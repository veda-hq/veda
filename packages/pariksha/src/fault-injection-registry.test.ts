import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkConsumers, checkHarness, discoverGroup, expectedBaseline, findings, formatFindings, leadName, parseBaseline, parseConfig, type Config } from './fault-injection-registry.ts';
import { gitAt, trackedUnder } from './git.ts';
import { audit } from './registry-ratchet.ts';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const sh = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, env: ENV, stdio: 'ignore', timeout: 30_000 });
};
const put = (root: string, files: Record<string, string>): void => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
};

const CLI_ENTRY = String.raw`isCliEntry\(|process\.argv\b|import\.meta\.main|require\.main === module|^(?:await |void )?main\(`;

/** A config with these overrides on a minimal valid one. */
const config = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  baseline: 'baseline.json',
  discover: {
    cli: { roots: ['scripts'], include: '\\.(ts|mts|cts|js|mjs|cjs)$', marker: { pattern: CLI_ENTRY, flags: 'm' } },
    server: { roots: ['apps/server/src'], include: '\\.ts$', marker: { pattern: 'best[- ]effort|fire-and-forget', flags: 'i' } },
  },
  collected: ['^scripts/.+\\.test\\.ts$', '^apps/server/src/.+\\.test\\.ts$', '^packages/h/src/.+\\.test\\.ts$'],
  harness: { module: 'packages/h/src/fault/index.ts', imports: ['@acme/h/fault'], checks: { 'ERR-09': 'checkExitContract', 'ERR-10': 'checkContainment', 'STATE-11': 'checkRerunConvergence' }, heldBy: 'assertNoViolations' },
  consumers: [{ source: 'scripts/tool.ts', unit: 'main (the entry)', checks: ['ERR-09', 'STATE-11'], test: 'scripts/tool.faults.test.ts' }],
  exempt: [],
  ...over,
});
const parsed = (over: Record<string, unknown> = {}): Config => parseConfig(JSON.stringify(config(over)));

const HARNESS = "export { assertNoViolations, checkContainment, checkExitContract, checkRerunConvergence } from './checks';\n";
const SUITE = "import { checkExitContract, checkRerunConvergence, assertNoViolations } from '../packages/h/src/fault/index.ts';\nimport { main } from './tool.ts';\nassertNoViolations(checkExitContract(main));\nassertNoViolations(checkRerunConvergence(main));\n";

