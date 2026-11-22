/** Which files a push changed, and whether a file's change is comment-only. */

export type Git = (args: string[]) => string;

export interface Changes {
  base: string;
  /** Changed (deletions excluded) plus untracked, repo-relative. */
  files: string[];
  /** Files judged whatever their diff says: untracked ones. */
  alwaysJudged: Set<string>;
}

/** The paths of a `-z` git listing: NUL-separated, the empty one after the last NUL dropped. */
export const entries = (out: string): string[] => out.split('\0').filter((entry) => entry !== '');

/**
 * Merge-base of HEAD with `base` (default `upstream`) → working tree, plus
 * untracked files unless `trackedOnly` (a push carries no untracked file).
 */
export function changedFiles(git: Git, upstream: string, base?: string, trackedOnly = false): Changes {
  // As today, a --base is resolved to its merge-base, so a moving ref brings in only this branch.
  const from = git(['merge-base', base ?? upstream, 'HEAD']).trim();
  const tracked = entries(git(['diff', '--name-only', '-z', '--diff-filter=d', from]));
  const untracked = trackedOnly ? [] : entries(git(['ls-files', '-z', '--others', '--exclude-standard']));
  return { base: from, files: [...new Set([...tracked, ...untracked])], alwaysJudged: new Set(untracked) };
}

/** Blank, `//`, or a block-comment line (`/*`, `*`, `*\/` first after whitespace). */
const COMMENT_OR_BLANK = /^\s*(?:\/\/|\/\*|\*|$)/;

/**
 * Whether a `git diff -U0` touches only comments and blank lines. Lines before
 * the first hunk are headers; an empty diff is not comment-only (judge it).
 */
export function commentOnly(diff: string): boolean {
  const lines = diff.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  if (firstHunk === -1) return false;
  return lines
    .slice(firstHunk)
    .filter((line) => line.startsWith('+') || line.startsWith('-'))
    .every((line) => COMMENT_OR_BLANK.test(line.slice(1)));
}
