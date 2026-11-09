// `dvara frozen`: frozen paths refuse changes. Nothing adds, changes or
// deletes a file under one of `records.frozen.paths`, except the exact paths
// `records.frozen.except` keeps editable.
//
//   --staged               pre-commit, merge commits included: what the index
//                          changes against HEAD. In a merge, a path staged
//                          exactly as a merged-in parent has it is that
//                          parent's change, judged where it was made, and
//                          passes; content no parent had (a hand resolution)
//                          counts. The branch check sees the rest.
//   --base REF [--head REF]
//                          the branch check: what HEAD (or --head) changes
//                          since its merge base with REF.
//
// Exit 0: no frozen path changes. 1: refused. 2: could not run.
import { existsSync, readFileSync } from "node:fs";
import { parseArgs as parseFlags } from "node:util";
import type { FrozenPaths } from "../config.ts";
import type { GitRun } from "./git.ts";
import { isFrozenPath } from "./scope.ts";

export type Mode =
  | { readonly kind: "staged" }
  | { readonly kind: "range"; readonly base: string; readonly head: string };

export const USAGE = "usage: dvara frozen --staged | --base REF [--head REF]";

/** The mode `args` ask for, or what is wrong with them. */
export const parseArgs = (
  args: readonly string[],
): Mode | { error: string } => {
  let values;
  try {
    ({ values } = parseFlags({
      args: [...args],
      options: {
        staged: { type: "boolean" },
        base: { type: "string" },
        head: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { error: (error as Error).message };
  }
  const { staged, base, head } = values;
  if (staged && base === undefined && head === undefined)
    return { kind: "staged" };
  if (!staged && base !== undefined)
    return { kind: "range", base, head: head ?? "HEAD" };
  return { error: "give --staged, or --base REF [--head REF]" };
};

export interface Change {
  /** git's status letter: A, M, D or T (renames are split, `--no-renames`). */
  readonly status: string;
  readonly path: string;
}

/** `git diff --name-status -z` output, as status and path pairs. */
export const parseNameStatus = (out: string): Change[] => {
  const fields = out.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2)
    changes.push({ status: fields[i] ?? "", path: fields[i + 1] ?? "" });
  return changes;
};

const DIFF = ["diff", "--name-status", "--no-renames", "-z"] as const;

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const GITHEAD = "GITHEAD_";

type Env = Readonly<Record<string, string | undefined>>;

/** The SHA lines of the git-dir file `name`; none when it is absent. */
const gitFileShas = (git: GitRun, name: string): string[] => {
  const file = git([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    name,
  ]).trim();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => SHA.test(line));
};

/** The tree of git's own clean merge of HEAD and `head`; none on a conflict. */
export const mergedTree = (git: GitRun, head: string): string | undefined => {
  try {
    return git(["merge-tree", "--write-tree", "--no-messages", "HEAD", head])
      .split("\n")[0]
      ?.trim();
  } catch {
    // merge-tree exits 1 on a conflict; with no clean merge to compare,
    // `head` is not trusted, the stricter answer.
    return undefined;
  }
};

/**
 * Whether the index is exactly a clean merge of HEAD and `heads`, so it holds
 * no content those commits do not: the tree git's default strategy writes to
 * AUTO_MERGE before pre-merge-commit runs, or, for one merged commit under any
 * strategy, git's own merge of HEAD and it.
 */
export const isCleanMerge = (
  git: GitRun,
  heads: readonly string[],
): boolean => {
  const trees = gitFileShas(git, "AUTO_MERGE");
  const [only] = heads;
  if (heads.length === 1 && only !== undefined) {
    const tree = mergedTree(git, only);
    if (tree !== undefined) trees.push(tree);
  }
  return trees.some(
    (tree) => git(["diff", "--cached", "--name-only", tree]) === "",
  );
};

/**
 * The commits a merge in progress takes in; none outside a merge. A merge
 * finished by `git commit` lists them in MERGE_HEAD. A clean `git merge` runs
 * pre-merge-commit before it writes MERGE_HEAD, and names each merged commit
 * only in the `GITHEAD_<sha>` variable it sets for its hooks. Anyone can set
 * such a variable, so those commits count only when the index is a clean
 * merge of them.
 */
export const mergeHeads = (git: GitRun, env: Env): string[] => {
  const heads = new Set(gitFileShas(git, "MERGE_HEAD"));
  const named = Object.keys(env)
    .filter((name) => name.startsWith(GITHEAD))
    .map((name) => name.slice(GITHEAD.length))
    .filter((sha) => SHA.test(sha));
  if (isCleanMerge(git, named)) for (const sha of named) heads.add(sha);
  return [...heads];
};

/** What `mode` changes, before the frozen filter. */
export const changes = (git: GitRun, mode: Mode, env: Env = {}): Change[] => {
  if (mode.kind === "range")
    return parseNameStatus(git([...DIFF, `${mode.base}...${mode.head}`]));
  const staged = parseNameStatus(git([...DIFF, "--cached"]));
  const kept = mergeHeads(git, env).map(
    (sha) =>
      new Set(
        parseNameStatus(git([...DIFF, "--cached", sha])).map((c) => c.path),
      ),
  );
  return staged.filter((change) =>
    kept.every((paths) => paths.has(change.path)),
  );
};

export interface Report {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

/** The verdict on `frozen`, the frozen changes of `mode`. */
export const report = (
  mode: Mode,
  frozen: readonly Change[],
  paths: FrozenPaths,
): Report => {
  if (frozen.length === 0)
    return {
      code: 0,
      stdout: ["✅ frozen: no frozen path changes"],
      stderr: [],
    };
  const undo =
    mode.kind === "staged"
      ? "Unstage them (git restore --staged -- <path>), then commit again."
      : `Drop them from the branch: restore each path to its ${mode.base} content.`;
  return {
    code: 1,
    stdout: [],
    stderr: [
      `❌ frozen: ${mode.kind === "staged" ? "this commit" : `this branch (since ${mode.base})`} changes ${frozen.length} file(s) under ${paths.paths.join(", ")}:`,
      ...frozen.map((change) => `     ${change.status} ${change.path}`),
      "   These paths are frozen: no file there is added, changed or deleted.",
      ...(paths.except.length === 0
        ? []
        : [`   Still editable: ${paths.except.join(", ")}.`]),
      `   ${undo}`,
    ],
  };
};

/** The verdict for `mode` in the repository `git` runs in; a failing git throws. */
export const frozen = (
  mode: Mode,
  git: GitRun,
  paths: FrozenPaths,
  env: Env = {},
): Report => {
  // Nothing frozen: nothing to ask git.
  if (paths.paths.length === 0)
    return { code: 0, stdout: ["✅ frozen: no paths are frozen"], stderr: [] };
  return report(
    mode,
    changes(git, mode, env).filter((change) =>
      isFrozenPath(change.path, paths),
    ),
    paths,
  );
};
