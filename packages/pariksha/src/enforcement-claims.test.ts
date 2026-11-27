import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ESLint } from 'eslint';
import { activeRules, checkClaims, claimedRules, findEnforcementProblems, formatOutcome, loadEslint, NO_INLINE_CONFIG, ownersOf, parseConfig, readStandards, ruleIsOn, type Config } from './enforcement-claims.ts';
import type { Standard } from './stage-reach.ts';

const made: string[] = [];
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-enforcement-'));
  made.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

const CONFIG = {
  id: 'BP-001',
  standards: 'docs/standards',
  workspaces: [
    { dir: '.', probes: ['scripts/probe.ts', 'scripts/probe.test.ts'] },
    { dir: 'apps/api', probes: ['src/probe.ts', 'src/probe.test.ts'] },
    { dir: 'apps/web', probes: ['src/probe.ts'] },
    { dir: 'packages/one', probes: ['src/probe.ts'] },
    { dir: 'packages/two', probes: ['src/probe.ts'] },
  ],
  dispatcher: { path: 'scripts/run-validation.sh' },
  packageRunner: { path: 'scripts/validate-package.sh', call: 'run_validator', validatorsDir: 'scripts/validators' },
  stageRoots: { hooks: ['.husky'], workflows: ['.github/workflows'], actions: ['.github/actions'] },
  runnable: { prefixes: ['scripts/', 'apps/*/scripts/'], extensions: ['sh', 'ts'], bin: 'node_modules/.bin' },
  workspaceList: { pnpm: 'pnpm-workspace.yaml', turbo: 'turbo.json' },
  tests: { file: '\\.test\\.tsx?$', runner: '\\bvitest\\b|\\s--test\\b' },
};
const config = (over: Record<string, unknown> = {}): Config => parseConfig(JSON.stringify({ ...CONFIG, ...over }));
const STANDARD: Standard = { file: 'docs/standards/probe.md', id: 'BP-PROBE-001', enforcement: 'eslint-rule', enforcementConfig: '', partialGates: '', appliesTo: [], enforcementScript: '', deprecated: false };
const standard = (over: Partial<Standard>): Standard => ({ ...STANDARD, ...over });

