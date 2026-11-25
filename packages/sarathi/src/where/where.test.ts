// `sarathi where`: argument parsing, the depcruise call, the answer's shape,
// and the run in a real git checkout with a stub depcruise in node_modules.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DEPCRUISE,
  EXCLUDED,
  HELP,
  WhereError,
  buildDepcruiseArgs,
  formatEdges,
  parseArgs,
  parseWhereSettings,
  readWhereConfig,
  render,
  runDepcruise,
  spawnDepcruise,
  whereMain,
  type Io,
  type Spawn,
  type WhereOptions,
} from './where.ts';

const options = (overrides: Partial<WhereOptions> = {}): WhereOptions => ({
  mode: 'focus',
  pattern: 'discount-engine/index',
  depth: 1,
  scope: ['apps', 'packages'],
  max: 60,
  ...overrides,
});

function runOptions(argv: readonly string[]): WhereOptions {
  const parsed = parseArgs(argv);
  if (parsed.kind !== 'run') throw new Error(`expected a run, got ${JSON.stringify(parsed)}`);
  return parsed.options;
}

function errorMessage(argv: readonly string[]): string {
  const parsed = parseArgs(argv);
  if (parsed.kind !== 'error') throw new Error(`expected an error, got ${JSON.stringify(parsed)}`);
  return parsed.message;
}

const EXCLUDED_TEXT = '(^|/)(node_modules|dist|build|coverage|\\.turbo|\\.stryker-tmp|\\.tmp|eslint-rule-wiring-fixture\\.test\\.ts)(/|$)';

