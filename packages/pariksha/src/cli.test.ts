// cli.ts's own suite: every command's flags, what it hands its check, what it
// prints and its exit codes. The cli.*.test.ts suites beside it test the
// checks end to end; this one is what the mutation gate runs against cli.ts,
// so it reaches every line in-process and stays fast: cheap tests come
// first, and the ones that build git histories last.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { hash } from './boundary.ts';
import { CONFIGURABLE, consoleIo, DENY_FILE, flags, main, ownVersion, run, splitFiles, trackedFiles, type Io } from './cli.ts';
import type { LinkRunner } from './doc-links.ts';
import { diskReads, type Reads } from './env-gate-switches.ts';
import type { EslintRunner } from './eslint-by-workspace.ts';
import type { SpawnOutcome, VitestRunner } from './flaky-tests.ts';
import type { PythonRunner } from './python-floor.ts';
import type { RunResult, ShellcheckRunner } from './shell-gates.ts';
import { loadTypescript, type Ts } from './typescript.ts';

/**
 * Git hermetic for the whole process: `run` spawns git with this process's
 * environment, as the fixtures' own git calls do. Both config files point at
 * /dev/null, trace2 is off, and every inherited `GIT_*` (a hook's `GIT_DIR`)
 * is dropped, so no fixture `git init` lands in the real repository.
 */
const HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' };
const inherited = Object.entries(process.env).filter(([name]) => name.startsWith('GIT_'));
for (const [name] of inherited) delete process.env[name];
Object.assign(process.env, HERMETIC);

const temps: string[] = [];
/** A fresh temporary directory, by its real path, removed when this file's tests end. */
const temp = (prefix = 'pariksha-cli-'): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  for (const name of Object.keys(HERMETIC)) delete process.env[name];
  Object.assign(process.env, Object.fromEntries(inherited));
});

/**
 * One turn of the event loop before each test. Under Stryker's tap runner a
 * mutant stops at its first failing test only once that test's TAP line
 * reaches the runner, and node writes it asynchronously: a file of
 * synchronous tests would print nothing until its end, so every mutant would
 * cost the whole file.
 */
beforeEach(() => new Promise((resolve) => setImmediate(resolve)));

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

// No detached auto-maintenance: it could write into a fixture as it is removed.
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, stdio: 'pipe' });

/** A folder with these files written; tracked by a fresh git repository unless `tracked` is false. */
const tree = (files: Record<string, string | Uint8Array>, tracked = true): string => {
  const root = temp();
  if (tracked) git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  if (tracked) git(root, 'add', '-A');
  return root;
};

/** A git repository with these files tracked. */
const repo = (files: Record<string, string | Uint8Array>): string => tree(files);

/** A folder outside any git repository, holding nothing. */
const NOWHERE = temp('pariksha-nowhere-');

/** A `.pariksha.json` with no entries, named by PARIKSHA_CONFIG, so a run reads no settings and asks git nothing to find them. */
const NO_PROJECT = join(NOWHERE, 'no-project.json');
writeFileSync(NO_PROJECT, '{ "checks": {} }');

/**
 * Standard input made a file that ends, opened on descriptor 0 (the lowest
 * free one): a run that reads it by default, or a mutant that does, gets this
 * list at once instead of waiting on a pipe that never closes.
 */
const STDIN_LIST = join(NOWHERE, 'stdin.txt');
writeFileSync(STDIN_LIST, 'from-standard-input.md\n');
closeSync(0);
assert.equal(openSync(STDIN_LIST, 'r'), 0, 'the list holds standard input’s descriptor');

/** Stands in for standard input: a test that reads it says so by giving `stdin`. */
const noStdin = (): string => {
  throw new Error('this test reads no standard input');
};

