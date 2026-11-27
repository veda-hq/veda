// The configuration rules of repo-rules, each first on its lesson's own incident.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  callArguments,
  CONFIG_RULES,
  deletedPathStillPinned,
  eslintIgnoresWorktrees,
  isVitestConfig,
  jsoncBox,
  lefthookRuns,
  lockfileNames,
  lockfileSingleDocParse,
  matchersOf,
  mcpMatcherServerId,
  namedScripts,
  parseJsonc,
  preMergeCommitMergeHead,
  rollupStateGate,
  turboPassesWorkers,
  vitest4InertPoolConfig,
  withoutJsComments,
  workersIntoTurbo,
} from './repo-rules-configs.ts';
import { memoryRepo } from './repo-rules-memory.ts';

describe('the configuration rules', () => {
  it('lists the seven rules, in order', () => {
    assert.deepEqual(
      CONFIG_RULES.map((rule) => rule.id),
      ['vitest4-inert-pool-config', 'eslint-ignores-worktrees', 'lockfile-single-doc-parse', 'pre-merge-commit-merge-head', 'mcp-matcher-server-id', 'rollup-state-gate', 'deleted-path-still-pinned'],
    );
  });

  it('gives each rule its id and lesson', () => {
    assert.deepEqual(
      CONFIG_RULES.map((rule) => [rule.id, rule.lesson]),
      [
        [
          'vitest4-inert-pool-config',
          'Vitest 4 removed `poolOptions`, so `poolOptions.forks.maxForks` and its kin do nothing, and with no `maxWorkers` the pool takes `availableParallelism - 1`. Set `maxWorkers` (or `VITEST_MAX_WORKERS`, which Vitest 4 honours over it). Turborepo strict env mode strips `VITEST_MAX_WORKERS` unless turbo.json lists it in `globalPassThroughEnv`.',
        ],
        [
          'eslint-ignores-worktrees',
          "ESLint run from the repository root walks the nested git worktrees under `.claude/worktrees/` (whole checkouts, each with its own node_modules) and can run out of memory. Ignore the folder in the root flat config: `{ ignores: ['.claude/worktrees/**'] }`.",
        ],
        [
          'lockfile-single-doc-parse',
          'pnpm 12 writes `pnpm-lock.yaml` as two YAML documents (the package-manager record first, the project lockfile last), so a single-document parse throws or reads the wrong one. Parse every document (`loadAll`, `parseAllDocuments`, `safe_load_all`) and read the last non-empty one.',
        ],
        [
          'pre-merge-commit-merge-head',
          'During a clean `git merge` the `pre-merge-commit` hook runs before MERGE_HEAD exists (only a stopped merge writes it), so a check that reads it never runs. The merged heads are in `GITHEAD_<sha>` variables and `GIT_REFLOG_ACTION`; trust a candidate only when `git merge-tree --write-tree HEAD <sha>` equals `git write-tree`, and test the hook through a real `.git/hooks/pre-merge-commit` in a fixture.',
        ],
        [
          'mcp-matcher-server-id',
          'A hook matcher naming `mcp__<server-id>__<tool>` goes stale when the connector is reconnected under a new id, and the hook silently stops firing. Match a suffix regex instead, such as `^mcp__.*__(save_issue|save_comment)$`.',
        ],
        [
          'rollup-state-gate',
          "`statusCheckRollup.state` folds in every check, required or not, so one failing helper check makes everything that waits for rollup SUCCESS skip the pull request. Read the rollup's contexts and filter them by name, judging only the checks that gate.",
        ],
        [
          'deleted-path-still-pinned',
          "A test elsewhere can pin a file's path, asserting it still exists, so deleting or renaming the file passes the checks run on the change and fails only at the next full test run. Before deleting a file, `git grep -ln` its repository-relative path; update a live pin to the new path, or to a sibling the same glob reaches.",
        ],
      ],
    );
  });
});