describe('parseArgs', () => {
  it('defaults a bare pattern to a depth-1 focus over apps and packages, 60 edges', () => {
    assert.deepEqual(parseArgs(['discount-engine/index']), {
      kind: 'run',
      options: { mode: 'focus', pattern: 'discount-engine/index', depth: 1, scope: ['apps', 'packages'], max: 60 },
    });
  });

  for (const flag of ['--reaches', '-r']) {
    it(`reads ${flag} as the reaches mode`, () => {
      assert.deepEqual(runOptions(['inventory', flag]), { mode: 'reaches', pattern: 'inventory', depth: 1, scope: ['apps', 'packages'], max: 60 });
    });
  }

  for (const flag of ['--help', '-h']) {
    it(`answers ${flag} before anything else`, () => {
      assert.deepEqual(parseArgs([flag, '--nonsense']), { kind: 'help' });
      assert.deepEqual(parseArgs(['x', '--max', '0', flag]), { kind: 'error', message: '--max needs a positive whole number, not "0"' });
    });
  }

  it('takes the revision directly after --affected', () => {
    assert.deepEqual(runOptions(['--affected', 'origin/main']), { mode: 'affected', pattern: 'origin/main', depth: 1, scope: ['apps', 'packages'], max: 60 });
  });

  it('falls back to main when --affected is bare or last', () => {
    assert.equal(runOptions(['--affected']).pattern, 'main');
  });

  it('does not take a following flag as the revision', () => {
    assert.deepEqual(runOptions(['--affected', '--max', '5']), { mode: 'affected', pattern: 'main', depth: 1, scope: ['apps', 'packages'], max: 5 });
  });

  it('collects --scope repeatedly, in order', () => {
    assert.deepEqual(runOptions(['x', '--scope', 'apps/server/src', '--scope', 'packages']).scope, ['apps/server/src', 'packages']);
  });

  it('reads --depth, --max and --config', () => {
    assert.deepEqual(runOptions(['x', '--depth', '3', '--max', '10', '--config', 'where.cjs']), {
      mode: 'focus',
      pattern: 'x',
      depth: 3,
      scope: ['apps', 'packages'],
      max: 10,
      config: 'where.cjs',
    });
    assert.equal(runOptions(['--affected', 'v1', '--config', 'c.cjs']).config, 'c.cjs');
    assert.equal(runOptions(['x', '-r', '--config', 'c.cjs']).config, 'c.cjs');
  });

  it('refuses a scope that depcruise would read as an option, and keeps a dash inside one', () => {
    assert.equal(errorMessage(['x', '--scope', '-odd']), '--scope needs a folder, not the option-like "-odd"');
    assert.equal(errorMessage(['x', '--scope', 'apps', '--scope', '--help']), '--scope needs a folder, not the option-like "--help"');
    assert.deepEqual(runOptions(['x', '--scope', 'apps/my-app']).scope, ['apps/my-app']);
  });

  it('takes an option-like --config, which never reaches depcruise as typed', () => {
    assert.equal(runOptions(['x', '--config', '-odd.cjs']).config, '-odd.cjs');
  });

  for (const [argv, mode] of [
    [['x', '--reaches', '--depth', '2'], 'reaches'],
    [['x', '--depth', '2', '--reaches'], 'reaches'],
    [['--affected', '--depth', '2'], 'affected'],
  ] as const) {
    it(`refuses ${JSON.stringify(argv)}, since --${mode} walks everything`, () => {
      assert.equal(errorMessage(argv), `--depth applies to the default --focus mode only; --${mode} always follows every module that reaches the match`);
    });
  }

  it('lets --depth 1 through in the focus mode', () => {
    assert.equal(runOptions(['x', '--depth', '1']).depth, 1);
  });

  for (const flag of ['--depth', '--max', '--scope', '--config']) {
    it(`refuses ${flag} without a value, or with an empty one`, () => {
      assert.equal(errorMessage(['x', flag]), `${flag} needs a value`);
      assert.equal(errorMessage(['x', flag, '']), `${flag} needs a value`);
    });
  }

  for (const [value, flag] of [
    ['0', '--max'],
    ['-1', '--depth'],
    ['2.5', '--max'],
    ['abc', '--depth'],
    ['07', '--max'],
    ['3x', '--depth'],
    ['3 ', '--max'],
    ['1e3', '--max'],
    ['99999999999999999999', '--max'],
  ]) {
    it(`refuses ${value} as a count for ${flag}`, () => {
      assert.equal(errorMessage(['x', String(flag), String(value)]), `${flag} needs a positive whole number, not ${JSON.stringify(value)}`);
    });
  }

  it('takes the largest safe count', () => {
    assert.equal(runOptions(['x', '--max', '9007199254740991']).max, 9007199254740991);
    assert.equal(runOptions(['x', '--max', '1000000']).max, 1000000);
  });

  it('refuses an unknown option', () => {
    assert.equal(errorMessage(['x', '--graph']), 'unknown option --graph');
    assert.equal(errorMessage(['-x']), 'unknown option -x');
  });

  it('refuses a second pattern', () => {
    assert.equal(errorMessage(['one', 'two']), 'only one pattern is accepted, got "one" and "two"');
  });

  it('requires a pattern outside --affected', () => {
    assert.equal(errorMessage([]), 'a module regex is required');
    assert.equal(errorMessage(['-r']), 'a module regex is required');
  });

  it('refuses a positional beside --affected, naming the right form', () => {
    assert.equal(errorMessage(['main', '--affected']), '--affected takes its revision directly, as --affected main');
    assert.equal(errorMessage(['--affected', 'v1', 'x']), '--affected takes its revision directly, as --affected x');
  });
});

describe('buildDepcruiseArgs', () => {
  it('asks for the compact reporter with the given config, excludes built output, and puts the scope last', () => {
    assert.deepEqual(buildDepcruiseArgs(options(), '/r/where.cjs'), [
      '--config',
      '/r/where.cjs',
      '--cache',
      '--output-type',
      'text',
      '--exclude',
      EXCLUDED_TEXT,
      '--focus',
      'discount-engine/index',
      'apps',
      'packages',
    ]);
  });

  it('passes --focus-depth only when the depth is not 1', () => {
    assert.deepEqual(buildDepcruiseArgs(options({ depth: 2, scope: ['s'] }), 'c').slice(7), ['--focus', 'discount-engine/index', '--focus-depth', '2', 's']);
  });

  it('uses --reaches and --affected for their modes', () => {
    assert.deepEqual(buildDepcruiseArgs(options({ mode: 'reaches', pattern: 'p', scope: ['s'] }), 'c').slice(7), ['--reaches', 'p', 's']);
    assert.deepEqual(buildDepcruiseArgs(options({ mode: 'affected', pattern: 'main', depth: 3, scope: ['s'] }), 'c').slice(7), ['--affected', 'main', 's']);
  });
});