interface Ran {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

/** `pariksha <args>` in-process, as version 0, reading no `.pariksha.json` unless `env` names one. */
const cli = (args: readonly string[], over: Partial<Io> = {}, env: NodeJS.ProcessEnv = { PARIKSHA_CONFIG: NO_PROJECT }): Ran => {
  const c = capture();
  const code = run(args, { ...c.io, stdin: noStdin, cwd: () => NOWHERE, ...over }, '0', env);
  assert.equal(typeof code, 'number', 'a synchronous command');
  return { code: code as number, out: c.out, err: c.err };
};

/** The async form of `cli`, for enforcement-claims. */
const cliAsync = async (args: readonly string[], over: Partial<Io> = {}, env: NodeJS.ProcessEnv = { PARIKSHA_CONFIG: NO_PROJECT }): Promise<Ran> => {
  const c = capture();
  const code = await run(args, { ...c.io, stdin: noStdin, cwd: () => NOWHERE, ...over }, '0', env);
  return { code, out: c.out, err: c.err };
};

const USAGE = [
  'usage: pariksha authority-citations [--mode staged|tree] [--authority <a,b>] [--issue-prefix <A,B>] [--adr-dir <dir>] [--root <dir>]',
  '       pariksha absolute-paths [--config <file>] [--staged | --base <ref> [--head <ref>] | --all | --files-from <file>|-] [--root <dir>]',
  '       pariksha aggregate-gate-needs [--config <file>] [--root <dir>]',
  '       pariksha boundary [--root <dir>] [--deny <file>]',
  '       pariksha codec-registry --config <file> [--base <ref> | --no-base] [--root <dir>]',
  '       pariksha coverage-by-type [--config <file>] [--staged | --base <ref> [--head <ref>] | --all | --files-from <file>|-] [--root <dir>]',
  '       pariksha coverage-exemptions --config <file> [--package <dir>] [--root <dir>]',
  '       pariksha doc-budgets --table <file> [--section <name>] [--root <dir>]',
  '       pariksha doc-references --config <file> (--staged | --base <ref> [--head <ref>] | --all [--update-baseline | --write-baseline]) [--checks <ids>] [--root <dir>]',
  '       pariksha duplicate-tests [--config <file>] [--staged | --base <ref> [--head <ref>] | --all | --files-from <file>|-] [--root <dir>]',
  '       pariksha enforcement-claims --config <file> [--root <dir>]',
  '       pariksha env-gate-switches --config <file> [--mode staged|tree] [--root <dir>]',
  '       pariksha eslint-by-workspace [--config <file>] [--files-from <file>|-] [--root <dir>] [<file>...] [-- <eslint args>...]',
  '       pariksha eslint-targets --range <git range> [--config <file>] [--root <dir>]',
  '       pariksha export-deletions [--base <ref>] [--root <dir>]',
  '       pariksha fault-injection-registry --config <file> [--base <ref> | --no-base] [--root <dir>]',
  '       pariksha flaky-tests [--config <file>] [--staged | --base <ref> [--head <ref>] | --all | --files-from <file>|-] [--runs <n>] [--root <dir>]',
  '       pariksha masked-exit-codes [--config <file>] [--staged] [--root <dir>]',
  '       pariksha non-synced-resources [--config <file>] [--staged | --base <ref> [--head <ref>] | --all | --files-from <file>|-] [--root <dir>]',
  '       pariksha pnpm-settings [--config <file>] [--root <dir>]',
  '       pariksha python-floor --python <interpreter> --floor-file <path> [--exclude <regex>] [--selector <path>] [--root <dir>]',
  '       pariksha regression-controls --config <file> [--staged] [--root <dir>]',
  '       pariksha repo-rules [--config <file>] [--staged | --base <ref> [--head <ref>] | --all | --files-from <file>|-] [--root <dir>]',
  '       pariksha required-settings --require <file> [--settings <file>] [--root <dir>]',
  '       pariksha schema-roots [--files-from <file>|-] [--root <dir>] [<file>...]',
  '       pariksha shell-gates [--config <file>] [--staged | --all | --base <ref> | --files-from <file>|-] [--only <checks>] [--root <dir>]',
  '       pariksha hash <word>',
  '       pariksha --version',
].join('\n');

/** A refusal with the usage text and nothing else. */
const assertUsage = (r: Ran): void => {
  assert.equal(r.code, 2);
  assert.deepEqual(r.err, [USAGE]);
  assert.deepEqual(r.out, []);
};

const DENY = `${hash('acme')}\n`;

describe('flags', () => {
  it('reads --name value pairs and bare switches, each once', () => {
    assert.deepEqual([...(flags(['--a', '1', '--s', '--b', '2'], ['--a', '--b'], ['--s']) ?? [])], [
      ['--a', '1'],
      ['--s', ''],
      ['--b', '2'],
    ]);
    assert.deepEqual([...(flags([], ['--a']) ?? [])], []);
    assert.deepEqual([...(flags(['--s'], [], ['--s']) ?? [])], [['--s', '']]);
  });

  it('refuses an unknown name, a repeat, a missing or empty value, and a switch given as a name', () => {
    for (const rest of [['--c', '1'], ['--a', '1', '--a', '2'], ['--s', '--s'], ['--a'], ['--a', ''], ['1'], ['--s', 'x']]) {
      assert.equal(flags(rest, ['--a'], ['--s']), undefined, rest.join(' '));
    }
    assert.equal(flags(['--s'], ['--a']), undefined);
  });
});

describe('splitFiles', () => {
  it('takes each --flag with the word after it, and the rest as files, in order', () => {
    assert.deepEqual(splitFiles(['a.json', '--root', 'r', 'b.json', '--files-from', '-', 'c.json']), { flagArgs: ['--root', 'r', '--files-from', '-'], files: ['a.json', 'b.json', 'c.json'] });
    assert.deepEqual(splitFiles(['--root']), { flagArgs: ['--root'], files: [] });
    assert.deepEqual(splitFiles(['-x', '--a', '--b']), { flagArgs: ['--a', '--b'], files: ['-x'] });
    assert.deepEqual(splitFiles([]), { flagArgs: [], files: [] });
  });
});

describe('run: what no command takes', () => {
  it('prints the version it is given, or its own, and a hash', () => {
    const v = capture();
    assert.equal(run(['--version'], v.io, '1.2.3'), 0);
    assert.deepEqual(v.out, ['1.2.3']);
    assert.deepEqual(v.err, []);
    const own = capture();
    assert.equal(run(['--version'], own.io), 0);
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    assert.deepEqual(own.out, [pkg.version]);
    assert.equal(ownVersion(), pkg.version);
    const h = capture();
    assert.equal(run(['hash', 'Acme'], h.io, '1.2.3'), 0);
    assert.deepEqual(h.out, [hash('acme')]);
    assert.deepEqual(h.err, []);
  });

  it('refuses anything else with the usage, and nothing on stdout', () => {
    for (const args of [[], ['lint'], ['hash'], ['hash', ''], ['hash', 'a', 'b'], ['--version', 'x'], ['constructor'], ['toString'], ['__proto__'], ['boundary', '--nope', 'x']]) {
      assertUsage(cli(args));
    }
  });

  it('lists the checks .pariksha.json can configure', () => {
    assert.deepEqual(CONFIGURABLE, [
      'absolute-paths',
      'aggregate-gate-needs',
      'authority-citations',
      'codec-registry',
      'coverage-by-type',
      'coverage-exemptions',
      'doc-budgets',
      'doc-references',
      'duplicate-tests',
      'enforcement-claims',
      'env-gate-switches',
      'eslint-by-workspace',
      'eslint-targets',
      'fault-injection-registry',
      'flaky-tests',
      'masked-exit-codes',
      'non-synced-resources',
      'pnpm-settings',
      'regression-controls',
      'repo-rules',
      'shell-gates',
    ]);
  });
});

describe('main and the console', () => {
  const script = join(import.meta.dirname, 'cli.ts');

  it('runs the arguments after the script when the script is this file, and nothing when it is another', async () => {
    const c = capture();
    assert.equal(await main([process.execPath, script, '--version'], c.io), 0);
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    assert.deepEqual(c.out, [pkg.version]);
    const usage = capture();
    assert.equal(await main([process.execPath, script, 'nope'], usage.io), 2);
    assert.deepEqual(usage.err, [USAGE]);
    const other = capture();
    assert.equal(await main([process.execPath, join(import.meta.dirname, 'cli.test.ts'), '--version'], other.io), undefined);
    assert.equal(await main([process.execPath], other.io), undefined);
    assert.deepEqual(other.out, []);
    assert.deepEqual(other.err, []);
  });

  it('leaves an importer’s exit code as it is', async () => {
    process.exitCode = 7;
    try {
      await import(`./cli.ts?import=${Date.now()}`);
      assert.equal(process.exitCode, 7);
    } finally {
      process.exitCode = undefined;
    }
  });

  it('follows a link to this file, as node names a bin', async () => {
    const link = join(temp(), 'pariksha');
    symlinkSync(script, link);
    const c = capture();
    assert.equal(await main([process.execPath, link, 'hash', 'x'], c.io), 0);
    assert.deepEqual(c.out, [hash('x')]);
  });

  it('prints to the console by default: reports on stdout, refusals on stderr', async (t) => {
    const info = t.mock.method(console, 'info', () => undefined);
    const error = t.mock.method(console, 'error', () => undefined);
    assert.equal(await main([process.execPath, script, 'hash', 'Acme']), 0);
    assert.deepEqual(info.mock.calls.map((call) => call.arguments), [[hash('acme')]]);
    assert.equal(await main([process.execPath, script, 'nope']), 2);
    assert.deepEqual(error.mock.calls.map((call) => call.arguments), [[USAGE]]);
    consoleIo.out('out');
    consoleIo.err('err');
    assert.deepEqual(info.mock.calls.at(-1)?.arguments, ['out']);
    assert.deepEqual(error.mock.calls.at(-1)?.arguments, ['err']);
  });
});

describe('run: the flags each command takes', () => {
  // Every flag and switch a command takes, each in a run that gets past the
  // flags: what follows fails fast (nothing at --root, no such file), and
  // is anything but the usage.
  const ACCEPTED: ReadonlyArray<readonly string[]> = [
    ['absolute-paths', '--config', 'x', '--files-from', 'x', '--base', 'b', '--head', 'h', '--root', NOWHERE, '--staged', '--all'],
    ['aggregate-gate-needs', '--config', 'x', '--root', NOWHERE],
    ['authority-citations', '--mode', 'tree', '--authority', 'a', '--issue-prefix', 'A', '--adr-dir', 'd', '--root', NOWHERE],
    ['boundary', '--root', NOWHERE, '--deny', 'x'],
    ['codec-registry', '--config', 'x', '--base', 'b', '--root', NOWHERE],
    ['codec-registry', '--config', 'x', '--no-base', '--root', NOWHERE],
    ['coverage-by-type', '--config', 'x', '--files-from', 'x', '--base', 'b', '--head', 'h', '--root', NOWHERE, '--staged', '--all'],
    ['coverage-exemptions', '--config', 'x', '--package', 'p', '--root', NOWHERE],
    ['doc-budgets', '--table', 'x', '--section', 's', '--root', NOWHERE],
    ['doc-references', '--config', 'x', '--base', 'b', '--head', 'h', '--checks', '01', '--root', NOWHERE],
    ['doc-references', '--config', 'x', '--staged', '--root', NOWHERE],
    ['doc-references', '--config', 'x', '--all', '--update-baseline', '--root', NOWHERE],
    ['doc-references', '--config', 'x', '--all', '--write-baseline', '--root', NOWHERE],
    ['duplicate-tests', '--config', 'x', '--files-from', 'x', '--base', 'b', '--head', 'h', '--root', NOWHERE, '--staged', '--all'],
    ['enforcement-claims', '--config', 'x', '--root', NOWHERE],
    ['env-gate-switches', '--config', 'x', '--mode', 'tree', '--root', NOWHERE],
    ['eslint-targets', '--range', 'a..b', '--config', 'x', '--root', NOWHERE],
    ['export-deletions', '--base', 'b', '--root', NOWHERE],
    ['fault-injection-registry', '--config', 'x', '--base', 'b', '--root', NOWHERE],
    ['fault-injection-registry', '--config', 'x', '--no-base', '--root', NOWHERE],
    ['flaky-tests', '--config', 'x', '--files-from', 'x', '--base', 'b', '--head', 'h', '--runs', '2', '--root', NOWHERE, '--staged', '--all'],
    ['masked-exit-codes', '--config', 'x', '--root', NOWHERE, '--staged'],
    ['non-synced-resources', '--config', 'x', '--files-from', 'x', '--base', 'b', '--head', 'h', '--root', NOWHERE, '--staged', '--all'],
    ['pnpm-settings', '--config', 'x', '--root', NOWHERE],
    ['python-floor', '--python', 'p', '--floor-file', 'f', '--exclude', 'e', '--selector', 's', '--root', NOWHERE],
    ['regression-controls', '--config', 'x', '--root', NOWHERE, '--staged'],
    ['repo-rules', '--config', 'x', '--files-from', 'x', '--base', 'b', '--head', 'h', '--root', NOWHERE, '--staged', '--all'],
    ['required-settings', '--require', 'x', '--settings', 's', '--root', NOWHERE],
    ['shell-gates', '--config', 'x', '--base', 'b', '--files-from', 'x', '--only', 'o', '--root', NOWHERE, '--staged', '--all'],
  ];
  const stubs: Partial<Io> = {
    typescript: () => 'no typescript in this test',
    eslint: () => Promise.resolve('no eslint in this test'),
    python: () => ({ status: null, signal: null, error: new Error('no python in this test') }),
  };

  it('gets past the flags with every flag and switch a command takes', async () => {
    for (const args of ACCEPTED) {
      const r = await cliAsync(args, stubs);
      assert.notDeepEqual(r.err, [USAGE], args.join(' '));
      assert.equal(r.code, 2, args.join(' '));
    }
  });

  it('refuses a flag another command takes', () => {
    for (const args of [
      ['aggregate-gate-needs', '--staged'],
      ['boundary', '--config', 'x'],
      ['codec-registry', '--config', 'x', '--staged'],
      ['coverage-exemptions', '--config', 'x', '--base', 'b'],
      ['export-deletions', '--config', 'x'],
      ['masked-exit-codes', '--all'],
      ['regression-controls', '--config', 'x', '--all'],
      ['required-settings', '--require', 'x', '--config', 'x'],
      ['schema-roots', '--config', 'x'],
      ['eslint-by-workspace', '--staged', 'x'],
    ]) {
      assertUsage(cli(args, stubs));
    }
  });
});

describe('run absolute-paths and non-synced-resources', () => {
  const DIRTY = 'Read /Users/fixture/private.txt for details.\n';
  let folder: string | undefined;
  /** Documents in a folder outside git, read through a list. */
  const docs = (): string =>
    (folder ??= tree(
      {
        'a.md': DIRTY,
        'b.md': 'Plain.\n',
        'c.rst': DIRTY,
        'cfg/rst.json': JSON.stringify({ include: '\\.rst$', guidance: ['See the guide.'] }),
        'bad.json': '{"nope": 1}',
        'list.txt': 'b.md\n',
      },
      false,
    ));
  const HEAD = '→ Checking for absolute paths in documentation...';

  it('passes the listed clean document, and refuses a listed dirty one with the default guidance', () => {
    const clean = cli(['absolute-paths', '--root', docs(), '--files-from', '-'], { stdin: () => 'b.md\n' });
    assert.deepEqual(clean, { code: 0, out: [HEAD, '   Checking 1 documentation file(s)...', '✅ No absolute paths found in documentation'], err: [] });
    const dirty = cli(['absolute-paths', '--root', docs(), '--files-from', '-'], { stdin: () => 'a.md\0b.md\0' });
    assert.deepEqual(dirty, {
      code: 1,
      out: [HEAD, '   Checking 2 documentation file(s)...', '', '❌ Error: Absolute paths or local file references found:', '', 'a.md:1:Read /Users/fixture/private.txt for details.', '', 'Please use relative paths only.'],
      err: [],
    });
  });

  it('reads a list from a file, and the config relative to the root', () => {
    const listed = cli(['absolute-paths', '--root', docs(), '--files-from', join(docs(), 'list.txt')]);
    assert.deepEqual(listed.out, [HEAD, '   Checking 1 documentation file(s)...', '✅ No absolute paths found in documentation']);
    const rst = cli(['absolute-paths', '--root', docs(), '--config', 'cfg/rst.json', '--files-from', '-'], { stdin: () => 'a.md\nc.rst\n' });
    assert.deepEqual(rst, {
      code: 1,
      out: [HEAD, '   Checking 1 documentation file(s)...', '', '❌ Error: Absolute paths or local file references found:', '', 'c.rst:1:Read /Users/fixture/private.txt for details.', '', 'See the guide.'],
      err: [],
    });
  });

  it('exits 2, printing nothing on stdout, on a bad config, two selections, or a selection outside git', () => {
    const NOT = 'nothing was checked, so this is not a pass';
    const bad = cli(['absolute-paths', '--root', docs(), '--config', 'bad.json', '--files-from', '-'], { stdin: () => 'b.md\n' });
    assert.deepEqual(bad, { code: 2, out: [], err: [`pariksha absolute-paths: unknown key "nope"; ${NOT}`] });
    const two = cli(['absolute-paths', '--root', docs(), '--staged', '--all']);
    assert.deepEqual(two, { code: 2, out: [], err: [`pariksha absolute-paths: choose one of --staged, --base, --all, --files-from (got --staged, --all); ${NOT}`] });
    for (const selection of [['--staged'], ['--all'], ['--base', 'main']]) {
      const outside = cli(['non-synced-resources', '--root', docs(), ...selection]);
      assert.deepEqual(outside, { code: 2, out: [], err: [`pariksha non-synced-resources: ${docs()} is not in a git repository, so --staged, --base and --all have nothing to list; ${NOT}`] });
    }
    const unread = cli(['absolute-paths', '--root', docs(), '--files-from', join(docs(), 'absent.txt')]);
    assert.equal(unread.code, 2);
    assert.match(unread.err[0] ?? '', /^pariksha absolute-paths: ENOENT: .*absent\.txt'; nothing was checked, so this is not a pass$/);
  });

  it('checks links only inside a repository, whose top it finds from the root', () => {
    const outside = cli(['non-synced-resources', '--root', docs(), '--files-from', '-'], { stdin: () => 'b.md\n' });
    assert.deepEqual(outside, { code: 2, out: [], err: [`pariksha non-synced-resources: ${docs()} is not in a git repository; nothing was checked, so this is not a pass`] });
    const root = tree({ 'docs/a.md': 'See [b](b.md).\n', 'docs/b.md': '', 'docs/c.md': 'See [g](ghost.md).\n' });
    const linked = cli(['non-synced-resources', '--root', root, '--files-from', '-'], { stdin: () => 'docs/a.md\n' });
    assert.deepEqual(linked, { code: 0, out: ['→ Checking for non-synced resource references...', '   Checking 1 documentation file(s)...', '✅ All resource references are valid'], err: [] });
    const ghost = cli(['non-synced-resources', '--root', root, '--files-from', '-'], { stdin: () => 'docs/c.md\n' });
    assert.equal(ghost.code, 1);
    assert.deepEqual(ghost.out.slice(-2), ['', 'Please ensure all referenced files exist in the repository.']);
    assert.ok(ghost.out.some((line) => line.includes('ghost.md')));
  });
});

describe('.pariksha.json', () => {
  const NOT = 'nothing was checked, so this is not a pass';
  /** A `.pariksha.json` with these checks, in a folder of its own; PARIKSHA_CONFIG names it. */
  const project = (checks: unknown, files: Record<string, string> = {}): { readonly env: NodeJS.ProcessEnv; readonly folder: string } => {
    const folder = tree({ ...files, 'p.json': JSON.stringify({ checks }) }, false);
    return { env: { PARIKSHA_CONFIG: join(folder, 'p.json') }, folder };
  };
  const DIRTY = 'Read /Users/fixture/private.txt for details.\n';
  let docsFolder: string | undefined;
  const docs = (): string => (docsFolder ??= tree({ 'a.md': DIRTY, 'b.rst': DIRTY }, false));
  const absolute = (env: NodeJS.ProcessEnv, more: readonly string[] = []) => cli(['absolute-paths', '--root', docs(), '--files-from', '-', ...more], { stdin: () => 'a.md\nb.rst\n' }, env);

  it('applies an inline entry, and a file entry read from the config file’s folder', () => {
    const inline = absolute(project({ 'absolute-paths': { include: '\\.rst$', guidance: ['inline'] } }).env);
    assert.deepEqual([inline.code, inline.out[1], inline.out.at(-1)], [1, '   Checking 1 documentation file(s)...', 'inline']);
    const file = absolute(project({ 'absolute-paths': 'cfg/a.json' }, { 'cfg/a.json': JSON.stringify({ include: '\\.rst$', guidance: ['file'] }) }).env);
    assert.deepEqual([file.code, file.out.at(-1)], [1, 'file']);
  });

  it('gives way to --config on the command line, and leaves other checks alone', () => {
    const { env } = project({ 'absolute-paths': { include: '\\.rst$', guidance: ['inline'] } }, { 'mine.json': JSON.stringify({ guidance: ['mine'] }) });
    const mine = absolute(env, ['--config', join(env.PARIKSHA_CONFIG as string, '..', 'mine.json')]);
    assert.deepEqual([mine.out[1], mine.out.at(-1)], ['   Checking 1 documentation file(s)...', 'mine']);
    const other = cli(['non-synced-resources', '--root', docs(), '--files-from', '-'], { stdin: () => '' }, env);
    assert.deepEqual(other, { code: 0, out: ['→ Checking for non-synced resource references...', '✅ No documentation files to check.'], err: [] });
  });

  it('is found from the working directory by default, and only by the checks that take settings', () => {
    const { folder } = project({ 'absolute-paths': { include: '\\.rst$', guidance: ['found'] } });
    const before = process.cwd();
    process.chdir(folder);
    try {
      const c = capture();
      assert.equal(run(['absolute-paths', '--root', docs(), '--files-from', '-'], { ...c.io, stdin: () => 'a.md\nb.rst\n' }, '0', { PARIKSHA_CONFIG: 'p.json' }), 1);
      assert.equal(c.out.at(-1), 'found');
    } finally {
      process.chdir(before);
    }
    const broken = { PARIKSHA_CONFIG: join(tree({ 'p.json': '{' }, false), 'p.json') };
    assert.deepEqual(cli(['hash', 'x'], {}, broken).code, 0);
    const deny = tree({ [DENY_FILE]: DENY, 'a.md': 'clean\n' });
    assert.equal(cli(['boundary', '--root', deny], {}, broken).code, 0);
  });

  it('refuses settings it cannot read, naming the file and the version, before running the check', () => {
    const { env } = project(undefined, {});
    writeFileSync(env.PARIKSHA_CONFIG as string, '{"check": {}}');
    assert.deepEqual(absolute(env), { code: 2, out: [], err: [`pariksha absolute-paths: ${env.PARIKSHA_CONFIG} (pariksha 0): unknown key "check"; this version reads "checks"; ${NOT}`] });
    const unknown = absolute(project({ boundary: {} }).env);
    assert.equal(unknown.code, 2);
    assert.match(
      unknown.err[0] ?? '',
      / \(pariksha 0\): unknown check "boundary" in "checks"; this version reads settings for absolute-paths, aggregate-gate-needs, authority-citations, codec-registry, coverage-by-type, coverage-exemptions, doc-budgets, doc-references, duplicate-tests, enforcement-claims, env-gate-switches, eslint-by-workspace, eslint-targets, fault-injection-registry, flaky-tests, masked-exit-codes, non-synced-resources, pnpm-settings, regression-controls, repo-rules, shell-gates; nothing was checked, so this is not a pass$/,
    );
    const gone = absolute(project({ 'absolute-paths': 'gone.json' }).env);
    assert.equal(gone.code, 2);
    assert.match(gone.err[0] ?? '', /^pariksha absolute-paths: ENOENT: .*gone\.json'; nothing was checked, so this is not a pass$/);
  });

  describe('for a check of flags alone', () => {
    const RULE = '# r\n\n## Sizes\n\n| Doc | Budget |\n| --- | --: |\n| `a.md` | 5 |\n';
    let sized: string | undefined;
    /** A document of 3 bytes, budgeted at 5 by a table under the section Sizes. */
    const sizes = (): string => (sized ??= tree({ 'a.md': 'abc', 'rule.md': RULE, 'tight.md': RULE.replace('| 5 |', '| 1 |') }, false));
    let last = '';
    const budgets = (entry: unknown, more: readonly string[] = []) => {
      const p = project({ 'doc-budgets': entry }, { 'rules/rule.md': RULE });
      last = relative(sizes(), join(p.folder, 'rules/rule.md'));
      return cli(['doc-budgets', '--root', sizes(), ...more], {}, p.env);
    };

    it('sets doc-budgets’ table, read from the config file’s folder, and its section', () => {
      const r = budgets({ table: 'rules/rule.md', section: 'Sizes' });
      assert.deepEqual(r, { code: 1, out: ['pariksha doc-budgets: a.md 3 / 5 bytes'], err: [`pariksha doc-budgets: ${last} sets budgets but has no row for itself; add "| \`${last}\` | <bytes> |"`] });
    });

    it('lets a flag on the command line win', () => {
      const r = budgets({ table: 'rules/rule.md', section: 'Sizes' }, ['--table', 'tight.md']);
      assert.deepEqual(r.err, ['pariksha doc-budgets: tight.md sets budgets but has no row for itself; add "| `tight.md` | <bytes> |"', 'pariksha doc-budgets: a.md is 3 bytes, over its budget of 1; cut it']);
      const section = budgets({ table: 'rules/rule.md', section: 'Budgets' }, ['--section', 'Sizes']);
      assert.deepEqual(section.out, ['pariksha doc-budgets: a.md 3 / 5 bytes']);
    });

    it('refuses an unknown field or a wrongly typed one, naming the version', () => {
      for (const [entry, message] of [
        [{ tabel: 'x' }, 'checks.doc-budgets: unknown field "tabel" (pariksha 0); doc-budgets reads table, section'],
        [{ toString: 'x' }, 'checks.doc-budgets: unknown field "toString" (pariksha 0); doc-budgets reads table, section'],
        [{ table: ['x'] }, 'checks.doc-budgets.table must be a string (pariksha 0)'],
        [{ table: '' }, 'checks.doc-budgets.table must be a string (pariksha 0)'],
        [{ section: 5 }, 'checks.doc-budgets.section must be a string (pariksha 0)'],
      ] as const) {
        assert.deepEqual(budgets(entry), { code: 2, out: [], err: [`pariksha doc-budgets: ${message}; ${NOT}`] });
      }
    });

    it('joins a list for authority-citations, and refuses a list of anything but strings', () => {
      const authority = (entry: unknown) => cli(['authority-citations', '--root', NOWHERE], {}, project({ 'authority-citations': entry }).env);
      for (const [entry, message] of [
        [{ authority: [1] }, 'checks.authority-citations.authority must be a string or a list of strings (pariksha 0)'],
        [{ authority: ['Dana', 1] }, 'checks.authority-citations.authority must be a string or a list of strings (pariksha 0)'],
        [{ authority: [] }, 'checks.authority-citations.authority must be a string or a list of strings (pariksha 0)'],
        [{ authority: {} }, 'checks.authority-citations.authority must be a string or a list of strings (pariksha 0)'],
        [{ adrDir: ['docs'] }, 'checks.authority-citations.adrDir must be a string (pariksha 0)'],
        [{ nope: 'x' }, 'checks.authority-citations: unknown field "nope" (pariksha 0); authority-citations reads authority, issuePrefix, adrDir'],
      ] as const) {
        assert.deepEqual(authority(entry), { code: 2, out: [], err: [`pariksha authority-citations: ${message}; ${NOT}`] });
      }
      const root = tree({ 'docs/a.md': 'Offers are read from the website, approved by Lee.\n' });
      const claims = cli(['authority-citations', '--mode', 'tree', '--root', root], {}, project({ 'authority-citations': { authority: ['Dana', 'Lee'], issuePrefix: ['ATH'], adrDir: 'records/adr' } }).env);
      assert.equal(claims.code, 1);
      const said = [...claims.out, ...claims.err].join('\n');
      assert.match(said, /uncited authority claim\(s\) in docs\/a\.md:\n {2}1: \[approved by Lee\]/);
      assert.match(said, /ADR-0040, in records\/adr\//);
      assert.match(said, /ATH-447/);
    });
  });
});

/**
 * An `eslint` that is executable but can never start: its interpreter does
 * not exist. A mutant that swaps a test's recorder for the real runner
 * spawns it and fails at once, running nothing.
 */
const EBW_ESLINT_STUB = '#!/nonexistent/pariksha-test-interpreter\n';

/** `folder/node_modules/.bin/eslint`, written as `EBW_ESLINT_STUB`; its path. */
const ebwEslintAt = (folder: string): string => {
  const path = join(folder, 'node_modules/.bin/eslint');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, EBW_ESLINT_STUB);
  chmodSync(path, 0o755);
  return path;
};

/** An ESLint runner that records each call and passes. */
const ebwRecorder = () => {
  const calls: { bin: string; args: readonly string[]; cwd: string }[] = [];
  const eslintRunner: EslintRunner = (bin, args, cwd) => {
    calls.push({ bin, args, cwd });
    return { status: 0 };
  };
  return { calls, eslintRunner };
};

let ebwDir: string | undefined;
/**
 * A folder outside git with a root ESLint, a config routing `apps/m/` to the
 * root, a config with an unknown key, and `.pariksha.json` files: one
 * routing `apps/m/` to the root, one naming no known check.
 */
const ebwFolder = (): string => {
  if (ebwDir !== undefined) return ebwDir;
  const root = temp('pariksha-ebw-');
  ebwEslintAt(root);
  writeFileSync(join(root, 'routes.json'), '{"routes": {"apps/m/": "."}}');
  writeFileSync(join(root, 'bad.json'), '{"x": 1}');
  writeFileSync(join(root, 'project.json'), '{"checks": {"eslint-by-workspace": {"routes": {"apps/m/": "."}}}}');
  writeFileSync(join(root, 'unknown.json'), '{"checks": {"nope": {}}}');
  ebwDir = root;
  return root;
};

let eslintTargetsDir: string | undefined;
/**
 * A git repository with one commit holding the root `eslint.config.js`,
 * edited since, so `--range HEAD` reaches the root; a root ESLint, untracked,
 * and an empty `sub/` folder.
 */
const eslintTargetsRepo = (): string => {
  if (eslintTargetsDir !== undefined) return eslintTargetsDir;
  const root = temp('pariksha-ebw-git-');
  git(root, 'init', '-q');
  writeFileSync(join(root, 'eslint.config.js'), 'export default [];\n');
  writeFileSync(join(root, 'bad.json'), '{"x": 1}');
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one');
  writeFileSync(join(root, 'eslint.config.js'), 'export default [{}];\n');
  ebwEslintAt(root);
  mkdirSync(join(root, 'sub'));
  eslintTargetsDir = root;
  return root;
};

describe('run eslint-by-workspace', () => {
  it('refuses no file and no list, a file only after --, and an unknown flag, with the usage', () => {
    const { calls, eslintRunner } = ebwRecorder();
    assertUsage(cli(['eslint-by-workspace'], { eslintRunner }));
    assertUsage(cli(['eslint-by-workspace', '--', 'a.ts'], { eslintRunner }));
    assertUsage(cli(['eslint-by-workspace', '--dir', 'x', 'a.ts'], { eslintRunner }));
    assert.deepEqual(calls, []);
  });

  it('lints the named files and the --files-from list under --root, passing what follows -- to ESLint', () => {
    const root = ebwFolder();
    const { calls, eslintRunner } = ebwRecorder();
    const r = cli(['eslint-by-workspace', '--root', root, 'a.ts', '--files-from', '-', 'b.ts', '--', '--max-warnings=0', '--cache'], { eslintRunner, stdin: () => 'c.ts\n\nb.ts\n' });
    assert.deepEqual(r, { code: 0, out: ['✅ ESLint passed (3 file(s), routed per workspace)'], err: [] });
    assert.deepEqual(calls, [{ bin: join(root, 'node_modules/.bin/eslint'), args: ['--no-warn-ignored', '--max-warnings=0', '--cache', 'a.ts', 'b.ts', 'c.ts'], cwd: root }]);
  });

  it('lints the named files alone, with no -- and so no ESLint arguments', () => {
    const root = ebwFolder();
    const { calls, eslintRunner } = ebwRecorder();
    const r = cli(['eslint-by-workspace', '--root', root, 'x.ts', 'y.ts'], { eslintRunner });
    assert.deepEqual(r, { code: 0, out: ['✅ ESLint passed (2 file(s), routed per workspace)'], err: [] });
    assert.deepEqual(calls, [{ bin: join(root, 'node_modules/.bin/eslint'), args: ['--no-warn-ignored', 'x.ts', 'y.ts'], cwd: root }]);
  });

  it('lints the --files-from list alone', () => {
    const root = ebwFolder();
    const { calls, eslintRunner } = ebwRecorder();
    const r = cli(['eslint-by-workspace', '--root', root, '--files-from', '-'], { eslintRunner, stdin: () => 'l.ts\n' });
    assert.deepEqual(r, { code: 0, out: ['✅ ESLint passed (1 file(s), routed per workspace)'], err: [] });
    assert.deepEqual(calls, [{ bin: join(root, 'node_modules/.bin/eslint'), args: ['--no-warn-ignored', 'l.ts'], cwd: root }]);
  });

  it('routes by the --config it names, and by its own workspace folder without one', () => {
    const root = ebwFolder();
    const routed = ebwRecorder();
    assert.equal(cli(['eslint-by-workspace', '--root', root, '--config', 'routes.json', 'apps/m/x.ts'], { eslintRunner: routed.eslintRunner }).code, 0);
    assert.deepEqual(routed.calls, [{ bin: join(root, 'node_modules/.bin/eslint'), args: ['--no-warn-ignored', 'apps/m/x.ts'], cwd: root }]);
    const plain = ebwRecorder();
    assert.equal(cli(['eslint-by-workspace', '--root', root, 'apps/m/x.ts'], { eslintRunner: plain.eslintRunner }).code, 0);
    assert.deepEqual(plain.calls, [{ bin: join(root, 'node_modules/.bin/eslint'), args: ['--no-warn-ignored', 'x.ts'], cwd: join(root, 'apps/m') }]);
  });

  it('routes by the .pariksha.json PARIKSHA_CONFIG names', () => {
    const root = ebwFolder();
    const { calls, eslintRunner } = ebwRecorder();
    assert.equal(cli(['eslint-by-workspace', '--root', root, 'apps/m/x.ts'], { eslintRunner }, { PARIKSHA_CONFIG: join(root, 'project.json') }).code, 0);
    assert.deepEqual(calls, [{ bin: join(root, 'node_modules/.bin/eslint'), args: ['--no-warn-ignored', 'apps/m/x.ts'], cwd: root }]);
  });

  it('exits 2, linting nothing, on a config it cannot read or a .pariksha.json it cannot use', () => {
    const root = ebwFolder();
    const { calls, eslintRunner } = ebwRecorder();
    assert.deepEqual(cli(['eslint-by-workspace', '--root', root, '--config', 'bad.json', 'a.ts'], { eslintRunner }), {
      code: 2,
      out: [],
      err: ['pariksha eslint-by-workspace: unknown key "x"; nothing was checked, so this is not a pass'],
    });
    const project = cli(['eslint-by-workspace', '--root', root, 'a.ts'], { eslintRunner }, { PARIKSHA_CONFIG: join(root, 'unknown.json') });
    assert.equal(project.code, 2);
    assert.deepEqual(project.out, []);
    assert.equal(project.err.length, 1);
    assert.match(project.err[0] ?? '', /^pariksha eslint-by-workspace: .*unknown check "nope".*; nothing was checked, so this is not a pass$/);
    assert.deepEqual(calls, []);
  });

  it('exits 2 on a --files-from list it cannot read', () => {
    const root = ebwFolder();
    const { calls, eslintRunner } = ebwRecorder();
    const list = join(root, 'none.txt');
    assert.deepEqual(cli(['eslint-by-workspace', '--root', root, '--files-from', list], { eslintRunner }), {
      code: 2,
      out: [],
      err: [`pariksha eslint-by-workspace: ENOENT: no such file or directory, open '${list}'; nothing was checked, so this is not a pass`],
    });
    assert.deepEqual(calls, []);
  });

  it('runs ESLint itself, from the process’s own folder, when given neither', () => {
    const root = ebwFolder();
    const c = capture();
    const code = run(['eslint-by-workspace', '--root', root, 'a.ts'], { ...c.io, stdin: noStdin }, '0', { PARIKSHA_CONFIG: NO_PROJECT });
    assert.deepEqual({ code, out: c.out, err: c.err }, { code: 1, out: [], err: [`❌ ESLint could not run in .: spawnSync ${join(root, 'node_modules/.bin/eslint')} ENOENT`] });
  });

  it('reads paths from the folder it runs in outside git, and from the top level inside it', () => {
    const outside = ebwRecorder();
    const folder = ebwFolder();
    assert.equal(cli(['eslint-by-workspace', 'a.ts'], { eslintRunner: outside.eslintRunner, cwd: () => folder }).code, 0);
    assert.deepEqual(outside.calls, [{ bin: join(folder, 'node_modules/.bin/eslint'), args: ['--no-warn-ignored', 'a.ts'], cwd: folder }]);
    const top = eslintTargetsRepo();
    const inside = ebwRecorder();
    assert.equal(cli(['eslint-by-workspace', 'a.ts'], { eslintRunner: inside.eslintRunner, cwd: () => join(top, 'sub') }).code, 0);
    assert.deepEqual(inside.calls, [{ bin: join(top, 'node_modules/.bin/eslint'), args: ['--no-warn-ignored', 'a.ts'], cwd: top }]);
  });
});

describe('run eslint-targets', () => {
  it('refuses no --range, and a range that reads as a flag, with the usage', () => {
    assertUsage(cli(['eslint-targets', '--root', NOWHERE]));
    assertUsage(cli(['eslint-targets', '--root', NOWHERE, '--range', '-x']));
  });

  it('exits 2 outside a git repository', () => {
    assert.deepEqual(cli(['eslint-targets', '--root', NOWHERE, '--range', 'HEAD']), { code: 2, out: [], err: [`pariksha eslint-targets: ${NOWHERE} is not in a git repository`] });
  });

  it('exits 2 on a config it cannot read', () => {
    assert.deepEqual(cli(['eslint-targets', '--root', eslintTargetsRepo(), '--range', 'HEAD', '--config', 'bad.json']), {
      code: 2,
      out: [],
      err: ['pariksha eslint-targets: unknown key "x"; nothing was checked, so this is not a pass'],
    });
  });

  it('names each target the range reaches on its own line', () => {
    assert.deepEqual(cli(['eslint-targets', '--root', eslintTargetsRepo(), '--range', 'HEAD']), { code: 0, out: ['.'], err: [] });
  });
});

/** An interpreter that does not exist: a mutant that swaps the recorder for the real runner fails at once. */
const PYTHON_FLOOR_NONE = '/nonexistent/pariksha-test-python';

/** A Python runner that records each call and exits 3. */
const pythonFloorRecorder = () => {
  const calls: { python: string; args: readonly string[] }[] = [];
  const python: PythonRunner = (interpreter, args) => {
    calls.push({ python: interpreter, args });
    return { status: 3, signal: null };
  };
  return { calls, python };
};

describe('run python-floor', () => {
  it('refuses a missing --python or --floor-file with the usage, running nothing', () => {
    const { calls, python } = pythonFloorRecorder();
    assertUsage(cli(['python-floor', '--floor-file', 'floor'], { python }));
    assertUsage(cli(['python-floor', '--python', PYTHON_FLOOR_NONE], { python }));
    assert.deepEqual(calls, []);
  });

  it('hands the runner the interpreter and every option given, returning its exit code', () => {
    const { calls, python } = pythonFloorRecorder();
    const r = cli(['python-floor', '--selector', 'pick.sh', '--python', PYTHON_FLOOR_NONE, '--exclude', '^old/', '--floor-file', 'floor', '--root', 'repo'], { python });
    assert.deepEqual(r, { code: 3, out: [], err: [] });
    assert.deepEqual(
      calls.map((c) => ({ python: c.python, args: c.args.slice(1) })),
      [{ python: PYTHON_FLOOR_NONE, args: ['--floor-file', 'floor', '--root', 'repo', '--exclude', '^old/', '--selector', 'pick.sh'] }],
    );
    assert.match(calls[0]?.args[0] ?? '', /python-floor\.py$/);
  });

  it('hands the runner no option it was not given', () => {
    const { calls, python } = pythonFloorRecorder();
    assert.equal(cli(['python-floor', '--python', PYTHON_FLOOR_NONE, '--floor-file', 'floor'], { python }).code, 3);
    assert.deepEqual(
      calls.map((c) => ({ python: c.python, args: c.args.slice(1) })),
      [{ python: PYTHON_FLOOR_NONE, args: ['--floor-file', 'floor'] }],
    );
  });

  it('runs the interpreter itself when given no runner', () => {
    assert.deepEqual(cli(['python-floor', '--python', PYTHON_FLOOR_NONE, '--floor-file', 'floor']), {
      code: 2,
      out: [],
      err: [`pariksha python-floor: cannot run ${PYTHON_FLOOR_NONE}: spawnSync ${PYTHON_FLOOR_NONE} ENOENT; nothing was checked, so this is not a pass`],
    });
  });
});

const SCHEMA_BAD = JSON.stringify({ tools: [{ name: 'verdict', input_schema: { oneOf: [{ type: 'object' }] } }] });
const SCHEMA_GOOD = JSON.stringify({ tools: [{ name: 'verdict', input_schema: { type: 'object' } }] });

let schemaRootsDir: string | undefined;
/** A folder outside git holding `bad.json`, with a root combinator, and `good.json`, with none. */
const schemaRootsFixture = (): string => {
  if (schemaRootsDir !== undefined) return schemaRootsDir;
  schemaRootsDir = tree({ 'bad.json': SCHEMA_BAD, 'good.json': SCHEMA_GOOD }, false);
  return schemaRootsDir;
};

describe('run schema-roots', () => {
  it('refuses a flag it does not take with the usage', () => {
    assertUsage(cli(['schema-roots', '--config', 'x.json']));
  });

  it('passes the named files under --root when none has a combinator at a schema root, each read once', () => {
    assert.deepEqual(cli(['schema-roots', '--root', schemaRootsFixture(), 'good.json', './good.json', 'notes.md']), {
      code: 0,
      out: ['pariksha schema-roots: 1 JSON file(s), no tool or output schema with oneOf, allOf or anyOf at its root'],
      err: [],
    });
  });

  it('reads the --files-from list, with the named files, and refuses a combinator at a schema root', () => {
    const r = cli(['schema-roots', 'good.json', '--root', schemaRootsFixture(), '--files-from', '-'], { stdin: () => 'bad.json\nnotes.md\n' });
    assert.deepEqual(r, {
      code: 1,
      out: [],
      err: [
        'pariksha schema-roots: bad.json: $.tools[0].input_schema: top-level oneOf. The API rejects tool and output schemas with oneOf, allOf or anyOf at the root; express the condition in code after the call returns.',
      ],
    });
  });

  it('reads the --files-from list alone', () => {
    assert.deepEqual(cli(['schema-roots', '--root', schemaRootsFixture(), '--files-from', '-'], { stdin: () => 'good.json\n' }), {
      code: 0,
      out: ['pariksha schema-roots: 1 JSON file(s), no tool or output schema with oneOf, allOf or anyOf at its root'],
      err: [],
    });
  });

  it('exits 2 naming a file it cannot read, printing no finding', () => {
    const root = schemaRootsFixture();
    assert.deepEqual(cli(['schema-roots', '--root', root, 'bad.json', 'missing.json']), {
      code: 2,
      out: [],
      err: [`pariksha schema-roots: missing.json: ENOENT: no such file or directory, open '${join(root, 'missing.json')}'; nothing was checked, so this is not a pass`],
    });
  });
});

/** Commits what is staged in `root`, as a fixture author. */
const w1Commit = (root: string, message: string) => git(root, '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);

/** `body` with PATH set to `path` alone, so no tool but those it holds can start. */
const w1WithPath = <T>(path: string, body: () => T): T => {
  const was = process.env['PATH'];
  process.env['PATH'] = path;
  try {
    return body();
  } finally {
    process.env['PATH'] = was;
  }
};

describe('run aggregate-gate-needs', () => {
  const GAP = [
    '\n❌ CI-1: 1 aggregate gate(s) with an incomplete needs list\n',
    ' .github/workflows/ci.yml → job "ci-gate"',
    '   not depended on: lint\n',
    'The merge queue checks only the gate. A job absent from its `needs:` cannot\nblock a merge however it fails — and a failure upstream turns into a SKIP\ndownstream, which the gate then accepts.\n',
  ];
  let gapRoot: string | undefined;
  const aggGap = (): string =>
    (gapRoot ??= tree(
      {
        '.github/workflows/ci.yml': 'jobs:\n  setup: {}\n  lint: {}\n  ci-gate:\n    needs: [setup]\n',
        'gate.json': '{"id": "CI-1"}',
        'bad.json': '{"x": 1}',
      },
      false,
    ));

  it('refuses a config it cannot parse, exit 2', () => {
    assert.deepEqual(cli(['aggregate-gate-needs', '--root', aggGap(), '--config', 'bad.json']), {
      code: 2,
      out: [],
      err: ['pariksha aggregate-gate-needs: unknown key "x"; nothing was checked, so this is not a pass'],
    });
  });

  it('refuses a gap on stderr, worded with the default id or the config’s, exit 1', () => {
    assert.deepEqual(cli(['aggregate-gate-needs', '--root', aggGap()]), { code: 1, out: [], err: GAP.map((line) => line.replace('CI-1', 'aggregate-gate-needs')) });
    assert.deepEqual(cli(['aggregate-gate-needs', '--root', aggGap(), '--config', 'gate.json']), { code: 1, out: [], err: GAP });
  });

  it('passes complete gates on stdout, exit 0', () => {
    const root = tree({ '.github/workflows/ci.yml': 'jobs:\n  setup: {}\n  ci-gate:\n    needs: [setup]\n' }, false);
    assert.deepEqual(cli(['aggregate-gate-needs', '--root', root]), { code: 0, out: ['✅ aggregate-gate-needs: every aggregate gate depends on all its jobs (1 workflow(s))'], err: [] });
  });
});

describe('run pnpm-settings', () => {
  let pnpmRoot: string | undefined;
  /** A pnpm workspace with one documented exception, expired since 2000. */
  const pnpmFixture = (): string =>
    (pnpmRoot ??= tree(
      {
        'package.json': '{}',
        'pnpm-workspace.yaml': "# Taken for a test.\n# EXPIRES: 2000-01-01\nminimumReleaseAgeExclude:\n  - 'a@1.0.0'\n",
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\npackages:\n  a@1.0.0: {}\n",
        'cfg.json': '{"id": "P-1"}',
        'bad.json': '{"x": 1}',
      },
      false,
    ));

  it('refuses a config it cannot parse, exit 2', () => {
    assert.deepEqual(cli(['pnpm-settings', '--root', pnpmFixture(), '--config', 'bad.json'], { now: () => 0 }), {
      code: 2,
      out: [],
      err: ['pariksha pnpm-settings: unknown key "x"; nothing was checked, so this is not a pass'],
    });
  });

  it('holds an expiry to the time it is given, with the default id', () => {
    assert.deepEqual(cli(['pnpm-settings', '--root', pnpmFixture()], { now: () => 0 }), {
      code: 0,
      out: ['✅ pnpm-settings: pnpm settings parity OK — 0 override(s), 0 patch(es), 0 resolved version(s) verified, 1 documented cooling-off exception(s).'],
      err: [],
    });
  });

  it('holds an expiry to the clock without one, worded with the config’s id, exit 1', () => {
    assert.deepEqual(cli(['pnpm-settings', '--root', pnpmFixture(), '--config', 'cfg.json']), {
      code: 1,
      out: [],
      err: [
        '\n❌ P-1: pnpm settings parity FAILED (1 problem(s))\n',
        ' • the minimumReleaseAgeExclude exception expired at 2000-01-01T00:00:00.000Z and is still in force for `a@1.0.0`. The pinned versions have aged past minimumReleaseAge, so pnpm will not re-add them: exception expired; delete the entries.\n',
        'A successful `pnpm install` is not evidence here — pnpm 11 drops these settings without warning.\n',
      ],
    });
  });
});

describe('run masked-exit-codes', () => {
  it('refuses a config it cannot parse, exit 2', () => {
    const root = tree({ 'bad.json': '{"x": 1}' }, false);
    assert.deepEqual(cli(['masked-exit-codes', '--root', root, '--config', 'bad.json']), {
      code: 2,
      out: [],
      err: ['pariksha masked-exit-codes: unknown key "x"; nothing was checked, so this is not a pass'],
    });
  });

  let maskedRoot: string | undefined;
  /** A repository whose index holds a masked gate and whose working tree holds it fixed. */
  const maskedFixture = (): string => {
    if (maskedRoot === undefined) {
      maskedRoot = tree({ 'a.sh': 'eslint . || true\n', 'cfg.json': '{"id": "M-1"}' });
      writeFileSync(join(maskedRoot, 'a.sh'), 'eslint .\n');
    }
    return maskedRoot;
  };

  it('reads the working tree by default, with the default id, exit 0', () => {
    assert.deepEqual(cli(['masked-exit-codes', '--root', maskedFixture()]), { code: 0, out: ['✅ masked-exit-codes: no masked exit codes (1 shell file(s) scanned)'], err: [] });
  });

  it('reads the index with --staged, worded with the config’s id, exit 1', () => {
    assert.deepEqual(cli(['masked-exit-codes', '--root', maskedFixture(), '--config', 'cfg.json', '--staged']), {
      code: 1,
      out: [],
      err: [
        '\n❌ M-1: 1 masked exit code(s)\n',
        ' a.sh:1',
        '   eslint . || true',
        '   `eslint` is a gate, but `|| true` discards its exit status — the check reports success whatever it found\n',
        'A gate that cannot fail is not a gate. Branch on the status, or drop the check.\n',
      ],
    });
  });
});

describe('run shell-gates', () => {
  const P = '❌ Shell gates could not run:';
  let plainRoot: string | undefined;
  /** A plain folder: one clean script, a config with a preamble section, and one that does not parse. */
  const shellPlain = (): string =>
    (plainRoot ??= tree(
      {
        'scripts/a.sh': '#!/bin/bash\necho ok\n',
        'pre.json': '{"preamble": {"selectScript": "select.sh", "selectFunction": "select"}}',
        'bad.json': '{"x": 1}',
      },
      false,
    ));
  /** A ShellCheck that passes everything, and the arguments of each call. */
  const shellStub = () => {
    const calls: (readonly string[])[] = [];
    const runner: ShellcheckRunner = (_cwd, args): RunResult => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    };
    return { calls, runner };
  };
  const shellFiles = (args: readonly string[], stub = shellStub(), stdin = 'scripts/a.sh\n') =>
    cli(['shell-gates', '--root', shellPlain(), '--files-from', '-', ...args], { shellcheck: stub.runner, stdin: () => stdin });

  it('refuses two modes, naming them', () => {
    const stub = shellStub();
    assert.deepEqual(cli(['shell-gates', '--root', NOWHERE, '--staged', '--all'], { shellcheck: stub.runner }), { code: 2, out: [], err: [`${P} choose one of --staged, --all, --base, --files-from (got --staged, --all)`] });
    assert.deepEqual(cli(['shell-gates', '--root', NOWHERE, '--base', 'x', '--files-from', '-'], { shellcheck: stub.runner }), {
      code: 2,
      out: [],
      err: [`${P} choose one of --staged, --all, --base, --files-from (got --base, --files-from)`],
    });
    assert.deepEqual(stub.calls, []);
  });

  it('refuses a config it cannot parse, and an empty --files-from list', () => {
    assert.deepEqual(shellFiles(['--config', 'bad.json']), { code: 2, out: [], err: [`${P} unknown key "x"`] });
    assert.deepEqual(shellFiles([], shellStub(), '\n'), { code: 2, out: [], err: [`${P} the --files-from list names no file, and a check of nothing is no pass`] });
  });

  it('refuses an --only that names no check, or one that is not a check', () => {
    assert.deepEqual(shellFiles(['--only', ',']), { code: 2, out: [], err: [`${P} --only takes preamble,pitfalls; got nothing`] });
    assert.deepEqual(shellFiles(['--only', 'lint,pitfalls']), { code: 2, out: [], err: [`${P} --only takes preamble,pitfalls; got lint,pitfalls`] });
  });

  it('runs every ShellCheck pass and the checks the default config has, over the listed files', () => {
    const stub = shellStub();
    assert.deepEqual(shellFiles([], stub), { code: 0, out: ['✅ Shell gates: 1 file(s) pass pitfalls'], err: [] });
    assert.deepEqual(stub.calls, [['--version'], ['--norc', '--severity=warning', '--', 'scripts/a.sh'], ['--norc', '--severity=info', '--include=SC2086,SC2013,SC2015', '--', 'scripts/a.sh']]);
  });

  it('runs the preamble check too when the config has its section', () => {
    const stub = shellStub();
    assert.deepEqual(shellFiles(['--config', 'pre.json'], stub), { code: 0, out: ['✅ Shell gates: 1 file(s) pass preamble, pitfalls'], err: [] });
    assert.equal(stub.calls.length, 3);
  });

  it('runs only the checks --only names, in their own order, and no ShellCheck', () => {
    const stub = shellStub();
    assert.deepEqual(shellFiles(['--config', 'pre.json', '--only', 'pitfalls'], stub), { code: 0, out: ['✅ Shell gates: 1 file(s) pass pitfalls'], err: [] });
    assert.deepEqual(shellFiles(['--config', 'pre.json', '--only', 'pitfalls,preamble,'], stub), { code: 0, out: ['✅ Shell gates: 1 file(s) pass preamble, pitfalls'], err: [] });
    assert.deepEqual(stub.calls, []);
  });

  it('runs shellcheck from PATH when it is given no runner', () => {
    const r = w1WithPath(NOWHERE, () => cli(['shell-gates', '--root', shellPlain(), '--files-from', '-'], { stdin: () => 'scripts/a.sh\n' }));
    assert.deepEqual(r, { code: 1, out: [], err: ['❌ shellcheck is required: install it from https://www.shellcheck.net'] });
  });

  let gitRoot: string | undefined;
  /** A repository with one committed script and one only staged. */
  const shellRepo = (): string => {
    if (gitRoot === undefined) {
      gitRoot = repo({ 'scripts/a.sh': '#!/bin/bash\necho a\n' });
      w1Commit(gitRoot, 'a');
      writeFileSync(join(gitRoot, 'scripts/b.sh'), '#!/bin/bash\necho b\n');
      git(gitRoot, 'add', 'scripts/b.sh');
    }
    return gitRoot;
  };

  it('judges the staged files by default, every tracked one with --all, and those since --base', () => {
    const at = (...args: string[]) => cli(['shell-gates', '--root', shellRepo(), '--only', 'pitfalls', ...args]);
    assert.deepEqual(at(), { code: 0, out: ['✅ Shell gates: 1 file(s) pass pitfalls'], err: [] });
    assert.deepEqual(at('--staged'), { code: 0, out: ['✅ Shell gates: 1 file(s) pass pitfalls'], err: [] });
    assert.deepEqual(at('--all'), { code: 0, out: ['✅ Shell gates: 2 file(s) pass pitfalls'], err: [] });
    assert.deepEqual(at('--base', 'HEAD'), { code: 0, out: ['✅ Shell gates: no shell scripts or hooks to check'], err: [] });
  });
});

describe('run doc-references', () => {
  const P = 'pariksha doc-references:';
  /** A doc-references config reading `markdown` files, its baseline at `baseline`; links checked in `links` when given. */
  const docRefConfig = (markdown: string, baseline: string, links: string | null = null): string =>
    JSON.stringify({
      baseline,
      exemptMarker: 'ok',
      files: { markdown: [markdown], html: [], code: [], codeExclude: [], exclude: [], hashComments: '^$' },
      placeholder: '<',
      paths: { extensions: ['ts', 'md'], examples: '^$', untracked: [], workspaces: '^$', layouts: [] },
      links: links === null ? null : { include: links },
      scripts: { manifests: ['package.json'], mutating: {}, verification: 'check', wrappers: [] },
      commands: { typescriptRunner: null, nested: [] },
      identifiers: { notIdentifiers: [], searchExclude: [], diffExclude: [], prisma: null, routes: null, jobs: null, packages: null },
    });

  /** Past every refusal: what a run whose flags all pass prints for a folder outside git. */
  const docRefPasses = (...args: string[]) => {
    assert.deepEqual(cli(['doc-references', '--config', 'c.json', ...args, '--root', NOWHERE]), { code: 2, out: [], err: [`${P} ${NOWHERE} is not in a git repository`] }, args.join(' '));
  };

  it('refuses each flag combination it does not take with the usage', () => {
    assertUsage(cli(['doc-references', '--staged', '--root', NOWHERE]));
    for (const args of [
      [],
      ['--staged', '--all'],
      ['--staged', '--base', 'x'],
      ['--all', '--base', 'x'],
      ['--all', '--update-baseline', '--write-baseline'],
      ['--staged', '--write-baseline'],
      ['--staged', '--update-baseline'],
      ['--base', 'x', '--update-baseline'],
      ['--staged', '--head', 'y'],
    ]) {
      assertUsage(cli(['doc-references', '--config', 'c.json', ...args, '--root', NOWHERE]));
    }
  });

  it('refuses an unknown --checks id, naming it, or them, and the ids there are', () => {
    const checks = (value: string) => cli(['doc-references', '--config', 'c.json', '--all', '--checks', value, '--root', NOWHERE]);
    assert.deepEqual(checks('03'), { code: 2, out: [], err: [`${P} --checks: DOC-DRIFT-03 is not one of DOC-DRIFT-01, DOC-DRIFT-02, DOC-DRIFT-04`] });
    assert.deepEqual(checks('01,DOC-DRIFT-05'), { code: 2, out: [], err: [`${P} --checks: DOC-DRIFT-05 is not one of DOC-DRIFT-01, DOC-DRIFT-02, DOC-DRIFT-04`] });
    assert.deepEqual(checks('03,05'), { code: 2, out: [], err: [`${P} --checks: DOC-DRIFT-03, DOC-DRIFT-05 are not of DOC-DRIFT-01, DOC-DRIFT-02, DOC-DRIFT-04`] });
  });

  it('takes one mode, a baseline switch with --all, --head with --base, and known --checks', () => {
    docRefPasses('--staged');
    docRefPasses('--all');
    docRefPasses('--base', 'x');
    docRefPasses('--base', 'x', '--head', 'y');
    docRefPasses('--all', '--write-baseline');
    docRefPasses('--all', '--update-baseline');
    docRefPasses('--staged', '--checks', '01,DOC-DRIFT-04');
  });

  let docRoot: string | undefined;
  /**
   * docs/a.md committed with the configs, then docs/b.md and docs/c.md a
   * commit each, and docs/d.md staged; bad/x.md names a file that is not there.
   */
  const docRefRepo = (): string => {
    if (docRoot === undefined) {
      const root = repo({
        '.gitignore': 'node_modules/\n',
        'package.json': '{"name": "r"}',
        'clean.json': docRefConfig('^docs/', 'none.json'),
        'slack.json': docRefConfig('^docs/', 'slack-base.json'),
        'slack-base.json': '{"version": 1, "files": {"docs/a.md": {"DOC-DRIFT-01": 1}}}\n',
        'bad.json': docRefConfig('^bad/', 'none.json'),
        'write.json': docRefConfig('^bad/', 'out/w.json'),
        'update.json': docRefConfig('^bad/', 'out/u.json'),
        'links.json': docRefConfig('^docs/', 'none.json', '^docs/a\\.md$'),
        'broken.json': '{"x": 1}',
        'docs/a.md': 'Hello.\n',
        'bad/x.md': 'See `scripts/gone.ts`.\n',
        'out/.keep': '',
      });
      mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
      w1Commit(root, 'a');
      for (const name of ['b', 'c']) {
        writeFileSync(join(root, `docs/${name}.md`), 'Hello.\n');
        git(root, 'add', `docs/${name}.md`);
        w1Commit(root, name);
      }
      writeFileSync(join(root, 'docs/d.md'), 'Hello.\n');
      git(root, 'add', 'docs/d.md');
      docRoot = root;
    }
    return docRoot;
  };
  const NOT_CHECKED = `${P} not checked: links, commands.typescriptRunner, identifiers.prisma, identifiers.routes, identifiers.jobs, identifiers.packages`;
  const docRefClean = (n: number, scope: string) => `${P} ${n} reference file(s) checked (${scope}), no new problem; the baseline does not grow`;
  const docRefs = (config: string, args: readonly string[], over: Partial<Io> = {}) => cli(['doc-references', '--config', config, '--root', docRefRepo(), ...args], over);

  it('refuses a config it cannot parse, exit 2', () => {
    assert.deepEqual(docRefs('broken.json', ['--all']), { code: 2, out: [], err: [`${P} unknown key "x"; nothing was checked, so this is not a pass`] });
  });

  it('checks a commit with DOC-DRIFT-01 and -02 by default, or the checks asked for', () => {
    assert.deepEqual(docRefs('clean.json', ['--staged']), { code: 0, out: [docRefClean(1, 'staged; DOC-DRIFT-04 not run'), NOT_CHECKED], err: [] });
    assert.deepEqual(docRefs('clean.json', ['--staged', '--checks', '01,DOC-DRIFT-04']), { code: 0, out: [docRefClean(1, 'staged; DOC-DRIFT-02 not run'), NOT_CHECKED], err: [] });
  });

  it('checks a push from the merge base to HEAD, or to --head, with every check', () => {
    assert.deepEqual(docRefs('clean.json', ['--base', 'HEAD~2']), { code: 0, out: [docRefClean(2, 'pushed'), NOT_CHECKED], err: [] });
    assert.deepEqual(docRefs('clean.json', ['--base', 'HEAD~2', '--head', 'HEAD~1']), { code: 0, out: [docRefClean(1, 'pushed'), NOT_CHECKED], err: [] });
  });

  it('checks the whole tree with every check, or the checks asked for', () => {
    assert.deepEqual(docRefs('clean.json', ['--all']), { code: 0, out: [docRefClean(4, 'all'), NOT_CHECKED], err: [] });
    assert.deepEqual(docRefs('clean.json', ['--all', '--checks', '04']), { code: 0, out: [docRefClean(4, 'all; DOC-DRIFT-01, DOC-DRIFT-02 not run'), NOT_CHECKED], err: [] });
  });

  it('hands the link check the runner it is given', () => {
    const asked: (readonly string[])[] = [];
    const links: LinkRunner = (_dir, files) => {
      asked.push(files);
      return '{"error_map":{}}';
    };
    assert.deepEqual(docRefs('links.json', ['--all'], { links }), {
      code: 0,
      out: [docRefClean(4, 'all'), `${P} not checked: commands.typescriptRunner, identifiers.prisma, identifiers.routes, identifiers.jobs, identifiers.packages`],
      err: [],
    });
    assert.deepEqual(asked, [['docs/a.md']]);
  });

  it('runs lychee from PATH when it is given no runner', () => {
    const bin = temp();
    writeFileSync(join(bin, 'lychee'), '#!/bin/sh\nexit 3\n');
    chmodSync(join(bin, 'lychee'), 0o755);
    assert.deepEqual(w1WithPath(`${bin}${delimiter}${process.env['PATH'] ?? ''}`, () => docRefs('links.json', ['--all'])), {
      code: 2,
      out: [],
      err: [`${P} lychee exited 3: ; nothing was checked, so this is not a pass`],
    });
  });

  it('prints each problem and what to do on stderr, exit 1', () => {
    const r = docRefs('bad.json', ['--all']);
    assert.equal(r.code, 1);
    assert.deepEqual(r.out, []);
    assert.equal(r.err.length, 2);
    assert.match(r.err[0] ?? '', /^pariksha doc-references: bad\/x\.md:1: \[DOC-DRIFT-01\] scripts\/gone\.ts: \S/);
    assert.equal(
      r.err[1],
      `${P} 1 unresolved reference(s) in 1 file(s). Fix each; one that names something absent on purpose (a quoted finding, a deleted or planned file) ends its line with <!-- ok: <why> --> (in code, a comment holding ok: <why>).`,
    );
  });

  it('names the --config it was given in the command that lowers the baseline, and none for settings from .pariksha.json', () => {
    const slack = (lower: string) => `${P} slack-base.json: docs/a.md DOC-DRIFT-01: baseline 1, now 0; lower it: ${lower}`;
    assert.deepEqual(docRefs('slack.json', ['--all']), { code: 1, out: [], err: [slack('pariksha doc-references --config slack.json --all --update-baseline')] });
    const project = join(temp(), '.pariksha.json');
    writeFileSync(project, JSON.stringify({ checks: { 'doc-references': join(docRefRepo(), 'slack.json') } }));
    assert.deepEqual(cli(['doc-references', '--all', '--root', docRefRepo()], {}, { PARIKSHA_CONFIG: project }), { code: 1, out: [], err: [slack('pariksha doc-references --all --update-baseline')] });
  });

  it('writes the baseline with --write-baseline, and only lowers it with --update-baseline', () => {
    assert.deepEqual(docRefs('write.json', ['--all', '--write-baseline']), { code: 0, out: [`${P} wrote out/w.json: 1 file(s) hold 1 problem(s) (1 reference file(s) checked)`], err: [] });
    assert.deepEqual(JSON.parse(readFileSync(join(docRefRepo(), 'out/w.json'), 'utf8')), { version: 1, files: { 'bad/x.md': { 'DOC-DRIFT-01': 1 } } });
    assert.deepEqual(docRefs('update.json', ['--all', '--update-baseline']), { code: 0, out: [`${P} wrote out/u.json: 0 file(s) hold 1 problem(s) (1 reference file(s) checked)`], err: [] });
    assert.deepEqual(JSON.parse(readFileSync(join(docRefRepo(), 'out/u.json'), 'utf8')), { version: 1, files: {} });
  });
});

/** A commit in a fixture repository, by a fixed identity (the hermetic config has none). */
const commitAll = (root: string, message: string): void => {
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
};

/** Writes `files` under `root`. */
const writeAll = (root: string, files: Record<string, string>): void => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
};

/**
 * repo-rules' one repository, built on first use and never changed after.
 * main holds a workflow whose path filter starts with "/", and the pin test
 * `src/pin.test.ts`; the branch `work` renames src/old.ts away; the index
 * deletes src/kept.ts. The pin quotes the removed paths at a different line
 * in the work commit (2), the index (3) and the working tree (5 and 6), so a
 * finding's line names the side grep read; and each version holds `''`,
 * which an empty removed path would quote. The working tree's also quotes
 * the path Stryker puts in a mutated empty list, so a run that removes
 * nothing must say so.
 */
let repoRulesTop: string | undefined;
const repoRulesFixture = (): string => {
  if (repoRulesTop !== undefined) return repoRulesTop;
  const root = temp('pariksha-cli-repo-rules-');
  git(root, 'init', '-q', '-b', 'main');
  writeAll(root, {
    '.github/workflows/ci.yml': 'on:\n  pull_request:\n    paths: ["/apps/**"]\njobs: {}\n',
    'src/old.ts': 'export {};\n',
    'src/kept.ts': 'export {};\n',
    'src/pin.test.ts': "const e = '';\n",
    'notes.md': 'x\n',
    'allow.json': '{"rules": {"actions-path-leading-slash": {"allow": {".github/workflows/ci.yml": "a fixture of the mistake"}}}}\n',
    'stale.json': '{"rules": {"actions-path-leading-slash": {"allow": {"gone.yml": "a file since deleted"}}}}\n',
  });
  git(root, 'add', '-A');
  commitAll(root, 'base');
  git(root, 'checkout', '-q', '-b', 'work');
  git(root, 'mv', 'src/old.ts', 'src/moved.ts');
  writeAll(root, { 'src/pin.test.ts': "const e = '';\nconst a = \"src/old.ts\";\n" });
  git(root, 'add', '-A');
  commitAll(root, 'move');
  git(root, 'checkout', '-q', 'main');
  git(root, 'rm', '-q', 'src/kept.ts');
  writeAll(root, { 'src/pin.test.ts': "const e = '';\n\nconst b = 'src/kept.ts';\nconst a = \"src/old.ts\";\n" });
  git(root, 'add', 'src/pin.test.ts');
  writeAll(root, { 'src/pin.test.ts': "const e = '';\n\n\n\nconst b = 'src/kept.ts';\nconst a = \"src/old.ts\";\n", 'bad.json': '{"rules": {"nope": {}}}\n' });
  repoRulesTop = root;
  return root;
};

const REPO_RULES_NOT_A_MISTAKE = 'Not a mistake? Name the file under rules.<id>.allow in the repo-rules settings, with the reason.';
const SLASH_FINDING = 'pariksha repo-rules: .github/workflows/ci.yml:3: actions-path-leading-slash: on.pull_request.paths pattern "/apps/**" starts with "/"';

/** A refused run: the findings, then each fired rule's lesson; the lesson is the rule module's, so only its id is pinned here. */
const assertRefused = (r: Ran, findings: readonly string[], rule: string): void => {
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, []);
  assert.deepEqual(r.err.slice(0, findings.length + 1), [...findings, '']);
  assert.equal(r.err.length, findings.length + 4);
  assert.ok(r.err[findings.length + 1]?.startsWith(`${rule}: `), r.err[findings.length + 1]);
  assert.deepEqual(r.err.slice(findings.length + 2), ['', REPO_RULES_NOT_A_MISTAKE]);
};

describe('run repo-rules', () => {
  it('exits 2 outside a git repository', () => {
    assert.deepEqual(cli(['repo-rules', '--root', NOWHERE]), { code: 2, out: [], err: [`pariksha repo-rules: ${NOWHERE} is not in a git repository; nothing was checked, so this is not a pass`] });
  });

  it('judges every tracked file by default, the allowed file left out', () => {
    const top = repoRulesFixture();
    assertRefused(cli(['repo-rules', '--root', top]), [SLASH_FINDING], 'actions-path-leading-slash');
    assert.deepEqual(cli(['repo-rules', '--root', top, '--config', 'allow.json']), { code: 0, out: ['pariksha repo-rules: 6 file(s), 16 rule(s), nothing refused'], err: [] });
  });

  it('judges every tracked file with --all, and removes nothing', () => {
    const top = repoRulesFixture();
    assert.deepEqual(cli(['repo-rules', '--root', top, '--all', '--config', 'allow.json']), { code: 0, out: ['pariksha repo-rules: 6 file(s), 16 rule(s), nothing refused'], err: [] });
  });

  it('reads a --files-from list relative to --root, naming files from the top level', () => {
    const top = repoRulesFixture();
    assertRefused(cli(['repo-rules', '--root', join(top, '.github'), '--files-from', '-'], { stdin: () => 'workflows/ci.yml\n' }), [SLASH_FINDING], 'actions-path-leading-slash');
    assert.deepEqual(cli(['repo-rules', '--root', top, '--files-from', '-'], { stdin: () => 'notes.md\n' }), { code: 0, out: ['pariksha repo-rules: 1 file(s), 16 rule(s), nothing refused'], err: [] });
  });

  it('refuses a stale allowance and settings it cannot read', () => {
    const top = repoRulesFixture();
    assert.deepEqual(cli(['repo-rules', '--root', top, '--config', 'stale.json']), {
      code: 1,
      out: [],
      err: ['pariksha repo-rules: rules.actions-path-leading-slash.allow["gone.yml"] names a file git does not track; drop the stale allowance'],
    });
    assert.deepEqual(cli(['repo-rules', '--root', top, '--config', 'bad.json']), {
      code: 2,
      out: [],
      err: [
        'pariksha repo-rules: unknown rule "nope"; the rules are actions-path-leading-slash, falsy-ternary-expression, job-level-if-not-step, job-timeout-minutes, pg-isready-over-socket, long-line-not-rgignored, raw-nul-in-source, codeql-suppression-comment-form, vitest4-inert-pool-config, eslint-ignores-worktrees, lockfile-single-doc-parse, pre-merge-commit-merge-head, mcp-matcher-server-id, rollup-state-gate, deleted-path-still-pinned, turbo-inputs-cover-reads; nothing was checked, so this is not a pass',
      ],
    });
  });

  it('judges the staged files with --staged, grepping the index for a staged deletion', () => {
    const top = repoRulesFixture();
    assertRefused(cli(['repo-rules', '--root', top, '--staged']), ['pariksha repo-rules: src/pin.test.ts:3: deleted-path-still-pinned: quotes src/kept.ts, which this change deletes or renames'], 'deleted-path-still-pinned');
  });

  it('judges a range with --base and --head, grepping the head commit for a rename', () => {
    const top = repoRulesFixture();
    assertRefused(cli(['repo-rules', '--root', top, '--base', 'main', '--head', 'work']), ['pariksha repo-rules: src/pin.test.ts:2: deleted-path-still-pinned: quotes src/old.ts, which this change deletes or renames'], 'deleted-path-still-pinned');
  });

  it('greps the working tree for a run of the whole tree', () => {
    // turbo.json in the run makes the workers rule grep for its callers; the
    // working tree holds one the index does not.
    const top = tree({ 'turbo.json': '{ "globalPassThroughEnv": ["OTHER"] }\n', 'scripts/x.sh': 'turbo run test\n' });
    writeFileSync(join(top, 'scripts/x.sh'), 'VITEST_MAX_WORKERS=2 turbo run test\n');
    const r = cli(['repo-rules', '--root', top]);
    assert.equal(r.code, 1);
    assert.equal(r.err[0], "pariksha repo-rules: scripts/x.sh:1: vitest4-inert-pool-config: hands VITEST_MAX_WORKERS to a turbo run, and turbo.json's globalPassThroughEnv does not list it, so turbo strips it");
  });
});

/** duplicate-tests and flaky-tests: a test body with enough matchers to compare. */
const testQualityOrder = (name: string): string => `describe('Orders', () => { it('${name}', () => { expect(a).toBe(1); expect(b).toEqual(2); expect(c).toMatch(/x/); }); });\n`;

/**
 * duplicate-tests' and flaky-tests' one repository, built on first use and
 * never changed after: two copies of a test committed, a third deleted from
 * the working tree, one untracked; both checks' settings files and a file
 * that is no test changed and staged. A stand-in `typescript` without the
 * compiler API sits in its node_modules, where the default loader looks first.
 */
let testQualityTop: string | undefined;
const testQualityFixture = (): string => {
  if (testQualityTop !== undefined) return testQualityTop;
  const root = temp('pariksha-cli-test-quality-');
  git(root, 'init', '-q', '-b', 'main');
  writeAll(root, {
    'a/x.test.ts': testQualityOrder('builds an order'),
    'b/y.spec.tsx': testQualityOrder('builds an order'),
    'gone.test.ts': testQualityOrder('cancels an order'),
    'readme.md': '# x\n',
    'cfg/dup.json': '{}\n',
    'cfg/flaky.json': '{}\n',
    'c.ts': '',
  });
  git(root, 'add', '-A');
  commitAll(root, 'base');
  rmSync(join(root, 'gone.test.ts'));
  writeAll(root, { 'cfg/dup.json': '{"threshold": 0.9}\n', 'cfg/flaky.json': '{"exclude": ["**/.tmp/**"]}\n', 'c.ts': 'export {};\n' });
  git(root, 'add', 'cfg', 'c.ts');
  writeAll(root, {
    'loose.test.ts': testQualityOrder('builds an order'),
    'cfg/bad-dup.json': '{"pairs": []}\n',
    'cfg/bad-flaky.json': '{"roots": []}\n',
    'cfg/every.json': '{"include": ""}\n',
    'node_modules/typescript/index.js': "module.exports = { version: 'fake' };\n",
  });
  testQualityTop = root;
  return root;
};

/** The real compiler API, loaded once. */
let testQualityTsLoaded: Ts | undefined;
const testQualityTs = (): Ts => {
  if (testQualityTsLoaded === undefined) {
    const ts = loadTypescript();
    if (typeof ts === 'string') throw new Error(ts);
    testQualityTsLoaded = ts;
  }
  return testQualityTsLoaded;
};

const DUPLICATE_REPORT = ['', '❌ Found potential duplicate tests:', '', '   100% Match:', '     A: a/x.test.ts:1 "builds an order"', '     B: b/y.spec.tsx:1 "builds an order"', '', 'Total potential duplicates: 1'];

describe('run duplicate-tests', () => {
  it('exits 2 outside a git repository', () => {
    assert.deepEqual(cli(['duplicate-tests', '--root', NOWHERE], { typescript: testQualityTs }), { code: 2, out: [], err: [`pariksha duplicate-tests: ${NOWHERE} is not in a git repository`] });
  });

  it('checks every tracked test file on disk by default, from the top level of the --root repository', () => {
    const top = testQualityFixture();
    assert.deepEqual(cli(['duplicate-tests', '--root', join(top, 'a')], { typescript: testQualityTs }), {
      code: 1,
      out: ['🔍 Searching for duplicate tests (Threshold: 0.85)...', '   Mode: all', '   Analyzing 2 files...', '   Extracted 2 test signatures.', ...DUPLICATE_REPORT],
      err: [],
    });
  });

  it('checks every tracked test file with --all, with the --config settings', () => {
    const top = testQualityFixture();
    assert.deepEqual(cli(['duplicate-tests', '--root', top, '--all', '--config', 'cfg/dup.json'], { typescript: testQualityTs }), {
      code: 1,
      out: ['🔍 Searching for duplicate tests (Threshold: 0.9)...', '   Mode: all', '   Analyzing 2 files...', '   Extracted 2 test signatures.', ...DUPLICATE_REPORT],
      err: [],
    });
  });

  it('never widens --staged to every file when its settings change', () => {
    const top = testQualityFixture();
    assert.deepEqual(cli(['duplicate-tests', '--root', top, '--staged', '--config', 'cfg/dup.json'], { typescript: testQualityTs }), {
      code: 0,
      out: ['🔍 Searching for duplicate tests (Threshold: 0.9)...', '   Mode: files', 'No files found to analyze.'],
      err: [],
    });
  });

  it('reads a --files-from list, absolute or relative, and warns of a listed file it cannot read', () => {
    const top = testQualityFixture();
    const missing = join(top, 'a/missing.test.ts');
    assert.deepEqual(cli(['duplicate-tests', '--root', top, '--files-from', '-'], { typescript: testQualityTs, stdin: () => `${join(top, 'a/x.test.ts')}\nb/y.spec.tsx\nreadme.md\na/missing.test.ts\n` }), {
      code: 1,
      out: ['🔍 Searching for duplicate tests (Threshold: 0.85)...', '   Mode: files', '   Analyzing 3 files...', '   Extracted 2 test signatures.', ...DUPLICATE_REPORT],
      err: [`⚠️  Failed to parse ${missing}: ENOENT: no such file or directory, open '${missing}'`],
    });
  });

  it('exits 2 when TypeScript cannot be had, from the caller or the repository', () => {
    const top = testQualityFixture();
    assert.deepEqual(cli(['duplicate-tests', '--root', top], { typescript: () => 'no compiler here' }), { code: 2, out: [], err: ['pariksha duplicate-tests: no compiler here'] });
    assert.deepEqual(cli(['duplicate-tests', '--root', top]), {
      code: 2,
      out: [],
      err: ['pariksha duplicate-tests: needs the TypeScript compiler API, which typescript fake does not export; install typescript >=5.4 <6'],
    });
  });

  it('exits 2 on settings it cannot read', () => {
    const top = testQualityFixture();
    assert.deepEqual(cli(['duplicate-tests', '--root', top, '--config', 'cfg/bad-dup.json'], { typescript: testQualityTs }), {
      code: 2,
      out: [],
      err: ['pariksha duplicate-tests: the config has unknown field(s): pairs; nothing was checked, so this is not a pass'],
    });
  });
});

/** A Vitest that is never to run. */
const flakyNoVitest: VitestRunner = () => {
  throw new Error('this test runs no vitest');
};

/** A Vitest whose every listed file passes, recording each call's arguments and directory. */
const flakyPassing = (): { calls: Array<[readonly string[], string]>; vitest: VitestRunner } => {
  const calls: Array<[readonly string[], string]> = [];
  const vitest = (args: readonly string[], cwd: string): SpawnOutcome => {
    calls.push([args, cwd]);
    const files = args.slice(3).filter((a) => !a.startsWith('--') && !a.startsWith('**'));
    return {
      status: 0,
      stdout: JSON.stringify({
        numTotalTests: files.length,
        numPassedTests: files.length,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        success: true,
        testResults: files.map((name) => ({ name, status: 'passed', message: '', assertionResults: [{ title: 'ok', fullName: 'ok', status: 'passed', failureMessages: [] }] })),
      }),
      stderr: '',
    };
  };
  return { calls, vitest };
};

describe('run flaky-tests', () => {
  // `npx` on PATH is a stand-in that fails at once, so the default runner
  // never reaches a real Vitest.
  let flakyPath: string | undefined;
  before(() => {
    const bin = temp('pariksha-cli-flaky-bin-');
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\necho "stand-in npx: $*" >&2\nexit 3\n');
    chmodSync(join(bin, 'npx'), 0o755);
    flakyPath = process.env['PATH'];
    process.env['PATH'] = `${bin}:${flakyPath ?? ''}`;
  });
  after(() => {
    process.env['PATH'] = flakyPath;
  });

  it('refuses a run count out of range before reading the repository', () => {
    assert.deepEqual(cli(['flaky-tests', '--runs', '0', '--root', NOWHERE], { vitest: flakyNoVitest }), { code: 2, out: [], err: ['--runs must be an integer from 1 to 1000'] });
  });

  it('exits 2 outside a git repository', () => {
    assert.deepEqual(cli(['flaky-tests', '--root', NOWHERE], { vitest: flakyNoVitest }), { code: 2, out: [], err: [`pariksha flaky-tests: ${NOWHERE} is not in a git repository`] });
  });

  it('exits 2 on settings it cannot read', () => {
    const top = testQualityFixture();
    assert.deepEqual(cli(['flaky-tests', '--root', top, '--config', 'cfg/bad-flaky.json'], { vitest: flakyNoVitest }), {
      code: 2,
      out: [],
      err: ['pariksha flaky-tests: the config has unknown field(s): roots; nothing was checked, so this is not a pass'],
    });
  });

  it('runs every tracked file on disk the include takes, five times by default, from the top level', () => {
    const top = testQualityFixture();
    const v = flakyPassing();
    const r = cli(['flaky-tests', '--root', join(top, 'a'), '--config', 'cfg/every.json'], { vitest: v.vitest });
    assert.deepEqual(r.err, []);
    assert.deepEqual(r.out.slice(0, 8), ['🔄 Detecting flaky tests (5 runs)...', '   Mode: all', '   Running on 6 files...', '   Run 1/5: ✅ Passed', '   Run 2/5: ✅ Passed', '   Run 3/5: ✅ Passed', '   Run 4/5: ✅ Passed', '   Run 5/5: ✅ Passed']);
    assert.equal(r.code, 0);
    assert.equal(v.calls.length, 5);
    assert.deepEqual(v.calls[0], [['run', '--reporter=json', '--passWithNoTests', 'a/x.test.ts', 'b/y.spec.tsx', 'c.ts', 'cfg/dup.json', 'cfg/flaky.json', 'readme.md'], top]);
  });

  it('runs every tracked test file with --all, --runs times, with the --config settings', () => {
    const top = testQualityFixture();
    const v = flakyPassing();
    const r = cli(['flaky-tests', '--root', top, '--all', '--runs', '1', '--config', 'cfg/flaky.json'], { vitest: v.vitest });
    assert.deepEqual(r.out.slice(0, 4), ['🔄 Detecting flaky tests (1 runs)...', '   Mode: all', '   Running on 2 files...', '   Run 1/1: ✅ Passed']);
    assert.equal(r.code, 0);
    assert.deepEqual(v.calls, [[['run', '--reporter=json', '--passWithNoTests', '--exclude', '**/.tmp/**', 'a/x.test.ts', 'b/y.spec.tsx'], top]]);
  });

  it('reads a --files-from list, and never widens --staged when its settings change', () => {
    const top = testQualityFixture();
    const v = flakyPassing();
    const listed = cli(['flaky-tests', '--root', top, '--files-from', '-', '--runs', '2'], { vitest: v.vitest, stdin: () => `${join(top, 'a/x.test.ts')}\nreadme.md\n` });
    assert.deepEqual(listed.out.slice(0, 5), ['🔄 Detecting flaky tests (2 runs)...', '   Mode: files', '   Running on 1 files...', '   Run 1/2: ✅ Passed', '   Run 2/2: ✅ Passed']);
    assert.equal(listed.code, 0);
    assert.deepEqual(v.calls, [
      [['run', '--reporter=json', '--passWithNoTests', 'a/x.test.ts'], top],
      [['run', '--reporter=json', '--passWithNoTests', 'a/x.test.ts'], top],
    ]);
    assert.deepEqual(cli(['flaky-tests', '--root', top, '--staged', '--config', 'cfg/flaky.json'], { vitest: flakyNoVitest }), {
      code: 0,
      out: ['🔄 Detecting flaky tests (5 runs)...', '   Mode: files', 'No files found to analyze.'],
      err: [],
    });
  });

  it('runs npx vitest by default', () => {
    const top = testQualityFixture();
    const r = cli(['flaky-tests', '--root', top, '--files-from', '-', '--runs', '1'], { stdin: () => 'a/x.test.ts\n' });
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, []);
    assert.deepEqual(r.out.slice(0, 4), ['🔄 Detecting flaky tests (1 runs)...', '   Mode: files', '   Running on 1 files...', '   Run 1/1: ❌ Failed']);
    assert.equal(r.out.at(-1), '[.] vitest exited with status 3\nstand-in npx: vitest run --reporter=json --passWithNoTests a/x.test.ts\n');
  });
});