describe('discovery', () => {
  let repo = '';
  const c = parsed();
  const discovered = (): { cli: string[]; server: string[] } => {
    const files = trackedUnder(gitAt(repo), repo, ['scripts', 'apps/server/src']);
    const within = (roots: readonly string[]) => files.filter((f) => roots.some((r) => f.startsWith(`${r}/`)));
    return {
      cli: discoverGroup(repo, within(['scripts']), c.discover['cli'] ?? assert.fail()),
      server: discoverGroup(repo, within(['apps/server/src']), c.discover['server'] ?? assert.fail()),
    };
  };
  const state = (): ReturnType<typeof audit> => audit(expectedBaseline(discovered(), { consumers: [], exempt: [] }), { cli: ['scripts/old.ts'], server: ['apps/server/src/a.service.ts'] });
  const entry = 'if (isCliEntry(process.argv[1], import.meta.url)) main();\n';
  const adding = (path: string, body: string, check: () => void): void => {
    put(repo, { [path]: body });
    sh(repo, 'add', path);
    try {
      check();
    } finally {
      sh(repo, 'rm', '-q', '-f', path);
    }
  };

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'pariksha-fault-'));
    sh(repo, 'init', '-q');
    put(repo, {
      'scripts/old.ts': entry,
      'scripts/plain.ts': 'export const x = 1;\n',
      'scripts/old.test.ts': entry,
      'scripts/fixtures/f.ts': entry,
      'apps/server/src/a.service.ts': '// best-effort: logged, never thrown\n',
    });
    sh(repo, 'add', '-A');
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it('starts consistent', () => {
    assert.deepEqual(state(), { unaccounted: [], stale: [] });
  });

  it('A: a new CLI is unaccounted until registered', () => {
    adding('scripts/new.mjs', entry, () => {
      assert.deepEqual(state().unaccounted, ['scripts/new.mjs']);
      const registered = audit(expectedBaseline(discovered(), { consumers: [{ source: 'scripts/new.mjs', unit: 'main', checks: ['ERR-09'], test: 't', motivatedBy: undefined, uncovered: undefined }], exempt: [] }), { cli: ['scripts/old.ts'], server: ['apps/server/src/a.service.ts'] });
      assert.deepEqual(registered, { unaccounted: [], stale: [] });
    });
  });

  for (const [label, body] of [
    ['an unconditional top-level main', 'await main(process.argv.slice(2));\n'],
    ['a main called without arguments', 'main();\n'],
    ['a module reading its arguments', 'const [, , flag] = process.argv;\n'],
    ['a module checking import.meta.main', 'if (import.meta.main) run();\n'],
    ['a CommonJS entry check', 'if (require.main === module) run();\n'],
  ] as const) {
    it(`A: ${label} is a CLI`, () => {
      adding('scripts/direct.mjs', body, () => assert.deepEqual(state().unaccounted, ['scripts/direct.mjs']));
    });
  }

  it('near-miss: a main that is only defined or exported is not a CLI', () => {
    adding('scripts/lib.mjs', 'export function main() {}\nexport const run = () => main();\n', () => assert.deepEqual(state().unaccounted, []));
  });

  it('near-miss: a server note that says best-effort is not a source', () => {
    adding('apps/server/src/notes.md', 'Retries are best-effort.\n', () => assert.deepEqual(state().unaccounted, []));
  });

  it('near-miss: a test, a declaration or a fixture that reads its arguments is not a CLI', () => {
    adding('scripts/x.spec.ts', entry, () => assert.deepEqual(state().unaccounted, []));
    adding('scripts/x.d.ts', entry, () => assert.deepEqual(state().unaccounted, []));
    assert.deepEqual(discovered().cli, ['scripts/old.ts']);
  });

  it('M: a module that becomes a CLI, or a service that gains a best-effort step, is unaccounted', () => {
    put(repo, { 'scripts/plain.ts': `export const x = 1;\n${entry}`, 'apps/server/src/b.service.ts': '// Fire-and-forget notification\n' });
    sh(repo, 'add', '-A');
    assert.deepEqual(state().unaccounted.sort(), ['apps/server/src/b.service.ts', 'scripts/plain.ts']);
    put(repo, { 'scripts/plain.ts': 'export const x = 1;\n' });
    sh(repo, 'rm', '-q', '-f', 'apps/server/src/b.service.ts');
    sh(repo, 'add', '-A');
  });

  it('D: a deleted CLI leaves a stale baseline entry', () => {
    rmSync(join(repo, 'scripts/old.ts'));
    assert.deepEqual(state(), { unaccounted: [], stale: ['scripts/old.ts'] });
    sh(repo, 'checkout', '--', 'scripts/old.ts');
  });

  it('R: a renamed CLI is both a new source and a stale entry', () => {
    sh(repo, 'mv', 'scripts/old.ts', 'scripts/renamed.ts');
    assert.deepEqual(state(), { unaccounted: ['scripts/renamed.ts'], stale: ['scripts/old.ts'] });
    sh(repo, 'mv', 'scripts/renamed.ts', 'scripts/old.ts');
  });
});

describe('registry helpers', () => {
  it('computes the baseline from discovered, registered and exempt sources', () => {
    assert.deepEqual(
      expectedBaseline(
        { cli: ['a.ts', 'b.ts', 'c.ts'], server: ['s.ts', 't.ts'] },
        { consumers: [{ source: 'a.ts', unit: 'u', checks: ['ERR-09'], test: 'a.test.ts', motivatedBy: undefined, uncovered: undefined }], exempt: [{ source: 'b.ts', reason: 'reads only, prints a report' }] },
      ),
      { cli: ['c.ts'], server: ['s.ts', 't.ts'] },
    );
  });

  it('refuses a malformed baseline, its lists named by the discovery groups', () => {
    const c = parsed();
    assert.deepEqual(parseBaseline('{"cli": ["a.ts"], "server": ["s.ts"]}', 'b.json', c), { cli: ['a.ts'], server: ['s.ts'] });
    assert.throws(() => parseBaseline('{"cli": "x", "server": []}', 'b.json', c), /"cli" must be a list of paths/);
    assert.throws(() => parseBaseline('{"cli": [], "server": [1]}', 'b.json', c), /"server" must be a list of paths/);
    assert.throws(() => parseBaseline('[]', 'b.json', c), /b\.json: must be an object with "cli" and "server" lists/);
  });

  it('reads the name a unit opens with', () => {
    assert.equal(leadName('AdminUsersService.update (deactivation)'), 'AdminUsersService');
    assert.equal(leadName('main'), 'main');
    assert.equal(leadName('(anonymous)'), '');
  });
});

