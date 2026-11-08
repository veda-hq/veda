/**
 * Fixtures the rule-check suites share: scratch folders, a hermetic git, and
 * a checkout with a linked worktree. It declares no tests; it is named
 * `*.test.ts` so the build and the coverage leave it out, like every suite.
 *
 * Why hermetic: a fixture that calls plain `git` inherits the machine's whole
 * git setup, `~/.gitconfig`, the system config and every `GIT_*` variable of
 * the shell or hook the tests run in. Signing makes a fixture commit prompt
 * for a key; a trace2 target set globally reports every fixture command to a
 * daemon that may then write into the fixture while teardown removes it; and
 * `GIT_DIR` or `GIT_INDEX_FILE` from a hook points the fixture at the hook's
 * repository. Pointing both config files at /dev/null, clearing the trace2
 * variables and dropping every other inherited `GIT_*` closes all three; a
 * fixture identity stands in for the masked one.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Git } from './fire-log.ts';

/** The inherited `GIT_*` variables a fixture keeps: who commits, and how git reaches a remote. */
const KEPT: ReadonlySet<string> = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_SSH_COMMAND',
  'GIT_TERMINAL_PROMPT',
]);

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
} as const;

/** Values every fixture git command runs with, whatever the machine has. */
export const HERMETIC_GIT_VARIABLES = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TRACE2: '0',
  GIT_TRACE2_EVENT: '0',
  GIT_TRACE2_PERF: '0',
} as const;

/** `base` with the git masks applied; `base` itself is not changed. */
export function hermeticGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!name.startsWith('GIT_') || KEPT.has(name)) env[name] = value;
  }
  return { ...IDENTITY, ...env, ...HERMETIC_GIT_VARIABLES };
}

/**
 * Apply the masks to this process's environment, for code under test that
 * runs its own git; returns the function that puts every `GIT_*` back.
 */
export function maskProcessGitEnv(): () => void {
  const before = { ...process.env };
  const hermetic = hermeticGitEnv(process.env);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_') && !(name in hermetic)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(hermetic)) {
    if (name.startsWith('GIT_')) process.env[name] = value;
  }
  return () => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('GIT_')) delete process.env[name];
    }
    for (const [name, value] of Object.entries(before)) {
      if (name.startsWith('GIT_')) process.env[name] = value;
    }
  };
}

export const GIT_ENV = hermeticGitEnv({ ...process.env });

/** Git in a fixture checkout, quiet on stderr. */
export const realGit: Git = (root, args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

export function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'ignore' });
}

/** Scratch folders under the system temp folder, and the cleanup that removes them. */
export function scratchDirs(prefix: string): { scratch: () => string; cleanup: () => void } {
  const dirs: string[] = [];
  return {
    scratch: () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
      dirs.push(dir);
      return dir;
    },
    cleanup: () => {
      for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
  };
}

/** A main checkout with one commit and a linked worktree on branch `wt`, holding a `sub` folder. */
export function repoWithWorktree(scratch: () => string): { main: string; worktree: string } {
  const main = join(scratch(), 'main');
  const worktree = join(main, '.worktrees', 'wt');
  mkdirSync(main, { recursive: true });
  sh(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'a.txt'), 'a\n');
  sh(main, 'add', 'a.txt');
  sh(main, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  sh(main, 'worktree', 'add', '-q', '-b', 'wt', worktree);
  mkdirSync(join(worktree, 'sub'));
  return { main, worktree };
}
