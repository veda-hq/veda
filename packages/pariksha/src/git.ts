// Git, as the checks read it: a function from arguments to stdout.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Git {
  /** Runs git in the repository; stdout, or undefined when git exits non-zero. */
  readonly run: (args: readonly string[]) => string | undefined;
}

/**
 * Settings that change what git prints, pinned so a user's config cannot:
 * quoted non-ASCII paths would name no file, and a column field would hide a
 * grep hit's text.
 */
export const PINNED = ['-c', 'core.quotePath=off', '-c', 'grep.column=false', '-c', 'color.ui=never', '-c', 'core.precomposeUnicode=false'] as const;

/** Variables that change how git reads a pathspec, so `:(literal)` would name no file. */
const PATHSPEC_ENV = ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'];

/** The environment git runs in: the caller's, less the pathspec switches. */
export const gitEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !PATHSPEC_ENV.includes(k)));

export const gitAt = (root: string): Git => ({
  run: (args) => {
    try {
      return execFileSync('git', [...PINNED, ...args], {
        cwd: root,
        env: gitEnv(process.env),
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 120_000,
      });
    } catch {
      return undefined;
    }
  },
});

/**
 * Git at the top level of the repository holding `dir`, or undefined outside
 * one. Paths git prints are relative to the top level, so every check runs
 * there whichever directory it was started in.
 */
export const gitAtTop = (dir: string): Git | undefined => {
  const top = topOf(dir);
  return top === undefined ? undefined : gitAt(top);
};

/** The top level of the repository holding `dir`, or undefined outside one. */
export const topOf = (dir: string): string | undefined => gitAt(dir).run(['rev-parse', '--show-toplevel'])?.trim() || undefined;

/**
 * Diff output a user's config cannot reshape: no colour, external tool,
 * textconv or rename pairing, and lines even for a file git or its
 * attributes class as binary, which would otherwise show no hunk at all.
 */
export const PLAIN_DIFF = ['--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--text'] as const;

/** A git call whose failure must stop the check rather than read as "nothing found". */
export const must = (git: Git, args: readonly string[]): string => {
  const out = git.run(args);
  if (out === undefined) throw new Error(`git ${args.join(' ')} failed`);
  return out;
};

/** Tracked paths under `roots` (each a literal path: a folder or one file) that still exist in the working tree. */
export const trackedUnder = (git: Git, root: string, roots: readonly string[]): string[] =>
  must(git, ['ls-files', '-z', '--', ...roots.map((r) => `:(literal)${r}`)])
    .split('\0')
    .filter((path) => path !== '' && existsSync(join(root, path)));

/** The merge base of HEAD and `base`; throws when git cannot name one. */
export const mergeBaseOf = (git: Git, base: string): string => must(git, ['merge-base', 'HEAD', base]).trim();

/**
 * `path` as committed at `commit`, or null when the commit does not have it.
 * `ls-tree` prints nothing for an absent path and fails on a real read
 * failure, so only a confirmed absence is null.
 */
export const fileAt = (git: Git, commit: string, path: string): string | null =>
  must(git, ['ls-tree', '--name-only', commit, '--', `:(literal)${path}`]) === '' ? null : must(git, ['show', `${commit}:${path}`]);

/**
 * The renames in `git diff --name-status -z` output, new path to old path.
 * NUL-separated, so a path arrives as committed. Each entry is a status then
 * its paths: two for a rename (`R`) or copy (`C`), one otherwise. Only a
 * rename counts: a copy leaves its source in place.
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

/** Files renamed between `commit` and the working tree (staged files count), new path to old path, by git's own rename detection. */
export const renamesSince = (git: Git, commit: string): Map<string, string> =>
  parseRenames(must(git, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', commit]));

export const BASE_CANDIDATES = ['origin/main', 'origin/develop', 'origin/master', 'main'] as const;

/** The first ref that names a commit, or undefined. */
export const resolveBase = (git: Git, candidates: readonly string[] = BASE_CANDIDATES): string | undefined =>
  candidates.find((ref) => git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== undefined);