describe('EXCLUDED', () => {
  it('is the pattern callers rely on', () => {
    assert.equal(EXCLUDED, EXCLUDED_TEXT);
  });

  it('excludes dependencies, built output and the lint fixture, and keeps sources', () => {
    const excluded = new RegExp(EXCLUDED);
    for (const path of [
      'node_modules/@nestjs/common/index.js',
      'packages/shared/dist/index.js',
      'apps/web/build/x.js',
      'coverage/x.js',
      'apps/.turbo/x',
      '.stryker-tmp/sandbox/x.ts',
      'packages/a/.tmp/x.ts',
      'packages/shared/src/eslint-rule-wiring-fixture.test.ts',
    ]) {
      assert.equal(excluded.test(path), true, path);
    }
    for (const path of ['packages/shared/src/index.ts', 'packages/shared/src/eslint-rule-wiring-fixture.ts', 'packages/distill/src/x.ts', 'apps/rebuild/x.ts', 'apps/xturbo/x.ts']) {
      assert.equal(excluded.test(path), false, path);
    }
  });
});

describe('formatEdges and render', () => {
  it('deduplicates, trims and sorts', () => {
    assert.deepEqual(formatEdges('  b → c\na → b\nb → c  \n\n  \n', 60), { lines: ['a → b', 'b → c'], total: 2 });
  });

  it('counts an empty answer as nothing', () => {
    assert.deepEqual(formatEdges('', 60), { lines: [], total: 0 });
  });

  it('caps at max and keeps the true total', () => {
    assert.deepEqual(formatEdges('d\nc\nb\na', 2), { lines: ['a', 'b'], total: 4 });
    assert.deepEqual(formatEdges('a\nb', 2), { lines: ['a', 'b'], total: 2 });
  });

  it('says so when nothing matched', () => {
    assert.equal(render({ lines: [], total: 0 }), 'no modules matched\n');
  });

  it('prints one edge per line, with no note when nothing is withheld', () => {
    assert.equal(render({ lines: ['a → b', 'b → c'], total: 2 }), 'a → b\nb → c\n');
  });

  it('names how many it withheld and how to see them', () => {
    assert.equal(render({ lines: ['a'], total: 9 }), 'a\n… 8 more of 9 (raise with --max)\n');
  });
});

describe('runDepcruise', () => {
  const calls: unknown[] = [];
  const answering =
    (result: string): Spawn =>
    (bin, args, cwd) => {
      calls.push([bin, args, cwd]);
      return result;
    };
  const throwing =
    (thrown: unknown): Spawn =>
    () => {
      throw thrown;
    };
  const refusal = (fn: () => unknown): WhereError => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof WhereError);
      return error;
    }
    throw new Error('expected a refusal');
  };

  it('hands the call through and returns its output', () => {
    calls.length = 0;
    assert.equal(runDepcruise('/b', ['--x'], '/root', answering('a → b\n')), 'a → b\n');
    assert.deepEqual(calls, [['/b', ['--x'], '/root']]);
  });

  it('keeps the output of a cruise that exited non-zero', () => {
    assert.equal(runDepcruise('/b', [], '/r', throwing({ status: 1, signal: null, stdout: 'a → b\n' })), 'a → b\n');
  });

  it('refuses a failure that printed nothing, naming it', () => {
    const crashed = Object.assign(new Error('Command failed: depcruise'), { status: 1, signal: null, stdout: '' });
    const error = refusal(() => runDepcruise('/b', [], '/r', throwing(crashed)));
    assert.equal(error.message, 'dependency-cruiser failed: Command failed: depcruise');
    assert.equal(error.cause, crashed);
    assert.equal(refusal(() => runDepcruise('/b', [], '/r', throwing(new Error('spawn ENOENT')))).message, 'dependency-cruiser failed: spawn ENOENT');
    assert.equal(refusal(() => runDepcruise('/b', [], '/r', throwing(Object.assign(new Error('odd'), { stdout: 42 })))).message, 'dependency-cruiser failed: odd');
  });

  it('refuses a child killed by a signal, even with partial output', () => {
    const killed = { status: null, signal: 'SIGKILL', stdout: '' };
    const error = refusal(() => runDepcruise('/b', [], '/r', throwing(killed)));
    assert.equal(error.message, 'dependency-cruiser was killed by SIGKILL');
    assert.equal(error.cause, killed);
    assert.equal(refusal(() => runDepcruise('/b', [], '/r', throwing({ signal: 'SIGTERM', stdout: 'a → b\n' }))).message, 'dependency-cruiser was killed by SIGTERM');
  });

  it('refuses a thrown value that is not an object', () => {
    assert.equal(refusal(() => runDepcruise('/b', [], '/r', throwing(null))).message, 'dependency-cruiser failed: null');
    assert.equal(refusal(() => runDepcruise('/b', [], '/r', throwing('boom'))).message, 'dependency-cruiser failed: boom');
    assert.equal(refusal(() => runDepcruise('/b', [], '/r', throwing(undefined))).message, 'dependency-cruiser failed: undefined');
  });

  it('names its error', () => {
    assert.equal(new WhereError('x').name, 'WhereError');
  });
});