describe('parseConfig', () => {
  it('reads every key', () => {
    const c = config();
    assert.equal(c.id, 'BP-001');
    assert.equal(c.standards, 'docs/standards');
    assert.deepEqual(c.workspaces, CONFIG.workspaces);
    assert.equal(c.dispatcher, 'scripts/run-validation.sh');
    assert.equal(c.dispatchCall?.source, 'run\\-validation\\.sh\\s+([a-z][a-z0-9-]*)');
    assert.deepEqual(c.packageRunner, CONFIG.packageRunner);
    assert.deepEqual([c.hooks, c.workflows, c.actions], [['.husky'], ['.github/workflows'], ['.github/actions']]);
    assert.equal(c.runnable.length, 2);
    assert.equal(c.bin, 'node_modules/.bin');
    assert.deepEqual(c.programs, new Map());
    assert.deepEqual(config({ runnable: { ...CONFIG.runnable, programs: { 'my-rules': ['vendor/rules/src/cli.ts', 'vendor/rules/dist/cli.js'], 'tool.v2': ['t.js'] } } }).programs, new Map([['my-rules', ['vendor/rules/src/cli.ts', 'vendor/rules/dist/cli.js']], ['tool.v2', ['t.js']]]));
    assert.deepEqual(config({ runnable: { ...CONFIG.runnable, programs: null } }).programs, new Map());
    assert.deepEqual([c.workspaceFile, c.turbo], ['pnpm-workspace.yaml', 'turbo.json']);
    assert.deepEqual([c.testFile.source, c.testRunner.source], ['\\.test\\.tsx?$', '\\bvitest\\b|\\s--test\\b']);
  });

  it('reads the optional keys as none when absent or null', () => {
    const c = config({ id: undefined, packageRunner: null, stageRoots: { hooks: ['.husky'] }, runnable: { prefixes: ['scripts/'], extensions: ['sh'], bin: null }, workspaceList: { pnpm: 'pnpm-workspace.yaml', turbo: null } });
    assert.deepEqual([c.id, c.packageRunner, c.turbo, c.workflows, c.actions, c.runnable.length, c.bin], [undefined, undefined, undefined, [], [], 1, undefined]);
    assert.equal(config({ packageRunner: undefined }).packageRunner, undefined);
    // A repository whose stages call each check directly has no dispatcher.
    for (const dispatcher of [undefined, null]) {
      const none = config({ dispatcher });
      assert.deepEqual([none.dispatcher, none.dispatchCall], [undefined, undefined]);
    }
  });

  const refuses = (over: Record<string, unknown>, message: RegExp): void => {
    assert.throws(() => config(over), message);
  };

  it('refuses an unknown key anywhere', () => {
    refuses({ extra: 1 }, /^Error: unknown key "extra"$/);
    refuses({ dispatcher: { path: 'scripts/d.sh', call: 'x' } }, /^Error: dispatcher: unknown key "call"$/);
    refuses({ workspaces: [{ dir: '.', probes: ['a.ts'], files: [] }] }, /^Error: workspaces\[0\]: unknown key "files"$/);
    refuses({ stageRoots: { hooks: ['.husky'], roots: [] } }, /^Error: stageRoots: unknown key "roots"$/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: ['sh'], glob: '' } }, /^Error: runnable: unknown key "glob"$/);
    refuses({ workspaceList: { pnpm: 'p.yaml', npm: 'x' } }, /^Error: workspaceList: unknown key "npm"$/);
    refuses({ tests: { file: 'x', runner: 'y', only: 1 } }, /^Error: tests: unknown key "only"$/);
    refuses({ packageRunner: { path: 'a.sh', call: 'run', validatorsDir: 'v', extra: 1 } }, /^Error: packageRunner: unknown key "extra"$/);
  });

  it('refuses a workspace list that is empty, repeats a folder, or names a folder outside the root', () => {
    refuses({ workspaces: [] }, /"workspaces" is empty/);
    refuses({ workspaces: [{ dir: '.', probes: ['a.ts'] }, { dir: '.', probes: ['b.ts'] }] }, /workspace "\." is listed more than once/);
    refuses({ workspaces: [{ dir: '../x', probes: ['a.ts'] }] }, /"dir": "\.\.\/x" is not "\." or a normalized root-relative path/);
    refuses({ workspaces: [{ dir: 'apps/api', probes: [] }] }, /"probes" is empty/);
    refuses({ workspaces: ['apps/api'] }, /workspaces\[0\] must be an object/);
  });

  it('refuses a missing or bad dispatcher, package runner, stage root, prefix, extension or pattern', () => {
    refuses({ dispatcher: 'scripts/run-validation.sh' }, /^Error: "dispatcher" must be an object$/);
    refuses({ dispatcher: { path: '/abs.sh' } }, /dispatcher: "path": "\/abs\.sh" is not a normalized root-relative path/);
    refuses({ packageRunner: { path: 'a.sh', call: 'run validator', validatorsDir: 'v' } }, /"call" must be a shell function name/);
    refuses({ stageRoots: { hooks: [], workflows: [] } }, /"hooks" and "workflows" are both empty/);
    refuses({ stageRoots: { hooks: ['../hooks'] } }, /^Error: stageRoots: hooks\[0\]: "\.\.\/hooks" is not a normalized root-relative path$/);
    refuses({ runnable: { prefixes: ['scripts'], extensions: ['sh'] } }, /prefixes\[0\]: "scripts" is not a folder path ending in "\/"/);
    refuses({ runnable: { prefixes: ['../scripts/'], extensions: ['sh'] } }, /prefixes\[0\]/);
    refuses({ runnable: { prefixes: [], extensions: ['sh'] } }, /"prefixes" is empty/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: ['.sh'] } }, /extensions\[0\]: "\.sh" is not a file extension/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: [] } }, /"extensions" is empty/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: ['sh'], bin: '' } }, /^Error: runnable: "bin" must be a non-empty string$/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: ['sh'], programs: ['tool'] } }, /runnable: "programs" must be an object/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: ['sh'], programs: { tool: 'vendor/cli.ts' } } }, /runnable\.programs: "tool" must be a list/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: ['sh'], programs: { tool: [] } } }, /runnable\.programs: "tool" is empty/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: ['sh'], programs: { tool: ['../cli.ts'] } } }, /runnable\.programs: tool\[0\]: "\.\.\/cli\.ts" is not a normalized root-relative path/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: ['sh'], programs: { tool: ['./cli.ts'] } } }, /tool\[0\]: "\.\/cli\.ts" is not a normalized/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: ['sh'], programs: { tool: [1] } } }, /tool\[0\]: 1 is not a normalized/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: ['sh'], programs: { 'my tool': ['cli.ts'] } } }, /runnable\.programs: "my tool" is not a program name/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: ['sh'], programs: { '-x': ['cli.ts'] } } }, /"-x" is not a program name/);
    refuses({ runnable: { prefixes: ['scripts/'], extensions: ['sh'], programs: { a: ['cli.ts'], b: ['cli.ts'] } } }, /runnable\.programs: "cli\.ts" runs both "a" and "b"/);
    refuses({ workspaceList: { turbo: 'turbo.json' } }, /workspaceList: "pnpm" must be a non-empty string/);
    refuses({ tests: { file: '(', runner: 'x' } }, /tests\.file: "\(" is not a regular expression/);
    refuses({ tests: { file: 'x' } }, /tests\.runner must be a non-empty regular expression/);
    refuses({ standards: '' }, /^Error: "standards" must be a non-empty string$/);
    refuses({ id: '' }, /^Error: "id" must be a non-empty string$/);
  });

  it('names where each bad value is, by its own key and its section', () => {
    const runnable = { prefixes: ['scripts/'], extensions: ['sh'] };
    refuses({ workspaces: 'apps/api' }, /^Error: "workspaces" must be a list$/);
    refuses({ packageRunner: { path: 'a.sh', validatorsDir: 'v' } }, /^Error: packageRunner: "call" must be a non-empty string$/);
    refuses({ packageRunner: { path: '/a.sh', call: 'run', validatorsDir: 'v' } }, /^Error: packageRunner: "path": "\/a\.sh" is not a normalized root-relative path$/);
    refuses({ packageRunner: { path: 'a.sh', call: 'run', validatorsDir: '../v' } }, /^Error: packageRunner: "validatorsDir": "\.\.\/v" is not a normalized root-relative path$/);
    refuses({ stageRoots: '.husky' }, /^Error: "stageRoots" must be an object$/);
    refuses({ stageRoots: { workflows: ['../wf'] } }, /^Error: stageRoots: workflows\[0\]: "\.\.\/wf" is not a normalized root-relative path$/);
    refuses({ stageRoots: { hooks: ['.husky'], actions: ['../a'] } }, /^Error: stageRoots: actions\[0\]: "\.\.\/a" is not a normalized root-relative path$/);
    refuses({ runnable: 'scripts/' }, /^Error: "runnable" must be an object$/);
    refuses({ runnable: { ...runnable, prefixes: 'scripts/' } }, /^Error: runnable: "prefixes" must be a list$/);
    refuses({ runnable: { ...runnable, extensions: 'sh' } }, /^Error: runnable: "extensions" must be a list$/);
    refuses({ workspaceList: 'pnpm-workspace.yaml' }, /^Error: "workspaceList" must be an object$/);
    refuses({ workspaceList: { pnpm: 'p.yaml', turbo: '/turbo.json' } }, /^Error: workspaceList: "turbo": "\/turbo\.json" is not a normalized root-relative path$/);
    refuses({ tests: '\\.test\\.ts$' }, /^Error: "tests" must be an object$/);
  });

  it('takes a prefix only as whole folder names, each ending in "/", and an extension only as letters and digits', () => {
    const runnable = { prefixes: ['scripts/'], extensions: ['sh'] };
    for (const prefix of ['scripts/x', 'node_modules/@scope/', '@scope/', './scripts/', 'scripts/./x/', 'scripts/../x/']) {
      refuses({ runnable: { ...runnable, prefixes: [prefix] } }, new RegExp(`^Error: runnable\\.prefixes\\[0\\]: ${JSON.stringify(prefix).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} is not a folder path ending in "/" \\(a "\\*" segment is one folder\\)$`));
    }
    refuses({ runnable: { ...runnable, prefixes: [['scripts/']] } }, /^Error: runnable\.prefixes\[0\]: \["scripts\/"\] is not a folder path/);
    for (const extension of ['sh.bak', 'sh!']) refuses({ runnable: { ...runnable, extensions: [extension] } }, /^Error: runnable\.extensions\[0\]: "sh(\.bak|!)" is not a file extension without its dot$/);
    refuses({ runnable: { ...runnable, extensions: [['sh']] } }, /^Error: runnable\.extensions\[0\]: \["sh"\] is not a file extension without its dot$/);
    assert.equal(config({ runnable: { prefixes: ['.claude/scripts/', 'apps/*/my-scripts.d/'], extensions: ['sh', 'mjs2'] } }).runnable.length, 1);
    assert.equal(config({ workspaceList: { pnpm: 'p.yaml' } }).turbo, undefined);
  });
});

