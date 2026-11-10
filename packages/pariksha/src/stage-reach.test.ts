import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseConfig } from './enforcement-claims.ts';
import { codeLines, dispatcherCase, dispatcherTargets, findUncalledValidators, pathsIn, resolveStageReach, runnablePatterns, testFileRuns, workspaceDirs, yamlCommands, type Standard, type StageConfig, type StageReach } from './stage-reach.ts';

const made: string[] = [];
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-stage-reach-'));
  made.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

/** A config with one of every key, as a repository with hooks, workflows, a dispatcher and a package runner sets it. */
const CONFIG = {
  standards: 'docs/standards',
  workspaces: [{ dir: '.', probes: ['scripts/probe.ts'] }],
  dispatcher: { path: 'scripts/run-validation.sh' },
  packageRunner: { path: 'scripts/package-validations/validate-package.sh', call: 'run_validator', validatorsDir: 'scripts/package-validations/validators' },
  stageRoots: { hooks: ['.husky'], workflows: ['.github/workflows'], actions: ['.github/actions'] },
  runnable: { prefixes: ['scripts/', '.claude/scripts/', 'apps/*/scripts/', 'packages/*/scripts/'], extensions: ['sh', 'ts', 'mts', 'mjs', 'cjs', 'js', 'py'], bin: 'node_modules/.bin' },
  workspaceList: { pnpm: 'pnpm-workspace.yaml', turbo: 'turbo.json' },
  tests: { file: '\\.test\\.tsx?$', runner: '\\bvitest\\b|\\s--test\\b' },
};
const config = (over: Record<string, unknown> = {}): StageConfig => parseConfig(JSON.stringify({ ...CONFIG, ...over }));
const STAGES = config();
const RUNNABLE = STAGES.runnable;

const DISPATCH = [
  'case "$1" in',
  '  foo|check-foo)',
  '    bash scripts/validations/foo.sh "$@"',
  '    ;;',
  '  bar)',
  '    npx tsx scripts/validations/bar.ts',
  '    ;;',
  '  pk)',
  '    node_modules/.bin/pk check "$@"',
  '    ;;',
  '  pk-unrun)',
  '    node_modules/.bin/pk-unrun check',
  '    ;;',
  'esac',
  '',
].join('\n');

