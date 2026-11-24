// `dvara review-size --cap N [--ignore GLOB]… [--base REF]`, for a pre-push
// hook. An AI reviewer skips a pull request over its line cap (Cubic's is
// 50,000 reviewable lines) with a "skipped" check, and a merge rule that
// needs its pass can then never be met. The branch is cheaper to split
// before the pull request opens than after. This counts the lines the branch
// changes outside the reviewer's ignore globs and warns over the cap. It
// never refuses: a branch may be meant to go unreviewed.
import { matchesGlob } from "node:path";
import { git, resolveRef, type Git } from "./records/git.ts";

export const USAGE =
  "usage: dvara review-size --cap N [--ignore GLOB]… [--base REF]";

export interface ReviewSizeArgs {
  readonly cap: number;
  readonly ignore: readonly string[];
  readonly base: string | null;
}

export const parseArgs = (
  args: readonly string[],
): ReviewSizeArgs | { error: string } => {
  let cap: number | null = null;
  let base: string | null = null;
  const ignore: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg !== "--cap" && arg !== "--ignore" && arg !== "--base")
      return { error: `unknown argument ${String(arg)}` };
    if (value === undefined || value === "")
      return { error: `${arg} takes a value` };
    i += 1;
    if (arg === "--ignore") ignore.push(value);
    else if (arg === "--base") base = value;
    else {
      if (!/^[1-9]\d*$/.test(value))
        return { error: "--cap takes a positive whole number of lines" };
      cap = Number(value);
    }
  }
  if (cap === null) return { error: "give --cap" };
  return { cap, ignore, base };
};

export interface Size {
  /** Lines added plus lines deleted, outside the ignore globs. */
  readonly lines: number;
  /** The files counted, with their lines, largest first. */
  readonly files: readonly { path: string; lines: number }[];
}

/** A numstat count: a binary file's `-`, or a field the entry lacks, counts nothing. */
const count = (field: string | undefined): number =>
  Number.parseInt(String(field), 10) || 0;

/**
 * The size of `git diff --numstat -z` output: binary files (`-`) count no
 * lines, and a path any `ignore` glob matches is left out. A rename's entry
 * is `<added>\t<deleted>\t` then the old and the new path; it is counted
 * under the new one.
 */
export const sizeOf = (numstat: string, ignore: readonly string[]): Size => {
  // One iterator, read both by the loop and inside it: a rename's two paths
  // are taken from it below, so the loop resumes at the entry after them.
  const fields = numstat.split("\0").values();
  const files: { path: string; lines: number }[] = [];
  for (const entry of fields) {
    if (entry === "") continue;
    const [added, deleted, inline] = entry.split("\t");
    let path = inline;
    if (!path) {
      // A rename: the old path and the new one follow; skip the old, take the new.
      fields.next();
      path = fields.next().value ?? "";
    }
    if (ignore.some((glob) => matchesGlob(path, glob))) continue;
    files.push({ path, lines: count(added) + count(deleted) });
  }
  files.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  return { lines: files.reduce((sum, file) => sum + file.lines, 0), files };
};

/** The first of `refs` that resolves, or null. */
export const firstBase = (repo: Git, refs: readonly string[]): string | null =>
  refs.find((ref) => resolveRef(repo, ref) !== null) ?? null;

/** The size of `base...HEAD`: what a pull request into `base` would show. */
export const branchSize = (
  repo: Git,
  base: string,
  ignore: readonly string[],
): Size =>
  sizeOf(
    git(repo, ["diff", "--numstat", "-z", "--find-renames", `${base}...HEAD`]),
    ignore,
  );

/** How many of the largest files the warning names. */
const LARGEST = 5;

/** The warning for a branch over `cap`; empty when it is not over. */
export const warning = (size: Size, cap: number, base: string): string[] =>
  size.lines <= cap
    ? []
    : [
        `⚠ review-size: this branch changes ${String(size.lines)} lines against ${base} outside the reviewer's ignore globs, over its cap of ${String(cap)}: the reviewer will skip the pull request, and a merge rule that needs its pass can never be met.`,
        "  Split it before the pull request opens, by workspace: rebuild each branch from this tree by path, and check `git diff --stat <this branch> HEAD -- <workspace>` is empty for each. Largest files:",
        ...size.files
          .slice(0, LARGEST)
          .map(({ path, lines }) => `    ${String(lines)} ${path}`),
      ];