describe('readStandards', () => {
  /** A tree holding one standard with this frontmatter. */
  const withStandard = (frontmatter: string): string => tree({ 'docs/standards/probe/probe.md': `---\n${frontmatter}\n---\n\nbody\n` });
  const read = (frontmatter: string): Standard[] => readStandards(withStandard(frontmatter), 'docs/standards');

  it('reads a BLOCK-form applies_to, the form a regex read as empty', () => {
    // The exact list, not merely non-empty: the bug produced [].
    assert.deepEqual(read(['id: BP-PROBE-100', 'enforcement: eslint-rule', 'applies_to:', '  - apps/api', '  - packages/one'].join('\n'))[0]?.appliesTo, ['apps/api', 'packages/one']);
  });

  it('reads block entries that are quoted, and stops at the next key', () => {
    const [s] = read(['id: BP-PROBE-101', 'applies_to:', "  - 'apps/web'", 'enforcement: validator', 'enforcement_config: run-validation.sh probe'].join('\n'));
    assert.deepEqual(s?.appliesTo, ['apps/web']);
    assert.equal(s?.enforcement, 'validator');
  });

  it('reads the inline form, quoted and bare', () => {
    assert.deepEqual(read(['id: BP-PROBE-102', 'enforcement: eslint-rule', "applies_to: ['apps/api', 'apps/web']"].join('\n'))[0]?.appliesTo, ['apps/api', 'apps/web']);
    assert.deepEqual(read(['id: BP-PROBE-103', 'enforcement: eslint-rule', 'applies_to: [apps/api]'].join('\n'))[0]?.appliesTo, ['apps/api']);
  });

  it('reads a MULTILINE FLOW-style applies_to', () => {
    assert.deepEqual(read(['id: BP-PROBE-105', 'enforcement: eslint-rule', 'applies_to: [', "  'apps/api',", "  'packages/one',", ']'].join('\n'))[0]?.appliesTo, ['apps/api', 'packages/one']);
  });

  it('reads a bare scalar applies_to as a one-entry list, and an absent one as none', () => {
    assert.deepEqual(read(['id: BP-PROBE-106', 'enforcement: eslint-rule', 'applies_to: apps/api'].join('\n'))[0]?.appliesTo, ['apps/api']);
    assert.deepEqual(read(['id: BP-PROBE-104', 'enforcement: eslint-rule'].join('\n'))[0]?.appliesTo, []);
  });

  it('reads every field it reports, trimmed, under the root-relative file path', () => {
    assert.deepEqual(
      read(
        [
          "id: '  BP-PROBE-108  '",
          'enforcement: guidance',
          "enforcement_config: ' Reviewer checks it '",
          'partial_gates: local/scope-rule',
          'applies_to: [apps/api, 3, " "]',
          "enforcement_script: ' scripts/probe.sh '",
          'status: deprecated',
        ].join('\n'),
      ),
      [
        {
          file: 'docs/standards/probe/probe.md',
          id: 'BP-PROBE-108',
          enforcement: 'guidance',
          enforcementConfig: 'Reviewer checks it',
          partialGates: 'local/scope-rule',
          appliesTo: ['apps/api'],
          enforcementScript: 'scripts/probe.sh',
          deprecated: true,
        },
      ],
    );
  });

  it('reads any status but deprecated as live, and a non-string scalar as its text', () => {
    assert.equal(read(['id: BP-PROBE-109', 'enforcement: validator', 'status: active'].join('\n'))[0]?.deprecated, false);
    assert.deepEqual(
      read(['id: 108', 'enforcement: guidance'].join('\n')).map((s) => s.id),
      ['108'],
    );
  });

  it('skips a standard that declares no enforcement, frontmatter that is not a mapping, and no frontmatter at all', () => {
    assert.deepEqual(read('id: BP-PROBE-109'), []);
    assert.deepEqual(read('~'), []);
    assert.deepEqual(readStandards(tree({ 'docs/standards/readme.md': '# no frontmatter\n' }), 'docs/standards'), []);
  });

  it('reads frontmatter only at the top of the file, and an absent field as empty', () => {
    assert.deepEqual(readStandards(tree({ 'docs/standards/a.md': 'intro\n---\nid: X\nenforcement: guidance\n---\n' }), 'docs/standards'), []);
    assert.deepEqual(read('enforcement: validator\nid: ~\nenforcement_config:'), [{ file: 'docs/standards/probe/probe.md', id: '', enforcement: 'validator', enforcementConfig: '', partialGates: '', appliesTo: [], enforcementScript: '', deprecated: false }]);
  });

  it('sorts the standards by file as text compares, not as the folder lists them', () => {
    const rule = (id: string): string => `---\nid: ${id}\nenforcement: guidance\n---\n`;
    const root = tree({ 'docs/standards/B.md': rule('BP-PROBE-121'), 'docs/standards/a.md': rule('BP-PROBE-120'), 'docs/standards/c/d.md': rule('BP-PROBE-122') });
    assert.deepEqual(
      readStandards(root, 'docs/standards').map((s) => s.file),
      ['docs/standards/a.md', 'docs/standards/B.md', 'docs/standards/c/d.md'],
    );
  });

  it('skips frontmatter that is not valid YAML, rather than counting it as a standard that passed', () => {
    // It declares an enforcement, so only the parse failure can skip it.
    assert.deepEqual(read(['id: BP-PROBE-107', 'enforcement: guidance', 'applies_to: [unbalanced'].join('\n')), []);
    assert.equal(read(['id: BP-PROBE-107', 'enforcement: guidance', 'applies_to: [balanced]'].join('\n')).length, 1);
  });

  it('reads only .md files, only under the folder, recursively and sorted, CRLF included', () => {
    const rule = (id: string): string => `---\nid: ${id}\nenforcement: guidance\n---\n`;
    const root = tree({
      'docs/standards/b/deep/z.md': rule('BP-PROBE-112'),
      'docs/standards/a.md': rule('BP-PROBE-110').replaceAll('\n', '\r\n'),
      'docs/standards/notes.txt': rule('BP-PROBE-111'),
      'docs/outside.md': rule('BP-PROBE-113'),
    });
    assert.deepEqual(
      readStandards(root, 'docs/standards').map((s) => [s.file, s.id]),
      [
        ['docs/standards/a.md', 'BP-PROBE-110'],
        ['docs/standards/b/deep/z.md', 'BP-PROBE-112'],
      ],
    );
  });
});