/** A small repo with one of every caller shape, and every decoy. */
const REPO: Record<string, string> = {
  'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - tools\n  - '!apps/excluded'\n",
  'turbo.json': '{ "tasks": { "//#lint": {}, "//#test:tooling": {} } }\n',
  'package.json': JSON.stringify({
    scripts: {
      'check:x': 'tsx scripts/x.ts',
      lint: 'bash scripts/lint.sh',
      'test:tooling': 'vitest run --project tooling',
      typecheck: 'bash scripts/root-typecheck.sh',
    },
  }),
  'apps/web/package.json': JSON.stringify({
    scripts: {
      'validate:pre-commit': 'bash ../../scripts/package-validations/validate-package.sh',
      test: 'vitest run',
      typecheck: 'tsc',
      count: 3,
    },
  }),
  'apps/server/package.json': JSON.stringify({ scripts: { 'test:cov': 'pnpm test:unit', 'test:unit': 'vitest run' } }),
  'apps/notapackage/readme.md': 'no package.json here\n',
  'tools/package.json': JSON.stringify({ name: 'tools' }),
  'scripts/run-validation.sh': DISPATCH,
  'scripts/validations/foo.sh': 'exit 0\n',
  'scripts/validations/bar.ts': 'export {};\n',
  'node_modules/.bin/pk': '#!/usr/bin/env node\n',
  'node_modules/.bin/pk-unrun': '#!/usr/bin/env node\n',
  'scripts/x.ts': '// names scripts/hidden.sh but TypeScript is not followed\n',
  'scripts/hidden.sh': 'exit 0\n',
  'scripts/lint.sh': 'exit 0\n',
  'scripts/root-typecheck.sh': 'exit 0\n',
  'scripts/outer.sh': 'bash scripts/inner.sh\nbash scripts/outer.sh\n',
  'scripts/inner.sh': 'exit 0\n',
  'scripts/aggregator.sh': 'bash scripts/validations/foo.sh\n',
  'scripts/commented.sh': 'exit 0\n',
  'scripts/printed.sh': 'exit 0\n',
  'scripts/ci-only.sh': 'exit 0\n',
  'scripts/action.sh': 'exit 0\n',
  'scripts/named.sh': 'exit 0\n',
  'scripts/package-validations/validate-package.sh': ['# run_validator "commented"', 'run_validator "alpha"'].join('\n'),
  'scripts/package-validations/validators/alpha.sh': 'bash ../../scripts/validations/alpha-check.sh\n',
  'scripts/package-validations/validators/beta.sh': 'bash ../../scripts/validations/beta-check.sh\n',
  'scripts/package-validations/validators/commented.sh': 'exit 0\n',
  'scripts/validations/alpha-check.sh': 'exit 0\n',
  'scripts/validations/beta-check.sh': 'exit 0\n',
  '.husky/pre-commit': [
    '# bash scripts/commented.sh',
    'echo "run scripts/printed.sh by hand"',
    'bash scripts/outer.sh',
    'bash scripts/run-validation.sh foo --staged',
    'bash scripts/run-validation.sh pk',
    'pnpm check:x',
    'pnpm turbo run validate:pre-commit --filter=...[HEAD]',
    'pnpm turbo run //#test:tooling lint 2>&1',
    'pnpm turbo run typecheck',
    'pnpm turbo run test',
  ].join('\n'),
  '.husky/_/husky.sh': 'bash scripts/aggregator.sh\n',
  '.github/workflows/ci.yml': [
    'on:',
    '  push:',
    '    paths:',
    '      - scripts/watched.sh',
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: Run scripts/named.sh',
    '        run: bash scripts/ci-only.sh',
    '      - run: |',
    '          # bash scripts/commented.sh',
    '          bash scripts/block.sh',
    '      - uses: ./.github/actions/setup',
    '      - uses: ./.github/actions/other',
    '      - uses: ./.github/actions/missing',
  ].join('\n'),
  '.github/workflows/notes.md': 'bash scripts/aggregator.sh\n',
  '.github/actions/setup/action.yml': 'runs:\n  steps:\n    - run: bash scripts/action.sh\n',
  '.github/actions/other/action.yaml': 'runs:\n  steps:\n    - run: bash scripts/other-action.sh\n',
  'scripts/other-action.sh': 'exit 0\n',
  'scripts/watched.sh': 'exit 0\n',
  'scripts/block.sh': 'exit 0\n',
};

describe('codeLines', () => {
  it('drops comments and printed text, keeping commands', () => {
    assert.equal(
      codeLines(['# a comment', '  # indented comment', 'echo "scripts/a.sh"', '  printf "%s" x', 'run: bash scripts/b.sh', 'echoed=1', 'value # trailing stays'].join('\n')),
      'run: bash scripts/b.sh\nechoed=1\nvalue # trailing stays',
    );
  });
});

