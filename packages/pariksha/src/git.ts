// Git, as the checks read it: a function from arguments to stdout.
import { execFileSync } from 'node:child_process';

export interface Git {
  /** Runs git in the repository; stdout, or undefined when git exits non-zero. */
  readonly run: (args: readonly string[]) => string | undefined;
}

/**
 * Settings that change what git prints, pinned so a user's config cannot:
 * quoted non-ASCII paths would name no file, and a column field would hide a
 * grep hit's text.
 */
export const PINNED = ['-c', 'core.quotePath=off', '-c', 'grep.column=false', '-c', 'color.ui=never'] as const;

export const gitAt = (root: string): Git => ({
  run: (args) => {
    try {
      return execFileSync('git', [...PINNED, ...args], {
        cwd: root,
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
  const top = gitAt(dir).run(['rev-parse', '--show-toplevel'])?.trim();
  return top ? gitAt(top) : undefined;
};

/** A git call whose failure must stop the check rather than read as "nothing found". */
export const must = (git: Git, args: readonly string[]): string => {
  const out = git.run(args);
  if (out === undefined) throw new Error(`git ${args.join(' ')} failed`);
  return out;
};

export const BASE_CANDIDATES = ['origin/main', 'origin/develop', 'origin/master', 'main'] as const;

/** The first ref that names a commit, or undefined. */
export const resolveBase = (git: Git, candidates: readonly string[] = BASE_CANDIDATES): string | undefined =>
  candidates.find((ref) => git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== undefined);
