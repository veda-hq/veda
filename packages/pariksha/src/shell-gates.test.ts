/**
 * shell-gates end to end: the config, the argument handling, the hook
 * preamble and the pitfalls together, ShellCheck beside them, and the CLI in
 * a throwaway repository. The argument and CLI cases are the original
 * suite's; the ShellCheck cases pin what the original's dispatcher arm and
 * its snapshot helper did (which files, read from where, with which flags),
 * with a stub in place of the binary. The original's wiring cases (its
 * hooks, dispatcher and setup script) belong to the product that adopts this
 * check, not here.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { run } from './cli.ts';
import { DEFAULT_RUNTIMES } from './hook-preamble.ts';
import { DEFAULT_PASSES, errorDetail, type GatesConfig, type GatesIo, parseGatesConfig, report, type RunResult, runChecks, runShellGates, selectSources, type ShellcheckRunner, shellcheckRunner } from './shell-gates.ts';

/** The original's rules, as the product that owned them configures this check. */
const PRODUCT_JSON = {
  hooksDir: '.husky/',
  exclude: ['node_modules/', '.husky/_/', 'apps/mobile/ios/Pods/'],
  gateInputs: ['scripts/validations/shell/'],
  preamble: { id: 'SHELL-06', selectScript: 'scripts/lib/select-node.sh', selectFunction: 'select_node' },
  pitfalls: { id: 'SHELL-03', validatorPaths: ['^scripts/(?:validations|package-validations)/'] },
  shellcheck: { inputs: ['scripts/run-validation.sh', 'scripts/lib/lint-snapshot.sh'], install: 'run the machine setup (or: brew install shellcheck)' },
  guidance: ['', '   SHELL-06 and SHELL-03 are described in', '   scripts/validations/shell/hook-preamble.ts and shell-pitfalls.ts.'],
};
const PRODUCT: GatesConfig = parseGatesConfig(JSON.stringify(PRODUCT_JSON));
/** The same, with ShellCheck off: the cases that judge only the repository's own rules. */
const NO_SHELLCHECK: GatesConfig = { ...PRODUCT, shellcheck: { ...PRODUCT.shellcheck, passes: [] } };