describe('withoutJsComments and parseJsonc', () => {
  it('reads each escape, quote and comment edge', () => {
    // A backslash that ends the text is kept as it is.
    assert.equal(withoutJsComments('"a\\'), '"a\\');
    // A newline ends a quote, but not a template; an escaped newline does not.
    assert.equal(withoutJsComments("'a\\\n// b'\n// c"), "'a\\\n// b'\n    ");
    assert.equal(withoutJsComments('"a" // b'), '"a"     ');
    assert.equal(withoutJsComments('"a // b'), '"a // b');
    // A slash alone, or a star after any other character, opens nothing.
    assert.equal(withoutJsComments('a / b * c */ d // e'), 'a / b * c */ d     ');
    assert.equal(withoutJsComments('2*/* x */3'), '2*       3');
    // `/*/` does not close the comment it opens.
    assert.equal(withoutJsComments('/*/ a */b'), '        b');
    assert.equal(withoutJsComments('a /* b\nc */ d'), 'a     \n     d');
    // Offsets count UTF-16 units, so an astral character blanks to two spaces.
    assert.equal(withoutJsComments('/*😀*/x // 😀\ny'), '      x      \ny');
  });

  it('boxes what parses, null included, and gives null for what does not', () => {
    assert.deepEqual(jsoncBox('{ "a": [1,], }'), { value: { a: [1] } });
    assert.deepEqual(jsoncBox('null'), { value: null });
    assert.equal(jsoncBox('{'), null);
    assert.equal(parseJsonc('null'), null);
  });

  it('blanks comments, keeps strings and offsets', () => {
    const text = 'a // x\n/* b\nc */ "d // e" \'f /* g\' `h\n// i` j\\\'';
    const out = withoutJsComments(text);
    assert.equal(out.length, text.length);
    assert.equal(out, 'a     \n    \n     "d // e" \'f /* g\' `h\n// i` j\\\'');
    assert.equal(withoutJsComments('"a\\"b" // c'), '"a\\"b"     ');
    assert.equal(withoutJsComments('x /* open'), 'x        ');
    assert.equal(withoutJsComments('"unterminated\n// c'), '"unterminated\n    ');
  });

  it('reads JSON with comments and trailing commas, and nothing that is not JSON', () => {
    assert.deepEqual(parseJsonc('{ // c\n "a": [1, 2,], }'), { a: [1, 2] });
    assert.equal(parseJsonc('{'), undefined);
  });
});