describe('claimedRules', () => {
  it('reads hyphen-less core rule names, which are still rule names', () => {
    assert.deepEqual(claimedRules('eqeqeq, curly, radix'), ['eqeqeq', 'curly', 'radix']);
  });

  it('reads rule names out of a claim without mistaking prose for one', () => {
    assert.deepEqual(claimedRules('vitest/no-disabled-tests, @scope/plugin/rule'), ['vitest/no-disabled-tests', '@scope/plugin/rule']);
    // A parenthetical narrows a rule rather than naming another one.
    assert.deepEqual(claimedRules('no-restricted-globals (Buffer)'), ['no-restricted-globals']);
    // A comma inside a parenthetical does not split the rule.
    assert.deepEqual(claimedRules('no-restricted-globals (Buffer, process), eqeqeq'), ['no-restricted-globals', 'eqeqeq']);
    assert.deepEqual(claimedRules('Reviewer confirms a determinism unit test exists'), []);
    assert.deepEqual(claimedRules(`${NO_INLINE_CONFIG}, no-console`), [NO_INLINE_CONFIG, 'no-console']);
    assert.deepEqual(claimedRules(''), []);
  });
});

describe('ruleIsOn', () => {
  it('reads error and warn as on, in either spelling', () => {
    for (const s of [2, 1, 'error', 'warn', [2, { allow: ['warn'] }]]) assert.equal(ruleIsOn(s), true, JSON.stringify(s));
  });

  it("reads 0 and 'off' as off, bare or as an options array's head", () => {
    for (const s of [0, 'off', [0], ['off', { allow: ['warn'] }]]) assert.equal(ruleIsOn(s), false, JSON.stringify(s));
  });
});