describe('shell-gates: config', () => {
  it('takes the defaults for an empty object', () => {
    const config = parseGatesConfig('{}');
    assert.deepEqual(config.sources, { hooksDir: '.husky/', exclude: ['node_modules/', '.husky/_/'], gateInputs: [] });
    assert.equal(config.preamble, undefined);
    assert.deepEqual(config.pitfalls, { id: 'shell-pitfalls', validatorPaths: [] });
    assert.deepEqual(config.shellcheck, { passes: DEFAULT_PASSES, inputs: [], install: 'install it from https://www.shellcheck.net' });
    assert.deepEqual(config.guidance, ['', "   hook-preamble and shell-pitfalls are described in pariksha's README, under shell-gates."]);
  });

  it('reads every field', () => {
    assert.deepEqual(PRODUCT.sources, { hooksDir: '.husky/', exclude: PRODUCT_JSON.exclude, gateInputs: PRODUCT_JSON.gateInputs });
    assert.deepEqual(PRODUCT.preamble, { id: 'SHELL-06', hooksDir: '.husky/', selectScript: 'scripts/lib/select-node.sh', selectFunction: 'select_node', runtimes: DEFAULT_RUNTIMES });
    assert.equal(PRODUCT.pitfalls.id, 'SHELL-03');
    assert.deepEqual(
      PRODUCT.pitfalls.validatorPaths.map((r) => r.source),
      ['^scripts\\/(?:validations|package-validations)\\/'],
    );
    assert.deepEqual(PRODUCT.shellcheck.inputs, PRODUCT_JSON.shellcheck.inputs);
    assert.deepEqual(PRODUCT.guidance, PRODUCT_JSON.guidance);
    const custom = parseGatesConfig(JSON.stringify({ hooksDir: 'githooks/', preamble: { selectScript: 's.sh', selectFunction: 'pick', runtimes: ['deno'] }, shellcheck: { passes: [['-S', 'error']] } }));
    assert.deepEqual(custom.preamble, { id: 'hook-preamble', hooksDir: 'githooks/', selectScript: 's.sh', selectFunction: 'pick', runtimes: ['deno'] });
    assert.deepEqual(custom.shellcheck.passes, [['-S', 'error']]);
    assert.deepEqual(parseGatesConfig('{"pitfalls":{"id":"P"}}').guidance, ['', "   hook-preamble and P are described in pariksha's README, under shell-gates."]);
  });

  for (const [json, message] of [
    ['nope', /not JSON: /],
    ['[]', /the config must be a JSON object/],
    ['{"hookDir":".husky/"}', /unknown key "hookDir"/],
    ['{"hooksDir":".husky"}', /"hooksDir" must end in "\/"/],
    ['{"hooksDir":""}', /"hooksDir" must be a non-empty string/],
    ['{"exclude":"node_modules/"}', /"exclude" must be a list of non-empty strings/],
    ['{"gateInputs":[""]}', /"gateInputs" must be a list of non-empty strings/],
    ['{"preamble":[]}', /"preamble" must be an object/],
    ['{"preamble":{"selectScript":"s.sh"}}', /"preamble\.selectFunction" must be a non-empty string/],
    ['{"preamble":{"selectScript":"s.sh","selectFunction":"f","extra":1}}', /unknown key "preamble\.extra"/],
    ['{"preamble":{"selectScript":"s.sh","selectFunction":"f","runtimes":[]}}', /"preamble\.runtimes" must be a list of non-empty strings/],
    ['{"pitfalls":{"validatorPaths":["("]}}', /"pitfalls\.validatorPaths" holds a bad regex: /],
    ['{"pitfalls":{"paths":[]}}', /unknown key "pitfalls\.paths"/],
    ['{"shellcheck":{"passes":["--severity=warning"]}}', /"shellcheck\.passes" must be a list of flag lists/],
    ['{"shellcheck":{"passes":[[""]]}}', /"shellcheck\.passes" must be a list of flag lists/],
    ['{"shellcheck":{"passes":{}}}', /"shellcheck\.passes" must be a list of flag lists/],
    ['{"shellcheck":{"bin":"sc"}}', /unknown key "shellcheck\.bin"/],
    ['{"guidance":"see the README"}', /"guidance" must be a list of lines/],
    ['{"guidance":[1]}', /"guidance" must be a list of lines/],
  ] as const) {
    it(`refuses ${json}`, () => {
      assert.throws(() => parseGatesConfig(json), message);
    });
  }
});

describe('shell-gates: runChecks and report', () => {
  const hook = {
    path: '.husky/post-commit',
    text: '#!/usr/bin/env bash\nnode x.js $1\ngrep -E "\\s" f\n',
  };

  it('runs both checks and orders findings by file and line', () => {
    const findings = runChecks([{ path: 'scripts/b.sh', text: '#!/bin/bash\ngrep -E "\\d" f\n' }, hook], ['preamble', 'pitfalls'], PRODUCT);
    assert.deepEqual(
      findings.map((f) => `${f.file}:${f.check}:${f.rule}:${String(f.line)}`),
      ['.husky/post-commit:SHELL-06:runtime-before-select-node:2', '.husky/post-commit:SHELL-03:grep-ere-perl-class:3', 'scripts/b.sh:SHELL-03:grep-ere-perl-class:2'],
    );
  });

  it('orders two findings on one line by rule', () => {
    const findings = runChecks([{ path: '.husky/post-merge', text: '#!/usr/bin/env bash\nnode x.js; grep -E "\\s" f\n' }], ['preamble', 'pitfalls'], PRODUCT);
    assert.deepEqual(
      findings.map((f) => f.rule),
      ['grep-ere-perl-class', 'runtime-before-select-node'],
    );
  });

  it('reports each finding on its own two lines', () => {
    assert.equal(
      report([
        { check: 'SHELL-03', rule: 'r1', file: 'a.sh', line: 2, message: 'm1' },
        { check: 'SHELL-06', rule: 'r2', file: 'b.sh', line: 5, message: 'm2' },
      ]),
      '  a.sh:2  SHELL-03 r1\n      m1\n  b.sh:5  SHELL-06 r2\n      m2',
    );
  });

  it('runs only the checks asked for, and no preamble without its config', () => {
    assert.deepEqual(
      runChecks([hook], ['pitfalls'], PRODUCT).map((f) => f.check),
      ['SHELL-03'],
    );
    assert.deepEqual(
      runChecks([hook], ['preamble'], PRODUCT).map((f) => f.check),
      ['SHELL-06'],
    );
    assert.deepEqual(runChecks([hook], ['preamble'], { ...PRODUCT, preamble: undefined }), []);
  });

  it('names what stopped the gate', () => {
    assert.equal(errorDetail(new Error('boom')), 'boom');
    assert.equal(errorDetail(new TypeError('')), 'TypeError');
    const nameless = new Error('');
    nameless.name = '';
    assert.equal(errorDetail(nameless), 'Error');
    assert.equal(errorDetail('a string'), 'a string');
  });
});