describe('vitest4-inert-pool-config', () => {
  it('names Vitest and Vite configs', () => {
    for (const p of ['vitest.config.ts', 'apps/web/vite.config.mts', 'vitest.integration.config.js', 'vitest.workspace.ts', 'vitest.workspace.json']) assert.equal(isVitestConfig(p), true, p);
    for (const p of ['vitest.ts', 'src/config.ts', 'vite.config.json', 'vitest.workspace.jsonc']) assert.equal(isVitestConfig(p), false, p);
  });

  it('reads poolOptions only in a Vitest or Vite config', () => {
    assert.deepEqual(vitest4InertPoolConfig.run(memoryRepo({ 'src/pool.ts': 'export const poolOptions = {};\n' }), {}), []);
  });

  it('reads turbo.json strictly: an array, each env list, the pipeline, a null task and an escaped name', () => {
    assert.equal(turboPassesWorkers(['VITEST_MAX_WORKERS']), true);
    assert.equal(turboPassesWorkers({ globalEnv: ['OTHER', 'VITEST_MAX_WORKERS'] }), true);
    assert.equal(turboPassesWorkers({ pipeline: { test: { passThroughEnv: ['VITEST_MAX_WORKERS'] } } }), true);
    assert.equal(turboPassesWorkers({ tasks: { a: null, test: { env: ['VITEST_MAX_WORKERS'] } } }), true);
    assert.equal(turboPassesWorkers({ globalPassThroughEnv: ['VITEST_MAX_WORKERS?'] }), false);
  });

  it('reads a workflow job by job and step by step', () => {
    const wf = '.github/workflows/ci.yml';
    assert.deepEqual(workersIntoTurbo(wf, '~'), []);
    assert.deepEqual(workersIntoTurbo(wf, ''), []);
    // One job that hands it on is enough.
    assert.deepEqual(workersIntoTurbo(wf, 'jobs:\n  a:\n    env: { VITEST_MAX_WORKERS: 2 }\n    steps: [{ run: turbo run test }]\n  b:\n    steps: [{ run: vitest }]\n'), [3]);
    // A job's env does not reach another job's turbo step.
    assert.deepEqual(workersIntoTurbo(wf, 'jobs:\n  a:\n    env: { VITEST_MAX_WORKERS: 2 }\n    steps: [{ run: vitest run }]\n  b:\n    steps: [{ run: turbo run test }]\n'), []);
    // One step that hands it on is enough.
    assert.deepEqual(workersIntoTurbo(wf, 'jobs:\n  a:\n    steps:\n      - run: echo\n      - run: turbo run test\n        env: { VITEST_MAX_WORKERS: 2 }\n'), [6]);
    // A null step, and a run that is no string, run nothing.
    assert.deepEqual(workersIntoTurbo(wf, 'jobs:\n  a:\n    env: { VITEST_MAX_WORKERS: 2 }\n    steps: [~, { run: [turbo, run] }]\n'), []);
    // An env that only mentions the name, as a value, sets nothing.
    assert.deepEqual(workersIntoTurbo(wf, 'env: { OTHER: VITEST_MAX_WORKERS }\njobs:\n  a:\n    steps: [{ run: turbo run test }]\n'), []);
  });

  it('reads a shell script line by line', () => {
    const line = 'VITEST_MAX_WORKERS=1 turbo run test';
    assert.deepEqual(workersIntoTurbo('docs/run.shell', line), []);
    assert.deepEqual(workersIntoTurbo('a/.husky/pre-push', line), []);
    assert.deepEqual(workersIntoTurbo('.husky/pre-push.txt', line), []);
    assert.deepEqual(workersIntoTurbo('scripts/ci.sh', '# export VITEST_MAX_WORKERS=2\nturbo run test\n'), []);
    assert.deepEqual(workersIntoTurbo('scripts/ci.sh', '  export VITEST_MAX_WORKERS=2\nturbo run test\n'), [2]);
    assert.deepEqual(workersIntoTurbo('scripts/ci.sh', 'export  VITEST_MAX_WORKERS=2\nturbo run test\n'), [2]);
    assert.deepEqual(workersIntoTurbo('scripts/ci.sh', 'VITEST_MAX_WORKERS=1 turbo run test # ci\n'), [1]);
    assert.deepEqual(workersIntoTurbo('scripts/ci.sh', 'export VITEST_MAX_WORKERS=2\n  # turbo run test\n'), []);
    // An export reaches only the lines after it.
    assert.deepEqual(workersIntoTurbo('scripts/ci.sh', 'turbo run test\nexport VITEST_MAX_WORKERS=2\n'), []);
    assert.deepEqual(workersIntoTurbo('scripts/ci.sh', 'export VITEST_MAX_WORKERS= turbo run test\n'), []);
  });

  it('greps once for the callers when turbo.json changes', () => {
    const files = { 'turbo.json': '{}', 'scripts/x.sh': 'VITEST_MAX_WORKERS=2 turbo run test\n' };
    const base = memoryRepo(files, { selected: ['turbo.json'] });
    const calls: Array<[readonly string[], readonly string[]]> = [];
    const repo = {
      ...base,
      grep: (fixed: readonly string[], pathspecs: readonly string[]) => {
        calls.push([fixed, pathspecs]);
        return base.grep(fixed, pathspecs);
      },
    };
    assert.deepEqual(vitest4InertPoolConfig.run(repo, {}), [{ file: 'scripts/x.sh', line: 1, detail: "hands VITEST_MAX_WORKERS to a turbo run, and turbo.json's globalPassThroughEnv does not list it, so turbo strips it" }]);
    assert.deepEqual(calls, [[['VITEST_MAX_WORKERS'], ['.']]]);
  });

  it('refuses the incident: poolOptions.forks.maxForks that Vitest 4 ignored', () => {
    const repo = memoryRepo({
      'vitest.config.ts': "export default {\n  test: {\n    // poolOptions was removed\n    poolOptions: { forks: { maxForks: 2 } },\n  },\n};\n",
      'vite.config.ts': "// poolOptions: { forks: {} }\nexport default {};\n",
    });
    assert.deepEqual(vitest4InertPoolConfig.run(repo, {}), [{ file: 'vitest.config.ts', line: 4, detail: 'sets poolOptions, which Vitest 4 ignores' }]);
    assert.deepEqual(vitest4InertPoolConfig.run(memoryRepo({}, { selected: ['vitest.config.ts'] }), {}), []);
  });

  it('reads whether turbo lets VITEST_MAX_WORKERS through', () => {
    assert.equal(turboPassesWorkers(undefined), true);
    assert.equal(turboPassesWorkers({ envMode: 'loose' }), true);
    assert.equal(turboPassesWorkers({ globalPassThroughEnv: ['VITEST_MAX_WORKERS'] }), true);
    assert.equal(turboPassesWorkers({ globalEnv: ['VITEST_*'] }), true);
    assert.equal(turboPassesWorkers({ tasks: { test: { passThroughEnv: ['VITEST_MAX_WORKERS'] }, x: 1 } }), true);
    assert.equal(turboPassesWorkers({ pipeline: { test: { env: ['OTHER', 3] } } }), false);
    assert.equal(turboPassesWorkers({ globalPassThroughEnv: 'VITEST_MAX_WORKERS', tasks: [] }), false);
  });

  it('reads the lines that hand VITEST_MAX_WORKERS to turbo', () => {
    const wf = '.github/workflows/ci.yml';
    assert.deepEqual(workersIntoTurbo(wf, 'env:\n  VITEST_MAX_WORKERS: 2\njobs:\n  a:\n    steps:\n      - run: pnpm turbo run test\n'), [2]);
    assert.deepEqual(workersIntoTurbo(wf, 'jobs:\n  a:\n    env: { VITEST_MAX_WORKERS: 2 }\n    steps: [{ run: turbo run test }]\n'), [3]);
    assert.deepEqual(workersIntoTurbo(wf, 'jobs:\n  a:\n    steps:\n      - run: turbo run test\n        env: { VITEST_MAX_WORKERS: 2 }\n'), [5]);
    assert.deepEqual(workersIntoTurbo(wf, 'jobs:\n  a:\n    env: { VITEST_MAX_WORKERS: 2 }\n    steps: [{ run: vitest run }, "x", { uses: a }]\n  b: { steps: 1 }\n  c: 3\n'), []);
    assert.deepEqual(workersIntoTurbo('.github/actions/t/action.yml', 'runs:\n  steps:\n    - run: turbo run test\n      env: { VITEST_MAX_WORKERS: 1 }\n'), [4]);
    assert.deepEqual(workersIntoTurbo(wf, ': ['), []);
    assert.deepEqual(workersIntoTurbo('package.json', '{\n  "scripts": {\n    "t": "VITEST_MAX_WORKERS=2 turbo run test",\n    "v": "VITEST_MAX_WORKERS=2 vitest"\n  }\n}'), [3]);
    assert.deepEqual(workersIntoTurbo('scripts/ci.sh', 'export VITEST_MAX_WORKERS=2\n# turbo run test\nturbo run test\n'), [3]);
    assert.deepEqual(workersIntoTurbo('.husky/pre-push', 'VITEST_MAX_WORKERS=1 pnpm turbo run test\npnpm turbo run lint\n'), [1]);
    assert.deepEqual(workersIntoTurbo('src/a.ts', 'VITEST_MAX_WORKERS=1 turbo'), []);
  });

  it('refuses the incident: a hook that set VITEST_MAX_WORKERS for turbo, which strict env mode stripped', () => {
    const files = { 'turbo.json': '{ "globalPassThroughEnv": ["OTHER"] }', '.husky/pre-push': 'VITEST_MAX_WORKERS=2 pnpm turbo run test\n', 'scripts/x.sh': 'VITEST_MAX_WORKERS=2 turbo run test\n', 'notes.md': 'VITEST_MAX_WORKERS=2 turbo' };
    const detail = "hands VITEST_MAX_WORKERS to a turbo run, and turbo.json's globalPassThroughEnv does not list it, so turbo strips it";
    assert.deepEqual(vitest4InertPoolConfig.run(memoryRepo(files, { selected: ['.husky/pre-push'] }), {}), [{ file: '.husky/pre-push', line: 1, detail }]);
    // A turbo.json change judges every caller.
    assert.deepEqual(
      vitest4InertPoolConfig.run(memoryRepo(files, { selected: ['turbo.json'] }), {}).map((f) => f.file),
      ['.husky/pre-push', 'scripts/x.sh'],
    );
    assert.deepEqual(vitest4InertPoolConfig.run(memoryRepo({ ...files, 'turbo.json': '{ "globalPassThroughEnv": ["VITEST_MAX_WORKERS"] }' }), {}), []);
    assert.deepEqual(vitest4InertPoolConfig.run(memoryRepo({ '.husky/pre-push': files['.husky/pre-push'] }), {}), []);
    assert.deepEqual(vitest4InertPoolConfig.run(memoryRepo({ 'turbo.json': '{}', 'a.sh': 'echo' }, { selected: ['a.sh', 'gone.sh'] }), {}), []);
  });
});

