// The codec-registry and fault-injection-registry subcommands, end to end:
// every refusal (exit 1) and every guard (exit 2) through `run`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { run } from './cli.ts';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
const put = (root: string, files: Record<string, string>): void => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
};
const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

/** A repository whose `main` holds `files`, with HEAD on a branch `work` cut from it. */
const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-ratchets-'));
  git(root, 'init', '-q', '-b', 'main');
  put(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'work');
  return root;
};
/** Stage these files (or delete a path, for null). */
const stage = (root: string, files: Record<string, string | null>): void => {
  for (const [p, body] of Object.entries(files)) {
    if (body === null) git(root, 'rm', '-q', '-f', p);
    else {
      put(root, { [p]: body });
      git(root, 'add', p);
    }
  }
};
const without = (files: Record<string, string>, ...paths: string[]): Record<string, string> => Object.fromEntries(Object.entries(files).filter(([p]) => !paths.includes(p)));
const USAGE = /^usage: /;

// ── codec-registry ──────────────────────────────────────────────────────────

const CODEC_SUITE = "import { F } from './md.ts';\nimport fc from 'fast-check';\nimport { fromMarkdown } from 'mdast-util-from-markdown';\nconst opts = { seed: SEED };\nfor (const eol of LINE_ENDINGS) {}\n";
const PAIR_SUITE = "import { writeRow, readRow } from './row.ts';\nimport fc from 'fast-check';\nconst opts = { seed: SEED };\n";
const codecConfig = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    baseline: 'codec.baseline.json',
    roots: ['scripts'],
    oracles: { markdown: 'mdast-util-from-markdown', yaml: 'js-yaml' },
    collected: ['^scripts/.+\\.test\\.ts$'],
    surfaces: ['scripts/**/*.{differential,roundtrip}.properties.test.ts'],
    markers: { seed: 'seed: SEED', lineEndings: 'LINE_ENDINGS', golden: 'assertGolden' },
    handParsers: [{ source: 'scripts/md.ts', formats: ['markdown'], suite: 'scripts/md.differential.properties.test.ts', outOfModel: 'lists' }],
    pairs: [{ id: 'scripts/row.ts#writeRow->readRow', kind: 'round-trip', suite: 'scripts/row.roundtrip.properties.test.ts' }],
    exempt: [{ id: 'scripts/notes.ts#yaml', reason: 'the --- it names is a horizontal rule in a message' }],
    minNoteLength: 1,
    examples: null,
    findingIds: { motivatedBy: '^M\\d{10}$', example: '^[MV]\\d{10}$' },
    ...over,
  });
const CODEC_FILES: Record<string, string> = {
  'codec.json': codecConfig(),
  'codec.baseline.json': '{"handParsers":["scripts/old.ts#yaml"],"pairs":[]}\n',
  'scripts/md.ts': 'export const F = /^```/;\n',
  'scripts/md.differential.properties.test.ts': CODEC_SUITE,
  'scripts/row.ts': 'export function writeRow() {}\nexport function readRow() {}\n',
  'scripts/row.roundtrip.properties.test.ts': PAIR_SUITE,
  'scripts/notes.ts': "export const RULE = '---';\n",
  'scripts/old.ts': "export const D = '---';\n",
};
const CODEC_GROWN = '{"handParsers":["scripts/new.ts#yaml","scripts/old.ts#yaml"],"pairs":[]}\n';
const codec = (root: string, ...extra: string[]) => {
  const c = capture();
  return { code: run(['codec-registry', '--root', root, '--config', 'codec.json', ...extra], c.io, '0'), out: c.out, err: c.err };
};
const P = 'pariksha codec-registry:';
const GROWN = `${P} scripts/new.ts#yaml: added to codec.baseline.json since the merge base; the baseline only shrinks, so register a suite instead`;
/** A repo on `work` whose baseline gained scripts/new.ts#yaml, staged. */
const grownCodec = (): string => {
  const root = repo(CODEC_FILES);
  stage(root, { 'scripts/new.ts': "export const D = '---';\n", 'codec.baseline.json': CODEC_GROWN });
  return root;
};