describe('shell-gates: in a repository', () => {
  // The gate runs its own git with this process's environment, as it must in
  // a hook. Under test that environment is the fixture's hermetic one.
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
  };
  const inherited = { ...process.env };
  before(() => {
    for (const name of Object.keys(process.env)) if (!(name in env)) Reflect.deleteProperty(process.env, name);
    Object.assign(process.env, env);
  });
  after(() => {
    for (const name of Object.keys(process.env)) if (!(name in inherited)) Reflect.deleteProperty(process.env, name);
    Object.assign(process.env, inherited);
  });

  let repo = '';
  let configFile = '';
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const useConfig = (config: object) => writeFileSync(configFile, JSON.stringify(config));

  /** What each ShellCheck call was asked, and the text of each file it was named, read from where it ran. */
  interface Call {
    readonly cwd: string;
    readonly args: readonly string[];
    readonly seen: Readonly<Record<string, string>>;
  }
  let calls: Call[] = [];
  const stub =
    (result: (args: readonly string[]) => RunResult = () => ({ status: 0, stdout: '', stderr: '' })): ShellcheckRunner =>
    (cwd, args) => {
      const named = args.slice(args.indexOf('--') + 1).filter((a) => !a.startsWith('-'));
      const seen = Object.fromEntries(named.map((p) => [p, existsSync(join(cwd, p)) ? readFileSync(join(cwd, p), 'utf8') : '<missing>']));
      calls.push({ cwd, args, seen });
      return result(args);
    };

  const cli = (args: readonly string[], shellcheck: ShellcheckRunner = stub(), stdin?: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(['shell-gates', '--root', repo, ...args], { out: (l) => out.push(l), err: (l) => err.push(l), shellcheck, ...(stdin === undefined ? {} : { stdin: () => stdin }) }, '0.0.0');
    return { code, out, err };
  };

  beforeEach(() => {
    repo = join(realpathSync(mkdtempSync(join(tmpdir(), 'shell-gates-test-'))), 'repo');
    configFile = join(dirname(repo), 'gates.json');
    useConfig({ ...PRODUCT_JSON, shellcheck: { ...PRODUCT_JSON.shellcheck, passes: [] } });
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    write('scripts/a.sh', '#!/bin/bash\necho "ok"\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    calls = [];
  });

  afterEach(() => {
    rmSync(dirname(repo), { recursive: true, force: true });
  });

  describe('the original suite, ShellCheck off', () => {
    it('passes a clean staged change and names the checks it ran', () => {
      write('scripts/a.sh', '#!/bin/bash\necho "still ok"\n');
      git('add', '-A');
      assert.deepEqual(cli(['--config', configFile, '--staged']), { code: 0, out: ['✅ Shell gates: 1 file(s) pass preamble, pitfalls'], err: [] });
    });

    it('defaults to staged mode with every check', () => {
      write('scripts/a.sh', '#!/bin/bash\necho "still ok"\n');
      write('scripts/b.sh', '#!/bin/bash\necho "unstaged"\n');
      git('add', 'scripts/a.sh');
      assert.deepEqual(cli(['--config', configFile]), { code: 0, out: ['✅ Shell gates: 1 file(s) pass preamble, pitfalls'], err: [] });
    });

    it('blocks a staged violation even when the working tree is fixed', () => {
      write('scripts/a.sh', '#!/bin/bash\ngrep -E "\\s" f\n');
      git('add', '-A');
      write('scripts/a.sh', '#!/bin/bash\ngrep -E "[[:space:]]" f\n');
      const result = cli(['--config', configFile, '--staged']);
      assert.equal(result.code, 1);
      assert.ok(result.err.join('\n').includes('scripts/a.sh:2  SHELL-03 grep-ere-perl-class'));
    });

    it('says when there is nothing to check', () => {
      assert.deepEqual(cli(['--config', configFile, '--staged']), { code: 0, out: ['✅ Shell gates: no shell scripts or hooks to check'], err: [] });
    });

    it('reports findings with their count, the list and where the rules live', () => {
      write('scripts/a.sh', '#!/bin/bash\ngrep -E "\\s" f\n');
      const result = cli(['--config', configFile, '--only', 'pitfalls', '--files-from', '-'], stub(), 'scripts/a.sh\n');
      assert.equal(result.code, 1);
      assert.deepEqual(result.out, []);
      assert.equal(result.err[0], '❌ Shell gates: 1 finding(s) in 1 file(s)\n');
      assert.match(result.err[1] as string, /^ {2}scripts\/a\.sh:2 {2}SHELL-03 grep-ere-perl-class\n {6}/);
      assert.deepEqual(result.err.slice(2), PRODUCT_JSON.guidance);
    });

    it('selects by revision', () => {
      write('scripts/b.sh', '#!/bin/bash\necho "b"\n');
      git('add', '-A');
      git('commit', '-qm', 'add b');
      assert.deepEqual(cli(['--config', configFile, '--base', 'HEAD~1']), { code: 0, out: ['✅ Shell gates: 1 file(s) pass preamble, pitfalls'], err: [] });
    });

    it('checks every target with --all', () => {
      assert.deepEqual(cli(['--config', configFile, '--all']), { code: 0, out: ['✅ Shell gates: 1 file(s) pass preamble, pitfalls'], err: [] });
    });

    it('reads --only in its own order, and runs no preamble when the config has none', () => {
      assert.deepEqual(cli(['--config', configFile, '--all', '--only', 'pitfalls,preamble']).out, ['✅ Shell gates: 1 file(s) pass preamble, pitfalls']);
      useConfig({ shellcheck: { passes: [] } });
      assert.deepEqual(cli(['--config', configFile, '--all']).out, ['✅ Shell gates: 1 file(s) pass pitfalls']);
      assert.deepEqual(cli(['--config', configFile, '--all', '--only', 'preamble']), {
        code: 2,
        out: [],
        err: ['❌ Shell gates could not run: the config has no "preamble" section, so the hook preamble cannot be checked; add one, or pass --only pitfalls'],
      });
    });

    it('reads a --files-from file, NUL or newline separated', () => {
      write('scripts/b.sh', '#!/bin/bash\necho "b"\n');
      const list = join(dirname(repo), 'list');
      writeFileSync(list, 'scripts/a.sh\0scripts/b.sh\0README.md\0');
      write('README.md', '# readme\n');
      assert.deepEqual(cli(['--config', configFile, '--files-from', list]).out, ['✅ Shell gates: 2 file(s) pass preamble, pitfalls']);
    });

    it('refuses two modes rather than letting one win', () => {
      assert.deepEqual(cli(['--staged', '--all', '--base', 'x', '--files-from', '-']), {
        code: 2,
        out: [],
        err: ['❌ Shell gates could not run: choose one of --staged, --all, --base, --files-from (got --staged, --all, --base, --files-from)'],
      });
      assert.equal(cli(['--files-from', '-', '--all']).code, 2);
    });

    for (const [args, message] of [
      [['--only', 'style,lint'], '--only takes preamble,pitfalls; got style,lint'],
      // ShellCheck is not one of these checks: --only is what turns it off.
      [['--only', 'shellcheck'], '--only takes preamble,pitfalls; got shellcheck'],
      [['--only', ','], '--only takes preamble,pitfalls; got nothing'],
    ] as const) {
      it(`refuses ${args.join(' ')}`, () => {
        assert.deepEqual(cli(['--config', configFile, ...args]), { code: 2, out: [], err: [`❌ Shell gates could not run: ${message}`] });
      });
    }

    // The original named each of these; the shared parser prints the usage.
    for (const args of [['--only'], ['--fix'], ['--base'], ['--base', ''], ['a.sh'], ['not-a-shell', '--all'], ['--root'], ['--root', '']]) {
      it(`refuses ${JSON.stringify(args)} with the usage`, () => {
        const out: string[] = [];
        const err: string[] = [];
        assert.equal(run(['shell-gates', ...args], { out: (l) => out.push(l), err: (l) => err.push(l) }, '0.0.0'), 2);
        assert.match(err.join('\n'), /^usage: pariksha /);
      });
    }

    it('refuses an empty --files-from list: a check of nothing is no pass', () => {
      assert.deepEqual(cli(['--config', configFile, '--files-from', '-'], stub(), '\n'), {
        code: 2,
        out: [],
        err: ['❌ Shell gates could not run: the --files-from list names no file, and a check of nothing is no pass'],
      });
    });

    it('exits 2 when the config cannot be read or parsed', () => {
      const missing = cli(['--config', 'absent.json']);
      assert.equal(missing.code, 2);
      assert.match(missing.err[0] as string, /^❌ Shell gates could not run: ENOENT/);
      writeFileSync(configFile, '{"hookDir":".husky/"}');
      assert.deepEqual(cli(['--config', configFile]).err, ['❌ Shell gates could not run: unknown key "hookDir"']);
    });

    it('exits 2 when selection fails: a named file it cannot read, a bad base', () => {
      const unread = cli(['--config', configFile, '--files-from', '-'], stub(), 'scripts/gone.sh\n');
      assert.equal(unread.code, 2);
      assert.match(unread.err[0] as string, /^❌ Shell gates could not run: cannot read scripts\/gone\.sh: /);
      const base = cli(['--config', configFile, '--base', 'no-such-ref']);
      assert.equal(base.code, 2);
      assert.match(base.err[0] as string, /^❌ Shell gates could not run: /);
    });

    it('judges the working directory when no --root is given', () => {
      write('scripts/a.sh', '#!/bin/bash\ngrep -E "\\s" f\n');
      const cwd = process.cwd();
      process.chdir(repo);
      try {
        const out: string[] = [];
        const err: string[] = [];
        assert.equal(run(['shell-gates', '--config', configFile, '--all'], { out: (l) => out.push(l), err: (l) => err.push(l), shellcheck: stub() }, '0.0.0'), 1);
        assert.ok(err.join('\n').includes('scripts/a.sh:2  SHELL-03 grep-ere-perl-class'));
      } finally {
        process.chdir(cwd);
      }
    });

    it('selectSources reads each mode', () => {
      write('scripts/b.sh', '#!/bin/bash\necho "b"\n');
      git('add', '-A');
      assert.deepEqual(
        selectSources(repo, { kind: 'staged' }, PRODUCT.sources).map((s) => s.path),
        ['scripts/b.sh'],
      );
      assert.deepEqual(
        selectSources(repo, { kind: 'all' }, PRODUCT.sources).map((s) => s.path),
        ['scripts/a.sh', 'scripts/b.sh'],
      );
      git('commit', '-qm', 'b');
      assert.deepEqual(
        selectSources(repo, { kind: 'base', base: 'HEAD~1' }, PRODUCT.sources).map((s) => s.path),
        ['scripts/b.sh'],
      );
      assert.deepEqual(
        selectSources(repo, { kind: 'files', files: ['scripts/a.sh'] }, PRODUCT.sources).map((s) => s.path),
        ['scripts/a.sh'],
      );
    });
  });

  describe('ShellCheck', () => {
    beforeEach(() => {
      useConfig(PRODUCT_JSON);
    });

    const passFlags = [
      ['--norc', '--severity=warning'],
      ['--norc', '--severity=info', '--include=SC2086,SC2013,SC2015'],
    ];

    it('runs each pass over the staged files as the index holds them, then the own checks', () => {
      write('scripts/a.sh', '#!/bin/bash\necho "staged"\n');
      write('.husky/pre-commit', 'echo hook\n');
      write('tools/run', '#!/usr/bin/env bash\necho run\n');
      write('tools/data', 'not shell\n');
      write('notes.txt', 'text\n');
      git('add', '-A');
      write('scripts/a.sh', '#!/bin/bash\necho "working tree"\n');
      const result = cli(['--config', configFile, '--staged']);
      assert.deepEqual(result, { code: 0, out: ['✅ Shell gates: 3 file(s) pass preamble, pitfalls'], err: [] });
      assert.deepEqual(
        calls.map((c) => c.args),
        [['--version'], ...passFlags.map((flags) => [...flags, '.husky/pre-commit', 'scripts/a.sh', 'tools/run'])],
      );
      const pass = calls[1] as Call;
      assert.notEqual(pass.cwd, repo);
      assert.deepEqual(pass.seen, { '.husky/pre-commit': 'echo hook\n', 'scripts/a.sh': '#!/bin/bash\necho "staged"\n', 'tools/run': '#!/usr/bin/env bash\necho run\n' });
      // Each snapshot is removed once its pass returns.
      assert.equal(existsSync(pass.cwd), false);
    });

    it('says each pass has no files to check when nothing shell is staged', () => {
      write('notes.txt', 'text\n');
      git('add', '-A');
      assert.deepEqual(cli(['--config', configFile, '--staged']), {
        code: 0,
        out: ['✅ No files to check.', '✅ No files to check.', '✅ Shell gates: no shell scripts or hooks to check'],
        err: [],
      });
      assert.deepEqual(
        calls.map((c) => c.args),
        [['--version']],
      );
    });

    it('judges the whole index when a staged change touches how ShellCheck runs', () => {
      write('scripts/b.sh', '#!/bin/bash\necho "b"\n');
      git('add', '-A');
      git('commit', '-qm', 'b');
      write('scripts/run-validation.sh', '#!/bin/bash\necho "dispatch"\n');
      git('add', '-A');
      cli(['--config', configFile, '--staged']);
      assert.deepEqual(
        (calls[1] as Call).args,
        [...(passFlags[0] as string[]), 'scripts/a.sh', 'scripts/b.sh', 'scripts/run-validation.sh'],
      );
    });

    it('judges the HEAD commit in base mode, not the working tree', () => {
      write('scripts/b.sh', '#!/bin/bash\necho "committed"\n');
      write('tools/run', '#!/bin/sh\necho run\n');
      git('add', '-A');
      git('commit', '-qm', 'b');
      write('scripts/b.sh', '#!/bin/bash\necho "edited"\n');
      assert.equal(cli(['--config', configFile, '--base', 'HEAD~1']).code, 0);
      const pass = calls[1] as Call;
      assert.deepEqual(pass.args, [...(passFlags[0] as string[]), 'scripts/b.sh', 'tools/run']);
      assert.deepEqual(pass.seen, { 'scripts/b.sh': '#!/bin/bash\necho "committed"\n', 'tools/run': '#!/bin/sh\necho run\n' });
    });

    it('reads the working tree at the top level in all mode, skipping a deleted file', () => {
      write('tools/gone', '#!/bin/sh\necho gone\n');
      git('add', '-A');
      git('commit', '-qm', 'gone');
      unlinkSync(join(repo, 'tools/gone'));
      write('scripts/a.sh', '#!/bin/bash\necho "edited"\n');
      assert.equal(cli(['--config', configFile, '--all']).code, 0);
      const pass = calls[1] as Call;
      assert.equal(pass.cwd, repo);
      assert.deepEqual(pass.seen, { 'scripts/a.sh': '#!/bin/bash\necho "edited"\n' });
    });

    it('runs the named files as given in files mode', () => {
      cli(['--config', configFile, '--files-from', '-'], stub(), 'scripts/a.sh\n-odd.sh\n');
      assert.deepEqual(
        (calls[1] as Call).args,
        [...(passFlags[0] as string[]), '--', 'scripts/a.sh', '-odd.sh'],
      );
      assert.equal((calls[1] as Call).cwd, repo);
    });

    it('needs no git repository in files mode, as the original did', () => {
      const bare = join(dirname(repo), 'plain');
      mkdirSync(join(bare, 'scripts'), { recursive: true });
      writeFileSync(join(bare, 'scripts/a.sh'), '#!/bin/bash\necho "ok"\n');
      const out: string[] = [];
      const err: string[] = [];
      const code = run(['shell-gates', '--root', bare, '--config', configFile, '--files-from', '-'], { out: (l) => out.push(l), err: (l) => err.push(l), shellcheck: stub(), stdin: () => 'scripts/a.sh\n' }, '0.0.0');
      assert.deepEqual({ code, out, err }, { code: 0, out: ['✅ Shell gates: 1 file(s) pass preamble, pitfalls'], err: [] });
      assert.deepEqual(
        calls.map((c) => c.args),
        [['--version'], ...passFlags.map((flags) => [...flags, '--', 'scripts/a.sh'])],
      );
    });

    it('fails on ShellCheck findings, printing them, and still runs the own checks', () => {
      write('scripts/a.sh', '#!/bin/bash\necho $1\n');
      git('add', '-A');
      const result = cli(
        ['--config', configFile, '--staged'],
        stub((args) => (args[0] === '--version' ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: 'In scripts/a.sh line 2:\nSC2086\n', stderr: 'note\n' })),
      );
      assert.deepEqual(result, {
        code: 1,
        out: ['In scripts/a.sh line 2:', 'SC2086', 'In scripts/a.sh line 2:', 'SC2086', '✅ Shell gates: 1 file(s) pass preamble, pitfalls'],
        err: ['note', 'note'],
      });
    });

    it('fails on a missing ShellCheck, saying how to install it', () => {
      const missing: ShellcheckRunner = () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn shellcheck ENOENT'), { code: 'ENOENT' }) });
      assert.deepEqual(cli(['--config', configFile, '--staged'], missing), { code: 1, out: [], err: ['❌ shellcheck is required: run the machine setup (or: brew install shellcheck)'] });
    });

    it('exits 2 when ShellCheck cannot start for another reason', () => {
      write('scripts/a.sh', '#!/bin/bash\necho "x"\n');
      git('add', '-A');
      const denied = stub((args) => (args[0] === '--version' ? { status: 0, stdout: '', stderr: '' } : { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn shellcheck EACCES'), { code: 'EACCES' }) }));
      assert.deepEqual(cli(['--config', configFile, '--staged'], denied), { code: 2, out: [], err: ['❌ Shell gates could not run: spawn shellcheck EACCES'] });
    });

    it('sits out under --only, as the original dispatcher did', () => {
      write('scripts/a.sh', '#!/bin/bash\necho "x"\n');
      git('add', '-A');
      assert.equal(cli(['--config', configFile, '--staged', '--only', 'pitfalls']).code, 0);
      assert.deepEqual(calls, []);
    });

    it('takes the hooks directory from the config', () => {
      useConfig({ ...PRODUCT_JSON, hooksDir: 'githooks/' });
      write('githooks/pre-push', 'echo hook\n');
      write('.husky/pre-push', 'echo not a hook here\n');
      git('add', '-A');
      cli(['--config', configFile, '--staged']);
      assert.deepEqual(
        (calls[1] as Call).args,
        [...(passFlags[0] as string[]), 'githooks/pre-push'],
      );
    });

    it('runs the real binary through shellcheckRunner', () => {
      // Node stands in for the binary: a program that starts and exits 0.
      const ran = shellcheckRunner(process.execPath)(repo, ['-e', 'console.log("ran")']);
      assert.deepEqual({ status: ran.status, stdout: ran.stdout, error: ran.error }, { status: 0, stdout: 'ran\n', error: undefined });
      const absent = shellcheckRunner(join(repo, 'no-such-binary'))(repo, ['--version']);
      assert.equal(absent.error?.code, 'ENOENT');
      assert.equal(absent.stdout, '');
    });
  });

  it('runShellGates refuses the preamble without its config', () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: GatesIo = { out: (l) => out.push(l), err: (l) => err.push(l), shellcheck: stub() };
    assert.equal(runShellGates({ root: repo, mode: { kind: 'all' }, checks: ['preamble'], only: true }, { ...NO_SHELLCHECK, preamble: undefined }, io), 2);
    assert.deepEqual(out, []);
    assert.equal(err.length, 1);
  });
});