describe('yamlCommands', () => {
  it('reads run steps and local actions, nothing a filter, name or input mentions', () => {
    assert.deepEqual(
      yamlCommands(
        [
          'on:',
          '  push:',
          '    paths: [scripts/watched.sh]',
          '  pull_request:',
          'env:',
          '  TOOL: scripts/env.sh',
          'jobs:',
          '  a:',
          '    steps:',
          '      - name: bash scripts/named.sh',
          '        run: bash scripts/a.sh',
          '      - uses: ./.github/actions/setup',
          '        with:',
          '          script: scripts/input.sh',
          '          action: ./.github/actions/not-a-use',
          '      - uses: actions/checkout@v4',
          '      - run: |',
          '          bash scripts/b.sh',
        ].join('\n'),
        ['.github/actions'],
      ),
      {
        runs: [
          { text: 'bash scripts/a.sh', dir: '.' },
          { text: 'bash scripts/b.sh\n', dir: '.' },
        ],
        actions: ['.github/actions/setup'],
      },
    );
  });

  it('reads run and uses only on a step, never an action input or another key that names them', () => {
    assert.deepEqual(
      yamlCommands(
        [
          'run: bash scripts/top.sh',
          'jobs:',
          '  a:',
          '    uses: ./.github/actions/job-level',
          '    steps:',
          '      - uses: ./.github/actions/setup',
          '        with:',
          '          run: bash scripts/input.sh',
          '          uses: ./.github/actions/input',
          '      - name: steps in an input',
          '        with:',
          '          steps:',
          '            - run: bash scripts/nested.sh',
          '      - plain string step',
        ].join('\n'),
        ['.github/actions'],
      ),
      { runs: [{ text: 'bash scripts/nested.sh', dir: '.' }], actions: ['.github/actions/setup'] },
    );
  });

  it("runs each step in its working-directory, else its job's or workflow's default", () => {
    const { runs } = yamlCommands(
      [
        'defaults:',
        '  run:',
        '    working-directory: apps/web',
        'jobs:',
        '  a:',
        '    steps:',
        '      - run: a',
        '      - run: b',
        '        working-directory: ./apps/api/',
        '      - run: c',
        '        working-directory: ${{ inputs.dir }}',
        '      - run: d',
        '        working-directory: ../outside',
        '      - run: e',
        '        working-directory: /abs',
        '  b:',
        '    defaults:',
        '      run:',
        '        working-directory: tools',
        '    steps:',
        '      - run: f',
        '  c:',
        '    defaults:',
        '      run: {}',
        '    steps:',
        '      - run: g',
        '  d:',
        '    defaults: plain',
        '    steps:',
        '      - run: h',
        '        working-directory: .',
      ].join('\n'),
      [],
    );
    assert.deepEqual(
      runs.map((r) => `${r.text}@${r.dir}`),
      ['a@apps/web', 'b@apps/api', 'c@apps/web', 'd@apps/web', 'e@apps/web', 'f@tools', 'g@apps/web', 'h@.'],
    );
  });

  it('reads a local action only under a configured actions folder', () => {
    assert.deepEqual(yamlCommands('steps:\n  - uses: ./.github/actions/setup\n  - uses: ./ci/actions/build\n', ['ci/actions']).actions, ['ci/actions/build']);
  });

  it('reads nothing from an empty document', () => {
    assert.deepEqual(yamlCommands('', ['.github/actions']), { runs: [], actions: [] });
  });
});

describe('workspaceDirs', () => {
  it('expands dir/* to the subdirectories with a package.json, sorted, and keeps literals', () => {
    const root = tree({
      'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - packages/one\n  - 3\n  - "gone/*"\n\nother:\n  - nope\n',
      'apps/b/package.json': '{}',
      'apps/a/package.json': '{}',
      'apps/c/readme.md': '',
    });
    assert.deepEqual(workspaceDirs(root, 'pnpm-workspace.yaml'), ['apps/a', 'apps/b', 'packages/one']);
  });

  it('removes what an exclusion names, a folder or a dir/* glob', () => {
    const root = tree({
      'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "tools/*"\n  - packages/one\n  - "!apps/b"\n  - "!tools/*"\n  - "!packages/on"\n',
      'apps/a/package.json': '{}',
      'apps/b/package.json': '{}',
      'tools/x/package.json': '{}',
    });
    assert.deepEqual(workspaceDirs(root, 'pnpm-workspace.yaml'), ['apps/a', 'packages/one']);
  });

  it('reads none when the file declares no packages, or is not a mapping', () => {
    assert.deepEqual(workspaceDirs(tree({ 'pnpm-workspace.yaml': 'overrides: {}\n' }), 'pnpm-workspace.yaml'), []);
    assert.deepEqual(workspaceDirs(tree({ 'pnpm-workspace.yaml': '' }), 'pnpm-workspace.yaml'), []);
  });
});