// ── w2: shared by w2's commands ─────────────────────────────────────────────

/** TypeScript, loaded once for the file; the checks that parse code get it through `Io`. */
const W2_TS = ((): Ts => {
  const loaded = loadTypescript();
  if (typeof loaded === 'string') throw new Error(loaded);
  return loaded;
})();
const w2Ts: Partial<Io> = { typescript: () => W2_TS };

/** git with an identity, for the fixtures that commit. */
const w2Commit = (root: string, message: string): void => {
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
};

/** Write these files under `root`. */
const w2Put = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
};

/** A value computed once, on first use. */
const w2Once = <T>(make: () => T): (() => T) => {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
};

// ── required-settings ───────────────────────────────────────────────────────

describe('run required-settings', () => {
  const P = 'pariksha required-settings:';
  const root = tree(
    {
      'req.json': JSON.stringify({ advisorModel: { value: 'fable', why: 'the advisor reviews' } }),
      'empty-req.json': '{}',
      '.claude/settings.json': JSON.stringify({ advisorModel: 'fable' }),
      'other.json': JSON.stringify({ model: 'opus' }),
      'list.json': '[]',
    },
    false,
  );

  it('refuses a run without --require as a usage error', () => {
    assertUsage(cli(['required-settings', '--root', root]));
  });

  it('exits 2 on requirements it cannot read, naming the file by its path under the root', () => {
    const r = cli(['required-settings', '--require', 'nope.json', '--root', root]);
    assert.equal(r.code, 2);
    assert.deepEqual(r.err, [`${P} cannot read the requirements ${root}/nope.json; nothing was checked, so this is not a pass`]);
    assert.deepEqual(r.out, []);
  });

  it('exits 2 on requirements that list no key, naming the file as given', () => {
    const r = cli(['required-settings', '--require', 'empty-req.json', '--root', root]);
    assert.equal(r.code, 2);
    assert.deepEqual(r.err, [`${P} empty-req.json: the requirements list no key; nothing was checked, so this is not a pass`]);
  });

  it('passes settings that carry every requirement, reading .claude/settings.json by default', () => {
    const r = cli(['required-settings', '--require', 'req.json', '--root', root]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, [`${P} .claude/settings.json carries all 1 required settings (req.json)`]);
    assert.deepEqual(r.err, []);
  });

  it('exits 1 on settings that lack a requirement, naming the --settings file', () => {
    const r = cli(['required-settings', '--require', 'req.json', '--settings', 'other.json', '--root', root]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, [`${P} other.json: "advisorModel" is missing; it must be "fable" (the advisor reviews). Put it back; to change the requirement, edit req.json.`]);
    assert.deepEqual(r.out, []);
  });

  it('exits 1 on settings it cannot read, and on settings that are not an object', () => {
    const gone = cli(['required-settings', '--require', 'req.json', '--settings', 'gone.json', '--root', root]);
    assert.equal(gone.code, 1);
    assert.deepEqual(gone.err, [`${P} cannot read the settings ${root}/gone.json; nothing was checked, so this is not a pass`]);
    const list = cli(['required-settings', '--require', 'req.json', '--settings', 'list.json', '--root', root]);
    assert.equal(list.code, 1);
    assert.deepEqual(list.err, [`${P} list.json: the settings must hold an object`]);
    assert.deepEqual(list.out, []);
  });
});

