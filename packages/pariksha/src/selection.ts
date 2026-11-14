// Which files a check that judges a list reads, when the caller names a
// stage instead of a list: the index (`--staged`), a branch or range
// (`--base <ref> [--head <ref>]`), or every tracked file (`--all`).
//
// Deleted files are not listed: nothing is left to read. A rename lists its
// new path. Symlinks and submodules are skipped, as every listing here skips
// them. A git that fails stops the check: a listing that failed must never
// read as "no files".
//
// A change to the check's own settings (its `.pariksha.json` entry, or the
// file the entry or `--config` names) judges every file: a tightened check
// must meet the code it did not change, and a change of settings alone would
// otherwise check nothing.
import { lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { must, PLAIN_DIFF, type Git } from './git.ts';

export type Selection = { readonly kind: 'staged' } | { readonly kind: 'range'; readonly base: string; readonly head: string } | { readonly kind: 'all' };

/** The selection `f` names, undefined for none, or why the flags do not name one. */
export const selectionOf = (f: ReadonlyMap<string, string>): Selection | undefined | { readonly error: string } => {
  const named = ['--staged', '--base', '--all', '--files-from'].filter((name) => f.has(name));
  if (named.length > 1) return { error: `choose one of --staged, --base, --all, --files-from (got ${named.join(', ')})` };
  const head = f.get('--head');
  const base = f.get('--base');
  if (head !== undefined && base === undefined) return { error: '--head needs --base' };
  if (base !== undefined) return { kind: 'range', base, head: head ?? 'HEAD' };
  if (f.has('--staged')) return { kind: 'staged' };
  if (f.has('--all')) return { kind: 'all' };
  return undefined;
};

/** `ref` as a commit git has; a name starting with a dash would be read as an option. */
const commitOf = (git: Git, ref: string): string => {
  if (ref.startsWith('-')) throw new Error(`${ref} is not a ref: it starts with a dash`);
  const commit = git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])?.trim();
  if (!commit) throw new Error(`${ref} names no commit here`);
  return commit;
};

const split = (out: string): string[] => out.split('\0').filter(Boolean);

/** The paths a selection changes, relative to the top level, deleted ones left out. */
export const changedPaths = (git: Git, selection: Exclude<Selection, { kind: 'all' }>): string[] => {
  if (selection.kind === 'staged') return split(must(git, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT', ...PLAIN_DIFF]));
  const base = commitOf(git, selection.base);
  const head = commitOf(git, selection.head);
  return split(must(git, ['diff', '--name-only', '-z', '--diff-filter=ACMRT', ...PLAIN_DIFF, `${base}...${head}`]));
};

/** Whether `path` under `top` is a regular file: not a symlink, a submodule or gone. */
const isFile = (top: string, path: string): boolean => {
  try {
    return lstatSync(join(top, path)).isFile();
  } catch {
    // fail-open: a path gone from the working tree has nothing to read, and is left out as a deletion is.
    return false;
  }
};

/**
 * The files `selection` names under the repository at `top`, absolute and
 * NUL-separated, as a `--files-from` list holds them. `settings` are the
 * absolute paths of the check's own settings: a selection that changes one
 * lists every tracked file instead.
 */
export const selectedList = (git: Git, top: string, selection: Selection, settings: readonly string[]): string => {
  const all = (): string[] => split(must(git, ['ls-files', '-z']));
  let paths: string[];
  if (selection.kind === 'all') paths = all();
  else {
    paths = changedPaths(git, selection);
    const own = new Set(settings.map((s) => relative(top, s)));
    if (paths.some((p) => own.has(p))) paths = all();
  }
  return paths
    .filter((p) => isFile(top, p))
    .map((p) => join(top, p))
    .join('\0');
};