describe('dispatcherCase', () => {
  it('returns the body of the case naming the target, by any alias', () => {
    assert.equal(dispatcherCase(DISPATCH, 'foo'), '    bash scripts/validations/foo.sh "$@"\n');
    assert.equal(dispatcherCase(DISPATCH, 'check-foo'), dispatcherCase(DISPATCH, 'foo'));
    assert.equal(dispatcherCase(DISPATCH, 'bar'), '    npx tsx scripts/validations/bar.ts\n');
  });

  it('returns nothing for a target no case names', () => {
    assert.equal(dispatcherCase(DISPATCH, 'fo'), '');
    assert.equal(dispatcherCase(DISPATCH, 'baz'), '');
  });

  it('lists every alias of every case line', () => {
    assert.deepEqual([...dispatcherTargets(DISPATCH)], ['foo', 'check-foo', 'bar', 'pk', 'pk-unrun']);
  });
});

describe('pathsIn', () => {
  it('resolves each path from the directory the command runs in', () => {
    assert.deepEqual(pathsIn('bash ../../scripts/a.sh && tsx ./scripts/b.ts; node scripts/c.mjs', 'apps/web', RUNNABLE), ['scripts/a.sh', 'apps/web/scripts/b.ts', 'apps/web/scripts/c.mjs']);
  });

  it('reads every configured prefix and extension', () => {
    assert.deepEqual(pathsIn(['.claude/scripts/a.ts', 'scripts/b.mts', 'scripts/c.cjs', 'scripts/d.js', 'scripts/e.py', 'scripts/sub/dir/f-g_h.sh'].join(' '), '.', RUNNABLE), [
      '.claude/scripts/a.ts',
      'scripts/b.mts',
      'scripts/c.cjs',
      'scripts/d.js',
      'scripts/e.py',
      'scripts/sub/dir/f-g_h.sh',
    ]);
  });

  it("reads a workspace's own scripts/ path named from the root, through a * segment", () => {
    assert.deepEqual(pathsIn('npx tsx apps/web/scripts/a.ts; bash apps/mobile/scripts/b.sh packages/shared/scripts/c.ts', '.', RUNNABLE), ['apps/web/scripts/a.ts', 'apps/mobile/scripts/b.sh', 'packages/shared/scripts/c.ts']);
    // Only a configured prefix: every other one is a longer word.
    assert.deepEqual(pathsIn('docs/web/scripts/a.ts apps/scripts/b.sh', '.', RUNNABLE), []);
  });

  it('reads only the configured prefixes and extensions', () => {
    const only = runnablePatterns(['tools/'], ['rb'], undefined);
    assert.deepEqual(pathsIn('tools/a.rb scripts/b.sh tools/c.sh node_modules/.bin/x', '.', only), ['tools/a.rb']);
  });

  it('drops a path that climbs out of the repository', () => {
    assert.deepEqual(pathsIn('bash ../../../scripts/a.sh', 'apps/web', RUNNABLE), []);
  });

  it('does not read a path glued to a longer word or extension', () => {
    assert.deepEqual(pathsIn('myscripts/a.sh scripts/b.shell scripts/c.json x-scripts/d.sh', '.', RUNNABLE), []);
  });

  it("reads a pinned package's binary, resolved from the directory it runs in", () => {
    assert.deepEqual(pathsIn('node_modules/.bin/pariksha export-deletions; "./node_modules/.bin/a-b_c" x', 'apps/web', RUNNABLE), ['apps/web/node_modules/.bin/pariksha', 'apps/web/node_modules/.bin/a-b_c']);
    assert.deepEqual(pathsIn('../../../node_modules/.bin/x', 'apps/web', RUNNABLE), []);
    // Glued to a longer word, an extension or a directory: not that binary.
    assert.deepEqual(pathsIn(['my-node_modules/.bin/a', 'node_modules/.bin/b.js', 'node_modules/.bin/c/d', 'lib/node_modules/.bin/e'].join('\n'), '.', RUNNABLE), []);
  });

  it('reads a binary only where it runs as a command', () => {
    assert.deepEqual(
      pathsIn(
        [
          '  node_modules/.bin/a',
          'x; node_modules/.bin/b',
          'x && node_modules/.bin/c',
          'x || node_modules/.bin/d',
          'x | node_modules/.bin/e',
          '(node_modules/.bin/f)',
          'if ! node_modules/.bin/g; then node_modules/.bin/h; fi',
          'for x in y; do node_modules/.bin/i; done',
          'exec node_modules/.bin/j',
          'FOO=1 BAR= node_modules/.bin/k',
          "'node_modules/.bin/l'",
          'x && ! node_modules/.bin/m',
          'if node_modules/.bin/n; then x; elif node_modules/.bin/o; then x; else node_modules/.bin/p; fi',
          'while node_modules/.bin/q; do x; done',
          'until node_modules/.bin/r; do x; done',
        ].join('\n'),
        '.',
        RUNNABLE,
      ),
      'abcdefghijklmnopqr'.split('').map((c) => `node_modules/.bin/${c}`),
    );
    // Named, tested or printed, it runs nothing.
    assert.deepEqual(
      pathsIn(
        [
          'test -x node_modules/.bin/a',
          '[ -x node_modules/.bin/b ]',
          'echo node_modules/.bin/c',
          'cp node_modules/.bin/d x',
          'redo node_modules/.bin/e',
          'thence node_modules/.bin/f',
          'executor node_modules/.bin/g',
          'iffy node_modules/.bin/h',
          'elsewhere node_modules/.bin/i',
          'awhile node_modules/.bin/j',
        ].join('\n'),
        '.',
        RUNNABLE,
      ),
      [],
    );
  });

  it('reads no binary when no bin folder is configured', () => {
    assert.deepEqual(pathsIn('node_modules/.bin/a', '.', runnablePatterns(['scripts/'], ['sh'], undefined)), []);
  });

  it('reads a path inside quotes and after an equals sign', () => {
    assert.deepEqual(pathsIn('"scripts/a.sh" X=scripts/b.ts', '.', RUNNABLE), ['scripts/a.sh', 'scripts/b.ts']);
  });
});