describe('parseWhereSettings', () => {
  it('names no config when the key or its config is absent', () => {
    assert.equal(parseWhereSettings(undefined, 'f.json', '/root'), undefined);
    assert.equal(parseWhereSettings({}, 'f.json', '/root'), undefined);
  });

  it('resolves a relative config from the root and keeps an absolute one', () => {
    assert.equal(parseWhereSettings({ config: 'scripts/where.cjs' }, 'f.json', '/root'), '/root/scripts/where.cjs');
    assert.equal(parseWhereSettings({ config: '/etc/where.cjs' }, 'f.json', '/root'), '/etc/where.cjs');
  });

  it('refuses what it cannot read exactly', () => {
    const refuses = (value: unknown, message: string): void => {
      assert.throws(
        () => parseWhereSettings(value, 'f.json', '/root'),
        (error: unknown) => error instanceof WhereError && error.message === message,
      );
    };
    refuses(null, 'f.json: "where" must be an object');
    refuses([], 'f.json: "where" must be an object');
    refuses('x', 'f.json: "where" must be an object');
    refuses({ config: 'c', depth: 2, max: 1 }, 'f.json where: unknown key "depth", "max"');
    refuses({ config: '' }, 'f.json where: "config" must be a path from the project root');
    refuses({ config: 1 }, 'f.json where: "config" must be a path from the project root');
  });
});

/** Every scratch folder the suite makes, removed when it ends. */
const scratchDirs: string[] = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

// Git without the hook's GIT_ variables or the machine's config, so a fixture never touches the real repository.
const gitEnv: Record<string, string | undefined> = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

// Records its arguments and working folder, then answers with $STUB_OUT's edges and $STUB_EXIT's status.
const STUB = `#!/bin/sh
printf '%s\\n' "$PWD" "$@" >"$STUB_LOG"
[ -n "$STUB_OUT" ] && printf "$STUB_OUT"
exit "\${STUB_EXIT:-0}"
`;

interface Checkout {
  readonly root: string;
  readonly log: string;
}

function checkout(files: { stub?: boolean; settings?: unknown; config?: string } = {}): Checkout {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sarathi-where-')));
  scratchDirs.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, env: { ...gitEnv }, stdio: 'ignore' });
  mkdirSync(join(root, 'sub'));
  if (files.stub !== false) {
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, DEPCRUISE), STUB);
    chmodSync(join(root, DEPCRUISE), 0o755);
  }
  if (files.settings !== undefined) {
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', 'sarathi.json'), typeof files.settings === 'string' ? files.settings : JSON.stringify(files.settings));
  }
  if (files.config !== undefined) writeFileSync(join(root, files.config), 'module.exports = {};\n');
  return { root, log: join(root, 'stub.log') };
}

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function where(argv: readonly string[], cwd: string, env: Record<string, string | undefined> = {}, spawn?: Spawn): Result {
  let out = '';
  let err = '';
  const io: Io = {
    cwd,
    env: { ...gitEnv, ...env },
    out: text => {
      out += text;
    },
    err: text => {
      err += text;
    },
  };
  // The stub reads its answer from the environment the real spawn inherits.
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const code = spawn === undefined ? whereMain(argv, io) : whereMain(argv, io, spawn);
    return { code, out, err };
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = saved[key];
    }
  }
}

