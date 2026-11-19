// cli.ts's own suite: every command's flags, what it hands its check, what it
// prints and its exit codes. The cli.*.test.ts suites beside it test the
// checks end to end; this one is what the mutation gate runs against cli.ts,
// so it reaches every line in-process and stays fast: cheap tests come
// first, and the ones that build git histories last.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { hash } from './boundary.ts';
import { CONFIGURABLE, consoleIo, DENY_FILE, flags, main, ownVersion, run, splitFiles, trackedFiles, type Io } from './cli.ts';
import { diskReads, type Reads } from './env-gate-switches.ts';
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

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

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
    const g = withStdin('ghost.ts\n');
    assert.equal(run(['coverage-by-type', '--root', root, '--files-from', '-'], g.io, '0'), 2);
    assert.deepEqual(g.err, ['pariksha coverage-by-type: listed file ghost.ts does not exist; nothing was checked, so this is not a pass']);
  });

  it('exits 2 outside a repository, without TypeScript, or on a bad config', () => {
    const outside = mkdtempSync(join(tmpdir(), 'pariksha-none-'));
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
    assert.equal(run(['coverage-exemptions', '--root', mkdtempSync(join(tmpdir(), 'pariksha-none-')), '--config', 'cov.json'], outside.io, '0'), 2);
    assert.match(outside.err[0] ?? '', /is not in a git repository$/);
    const root = repo(files);
    const pkg = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'cov.json', '--package', 'apps/a/'], pkg.io, '0'), 2);
    assert.deepEqual(pkg.err, ['pariksha coverage-exemptions: --package "apps/a/" is not a normalized root-relative folder']);
    const gone = repo(Object.fromEntries(Object.entries(files).filter(([p]) => p !== 'apps/a/tsconfig.build.json')));
    const missing = capture();
    assert.equal(run(['coverage-exemptions', '--root', gone, '--config', 'cov.json'], missing.io, '0'), 2);
    assert.deepEqual(missing.err, ['pariksha coverage-exemptions: apps/a/tsconfig.build.json named in cov.json but not a file; nothing was checked, so this is not a pass']);
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
    const dir = mkdtempSync(join(tmpdir(), 'pariksha-norepo-'));
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
    const outside = check(mkdtempSync(join(tmpdir(), 'pariksha-none-')));
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

// Very last: it gives this process a standard input that ends, a list file
// opened on descriptor 0 (the lowest free one), so the default reader of
// `--files-from -` is read in-process and never waits on a pipe.
describe('standard input', () => {
  it('is read whole for --files-from - when the run is given no reader', () => {
    const root = tree({ 'a.md': 'Plain.\n', 'list.txt': 'a.md\n' }, false);
    closeSync(0);
    assert.equal(openSync(join(root, 'list.txt'), 'r'), 0, 'the list holds standard input’s descriptor');
    const c = capture();
    const code = run(['absolute-paths', '--root', root, '--files-from', '-'], { ...c.io, cwd: () => NOWHERE }, '0', { PARIKSHA_CONFIG: NO_PROJECT });
    assert.deepEqual({ code, out: c.out }, { code: 0, out: ['→ Checking for absolute paths in documentation...', '   Checking 1 documentation file(s)...', '✅ No absolute paths found in documentation'] });
  });
});
