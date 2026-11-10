import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INTERPRETERS, interpreterTarget, nestedCommands, ownArgs, parsePnpm, scriptIndex, scriptTarget } from './doc-command-targets.ts';
import { CONFIG } from './doc-references.fixture.test.ts';

const NESTED = nestedCommands(CONFIG.commands.nested);

describe('fixed vocabularies', () => {
  // The pnpm value options are internal: each one's value is the next word, so the word after it is the script.
  it('knows which pnpm options take a value', () => {
    for (const option of ['--filter', '-F', '--dir', '-C', '--workspace-concurrency', '--reporter']) {
      assert.equal(parsePnpm(['pnpm', option, 'v', 'x']).script, 'x', option);
      assert.equal(parsePnpm(['pnpm', `${option}=v`, 'x']).script, 'x', option);
    }
    // Any other option is a switch: the next word is the script.
    for (const option of ['--silent', '--recursive', '-r', '--filterx', '--workspace-root']) {
      assert.equal(parsePnpm(['pnpm', option, 'v', 'x']).script, 'v', option);
    }
  });

  it('knows the interpreters, and the commands a wrapper nests', () => {
    assert.deepEqual(INTERPRETERS, new Set(['tsx', 'node', 'python', 'python3', 'bash', 'sh']));
    assert.deepEqual(NESTED, new Set(['tsx', 'node', 'python', 'python3', 'bash', 'sh', 'pnpm', 'npx', 'vitest', 'jest', 'playwright', 'detox', 'prisma', 'eslint', 'tsc', 'turbo', 'git', 'stryker']));
  });

  it('nests the interpreters, pnpm and npx whatever the config lists', () => {
    assert.deepEqual(nestedCommands([]), new Set(['tsx', 'node', 'python', 'python3', 'bash', 'sh', 'pnpm', 'npx']));
    assert.deepEqual(nestedCommands(['bun']), new Set(['tsx', 'node', 'python', 'python3', 'bash', 'sh', 'pnpm', 'npx', 'bun']));
  });
});

describe('scriptIndex', () => {
  const NODE_VALUE_OPTIONS = [
    '--import',
    '--loader',
    '--experimental-loader',
    '--require',
    '-r',
    '--env-file',
    '--env-file-if-exists',
    '--title',
    '--conditions',
    '-C',
    '--input-type',
    '--disable-warning',
    '--redirect-warnings',
    '--watch-path',
    '--inspect-port',
    '--test-reporter',
    '--test-reporter-destination',
    '--test-name-pattern',
    '--test-skip-pattern',
  ];

  // The node value options are internal: node and tsx skip each one's value; bash and python take none.
  it('knows the node options whose value may be the next word', () => {
    for (const option of NODE_VALUE_OPTIONS) {
      assert.equal(scriptIndex(['node', option, 'v', 'x.ts'], 0), 3, option);
      assert.equal(scriptIndex(['tsx', option, 'v', 'x.ts'], 0), 3, option);
      assert.equal(scriptIndex(['python3', option, 'v', 'x.ts'], 0), 2, option);
    }
    for (const option of ['--watch', '--importx', '-q', '--inspect']) {
      assert.equal(scriptIndex(['node', option, 'x.ts'], 0), 2, option);
    }
  });

  // `node -r dotenv/config x.ts` read the preload as the script, and `--title` was not skipped either.
  const cases: ReadonlyArray<readonly [readonly string[], number, number]> = [
    [['node', '-r', 'dotenv/config', 'x.ts'], 0, 3],
    [['node', '--title', 'report', 'x.ts'], 0, 3],
    [['node', '--import=tsx', 'x.ts'], 0, 2],
    [['node', '--watch', '-r', 'm', '--', 'x.ts'], 0, 5],
    [['tsx', '--env-file', '.env', 'x.ts'], 0, 3],
    [['npx', 'tsx', '--title', 't', 'x.ts'], 1, 4],
    [['bash', '-r', 'x.sh'], 0, 2],
    [['bash', '-C', 'x.sh'], 0, 2],
    [['python3', '--title', 'x.py'], 0, 2],
    [['node', '--watch'], 0, 2],
    [['node'], 0, 1],
    // After `--` every word is the script and its arguments, so `--import
    // tsx` there is neither an option nor a loader.
    [['node', '--', '--import', 'tsx', 'x.ts'], 0, 2],
    [['node', '--import', 'tsx', '--', 'x.ts'], 0, 4],
    [['bash', '--', '-x.sh'], 0, 2],
    [['node', '--'], 0, 2],
  ];
  for (const [words, at, index] of cases) {
    it(`finds the script in ${JSON.stringify(words)} from ${at} at ${index}`, () => {
      assert.equal(scriptIndex(words, at), index);
    });
  }
});