describe('eslint-ignores-worktrees', () => {
  it('refuses the incident: a root config that walked nested worktrees out of memory', () => {
    const repo = memoryRepo({ 'eslint.config.js': "export default [{ ignores: ['dist/**'] }, // .claude/worktrees\n];\n", 'apps/web/eslint.config.js': 'export default [];' });
    assert.deepEqual(eslintIgnoresWorktrees.run(repo, {}), [{ file: 'eslint.config.js', detail: "the root ESLint config does not ignore '.claude/worktrees/**'" }]);
  });

  it('passes an ignore, or a .gitignore the config reads that lists the folder', () => {
    assert.deepEqual(eslintIgnoresWorktrees.run(memoryRepo({ 'eslint.config.mjs': "export default [{ ignores: ['.claude/worktrees/**'] }];" }), {}), []);
    const reads = "import { includeIgnoreFile } from '@eslint/compat';\nexport default [includeIgnoreFile(gitignorePath)];";
    assert.deepEqual(eslintIgnoresWorktrees.run(memoryRepo({ 'eslint.config.mjs': reads, '.gitignore': 'node_modules\n.claude/worktrees/\n' }), {}), []);
    assert.equal(eslintIgnoresWorktrees.run(memoryRepo({ 'eslint.config.mjs': reads, '.gitignore': 'node_modules\n' }), {}).length, 1);
    assert.equal(eslintIgnoresWorktrees.run(memoryRepo({ 'eslint.config.mjs': reads }), {}).length, 1);
    assert.deepEqual(eslintIgnoresWorktrees.run(memoryRepo({}, { selected: ['eslint.config.js'] }), {}), []);
  });

  it('judges only the root config, and reads each .gitignore line whole', () => {
    assert.deepEqual(eslintIgnoresWorktrees.run(memoryRepo({ 'eslint.config.json': '{}' }), {}), []);
    const reads = "import { includeIgnoreFile } from '@eslint/compat';\nexport default [includeIgnoreFile(gitignorePath)];";
    const judged = (gitignore: string) => eslintIgnoresWorktrees.run(memoryRepo({ 'eslint.config.mjs': reads, '.gitignore': gitignore }), {});
    const finding = [{ file: 'eslint.config.mjs', detail: "the root ESLint config does not ignore '.claude/worktrees/**'" }];
    assert.deepEqual(judged('.claude/\n'), []);
    assert.deepEqual(judged('/.claude/worktrees\n'), []);
    assert.deepEqual(judged('.claude/worktrees/** \n'), []);
    assert.deepEqual(judged('node_modules\n.claude/worktrees'), []);
    assert.deepEqual(judged('docs/.claude/worktrees/\n'), finding);
    assert.deepEqual(judged('.claude/settings.local.json\n'), finding);
  });
});