describe('the config', () => {
  it('reads a valid config', () => {
    const c = parsed();
    assert.equal(c.discover['cli']?.marker.flags, 'm');
    assert.equal(c.consumers[0]?.motivatedBy, undefined);
    assert.equal(parsed({ discover: { cli: { roots: ['scripts'], include: '\\.ts$', marker: { pattern: 'main\\(' } } } }).discover['cli']?.marker.flags, '');
  });

  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an unknown key', { extra: 1 }, /^Error: unknown key "extra"$/],
    ['no discovery group', { discover: {} }, /"discover" is empty/],
    ['a group name that is no list name', { discover: { 'a b': {} } }, /discover: "a b" is not a baseline list name/],
    ['a group that is not an object', { discover: { cli: [] } }, /discover\.cli must be an object/],
    ['an unknown group key', { discover: { cli: { roots: ['s'], include: 'x', marker: { pattern: 'x' }, other: 1 } } }, /discover\.cli: unknown key "other"/],
    ['a group with no roots', { discover: { cli: { roots: [], include: 'x', marker: { pattern: 'x' } } } }, /discover\.cli: "roots" is empty/],
    ['a bad marker flag', { discover: { cli: { roots: ['s'], include: 'x', marker: { pattern: 'x', flags: 'g' } } } }, /discover\.cli: marker\.flags must be some of i, m, s, u/],
    ['a marker that is no regex', { discover: { cli: { roots: ['s'], include: 'x', marker: { pattern: '(' } } } }, /discover\.cli: marker\.pattern: "\(" is not a regular expression/],
    ['an unknown marker key', { discover: { cli: { roots: ['s'], include: 'x', marker: { pattern: 'x', why: 1 } } } }, /discover\.cli: marker: unknown key "why"/],
    ['a relative harness import', { harness: { module: 'h.ts', imports: ['./h'], checks: { A: 'a' }, heldBy: 'h' } }, /harness\.imports\[0\] must be a bare module specifier/],
    ['a check function that is no name', { harness: { module: 'h.ts', checks: { A: 'a b' }, heldBy: 'h' } }, /harness\.checks\.A must be a function name/],
    ['no checks', { harness: { module: 'h.ts', checks: {}, heldBy: 'h' }, consumers: [] }, /harness: "checks" is empty/],
    ['a heldBy that is no name', { harness: { module: 'h.ts', checks: { A: 'a' }, heldBy: 'x(' } }, /harness: "heldBy" must be a function name/],
    ['an unknown harness key', { harness: { module: 'h.ts', checks: { A: 'a' }, heldBy: 'h', path: 'x' } }, /harness: unknown key "path"/],
    ['a consumer with no checks', { consumers: [{ source: 'a.ts', unit: 'main', checks: [], test: 'a.test.ts' }] }, /consumers\[0\]: "checks" must be a non-empty list of check ids/],
    ['a consumer declaring an unknown check', { consumers: [{ source: 'a.ts', unit: 'main', checks: ['ERR-99'], test: 'a.test.ts' }] }, /consumers\[0\]: "ERR-99" is not a check in harness\.checks/],
    ['a consumer with an unknown key', { consumers: [{ source: 'a.ts', unit: 'main', checks: ['ERR-09'], test: 'a.test.ts', note: 'x' }] }, /consumers\[0\]: unknown key "note"/],
    ['a consumer with a blank uncovered note', { consumers: [{ source: 'a.ts', unit: 'main', checks: ['ERR-09'], test: 'a.test.ts', uncovered: '' }] }, /consumers\[0\]: "uncovered" must be a non-empty string/],
    ['an exemption without a reason', { exempt: [{ source: 'scripts/x.ts' }] }, /exempt\[0\]: an exemption needs a reason/],
    ['an exemption with an unknown key', { exempt: [{ source: 'scripts/x.ts', reason: 'r', why: 'w' }] }, /exempt\[0\]: unknown key "why"/],
    ['a source registered and exempt', { exempt: [{ source: 'scripts/tool.ts', reason: 'r' }] }, /"scripts\/tool\.ts" is registered or exempt more than once/],
    ['an example for no check', { examples: { fixtures: { 'ERR-99': { example: 'M1', test: 'a.test.ts' } } } }, /examples\.fixtures\.ERR-99: not a check in harness\.checks/],
    ['a motivation that is not a finding id', { findingId: '^[MV]\\d{10}$', consumers: [{ source: 'a.ts', unit: 'main', checks: ['ERR-09'], test: 'a.test.ts', motivatedBy: 'M1' }] }, /consumers a\.ts: motivatedBy: "M1" is not a finding id/],
    ['an example that is not a finding id', { findingId: '^[MV]\\d{10}$', examples: { fixtures: { 'ERR-09': { example: 'X', test: 'a.test.ts' } } } }, /examples\.fixtures\.ERR-09: example: "X"/],
  ];
  for (const [label, over, message] of refusals) {
    it(`refuses ${label}`, () => {
      assert.throws(() => parseConfig(JSON.stringify(config(over))), message);
    });
  }
});