describe('run codec-registry', () => {
  it('passes a tree whose every parser and pair is registered, exempt or baselined, and says what it did not check', () => {
    const r = codec(repo(CODEC_FILES));
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual(r.out, [`${P} 3 hand parser(s) and 1 pair(s) discovered, each registered, exempt or among the 1 baselined; the baseline does not grow`, `${P} not checked: examples`]);
  });

  it('prints a check opted out with null as not checked, on a pass', () => {
    const r = codec(repo({ ...CODEC_FILES, 'codec.json': codecConfig({ surfaces: null, findingIds: null }) }));
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual(r.out[1], `${P} not checked: surfaces, examples, findingIds`);
  });

  it('refuses a discovered parser or pair that is unregistered and not baselined', () => {
    const root = repo(CODEC_FILES);
    stage(root, { 'scripts/new.ts': 'export const F = /^#/;\n', 'scripts/pair.ts': 'export function renderX() {}\nexport function parseX() {}\n' });
    const r = codec(root);
    assert.equal(r.code, 1);
    assert.deepEqual(r.err.slice(0, 2), [
      `${P} scripts/new.ts#markdown: discovered and unaccounted; register a suite for it, or exempt it with a reason`,
      `${P} scripts/pair.ts#renderX->parseX: discovered and unaccounted; register a suite for it, or exempt it with a reason`,
    ]);
    assert.match(r.err[2] ?? '', /2 problem\(s\)\. Register a suite/);
  });

  it('refuses a registered suite that is missing, uncollected, unwired or LF only, naming the kind and no check id', () => {
    const missing = repo(CODEC_FILES);
    stage(missing, { 'scripts/md.differential.properties.test.ts': null });
    assert.deepEqual(codec(missing).err[0], `${P} hand parser scripts/md.ts: the suite scripts/md.differential.properties.test.ts does not exist`);
    const uncollected = repo({ ...CODEC_FILES, 'codec.json': codecConfig({ collected: ['^tests/'] }) });
    assert.match(codec(uncollected).err.join('\n'), /no runner collects scripts\/md\.differential\.properties\.test\.ts/);
    const unwired = repo({ ...CODEC_FILES, 'scripts/md.differential.properties.test.ts': CODEC_SUITE.replace("from 'fast-check'", "from 'other'").replace("'./md.ts'", "'./mdx.ts'").replace("'mdast-util-from-markdown'", "'marked'") });
    const u = codec(unwired);
    assert.equal(u.code, 1);
    assert.deepEqual(u.err.slice(0, 3), [
      `${P} hand parser scripts/md.ts: scripts/md.differential.properties.test.ts does not import scripts/md.ts`,
      `${P} hand parser scripts/md.ts: scripts/md.differential.properties.test.ts does not import fast-check`,
      `${P} hand parser scripts/md.ts: scripts/md.differential.properties.test.ts does not import mdast-util-from-markdown, the markdown reference`,
    ]);
    const lf = repo({ ...CODEC_FILES, 'scripts/md.differential.properties.test.ts': CODEC_SUITE.replace('LINE_ENDINGS', 'EOLS') });
    const l = codec(lf);
    assert.equal(l.code, 1);
    assert.deepEqual(l.err[0], `${P} hand parser scripts/md.ts: scripts/md.differential.properties.test.ts runs LF only; run CRLF too (LINE_ENDINGS) or give lfOnly a reason`);
    const pair = repo(CODEC_FILES);
    stage(pair, { 'scripts/row.roundtrip.properties.test.ts': null });
    assert.deepEqual(codec(pair).err[0], `${P} pair scripts/row.ts#writeRow->readRow: the suite scripts/row.roundtrip.properties.test.ts does not exist`);
  });

  it('refuses a stale baseline entry', () => {
    const root = repo(CODEC_FILES);
    stage(root, { 'scripts/old.ts': null });
    const r = codec(root);
    assert.equal(r.code, 1);
    assert.deepEqual(r.err[0], `${P} scripts/old.ts#yaml: in codec.baseline.json, but registered, exempt or gone; remove it from the baseline`);
  });

  it('refuses a baseline that grew since the merge base, but not one whose file only moved', () => {
    const g = codec(grownCodec());
    assert.equal(g.code, 1);
    assert.deepEqual(g.err[0], GROWN);
    assert.equal(g.err.length, 2);
    const moved = repo({ ...CODEC_FILES, 'scripts/old.ts': `${"export const D = '---';\n".repeat(20)}` });
    git(moved, 'mv', 'scripts/old.ts', 'scripts/moved.ts');
    stage(moved, { 'codec.baseline.json': '{"handParsers":["scripts/moved.ts#yaml"],"pairs":[]}\n' });
    assert.equal(codec(moved).code, 0);
  });

  it('refuses growth committed on the branch, since it compares with the merge base, not HEAD', () => {
    const root = grownCodec();
    git(root, 'commit', '-q', '-m', 'grow the baseline');
    const r = codec(root);
    assert.equal(r.code, 1);
    assert.deepEqual(r.err[0], GROWN);
  });

  it('with --base HEAD compares the tree with HEAD only, so committed growth passes and staged growth does not', () => {
    const root = grownCodec();
    assert.deepEqual(codec(root, '--base', 'HEAD').err[0], GROWN);
    git(root, 'commit', '-q', '-m', 'grow the baseline');
    const r = codec(root, '--base', 'HEAD');
    assert.equal(r.code, 0, r.err.join('\n'));
  });

  it('with --no-base compares no growth, and says so', () => {
    const root = grownCodec();
    // No candidate base either: --no-base does not need one.
    git(root, 'branch', '-q', '-m', 'main', 'trunk');
    const r = codec(root, '--no-base');
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual(r.out, [`${P} 4 hand parser(s) and 1 pair(s) discovered, each registered, exempt or among the 2 baselined`, `${P} not checked: examples, baseline growth (--no-base)`]);
  });

  it('refuses --no-base with --base, an empty --base and --no-base twice as usage errors', () => {
    const root = repo(CODEC_FILES);
    for (const extra of [['--no-base', '--base', 'main'], ['--base', 'main', '--no-base'], ['--base', ''], ['--no-base', '--no-base']]) {
      const r = codec(root, ...extra);
      assert.equal(r.code, 2, extra.join(' '));
      assert.match(r.err[0] ?? '', USAGE);
    }
  });

  it('passes a baseline the merge base does not hold yet, or one moved to a new path: its first introduction', () => {
    const first = repo(without(CODEC_FILES, 'codec.baseline.json'));
    stage(first, { 'codec.baseline.json': CODEC_FILES['codec.baseline.json'] ?? '' });
    assert.equal(codec(first).code, 0);
    const moved = grownCodec();
    stage(moved, { 'codec.baseline.json': null, 'debt.json': CODEC_GROWN, 'codec.json': codecConfig({ baseline: 'debt.json' }) });
    assert.equal(codec(moved).code, 0);
  });

  it('reads the merge base against today’s lists: a list it lacks is empty, a list no longer named is ignored', () => {
    const lacking = repo({ ...CODEC_FILES, 'codec.baseline.json': '{"handParsers":["scripts/old.ts#yaml"]}' });
    stage(lacking, { 'codec.baseline.json': CODEC_FILES['codec.baseline.json'] ?? '' });
    assert.equal(codec(lacking).code, 0);
    const extra = repo({ ...CODEC_FILES, 'codec.baseline.json': '{"handParsers":["scripts/old.ts#yaml"],"pairs":[],"retired":["x"]}' });
    stage(extra, { 'codec.baseline.json': CODEC_FILES['codec.baseline.json'] ?? '' });
    assert.equal(codec(extra).code, 0);
    // A list the base lacks is empty, so an entry in it today is growth.
    const grown = repo({ ...CODEC_FILES, 'codec.baseline.json': '{"handParsers":["scripts/old.ts#yaml"]}' });
    stage(grown, { 'scripts/pair.ts': 'export function renderX() {}\nexport function parseX() {}\n', 'codec.baseline.json': '{"handParsers":["scripts/old.ts#yaml"],"pairs":["scripts/pair.ts#renderX->parseX"]}' });
    const g = codec(grown);
    assert.equal(g.code, 1);
    assert.match(g.err[0] ?? '', /scripts\/pair\.ts#renderX->parseX: added to codec\.baseline\.json since the merge base/);
  });

  it('refuses a registered or exempt id discovery no longer finds', () => {
    const root = repo(CODEC_FILES);
    stage(root, { 'scripts/notes.ts': 'export const RULE = 1;\n' });
    assert.deepEqual(codec(root).err[0], `${P} scripts/notes.ts#yaml: registered or exempt, but discovery does not find it; drop the entry, or fix what it names`);
  });

  it('compares with --base, and stops when it names no commit or no candidate does', () => {
    const root = repo(CODEC_FILES);
    assert.equal(codec(root, '--base', 'main').code, 0);
    const none = codec(root, '--base', 'no-such-ref');
    assert.equal(none.code, 2);
    assert.deepEqual(none.err, [`${P} --base no-such-ref names no commit; nothing was checked, so this is not a pass`]);
    git(root, 'branch', '-q', '-m', 'main', 'trunk');
    const nothing = codec(root);
    assert.equal(nothing.code, 2);
    assert.match(nothing.err[0] ?? '', /none of origin\/main, origin\/develop, origin\/master, main names a commit, so the baseline cannot be held to its merge base; fetch one, pass --base, or pass --no-base/);
  });

  it('exits 2 when git fails, as when the base shares no history with HEAD', () => {
    const root = repo(CODEC_FILES);
    git(root, 'checkout', '-q', '--orphan', 'other');
    git(root, 'commit', '-q', '-m', 'unrelated');
    git(root, 'checkout', '-q', 'work');
    const r = codec(root, '--base', 'other');
    assert.equal(r.code, 2);
    assert.deepEqual(r.err, [`${P} git merge-base HEAD other failed; nothing was checked, so this is not a pass`]);
  });

  it('exits 2 on a malformed baseline, here or at the merge base, and on a missing one', () => {
    const here = repo(CODEC_FILES);
    stage(here, { 'codec.baseline.json': '{"handParsers":"x","pairs":[]}' });
    assert.deepEqual(codec(here).err, [`${P} codec.baseline.json: "handParsers" must be a list of ids; nothing was checked, so this is not a pass`]);
    const atBase = repo({ ...CODEC_FILES, 'codec.baseline.json': '{"handParsers":[],"pairs":"x"}' });
    stage(atBase, { 'codec.baseline.json': CODEC_FILES['codec.baseline.json'] ?? '' });
    const b = codec(atBase);
    assert.equal(b.code, 2);
    assert.match(b.err[0] ?? '', /codec\.baseline\.json at the merge base [0-9a-f]{12}: "pairs" must be a list of ids/);
    const missing = repo(CODEC_FILES);
    stage(missing, { 'codec.baseline.json': null });
    assert.deepEqual(codec(missing).err, [`${P} the baseline codec.baseline.json is not a readable file; nothing was checked, so this is not a pass`]);
  });

  it('exits 2 on a config with an unknown key, a missing required key, a short note, or none at all', () => {
    const unknown = repo({ ...CODEC_FILES, 'codec.json': codecConfig({ registry: [] }) });
    assert.deepEqual(codec(unknown).err, [`${P} unknown key "registry"; nothing was checked, so this is not a pass`]);
    const reasonless = repo({ ...CODEC_FILES, 'codec.json': codecConfig({ exempt: [{ id: 'scripts/notes.ts#yaml', reason: '' }] }) });
    assert.deepEqual(codec(reasonless).err, [`${P} exempt[0]: an exemption needs a reason; nothing was checked, so this is not a pass`]);
    const noSurfaces = repo({ ...CODEC_FILES, 'codec.json': JSON.stringify({ ...(JSON.parse(codecConfig()) as Record<string, unknown>), surfaces: undefined }) });
    assert.deepEqual(codec(noSurfaces).err, [`${P} "surfaces" is required (null opts its check out); nothing was checked, so this is not a pass`]);
    const short = repo({ ...CODEC_FILES, 'codec.json': codecConfig({ minNoteLength: 21 }) });
    assert.match(codec(short).err[0] ?? '', /"outOfModel" is shorter than minNoteLength \(21\)/);
    const absent = repo(CODEC_FILES);
    assert.equal(codec(absent, '--config', 'x').code, 2);
    const c = capture();
    assert.equal(run(['codec-registry', '--root', absent], c.io, '0'), 2);
    assert.match(c.err[0] ?? '', USAGE);
  });

  it('exits 2 when a root holds no tracked file, or discovery finds nothing of a kind, never a vacuous pass', () => {
    const typo = repo({ ...CODEC_FILES, 'codec.json': codecConfig({ roots: ['scripts', 'scirpts'] }) });
    assert.deepEqual(codec(typo).err, [`${P} no tracked file lies under scirpts, so discovery there would read nothing; nothing was checked, so this is not a pass`]);
    const empty = repo({ 'codec.json': codecConfig({ handParsers: [], pairs: [], exempt: [] }), 'codec.baseline.json': '{"handParsers":[],"pairs":[]}', 'scripts/plain.ts': 'export const x = 1;\n' });
    assert.deepEqual(codec(empty).err, [`${P} discovery finds no hand parser under scripts, so nothing of that kind would be checked; nothing was checked, so this is not a pass`]);
    // Parsers alone: the pairs a discovery regression would stop finding must not pass silently.
    const parsersOnly = repo({ ...without(CODEC_FILES, 'scripts/row.ts', 'scripts/row.roundtrip.properties.test.ts'), 'codec.json': codecConfig({ pairs: [] }) });
    assert.deepEqual(codec(parsersOnly).err, [`${P} discovery finds no producer/consumer pair under scripts, so nothing of that kind would be checked; nothing was checked, so this is not a pass`]);
  });

  it('exits 2 outside a repository and without TypeScript', () => {
    const outside = mkdtempSync(join(tmpdir(), 'pariksha-none-'));
    assert.deepEqual(codec(outside).err, [`${P} ${outside} is not in a git repository`]);
    rmSync(outside, { recursive: true, force: true });
    const c = capture();
    const root = repo(CODEC_FILES);
    assert.equal(run(['codec-registry', '--root', root, '--config', 'codec.json'], { ...c.io, typescript: () => 'needs the typescript package' }, '0'), 2);
    assert.deepEqual(c.err, [`${P} needs the typescript package`]);
  });
});

// ── fault-injection-registry ────────────────────────────────────────────────

const HARNESS = "export { assertNoViolations, checkExitContract, checkRerunConvergence } from './checks';\n";
const CHECKS = 'export function assertNoViolations() {}\nexport async function checkExitContract() {}\nexport const checkRerunConvergence = async () => {};\n';
const FAULT_SUITE = "import { checkExitContract, assertNoViolations } from '../packages/h/index.ts';\nimport { main } from './tool.ts';\nassertNoViolations(checkExitContract(main));\n";
const ENTRY = 'export async function main() {}\nif (process.argv[1] === import.meta.filename) await main();\n';
const faultConfig = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    baseline: 'fault.baseline.json',
    discover: {
      cli: { roots: ['scripts'], include: '\\.(ts|mjs)$', marker: { pattern: 'process\\.argv\\b' } },
      server: { roots: ['server'], include: '\\.ts$', marker: { pattern: 'best[- ]effort', flags: 'i' } },
    },
    collected: ['^scripts/.+\\.test\\.ts$', '^server/.+\\.test\\.ts$'],
    harness: { module: 'packages/h/index.ts', checks: { 'ERR-09': 'checkExitContract', 'STATE-11': 'checkRerunConvergence' }, heldBy: 'assertNoViolations' },
    consumers: [{ source: 'scripts/tool.ts', unit: 'main', checks: ['ERR-09'], test: 'scripts/tool.faults.test.ts' }],
    exempt: [{ source: 'scripts/report.ts', reason: 'writes no file and holds no state' }],
    exemptIn: ['cli'],
    minNoteLength: 21,
    examples: null,
    findingIds: { motivatedBy: '^[MV]\\d{10}$', example: '^[MV]\\d{10}$' },
    ...over,
  });
