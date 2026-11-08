/**
 * The processes the rule checks start: git in a checkout, and any other
 * program with its output. Its own module so the checks can use them without
 * importing the runtime that runs the checks.
 */
import { spawnSync } from 'node:child_process';

import type { Git } from './fire-log.ts';

/** A program's exit status and its stdout followed by its stderr. */
export type Run = (
  program: string,
  args: readonly string[],
) => { readonly status: number | null; readonly output: string };

export const run: Run = (program, args) => {
  // Buffers; a program that cannot start has none.
  const result = spawnSync(program, args);
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
};

/**
 * Git in `root`. Its complaints go into the thrown error, where the fire log's
 * failure note can name them, never onto the hook's own stderr.
 */
export const git: Git = (root, args) => {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    // A git that cannot start leaves no stderr; its reason is in `error`.
    const reason = result.error?.message ?? String(result.stderr).trim();
    throw new Error(`git ${args.join(' ')}: ${reason}`);
  }
  return result.stdout.trim();
};