describe('lockfile-single-doc-parse', () => {
  it('reads call arguments to the matching paren, within a limit', () => {
    assert.equal(callArguments('f(a, g(b)) + c', 2), 'a, g(b)');
    assert.equal(callArguments('f(abcdef', 2, 3), 'abc');
    assert.equal(callArguments('f(abcd)', 2, 3), 'abc');
    assert.equal(callArguments('f()', 2), '');
    assert.equal(callArguments('f(a(b)c)d', 2), 'a(b)c');
  });

  it('follows names bound to the lockfile', () => {
    assert.deepEqual([...lockfileNames("const LOCK = 'pnpm-lock.yaml';\nconst text = readFileSync(LOCK);\nlet other = 1;\nraw = text\n")], ['LOCK', 'text', 'raw']);
    assert.deepEqual([...lockfileNames('const a = 1;')], []);
  });

  it('follows a chain written backwards through four passes, no more', () => {
    assert.deepEqual([...lockfileNames("e = d;\nd = c;\nc = b;\nb = a;\na = 'pnpm-lock.yaml';\n")], ['a', 'b', 'c', 'd']);
  });

  it('reads each way of writing a binding', () => {
    assert.deepEqual([...lockfileNames("const $lock = 'pnpm-lock.yaml';\nconst t = read($lock);\n")], ['$lock', 't']);
    assert.deepEqual([...lockfileNames("const  LOCK = 'pnpm-lock.yaml';")], ['LOCK']);
    assert.deepEqual([...lockfileNames("const LOCK='pnpm-lock.yaml';")], ['LOCK']);
    assert.deepEqual([...lockfileNames("const LOCK: string = 'pnpm-lock.yaml';")], ['LOCK']);
    // Only a declaration, or an assignment that starts its line, binds.
    assert.deepEqual([...lockfileNames("if (x) lock = 'pnpm-lock.yaml';")], []);
  });

  it('reads each spelling of a call, a Python comment and a name with a $', () => {
    const repo = memoryRepo({
      'scripts/spaced.ts': "const doc = YAML . parse(readFileSync('pnpm-lock.yaml'));\n",
      'scripts/dollar.ts': "const $lock = 'pnpm-lock.yaml';\nconst doc = load($lock);\n",
      'scripts/after.ts': "const x = load(other);\nconst p = 'pnpm-lock.yaml';\n",
      'tools/comments.py': "# yaml.safe_load(open('pnpm-lock.yaml'))\ndata = 1 # yaml.safe_load(open('pnpm-lock.yaml'))\n",
      'docs/a.ts.md': "load('pnpm-lock.yaml')",
    });
    assert.deepEqual(lockfileSingleDocParse.run(repo, {}), [
      { file: 'scripts/dollar.ts', line: 2, detail: '`load(…)` parses one document of pnpm-lock.yaml' },
      { file: 'scripts/spaced.ts', line: 1, detail: '`YAML.parse(…)` parses one document of pnpm-lock.yaml' },
    ]);
  });

  it('refuses the incident: a script that parsed pnpm 12\'s two-document lockfile as one', () => {
    const repo = memoryRepo({
      'scripts/pins.ts': "import { load } from 'js-yaml';\nconst lock = load(readFileSync('pnpm-lock.yaml', 'utf8'));\n",
      'scripts/chain.ts': "const LOCK = join(root, 'pnpm-lock.yaml');\nconst text = readFileSync(LOCK, 'utf8');\nconst doc = YAML.parse(text);\n",
      'scripts/ok.ts': "import { loadAll, load } from 'js-yaml';\nconst docs = loadAll(readFileSync('pnpm-lock.yaml', 'utf8'));\nconst ws = load(readFileSync('pnpm-workspace.yaml', 'utf8'));\n// load(readFileSync('pnpm-lock.yaml'))\n",
      'tools/lock.py': "import yaml\n# yaml.safe_load(open('pnpm-lock.yaml'))\ndata = yaml.safe_load(open('pnpm-lock.yaml'))\n",
      'notes.md': "load('pnpm-lock.yaml')",
      'scripts/other.ts': 'load(x)',
    });
    assert.deepEqual(lockfileSingleDocParse.run(repo, {}), [
      { file: 'scripts/chain.ts', line: 3, detail: '`YAML.parse(…)` parses one document of pnpm-lock.yaml' },
      { file: 'scripts/pins.ts', line: 2, detail: '`load(…)` parses one document of pnpm-lock.yaml' },
      { file: 'tools/lock.py', line: 3, detail: '`yaml.safe_load(…)` parses one document of pnpm-lock.yaml' },
    ]);
    assert.deepEqual(lockfileSingleDocParse.run(memoryRepo({}, { selected: ['a.ts'] }), {}), []);
  });
});