describe('the harness and the registered consumers', () => {
  const make = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'pariksha-fault-wiring-'));
    put(root, { 'packages/h/src/fault/index.ts': HARNESS, 'scripts/tool.ts': 'export async function main() {}\n', 'scripts/tool.faults.test.ts': SUITE, ...files });
    return root;
  };

  it('passes a suite that imports the harness and the unit and asserts each check held to zero violations', () => {
    const root = make({});
    assert.deepEqual(checkHarness(root, parsed()), []);
    assert.deepEqual(checkConsumers(root, parsed()), []);
  });

  it('takes the harness by its package specifier, or by its folder', () => {
    const root = make({ 'scripts/tool.faults.test.ts': SUITE.replace('../packages/h/src/fault/index.ts', '@acme/h/fault'), 'scripts/two.faults.test.ts': SUITE.replace('index.ts', '').replace('./tool.ts', './tool') });
    const two = { source: 'scripts/tool.ts', unit: 'main', checks: ['ERR-09'], test: 'scripts/two.faults.test.ts' };
    assert.deepEqual(checkConsumers(root, parsed()), []);
    assert.deepEqual(checkConsumers(root, parsed({ consumers: [two] })), []);
  });

  it('refuses a harness module that is missing or does not export a named function', () => {
    assert.deepEqual(checkHarness(make({ 'packages/h/src/fault/index.ts': "export { checkExitContract, assertNoViolations } from './checks';\n// checkContainment\n" }), parsed()), [
      'harness: packages/h/src/fault/index.ts does not export checkContainment',
      'harness: packages/h/src/fault/index.ts does not export checkRerunConvergence',
    ]);
    const root = make({});
    rmSync(join(root, 'packages/h/src/fault/index.ts'));
    assert.deepEqual(checkHarness(root, parsed()), ['harness: packages/h/src/fault/index.ts does not exist']);
  });

  it('refuses a suite that does not import the harness or the unit, skips a check, or holds nothing to zero', () => {
    const root = make({ 'scripts/tool.faults.test.ts': "import { main } from '../other/tool.ts';\n// fault-injection\ncheckExitContract(main);\n" });
    assert.deepEqual(checkConsumers(root, parsed()), [
      'scripts/tool.ts: scripts/tool.faults.test.ts does not import the harness (packages/h/src/fault/index.ts or @acme/h/fault)',
      'scripts/tool.ts: scripts/tool.faults.test.ts does not import scripts/tool.ts',
      'scripts/tool.ts: scripts/tool.faults.test.ts declares STATE-11 but never calls checkRerunConvergence(',
      'scripts/tool.ts: scripts/tool.faults.test.ts never calls assertNoViolations(, so no run is held to zero violations',
    ]);
  });

  it('refuses a missing source or suite, an uncollected suite, and a unit the source does not name', () => {
    const root = make({ 'docs/tool.test.ts': SUITE.replace('../packages', '../packages').replace("'./tool.ts'", "'../scripts/tool.ts'") });
    rmSync(join(root, 'scripts/tool.faults.test.ts'));
    const c = parsed({
      consumers: [
        { source: 'scripts/tool.ts', unit: 'main', checks: ['ERR-09'], test: 'scripts/tool.faults.test.ts' },
        { source: 'scripts/gone.ts', unit: 'main', checks: ['ERR-09'], test: 'docs/tool.test.ts' },
        { source: 'scripts/tool.ts#2', unit: 'run', checks: ['ERR-09'], test: 'docs/tool.test.ts' },
      ],
    });
    assert.deepEqual(checkConsumers(root, c), [
      'scripts/tool.ts: the suite scripts/tool.faults.test.ts does not exist',
      'scripts/gone.ts: the registered source does not exist',
      'scripts/gone.ts: no runner collects docs/tool.test.ts',
      'scripts/gone.ts: docs/tool.test.ts does not import scripts/gone.ts',
      'scripts/tool.ts#2: the registered source does not exist',
      'scripts/tool.ts#2: no runner collects docs/tool.test.ts',
      'scripts/tool.ts#2: docs/tool.test.ts does not import scripts/tool.ts#2',
    ]);
    const unnamed = parsed({ consumers: [{ source: 'scripts/tool.ts', unit: 'runSafely', checks: ['ERR-09'], test: 'docs/tool.test.ts' }] });
    assert.ok(checkConsumers(root, unnamed).includes('scripts/tool.ts: unit runSafely is not named in the source'));
    const nameless = parsed({ consumers: [{ source: 'scripts/tool.ts', unit: '(entry)', checks: ['ERR-09'], test: 'docs/tool.test.ts' }] });
    assert.ok(checkConsumers(root, nameless).includes('scripts/tool.ts: unit "(entry)" opens with no name'));
  });
});