// ── enforcement-claims ──────────────────────────────────────────────────────

describe('run enforcement-claims', () => {
  const P = 'pariksha enforcement-claims:';
  const CONFIG = {
    standards: 'docs/standards',
    workspaces: [{ dir: '.', probes: ['scripts/probe.ts'] }],
    dispatcher: { path: 'scripts/run-validation.sh' },
    packageRunner: null,
    stageRoots: { hooks: ['.husky'], workflows: ['.github/workflows'], actions: ['.github/actions'] },
    runnable: { prefixes: ['scripts/'], extensions: ['sh', 'ts'], bin: 'node_modules/.bin' },
    workspaceList: { pnpm: 'pnpm-workspace.yaml', turbo: 'turbo.json' },
    tests: { file: '\\.test\\.tsx?$', runner: '\\bvitest\\b|\\s--test\\b' },
  };
  const standard = (...lines: string[]): string => `---\n${lines.join('\n')}\n---\n`;
  const root = tree(
    {
      'claims.json': JSON.stringify(CONFIG),
      'named.json': JSON.stringify({ ...CONFIG, id: 'STD-1' }),
      'unknown.json': JSON.stringify({ ...CONFIG, extra: true }),
      'nostandards.json': JSON.stringify({ ...CONFIG, standards: 'docs/none' }),
      'untrue.json': JSON.stringify({ ...CONFIG, standards: 'docs/untrue' }),
      'scripts/run-validation.sh': 'case "$1" in\n  probe)\n    bash scripts/probe-check.sh\n    ;;\nesac\n',
      'scripts/probe-check.sh': 'exit 0\n',
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'turbo.json': '{}\n',
      '.husky/pre-commit': 'bash scripts/run-validation.sh probe\n',
      'docs/standards/a.md': standard('id: BP-1', 'enforcement: eslint-rule', 'enforcement_config: no-console'),
      'docs/untrue/a.md': standard('id: BP-2', 'enforcement: guidance', 'partial_gates: Reviewer eyeballs it'),
    },
    false,
  );
  /** An ESLint whose every config turns `no-console` on. */
  const Eslint = class {
    calculateConfigForFile(): Promise<unknown> {
      return Promise.resolve({ rules: { 'no-console': 'error' } });
    }
  };
  const eslint: Partial<Io> = { eslint: () => Promise.resolve(Eslint) };

  it('refuses a run without --config as a usage error', async () => {
    assertUsage(await cliAsync(['enforcement-claims', '--root', root]));
  });

  it('exits 2 on a config it cannot read or parse, before loading ESLint', async () => {
    const missing = await cliAsync(['enforcement-claims', '--config', 'absent.json', '--root', root], eslint);
    assert.equal(missing.code, 2);
    assert.deepEqual(missing.err, [`${P} ENOENT: no such file or directory, open '${root}/absent.json'; nothing was checked, so this is not a pass`]);
    const unknown = await cliAsync(['enforcement-claims', '--config', 'unknown.json', '--root', root], eslint);
    assert.deepEqual(unknown.err, [`${P} unknown key "extra"; nothing was checked, so this is not a pass`]);
  });

  it('exits 2 without ESLint, naming the peer under the configured id', async () => {
    const r = await cliAsync(['enforcement-claims', '--config', 'named.json', '--root', root], { eslint: () => Promise.resolve('needs the eslint package') });
    assert.deepEqual(r, { code: 2, out: [], err: ['pariksha enforcement-claims (STD-1): needs the eslint package'] });
  });

  it('passes true claims, counting them', async () => {
    const r = await cliAsync(['enforcement-claims', '--config', 'claims.json', '--root', root], eslint);
    assert.deepEqual(r, { code: 0, out: [`${P} every eslint-rule claim is real and every validator claim runs at a stage (1 + 0 of 1 rule(s))`], err: [] });
  });

  it('exits 1 on an untrue claim, naming it', async () => {
    const r = await cliAsync(['enforcement-claims', '--config', 'untrue.json', '--root', root], eslint);
    assert.deepEqual(r, {
      code: 1,
      out: [],
      err: [
        `${P} docs/untrue/a.md (BP-2): \`Reviewer eyeballs it\` (partial_gates) names no rule this gate can adjudicate — a partial gate that cannot be checked is not a gate`,
        `${P} 1 untrue enforcement claim(s); a standard whose enforcement is described wrongly reads as enforced while nothing runs`,
      ],
    });
  });
});