describe('ownersOf', () => {
  const dirs = ['.', 'apps/api', 'apps/web', 'packages/one', 'packages/two'];

  it('returns the SET a prefix covers, not its first member', () => {
    assert.deepEqual(ownersOf('packages', dirs), ['packages/one', 'packages/two']);
    assert.deepEqual(ownersOf('apps/api/src', dirs), ['apps/api']);
    assert.deepEqual(ownersOf('apps/web', dirs), ['apps/web']);
  });

  it('falls back to the root for a target under no workspace', () => {
    assert.deepEqual(ownersOf('scripts', dirs), ['.']);
    assert.deepEqual(ownersOf('.', dirs), ['.']);
    assert.deepEqual(ownersOf('./scripts', dirs), ['.']);
  });
});

describe('findEnforcementProblems', () => {
  // Each workspace's active rules, as activeRules resolves them.
  const ACTIVE = new Map<string, Set<string>>([
    ['.', new Set(['no-console', 'eqeqeq'])],
    ['apps/api', new Set(['no-console', 'local/order-by'])],
    ['apps/web', new Set(['no-console'])],
    ['packages/one', new Set(['no-console', 'no-debugger'])],
    ['packages/two', new Set(['no-debugger'])],
  ]);
  const DISPATCH = 'case "$1" in\n  masked|check-masked)\n    bash scripts/masked.sh\n    ;;\nesac\n';
  const problems = (s: Standard) => findEnforcementProblems([s], ACTIVE, DISPATCH, config());
  const NOWHERE = '(enforcement_config) is not enabled in ANY workspace config — the claim is false';

  it('refuses a rule that no workspace enables', () => {
    assert.deepEqual(problems(standard({ enforcementConfig: 'local/never-written' })), [{ file: 'docs/standards/probe.md', id: 'BP-PROBE-001', rule: 'local/never-written', reason: NOWHERE }]);
  });

  it('holds a root-scoped claim to the ROOT workspace, through the fallback', () => {
    assert.deepEqual(
      problems(standard({ enforcementConfig: 'local/order-by', appliesTo: ['scripts'] })).map((p) => p.reason),
      ['(enforcement_config) is enabled elsewhere but NOT in scripts, which is where this rule claims to apply'],
    );
    assert.deepEqual(problems(standard({ enforcementConfig: 'eqeqeq', appliesTo: ['scripts'] })), []);
  });

  it('skips a scope with no resolved config, so a root target with no root workspace checks nothing', () => {
    const only = new Map([['apps/api', new Set(['no-console'])]]);
    assert.deepEqual(findEnforcementProblems([standard({ enforcementConfig: 'no-console', appliesTo: ['docs'] })], only, '', { dispatcher: undefined, dispatchCall: undefined }), []);
  });

  it('names every claimed workspace when the rule is missing from them', () => {
    assert.deepEqual(
      problems(standard({ enforcementConfig: 'local/order-by', appliesTo: ['apps/web', 'packages/one'] })).map((p) => p.reason),
      ['(enforcement_config) is enabled elsewhere but NOT in apps/web, packages/one, which is where this rule claims to apply'],
    );
  });

  it('holds a claim to EVERY workspace its applies_to covers, not some', () => {
    // On in packages/one, off in packages/two: a prefix covering both fails.
    assert.match(problems(standard({ enforcementConfig: 'no-console', appliesTo: ['packages'] }))[0]?.reason ?? '', /NOT in packages,/);
    assert.match(problems(standard({ enforcementConfig: 'no-console', appliesTo: ['apps/api', 'packages/two'] }))[0]?.reason ?? '', /NOT in apps\/api, packages\/two/);
    // The narrow claim is the control.
    assert.deepEqual(problems(standard({ enforcementConfig: 'no-console', appliesTo: ['packages/one'] })), []);
    assert.deepEqual(problems(standard({ enforcementConfig: 'no-debugger', appliesTo: ['packages'] })), []);
  });

  it('passes a rule on where it applies, and one with no applies_to that is on somewhere', () => {
    assert.deepEqual(problems(standard({ enforcementConfig: 'local/order-by', appliesTo: ['apps/api'] })), []);
    assert.deepEqual(problems(standard({ enforcementConfig: 'local/order-by' })), []);
  });

  it('refuses a claim that names prose, and names an empty one as such', () => {
    assert.deepEqual(problems(standard({ enforcementConfig: 'Reviewer checks the diff by hand' })), [
      {
        file: 'docs/standards/probe.md',
        id: 'BP-PROBE-001',
        rule: 'Reviewer checks the diff by hand',
        reason: 'claims eslint-rule enforcement but enforcement_config names no rule — nothing here can be checked, by a reader or by this gate',
      },
    ]);
    assert.deepEqual(
      problems(standard({ enforcementConfig: '' })).map((p) => p.rule),
      ['(empty)'],
    );
    // A parenthetical stripped to a bare token that is no enabled rule.
    assert.deepEqual(
      problems(standard({ enforcementConfig: 'eslint (global config)' })).map((p) => [p.rule, p.reason]),
      [['eslint', NOWHERE]],
    );
  });

  it('holds partial_gates to the same standard, on a guidance or validator standard', () => {
    assert.deepEqual(
      problems(standard({ enforcement: 'guidance', partialGates: 'local/never-written' })).map((p) => p.reason),
      ['(partial_gates) is not enabled in ANY workspace config — the claim is false'],
    );
    assert.deepEqual(
      problems(standard({ enforcement: 'validator', enforcementConfig: 'run-validation.sh masked', partialGates: 'local/never-written' })).map((p) => p.reason),
      ['(partial_gates) is not enabled in ANY workspace config — the claim is false'],
    );
    assert.deepEqual(problems(standard({ enforcement: 'guidance', partialGates: 'local/order-by', appliesTo: ['apps/api'] })), []);
    assert.match(problems(standard({ enforcement: 'guidance', partialGates: 'local/order-by', appliesTo: ['apps/web'] }))[0]?.reason ?? '', /^\(partial_gates\) is enabled elsewhere but NOT in apps\/web/);
  });

  it('refuses a partial_gates that is prose naming no rule, and leaves an empty one alone', () => {
    assert.deepEqual(problems(standard({ enforcement: 'guidance', partialGates: 'Reviewer eyeballs the query for a tenant filter' })), [
      {
        file: 'docs/standards/probe.md',
        id: 'BP-PROBE-001',
        rule: 'Reviewer eyeballs the query for a tenant filter',
        reason: '(partial_gates) names no rule this gate can adjudicate — a partial gate that cannot be checked is not a gate',
      },
    ]);
    assert.deepEqual(problems(standard({ enforcement: 'guidance' })), []);
  });

  it('refuses a validator naming a dispatcher target that does not exist, matching every alias on a case line', () => {
    assert.deepEqual(problems(standard({ enforcement: 'validator', enforcementConfig: 'run-validation.sh no-such-target' })), [
      { file: 'docs/standards/probe.md', id: 'BP-PROBE-001', rule: 'no-such-target', reason: 'is not a case in scripts/run-validation.sh — the command does not exist' },
    ]);
    assert.deepEqual(problems(standard({ enforcement: 'validator', enforcementConfig: 'run-validation.sh masked' })), []);
    assert.deepEqual(problems(standard({ enforcement: 'validator', enforcementConfig: 'run-validation.sh check-masked' })), []);
    // No dispatcher call: the stage walk judges it.
    assert.deepEqual(problems(standard({ enforcement: 'validator', enforcementConfig: 'Reviewer checks it' })), []);
  });

  it('reads a dispatcher-shaped claim as prose when the repository has no dispatcher', () => {
    const claim = standard({ enforcement: 'validator', enforcementConfig: 'run-validation.sh no-such-target' });
    assert.deepEqual(findEnforcementProblems([claim], ACTIVE, '', config({ dispatcher: undefined })), []);
  });

  it('reads a deprecated standard as claiming nothing', () => {
    assert.deepEqual(problems(standard({ deprecated: true, enforcementConfig: 'local/never-written', partialGates: 'prose here' })), []);
    assert.deepEqual(problems(standard({ deprecated: true, enforcement: 'validator', enforcementConfig: 'run-validation.sh gone' })), []);
  });

  it('checks every standard, and leaves other modes alone', () => {
    assert.deepEqual(
      findEnforcementProblems([standard({ id: 'A', enforcementConfig: 'no-console' }), standard({ id: 'B', enforcementConfig: 'local/nope' }), standard({ id: 'C', enforcement: 'guidance', enforcementConfig: 'local/nope' })], ACTIVE, DISPATCH, config()).map((p) => p.id),
      ['B'],
    );
  });
});

