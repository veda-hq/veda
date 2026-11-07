import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { format } from 'node:util';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import * as hygiene from './process-hygiene.js';

/**
 * SHELL-09, TEST-STRUCT-11 and test process hygiene: the cases for
 * `test-lint/process-hygiene.js`, the module this suite owns.
 *
 * Each `invalid` case is a review finding, reduced to the shape that still
 * reproduces it. Each `valid` case is the corrected code or a near miss. The
 * `guard removal` blocks delete only the guard from a corrected case and
 * prove the rule fires again.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

type AnyRule = Parameters<RuleTester['run']>[1];

const rules = {
  'no-process-exit': hygiene.noProcessExit,
  'cli-entry-helper': hygiene.cliEntryHelper,
  'git-spawn-env': hygiene.gitSpawnEnv,
  'git-fixture-env': hygiene.gitFixtureEnv,
  'no-global-patch': hygiene.noGlobalPatch,
  'no-partial-git-mask': hygiene.noPartialGitMask,
  'env-via-stub': hygiene.envViaStub,
  'spawn-timeout': hygiene.spawnTimeout,
  'no-raw-group-kill': hygiene.noRawGroupKill,
  'detached-teardown': hygiene.detachedTeardown,
} as unknown as Record<string, AnyRule>;

const plugin = { meta: { name: 'shuddhi' }, rules } as unknown as NonNullable<
  Linter.Config['plugins']
>[string];

/** Vitest's `it.each`: one `it` per row, its title printf-formatted. */
function each<const T>(rows: readonly T[]) {
  return (
    title: string,
    fn: (...args: T extends readonly unknown[] ? T : [T]) => void,
  ): void => {
    for (const row of rows) {
      const args = (Array.isArray(row) ? row : [row]) as T extends readonly unknown[]
        ? T
        : [T];
      it(format(title, ...args), () => {
        fn(...args);
      });
    }
  };
}

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

const TEST_FILE = 'probe.test.ts';

// ---------------------------------------------------------------------------
// SHELL-09 (+ TEST-STRUCT-11, same rule set)
// ---------------------------------------------------------------------------

ruleTester.run('no-process-exit', rules['no-process-exit']!, {
  valid: [
    {
      filename: 'scripts/x.self-test.ts',
      code: `process.exitCode = failed.length === 0 ? 0 : 1;`,
    },
    {
      filename: 'scripts/x.test.ts',
      code: `const exit = vi.spyOn(process, 'exit');`,
    },
  ],
  invalid: [
    // The SHELL-09 example: a self-test's PASS/FAIL report cut off.
    {
      filename: 'scripts/x.self-test.ts',
      code: `process.stdout.write(\`\${passed}/\${total} checks passed\\n\`);
      process.exit(failed.length === 0 ? 0 : 1);`,
      errors: [{ messageId: 'exit' }],
    },
    // The TEST-STRUCT-11 example (the same rule as SHELL-09).
    {
      filename: 'scripts/x.self-test.ts',
      code: `main().then(code => { process.stdout.write(report); process.exit(code); });`,
      errors: [{ messageId: 'exit' }],
    },
  ],
});

ruleTester.run('cli-entry-helper', rules['cli-entry-helper']!, {
  valid: [
    {
      filename: 'scripts/lint-adrs.ts',
      code: `if (isCliEntry(process.argv[1], import.meta.url)) main();`,
    },
    {
      filename: 'scripts/lint-adrs.ts',
      code: `console.log(\`usage: \${process.argv[1]} <file>\`);`,
    },
    // The helper itself is where the comparison lives.
    {
      filename: 'scripts/lib/cli-entry.ts',
      code: `export const isCliEntry = (entry: string, url: string) => resolve(entry) === fileURLToPath(url);
      const self = process.argv[1] === fileURLToPath(import.meta.url);`,
    },
  ],
  invalid: [
    // A script's own entry check, compared as a URL.
    {
      filename: 'scripts/lint-adrs.ts',
      code: `const invokedAsCli = import.meta.url === pathToFileURL(process.argv[1]).href;`,
      errors: [{ messageId: 'handRolled' }],
    },
    {
      filename: 'scripts/x.ts',
      code: `const entry = process.argv[1];
      if (entry !== undefined && entry.endsWith('vitest-violation-ratchet.ts')) main();`,
      errors: [{ messageId: 'handRolled' }],
    },
  ],
});

ruleTester.run('git-spawn-env', rules['git-spawn-env']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `spawnSync('git', ['config', '--local', 'user.name'], { cwd: dir, env: hermeticGitEnv() });`,
    },
    { filename: TEST_FILE, code: `spawnSync('node', ['x.js'], { cwd: dir });` },
    { filename: TEST_FILE, code: `execFileSync('git', args, options);` },
  ],
  invalid: [
    // A self-test reading back a fixture's config from the hook's repository.
    {
      filename: TEST_FILE,
      code: `const readBack = () => spawnSync('git', ['config', '--local', 'core.hooksPath'], { cwd: dir, encoding: 'utf8' });`,
      errors: [{ messageId: 'inheritsEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `execSync(\`git -C \${dir} init\`);`,
      errors: [{ messageId: 'inheritsEnv' }],
    },
  ],
});