// ── regression-controls ─────────────────────────────────────────────────────

describe('run regression-controls', () => {
  const P = 'pariksha regression-controls:';
  const CONTROL = 'scripts/cleanup.test.ts';
  const FIXED = 'fixed: the same kind of path is refused';
  const controlSource = (fixed: string): string =>
    [
      "import { it } from 'vitest';",
      "it('bad: the old removal deletes outside the temp folder', () => {});",
      `it('${fixed}', () => {});`,
      "it('near miss: an owned temp root is removed', () => {});",
      "it('guard flip: without the check the fixed case is deleted', () => {});",
      '',
    ].join('\n');
  const registry = (fixed = FIXED): string =>
    JSON.stringify({
      gates: null,
      requiredFindings: null,
      controls: [
        {
          id: 'fixture-root',
          finding: 'F-3',
          family: 'fixture',
          file: CONTROL,
          gate: 'tooling',
          guard: 'isOwned in scripts/cleanup.ts',
          cases: { bad: 'bad: the old removal deletes outside the temp folder', fixed, nearMiss: 'near miss: an owned temp root is removed', guardFlip: 'guard flip: without the check the fixed case is deleted' },
        },
      ],
    });
  const WHOLE = [`${P} 1 control(s) whole`, `${P} not checked: gates, requiredFindings`];
  const STAGED = [`${P} 1 control(s) whole (staged)`, `${P} not checked: gates, requiredFindings`];
  const missingFixed = (shown: string): string[] => [
    `${P} fixture-root (F-3): fixed case "renamed" is not a case in ${CONTROL}`,
    `${P} 1 problem(s). Each control's bad, fixed, near-miss and guard-flip tests prove its fix still bites; keep the titles in ${shown} in step with the tests.`,
  ];
  const GUARDED = { [CONTROL]: controlSource(FIXED), 'scripts/cleanup.ts': 'export const isOwned = () => true;\n' };
  const plain = tree({ ...GUARDED, 'reg.json': registry(), 'renamed.json': registry('renamed'), 'bad.json': '{"gates":null,"requiredFindings":null,"controls":[{}]}' }, false);

  /**
   * A repository whose index holds whole registries that the disk has
   * broken, at the top and below `sub/`, a registry only the disk holds, and
   * a staged file named as an inline entry's label, holding a broken one.
   */
  const staged = w2Once(() => {
    const top = repo({
      ...GUARDED,
      ...Object.fromEntries(Object.entries(GUARDED).map(([path, body]) => [`sub/${path}`, body])),
      'config/reg.json': registry(),
      '.pariksha.json (checks.regression-controls)': registry('renamed'),
    });
    w2Put(top, { 'config/reg.json': registry('renamed'), 'untracked.json': registry() });
    return top;
  });

  it('refuses a run without --config as a usage error', () => {
    assertUsage(cli(['regression-controls', '--root', plain]));
  });

  it('exits 2 without typescript, before reading the registry', () => {
    const r = cli(['regression-controls', '--config', 'gone.json', '--root', plain], { typescript: () => 'needs the typescript package' });
    assert.deepEqual(r, { code: 2, out: [], err: [`${P} needs the typescript package`] });
  });

  it('reports the working tree whole, loading typescript itself when none is given', () => {
    const r = cli(['regression-controls', '--config', 'reg.json', '--root', plain]);
    assert.deepEqual(r, { code: 0, out: WHOLE, err: [] });
  });

  it('exits 1 on a renamed case, naming the registry as --config gives it', () => {
    const r = cli(['regression-controls', '--config', 'renamed.json', '--root', plain], w2Ts);
    assert.deepEqual(r, { code: 1, out: [`${P} not checked: gates, requiredFindings`], err: missingFixed('renamed.json') });
  });

  it('exits 2 on a malformed or missing registry', () => {
    const bad = cli(['regression-controls', '--config', 'bad.json', '--root', plain], w2Ts);
    assert.deepEqual(bad, { code: 2, out: [], err: [`${P} bad.json: controls[0]: "id" must be a non-empty string; nothing was checked, so this is not a pass`] });
    const gone = cli(['regression-controls', '--config', 'gone.json', '--root', plain], w2Ts);
    assert.deepEqual(gone, { code: 2, out: [], err: [`${P} ENOENT: no such file or directory, open '${plain}/gone.json'; nothing was checked, so this is not a pass`] });
  });

  it('exits 2 on --staged outside a git repository', () => {
    const r = cli(['regression-controls', '--config', 'reg.json', '--staged', '--root', plain], w2Ts);
    assert.deepEqual(r, { code: 2, out: [], err: [`${P} ${plain} is not in a git repository, so --staged has no index to read; nothing was checked, so this is not a pass`] });
  });

  it('with --staged reads the registry the index holds, in a folder too', () => {
    const r = cli(['regression-controls', '--config', 'config/reg.json', '--staged', '--root', staged()], w2Ts);
    assert.deepEqual(r, { code: 0, out: STAGED, err: [] });
    const tree = cli(['regression-controls', '--config', 'config/reg.json', '--root', staged()], w2Ts);
    assert.deepEqual(tree, { code: 1, out: [`${P} not checked: gates, requiredFindings`], err: missingFixed('config/reg.json') });
  });

  it('with --staged reads a registry the index lacks, or one outside the root, from the disk', () => {
    const untracked = cli(['regression-controls', '--config', 'untracked.json', '--staged', '--root', staged()], w2Ts);
    assert.deepEqual(untracked, { code: 0, out: STAGED, err: [] });
    const outside = cli(['regression-controls', '--config', '../config/reg.json', '--staged', '--root', join(staged(), 'sub')], w2Ts);
    assert.deepEqual(outside, { code: 1, out: [`${P} not checked: gates, requiredFindings`], err: missingFixed('../config/reg.json') });
  });

  it('with --staged reads an inline entry as given, never a staged file named as its label', () => {
    const project = join(temp(), '.pariksha.json');
    writeFileSync(project, JSON.stringify({ checks: { 'regression-controls': JSON.parse(registry()) as unknown } }));
    const r = cli(['regression-controls', '--staged', '--root', staged()], w2Ts, { PARIKSHA_CONFIG: project });
    assert.deepEqual(r, { code: 0, out: STAGED, err: [] });
  });

  it('with --staged refuses a registry that is nowhere, naming the file it looked for', () => {
    const r = cli(['regression-controls', '--config', 'absent.json', '--staged', '--root', staged()], w2Ts);
    assert.equal(r.code, 2);
    assert.match(r.err[0] ?? '', /^pariksha regression-controls: ENOENT: no such file or directory, open '.*absent\.json'; nothing was checked, so this is not a pass$/);
  });
});