describe('pre-merge-commit-merge-head', () => {
  it('reads the scripts a hook names, from the root or its folder', () => {
    const tracked = new Set(['.husky/lib.sh', 'scripts/check.sh', 'scripts/check.ts']);
    assert.deepEqual(namedScripts('. "$(dirname -- "$0")/lib.sh"\nbash scripts/check.sh\npnpm exec tsx ./scripts/check.ts origin/main', '.husky/pre-merge-commit', tracked), ['.husky/lib.sh', 'scripts/check.sh', 'scripts/check.ts']);
    assert.deepEqual(namedScripts('. "${0%/*}/lib.sh"', '.husky/pre-merge-commit', tracked), ['.husky/lib.sh']);
    assert.deepEqual(namedScripts('. lib.sh', 'pre-merge-commit', new Set(['lib.sh'])), ['lib.sh']);
  });

  it("reads each spelling of the hook's own folder, for a name with no extension", () => {
    const tracked = new Set(['.husky/common', 'lib/common', 'libx.sh', 'scripts/check']);
    const hook = '.husky/pre-merge-commit';
    assert.deepEqual(namedScripts('. "$(dirname "$0")/common"', hook, tracked), ['.husky/common']);
    assert.deepEqual(namedScripts('. $(dirname $0)/common', hook, tracked), ['.husky/common']);
    assert.deepEqual(namedScripts('. "$( dirname  --  "$0" )"/common', hook, tracked), ['.husky/common']);
    assert.deepEqual(namedScripts('. ${0%/*}/common', hook, tracked), ['.husky/common']);
    assert.deepEqual(namedScripts('bash scripts/check', hook, tracked), ['scripts/check']);
    assert.deepEqual(namedScripts('. "$(dirname "$0")/lib/common"', 'pre-merge-commit', tracked), ['lib/common']);
    // At the top level the folder reads as nothing, so text glued before it joins the name.
    assert.deepEqual(namedScripts('. lib$(dirname "$0")/x.sh', 'pre-merge-commit', tracked), ['libx.sh']);
  });

  it("reads lefthook's pre-merge-commit run lines at any depth, and nothing else", () => {
    assert.deepEqual(lefthookRuns(undefined), []);
    assert.deepEqual(lefthookRuns({ 'pre-commit': { commands: { a: { run: 'bash a.sh' } } } }), []);
    const doc = {
      'pre-merge-commit': {
        commands: { a: { run: 'one' } },
        jobs: [{ run: 'two' }, { group: { jobs: [{ run: 'three' }] } }, { run: 4 }, null],
        name: 'not a run',
      },
    };
    assert.deepEqual(lefthookRuns(doc), ['one', 'two', 'three']);
  });

  it('reads only a lefthook config at the root, and no other YAML', () => {
    const config = 'pre-merge-commit:\n  commands:\n    m: { run: bash scripts/m.sh }\n';
    const files = { 'sub/lefthook.yml': config, 'lefthook.yml.bak': config, 'ci/hooks.yml': config, 'scripts/m.sh': 'git rev-parse MERGE_HEAD\n' };
    assert.deepEqual(preMergeCommitMergeHead.run(memoryRepo(files, { selected: ['scripts/m.sh'] }), {}), []);
  });

  it('skips a reached file gone from the working tree, and a config gone with it', () => {
    const base = memoryRepo({ '.husky/pre-merge-commit': 'git rev-parse MERGE_HEAD\n', 'lefthook.yml': 'pre-merge-commit: { commands: { a: { run: x } } }\n' });
    const repo = { ...base, read: (path: string) => (path === '.husky/pre-merge-commit' || path === 'lefthook.yml' ? undefined : base.read(path)) };
    assert.deepEqual(preMergeCommitMergeHead.run(repo, {}), []);
  });

  it('judges when any selected file is the config or a reached file, and lists findings by path', () => {
    const files = {
      'lefthook.yml': 'pre-merge-commit:\n  commands:\n    m: { run: bash scripts/z.sh && bash scripts/a.sh }\n',
      'scripts/z.sh': 'git rev-parse MERGE_HEAD\n',
      'scripts/a.sh': '\necho "$MERGE_HEAD"\n',
    };
    const detail = 'the pre-merge-commit hook reaches this file, and it reads MERGE_HEAD';
    const both = [
      { file: 'scripts/a.sh', line: 2, detail },
      { file: 'scripts/z.sh', line: 1, detail },
    ];
    assert.deepEqual(preMergeCommitMergeHead.run(memoryRepo(files, { selected: ['lefthook.yml', 'README.md'] }), {}), both);
    assert.deepEqual(preMergeCommitMergeHead.run(memoryRepo(files, { selected: ['scripts/z.sh', 'README.md'] }), {}), both);
  });

  it('refuses the incident: a pre-merge-commit check reading MERGE_HEAD, which a clean merge never writes', () => {
    const files = {
      '.husky/pre-merge-commit': '#!/bin/sh\n. "$(dirname -- "$0")/lib.sh"\n',
      '.husky/lib.sh': '# MERGE_HEAD is read below\nheads=$(cat .git/MERGE_HEAD)\n',
      'scripts/unrelated.sh': 'cat .git/MERGE_HEAD\n',
    };
    const detail = 'the pre-merge-commit hook reaches this file, and it reads MERGE_HEAD';
    assert.deepEqual(preMergeCommitMergeHead.run(memoryRepo(files, { selected: ['.husky/pre-merge-commit'] }), {}), [{ file: '.husky/lib.sh', line: 2, detail }]);
    assert.deepEqual(preMergeCommitMergeHead.run(memoryRepo(files, { selected: ['scripts/unrelated.sh'] }), {}), []);
  });

  it("reads lefthook's pre-merge-commit commands, and judges them when the config changes", () => {
    const files = {
      'lefthook.yml': 'pre-commit:\n  commands:\n    x: { run: bash scripts/a.sh }\npre-merge-commit:\n  commands:\n    merged:\n      run: bash scripts/merged.sh {staged_files}\n  jobs:\n    - run: 3\n    - name: y\n',
      'scripts/merged.sh': 'git rev-parse MERGE_HEAD\n',
      'scripts/a.sh': 'git rev-parse MERGE_HEAD\n',
    };
    assert.deepEqual(
      preMergeCommitMergeHead.run(memoryRepo(files, { selected: ['lefthook.yml'] }), {}).map((f) => f.file),
      ['scripts/merged.sh'],
    );
    assert.deepEqual(preMergeCommitMergeHead.run(memoryRepo({ 'lefthook.yml': 'pre-commit: {}\n' }), {}), []);
    assert.deepEqual(preMergeCommitMergeHead.run(memoryRepo({ '.husky/pre-merge-commit': 'exit 0\n' }), {}), []);
    assert.deepEqual(preMergeCommitMergeHead.run(memoryRepo({ 'lefthook.yml': 'x: 1' }, { selected: ['lefthook.yml', 'lefthook-local.yml', 'gone/pre-merge-commit'] }), {}), []);
  });
});