const logged = (log: string): string[] => readFileSync(log, 'utf8').split('\n').slice(0, -1);

describe('whereMain', () => {
  it('prints the help on stdout and exits 0', () => {
    assert.deepEqual(where(['--help'], tmpdir()), { code: 0, out: HELP, err: '' });
    assert.ok(HELP.startsWith('sarathi where — '));
    assert.ok(HELP.includes('(default apps packages)'));
  });

  it('reports a usage error on stderr with the help, and exits 2', () => {
    assert.deepEqual(where([], tmpdir()), { code: 2, out: '', err: `sarathi where: a module regex is required\n\n${HELP}` });
  });

  it('runs the project’s depcruise from the root with sarathi.json’s config, and prints the sorted edges', () => {
    const { root, log } = checkout({ settings: { hooks: {}, where: { config: 'where.cjs' } }, config: 'where.cjs' });
    const result = where(['discount', '--scope', 'src'], join(root, 'sub'), { STUB_LOG: log, STUB_OUT: 'b → c\\na → b\\nb → c\\n' });
    assert.deepEqual(result, { code: 0, out: 'a → b\nb → c\n', err: '' });
    assert.deepEqual(logged(log), [root, '--config', join(root, 'where.cjs'), '--cache', '--output-type', 'text', '--exclude', EXCLUDED_TEXT, '--focus', 'discount', 'src']);
  });

  it('takes --config from the working folder over sarathi.json’s', () => {
    const { root, log } = checkout({ settings: { hooks: {}, where: { config: 'missing.cjs' } } });
    writeFileSync(join(root, 'sub', 'mine.cjs'), '');
    const result = where(['x', '-r', '--config', 'mine.cjs'], join(root, 'sub'), { STUB_LOG: log, STUB_OUT: 'a → b\\n' });
    assert.deepEqual(result, { code: 0, out: 'a → b\n', err: '' });
    assert.deepEqual(logged(log).slice(1, 3), ['--config', join(root, 'sub', 'mine.cjs')]);
  });

  it('truncates at --max and says how many it withheld', () => {
    const { root, log } = checkout({ config: 'c.cjs' });
    const result = where(['x', '--max', '1', '--config', 'c.cjs'], root, { STUB_LOG: log, STUB_OUT: 'c\\nb\\na\\n' });
    assert.deepEqual(result, { code: 0, out: 'a\n… 2 more of 3 (raise with --max)\n', err: '' });
  });

  it('keeps the answer of a cruise that exits non-zero for rule violations', () => {
    const { root, log } = checkout({ config: 'c.cjs' });
    assert.deepEqual(where(['x', '--config', 'c.cjs'], root, { STUB_LOG: log, STUB_OUT: 'a → b\\n', STUB_EXIT: '1' }), { code: 0, out: 'a → b\n', err: '' });
  });

  it('says no modules matched for an empty answer that exited 0', () => {
    const { root, log } = checkout({ config: 'c.cjs' });
    assert.deepEqual(where(['x', '--config', 'c.cjs'], root, { STUB_LOG: log }), { code: 0, out: 'no modules matched\n', err: '' });
  });

  it('exits 1, printing nothing on stdout, when the cruise failed with no answer', () => {
    const { root, log } = checkout({ config: 'c.cjs' });
    const result = where(['x', '--config', 'c.cjs'], root, { STUB_LOG: log, STUB_EXIT: '3' });
    assert.equal(result.code, 1);
    assert.equal(result.out, '');
    assert.match(result.err, /^sarathi where: dependency-cruiser failed: Command failed: /);
  });

  it('exits 1 when the child is killed', () => {
    const { root } = checkout({ config: 'c.cjs' });
    const killed: Spawn = () => {
      throw { signal: 'SIGKILL', stdout: '' };
    };
    assert.deepEqual(where(['x', '--config', 'c.cjs'], root, {}, killed), { code: 1, out: '', err: 'sarathi where: dependency-cruiser was killed by SIGKILL\n' });
  });

  it('refuses, naming the binary, in a checkout without dependency-cruiser', () => {
    const { root } = checkout({ stub: false, config: 'c.cjs' });
    assert.deepEqual(where(['x', '--config', 'c.cjs'], root), {
      code: 1,
      out: '',
      err: `sarathi where: ${join(root, 'node_modules', '.bin', 'depcruise')} is not installed: add dependency-cruiser to the project\n`,
    });
  });

  it('refuses when no config is named, rather than cruise with the project’s default one', () => {
    const { root } = checkout();
    const expected = {
      code: 1,
      out: '',
      err: `sarathi where: no dependency-cruiser config: pass --config, or set "where": { "config": "<file>" } in ${join(root, '.claude', 'sarathi.json')}\n`,
    };
    assert.deepEqual(where(['x'], root), expected);
    const named = checkout({ settings: { hooks: {} } });
    assert.match(where(['x'], named.root).err, /no dependency-cruiser config/);
  });

  it('refuses a config that does not exist', () => {
    const { root } = checkout({ settings: { hooks: {}, where: { config: 'gone.cjs' } } });
    assert.deepEqual(where(['x'], root), { code: 1, out: '', err: `sarathi where: the config ${join(root, 'gone.cjs')} does not exist\n` });
  });

  it('refuses a sarathi.json it cannot read', () => {
    const { root } = checkout({ settings: '{' });
    assert.deepEqual(where(['x'], root), { code: 1, out: '', err: `sarathi where: ${join(root, '.claude', 'sarathi.json')} is not JSON\n` });
    const bad = checkout({ settings: { hooks: {}, where: [] } });
    assert.equal(where(['x'], bad.root).err, `sarathi where: ${join(bad.root, '.claude', 'sarathi.json')}: "where" must be an object\n`);
  });

  it('refuses outside a git checkout, keeping git’s own complaint off the terminal', () => {
    // Inside a checkout, below a ceiling that hides it: git finds it only if it misses the session's environment.
    const { root } = checkout({ config: 'c.cjs' });
    const dir = join(root, 'sub', 'deep');
    mkdirSync(dir);
    const written: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
      written.push(String(chunk));
      return write(chunk, ...rest);
    }) as typeof process.stderr.write;
    try {
      const io: Io = { cwd: dir, env: { ...gitEnv, GIT_CEILING_DIRECTORIES: join(root, 'sub') }, out: () => undefined, err: text => written.push(`io:${text}`) };
      assert.equal(whereMain(['x'], io), 1);
    } finally {
      process.stderr.write = write;
    }
    assert.deepEqual(written, [`io:sarathi where: ${dir} is not in a git checkout\n`]);
  });
});