// ── authority-citations ─────────────────────────────────────────────────────

describe('run authority-citations', () => {
  const P = 'pariksha authority-citations:';
  /** The guidance after the claims, for an ADR folder and an issue prefix. */
  const guidance = (adrDir: string, prefix?: string): string[] => [
    '',
    'An authority claim must anchor in something only that authority can produce. Cite one of:',
    '  a commit id                       (owner decision, f1a0da2d)',
    `  an existing ADR                   ADR-0040, in ${adrDir}/`,
    ...(prefix === undefined ? [] : [`  an issue id                       ${prefix}-447`]),
    '  a GitHub pull request or issue    PR #269, or its full URL',
    'A comment or a document an agent could have written is not a citation, and neither',
    'is an answer in a chat: ask the authority to say it in a comment on the pull request',
    "(or issue), then cite that comment's URL. If no such artifact exists, the decision",
    'has not been made. Do not reword the claim to get past this check. Only for words',
    'that are no authority claim at all, add',
    '  ALLOW-AUTHORITY-PHRASE: <reason>',
    '',
  ];
  const COMMITTED = 'Prices round down, per the founder (ADR-0001).';
  const STAGED = 'Releases are approved by Lee.';
  /** A commit holding a claim that cites an ADR only `decisions/` has; staged, a claim naming Lee and words that name no one. */
  const citations = w2Once(() => {
    const root = temp();
    git(root, 'init', '-q');
    w2Put(root, { 'a.md': `${COMMITTED}\n`, 'decisions/0001-rounding.md': '# Rounding\n' });
    git(root, 'add', '-A');
    w2Commit(root, 'base');
    w2Put(root, { 'b.md': `${STAGED}\n\n\n\n\n\n\nDeploys are approved by the build.\n` });
    git(root, 'add', 'b.md');
    return root;
  });

  it('refuses a mode other than staged or tree as a usage error', () => {
    assertUsage(cli(['authority-citations', '--mode', 'all', '--root', NOWHERE]));
  });

  it('exits 2 outside a git repository', () => {
    const r = cli(['authority-citations', '--root', NOWHERE]);
    assert.deepEqual(r, { code: 2, out: [], err: [`${P} ${NOWHERE} is not in a git repository`] });
  });

  it('judges the staged change by default, with each listed authority and issue prefix trimmed and empty entries dropped', () => {
    const r = cli(['authority-citations', '--authority', 'Dana, Lee,', '--issue-prefix', ',ABC', '--root', citations()]);
    assert.deepEqual(r, {
      code: 1,
      out: [],
      err: [`${P} uncited authority claim(s) in b.md:`, `  1: [approved by Lee] ${STAGED}`, ...guidance('docs/adr', 'ABC'), '1 claim(s) across 1 file(s).'],
    });
  });

  it('judges every tracked file with --mode tree, citing ADRs under docs/adr by default', () => {
    const r = cli(['authority-citations', '--mode', 'tree', '--root', citations()]);
    assert.deepEqual(r, {
      code: 1,
      out: [],
      err: [`${P} uncited authority claim(s) in a.md:`, `  1: [per the founder] ${COMMITTED}`, ...guidance('docs/adr'), '1 claim(s) across 1 file(s).'],
    });
  });

  it('reads ADRs from --adr-dir', () => {
    const r = cli(['authority-citations', '--mode', 'tree', '--adr-dir', 'decisions', '--root', citations()]);
    assert.deepEqual(r, { code: 0, out: [`${P} every authority claim cites an anchor`], err: [] });
  });

  it('exits 2 when the check cannot read what it must', () => {
    const r = cli(['authority-citations', '--mode', 'tree', '--adr-dir', 'a.md', '--root', citations()]);
    assert.deepEqual(r, { code: 2, out: [], err: [`${P} ENOTDIR: not a directory, scandir '${citations()}/a.md'; nothing was checked, so this is not a pass`] });
  });
});

// ── codec-registry and fault-injection-registry ─────────────────────────────

const ratchetSuite = "import { F } from './md.ts';\nimport fc from 'fast-check';\nimport { fromMarkdown } from 'mdast-util-from-markdown';\nconst opts = { seed: SEED };\nfor (const eol of LINE_ENDINGS) {}\n";
const ratchetCodec = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    baseline: 'codec.baseline.json',
    roots: ['scripts'],
    oracles: { markdown: 'mdast-util-from-markdown', yaml: 'js-yaml' },
    collected: ['^scripts/.+\\.test\\.ts$'],
    surfaces: null,
    markers: { seed: 'seed: SEED', lineEndings: 'LINE_ENDINGS', golden: 'assertGolden' },
    handParsers: [{ source: 'scripts/md.ts', formats: ['markdown'], suite: 'scripts/md.differential.properties.test.ts', outOfModel: 'lists' }],
    pairs: [{ id: 'scripts/row.ts#writeRow->readRow', kind: 'round-trip', suite: 'scripts/row.roundtrip.properties.test.ts' }],
    exempt: [],
    minNoteLength: 1,
    examples: null,
    findingIds: null,
    ...over,
  });
const ratchetEntry = 'export async function main() {}\nif (process.argv[1] === import.meta.filename) await main();\n';
const ratchetFault = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    baseline: 'fault.baseline.json',
    discover: {
      cli: { roots: ['bin', 'tools/run.ts'], include: '\\.ts$', marker: { pattern: 'process\\.argv\\b' } },
      server: { roots: ['server'], include: '\\.ts$', marker: { pattern: 'best[- ]effort', flags: 'i' } },
    },
    collected: ['^bin/.+\\.test\\.ts$'],
    harness: { module: 'packages/h/index.ts', checks: { 'ERR-09': 'checkExitContract' }, heldBy: 'assertNoViolations' },
    consumers: [{ source: 'bin/tool.ts', unit: 'main', checks: ['ERR-09'], test: 'bin/tool.faults.test.ts' }],
    exempt: [],
    exemptIn: ['cli'],
    minNoteLength: 21,
    examples: null,
    findingIds: null,
    ...over,
  });
/** What both ratchets read, as committed. */
const RATCHET_FILES: Record<string, string> = {
  'scripts/md.ts': 'export const F = /^```/;\n',
  'scripts/md.differential.properties.test.ts': ratchetSuite,
  'scripts/row.ts': 'export function writeRow() {}\nexport function readRow() {}\n',
  'scripts/row.roundtrip.properties.test.ts': "import { writeRow, readRow } from './row.ts';\nimport fc from 'fast-check';\nconst opts = { seed: SEED };\n",
  'scripts/old.ts': "export const D = '---';\n",
  'parsers/md.ts': 'export const F = /^```/;\n',
  'plain/plain.ts': 'export const x = 1;\n',
  // At the merge base the codec baseline holds a list since retired; the head copy, below, does not.
  'codec.baseline.json': '{"handParsers":["scripts/old.ts#yaml"],"pairs":[],"retired":[]}\n',
  'grown.baseline.json': '{"handParsers":[],"pairs":[]}\n',
  'packages/h/index.ts': "export { assertNoViolations, checkExitContract } from './checks';\n",
  'packages/h/checks.ts': 'export function assertNoViolations() {}\nexport async function checkExitContract() {}\n',
  'bin/tool.ts': ratchetEntry,
  'bin/tool.faults.test.ts': "import { checkExitContract, assertNoViolations } from '../packages/h/index.ts';\nimport { main } from './tool.ts';\nassertNoViolations(checkExitContract(main));\n",
  // A root that is a file, and best-effort words no group but cli reads.
  'tools/run.ts': `${ratchetEntry}// best effort\n`,
  'server/a.service.ts': '// best-effort: logged, never thrown\n',
  'fault.baseline.json': '{"cli":["tools/run.ts"],"server":["server/a.service.ts"]}\n',
};
/** The configs and head baselines, read from the disk only. */
const RATCHET_DISK: Record<string, string> = {
  'codec.baseline.json': '{"handParsers":["scripts/old.ts#yaml"],"pairs":[]}\n',
  'grown.baseline.json': '{"handParsers":["scripts/old.ts#yaml"],"pairs":[]}\n',
  'extra.baseline.json': '{"handParsers":["scripts/old.ts#yaml"],"pairs":[],"retired":[]}\n',
  'codec.json': ratchetCodec(),
  'codec-grown.json': ratchetCodec({ baseline: 'grown.baseline.json' }),
  'codec-extra.json': ratchetCodec({ baseline: 'extra.baseline.json' }),
  'codec-unknown.json': ratchetCodec({ registry: [] }),
  'codec-typo.json': ratchetCodec({ roots: ['scripts', 'nope', 'gone'] }),
  'codec-plain.json': ratchetCodec({ roots: ['plain'] }),
  'codec-parsers.json': ratchetCodec({ roots: ['parsers', 'plain'] }),
  'fault.json': ratchetFault(),
  'fault-typo.json': ratchetFault({ discover: { cli: { roots: ['bin'], include: '\\.ts$', marker: { pattern: 'process\\.argv\\b' } }, server: { roots: ['server', 'nope'], include: '\\.ts$', marker: { pattern: 'best[- ]effort' } } } }),
  'fault-plain.json': ratchetFault({ discover: { cli: { roots: ['bin'], include: '\\.ts$', marker: { pattern: 'process\\.argv\\b' } }, server: { roots: ['plain', 'parsers'], include: '\\.ts$', marker: { pattern: 'best[- ]effort' } } } }),
};
/** One repository both ratchets read: `main` holds RATCHET_FILES, the disk RATCHET_DISK over them. */
const ratchetRepo = w2Once(() => {
  const root = temp();
  git(root, 'init', '-q', '-b', 'main');
  w2Put(root, RATCHET_FILES);
  git(root, 'add', '-A');
  w2Commit(root, 'base');
  // The first base candidate, so a run asks git for one ref, not four.
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  w2Put(root, RATCHET_DISK);
  return root;
});
/** The same files staged in a repository with no commit, so no base candidate names one. */
const ratchetUncommitted = w2Once(() => {
  const root = repo(RATCHET_FILES);
  w2Put(root, RATCHET_DISK);
  return root;
});

describe('run codec-registry', () => {
  const P = 'pariksha codec-registry:';
  const codec = (config: string, extra: readonly string[] = [], over: Partial<Io> = w2Ts, root = ratchetRepo()): Ran => cli(['codec-registry', '--config', config, '--root', root, ...extra], over);
  const NOT_PASS = '; nothing was checked, so this is not a pass';

  it('refuses a run without --config, or with --no-base and --base, as a usage error', () => {
    assertUsage(cli(['codec-registry', '--root', NOWHERE]));
    assertUsage(cli(['codec-registry', '--config', 'codec.json', '--no-base', '--base', 'main', '--root', NOWHERE]));
  });

  it('exits 2 outside a git repository', () => {
    const r = cli(['codec-registry', '--config', 'codec.json', '--root', NOWHERE]);
    assert.deepEqual(r, { code: 2, out: [], err: [`${P} ${NOWHERE} is not in a git repository`] });
  });

  it('exits 2 on a bad config, a head baseline with an unknown list and roots holding no tracked file', () => {
    assert.deepEqual(codec('codec-unknown.json'), { code: 2, out: [], err: [`${P} unknown key "registry"${NOT_PASS}`] });
    assert.deepEqual(codec('codec-extra.json'), { code: 2, out: [], err: [`${P} extra.baseline.json: unknown list "retired"${NOT_PASS}`] });
    assert.deepEqual(codec('codec-typo.json'), { code: 2, out: [], err: [`${P} no tracked file lies under nope, gone, so discovery there would read nothing${NOT_PASS}`] });
  });

  it('exits 2 when discovery finds nothing of a kind, naming the kind and its roots', () => {
    assert.deepEqual(codec('codec-plain.json'), { code: 2, out: [], err: [`${P} discovery finds no hand parser under plain, so nothing of that kind would be checked${NOT_PASS}`] });
    assert.deepEqual(codec('codec-parsers.json'), { code: 2, out: [], err: [`${P} discovery finds no producer/consumer pair under parsers, plain, so nothing of that kind would be checked${NOT_PASS}`] });
  });

  it('exits 2 without typescript, with the loader’s message alone', () => {
    assert.deepEqual(codec('codec.json', [], { typescript: () => 'needs the typescript package' }), { code: 2, out: [], err: [`${P} needs the typescript package`] });
  });

  it('with --no-base passes without comparing growth, and says so', () => {
    assert.deepEqual(codec('codec-grown.json', ['--no-base']), {
      code: 0,
      out: [`${P} 2 hand parser(s) and 1 pair(s) discovered, each registered, exempt or among the 1 baselined`, `${P} not checked: surfaces, examples, findingIds, baseline growth (--no-base)`],
      err: [],
    });
  });

  it('passes against the merge base with the first candidate, reading its baseline against today’s lists, loading typescript itself', () => {
    assert.deepEqual(codec('codec.json', [], {}), {
      code: 0,
      out: [`${P} 2 hand parser(s) and 1 pair(s) discovered, each registered, exempt or among the 1 baselined; the baseline does not grow`, `${P} not checked: surfaces, examples, findingIds`],
      err: [],
    });
  });

  it('exits 1 on a baseline grown since the merge base with --base', () => {
    const r = codec('codec-grown.json', ['--base', 'HEAD']);
    assert.equal(r.code, 1);
    assert.deepEqual(r.out, [`${P} not checked: surfaces, examples, findingIds`]);
    assert.equal(r.err[0], `${P} scripts/old.ts#yaml: added to grown.baseline.json since the merge base; the baseline only shrinks, so register a suite instead`);
  });

  it('exits 2 when --base names no commit, or no candidate does', () => {
    assert.deepEqual(codec('codec.json', ['--base', 'no-such-ref']), { code: 2, out: [], err: [`${P} --base no-such-ref names no commit${NOT_PASS}`] });
    assert.deepEqual(codec('codec.json', [], w2Ts, ratchetUncommitted()), {
      code: 2,
      out: [],
      err: [`${P} none of origin/main, origin/develop, origin/master, main names a commit, so the baseline cannot be held to its merge base; fetch one, pass --base, or pass --no-base${NOT_PASS}`],
    });
  });
});

describe('run fault-injection-registry', () => {
  const P = 'pariksha fault-injection-registry:';
  const fault = (config: string, extra: readonly string[] = []): Ran => cli(['fault-injection-registry', '--config', config, '--root', ratchetRepo(), ...extra], w2Ts);

  it('refuses a run without --config as a usage error', () => {
    assertUsage(cli(['fault-injection-registry', '--root', NOWHERE]));
  });

  it('exits 2 when a group’s root holds no tracked file', () => {
    assert.deepEqual(fault('fault-typo.json', ['--no-base']), {
      code: 2,
      out: [],
      err: [`${P} no tracked file lies under nope, so discovery there would read nothing; nothing was checked, so this is not a pass`],
    });
  });

  it('exits 2 when a group discovers nothing, naming the group and its roots', () => {
    assert.deepEqual(fault('fault-plain.json', ['--no-base']), {
      code: 2,
      out: [],
      err: [`${P} discovery finds no server source under plain, parsers, so nothing of that kind would be checked; nothing was checked, so this is not a pass`],
    });
  });

  it('passes a tree whose sources each group reads under its own roots are registered or baselined', () => {
    assert.deepEqual(fault('fault.json'), {
      code: 0,
      out: [`${P} 2 cli and 1 server source(s) discovered, each registered, exempt or among the 2 baselined; the baseline does not grow`, `${P} not checked: examples, findingIds`],
      err: [],
    });
  });
});