describe('mcp-matcher-server-id', () => {
  it('reads every hook matcher', () => {
    assert.deepEqual(matchersOf({ hooks: { PreToolUse: [{ matcher: 'Bash' }, { hooks: [] }, 'x'], Stop: 'y' } }), ['Bash']);
    assert.deepEqual(matchersOf({}), []);
  });

  it('refuses the incident: a deny hook that stopped firing when the connector came back under a new id', () => {
    const id = 'mcp__af47f3dd-fce2-461f-b77e-0810108a710b__';
    const repo = memoryRepo({
      '.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: `${id}save_issue` }, { matcher: '^mcp__.*__save_issue$' }, { matcher: 'mcp__ccd_pr__get_status' }] } }, null, 2),
      'plugins/x/hooks/hooks.json': `{ "hooks": { "PreToolUse": [ { "matcher": "${id.toUpperCase()}a" } ] } }`,
      'other.json': `{ "hooks": { "PreToolUse": [ { "matcher": "${id}a" } ] } }`,
    });
    assert.deepEqual(mcpMatcherServerId.run(repo, {}), [
      { file: '.claude/settings.json', line: 5, detail: `matcher "${id}save_issue" names a connector id (${id.slice(0, -2)})` },
      { file: 'plugins/x/hooks/hooks.json', line: 1, detail: `matcher "${id.toUpperCase()}a" names a connector id (${id.toUpperCase().slice(0, -2)})` },
    ]);
    assert.deepEqual(mcpMatcherServerId.run(memoryRepo({}, { selected: ['.claude/settings.json'] }), {}), []);
  });

  it('gives no line when the matcher is written escaped', () => {
    const repo = memoryRepo({ '.claude/settings.json': '{ "hooks": { "Stop": [ { "matcher": "mcp\\u005f_af47f3dd-fce2-461f-b77e-0810108a710b__x" } ] } }' });
    assert.equal(mcpMatcherServerId.run(repo, {})[0]?.line, undefined);
    assert.deepEqual(mcpMatcherServerId.run(repo, {}), [
      { file: '.claude/settings.json', detail: 'matcher "mcp__af47f3dd-fce2-461f-b77e-0810108a710b__x" names a connector id (mcp__af47f3dd-fce2-461f-b77e-0810108a710b)' },
    ]);
  });

  it('reads a root plugin hooks file, and no file named after one', () => {
    const settings = '{ "hooks": { "Stop": [ { "matcher": "mcp__af47f3dd-fce2-461f-b77e-0810108a710b__x" } ] } }';
    const repo = memoryRepo({ 'hooks/hooks.json': settings, 'hooks/hooks.json.bak': settings, '.claude/settings.json.bak': settings });
    assert.deepEqual(mcpMatcherServerId.run(repo, {}), [
      { file: 'hooks/hooks.json', line: 1, detail: 'matcher "mcp__af47f3dd-fce2-461f-b77e-0810108a710b__x" names a connector id (mcp__af47f3dd-fce2-461f-b77e-0810108a710b)' },
    ]);
  });
});