/** A workspace flat config: these rules for TypeScript, test rules for tests. */
const flat = (rules: Record<string, unknown>, extra = ''): string =>
  `export default [{ files: ['**/*.ts'],${extra} rules: ${JSON.stringify(rules)} }, { files: ['**/*.test.ts'], rules: { 'no-unused-expressions': 'error' } }];\n`;

describe('activeRules', () => {
  it("resolves each workspace's own flat config through ESLint, test globs and linter options included", async () => {
    const root = tree({
      'eslint.config.mjs': flat({ 'no-console': 'error', eqeqeq: ['warn', 'always'], 'no-undef': 'off' }, ' linterOptions: { noInlineConfig: true },'),
      'apps/api/eslint.config.mjs': flat({ 'no-debugger': 2 }),
    });
    const active = await activeRules(ESLint, root, [
      { dir: '.', probes: ['scripts/probe.ts', 'scripts/probe.test.ts'] },
      { dir: 'apps/api', probes: ['src/probe.ts'] },
    ]);
    assert.deepEqual([...(active.get('.') ?? [])].sort(), ['eqeqeq', NO_INLINE_CONFIG, 'no-console', 'no-unused-expressions'].sort());
    assert.deepEqual([...(active.get('apps/api') ?? [])], ['no-debugger']);
  });

  it('reads a probe no config matches, or one ESLint ignores, as contributing nothing', async () => {
    const root = tree({ 'eslint.config.mjs': `export default [{ ignores: ['ignored/**'] }, { files: ['**/*.ts'], rules: { 'no-console': 'error' } }];\n` });
    const active = await activeRules(ESLint, root, [{ dir: '.', probes: ['a.js', 'ignored/b.ts', 'c.ts'] }]);
    assert.deepEqual([...(active.get('.') ?? [])], ['no-console']);
    assert.deepEqual([...((await activeRules(ESLint, root, [{ dir: '.', probes: ['ignored/b.ts'] }])).get('.') ?? [])], []);
  });

  it('skips a probe whose config fails while another resolves, and throws when none of a workspace resolves', async () => {
    const root = tree({ 'eslint.config.mjs': flat({ 'no-console': 'error' }) });
    let calls = 0;
    class Flaky {
      calculateConfigForFile(file: string): Promise<unknown> {
        calls += 1;
        return file.endsWith('bad.ts') ? Promise.reject(new Error('boom')) : Promise.resolve({ rules: { curly: 2 }, linterOptions: {} });
      }
    }
    assert.deepEqual([...((await activeRules(Flaky, root, [{ dir: '.', probes: ['bad.ts', 'good.ts'] }])).get('.') ?? [])], ['curly']);
    assert.equal(calls, 2);
    await assert.rejects(activeRules(Flaky, root, [{ dir: '.', probes: ['bad.ts'] }]), /^Error: no probe of workspace "\." resolves a config: boom$/);
    await assert.rejects(activeRules(ESLint, tree({ 'eslint.config.mjs': 'export default [' }), [{ dir: '.', probes: ['a.ts'] }]), /no probe of workspace "\." resolves a config/);
  });

  it('throws on a workspace folder that does not exist, rather than resolving another config', async () => {
    await assert.rejects(activeRules(ESLint, tree({ 'eslint.config.mjs': flat({}) }), [{ dir: 'apps/gone', probes: ['a.ts'] }]), /^Error: workspace "apps\/gone" is not a folder under the root$/);
  });
});