describe('run absolute-paths: what --staged, --base and --all select', () => {
  const DIRTY = 'Read /Users/fixture/private.txt for details.\n';
  const commitAll = (root: string, message: string) => git(root, '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-qam', message);
  const HEAD = '→ Checking for absolute paths in documentation...';
  const NONE = [HEAD, '✅ No documentation files to check.'];
  const checking = (n: number) => `   Checking ${n} documentation file(s)...`;
  const FOUND = ['', '❌ Error: Absolute paths or local file references found:', ''];

  let history: string | undefined;
  /** main: a dirty a.md and a clean b.md; work: b.md edited, a dirty c.md added; b.md edited again and staged. */
  const histories = (): string => {
    if (history !== undefined) return history;
    const root = tree({ 'docs/a.md': DIRTY, 'docs/b.md': 'One.\n', 'cfg.json': '{}' });
    commitAll(root, 'base');
    git(root, 'branch', '-M', 'main');
    git(root, 'checkout', '-q', '-b', 'work');
    writeFileSync(join(root, 'docs/b.md'), 'Two.\n');
    writeFileSync(join(root, 'docs/c.md'), DIRTY);
    git(root, 'add', '-A');
    commitAll(root, 'work');
    writeFileSync(join(root, 'docs/b.md'), 'Three.\n');
    git(root, 'add', 'docs/b.md');
    history = root;
    return root;
  };
  const absolute = (root: string, ...more: string[]) => cli(['absolute-paths', '--root', root, ...more]);

  it('selects the staged files, a branch’s changes, or every tracked file', () => {
    assert.deepEqual(absolute(histories(), '--staged', '--config', 'cfg.json'), { code: 0, out: [HEAD, checking(1), '✅ No absolute paths found in documentation'], err: [] });
    assert.deepEqual(absolute(histories(), '--base', 'main', '--config', 'cfg.json'), {
      code: 1,
      out: [HEAD, checking(2), ...FOUND, 'docs/c.md:1:Read /Users/fixture/private.txt for details.', '', 'Please use relative paths only.'],
      err: [],
    });
    assert.deepEqual(absolute(histories(), '--base', 'main', '--head', 'main'), { code: 0, out: NONE, err: [] });
    const all = absolute(histories(), '--all');
    assert.deepEqual([all.code, all.out[1], all.out.filter((line) => line.includes(':1:'))], [1, checking(3), ['docs/a.md:1:Read /Users/fixture/private.txt for details.', 'docs/c.md:1:Read /Users/fixture/private.txt for details.']]);
  });

  it('names the selected files relative to the root, read through its links', () => {
    const docs = absolute(join(histories(), 'docs'), '--all');
    assert.deepEqual(docs.out.filter((line) => line.includes(':1:')), ['a.md:1:Read /Users/fixture/private.txt for details.', 'c.md:1:Read /Users/fixture/private.txt for details.']);
    const link = join(temp(), 'link');
    symlinkSync(histories(), link);
    const linked = absolute(link, '--base', 'main');
    assert.deepEqual(linked.out.filter((line) => line.includes(':1:')), ['docs/c.md:1:Read /Users/fixture/private.txt for details.']);
  });

  it('selects every tracked file when the selection changes the check’s own settings', () => {
    const root = tree({ 'docs/a.md': DIRTY, 'docs/b.md': 'One.\n', 'cfg.json': '{}', 'package.json': '{}' });
    commitAll(root, 'base');
    writeFileSync(join(root, 'docs/b.md'), 'Two.\n');
    git(root, 'add', 'docs/b.md');
    assert.deepEqual(absolute(root, '--staged', '--config', 'cfg.json').out[1], checking(1));
    writeFileSync(join(root, 'cfg.json'), '{ }');
    git(root, 'add', 'cfg.json');
    const widened = absolute(root, '--staged', '--config', 'cfg.json');
    assert.deepEqual([widened.code, widened.out[1]], [1, checking(2)]);
    // Settings git does not track have package.json, which a pin bump edits, stand in for them.
    const outside = join(temp(), 'cfg.json');
    writeFileSync(outside, '{}');
    commitAll(root, 'cfg');
    writeFileSync(join(root, 'docs/b.md'), 'Three.\n');
    git(root, 'add', 'docs/b.md');
    assert.deepEqual(absolute(root, '--staged', '--config', outside).out[1], checking(1));
    writeFileSync(join(root, 'package.json'), '{ }');
    git(root, 'add', 'package.json');
    assert.deepEqual(absolute(root, '--staged', '--config', outside).out[1], checking(2));
    assert.deepEqual(absolute(root, '--staged').out[1], checking(1));
  });

  it('takes a file entry’s settings to be its own file, not .pariksha.json', () => {
    const root = tree({ 'docs/a.md': DIRTY, 'docs/b.md': 'One.\n', 'cfg/abs.json': '{}', '.pariksha.json': '{"checks": {"absolute-paths": "cfg/abs.json"}}' });
    commitAll(root, 'base');
    const env = { PARIKSHA_CONFIG: join(root, '.pariksha.json') };
    writeFileSync(join(root, '.pariksha.json'), '{"checks": {"absolute-paths": "cfg/abs.json", "flaky-tests": "cfg/abs.json"}}');
    writeFileSync(join(root, 'docs/b.md'), 'Two.\n');
    git(root, 'add', '-A');
    assert.deepEqual(cli(['absolute-paths', '--root', root, '--staged'], {}, env).out[1], checking(1));
    writeFileSync(join(root, 'cfg/abs.json'), '{ }');
    git(root, 'add', 'cfg/abs.json');
    const widened = cli(['absolute-paths', '--root', root, '--staged'], {}, env);
    assert.deepEqual([widened.code, widened.out[1]], [1, checking(2)]);
  });

  it('takes an inline entry’s settings to be .pariksha.json itself', () => {
    const entry = (include: string) => JSON.stringify({ checks: { 'absolute-paths': { include } } });
    const root = tree({ 'docs/a.md': DIRTY, 'docs/b.md': 'One.\n', '.pariksha.json': entry('\\.md$') });
    commitAll(root, 'base');
    writeFileSync(join(root, 'docs/b.md'), 'Two.\n');
    git(root, 'add', 'docs/b.md');
    const env = { PARIKSHA_CONFIG: join(root, '.pariksha.json') };
    assert.deepEqual(cli(['absolute-paths', '--root', root, '--staged'], {}, env).out[1], checking(1));
    writeFileSync(join(root, '.pariksha.json'), entry('\\.mdx?$'));
    git(root, 'add', '.pariksha.json');
    const widened = cli(['absolute-paths', '--root', root, '--staged'], {}, env);
    assert.deepEqual([widened.code, widened.out[1]], [1, checking(2)]);
  });
});

describe('trackedFiles', () => {
  it('lists tracked text files, skipping binary and deleted ones', () => {
    const root = repo({ 'a.txt': 'hello', 'b.bin': new Uint8Array([1, 0, 2]), 'c.txt': 'gone' });
    rmSync(join(root, 'c.txt'));
    writeFileSync(join(root, 'untracked.txt'), 'acme');
    assert.deepEqual(trackedFiles(root), [{ path: 'a.txt', text: 'hello' }]);
  });
});

describe('run boundary', () => {
  it('passes a clean repository', () => {
    const c = capture();
    const root = repo({ [DENY_FILE]: DENY, 'README.md': 'clean\n' });
    assert.equal(run(['boundary', '--root', root], c.io, '0.1.0'), 0);
    assert.deepEqual(c.out, ['pariksha boundary: 2 files, none names a denied word (1 on the list)']);
  });

  it('refuses a file or path naming a denied word', () => {
    const c = capture();
    const root = repo({ [DENY_FILE]: DENY, 'docs/acme.md': 'clean\nfor Acme\n' });
    assert.equal(run(['boundary', '--root', root], c.io, '0.1.0'), 1);
    assert.deepEqual(c.err, [
      'pariksha boundary: docs/acme.md (its path): "acme" is on the deny list',
      'pariksha boundary: docs/acme.md:2: "acme" is on the deny list',
    ]);
  });

  it('reads a deny list named by --deny, relative to the root', () => {
    const c = capture();
    const root = repo({ 'lists/deny.txt': DENY, 'a.md': 'acme' });
    assert.equal(run(['boundary', '--root', root, '--deny', 'lists/deny.txt'], c.io, '0.1.0'), 1);
  });

  it('checks the current directory without --root', () => {
    const c = capture();
    const before = process.cwd();
    process.chdir(repo({ [DENY_FILE]: DENY }));
    try {
      assert.equal(run(['boundary'], c.io, '0.1.0'), 0);
    } finally {
      process.chdir(before);
    }
  });

  it('stops on a missing or broken deny list', () => {
    const missing = capture();
    assert.equal(run(['boundary', '--root', repo({ 'a.md': 'x' })], missing.io, '0.1.0'), 2);
    assert.match(missing.err[0] ?? '', /no deny list at/);
    const broken = capture();
    assert.equal(run(['boundary', '--root', repo({ [DENY_FILE]: 'acme\n' })], broken.io, '0.1.0'), 2);
    assert.match(broken.err[0] ?? '', /not a SHA-256 hash/);
  });

  it('refuses bad flags with the usage', () => {
    for (const args of [['--root'], ['--root', ''], ['--dir', 'x'], ['--root', 'a', '--root', 'b']]) {
      const c = capture();
      assert.equal(run(['boundary', ...args], c.io, '0.1.0'), 2);
      assert.match(c.err[0] ?? '', /^usage: pariksha authority-citations/);
    }
  });
});

describe('run coverage-by-type', () => {
  const files = {
    'app/services/ok.ts': '',
    'app/services/ok.test.ts': "import './ok';",
    'app/services/bare.ts': '',
    'scripts/lib/tool.ts': '',
  };
  const withStdin = (text: string) => {
    const c = capture();
    return { ...c, io: { ...c.io, stdin: () => text } };
  };

  it('checks every tracked file by default, and refuses a gap', () => {
    const c = capture();
    const root = repo(files);
    assert.equal(run(['coverage-by-type', '--root', root], c.io, '0'), 1);
    assert.deepEqual(c.err.slice(0, 3), ['pariksha coverage-by-type: service (needs: unit tests)', '  app/services/bare.ts: missing unit', 'pariksha coverage-by-type: utility (needs: unit tests)']);
  });

  it('reads a config relative to the root and a file list from a file or stdin', () => {
    const root = repo({ ...files, 'cov.json': JSON.stringify({ exclude: ['^scripts/'], hint: 'see the rules' }) });
    const list = join(root, 'list.txt');
    writeFileSync(list, 'app/services/ok.ts\napp/services/bare.ts\n');
    const c = capture();
    assert.equal(run(['coverage-by-type', '--root', root, '--config', 'cov.json', '--files-from', list], c.io, '0'), 1);
    assert.deepEqual(c.err, ['pariksha coverage-by-type: service (needs: unit tests)', '  app/services/bare.ts: missing unit', '', 'pariksha coverage-by-type: 1 file(s) missing required tests. A suite counts only when it imports its subject at runtime.', 'see the rules']);
    const s = withStdin('app/services/ok.ts\0scripts/lib/tool.ts\0');
    assert.equal(run(['coverage-by-type', '--root', root, '--config', 'cov.json', '--files-from', '-'], s.io, '0'), 0);
    assert.deepEqual(s.out, ['pariksha coverage-by-type: 1 of 2 listed file(s) judged, each has the tests its category needs']);
    const empty = withStdin('');
    assert.equal(run(['coverage-by-type', '--root', root, '--files-from', '-'], empty.io, '0'), 0);
    assert.deepEqual(empty.out, ['pariksha coverage-by-type: 0 of 0 listed file(s) judged, each has the tests its category needs']);
  });

  it('exits 2 when the whole tree has nothing in a category, or a listed file is missing', () => {
    const root = repo({ 'README.md': '', 'cov.json': JSON.stringify({ categories: { lib: '/nowhere/' }, required: { lib: ['unit'] } }) });
    const c = capture();
    assert.equal(run(['coverage-by-type', '--root', root, '--config', 'cov.json'], c.io, '0'), 2);
    assert.deepEqual(c.err, ['pariksha coverage-by-type: none of 2 tracked file(s) is in a category; nothing was checked, so this is not a pass']);
    const all = capture();
    assert.equal(run(['coverage-by-type', '--root', root, '--config', 'cov.json', '--all'], all.io, '0'), 2);
    assert.deepEqual(all.err, ['pariksha coverage-by-type: none of 2 tracked file(s) is in a category; nothing was checked, so this is not a pass']);
    const g = withStdin('ghost.ts\n');
    assert.equal(run(['coverage-by-type', '--root', root, '--files-from', '-'], g.io, '0'), 2);
    assert.deepEqual(g.err, ['pariksha coverage-by-type: listed file ghost.ts does not exist; nothing was checked, so this is not a pass']);
  });

  it('exits 2 outside a repository, without TypeScript, or on a bad config', () => {
    const outside = temp('pariksha-none-');
    const a = capture();
    assert.equal(run(['coverage-by-type', '--root', outside], a.io, '0'), 2);
    assert.match(a.err[0] ?? '', /is not in a git repository$/);
    const root = repo({ ...files, 'bad.json': '{"maxHops": -1}' });
    const b = capture();
    assert.equal(run(['coverage-by-type', '--root', root], { ...b.io, typescript: () => 'needs the typescript package' }, '0'), 2);
    assert.deepEqual(b.err, ['pariksha coverage-by-type: needs the typescript package']);
    const d = capture();
    assert.equal(run(['coverage-by-type', '--root', root, '--config', 'bad.json'], d.io, '0'), 2);
    assert.deepEqual(d.err, ['pariksha coverage-by-type: "maxHops" must be a whole number, 0 or more; nothing was checked, so this is not a pass']);
    const e = capture();
    assert.equal(run(['coverage-by-type', '--root', root, '--files-from', join(root, 'absent.txt')], e.io, '0'), 2);
    assert.match(e.err[0] ?? '', /ENOENT.*nothing was checked, so this is not a pass$/);
  });
});

describe('run coverage-exemptions', () => {
  const good = 'export default { test: { coverage: { exclude: ["**/*.test.ts", "dist/**"] } } };';
  const config = JSON.stringify({
    vitest: { configs: ['apps/a/vitest.config.mjs', 'apps/b/vitest.config.mjs'], requiredExcludes: ['**/*.test.ts'] },
    build: { configs: ['apps/a/tsconfig.build.json'], forbiddenIncludes: ['__mocks__'] },
  });
  const files = {
    'cov.json': config,
    'apps/a/vitest.config.mjs': good,
    'apps/b/vitest.config.mjs': good,
    'apps/a/tsconfig.build.json': '{ "include": ["src"] }',
    'packages/c/x.ts': '',
  };

  it('passes configs that hold the lists, and counts them', () => {
    const c = capture();
    assert.equal(run(['coverage-exemptions', '--root', repo(files), '--config', 'cov.json'], c.io, '0'), 0);
    assert.deepEqual(c.out, ['pariksha coverage-exemptions: 2 vitest and 1 build config(s) checked, none drifts']);
  });

  it('refuses drift, and judges only a package’s own configs with --package', () => {
    const root = repo({ ...files, 'apps/b/vitest.config.mjs': 'export default { test: { coverage: { exclude: ["dist/**"] } } };', 'apps/a/tsconfig.build.json': '{ "include": ["src", "src/__mocks__"] }' });
    const all = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'cov.json'], all.io, '0'), 1);
    assert.deepEqual(all.err.slice(0, 2), ['pariksha coverage-exemptions: apps/b/vitest.config.mjs: coverage.exclude lacks **/*.test.ts', 'pariksha coverage-exemptions: apps/a/tsconfig.build.json: include brings test files into the build: __mocks__']);
    const b = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'cov.json', '--package', 'apps/b'], b.io, '0'), 1);
    assert.deepEqual(b.err[0], 'pariksha coverage-exemptions: apps/b/vitest.config.mjs: coverage.exclude lacks **/*.test.ts');
    const c = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'cov.json', '--package', 'packages/c'], c.io, '0'), 0);
    assert.deepEqual(c.out, ['pariksha coverage-exemptions: 0 vitest and 0 build config(s) under packages/c checked, none drifts']);
  });

  it('exits 2 without a config, outside a repository, on a bad package, a missing config or no typescript', () => {
    const usage = capture();
    assert.equal(run(['coverage-exemptions'], usage.io, '0'), 2);
    assert.match(usage.err[0] ?? '', /^usage:/);
    const outside = capture();
    assert.equal(run(['coverage-exemptions', '--root', temp('pariksha-none-'), '--config', 'cov.json'], outside.io, '0'), 2);
    assert.match(outside.err[0] ?? '', /is not in a git repository$/);
    const root = repo(files);
    const pkg = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'cov.json', '--package', 'apps/a/'], pkg.io, '0'), 2);
    assert.deepEqual(pkg.err, ['pariksha coverage-exemptions: --package "apps/a/" is not a normalized root-relative folder']);
    const gone = repo(Object.fromEntries(Object.entries(files).filter(([p]) => p !== 'apps/a/tsconfig.build.json')));
    const missing = capture();
    assert.equal(run(['coverage-exemptions', '--root', gone, '--config', 'cov.json'], missing.io, '0'), 2);
    assert.deepEqual(missing.err, ['pariksha coverage-exemptions: apps/a/tsconfig.build.json named in cov.json but not a file; nothing was checked, so this is not a pass']);
    const two = repo(Object.fromEntries(Object.entries(files).filter(([p]) => !p.startsWith('apps/a/'))));
    const both = capture();
    assert.equal(run(['coverage-exemptions', '--root', two, '--config', 'cov.json'], both.io, '0'), 2);
    assert.deepEqual(both.err, ['pariksha coverage-exemptions: apps/a/vitest.config.mjs, apps/a/tsconfig.build.json named in cov.json but not a file; nothing was checked, so this is not a pass']);
    const nots = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'cov.json'], { ...nots.io, typescript: () => 'needs the typescript package' }, '0'), 2);
    assert.deepEqual(nots.err, ['pariksha coverage-exemptions: needs the typescript package']);
    const bad = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'absent.json'], bad.io, '0'), 2);
    assert.match(bad.err[0] ?? '', /ENOENT.*nothing was checked, so this is not a pass$/);
  });

  it('needs no typescript for vitest configs alone, and exits 2 on a loader that does not load', () => {
    const vitestOnly = JSON.stringify({ vitest: { configs: ['apps/a/vitest.config.mjs'], requiredExcludes: ['**/*.test.ts'] } });
    const root = repo({ ...files, 'v.json': vitestOnly, 'l.json': JSON.stringify({ ...JSON.parse(vitestOnly), loader: 'no-such-loader-pariksha' }) });
    const c = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'v.json'], { ...c.io, typescript: () => 'needs the typescript package' }, '0'), 0);
    assert.deepEqual(c.out, ['pariksha coverage-exemptions: 1 vitest and 0 build config(s) checked, none drifts']);
    const l = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'l.json'], l.io, '0'), 2);
    assert.match(l.err[0] ?? '', /^pariksha coverage-exemptions: loader no-such-loader-pariksha does not load: .*nothing was checked, so this is not a pass$/);
    // A package that owns no vitest config never needs the loader.
    const none = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'l.json', '--package', 'packages/c'], none.io, '0'), 0);
    assert.deepEqual(none.out, ['pariksha coverage-exemptions: 0 vitest and 0 build config(s) under packages/c checked, none drifts']);
  });
});

describe('run doc-budgets', () => {
  const RULE = '# r\n\n## Budgets\n\n| Doc | Budget |\n| --- | --: |\n| `a.md` | 5 |\n| `rule.md` | 500 |\n';

  it('passes and refuses by size, relative to the root', () => {
    const ok = capture();
    const root = repo({ 'rule.md': RULE, 'a.md': 'abc' });
    assert.equal(run(['doc-budgets', '--root', root, '--table', 'rule.md'], ok.io, '0'), 0);
    assert.deepEqual(ok.out, ['pariksha doc-budgets: a.md 3 / 5 bytes', `pariksha doc-budgets: rule.md ${RULE.length} / 500 bytes`]);
    const over = capture();
    writeFileSync(join(root, 'a.md'), 'abcdef');
    assert.equal(run(['doc-budgets', '--root', root, '--table', 'rule.md'], over.io, '0'), 1);
    assert.deepEqual(over.err, ['pariksha doc-budgets: a.md is 6 bytes, over its budget of 5; cut it']);
  });

  it('names the table by its path under the root when it misses its own row', () => {
    const root = repo({ 'docs/rule.md': RULE, 'a.md': 'abc' });
    const c = capture();
    assert.equal(run(['doc-budgets', '--root', root, '--table', 'docs/rule.md'], c.io, '0'), 1);
    assert.match(c.err[0] ?? '', /^pariksha doc-budgets: docs\/rule.md sets budgets but has no row for itself/);
  });

  it('reads another section by --section, and a directory is not a file', () => {
    const root = repo({ 'rule.md': RULE.replace('Budgets', 'Sizes'), 'a.md/x': '' });
    const c = capture();
    assert.equal(run(['doc-budgets', '--root', root, '--table', 'rule.md', '--section', 'Sizes'], c.io, '0'), 1);
    assert.deepEqual(c.err, ['pariksha doc-budgets: a.md has a budget but does not exist']);
  });

  it('needs --table naming a file', () => {
    const c = capture();
    assert.equal(run(['doc-budgets'], c.io, '0'), 2);
    assert.match(c.err[0] ?? '', /^usage:/);
    const missing = capture();
    assert.equal(run(['doc-budgets', '--table', 'nope.md', '--root', repo({})], missing.io, '0'), 2);
    assert.match(missing.err[0] ?? '', /no budget table at/);
  });
});