describe('findings', () => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-fault-findings-'));
  put(root, { 'packages/h/src/fault/index.ts': HARNESS, 'packages/h/src/err-09.examples.test.ts': 'M1 checkExitContract(x)', 'packages/h/src/state-11.examples.test.ts': 'M2' });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('names an exemption discovery no longer finds, the unaccounted, the stale and the grown', () => {
    const c = parsed({ consumers: [], exempt: [{ source: 'scripts/gone.ts', reason: 'reads only' }] });
    assert.deepEqual(findings(root, c, { cli: ['scripts/a.ts'], server: [] }, { cli: ['scripts/old.ts'], server: [] }, ['scripts/old.ts']), [
      'scripts/gone.ts: exempt, but discovery does not find it; drop the exemption',
      'scripts/a.ts: discovered and unaccounted; register it with a fault-injection suite, or exempt it with a reason',
      'scripts/old.ts: in baseline.json, but registered, exempt, renamed or gone; remove it from the baseline',
      'scripts/old.ts: added to baseline.json since the merge base; the baseline only shrinks, so register a suite instead',
    ]);
  });

  it('holds each example suite to calling its check through the harness', () => {
    const c = parsed({ consumers: [], examples: { fixtures: { 'ERR-09': { example: 'M1', test: 'packages/h/src/err-09.examples.test.ts' }, 'STATE-11': { example: 'M2', test: 'packages/h/src/state-11.examples.test.ts' } } } });
    assert.deepEqual(findings(root, c, { cli: [], server: [] }, { cli: [], server: [] }, []), ['packages/h/src/state-11.examples.test.ts: the STATE-11 example suite never calls checkRerunConvergence(']);
  });

  it('summarises a clean run by group', () => {
    assert.deepEqual(formatFindings([], { cli: ['a', 'b'], server: ['s'] }, { cli: ['a'], server: [] }).out, [
      'pariksha fault-injection-registry: 2 cli and 1 server source(s) discovered, each registered, exempt or among the 1 baselined; the baseline does not grow',
    ]);
  });
});