describe('parsePnpm', () => {
  it('parses pnpm options before the script', () => {
    assert.deepEqual(parsePnpm(['pnpm', '--filter=@a/b', 'run', 'x', '--y']), { filter: '@a/b', script: 'x', args: ['--y'] });
    assert.deepEqual(parsePnpm(['pnpm', '-C', 'apps', 'exec', 'tsx', 'a.ts']).exec, ['tsx', 'a.ts']);
  });

  it('parses every pnpm option that takes a value', () => {
    assert.deepEqual(parsePnpm(['pnpm', '-F', 'a', 'x', '--y']), { filter: 'a', script: 'x', args: ['--y'] });
    assert.deepEqual(parsePnpm(['pnpm', '--dir', 'd', 'x']), { dir: 'd', script: 'x', args: [] });
    assert.equal(parsePnpm(['pnpm', '-C', 'd', 'x']).dir, 'd');
    assert.equal(parsePnpm(['pnpm', '--filter', 'f', 'x']).filter, 'f');
    for (const option of ['--workspace-concurrency', '--reporter']) {
      assert.equal(parsePnpm(['pnpm', option, 'v', 'x']).script, 'x');
    }
    assert.equal(parsePnpm(['pnpm', '--silent', 'x']).script, 'x');
    // The source's `{ script: undefined, args: [] }`: an absent key, which a strict deep equality tells apart.
    assert.deepEqual(parsePnpm(['pnpm', '--silent']), { args: [] });
    assert.deepEqual(parsePnpm(['pnpm', 'dlx', 'tsx', 'a.ts']).exec, ['tsx', 'a.ts']);
  });

  it('records no filter or dir when the value is missing', () => {
    assert.deepEqual(parsePnpm(['pnpm', '--filter']), { args: [] });
    assert.deepEqual(parsePnpm(['pnpm', '-C']), { args: [] });
  });
});

describe('ownArgs', () => {
  it('stops a script own arguments at -- or a nested command', () => {
    assert.deepEqual(ownArgs(['--a', 'vitest', '--b'], NESTED), ['--a']);
    assert.deepEqual(ownArgs(['--a', '--', '--b'], NESTED), ['--a']);
    assert.deepEqual(ownArgs(['--a', '--b'], NESTED), ['--a', '--b']);
  });

  for (const word of ['tsx', 'node', 'python', 'python3', 'bash', 'sh', 'pnpm', 'npx', 'vitest', 'jest', 'playwright', 'detox', 'prisma', 'eslint', 'tsc', 'turbo', 'git', 'stryker']) {
    it(`hands the words after ${word} to that command`, () => {
      assert.deepEqual(ownArgs(['--a', word, '--b'], NESTED), ['--a']);
    });
  }

  it('nests only the words the set holds', () => {
    assert.deepEqual(ownArgs(['--a', 'vitest', '--b'], nestedCommands([])), ['--a', 'vitest', '--b']);
    assert.deepEqual(ownArgs(['--a', 'bun', '--b'], nestedCommands(['bun'])), ['--a']);
  });
});

/** Resolves only the repo-relative paths listed, as written. */
const only =
  (...paths: string[]) =>
  (path: string): string | undefined =>
    paths.includes(path) ? path : undefined;