describe('run export-deletions', () => {
  const commit = (root: string, ...args: string[]) =>
    git(root, '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', ...args);

  const work = (): string => {
    const root = repo({ 'a.ts': 'export const gone = 1;\n' });
    commit(root, '-m', 'base');
    git(root, 'branch', '-M', 'main');
    git(root, 'checkout', '-q', '-b', 'work');
    writeFileSync(join(root, 'a.ts'), 'export const kept = 1;\n');
    commit(root, '-am', 'drop');
    return root;
  };

  it('refuses an undeclared removal against the found base', () => {
    const c = capture();
    assert.equal(run(['export-deletions', '--root', work()], c.io, '0'), 1);
    assert.ok(c.err.includes('  gone   (removed from a.ts)'));
  });

  it('compares with --base, and stops when it names no commit', () => {
    const root = work();
    const same = capture();
    assert.equal(run(['export-deletions', '--root', root, '--base', 'work'], same.io, '0'), 0);
    assert.deepEqual([same.out, same.err], [['pariksha export-deletions: no undeclared export removals since work'], []]);
    const bad = capture();
    assert.equal(run(['export-deletions', '--root', root, '--base', 'nope'], bad.io, '0'), 2);
    assert.deepEqual(bad.err, ['pariksha export-deletions: --base nope names no commit']);
  });

  it('checks the whole repository from a subdirectory', () => {
    const root = work();
    mkdirSync(join(root, 'sub'));
    const c = capture();
    assert.equal(run(['export-deletions', '--root', join(root, 'sub')], c.io, '0'), 1);
    assert.ok(c.err.includes('  gone   (removed from a.ts)'));
  });

  it('stops outside a repository, and when git cannot read the branch', () => {
    const outside = capture();
    const dir = temp('pariksha-norepo-');
    assert.equal(run(['export-deletions', '--root', dir], outside.io, '0'), 2);
    assert.match(outside.err[0] ?? '', /is not in a git repository$/);
    const root = work();
    git(root, 'checkout', '-q', '--orphan', 'unrelated');
    commit(root, '-m', 'no shared history');
    git(root, 'checkout', '-q', 'work');
    const failed = capture();
    assert.equal(run(['export-deletions', '--root', root, '--base', 'unrelated'], failed.io, '0'), 2);
    assert.match(failed.err[0] ?? '', /failed; nothing was checked, so this is not a pass$/);
  });

  it('stops with nothing to compare with, since that reads nothing', () => {
    const c = capture();
    const root = repo({ 'a.ts': '' });
    commit(root, '-m', 'only');
    git(root, 'branch', '-M', 'trunk');
    assert.equal(run(['export-deletions', '--root', root], c.io, '0'), 2);
    assert.deepEqual(c.err, ['pariksha export-deletions: none of origin/main, origin/develop, origin/master, main names a commit; fetch one or pass --base']);
  });
});

const loadedTs = loadTypescript();
if (typeof loadedTs === 'string') throw new Error(loadedTs);
const compiler: Ts = loadedTs;
const commit = (root: string) => git(root, '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'gates');

const GATE_CONFIG = JSON.stringify({
  gatePaths: ['^\\.husky/', '^scripts/'],
  notGateCode: ['\\.test\\.[cm]?[jt]sx?$'],
  notAGate: { SETUP_SKIP_MOBILE: { files: ['scripts/setup.sh'], reason: 'installs no mobile toolchain; checks nothing' } },
});

describe('run env-gate-switches', () => {
  const P = 'pariksha env-gate-switches:';
  const PASS = (n: number) => `${P} no gate reads a *_SKIP / *_PROBE environment switch (${n} gate file(s) read)`;
  const HINT = `${P} 1 read(s). Decide inside the gate (a flag the gate owns, a file it checks), or, if the switch turns off no check at all, add it to notAGate in gates.json with the reason.`;
  const check = (root: string, more: string[] = [], over: Partial<Io> = {}) => {
    const c = capture();
    const code = run(['env-gate-switches', '--root', root, '--config', 'gates.json', ...more], { ...c.io, ...over }, '0');
    return { code, out: c.out, err: c.err };
  };

  /**
   * Leaves a directory where the gate file was, and returns its restore.
   * Not `chmod 000`: root reads such a file anyway, so the refusal would
   * never be exercised for a check run as root.
   */
  const makeUnreadable = (gate: string): (() => void) => {
    const content = readFileSync(gate);
    unlinkSync(gate);
    mkdirSync(gate);
    return () => {
      rmSync(gate, { recursive: true });
      writeFileSync(gate, content);
    };
  };

  it('finds a read in a tracked file and, in staged mode, only in the index', () => {
    const root = repo({ 'gates.json': GATE_CONFIG, '.husky/pre-push': '[ -n "$PUSH_SKIP" ] && exit 0\n' });
    for (const mode of [[], ['--mode', 'tree'], ['--mode', 'staged']]) {
      const r = check(root, mode);
      assert.equal(r.code, 1);
      assert.deepEqual(r.err, [`${P} gate code reads an environment switch anyone can set to turn it off:`, '   .husky/pre-push:1 reads PUSH_SKIP', HINT]);
    }
    // The working tree fixed but not staged: staged mode still sees the read.
    writeFileSync(join(root, '.husky/pre-push'), 'exit 0\n');
    assert.equal(check(root, ['--mode', 'staged']).code, 1);
    const tree = check(root);
    assert.equal(tree.code, 0);
    assert.deepEqual(tree.out, [PASS(1)]);
  });

  it('names the settings as .pariksha.json gives them: the entry inline, or its file', () => {
    const root = repo({ '.husky/pre-push': '[ -n "$PUSH_SKIP" ] && exit 0\n', 'cfg/gates.json': GATE_CONFIG, 'inline.json': JSON.stringify({ checks: { 'env-gate-switches': JSON.parse(GATE_CONFIG) } }), 'file.json': '{"checks": {"env-gate-switches": "cfg/gates.json"}}' });
    const hint = (where: string) => `${P} 1 read(s). Decide inside the gate (a flag the gate owns, a file it checks), or, if the switch turns off no check at all, add it to notAGate in ${where} with the reason.`;
    const inline = cli(['env-gate-switches', '--root', root], {}, { PARIKSHA_CONFIG: join(root, 'inline.json') });
    assert.deepEqual([inline.code, inline.err.at(-1)], [1, hint('.pariksha.json (checks.env-gate-switches)')]);
    const file = cli(['env-gate-switches', '--root', root], {}, { PARIKSHA_CONFIG: join(root, 'file.json') });
    assert.deepEqual([file.code, file.err.at(-1)], [1, hint(join(root, 'cfg/gates.json'))]);
  });

  it('checks the current directory without --root, from anywhere in the repository', () => {
    const root = repo({ 'gates.json': GATE_CONFIG, 'scripts/setup.sh': 'if [ "$SETUP_SKIP_MOBILE" = 1 ]; then return; fi\n', 'scripts/sub/x.sh': 'exit 0\n' });
    const before = process.cwd();
    process.chdir(join(root, 'scripts/sub'));
    try {
      const c = capture();
      assert.equal(run(['env-gate-switches', '--config', 'gates.json'], c.io, '0'), 0);
      assert.deepEqual(c.out, [PASS(2)]);
    } finally {
      process.chdir(before);
    }
  });

  it('refuses, rather than passes, when it cannot read a gate file', () => {
    const root = repo({ 'gates.json': GATE_CONFIG, '.husky/pre-push': 'exit 0\n' });
    const restore = makeUnreadable(join(root, '.husky/pre-push'));
    try {
      const r = check(root);
      assert.equal(r.code, 2);
      assert.equal(r.err.length, 1);
      assert.match(r.err[0] ?? '', /^pariksha env-gate-switches: could not read gate code, so it is unchecked: \.husky\/pre-push: EISDIR/);
    } finally {
      restore();
    }
    assert.equal(check(root).code, 0);
  });

  it('reads a long file list, and skips a tracked file the working tree deleted', () => {
    const long = `scripts/${'a'.repeat(100)}.sh`;
    const root = repo({ 'gates.json': GATE_CONFIG, '.husky/pre-push': '[ -n "$PUSH_SKIP" ] && exit 0\n', [long]: 'echo "$LONG_SKIP"\n', 'scripts/gone.sh': 'echo "$GONE_SKIP"\n' });
    rmSync(join(root, 'scripts/gone.sh'));
    const read = (r: { err: string[] }) => r.err.filter((l) => l.startsWith('   ')).map((l) => l.replace(/^.* reads /, ''));
    assert.deepEqual(read(check(root)), ['PUSH_SKIP', 'LONG_SKIP']);
    // The index still holds the deleted file: staged mode reads it there.
    assert.deepEqual(read(check(root, ['--mode', 'staged'])), ['PUSH_SKIP', 'LONG_SKIP', 'GONE_SKIP']);
  });

  it('loads TypeScript only for a script gate, and exits 2 when it cannot', () => {
    const noTs = { typescript: () => 'needs the typescript package (>=5.4 <6) in the repository or beside pariksha' };
    const shell = repo({ 'gates.json': GATE_CONFIG, 'scripts/a.sh': 'exit 0\n', 'scripts/a.test.ts': 'process.env.A_SKIP;\n' });
    const s = check(shell, [], noTs);
    assert.equal(s.code, 0);
    assert.deepEqual(s.out, [PASS(1)]);
    const script = repo({ 'gates.json': GATE_CONFIG, 'scripts/a.ts': 'if (process.env.A_SKIP) process.exit(0);\n' });
    const t = check(script, [], noTs);
    assert.equal(t.code, 2);
    assert.deepEqual(t.err, [`${P} needs the typescript package (>=5.4 <6) in the repository or beside pariksha`]);
    // One script gate among shell ones is enough to need it.
    const mixed = check(repo({ 'gates.json': GATE_CONFIG, 'scripts/a.sh': 'exit 0\n', 'scripts/b.ts': 'export {};\n' }), [], noTs);
    assert.deepEqual([mixed.code, mixed.err], [2, [`${P} needs the typescript package (>=5.4 <6) in the repository or beside pariksha`]]);
    // The default loader finds the one beside pariksha.
    const found = check(script);
    assert.equal(found.code, 1);
    assert.equal(found.err[1], '   scripts/a.ts:1 reads A_SKIP');
  });

  it('exits 2 on bad flags, outside a repository, on a bad config, and on a tree with no gate code', () => {
    for (const args of [['--root', '.'], ['--config', 'gates.json', '--mode', 'all'], ['--config', 'gates.json', '--staged'], ['--config']]) {
      const c = capture();
      assert.equal(run(['env-gate-switches', ...args], c.io, '0'), 2);
      assert.match(c.err[0] ?? '', /^usage: pariksha authority-citations/);
    }
    const outside = check(temp('pariksha-none-'));
    assert.equal(outside.code, 2);
    assert.match(outside.err[0] ?? '', /^pariksha env-gate-switches: .* is not in a git repository$/);
    const missing = check(repo({ 'scripts/a.sh': '' }));
    assert.equal(missing.code, 2);
    assert.match(missing.err[0] ?? '', /^pariksha env-gate-switches: ENOENT.*; nothing was checked, so this is not a pass$/);
    const bad = check(repo({ 'gates.json': '{"gatePaths": ["("]}' }));
    assert.equal(bad.code, 2);
    assert.match(bad.err[0] ?? '', /^pariksha env-gate-switches: gatePaths: "\(" is not a regular expression: .*; nothing was checked, so this is not a pass$/);
    const empty = check(repo({ 'gates.json': GATE_CONFIG, 'docs/a.sh': '' }));
    assert.equal(empty.code, 2);
    assert.deepEqual(empty.err, [`${P} no tracked file is gate code under the config's gatePaths; nothing was checked, so this is not a pass`]);
    // Staged mode refuses the same config: it would pass every commit.
    const staged = check(repo({ 'gates.json': GATE_CONFIG, 'docs/a.sh': '' }), ['--mode', 'staged']);
    assert.equal(staged.code, 2);
    assert.deepEqual(staged.err, empty.err);
  });

  it('passes staged mode with nothing staged under a config that names gate code', () => {
    const root = repo({ 'gates.json': GATE_CONFIG, 'scripts/a.sh': 'echo "$A_SKIP"\n' });
    commit(root);
    const r = check(root, ['--mode', 'staged']);
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, [PASS(0)]);
  });

  it('refuses a symlink gate in the index and in the working tree, rather than reading its target path', () => {
    const root = repo({ 'gates.json': GATE_CONFIG, 'scripts/target.sh': 'echo "$A_SKIP"\n' });
    commit(root);
    symlinkSync('target.sh', join(root, 'scripts/a.sh'));
    git(root, 'add', 'scripts/a.sh');
    const staged = check(root, ['--mode', 'staged']);
    assert.equal(staged.code, 2);
    assert.deepEqual(staged.err, [`${P} could not read gate code, so it is unchecked: scripts/a.sh is a symlink in the index; its target is unchecked`]);
    const tree = check(root);
    assert.equal(tree.code, 2);
    assert.deepEqual(tree.err, [`${P} could not read gate code, so it is unchecked: scripts/a.sh is a symlink in the working tree; its target is unchecked`]);
  });

  it('refuses a staged type change from a file to a symlink', () => {
    const root = repo({ 'gates.json': GATE_CONFIG, 'scripts/target.sh': 'exit 0\n', 'scripts/a.sh': 'exit 0\n' });
    commit(root);
    rmSync(join(root, 'scripts/a.sh'));
    symlinkSync('target.sh', join(root, 'scripts/a.sh'));
    git(root, 'add', 'scripts/a.sh');
    const r = check(root, ['--mode', 'staged']);
    assert.equal(r.code, 2);
    assert.match(r.err[0] ?? '', /scripts\/a\.sh is a symlink in the index; its target is unchecked$/);
  });

  it('exits 2 in tree mode when every tracked gate file is gone from the working tree', () => {
    const root = repo({ 'gates.json': GATE_CONFIG, 'scripts/a.sh': 'echo "$A_SKIP"\n', 'scripts/b.sh': 'exit 0\n' });
    rmSync(join(root, 'scripts/a.sh'));
    rmSync(join(root, 'scripts/b.sh'));
    const r = check(root);
    assert.equal(r.code, 2);
    assert.deepEqual(r.err, [`${P} every tracked gate file (2) is gone from the working tree; nothing was checked, so this is not a pass`]);
  });

  it('reads a staged type change: a symlink replaced by a file that reads a switch', () => {
    const root = repo({ 'gates.json': GATE_CONFIG, 'scripts/target.sh': 'exit 0\n' });
    symlinkSync('target.sh', join(root, 'scripts/a.sh'));
    git(root, 'add', 'scripts/a.sh');
    commit(root);
    rmSync(join(root, 'scripts/a.sh'));
    writeFileSync(join(root, 'scripts/a.sh'), 'echo "$A_SKIP"\n');
    git(root, 'add', 'scripts/a.sh');
    assert.match(git(root, 'diff', '--cached', '--name-status').toString(), /^T\tscripts\/a\.sh$/m);
    const r = check(root, ['--mode', 'staged']);
    assert.equal(r.code, 1);
    assert.equal(r.err[1], '   scripts/a.sh:1 reads A_SKIP');
  });

  it('refuses a gate under a folder it cannot read, rather than skipping it as deleted', () => {
    const root = repo({ 'gates.json': GATE_CONFIG, 'scripts/ok.sh': 'exit 0\n', 'scripts/locked/a.sh': 'exit 0\n' });
    const locked = join(root, 'scripts/locked');
    chmodSync(locked, 0o000);
    try {
      const r = check(root);
      if (process.getuid?.() === 0) {
        // root reads through mode 000, so the refusal cannot be exercised here.
        assert.equal(process.getuid(), 0, 'skipped: running as root');
        assert.equal(r.code, 0);
        return;
      }
      assert.equal(r.code, 2);
      assert.match(r.err[0] ?? '', /^pariksha env-gate-switches: could not read gate code, so it is unchecked: scripts\/locked\/a\.sh: EACCES/);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('exits 2, never 1, when reading a gate fails inside the compiler', () => {
    const root = repo({ 'gates.json': GATE_CONFIG, 'scripts/a.ts': 'export {};\n' });
    const broken = {
      ...compiler,
      createSourceFile: () => {
        throw new TypeError('ts.isSatisfiesExpression is not a function');
      },
    } as Ts;
    const r = check(root, [], { typescript: () => broken });
    assert.equal(r.code, 2);
    assert.deepEqual(r.err, [`${P} could not read gate code, so it is unchecked: ts.isSatisfiesExpression is not a function`]);
  });
});

/**
 * Every call the check makes to read gate code (the git listings, the file
 * read, `git show` of a staged file) fails in turn against a real
 * repository: an unread gate is unchecked, never clean, so each run must exit
 * 2, never 0.
 */
describe('run env-gate-switches under fault injection', () => {
  const GATES = {
    'gates.json': GATE_CONFIG,
    '.husky/pre-push': '#!/bin/sh\npnpm validate || exit 1\n',
    'scripts/gate.sh': '#!/bin/sh\n[ -n "$CI" ] && echo ci\nexit 0\n',
  };
  const world = (staged: boolean): string => {
    const root = repo(GATES);
    commit(root);
    if (staged) {
      writeFileSync(join(root, 'scripts/gate.sh'), `${GATES['scripts/gate.sh']}# staged\n`);
      git(root, 'add', 'scripts/gate.sh');
    }
    return root;
  };
  /** The disk's reads with call number `fault` failing (git as a failed run, a file call by throwing), counting every call. */
  const faulty = (fault: number) => {
    let calls = 0;
    const fails = (): boolean => calls++ === fault;
    const gateReads = (root: string): Reads => {
      const real = diskReads(root);
      return {
        git: { run: (args) => (fails() ? undefined : real.git.run(args)) },
        read: (file) => {
          if (fails()) throw new Error('injected: read');
          return real.read(file);
        },
      };
    };
    return { calls: () => calls, gateReads };
  };

  const cases: Array<[string, boolean, number]> = [
    // The listing, then the read of each of the two gates.
    ['tree', false, 3],
    // The staged listing, the tracked listing (is any file gate code?), then
    // `git show` of the one staged gate.
    ['staged', true, 3],
  ];
  for (const [mode, staged, calls] of cases) {
    it(`no failed read of gate code ends in exit 0 (${mode})`, () => {
      const root = world(staged);
      const runWith = (reads: ReturnType<typeof faulty>) => {
        const c = capture();
        return { code: run(['env-gate-switches', '--root', root, '--config', 'gates.json', '--mode', mode], { ...c.io, gateReads: reads.gateReads }, '0'), err: c.err };
      };
      const clean = faulty(-1);
      assert.equal(runWith(clean).code, 0);
      assert.equal(clean.calls(), calls);
      for (let fault = 0; fault < calls; fault++) {
        const r = runWith(faulty(fault));
        assert.equal(r.code, 2, `fault at call ${fault}`);
        assert.match(r.err[0] ?? '', /^pariksha env-gate-switches: could not read gate code, so it is unchecked: /);
      }
    });
  }
});

// Last: the only test that starts node, so the cheap tests above stop a
// mutant before it pays for the start.
describe('the command', () => {
  it('runs as a script, its arguments after the script, and exits with the code', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    const script = join(import.meta.dirname, 'cli.ts');
    assert.equal(execFileSync(process.execPath, [script, '--version'], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' }), `${pkg.version}\n`);
    assert.throws(() => execFileSync(process.execPath, [script, 'nope'], { stdio: 'pipe', timeout: 30_000, killSignal: 'SIGKILL' }), { status: 2 });
  });
});

// Last: the one read of this process's standard input, STDIN_LIST.
describe('standard input', () => {
  it('is read whole for --files-from - when the run is given no reader', () => {
    const root = tree({ 'from-standard-input.md': 'Plain.\n' }, false);
    const c = capture();
    const code = run(['absolute-paths', '--root', root, '--files-from', '-'], { ...c.io, cwd: () => NOWHERE }, '0', { PARIKSHA_CONFIG: NO_PROJECT });
    assert.deepEqual({ code, out: c.out }, { code: 0, out: ['→ Checking for absolute paths in documentation...', '   Checking 1 documentation file(s)...', '✅ No absolute paths found in documentation'] });
  });
});
