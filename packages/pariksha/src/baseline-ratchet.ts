// baseline-ratchet: the git reads a baseline that may only shrink is held
// with, for a repository's own list-shaped checks. It lists the tracked
// files a check reads, and reads the baseline as the merge base has it, so
// the check can refuse an entry the merge base does not have. A baseline
// entry that only moved is the same debt under a new name, not growth, so
// renames since the merge base are read too.
//
// A library, not a command: a check imports it from
// `@veda-hq/pariksha/baseline-ratchet`. Each read runs git at the root it is
// given, with the environment it is given; a failed read throws, with git's
// reason, rather than reading as an empty baseline.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Enough for a whole-repository listing or diff of a large monorepo. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Tracked paths under `pathspecs` that still exist in the working tree. */
export const trackedFiles = (root: string, env: NodeJS.ProcessEnv, pathspecs: readonly string[]): string[] =>
  execFileSync('git', ['ls-files', '--', ...pathspecs], { cwd: root, encoding: 'utf8', env, maxBuffer: MAX_BUFFER })
    .split('\n')
    .filter((path) => path !== '' && existsSync(join(root, path)));

// Default stdio: git's stderr is captured into a failure's message (and
// echoed, which only a failure produces).
const git = (root: string, env: NodeJS.ProcessEnv, args: readonly string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', env, maxBuffer: MAX_BUFFER });

/**
 * The merge base of HEAD and `base` (BASE_BRANCH, as a pre-push hook sets
 * it, and origin/main without it). An empty base is a hook's "no base
 * branch found" (a first push): null, nothing to compare against. A base
 * that is named but does not resolve throws.
 */
export const mergeBaseOf = (root: string, base: string = process.env['BASE_BRANCH'] ?? 'origin/main', env: NodeJS.ProcessEnv = process.env): string | null => {
  if (base === '') return null;
  return git(root, env, ['merge-base', 'HEAD', base]).trim();
};

/**
 * `path` as committed at `commit`, or null when `commit` does not have it.
 * `ls-tree` prints nothing for an absent path and throws on a real read
 * failure, so only a confirmed absence is null.
 */
export const fileAt = (root: string, commit: string, path: string, env: NodeJS.ProcessEnv = process.env): string | null => {
  if (git(root, env, ['ls-tree', '--name-only', commit, '--', path]) === '') return null;
  return git(root, env, ['show', `${commit}:${path}`]);
};

/**
 * The renames in `git diff --name-status -z` output, new path → old path.
 * NUL-separated, so a path arrives as committed, never C-quoted the way
 * plain output quotes a non-ASCII name. Each entry is a status then its
 * paths: two for a rename (`R`) or copy (`C`), one otherwise. Only a rename
 * counts: a copy leaves its source in place.
 */
export const parseRenames = (nameStatus: string): Map<string, string> => {
  const renamed = new Map<string, string>();
  const fields = nameStatus.split('\0');
  // How many of the fields that follow are the current entry's paths.
  let paths = 0;
  for (const [index, status] of fields.entries()) {
    if (paths > 0) {
      paths -= 1;
      continue;
    }
    paths = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    const from = fields[index + 1];
    const to = fields[index + 2];
    if (status.startsWith('R') && from !== undefined && to !== undefined) renamed.set(to, from);
  }
  return renamed;
};

/**
 * Files renamed since the merge base of HEAD and `base`, new path → old
 * path, by git's own rename detection over the working tree (staged files
 * count). Empty when there is no base (see `mergeBaseOf`).
 */
export const renamedSinceMergeBase = (
  root: string,
  // Undefined takes `mergeBaseOf`'s own default, BASE_BRANCH or origin/main.
  base?: string,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, string> => {
  const commit = mergeBaseOf(root, base, env);
  if (commit === null) return new Map();
  return parseRenames(git(root, env, ['diff', '--name-status', '-z', '-M', commit]));
};

/**
 * `path` as committed at the merge base of HEAD and `base`, or null when the
 * merge base does not have it, or when there is no base (see `mergeBaseOf`).
 */
export const atMergeBase = (root: string, path: string, base: string = process.env['BASE_BRANCH'] ?? 'origin/main', env: NodeJS.ProcessEnv = process.env): string | null => {
  const commit = mergeBaseOf(root, base, env);
  return commit === null ? null : fileAt(root, commit, path, env);
};