describe('loadEslint', () => {
  it("loads the eslint peer's class", async () => {
    assert.equal(await loadEslint(), ESLint);
  });

  it('names the peer when it is missing or exports no class', async () => {
    const message = 'needs the eslint package (>=9.24 <10) installed beside pariksha';
    assert.equal(await loadEslint(() => Promise.reject(new Error('Cannot find package'))), message);
    assert.equal(await loadEslint(() => Promise.resolve({})), message);
  });
});

describe('checkClaims', () => {
  it('throws on a missing standards folder, a corpus with no enforcement, or a missing dispatcher', async () => {
    await assert.rejects(checkClaims(tree({}), config(), ESLint), /^Error: the standards folder docs\/standards is not a folder under the root$/);
    await assert.rejects(checkClaims(tree({ 'docs/standards/a.md': '---\nid: X\n---\n' }), config(), ESLint), /^Error: no standard under docs\/standards declares an enforcement — the scan failed$/);
    await assert.rejects(checkClaims(tree({ 'docs/standards/a.md': '---\nid: X\nenforcement: guidance\n---\n' }), config(), ESLint), /ENOENT/);
  });
});

describe('checkClaims (a whole run)', () => {
  /** An ESLint stand-in whose every probe resolves to these rules. */
  const fixed = (rules: Record<string, unknown>) =>
    class {
      calculateConfigForFile(): Promise<unknown> {
        return Promise.resolve({ rules });
      }
    };
  const files = (dispatch: boolean): Record<string, string> => ({
    'docs/standards/lint.md': '---\nid: BP-LINT-001\nenforcement: eslint-rule\nenforcement_config: curly\n---\n',
    'docs/standards/check.md': '---\nid: BP-CHECK-001\nenforcement: validator\nenforcement_config: run-validation.sh gone\nenforcement_script: scripts/check.sh\n---\n',
    'scripts/check.sh': 'exit 0\n',
    '.husky/pre-commit': 'bash scripts/check.sh\n',
    'pnpm-workspace.yaml': 'packages:\n',
    'turbo.json': '{}\n',
    ...(dispatch ? { 'scripts/run-validation.sh': 'case "$1" in\n  here)\n    exit 0\n    ;;\nesac\n' } : {}),
  });

  it('reads the standards and returns every problem, the eslint-rule ones and the validator ones', async () => {
    const outcome = await checkClaims(tree({ ...files(true), '.husky/pre-commit': 'exit 0\n' }), config({ workspaces: [{ dir: '.', probes: ['a.ts'] }] }), fixed({ eqeqeq: 2 }));
    assert.deepEqual(
      outcome.standards.map((s) => s.id),
      ['BP-CHECK-001', 'BP-LINT-001'],
    );
    assert.deepEqual(outcome.problems, [
      { file: 'docs/standards/check.md', id: 'BP-CHECK-001', rule: 'gone', reason: 'is not a case in scripts/run-validation.sh — the command does not exist' },
      { file: 'docs/standards/lint.md', id: 'BP-LINT-001', rule: 'curly', reason: '(enforcement_config) is not enabled in ANY workspace config — the claim is false' },
      { file: 'docs/standards/check.md', id: 'BP-CHECK-001', rule: 'scripts/check.sh', reason: 'is never run by a hook or workflow — the claim names a validator nothing calls' },
    ]);
  });

  it('runs with no dispatcher, reading none', async () => {
    const outcome = await checkClaims(tree(files(false)), config({ dispatcher: undefined, workspaces: [{ dir: '.', probes: ['a.ts'] }] }), fixed({ curly: 'error' }));
    assert.deepEqual(outcome.problems, []);
    assert.equal(outcome.standards.length, 2);
  });
});