describe('rollup-state-gate', () => {
  it('refuses the incident: a drain that waited for rollup SUCCESS while a helper check failed', () => {
    const repo = memoryRepo({
      'scripts/drain.ts': "const ok = pr.statusCheckRollup?.state === 'SUCCESS';\n// statusCheckRollup.state is not read here\n",
      'scripts/q.graphql': 'commit { statusCheckRollup {\n  state } }\n',
      '.husky/pre-push': "gh pr view --json statusCheckRollup --jq '.statusCheckRollup.state'\n",
      'scripts/ok.ts': 'const failing = pr.statusCheckRollup.contexts.nodes.filter((c) => c.name === gate);\n',
      'docs/a.md': 'statusCheckRollup.state',
    });
    assert.deepEqual(
      rollupStateGate.run(repo, {}).map((f) => `${f.file}:${f.line}`),
      ['.husky/pre-push:1', 'scripts/drain.ts:1', 'scripts/q.graphql:1'],
    );
    assert.deepEqual(rollupStateGate.run(memoryRepo({}, { selected: ['a.ts'] }), {}), []);
  });

  it('reads each spacing of the field, skips only a comment line, and judges only gate code', () => {
    const detail = 'gates on statusCheckRollup.state';
    const repo = memoryRepo({
      'scripts/a.ts': 'x.statusCheckRollup. state\ny.statusCheckRollup .state\nconst q = `{ statusCheckRollup{ state } }`;\nconst ok = pr.statusCheckRollup.state; // gate\n  // statusCheckRollup.state\n',
      'site/page.shtml': 'statusCheckRollup.state',
      'docs/.husky/notes': 'statusCheckRollup.state',
    });
    assert.deepEqual(rollupStateGate.run(repo, {}), [
      { file: 'scripts/a.ts', line: 1, detail },
      { file: 'scripts/a.ts', line: 2, detail },
      { file: 'scripts/a.ts', line: 3, detail },
      { file: 'scripts/a.ts', line: 4, detail },
    ]);
  });
});

describe('deleted-path-still-pinned', () => {
  it('refuses the incident: a deleted test file whose path a validator test still asserted', () => {
    const repo = memoryRepo(
      {
        'scripts/validations/wiring.test.ts': "expect(existsSync('apps/web/src/old.test.ts')).toBe(true);\nconst other = \"apps/web/src/kept.ts\";\n",
        'tests/test_paths.py': 'assert exists(`scripts/gone.sh`)\n',
        'docs/notes.md': "'apps/web/src/old.test.ts'",
        'apps/web/src/old.test.ts': "'apps/web/src/old.test.ts'",
      },
      { removed: ['apps/web/src/old.test.ts', 'scripts/gone.sh'] },
    );
    assert.deepEqual(deletedPathStillPinned.run(repo, {}), [
      { file: 'scripts/validations/wiring.test.ts', line: 1, detail: 'quotes apps/web/src/old.test.ts, which this change deletes or renames' },
      { file: 'tests/test_paths.py', line: 1, detail: 'quotes scripts/gone.sh, which this change deletes or renames' },
    ]);
  });

  it('asks nothing when the selection removes nothing', () => {
    assert.deepEqual(deletedPathStillPinned.run(memoryRepo({ 'a.test.ts': "'x'" }), {}), []);
    const repo = {
      ...memoryRepo({ 'a.test.ts': "'x'" }),
      grep: () => {
        throw new Error('git grep ran');
      },
    };
    assert.deepEqual(deletedPathStillPinned.run(repo, {}), []);
  });
});