describe('interpreterTarget', () => {
  const runners: ReadonlyArray<readonly string[]> = [
    ['tsx', 'x.ts', '--a', 'b'],
    ['npx', 'tsx', 'x.ts', '--a', 'b'],
    ['pnpm', 'tsx', 'x.ts', '--a', 'b'],
    ['pnpm', 'exec', 'tsx', 'x.ts', '--a', 'b'],
    ['exec', 'tsx', 'x.ts', '--a', 'b'],
  ];
  for (const words of runners) {
    it(`finds the script after an interpreter: ${JSON.stringify(words)}`, () => {
      assert.deepEqual(interpreterTarget(words, only('x.ts')), { path: 'x.ts', args: ['--a', 'b'] });
    });
  }

  // An option before the interpreter left it unread.
  const options: ReadonlyArray<readonly string[]> = [
    ['npx', '--yes', 'tsx', 'x.ts', '--a', 'b'],
    ['npx', '-y', '--quiet', 'tsx', 'x.ts', '--a', 'b'],
    ['npx', '--package', 'tsx', 'tsx', 'x.ts', '--a', 'b'],
    ['npx', '-p', 'tsx', 'tsx', 'x.ts', '--a', 'b'],
    ['npx', '--package=tsx', 'tsx', 'x.ts', '--a', 'b'],
    ['npx', '--', 'tsx', 'x.ts', '--a', 'b'],
    ['npx', '--callx', 'tsx', 'x.ts', '--a', 'b'],
    ['npx', '-cx', 'tsx', 'x.ts', '--a', 'b'],
    ['pnpm', 'exec', '--silent', 'tsx', 'x.ts', '--a', 'b'],
    ['exec', '-c', 'tsx', 'x.ts', '--a', 'b'],
    ['exec', '--resume-from', 'p', 'tsx', 'x.ts', '--a', 'b'],
  ];
  for (const words of options) {
    it(`skips the runner’s options before the interpreter: ${JSON.stringify(words)}`, () => {
      assert.deepEqual(interpreterTarget(words, only('x.ts')), { path: 'x.ts', args: ['--a', 'b'] });
    });
  }

  // The pnpm exec value options are internal: `--resume-from` takes a value there, npx's value options do not.
  it('knows which pnpm exec options take a value', () => {
    assert.deepEqual(interpreterTarget(['pnpm', 'exec', '--resume-from', 'p', 'tsx', 'x.ts'], only('x.ts')), { path: 'x.ts', args: [] });
    assert.deepEqual(interpreterTarget(['pnpm', 'exec', '--package', 'tsx', 'x.ts'], only('x.ts')), { path: 'x.ts', args: [] });
    assert.deepEqual(interpreterTarget(['npx', '--resume-from', 'tsx', 'x.ts'], only('x.ts')), { path: 'x.ts', args: [] });
    assert.equal(interpreterTarget(['npx', '--yes'], only('x.ts')), undefined);
  });

  // The commands an `npx -c` runs are documentedCommands' to read; here
  // the call is skipped as a value, and `npx -c tsx x.ts` runs nothing.
  const calls: ReadonlyArray<readonly string[]> = [
    ['npx', '-c', 'tsx x.ts --a b'],
    ['npx', '-c', 'tsx', 'x.ts'],
    ['npx', '--call', 'tsx', 'x.ts'],
  ];
  for (const words of calls) {
    it(`names no script for npx --call: ${JSON.stringify(words)}`, () => {
      assert.equal(interpreterTarget(words, only('x.ts')), undefined);
    });
  }

  it('runs no script when the word is no interpreter', () => {
    assert.equal(interpreterTarget(['vitest', 'x.ts'], only('x.ts')), undefined);
    assert.equal(interpreterTarget(['npx', 'x.ts'], only('x.ts')), undefined);
    assert.equal(interpreterTarget([], only('x.ts')), undefined);
  });

  it('skips interpreter options, and the value of a loader option', () => {
    for (const option of ['--import', '--loader', '--require', '-r', '--env-file', '--title']) {
      assert.deepEqual(interpreterTarget(['node', option, 'm', 'x.ts', '--a'], only('x.ts')), { path: 'x.ts', args: ['--a'] });
    }
    assert.deepEqual(interpreterTarget(['node', '--watch', '-q', 'x.ts'], only('x.ts')), { path: 'x.ts', args: [] });
    // `--importx` is an ordinary option: its next word is the script.
    assert.deepEqual(interpreterTarget(['node', '--importx', 'x.ts', 'y'], only('x.ts')), { path: 'x.ts', args: ['y'] });
  });

  it('names no script when none follows, or it does not resolve', () => {
    assert.equal(interpreterTarget(['tsx'], only('x.ts')), undefined);
    assert.equal(interpreterTarget(['tsx', '--watch'], only('x.ts')), undefined);
    assert.equal(interpreterTarget(['tsx', 'y.ts'], only('x.ts')), undefined);
  });

  it('hands the resolver the word as written', () => {
    const seen: string[] = [];
    interpreterTarget(['python3', './a.py', 'b'], (path) => {
      seen.push(path);
      return 'resolved/a.py';
    });
    assert.deepEqual(seen, ['./a.py']);
  });
});

describe('scriptTarget', () => {
  /** Resolves `path` under `dir` when that joined path is listed. */
  const under =
    (...paths: string[]) =>
    (dir: string, path: string): string | undefined =>
      paths.includes(`${dir}/${path}`) ? `${dir}/${path}` : undefined;

  it('reads the one interpreter command a package script runs', () => {
    assert.deepEqual(scriptTarget('FOO=1 tsx scripts/x.ts --a', 'apps/web', under('apps/web/scripts/x.ts'), NESTED), { path: 'apps/web/scripts/x.ts', args: ['--a'] });
  });

  it('runs no single script for a list of commands', () => {
    for (const body of ['tsx scripts/x.ts && echo', 'tsx scripts/x.ts; echo', 'tsx scripts/x.ts | cat']) {
      assert.equal(scriptTarget(body, 'd', under('d/scripts/x.ts'), NESTED), undefined, body);
    }
  });

  it('keeps a quoted operator inside the one command', () => {
    assert.deepEqual(scriptTarget("tsx scripts/x.ts 'a;b'", 'd', under('d/scripts/x.ts'), NESTED), { path: 'd/scripts/x.ts', args: ['a;b'] });
  });

  it('runs no script it cannot resolve, or one that wraps another command', () => {
    assert.equal(scriptTarget('tsx scripts/x.ts', 'd', under(), NESTED), undefined);
    assert.equal(scriptTarget('eslint .', 'd', under('d/.'), NESTED), undefined);
    assert.equal(scriptTarget('tsx scripts/x.ts vitest run', 'd', under('d/scripts/x.ts'), NESTED), undefined);
    assert.equal(scriptTarget('tsx scripts/x.ts -- --a', 'd', under('d/scripts/x.ts'), NESTED), undefined);
  });

  it('reads a wrapper from the nested set it is given', () => {
    assert.deepEqual(scriptTarget('tsx scripts/x.ts vitest run', 'd', under('d/scripts/x.ts'), nestedCommands([])), { path: 'd/scripts/x.ts', args: ['vitest', 'run'] });
  });
});