describe('resolveStageReach', () => {
  const reach = (): StageReach => resolveStageReach(tree(REPO), STAGES);

  it('reaches what the hooks and workflows run, through every layer', () => {
    const { files } = reach();
    for (const path of [
      '.husky/pre-commit',
      '.github/workflows/ci.yml',
      'scripts/outer.sh',
      'scripts/inner.sh',
      'scripts/validations/foo.sh',
      'scripts/x.ts',
      'scripts/package-validations/validate-package.sh',
      'scripts/package-validations/validators/alpha.sh',
      'scripts/validations/alpha-check.sh',
      'scripts/lint.sh',
      'scripts/ci-only.sh',
      '.github/actions/setup/action.yml',
      'scripts/action.sh',
      '.github/actions/other/action.yaml',
      'scripts/other-action.sh',
      'scripts/block.sh',
      'node_modules/.bin/pk',
    ]) {
      assert.equal(files.has(path), true, path);
    }
  });

  it('does not reach what nothing runs: the dispatcher file, TypeScript, comments, echo, YAML filters and names', () => {
    const { files } = reach();
    for (const path of [
      'scripts/run-validation.sh',
      'scripts/validations/bar.ts',
      'node_modules/.bin/pk-unrun',
      'scripts/hidden.sh',
      'scripts/aggregator.sh',
      'scripts/commented.sh',
      'scripts/printed.sh',
      'scripts/named.sh',
      'scripts/watched.sh',
      'scripts/package-validations/validators/beta.sh',
      'scripts/package-validations/validators/commented.sh',
      'scripts/validations/beta-check.sh',
      'scripts/root-typecheck.sh',
      '.husky/_/husky.sh',
      '.github/workflows/notes.md',
    ]) {
      assert.equal(files.has(path), false, path);
    }
  });

  it('records the package scripts it ran, per workspace, with their commands', () => {
    const scripts = reach().scripts;
    assert.deepEqual([...scripts.keys()].sort(), ['.\tcheck:x', '.\tlint', '.\ttest:tooling', 'apps/web\ttest', 'apps/web\ttypecheck', 'apps/web\tvalidate:pre-commit']);
    assert.equal(scripts.get('.\tcheck:x'), 'tsx scripts/x.ts');
  });

  it('follows pnpm inside a workspace script to that workspace', () => {
    const root = tree({ ...REPO, '.husky/pre-commit': 'pnpm turbo run test:cov\n' });
    assert.deepEqual([...resolveStageReach(root, STAGES).scripts.keys()].sort(), ['apps/server\ttest:cov', 'apps/server\ttest:unit']);
  });

  it("walks a workflow step's commands from its working-directory", () => {
    const root = tree({
      ...REPO,
      '.husky/pre-commit': '',
      '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - run: pnpm test && bash scripts/local.sh\n        working-directory: apps/web\n',
      'apps/web/scripts/local.sh': 'exit 0\n',
    });
    const reach = resolveStageReach(root, STAGES);
    assert.deepEqual([...reach.scripts.keys()], ['apps/web\ttest']);
    assert.equal(reach.files.has('apps/web/scripts/local.sh'), true);
  });

  it('reads a script name only as the package.json names it, never an inherited member', () => {
    const root = tree({ ...REPO, '.husky/pre-commit': 'pnpm constructor\npnpm turbo run toString __proto__\n' });
    assert.deepEqual([...resolveStageReach(root, STAGES).scripts.keys()], []);
  });

  it('runs no root task through turbo when no turbo config is named', () => {
    const root = tree({ ...REPO, '.husky/pre-commit': 'pnpm turbo run lint\n' });
    assert.deepEqual([...resolveStageReach(root, config({ workspaceList: { pnpm: 'pnpm-workspace.yaml' } })).scripts.keys()], []);
  });

  it('follows no package runner when none is configured', () => {
    const files = resolveStageReach(tree(REPO), config({ packageRunner: null })).files;
    assert.equal(files.has('scripts/package-validations/validate-package.sh'), true);
    assert.equal(files.has('scripts/package-validations/validators/alpha.sh'), false);
  });

  it('walks a repo with no hooks or workflows to nothing', () => {
    const root = tree({ 'pnpm-workspace.yaml': 'packages:\n', 'turbo.json': '{}', 'scripts/run-validation.sh': '' });
    assert.deepEqual(resolveStageReach(root, STAGES), { files: new Set(), scripts: new Map(), workspaces: [] });
  });

  it('throws naming a workflow that is not YAML, or a package.json that is not JSON', () => {
    assert.throws(() => resolveStageReach(tree({ ...REPO, '.github/workflows/bad.yml': 'a: [' }), STAGES), /^Error: \.github\/workflows\/bad\.yml is not YAML: /);
    assert.throws(() => resolveStageReach(tree({ ...REPO, 'package.json': '{' }), STAGES), /^Error: package\.json is not JSON: /);
  });

  it('throws on a missing dispatcher or workspace file', () => {
    assert.throws(() => resolveStageReach(tree({ 'pnpm-workspace.yaml': 'packages:\n', 'turbo.json': '{}' }), STAGES), /ENOENT/);
    assert.throws(() => resolveStageReach(tree({ 'scripts/run-validation.sh': '', 'turbo.json': '{}' }), STAGES), /ENOENT/);
  });
});