describe('formatOutcome', () => {
  const P = 'pariksha enforcement-claims:';

  it('counts the eslint-rule claims and the live validator claims on a pass', () => {
    const standards = [
      standard({}),
      standard({}),
      standard({ deprecated: true }),
      standard({ enforcement: 'validator' }),
      standard({ enforcement: 'validator' }),
      standard({ enforcement: 'validator' }),
      standard({ enforcement: 'validator' }),
      standard({ enforcement: 'validator', deprecated: true }),
      standard({ enforcement: 'guidance' }),
    ];
    assert.deepEqual(formatOutcome(P, { standards, problems: [] }), { ok: true, out: [`${P} every eslint-rule claim is real and every validator claim runs at a stage (2 + 4 of 9 rule(s))`], err: [] });
  });

  it('lists each problem on one line, file, id, rule and reason, then the count', () => {
    assert.deepEqual(formatOutcome(P, { standards: [], problems: [{ file: 'a.md', id: 'BP-1', rule: 'r', reason: 'why' }, { file: 'b.md', id: '', rule: 's', reason: 'because' }] }), {
      ok: false,
      out: [],
      err: [`${P} a.md (BP-1): \`r\` why`, `${P} b.md (no id): \`s\` because`, `${P} 2 untrue enforcement claim(s); a standard whose enforcement is described wrongly reads as enforced while nothing runs`],
    });
  });
});
