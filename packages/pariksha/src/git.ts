// Git, as the checks read it: a function from arguments to stdout.
import { execFileSync } from 'node:child_process';

export interface Git {
  /** Runs git in the repository; stdout, or undefined when git exits non-zero. */
  readonly run: (args: readonly string[]) => string | undefined;
}

export const gitAt = (root: string): Git => ({
  run: (args) => {
    try {
      return execFileSync('git', args, {
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

export const BASE_CANDIDATES = ['origin/main', 'origin/develop', 'origin/master', 'main'] as const;

/** The first ref that names a commit, or undefined. */
export const resolveBase = (git: Git, candidates: readonly string[] = BASE_CANDIDATES): string | undefined =>
  candidates.find((ref) => git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== undefined);