describe('testFileRuns', () => {
  const reachWith = (scripts: Array<[string, string]>): StageReach => ({ files: new Set(), scripts: new Map(scripts), workspaces: ['apps/web', 'apps/web/nested', 'apps/server'] });

  it('is true when its workspace runs a test runner some stage reached', () => {
    const reach = reachWith([
      ['apps/web\ttest', 'vitest run'],
      ['.\ttest:claude', 'tsx --test .claude/scripts/*.test.ts'],
    ]);
    assert.equal(testFileRuns('apps/web/src/a.test.ts', reach, STAGES), true);
    assert.equal(testFileRuns('apps/web/src/a.test.tsx', reach, STAGES), true);
    assert.equal(testFileRuns('scripts/a.test.ts', reach, STAGES), true);
  });

  it('is false for another workspace, a non-runner script, or a non-test file', () => {
    const reach = reachWith([
      ['apps/web\ttest', 'vitest run'],
      ['apps/server\tlint', 'eslint .'],
      ['apps/serverx\ttest', 'vitest run'],
    ]);
    assert.equal(testFileRuns('apps/server/src/a.test.ts', reach, STAGES), false);
    assert.equal(testFileRuns('apps/web/src/a.ts', reach, STAGES), false);
    assert.equal(testFileRuns('apps/web/src/a.test.ts.snap', reach, STAGES), false);
    assert.equal(testFileRuns('scripts/a.test.ts', reach, STAGES), false);
  });

  it('owns a file by the longest workspace prefix', () => {
    assert.equal(testFileRuns('apps/web/nested/a.test.ts', reachWith([['apps/web\ttest', 'vitest run']]), STAGES), false);
  });

  it('does not take a script that merely mentions a runner flag in a word', () => {
    assert.equal(testFileRuns('apps/web/a.test.ts', reachWith([['apps/web\tx', 'run --testing && myvitest']]), STAGES), false);
  });

  it('uses the configured test-file and runner patterns', () => {
    const jest = config({ tests: { file: '\\.spec\\.js$', runner: '\\bjest\\b' } });
    const reach = reachWith([['apps/web\ttest', 'jest']]);
    assert.equal(testFileRuns('apps/web/a.spec.js', reach, jest), true);
    assert.equal(testFileRuns('apps/web/a.test.ts', reach, jest), false);
  });
});

