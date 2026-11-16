// `sarathi services` from the command line: a real git checkout with its
// settings and services file, stub `docker` and `pnpm` on PATH.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { main } from '../cli.ts';
import { expect } from '../test/expect.test.ts';
import { servicesMain, type Io } from './main.ts';
import { projectName, type SweepHost } from './reaper.ts';
import { PREFIX, sampleRaw } from './sample.test.ts';

// `docker compose -f <file> port <service> <port>` answers a loopback endpoint.
const STUB = `#!/bin/sh
printf '%s %s|%s\\n' "$(basename "$0")" "$*" "$PWD" >>"$STUB_LOG"
[ "$4" = port ] && printf '127.0.0.1:41001'
exit 0
`;

let root: string;
let log: string;
let env: Record<string, string | undefined>;
let out: string;
let err: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: { ...env }, stdio: 'ignore' });
}

function settings(worktree: unknown): void {
  writeFileSync(join(root, '.claude', 'sarathi.json'), JSON.stringify({ hooks: {}, worktree }));
}

const io = (cwd: string, extra: Partial<Io> = {}): Io => ({
  cwd,
  env,
  out: text => {
    out += text;
  },
  err: text => {
    err += text;
  },
  ...extra,
});

const calls = (): string[] => {
  try {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sarathi-services-cli-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // orbctl too, so a machine's own OrbStack never decides the sweep.
  for (const name of ['docker', 'pnpm', 'orbctl']) {
    writeFileSync(join(bin, name), STUB);
    chmodSync(join(bin, name), 0o755);
  }
  log = join(root, 'calls.log');
  env = { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: root, STUB_LOG: log, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  out = '';
  err = '';
  git(root, 'init', '-q');
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, 'services.json'), JSON.stringify(sampleRaw(41999)));
  settings({ name: 'acme', services: 'services.json' });
  mkdirSync(join(root, '.tmp', 'services'), { recursive: true });
  writeFileSync(
    join(root, '.tmp', 'services', 'config.json'),
    JSON.stringify({ project: projectName(PREFIX, root), password: 'a'.repeat(48), serverPort: 23456, webPort: 41999 }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('sarathi services', () => {
  test('names its usage without an action, or with a flag for one', async () => {
    expect(await servicesMain([], io(root))).toBe(1);
    expect(await servicesMain(['--up'], io(root))).toBe(1);
    expect(err).toContain('usage: sarathi services up|down|status|web|server|<action> [args]');
  });

  test('names the actions when given another', async () => {
    expect(await servicesMain(['restart'], io(root))).toBe(1);
    expect(err).toContain('unknown action restart; the actions are up, down, status, run, web, server, reap, database-init, database-snapshot');
  });

  test('takes no object built-in for an action', async () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(await servicesMain([name], io(root))).toBe(1);
      expect(err).toContain(`unknown action ${name};`);
    }
    expect(calls().filter(line => line.startsWith('docker'))).toEqual([]);
  });

  test('resolves the worktree from the directory it runs in, with or without --', async () => {
    expect(await servicesMain(['run', '--', 'pnpm', 'one'], io(join(root, 'bin')))).toBe(0);
    expect(await servicesMain(['run', 'pnpm', 'two'], io(root))).toBe(0);
    expect(calls().filter(line => line.startsWith('pnpm'))).toEqual([`pnpm one|${root}`, `pnpm two|${root}`]);
  });

  test('a failure is one line on stderr and exit 1', async () => {
    expect(await servicesMain(['run'], io(root))).toBe(1);
    expect(err).toBe('sarathi services: A command is required after --\n');
  });

  test('outside a git checkout, or without a services file, it says so', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sarathi-services-none-')));
    try {
      expect(await servicesMain(['up'], io(outside))).toBe(1);
      expect(err).toBe(`sarathi services: ${outside} is not in a git checkout\n`);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    err = '';
    settings({ name: 'acme' });
    expect(await servicesMain(['up'], io(root))).toBe(1);
    expect(err).toBe(`sarathi services: ${join(root, '.claude', 'sarathi.json')} names no services file; set "worktree.services"\n`);
  });

  test('a package path resolves under SARATHI_PACKAGES', async () => {
    const packages = join(root, 'packages');
    mkdirSync(join(packages, '@acme', 'rules'), { recursive: true });
    writeFileSync(join(packages, '@acme', 'rules', 'services.json'), JSON.stringify(sampleRaw(41999)));
    settings({ name: 'acme', services: '@acme/rules/services.json' });
    expect(await servicesMain(['run', 'pnpm', 'x'], io(root))).toBe(1);
    expect(err).toContain(join(root, 'node_modules', '@acme', 'rules', 'services.json'));
    env.SARATHI_PACKAGES = packages;
    expect(await servicesMain(['run', 'pnpm', 'x'], io(root))).toBe(0);
  });

  test('runs through the sarathi command line', async () => {
    const code = await main({ argv: ['services', 'status'], env, cwd: root, readStdin: async () => '', out: text => (out += text), err: text => (err += text) });
    expect(code).toBe(0);
    expect(calls()).toEqual([`docker compose -f ${join(root, 'compose.yaml')} ps|${root}`]);
  });
});

describe('sarathi services reap', () => {
  const host = (calls: string[][]): ((write: (text: string) => void) => SweepHost) => write => ({
    docker: async args => {
      calls.push(args);
      return '';
    },
    execFile: async () => ({ stdout: 'Running' }),
    execFileSync: () => '',
    appendFileSync: () => undefined,
    write,
  });

  test('sweeps with the project’s names, from the project checkout', async () => {
    const seen: string[][] = [];
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'sarathi-services-cwd-')));
    try {
      env.CLAUDE_PROJECT_DIR = root;
      expect(await servicesMain(['reap'], io(elsewhere, { sweepHost: host(seen) }))).toBe(0);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    expect(out).toBe('No services of deleted worktrees found\n');
    expect(seen.some(args => args.includes('label=acme.worktree-services.root'))).toBe(true);
    env.CLAUDE_PROJECT_DIR = '';
    out = '';
    expect(await servicesMain(['reap'], io(root, { sweepHost: host([]) }))).toBe(0);
    expect(out).toBe('No services of deleted worktrees found\n');
  });

  test('without a services file there is nothing to sweep', async () => {
    settings({ name: 'acme' });
    expect(await servicesMain(['reap'], io(root))).toBe(0);
    expect(out).toBe('No services file configured; nothing to sweep\n');
  });

  test('takes no arguments', async () => {
    expect(await servicesMain(['reap', 'now'], io(root))).toBe(1);
    expect(err).toContain('sarathi services reap');
  });

  test('the default host is the real one', async () => {
    // Stubs that answer nothing: OrbStack "runs", the engine "answers", nothing is found.
    expect(await servicesMain(['reap'], io(root))).toBe(0);
    expect(out).toBe('No services of deleted worktrees found\n');
  });
});
