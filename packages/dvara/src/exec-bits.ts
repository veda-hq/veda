// `dvara exec-bits --staged [--refuse]`, for a pre-commit hook. A tool that
// rewrites files and puts them back (Stryker's in-place restore, an editor's
// save-as, a copy through a filesystem that keeps no modes) can drop the
// executable bit on a file whose content it left as it was. `git status`
// shows the file modified, `git add -A` stages a 100755 → 100644 change, and
// the script then fails with "permission denied" for everyone who checks it
// out. This finds such entries in the index, so the hook can stop them.
//
// A new hook refusal warns first (veda's lessons: a refusal that fires wrongly
// costs every commit), so it warns unless `--refuse` is given.
import { spawnSync } from "node:child_process";
import type { Git } from "./records/git.ts";

export const USAGE = "usage: dvara exec-bits --staged [--refuse]";

export interface Dropped {
  readonly path: string;
}

/**
 * The staged entries that went from 100755 to 100644 with the same blob:
 * `git diff --cached --raw -z` gives `:<old mode> <new mode> <old> <new>
 * <status>` and then the path, NUL-separated.
 */
export const droppedBits = (raw: string): Dropped[] => {
  const fields = raw.split("\0");
  const dropped: Dropped[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const header = String(fields[i]);
    const path = String(fields[i + 1]);
    const [oldMode, newMode, oldId, newId, status] = header
      .replace(/^:/, "")
      .split(" ");
    if (
      status === "M" &&
      oldMode === "100755" &&
      newMode === "100644" &&
      oldId === newId
    )
      dropped.push({ path });
  }
  return dropped;
};

/** The staged entries whose executable bit was dropped, or why git could not say. */
export const stagedDroppedBits = (repo: Git): Dropped[] | { error: string } => {
  const result = spawnSync(
    "git",
    ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames"],
    {
      cwd: repo.cwd,
      env: repo.env ?? process.env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status === 0) return droppedBits(result.stdout);
  return {
    error: `git diff failed (${String(result.status ?? result.error)}): ${result.stderr.trim()}`,
  };
};

export const ADVICE =
  "The content is unchanged, so this is a tool dropping the bit (Stryker's in-place restore does), not an edit. Put it back with `git update-index --chmod=+x <path>` (and `chmod +x <path>`).";

/** The report for `dropped`: a warning, or with `refuse` a refusal. */
export const report = (
  dropped: readonly Dropped[],
  refuse: boolean,
): string[] => [
  `${refuse ? "❌" : "⚠"} exec-bits: ${String(dropped.length)} staged file(s) lose the executable bit (100755 → 100644) with no change to their content:`,
  ...dropped.map(({ path }) => `  ${path}`),
  `  ${ADVICE}`,
];

export const parseArgs = (
  args: readonly string[],
): { refuse: boolean } | { error: string } => {
  const known = new Set(["--staged", "--refuse"]);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown !== undefined) return { error: `unknown argument ${unknown}` };
  if (!args.includes("--staged")) return { error: "give --staged" };
  return { refuse: args.includes("--refuse") };
};