const FAULT_FILES: Record<string, string> = {
  'fault.json': faultConfig(),
  'fault.baseline.json': '{"cli":["scripts/old.ts"],"server":["server/a.service.ts"]}\n',
  'packages/h/index.ts': HARNESS,
  'packages/h/checks.ts': CHECKS,
  'scripts/tool.ts': ENTRY,
  'scripts/tool.faults.test.ts': FAULT_SUITE,
  'scripts/report.ts': ENTRY,
  'scripts/old.ts': ENTRY,
  'server/a.service.ts': '// best-effort: logged, never thrown\n',
};
const fault = (root: string, ...extra: string[]) => {
  const c = capture();
  return { code: run(['fault-injection-registry', '--root', root, '--config', 'fault.json', ...extra], c.io, '0'), out: c.out, err: c.err };
};
const F = 'pariksha fault-injection-registry:';

describe('run fault-injection-registry', () => {
  it('passes a tree whose every CLI and best-effort source is registered, exempt or baselined', () => {
    const r = fault(repo(FAULT_FILES));
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual(r.out, [`${F} 3 cli and 1 server source(s) discovered, each registered, exempt or among the 2 baselined; the baseline does not grow`, `${F} not checked: examples`]);
  });

  it('refuses a new CLI or best-effort source that is unregistered and not baselined', () => {
    const root = repo(FAULT_FILES);
    stage(root, { 'scripts/new.mjs': ENTRY, 'server/b.service.ts': '// Best effort\n' });
    const r = fault(root);
    assert.equal(r.code, 1);
    assert.deepEqual(r.err.slice(0, 2), [
      `${F} scripts/new.mjs: discovered and unaccounted; register it with a fault-injection suite, or exempt it with a reason`,
      `${F} server/b.service.ts: discovered and unaccounted; register it with a fault-injection suite, or exempt it with a reason`,
    ]);
  });

  it('refuses a registered suite that is missing, or does not import the harness or assert a declared check', () => {
    const missing = repo(FAULT_FILES);
    stage(missing, { 'scripts/tool.faults.test.ts': null });
    assert.deepEqual(fault(missing).err[0], `${F} scripts/tool.ts: the suite scripts/tool.faults.test.ts does not exist`);
    const unwired = repo({ ...FAULT_FILES, 'fault.json': faultConfig({ consumers: [{ source: 'scripts/tool.ts', unit: 'main', checks: ['ERR-09', 'STATE-11'], test: 'scripts/tool.faults.test.ts' }] }), 'scripts/tool.faults.test.ts': FAULT_SUITE.replace('../packages/h/index.ts', './harness.ts') });
    const u = fault(unwired);
    assert.equal(u.code, 1);
    assert.deepEqual(u.err.slice(0, 2), [
      `${F} scripts/tool.ts: scripts/tool.faults.test.ts does not import the harness (packages/h/index.ts)`,
      `${F} scripts/tool.ts: scripts/tool.faults.test.ts declares STATE-11 but never calls checkRerunConvergence(`,
    ]);
  });

  it('refuses a harness whose declared function resolves to a type, or is not exported at all', () => {
    const typed = repo({ ...FAULT_FILES, 'packages/h/index.ts': "export { assertNoViolations, checkExitContract } from './checks';\nexport type { checkRerunConvergence } from './checks';\n" });
    const t = fault(typed);
    assert.equal(t.code, 1);
    assert.deepEqual(t.err[0], `${F} harness: packages/h/index.ts exports checkRerunConvergence as a type, not a function`);
    const gone = repo({ ...FAULT_FILES, 'packages/h/index.ts': "export * from '@acme/checks';\n// checkExitContract checkRerunConvergence assertNoViolations\n" });
    const g = fault(gone);
    assert.equal(g.code, 1);
    assert.match(g.err[0] ?? '', /harness: packages\/h\/index\.ts does not export checkExitContract \(not followed: packages\/h\/index\.ts: '@acme\/checks'\)/);
  });

  it('refuses a stale baseline entry, growth since the merge base and an exemption nothing discovers in cli', () => {
    const root = repo(FAULT_FILES);
    // new.ts shares nothing with old.ts, so git reads no rename between them.
    stage(root, { 'scripts/old.ts': null, 'scripts/report.ts': 'export const x = 1;\n', 'scripts/new.ts': 'const [, , flag] = process.argv;\nconsole.log(flag);\n', 'fault.baseline.json': '{"cli":["scripts/new.ts","scripts/old.ts"],"server":["server/a.service.ts"]}' });
    const r = fault(root);
    assert.equal(r.code, 1);
    assert.deepEqual(r.err.slice(0, 3), [
      `${F} scripts/report.ts: exempt, but discovery does not find it in cli; drop the exemption`,
      `${F} scripts/old.ts: in fault.baseline.json, but registered, exempt, renamed or gone; remove it from the baseline`,
      `${F} scripts/new.ts: added to fault.baseline.json since the merge base; the baseline only shrinks, so register a suite instead`,
    ]);
  });

  it('refuses an exemption of a source only a group outside exemptIn discovers', () => {
    const root = repo({ ...FAULT_FILES, 'fault.json': faultConfig({ exempt: [{ source: 'server/a.service.ts', reason: 'logs the failure and carries on' }] }), 'scripts/report.ts': 'export const x = 1;\n', 'fault.baseline.json': '{"cli":["scripts/old.ts"],"server":[]}' });
    const r = fault(root);
    assert.equal(r.code, 1);
    assert.deepEqual(r.err[0], `${F} server/a.service.ts: exempt, but discovery does not find it in cli; drop the exemption`);
  });

  it('reads the merge base against today’s groups, and holds growth to the merge base, with --no-base and --base HEAD as for codecs', () => {
    // The base names a group since removed (ignored) and lacks one since added (empty).
    const changed = repo({ ...FAULT_FILES, 'fault.baseline.json': '{"cli":["scripts/old.ts"],"tools":["x"]}' });
    stage(changed, { 'fault.baseline.json': FAULT_FILES['fault.baseline.json'] ?? '' });
    const c = fault(changed);
    assert.equal(c.code, 1);
    assert.deepEqual(c.err[0], `${F} server/a.service.ts: added to fault.baseline.json since the merge base; the baseline only shrinks, so register a suite instead`);
    const grown = repo(FAULT_FILES);
    stage(grown, { 'scripts/new.ts': 'const [, , flag] = process.argv;\nconsole.log(flag);\n', 'fault.baseline.json': '{"cli":["scripts/new.ts","scripts/old.ts"],"server":["server/a.service.ts"]}' });
    git(grown, 'commit', '-q', '-m', 'grow the baseline');
    assert.equal(fault(grown).code, 1);
    assert.equal(fault(grown, '--base', 'HEAD').code, 0);
    const n = fault(grown, '--no-base');
    assert.equal(n.code, 0);
    assert.deepEqual(n.out[1], `${F} not checked: examples, baseline growth (--no-base)`);
    assert.match(fault(grown, '--no-base', '--base', 'main').err[0] ?? '', USAGE);
  });

  it('exits 2 when a group discovers nothing, a baseline is malformed or the config is bad', () => {
    const none = repo({ ...FAULT_FILES, 'server/a.service.ts': '// strict\n' });
    assert.deepEqual(fault(none).err, [`${F} discovery finds no server source under server, so nothing of that kind would be checked; nothing was checked, so this is not a pass`]);
    const malformed = repo({ ...FAULT_FILES, 'fault.baseline.json': '{"cli":[]}' });
    assert.deepEqual(fault(malformed).err, [`${F} fault.baseline.json: "server" must be a list of paths; nothing was checked, so this is not a pass`]);
    const bad = repo({ ...FAULT_FILES, 'fault.json': faultConfig({ exempt: [{ source: 'scripts/report.ts' }] }) });
    assert.deepEqual(fault(bad).err, [`${F} exempt[0]: an exemption needs a reason; nothing was checked, so this is not a pass`]);
    const short = repo({ ...FAULT_FILES, 'fault.json': faultConfig({ exempt: [{ source: 'scripts/report.ts', reason: 'x'.repeat(20) }] }) });
    assert.deepEqual(fault(short).err, [`${F} exempt[0]: "reason" is shorter than minNoteLength (21): say why in words; nothing was checked, so this is not a pass`]);
  });

  it('exits 2 without TypeScript, which resolves the harness exports', () => {
    const c = capture();
    assert.equal(run(['fault-injection-registry', '--root', repo(FAULT_FILES), '--config', 'fault.json'], { ...c.io, typescript: () => 'needs the typescript package' }, '0'), 2);
    assert.deepEqual(c.err, [`${F} needs the typescript package`]);
  });
});