describe('readWhereConfig', () => {
  it('is undefined without a sarathi.json, or one with no where', () => {
    assert.equal(readWhereConfig(checkout().root), undefined);
    assert.equal(readWhereConfig(checkout({ settings: [] }).root), undefined);
  });

  it('refuses a sarathi.json that is not a file it can read', () => {
    const { root } = checkout();
    mkdirSync(join(root, '.claude', 'sarathi.json'), { recursive: true });
    assert.throws(
      () => readWhereConfig(root),
      (error: unknown) => error instanceof WhereError && error.message === `cannot read ${join(root, '.claude', 'sarathi.json')}`,
    );
  });
});

describe('spawnDepcruise', () => {
  it('runs the binary from the folder and returns its stdout as text', () => {
    const { root, log } = checkout();
    process.env.STUB_LOG = log;
    process.env.STUB_OUT = 'a → b\\n';
    try {
      assert.equal(spawnDepcruise(join(root, DEPCRUISE), ['--one', 'two'], join(root, 'sub')), 'a → b\n');
      assert.deepEqual(logged(log), [join(root, 'sub'), '--one', 'two']);
    } finally {
      Reflect.deleteProperty(process.env, 'STUB_LOG');
      Reflect.deleteProperty(process.env, 'STUB_OUT');
    }
  });

  it('carries an answer larger than the default buffer', () => {
    const { root } = checkout();
    const big = join(root, 'big.sh');
    writeFileSync(big, '#!/bin/sh\nhead -c 2000000 /dev/zero | tr "\\\\0" "a"\n');
    chmodSync(big, 0o755);
    assert.equal(spawnDepcruise(big, [], root).length, 2000000);
  });
});