describe('findUncalledValidators', () => {
  const claim = (overrides: Partial<Standard>): Standard => ({
    file: 'docs/standards/probe.md',
    id: 'BP-PROBE-001',
    enforcement: 'validator',
    enforcementConfig: '',
    partialGates: '',
    appliesTo: [],
    enforcementScript: '',
    deprecated: false,
    ...overrides,
  });
  const root = tree({ ...REPO, 'apps/web/src/a.test.ts': '', 'apps/server/src/b.test.ts': '' });
  const problems = (standard: Standard) => findUncalledValidators(root, [standard], STAGES);
  const NEVER = 'is never run by a hook or workflow — the claim names a validator nothing calls';

  it('passes a claim whose script a stage runs, by path or through the dispatcher', () => {
    assert.deepEqual(problems(claim({ enforcementScript: 'scripts/inner.sh' })), []);
    assert.deepEqual(problems(claim({ enforcementScript: './scripts/inner.sh' })), []);
    assert.deepEqual(problems(claim({ enforcementConfig: 'run-validation.sh check-foo' })), []);
    assert.deepEqual(problems(claim({ enforcementScript: 'apps/web/src/a.test.ts' })), []);
    assert.deepEqual(problems(claim({ enforcementConfig: 'run-validation.sh pk' })), []);
  });

  it('reports a dispatcher target whose package binary no stage runs', () => {
    assert.deepEqual(problems(claim({ enforcementConfig: 'run-validation.sh pk-unrun' })), [{ file: 'docs/standards/probe.md', id: 'BP-PROBE-001', rule: 'node_modules/.bin/pk-unrun', reason: NEVER }]);
  });

  it('passes when one of the named files runs', () => {
    assert.deepEqual(problems(claim({ enforcementScript: 'scripts/hidden.sh', enforcementConfig: 'run-validation.sh foo' })), []);
  });

  it('reports a claim whose target exists but nothing reaches, each file named once', () => {
    assert.deepEqual(problems(claim({ enforcementScript: 'scripts/validations/bar.ts', enforcementConfig: 'run-validation.sh bar' })), [{ file: 'docs/standards/probe.md', id: 'BP-PROBE-001', rule: 'scripts/validations/bar.ts', reason: NEVER }]);
    // A cited test counts only when its workspace has a reached runner script.
    assert.equal(problems(claim({ enforcementScript: 'apps/server/src/b.test.ts' }))[0]?.rule, 'apps/server/src/b.test.ts');
    assert.equal(problems(claim({ enforcementScript: 'scripts/hidden.sh', enforcementConfig: 'run-validation.sh bar' }))[0]?.rule, 'scripts/hidden.sh, scripts/validations/bar.ts');
  });

  it('reports a claim that names nothing', () => {
    assert.deepEqual(problems(claim({ enforcementConfig: 'Reviewer checks it' })), [
      { file: 'docs/standards/probe.md', id: 'BP-PROBE-001', rule: 'Reviewer checks it', reason: 'claims validator enforcement but names no script — nothing here can run' },
    ]);
    assert.equal(problems(claim({}))[0]?.rule, '(empty)');
    assert.equal(problems(claim({ enforcementConfig: 'run-validation.sh nope' }))[0]?.rule, 'run-validation.sh nope');
  });

  it('reports each named file that does not exist, and nothing else for it', () => {
    assert.deepEqual(problems(claim({ enforcementScript: 'scripts/gone.sh', enforcementConfig: 'run-validation.sh foo' })), [{ file: 'docs/standards/probe.md', id: 'BP-PROBE-001', rule: 'scripts/gone.sh', reason: 'does not exist' }]);
  });

  it('ignores other enforcement modes and deprecated claims, without walking', () => {
    assert.deepEqual(findUncalledValidators(tree({}), [claim({ enforcement: 'guidance' }), claim({ enforcement: 'eslint-rule' }), claim({ deprecated: true })], STAGES), []);
  });

  it('checks every live claim, not only the first', () => {
    assert.deepEqual(
      findUncalledValidators(root, [claim({ enforcementScript: 'scripts/inner.sh' }), claim({ id: 'BP-PROBE-002', enforcementScript: 'scripts/hidden.sh' })], STAGES).map((p) => p.id),
      ['BP-PROBE-002'],
    );
  });

  it('uses a reach it is given instead of walking', () => {
    const given: StageReach = { files: new Set(['scripts/hidden.sh']), scripts: new Map(), workspaces: [] };
    assert.deepEqual(findUncalledValidators(root, [claim({ enforcementScript: 'scripts/hidden.sh' })], STAGES, given), []);
  });

  it('reads the dispatcher call by the configured file name, and follows only the configured dispatcher by case', () => {
    const other = tree({ ...REPO, 'ci/dispatch.sh': DISPATCH });
    const stages = config({ dispatcher: { path: 'ci/dispatch.sh' } });
    assert.deepEqual(findUncalledValidators(other, [claim({ enforcementConfig: 'run-validation.sh pk' })], stages)[0]?.reason, 'claims validator enforcement but names no script — nothing here can run');
    // scripts/run-validation.sh is an ordinary script under this config, so
    // the hook's call follows the whole file, pk-unrun's line included.
    assert.deepEqual(findUncalledValidators(other, [claim({ enforcementConfig: 'dispatch.sh pk-unrun' })], stages), []);
  });
});