ruleTester.run('no-global-patch', rules['no-global-patch']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `vi.spyOn(console, 'error').mockImplementation(() => undefined);`,
    },
    { filename: TEST_FILE, code: `const log = console.log;` },
  ],
  invalid: [
    // A self-test silencing console.error by reassignment.
    {
      filename: TEST_FILE,
      code: `const originalError = console.error; console.error = () => undefined;`,
      errors: [{ messageId: 'patched' }],
    },
    // A test capturing stdout by reassigning its write.
    {
      filename: TEST_FILE,
      code: `process.stdout.write = ((chunk: string) => { out.push(chunk); return true; }) as typeof process.stdout.write;`,
      errors: [{ messageId: 'patched' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// Deleting the guard from a corrected case brings the rule back
// ---------------------------------------------------------------------------

function lint(
  rule: string,
  code: string,
  filename = TEST_FILE,
  options: unknown[] = [],
): Linter.LintMessage[] {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { shuddhi: plugin },
        rules: {
          [`shuddhi/${rule}`]: ['error', ...options] as Linter.RuleEntry,
        },
      },
    ],
    filename,
  );
}

function messageIds(
  rule: string,
  code: string,
  filename = TEST_FILE,
  options: unknown[] = [],
): string[] {
  return lint(rule, code, filename, options).map(
    message => message.messageId ?? message.message,
  );
}

interface Flip {
  rule: string;
  messageId: string;
  corrected: string;
  guard: string;
  replacement?: string;
  filename?: string;
  options?: unknown[];
}

const FLIPS: Flip[] = [
  {
    rule: 'no-process-exit',
    messageId: 'exit',
    corrected: `process.exitCode = code;`,
    guard: 'process.exitCode = code;',
    replacement: 'process.exit(code);',
  },
  {
    rule: 'cli-entry-helper',
    messageId: 'handRolled',
    corrected: `if (isCliEntry(process.argv[1], import.meta.url)) main();`,
    guard: 'isCliEntry(process.argv[1], import.meta.url)',
    replacement: 'process.argv[1] === fileURLToPath(import.meta.url)',
  },
  {
    rule: 'git-spawn-env',
    messageId: 'inheritsEnv',
    corrected: `spawnSync('git', ['status'], { cwd: dir, env: hermeticGitEnv() });`,
    guard: ', env: hermeticGitEnv()',
  },
  {
    rule: 'no-global-patch',
    messageId: 'patched',
    corrected: `vi.spyOn(console, 'error').mockImplementation(() => undefined);`,
    guard: `vi.spyOn(console, 'error').mockImplementation(() => undefined);`,
    replacement: 'console.error = () => undefined;',
  },
];

describe('guard removal flips each corrected case', () => {
  each(FLIPS.map(flip => [`${flip.rule}/${flip.messageId}`, flip] as const))(
    '%s',
    (_name, flip) => {
      const filename = flip.filename ?? TEST_FILE;
      assert.deepEqual(
        messageIds(flip.rule, flip.corrected, filename, flip.options),
        [],
      );
      assert.ok(flip.corrected.includes(flip.guard));
      const broken = flip.corrected.replace(flip.guard, flip.replacement ?? '');
      assert.ok(
        messageIds(flip.rule, broken, filename, flip.options).includes(
          flip.messageId,
        ),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// SHELL-09 metadata and messages
// ---------------------------------------------------------------------------

interface Meta {
  type: string;
  docs: { description: string };
  schema: unknown;
  messages: Record<string, string>;
}

const ruleMeta = (name: string): Meta =>
  (rules[name] as unknown as { meta: Meta }).meta;

/**
 * Options naming a repository's own helper modules: with them, each message
 * reads as it did before the options existed.
 */
const REPO_OPTIONS = {
  'cli-entry-helper': { helperModule: 'scripts/lib/cli-entry' },
  'git-spawn-env': { envHelperModule: 'scripts/lib/hermetic-git' },
  'spawn-timeout': { testBudget: '300 s for tooling' },
  'no-raw-group-kill': { groupHelperModule: 'scripts/utils/process-group' },
  'detached-teardown': { groupHelperModule: 'scripts/utils/process-group' },
} as const;

/** The text of each finding `code` produces under `options`. */
const texts = (
  rule: string,
  code: string,
  options: unknown[] = [],
  filename = TEST_FILE,
): string[] => lint(rule, code, filename, options).map(m => m.message);

describe('SHELL-09 rule metadata', () => {
  it('states each rule, its catalogue id and its message verbatim', () => {
    assert.deepEqual(ruleMeta('no-process-exit'), {
      type: 'problem',
      docs: {
        description:
          'Scripts and self-tests set process.exitCode instead of exiting (SHELL-09)',
      },
      schema: [],
      messages: {
        exit: '`process.exit()` ends the process before piped stdout/stderr drains, so the PASS/FAIL report or error that explains the exit can be cut off. Set `process.exitCode = n` and return.',
      },
    });
    assert.deepEqual(ruleMeta('cli-entry-helper').docs, {
      description:
        'CLI entry checks go through the shared CLI entry helper (SHELL-09)',
    });
    assert.deepEqual(ruleMeta('git-spawn-env').docs, {
      description:
        'git children spawned by tests get an explicit env (SHELL-09)',
    });
    assert.deepEqual(ruleMeta('git-fixture-env').docs, {
      description:
        'shells and in-process code in git-fixture tests get a hermetic env',
    });
    assert.deepEqual(ruleMeta('no-global-patch'), {
      type: 'problem',
      docs: {
        description:
          'Tests spy on console/stdout instead of reassigning them (TEST-STRUCT-11)',
      },
      schema: [],
      messages: {
        patched:
          'Reassigning `{{target}}` patches a process-wide global that a thrown assertion leaves patched for every later test. Use `vi.spyOn(...)` (restored by `restoreMocks`/`vi.restoreAllMocks()`).',
      },
    });
    for (const name of ['cli-entry-helper', 'git-spawn-env', 'git-fixture-env']) {
      assert.equal(ruleMeta(name).type, 'problem');
    }
  });

  it('names the repository helper modules it is given', () => {
    assert.deepEqual(
      texts(
        'cli-entry-helper',
        `if (process.argv[1] === self) main();`,
        [REPO_OPTIONS['cli-entry-helper']],
        'scripts/x.ts',
      ),
      [
        'A hand-rolled entry check on `process.argv[1]` fails when the script is reached through a symlink (a linked worktree, /tmp on macOS): the script exits 0 without running. Use `isCliEntry(process.argv[1], import.meta.url)` from scripts/lib/cli-entry.',
      ],
    );
    assert.deepEqual(
      texts(
        'git-spawn-env',
        `spawnSync('git', ['status']); spawnSync('git', ['status'], { env: process.env });`,
        [REPO_OPTIONS['git-spawn-env']],
      ),
      [
        "This git child inherits the caller's environment, and under a git hook that includes GIT_DIR and GIT_INDEX_FILE, so it reads and writes the hook's repository instead of the fixture. Pass `env: hermeticGitEnv()` (scripts/lib/hermetic-git).",
        'This env copies `process.env` into a git child, so GIT_CONFIG_* injection, GIT_DIR and the global config file and hooks still reach the fixture whatever is overridden after the spread. Build it with `hermeticGitEnv({ ...process.env, ... })`.',
      ],
    );
    assert.deepEqual(texts('git-fixture-env', DEFAULT_BRANCH_CHECK), [
      "This file builds a git repository, and the code it calls in-process spawns git with this process's environment: under a hook that is the hook's repository, and git-ai's trace daemon writes into the fixture during teardown. Mask the process for the file: `beforeAll(() => maskProcessGitEnv())`.",
      "This shell runs in a file that builds git fixtures, and inherits the caller's environment: every git it runs reads the hook's GIT_DIR and the machine's global config. Pass `env: hermeticGitEnv()`.",
    ]);
  });

  it('names no module when none is given', () => {
    assert.deepEqual(
      texts('cli-entry-helper', `if (process.argv[1] === self) main();`),
      [
        'A hand-rolled entry check on `process.argv[1]` fails when the script is reached through a symlink (a linked worktree, /tmp on macOS): the script exits 0 without running. Use `isCliEntry(process.argv[1], import.meta.url)`.',
      ],
    );
    const [inherits] = texts('git-spawn-env', `spawnSync('git', ['status']);`);
    assert.match(inherits ?? '', /Pass `env: hermeticGitEnv\(\)`\.$/);
  });
});

ruleTester.run('no-process-exit: only process.exit', rules['no-process-exit']!, {
  valid: [
    // Another object's `exit`, and a bare `exit`, are not the process's.
    { filename: 'scripts/x.ts', code: `app.exit(0);` },
    { filename: 'scripts/x.ts', code: `exit(0);` },
  ],
  invalid: [],
});

ruleTester.run('cli-entry-helper: entry shapes', rules['cli-entry-helper']!, {
  valid: [
    // Other argv slots and other `.at()` / `[n]` reads are not the entry.
    {
      filename: 'scripts/x.ts',
      code: `if (process.argv.length === 3) usage();`,
    },
    {
      filename: 'scripts/x.ts',
      code: `if (process.argv[2] === '--help') usage();`,
    },
    {
      filename: 'scripts/x.ts',
      // An expression statement, not a conditional statement: a strict-fakes
      // ratchet (TEST-WEAK-09) counts that shape on argv as a routed fake.
      code: `process.argv.slice(1).includes('--help') && usage();`,
    },
    {
      filename: 'scripts/x.ts',
      code: `if (process.argv.at(2) === '--help') usage();`,
    },
    { filename: 'scripts/x.ts', code: `if (items.at(0) === target) run();` },
    { filename: 'scripts/x.ts', code: `if (config.mode === 'x') run();` },
    // A nullish comparison is a presence check, not an entry check.
    {
      filename: 'scripts/x.ts',
      code: `if (process.argv[1] === null) usage();`,
    },
    // Aliases: only an identifier bound to the entry, or argv's slot 1.
    {
      filename: 'scripts/x.ts',
      code: `const { length } = process.argv[1]; if (length === 40) run();`,
    },
    {
      filename: 'scripts/x.ts',
      code: `const mode = config.mode; if (mode === 'x') run();`,
    },
    {
      filename: 'scripts/x.ts',
      code: `const args = process.argv; if (args.length > 2) run();`,
    },
    {
      filename: 'scripts/x.ts',
      code: `const [first, second] = pair; if (second === 'x') run(first);`,
    },
    {
      filename: 'scripts/x.ts',
      code: `let entry = process.argv[1]; entry = other; run(entry);`,
    },
    // Uses of the entry that compare nothing.
    {
      filename: 'scripts/x.ts',
      code: `const parts = process.argv[1].split('/');`,
    },
    {
      filename: 'scripts/x.ts',
      code: `if (process.argv[1].length === 0) usage();`,
    },
    {
      filename: 'scripts/x.ts',
      code: `const backup = process.argv[1] + '.bak';`,
    },
    {
      filename: 'scripts/x.ts',
      code: `if ((process.argv[1] || '') === self) main();`,
    },
  ],
  invalid: [
    {
      filename: 'scripts/x.ts',
      code: `if (process.argv.at(1) === fileURLToPath(import.meta.url)) main();`,
      errors: [{ messageId: 'handRolled' }],
    },
    {
      filename: 'scripts/x.ts',
      code: `if (process.argv[1] === '/repo/scripts/x.ts') main();`,
      errors: [{ messageId: 'handRolled' }],
    },
    {
      filename: 'scripts/x.ts',
      code: `if (process.argv[1] === self) main();`,
      errors: [{ messageId: 'handRolled' }],
    },
    {
      filename: 'scripts/x.ts',
      code: `const [, entry] = process.argv; if (entry.endsWith('x.ts')) main();`,
      errors: [{ messageId: 'handRolled' }],
    },
    {
      filename: 'scripts/x.ts',
      // An expression statement for the same reason as the help case above.
      code: `import.meta.url.includes(process.argv[1]) && main();`,
      errors: [{ messageId: 'handRolled' }],
    },
    {
      filename: 'scripts/x.ts',
      code: `if (pathToFileURL(process.argv[1]).pathname === new URL(import.meta.url).pathname) main();`,
      errors: [{ messageId: 'handRolled' }],
    },
    {
      filename: 'scripts/x.ts',
      code: `if ((process.argv[1] ?? '') === self) main();`,
      errors: [{ messageId: 'handRolled' }],
    },
    {
      filename: 'scripts/x.ts',
      code: 'if (`${process.argv[1]}` === self) main();',
      errors: [{ messageId: 'handRolled' }],
    },
    {
      filename: 'scripts/x.ts',
      code: `if ((process.argv[1] as string) === self) main();`,
      errors: [{ messageId: 'handRolled' }],
    },
    {
      filename: 'scripts/x.ts',
      code: `if (process.argv[1] !== self) usage();
      if (process.argv[1] == self) main();
      if (process.argv[1] != self) usage();`,
      errors: [
        { messageId: 'handRolled' },
        { messageId: 'handRolled' },
        { messageId: 'handRolled' },
      ],
    },
  ],
});

ruleTester.run('cli-entry-helper: options', rules['cli-entry-helper']!, {
  valid: [
    // The file that holds a renamed helper is where the comparison lives.
    {
      filename: 'tools/entry-point.ts',
      options: [{ helperFilePattern: 'entry-point\\.ts$' }],
      code: `const self = process.argv[1] === fileURLToPath(import.meta.url);`,
    },
  ],
  invalid: [
    // The default pattern no longer exempts the old helper file.
    {
      filename: 'scripts/lib/cli-entry.ts',
      options: [{ helperFilePattern: 'entry-point\\.ts$' }],
      code: `const self = process.argv[1] === fileURLToPath(import.meta.url);`,
      errors: [{ messageId: 'handRolled' }],
    },
    {
      filename: 'scripts/x.ts',
      options: [{ helper: 'isMain', helperModule: 'tools/entry-point' }],
      code: `if (process.argv[1] === self) main();`,
      errors: [
        {
          messageId: 'handRolled',
          data: { helper: 'isMain', from: ' from tools/entry-point' },
        },
      ],
    },
  ],
});

describe('cli-entry-helper path functions and tests', () => {
  each([
    'resolve',
    'realpathSync',
    'normalize',
    'basename',
    'pathToFileURL',
    'fileURLToPath',
    'String',
  ])('follows the entry through %s()', fn => {
    assert.deepEqual(
      messageIds(
        'cli-entry-helper',
        `if (${fn}(process.argv[1]) === self) main();`,
        'scripts/x.ts',
      ),
      ['handRolled'],
    );
  });

  each(['endsWith', 'startsWith', 'includes', 'match', 'localeCompare'])(
    'reports the entry tested with .%s()',
    method => {
      assert.deepEqual(
        messageIds(
          'cli-entry-helper',
          `if (process.argv[1].${method}(self)) main();`,
          'scripts/x.ts',
        ),
        ['handRolled'],
      );
    },
  );
});

ruleTester.run('git-spawn-env: env shapes', rules['git-spawn-env']!, {
  valid: [
    // Another object's `env` is not process.env.
    {
      filename: TEST_FILE,
      code: `spawnSync('git', ['status'], { env: fixture.env });`,
    },
    // The const walk stops four spreads deep (a documented bound).
    {
      filename: TEST_FILE,
      code: `const l4 = { ...process.env };
      const l3 = { ...l4 };
      const l2 = { ...l3 };
      const l1 = { ...l2 };
      spawnSync('git', ['status'], { env: { ...l1 } });`,
    },
    // A parameter is built by the caller: not provable here.
    {
      filename: TEST_FILE,
      code: `function run(env: NodeJS.ProcessEnv) { return spawnSync('git', ['status'], { env }); }`,
    },
    {
      filename: TEST_FILE,
      code: `spawnSync('git', ['status'], { env: { ...hermeticGitEnv(), GIT_DIR: dir } });`,
    },
    {
      filename: TEST_FILE,
      code: `execFileSync('git', { cwd: dir, env: hermeticGitEnv() });`,
    },
    { filename: TEST_FILE, code: `execSync('npm test');` },
    {
      filename: TEST_FILE,
      code: `execSync('git status', { env: hermeticGitEnv() });`,
    },
    // A spread this file cannot read may carry the env (built elsewhere); a
    // spread before `env` is skipped.
    {
      filename: TEST_FILE,
      code: `function run(baseOptions: SpawnSyncOptions) { return spawnSync('git', ['status'], { ...baseOptions }); }`,
    },
    {
      filename: TEST_FILE,
      code: `spawnSync('git', ['status'], { ...baseOptions, env: hermeticGitEnv() });`,
    },
    {
      filename: TEST_FILE,
      code: `spawnSync('git', ['status'], { ...makeOptions() });`,
    },
    {
      filename: TEST_FILE,
      code: `let base = { cwd: dir }; spawnSync('git', ['status'], { ...base });`,
    },
    // A readable spread that carries `env`, inline or through a const.
    {
      filename: TEST_FILE,
      code: `const base = { cwd: dir, env: hermeticGitEnv() }; spawnSync('git', ['status'], { ...base });`,
    },
    {
      filename: TEST_FILE,
      code: `spawnSync('git', ['status'], { ...{ env: hermeticGitEnv() } });`,
    },
    // The spread walk stops past three readable levels (unknown: allowed).
    {
      filename: TEST_FILE,
      code: `const s4 = { cwd: dir };
      const s3 = { ...s4 };
      const s2 = { ...s3 };
      const s1 = { ...s2 };
      spawnSync('git', ['status'], { ...s1 });`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `spawnSync('git', ['status'], { cwd: dir, env: process.env });`,
      errors: [{ messageId: 'ambientEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `spawnSync('git', ['status'], { 'env': process.env });`,
      errors: [{ messageId: 'ambientEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `spawnSync('git', ['status'], { env: { ...process.env, GIT_DIR: dir } });`,
      errors: [{ messageId: 'ambientEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `const base = { ...process.env }; spawnSync('git', ['status'], { env: base });`,
      errors: [{ messageId: 'ambientEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `const inner = { ...process.env }; spawnSync('git', ['status'], { env: { ...inner, X: '1' } });`,
      errors: [{ messageId: 'ambientEnv' }],
    },
    // Three spreads deep is still followed.
    {
      filename: TEST_FILE,
      code: `const l3 = { ...process.env };
      const l2 = { ...l3 };
      const l1 = { ...l2 };
      spawnSync('git', ['status'], { env: { ...l1 } });`,
      errors: [{ messageId: 'ambientEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `spawnSync('git', ['status']);`,
      errors: [{ messageId: 'inheritsEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `execFileSync('git', { cwd: dir });`,
      errors: [{ messageId: 'inheritsEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `execSync('git status');`,
      errors: [{ messageId: 'inheritsEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `const opts = { cwd: dir }; spawnSync('git', ['status'], opts);`,
      errors: [{ messageId: 'inheritsEnv' }],
    },
    // A spread this file can read and that sets no env is no env.
    {
      filename: TEST_FILE,
      code: `const options = { cwd: dir }; spawnSync('git', ['status'], { ...options });`,
      errors: [{ messageId: 'inheritsEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `spawnSync('git', ['status'], { ...{ cwd: dir }, encoding: 'utf8' });`,
      errors: [{ messageId: 'inheritsEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `const s3 = { cwd: dir };
      const s2 = { ...s3 };
      const s1 = { ...s2 };
      spawnSync('git', ['status'], { ...s1 });`,
      errors: [{ messageId: 'inheritsEnv' }],
    },
  ],
});

describe('git-spawn-env spawners', () => {
  each([
    'spawn',
    'spawnSync',
    'execFile',
    'execFileSync',
    'execa',
    'execaSync',
  ])('checks %s() of git', spawner => {
    assert.deepEqual(
      messageIds(
        'git-spawn-env',
        `${spawner}('git', ['status'], { cwd: dir });`,
      ),
      ['inheritsEnv'],
    );
  });

  each(['exec', 'execSync'])('checks a %s() git command line', spawner => {
    assert.deepEqual(messageIds('git-spawn-env', `${spawner}('git status');`), [
      'inheritsEnv',
    ]);
  });
});

ruleTester.run('no-global-patch: targets', rules['no-global-patch']!, {
  valid: [
    { filename: TEST_FILE, code: `state.value = 1;` },
    { filename: TEST_FILE, code: `stream.write = handler;` },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `process.stderr.write = () => true;`,
      errors: [
        { messageId: 'patched', data: { target: 'process.stderr.write' } },
      ],
    },
  ],
});

// ===========================================================================
// Test process hygiene (R-1 to R-6). Each `invalid` case is a review finding,
// reduced to the shape that still reproduces it; each `valid` case is the
// corrected code or a near miss. The flips delete only the guard from a
// corrected case and prove the rule fires again.
// ===========================================================================
const FIXTURE_FILE = 'probe.fixture.ts';

const CP = `import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';\n`;

// ---------------------------------------------------------------------------
// R-1 — a git env built from the masks alone
// ---------------------------------------------------------------------------

ruleTester.run('no-partial-git-mask', rules['no-partial-git-mask']!, {
  valid: [
    // Corrected: the process masked by the helper, which scrubs.
    { filename: TEST_FILE, code: `beforeAll(() => maskProcessGitEnv());` },
    // Corrected: the child's env from the helper, identity included.
    {
      filename: TEST_FILE,
      code: `${CP}execFileSync('git', ['commit', '-m', 'fix'], { cwd: repo, env: hermeticGitEnv() });`,
    },
    // Near misses: asserting on the masks is not building an env from them.
    {
      filename: TEST_FILE,
      code: `expect(env).toMatchObject(HERMETIC_GIT_VARIABLES);`,
    },
    {
      filename: TEST_FILE,
      code: `const expected = { PATH: '/usr/bin', ...HERMETIC_GIT_VARIABLES }; expect(env).toEqual(expected);`,
    },
    {
      filename: TEST_FILE,
      code: `Object.assign(process.env, OTHER_VARIABLES);`,
    },
    { filename: TEST_FILE, code: `spawn('x', [], { env: { ...BASE } });` },
  ],
  invalid: [
    // Masks on, inherited GIT_* kept.
    {
      filename: TEST_FILE,
      code: `Object.assign(process.env, HERMETIC_GIT_VARIABLES);`,
      errors: [{ messageId: 'partial' }],
    },
    // A child env from the masks, with no identity.
    {
      filename: TEST_FILE,
      code: `const GIT_ENV = { ...process.env, ...HERMETIC_GIT_VARIABLES };\n${CP}execFileSync('git', ['commit-tree', '-m', 'x', tree], { env: GIT_ENV });`,
      errors: [{ messageId: 'partial' }],
    },
    {
      filename: TEST_FILE,
      code: `spawn('git', ['commit'], { env: { PATH, ...hermetic.HERMETIC_GIT_VARIABLES } });`,
      errors: [{ messageId: 'partial' }],
    },
  ],
});

ruleTester.run('no-partial-git-mask: options', rules['no-partial-git-mask']!, {
  valid: [
    // Under another constant's name the default one is no longer the masks.
    {
      filename: TEST_FILE,
      options: [{ maskConstant: 'GIT_MASKS' }],
      code: `Object.assign(process.env, HERMETIC_GIT_VARIABLES);`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      options: [
        { maskConstant: 'GIT_MASKS', envHelper: 'gitEnv', maskHelper: 'maskGit' },
      ],
      code: `spawn('git', ['commit'], { env: { ...GIT_MASKS } });`,
      errors: [
        {
          messageId: 'partial',
          data: {
            maskConstant: 'GIT_MASKS',
            envHelper: 'gitEnv',
            maskHelper: 'maskGit',
          },
        },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// R-2 — git calls with no env, widened
// ---------------------------------------------------------------------------

/** A pre-commit default-branch check's suite, reduced. */
const DEFAULT_BRANCH_CHECK = `${CP}
const git = (...args) => { execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', timeout: 10_000 }); };
git('init', '-q', '-b', 'main');
const run = spawnSync('bash', ['-c', check], { cwd: dir, encoding: 'utf8', timeout: 10_000 });`;

/** A rule-checks suite that runs live checks on a fresh checkout, reduced. */
const LIVE_CHECK = `${CP}
const ENV = hermeticGitEnv();
const checkout = () => { execFileSync('git', ['init', '-q', root], { env: ENV, timeout: 10_000 }); return root; };
it('H-05 asks git', () => { expect(byRule('H-05').run(context(checkout()))).toBeNull(); });`;

ruleTester.run('git-spawn-env (R-2)', rules['git-spawn-env']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: DEFAULT_BRANCH_CHECK.replace(
        "{ stdio: 'ignore',",
        "{ stdio: 'ignore', env: hermeticGitEnv(),",
      ),
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: DEFAULT_BRANCH_CHECK,
      errors: [{ messageId: 'inheritsEnv' }],
    },
  ],
});

ruleTester.run('git-fixture-env (R-2)', rules['git-fixture-env']!, {
  valid: [
    // Corrected: the in-process code inherits a masked process.
    {
      filename: TEST_FILE,
      code: `beforeAll(() => maskProcessGitEnv());\n${LIVE_CHECK}`,
    },
    // Corrected: both children get the hermetic env, process masked.
    {
      filename: TEST_FILE,
      code: `beforeAll(() => maskProcessGitEnv());\n${DEFAULT_BRANCH_CHECK}`
        .replace(
          "{ stdio: 'ignore',",
          "{ stdio: 'ignore', env: hermeticGitEnv(),",
        )
        .replace(
          '{ cwd: dir, encoding',
          '{ cwd: dir, env: hermeticGitEnv(), encoding',
        ),
    },
    // Near misses: a shell in a file with no git; shell options built elsewhere.
    {
      filename: TEST_FILE,
      code: `${CP}spawnSync('bash', ['-c', 'echo hi'], { encoding: 'utf8' });`,
    },
    {
      filename: TEST_FILE,
      code: `${CP}execFileSync('git', ['status'], { env: hermeticGitEnv() });\nspawnSync('bash', args, options);`,
    },
    // A repository that is only read, never made: nothing in-process to mask.
    {
      filename: TEST_FILE,
      code: `${CP}execFileSync('git', ['rev-parse', 'HEAD'], { env: hermeticGitEnv() });`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: DEFAULT_BRANCH_CHECK,
      errors: [
        { messageId: 'unmaskedProcess' },
        { messageId: 'shellInheritsEnv' },
      ],
    },
    {
      filename: TEST_FILE,
      code: LIVE_CHECK,
      errors: [{ messageId: 'unmaskedProcess' }],
    },
    // A shell with a readable options const that sets no env.
    {
      filename: TEST_FILE,
      code: `${CP}const OPTS = { cwd: dir };\nexecFileSync('git', ['status'], { env: hermeticGitEnv() });\nspawn('/bin/sh', ['-c', 'git log'], OPTS);`,
      errors: [{ messageId: 'shellInheritsEnv' }],
    },
  ],
});

ruleTester.run('git-fixture-env: options', rules['git-fixture-env']!, {
  valid: [
    // A renamed mask helper covers the fixture.
    {
      filename: TEST_FILE,
      options: [{ maskHelper: 'maskGit' }],
      code: `beforeAll(() => maskGit());\n${LIVE_CHECK}`,
    },
  ],
  invalid: [
    // Under that name the default helper masks nothing.
    {
      filename: TEST_FILE,
      options: [{ maskHelper: 'maskGit', envHelper: 'gitEnv' }],
      code: `beforeAll(() => maskProcessGitEnv());\n${LIVE_CHECK}`,
      errors: [
        {
          messageId: 'unmaskedProcess',
          data: { maskHelper: 'maskGit', envHelper: 'gitEnv' },
        },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// R-3 — env vars and exitCode
// ---------------------------------------------------------------------------

/** A flaky-test detector's suite, corrected: the exit code is put back. */
const EXIT_CODE_RESTORED = `const prior = process.exitCode;
try { await main(argv); } finally {
  run.exitCode = process.exitCode;
  process.exitCode = prior;
}`;

ruleTester.run('env-via-stub', rules['env-via-stub']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `vi.stubEnv('MUTATION_GATE_REFUSAL_FILE', refusalFile);`,
    },
    {
      filename: TEST_FILE,
      code: `vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);`,
    },
    {
      filename: TEST_FILE,
      code: `const home = process.env.HOME; const env = { ...process.env };`,
    },
    {
      filename: TEST_FILE,
      code: `env.PATH = '/usr/bin'; options.env.X = '1'; delete env.GIT_DIR;`,
    },
    { filename: TEST_FILE, code: EXIT_CODE_RESTORED },
    {
      filename: TEST_FILE,
      code: `it('a', () => { const prior = process.exitCode; onTestFinished(() => { process.exitCode = prior; }); process.exitCode = 1; });`,
    },
    {
      filename: TEST_FILE,
      code: `afterEach(() => { process.exitCode = undefined; });\nit('a', () => { process.exitCode = 1; });`,
    },
    // Near miss: reading it is not setting it.
    { filename: TEST_FILE, code: `run.exitCode = process.exitCode;` },
  ],
  invalid: [
    // A gate's suite setting and deleting an env var by hand.
    {
      filename: TEST_FILE,
      code: `process.env[REFUSAL_FILE_ENV_VAR] = refusalFile;
try { record(); } finally { delete process.env[REFUSAL_FILE_ENV_VAR]; }`,
      errors: [{ messageId: 'envWrite' }, { messageId: 'envWrite' }],
    },
    // A shell-check suite scrubbing GIT_* from the process by hand.
    {
      filename: TEST_FILE,
      code: `beforeAll(() => {
  const hermetic = hermeticGitEnv();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_') && !(key in hermetic)) delete process.env[key];
  }
  Object.assign(process.env, HERMETIC_GIT_VARIABLES);
});`,
      errors: [{ messageId: 'envWrite' }, { messageId: 'envWrite' }],
    },
    // A hermetic-git suite pointing the global config elsewhere.
    {
      filename: TEST_FILE,
      code: `const previous = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = globalConfig;`,
      errors: [{ messageId: 'envWrite' }],
    },
    {
      filename: TEST_FILE,
      code: `process.env = { PATH: '/usr/bin' };`,
      errors: [{ messageId: 'envWrite' }],
    },
    // A flaky-test detector's suite: clears another test's value.
    {
      filename: TEST_FILE,
      code: `try { await main(argv); } finally {
  run.exitCode = process.exitCode;
  process.exitCode = undefined;
}`,
      errors: [{ messageId: 'exitCode' }],
    },
    // A teardown registered after the write does not cover it.
    {
      filename: TEST_FILE,
      code: `it('a', () => { process.exitCode = 1; onTestFinished(() => { process.exitCode = undefined; }); });`,
      errors: [{ messageId: 'exitCode' }],
    },
    // The mask helper named in the message is the configured one.
    {
      filename: TEST_FILE,
      options: [{ maskHelper: 'maskGit' }],
      code: `process.env.X = '1';`,
      errors: [{ messageId: 'envWrite', data: { maskHelper: 'maskGit' } }],
    },
  ],
});

// ---------------------------------------------------------------------------
// R-4 — blocking children without a timeout
// ---------------------------------------------------------------------------

ruleTester.run('spawn-timeout', rules['spawn-timeout']!, {
  valid: [
    // Corrected: a refusal-record suite's child, bounded.
    {
      filename: TEST_FILE,
      code: `${CP}spawnSync(process.execPath, ['--import', 'tsx', entry], { cwd: repo, encoding: 'utf8', timeout: 60_000 });`,
    },
    // A fixture's own runCase: bounded below the test budget.
    {
      filename: FIXTURE_FILE,
      code: `${CP}execFileSync('python3', ['-c', LOADER, 'run', id], { encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL' });`,
    },
    {
      filename: TEST_FILE,
      code: `${CP}const OPTS = { timeout: 5_000 };\nexecSync('git status', OPTS);`,
    },
    {
      filename: TEST_FILE,
      code: `${CP}execFileSync('x', [], { ...BASE_OPTIONS });`,
    },
    {
      filename: TEST_FILE,
      code: `${CP}const BASE = { timeout: 1 };\nexecFileSync('x', [], { ...BASE, cwd });`,
    },
    // Near misses: options built elsewhere; an async spawn; a fake that shares the name.
    { filename: TEST_FILE, code: `${CP}spawnSync('x', [], options);` },
    { filename: TEST_FILE, code: `${CP}spawn('x', []);` },
    {
      filename: TEST_FILE,
      code: `const spawnSync = vi.fn(); spawnSync('x', []);`,
    },
    {
      filename: TEST_FILE,
      code: `import { spawnSync } from './fake'; spawnSync('x', []);`,
    },
  ],
  invalid: [
    // A refusal-record suite's child with no timeout.
    {
      filename: TEST_FILE,
      code: `${CP}const result = spawnSync(process.execPath, ['--import', 'tsx', entry, '--no-such-flag'], { cwd: repo, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: dir } });`,
      errors: [{ messageId: 'noTimeout', data: { name: 'spawnSync', budget: '' } }],
    },
    // A fixture's listTestIds, run at collection by its sharding helper.
    {
      filename: FIXTURE_FILE,
      code: `${CP}function listTestIds() { return execFileSync('python3', ['-c', LOADER, SCRIPTS_DIR, 'list', SUITE_MODULE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).split('\\n'); }`,
      errors: [{ messageId: 'noTimeout', data: { name: 'execFileSync', budget: '' } }],
    },
    {
      filename: TEST_FILE,
      code: `${CP}execSync('git status');`,
      errors: [{ messageId: 'noTimeout' }],
    },
    {
      filename: TEST_FILE,
      code: `${CP}execFileSync('git', ['status']);`,
      errors: [{ messageId: 'noTimeout' }],
    },
    {
      filename: TEST_FILE,
      code: `import * as cp from 'node:child_process';\ncp.spawnSync('x', [], { cwd });`,
      errors: [{ messageId: 'noTimeout' }],
    },
    {
      filename: TEST_FILE,
      code: `import { execFileSync as run } from 'child_process';\nconst OPTS = { cwd };\nrun('x', [], OPTS);`,
      errors: [{ messageId: 'noTimeout', data: { name: 'execFileSync', budget: '' } }],
    },
    {
      filename: TEST_FILE,
      code: `${CP}const BASE = { cwd };\nexecFileSync('x', [], { ...BASE });`,
      errors: [{ messageId: 'noTimeout' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// R-5 — raw group kills
// ---------------------------------------------------------------------------

ruleTester.run('no-raw-group-kill', rules['no-raw-group-kill']!, {
  valid: [
    {
      filename: TEST_FILE,
      code: `const group = trackGroup(long); expect(killGroup(group, 'SIGTERM')).toBe(true);`,
    },
    {
      filename: TEST_FILE,
      code: `process.kill(pid, 0); process.kill(child.pid, 'SIGTERM'); child.kill('SIGKILL');`,
    },
    { filename: TEST_FILE, code: `other.kill(-pid);` },
  ],
  invalid: [
    // A run-child suite: `-0` is the runner's own group.
    {
      filename: TEST_FILE,
      code: `const long = startDetached('sleep', ['30']);\nprocess.kill(-(long.pid ?? 0), 'SIGTERM');`,
      errors: [{ messageId: 'raw' }],
    },
    // A build suite's helper: no check the pid is still ours.
    {
      filename: TEST_FILE,
      code: `function killGroup(pid) {
  if (pid === undefined) return;
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}`,
      errors: [{ messageId: 'raw' }],
    },
    {
      filename: FIXTURE_FILE,
      code: `process.kill(-1);`,
      errors: [{ messageId: 'raw' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// R-6 — detached children with no teardown
// ---------------------------------------------------------------------------

/** A frozen-install suite, corrected: the hung attempt's group is torn down. */
const CANCELLED_INSTALL = `${CP}
it('stops the hung attempt', async () => {
  const child = spawn('/bin/bash', [SCRIPT], { detached: true, stdio: 'ignore' });
  const group = trackGroup(child);
  onTestFinished(() => { killGroup(group); });
  await vi.waitFor(() => expect(existsSync(children)).toBe(true));
  expect(killGroup(group, 'SIGTERM')).toBe(true);
});`;

/** A background-preflight suite, corrected: every stray's group is killed. */
const IMMUNE_STRAY = `${CP}
const groups = [];
afterEach(() => { for (const group of groups.splice(0)) killGroup(group); });
it('ends a stray that ignores TERM', async () => {
  const immune = spawn('bash', ['-c', "trap '' TERM; sleep 300"], { cwd: copy, detached: true, stdio: 'ignore' });
  groups.push(trackGroup(immune));
});`;

ruleTester.run('detached-teardown', rules['detached-teardown']!, {
  valid: [
    { filename: TEST_FILE, code: CANCELLED_INSTALL },
    { filename: TEST_FILE, code: IMMUNE_STRAY },
    // A spawn inside a try whose finally kills the group.
    {
      filename: TEST_FILE,
      code: `${CP}it('a', async () => { let group = null; try { const child = spawn('x', [], { detached: true }); group = trackGroup(child); await run(); } finally { killGroup(group); } });`,
    },
    // Near misses: asserting on a fake's arguments; not detached; a sync child.
    {
      filename: TEST_FILE,
      code: `expect(spawn).toHaveBeenCalledWith('x', [], { detached: true });`,
    },
    { filename: TEST_FILE, code: `${CP}spawn('x', [], { detached: false });` },
    {
      filename: TEST_FILE,
      code: `${CP}spawnSync('x', [], { detached: true, timeout: 1 });`,
    },
  ],
  invalid: [
    // The frozen-install suite: killed inline, no teardown.
    {
      filename: TEST_FILE,
      code: CANCELLED_INSTALL.replace(
        '  onTestFinished(() => { killGroup(group); });\n',
        '',
      ),
      errors: [{ messageId: 'noTeardown' }],
    },
    // The background-preflight suite: teardown kills the leader's pid only,
    // orphaning the `sleep` it forked.
    {
      filename: TEST_FILE,
      code: `${CP}
const live = [];
afterEach(() => { for (const pid of live.splice(0)) process.kill(pid, 'SIGKILL'); });
it('ends a stray that ignores TERM', async () => {
  const immune = spawn('bash', ['-c', "trap '' TERM; sleep 300"], { cwd: copy, detached: true, stdio: 'ignore' });
  live.push(immune.pid ?? 0);
});`,
      errors: [{ messageId: 'noTeardown' }],
    },
    // A build suite, reduced to the spawn the test itself starts: the
    // cleanup's try opens after it.
    {
      filename: TEST_FILE,
      code: `${CP}
it('starts the build detached', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT], { detached: true, stdio: 'ignore' });
  const group = trackGroup(child);
  expect(await built()).toBe(true);
  try { await check(); } finally { killGroup(group); }
});`,
      errors: [{ messageId: 'noTeardown' }],
    },
    // A teardown registered in another test does not cover this one.
    {
      filename: TEST_FILE,
      code: `${CP}
it('a', () => { onTestFinished(() => killGroup(other)); });
it('b', () => { const OPTS = { detached: true }; spawn('x', [], OPTS); });`,
      errors: [{ messageId: 'noTeardown' }],
    },
  ],
});

ruleTester.run('detached-teardown: options', rules['detached-teardown']!, {
  valid: [
    // Renamed group helpers are the teardown.
    {
      filename: TEST_FILE,
      options: [{ trackHelper: 'watchGroup', killHelper: 'endGroup' }],
      code: `it('a', () => { const child = spawn('a', [], { detached: true }); const group = watchGroup(child); onTestFinished(() => { endGroup(group); }); });`,
    },
  ],
  invalid: [
    // Under those names the default kill helper ends nothing.
    {
      filename: TEST_FILE,
      options: [{ trackHelper: 'watchGroup', killHelper: 'endGroup' }],
      code: `it('a', () => { const child = spawn('a', [], { detached: true }); onTestFinished(() => { killGroup(group); }); });`,
      errors: [
        {
          messageId: 'noTeardown',
          data: { trackHelper: 'watchGroup', killHelper: 'endGroup', source: '' },
        },
      ],
    },
    // A group tracked from another child, under the renamed tracker.
    {
      filename: TEST_FILE,
      options: [{ trackHelper: 'watchGroup', killHelper: 'endGroup' }],
      code: `it('a', () => { const a = spawn('a', [], { detached: true }); const b = start(); onTestFinished(() => { endGroup(watchGroup(b)); }); });`,
      errors: [{ messageId: 'noTeardown' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// Guard removal and wiring
// ---------------------------------------------------------------------------

const PROCESS_FLIPS: Flip[] = [
  {
    rule: 'no-partial-git-mask',
    messageId: 'partial',
    corrected: `spawn('git', ['commit'], { env: hermeticGitEnv({ ...HERMETIC_GIT_VARIABLES }) });`,
    guard: 'hermeticGitEnv(',
    replacement: '(',
  },
  {
    rule: 'git-fixture-env',
    messageId: 'unmaskedProcess',
    corrected: `beforeAll(() => maskProcessGitEnv());\n${LIVE_CHECK}`,
    guard: 'beforeAll(() => maskProcessGitEnv());',
  },
  {
    rule: 'git-fixture-env',
    messageId: 'shellInheritsEnv',
    corrected: `${CP}execFileSync('git', ['status'], { env: hermeticGitEnv() });\nspawnSync('bash', ['-c', s], { cwd, env: hermeticGitEnv() });`,
    guard: 'cwd, env: hermeticGitEnv()',
    replacement: 'cwd',
  },
  {
    rule: 'env-via-stub',
    messageId: 'exitCode',
    corrected: EXIT_CODE_RESTORED,
    guard: 'const prior = process.exitCode;',
    replacement: 'let prior = process.exitCode;',
  },
  {
    rule: 'env-via-stub',
    messageId: 'exitCode',
    corrected: `it('a', () => { const prior = process.exitCode; onTestFinished(() => { process.exitCode = prior; }); process.exitCode = 1; });`,
    guard: 'onTestFinished(() => { process.exitCode = prior; }); ',
  },
  {
    rule: 'spawn-timeout',
    messageId: 'noTimeout',
    corrected: `${CP}spawnSync(process.execPath, [entry], { cwd: repo, timeout: 60_000 });`,
    guard: ', timeout: 60_000',
  },
  {
    rule: 'detached-teardown',
    messageId: 'noTeardown',
    corrected: CANCELLED_INSTALL,
    guard: '  onTestFinished(() => { killGroup(group); });\n',
  },
  {
    rule: 'detached-teardown',
    messageId: 'noTeardown',
    corrected: IMMUNE_STRAY,
    guard: 'killGroup(group)',
    replacement: 'process.kill(group.pid)',
  },
];

describe('guard removal flips each corrected case (R-1 to R-6)', () => {
  each(
    PROCESS_FLIPS.map(
      (flip, index) =>
        [`${flip.rule}/${flip.messageId}#${index}`, flip] as const,
    ),
  )('%s', (_name, flip) => {
    assert.deepEqual(messageIds(flip.rule, flip.corrected), []);
    assert.ok(flip.corrected.includes(flip.guard));
    const broken = flip.corrected.replace(flip.guard, flip.replacement ?? '');
    assert.ok(messageIds(flip.rule, broken).includes(flip.messageId));
  });
});

// ---------------------------------------------------------------------------
// Edges each rule's reading depends on
// ---------------------------------------------------------------------------

ruleTester.run('git-fixture-env edges', rules['git-fixture-env']!, {
  valid: [
    // Other calls in a file with no git do not make it a git file.
    {
      filename: TEST_FILE,
      code: `${CP}spawnSync('bash', ['-c', 'echo hi'], { timeout: 1 });\nexpect(1).toBe(1);`,
    },
    // A describe's beforeAll mask covers a fixture built inside it.
    {
      filename: TEST_FILE,
      code: `${CP}describe('a', () => { beforeAll(() => maskProcessGitEnv()); it('b', () => { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); }); });`,
    },
    // A mask earlier in the same test covers the fixture after it.
    {
      filename: TEST_FILE,
      code: `${CP}it('a', () => { onTestFinished(maskProcessGitEnv()); execFileSync('git', ['init', '-q', dir], { timeout: 1 }); });`,
    },
    // A top-level mask runs at import, before any helper is called.
    {
      filename: TEST_FILE,
      code: `${CP}function repo() { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); }\nmaskProcessGitEnv();\nit('a', () => repo());`,
    },
    // A hook mask covers a file helper its block calls.
    {
      filename: TEST_FILE,
      code: `${CP}function repo() { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); }\ndescribe('a', () => { beforeAll(() => { maskProcessGitEnv(); repo(); }); });`,
    },
    // So does a test's mask, for a const helper it calls after it.
    {
      filename: TEST_FILE,
      code: `${CP}const repo = () => { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); };\nit('a', () => { maskProcessGitEnv(); repo(); });`,
    },
    // A top-level mask covers a helper even when the call is written first:
    // the mask runs at import, the test later.
    {
      filename: TEST_FILE,
      code: `${CP}function repo() { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); }\nit('a', () => repo());\nmaskProcessGitEnv();`,
    },
    // A top-level fixture built after the top-level mask.
    {
      filename: TEST_FILE,
      code: `${CP}maskProcessGitEnv();\nexecFileSync('git', ['init', '-q', dir], { timeout: 1 });`,
    },
  ],
  invalid: [
    // A mask in another describe, a later test or under a condition does not
    // cover the fixture.
    {
      filename: TEST_FILE,
      code: `${CP}describe('a', () => { beforeAll(() => maskProcessGitEnv()); });\ndescribe('b', () => { it('c', () => { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); }); });`,
      errors: [{ messageId: 'unmaskedProcess' }],
    },
    {
      filename: TEST_FILE,
      code: `${CP}it('a', () => { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); });\nit('b', () => { maskProcessGitEnv(); });`,
      errors: [{ messageId: 'unmaskedProcess' }],
    },
    {
      filename: TEST_FILE,
      code: `${CP}beforeAll(() => { if (ci) maskProcessGitEnv(); });\nit('a', () => { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); });`,
      errors: [{ messageId: 'unmaskedProcess' }],
    },
    {
      filename: TEST_FILE,
      code: `${CP}it('a', () => { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); maskProcessGitEnv(); });`,
      errors: [{ messageId: 'unmaskedProcess' }],
    },
    // Every kind of condition around a hook's mask.
    ...[
      'ci ? maskProcessGitEnv() : 0',
      'ci && maskProcessGitEnv()',
      'switch (ci) { case 1: maskProcessGitEnv(); }',
      'try { x(); } catch { maskProcessGitEnv(); }',
    ].map(body => ({
      filename: TEST_FILE,
      code: `${CP}beforeAll(() => { ${body}; });\nit('a', () => { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); });`,
      errors: [{ messageId: 'unmaskedProcess' as const }],
    })),
    // A mask in a teardown runs after the fixture.
    {
      filename: TEST_FILE,
      code: `${CP}afterAll(() => maskProcessGitEnv());\nit('a', () => { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); });`,
      errors: [{ messageId: 'unmaskedProcess' }],
    },
    // A test's expression-bodied mask covers no other test.
    {
      filename: TEST_FILE,
      code: `${CP}it('a', () => maskProcessGitEnv());\nit('b', () => { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); });`,
      errors: [{ messageId: 'unmaskedProcess' }],
    },
    // A top-level fixture built before the top-level mask.
    {
      filename: TEST_FILE,
      code: `${CP}execFileSync('git', ['init', '-q', dir], { timeout: 1 });\nmaskProcessGitEnv();`,
      errors: [{ messageId: 'unmaskedProcess' }],
    },
    // A helper called before the mask, or a call that names no helper here.
    {
      filename: TEST_FILE,
      code: `${CP}const repo = () => { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); };\nit('a', () => { repo(); maskProcessGitEnv(); });`,
      errors: [{ messageId: 'unmaskedProcess' }],
    },
    {
      filename: TEST_FILE,
      code: `${CP}const made = build();\nfunction repo() { execFileSync('git', ['init', '-q', dir], { timeout: 1 }); }\nit('a', () => { maskProcessGitEnv(); made(); other(); });\nit('b', () => repo());`,
      errors: [{ messageId: 'unmaskedProcess' }],
    },
    // A local \`git(...)\` wrapper, made elsewhere, is git too.
    {
      filename: TEST_FILE,
      code: `${CP}const git = makeGit(root);\ngit('status');\nspawnSync('bash', ['-c', 'x'], { timeout: 1 });`,
      errors: [{ messageId: 'shellInheritsEnv' }],
    },
  ],
});

ruleTester.run('env-via-stub edges', rules['env-via-stub']!, {
  valid: [
    // A file-level afterAll that puts the exit code back covers the file.
    {
      filename: TEST_FILE,
      code: `afterAll(() => { process.exitCode = undefined; });\nit('a', () => { process.exitCode = 1; });`,
    },
    // onTestFinished registered right before the write, no space between.
    {
      filename: TEST_FILE,
      code: `it('a', () => { const p = process.exitCode; onTestFinished(() => { process.exitCode = p; });process.exitCode = 1; });`,
    },
    // A describe's afterEach covers the tests nested inside it.
    {
      filename: TEST_FILE,
      code: `describe('a', () => { afterEach(() => { process.exitCode = undefined; }); describe('b', () => { it('c', () => { process.exitCode = 1; }); }); });`,
    },
  ],
  invalid: [
    // A restore in one describe does not cover a test in another: only the
    // second write is reported.
    {
      filename: TEST_FILE,
      code: `describe('a', () => { afterEach(() => { process.exitCode = undefined; }); it('x', () => { process.exitCode = 1; }); });\ndescribe('b', () => { it('y', () => { process.exitCode = 2; }); });`,
      errors: [{ messageId: 'exitCode', line: 2 }],
    },
    // A helper outside any test or hook is no teardown.
    {
      filename: TEST_FILE,
      code: `const set = () => { process.exitCode = 1; };\nit('a', () => set());`,
      errors: [{ messageId: 'exitCode' }],
    },
    // An expression-bodied test registers nothing.
    {
      filename: TEST_FILE,
      code: `it('a', () => (process.exitCode = 1));`,
      errors: [{ messageId: 'exitCode' }],
    },
  ],
});

ruleTester.run('spawn-timeout edges', rules['spawn-timeout']!, {
  valid: [
    // Spread chains are read three deep, then assumed to carry it.
    {
      filename: TEST_FILE,
      code: `${CP}const a = { cwd: x };\nconst b = { ...a };\nconst c = { ...b };\nconst d = { ...c };\nspawnSync('x', [], { ...d });`,
    },
    // A callee that is a call's result, or a member of a named import.
    { filename: TEST_FILE, code: `${CP}getSpawner()('x');` },
    { filename: TEST_FILE, code: `${CP}spawn.spawnSync('x', []);` },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `${CP}execSync('ls');`,
      errors: [{ messageId: 'noTimeout', data: { name: 'execSync', budget: '' } }],
    },
  ],
});

ruleTester.run('no-raw-group-kill edges', rules['no-raw-group-kill']!, {
  valid: [{ filename: TEST_FILE, code: `process.kill(+pid, 'SIGTERM');` }],
  invalid: [
    {
      filename: TEST_FILE,
      code: `process.kill(-1, 'SIGKILL');`,
      errors: [{ messageId: 'raw' }],
    },
  ],
});

ruleTester.run('detached-teardown edges', rules['detached-teardown']!, {
  valid: [
    // A computed key is not \`detached\`; another option set true is not it.
    { filename: TEST_FILE, code: `${CP}spawn('x', [], { [detached]: true });` },
    { filename: TEST_FILE, code: `${CP}spawn('x', [], { shell: true });` },
    // A top-level afterEach covers every test in the file.
    {
      filename: TEST_FILE,
      code: `${CP}afterEach(() => { killGroup(g); });\ndescribe('a', () => { it('b', () => { spawn('x', [], { detached: true }); }); });`,
    },
    // A describe's afterAll covers the tests nested inside it.
    {
      filename: TEST_FILE,
      code: `${CP}describe('a', () => { afterAll(() => { killGroup(g); }); describe('b', () => { it('c', () => { spawn('x', [], { detached: true }); }); }); });`,
    },
  ],
  invalid: [
    // A hook in one describe does not cover a spawn in another; only the
    // second spawn is reported.
    {
      filename: TEST_FILE,
      code: `${CP}describe('a', () => { afterEach(() => { killGroup(g); }); it('x', () => { spawn('x', [], { detached: true }); }); });\ndescribe('b', () => { it('y', () => { spawn('y', [], { detached: true }); }); });`,
      errors: [{ messageId: 'noTeardown', line: 3 }],
    },
    ...['fork', 'execFile', 'exec', 'execa'].map(name => ({
      filename: TEST_FILE,
      code: `${name}('x', [], { ...base, detached: true });`,
      errors: [{ messageId: 'noTeardown' as const }],
    })),
    // A try whose finally kills nothing, and a kill after it, are no teardown.
    {
      filename: TEST_FILE,
      code: `${CP}it('a', () => { try { spawn('x', [], { detached: true }); } finally { cleanup(); } killGroup(g); });`,
      errors: [{ messageId: 'noTeardown' }],
    },
    {
      filename: TEST_FILE,
      code: `${CP}it('a', () => { try { spawn('x', [], { detached: true }); } catch { log(); } killGroup(g); });`,
      errors: [{ messageId: 'noTeardown' }],
    },
  ],
});

describe('process hygiene rule metadata', () => {
  it('states each rule and its message verbatim', () => {
    const descriptions: Record<string, string> = {
      'no-partial-git-mask':
        'A git env is built by the hermetic env helper, never from its masks alone',
      'env-via-stub':
        'Tests change env vars through vi.stubEnv and restore process.exitCode',
      'spawn-timeout': 'A blocking child process in a test has a timeout',
      'no-raw-group-kill':
        'Tests signal a process group only through the guarded helper',
      'detached-teardown':
        'A detached child started by a test has teardown that kills its group',
    };
    for (const [name, description] of Object.entries(descriptions)) {
      assert.equal(ruleMeta(name).type, 'problem', name);
      assert.deepEqual(ruleMeta(name).docs, { description }, name);
    }
    assert.deepEqual(
      texts('no-partial-git-mask', `Object.assign(process.env, HERMETIC_GIT_VARIABLES);`),
      [
        "`HERMETIC_GIT_VARIABLES` is only the masks: it keeps every inherited `GIT_*` (a hook's GIT_DIR, GIT_NAMESPACE, …) and names no author, so a fixture commit fails on a runner with no identity. Use `hermeticGitEnv(...)` for a child's env and `maskProcessGitEnv()` for this process.",
      ],
    );
    assert.deepEqual(
      texts('env-via-stub', `process.env = {};\nprocess.exitCode = 1;`),
      [
        'Writing `process.env` directly outlives a failed assertion and leaks into every later test in this worker. Use `vi.stubEnv(name, value)` (`undefined` unsets): `unstubEnvs: true` undoes it before the next test. For git masks, `maskProcessGitEnv()`.',
        'This sets `process.exitCode` for the whole worker: a value another test set is lost, or a failure is masked. Save it first and put it back, `const prior = process.exitCode; onTestFinished(() => { process.exitCode = prior; })`.',
      ],
    );
    assert.deepEqual(
      texts('spawn-timeout', `${CP}execSync('ls');`, [
        REPO_OPTIONS['spawn-timeout'],
      ]),
      [
        '`execSync` with no `timeout` blocks the worker until the test budget (300 s for tooling), or with no budget at all at module load, when the child hangs. Pass `timeout` in ms: the killed child then fails the test.',
      ],
    );
    assert.deepEqual(texts('spawn-timeout', `${CP}execSync('ls');`), [
      '`execSync` with no `timeout` blocks the worker until the test budget, or with no budget at all at module load, when the child hangs. Pass `timeout` in ms: the killed child then fails the test.',
    ]);
    assert.deepEqual(
      texts('no-raw-group-kill', `process.kill(-1);`, [
        REPO_OPTIONS['no-raw-group-kill'],
      ]),
      [
        "`process.kill(-pid)` signals whatever group that number names now: `-(pid ?? 0)` after a failed spawn is the runner's own group, and a pid reused after the child exited is someone else's. Track the group at spawn, `const group = trackGroup(child)`, and end it with `killGroup(group)` (scripts/utils/process-group).",
      ],
    );
    assert.deepEqual(
      texts('detached-teardown', `spawn('x', [], { detached: true });`, [
        REPO_OPTIONS['detached-teardown'],
      ]),
      [
        'A `detached: true` child leads its own process group and outlives this test when an assertion fails before it ends. Kill the group in teardown: `const group = trackGroup(child); onTestFinished(() => { killGroup(group); });` (scripts/utils/process-group), or in a `finally` around it.',
      ],
    );
  });

  it('refuses options it does not know', () => {
    assert.throws(
      () => lint('spawn-timeout', `${CP}execSync('ls');`, TEST_FILE, [
        { budget: 1 },
      ]),
      /should NOT have additional properties|must NOT have additional properties/,
    );
  });
});

// ---------------------------------------------------------------------------
// Review findings on rule logic that predates the module split
// ---------------------------------------------------------------------------

ruleTester.run(
  'detached-teardown (a kill traced to another child)',
  rules['detached-teardown']!,
  {
    valid: [
      {
        filename: TEST_FILE,
        code: `it('a', () => { const child = spawn('a', [], { detached: true }); const group = trackGroup(child); onTestFinished(() => { killGroup(group); }); });`,
      },
      {
        filename: TEST_FILE,
        code: `it('a', () => { const child = spawn('a', [], { detached: true }); onTestFinished(() => { killGroup(trackGroup(child)); }); });`,
      },
      // A group this file cannot trace to a child still counts.
      {
        filename: TEST_FILE,
        code: `it('a', () => { const child = spawn('a', [], { detached: true }); onTestFinished(() => { killGroup(trackGroup({ pid })); killGroup(group); }); });`,
      },
      {
        filename: TEST_FILE,
        code: `it('a', () => { children.push(spawn('a', [], { detached: true })); const group = trackGroup(other); onTestFinished(() => { killGroup(group); }); });`,
      },
      {
        filename: TEST_FILE,
        code: `it('a', () => { const { pid } = spawn('a', [], { detached: true }); const group = trackGroup(other); onTestFinished(() => { killGroup(group); }); });`,
      },
    ],
    invalid: [
      {
        filename: TEST_FILE,
        code: `it('a', () => {
        const a = spawn('a', [], { detached: true });
        const b = spawn('b', [], { detached: true });
        const groupB = trackGroup(b);
        onTestFinished(() => { killGroup(groupB); });
      });`,
        errors: [{ messageId: 'noTeardown', line: 2 }],
      },
      {
        filename: TEST_FILE,
        code: `it('a', () => { const b = start(); try { const a = spawn('a', [], { detached: true }); } finally { killGroup(trackGroup(b)); } });`,
        errors: [{ messageId: 'noTeardown' }],
      },
    ],
  },
);

ruleTester.run(
  'env-via-stub (a teardown that restores nothing)',
  rules['env-via-stub']!,
  {
    valid: [],
    invalid: [
      {
        filename: TEST_FILE,
        code: `it('a', () => { onTestFinished(() => {}); process.exitCode = 1; });`,
        errors: [{ messageId: 'exitCode' }],
      },
      {
        filename: TEST_FILE,
        code: `it('a', () => { onTestFinished(() => { cleanup(); }); process.exitCode = 1; });`,
        errors: [{ messageId: 'exitCode' }],
      },
    ],
  },
);

ruleTester.run('git-spawn-env (the last env wins)', rules['git-spawn-env']!, {
  valid: [
    // The last env wins, read through the spreads this file shows.
    {
      filename: TEST_FILE,
      code: `const base = { env: { ...process.env } }; execFileSync('git', ['status'], { ...base, env: hermeticGitEnv() });`,
    },
    {
      filename: TEST_FILE,
      code: `execFileSync('git', ['status'], { env: { ...process.env }, ...{ env: hermeticGitEnv() } });`,
    },
    // Read three spreads deep, as optionsSetEnv reads them.
    {
      filename: TEST_FILE,
      code: `execFileSync('git', ['status'], { ...{ ...{ ...{ ...{ env: { ...process.env } } } } } });`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `const base = { env: { ...process.env } }; execFileSync('git', ['status'], { ...base, cwd: dir });`,
      errors: [{ messageId: 'ambientEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `execFileSync('git', ['status'], { env: hermeticGitEnv(), ...{ env: { ...process.env } } });`,
      errors: [{ messageId: 'ambientEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `execFileSync('git', ['status'], { ...{ ...{ ...{ env: { ...process.env } } } } });`,
      errors: [{ messageId: 'ambientEnv' }],
    },
    {
      filename: TEST_FILE,
      code: `execFileSync('git', ['status'], { env: { ...process.env }, ...opts });`,
      errors: [{ messageId: 'ambientEnv' }],
    },
  ],
});
