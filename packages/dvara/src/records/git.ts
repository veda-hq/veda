// Git access for the record gate: one tree (the index at pre-commit, a commit
// in CI) read in batches, so a hundred staged files cost one `cat-file`
// process, not a hundred.
import { execFileSync, spawnSync } from "node:child_process";
import type { TreeContext } from "./types.ts";

/** `:` is the index; anything else is a commit-ish. */
export type TreeRef = string;

export interface Git {
  readonly cwd: string;
  /** Passed whole: under a hook, git's own variables (GIT_INDEX_FILE) matter. */
  readonly env?: NodeJS.ProcessEnv;
}

export const git = (
  repo: Git,
  args: readonly string[],
  input?: string,
): string =>
  execFileSync("git", args, {
    cwd: repo.cwd,
    env: repo.env ?? process.env,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    maxBuffer: 512 * 1024 * 1024,
    // All three piped: stderr goes into the thrown error, not the terminal.
    stdio: "pipe",
  });

/** Runs git with `args` and returns its stdout; throws when git fails. */
export type GitRun = (args: readonly string[]) => string;

export const runner =
  (repo: Git): GitRun =>
  (args) =>
    git(repo, args);

/**
 * A git question whose "no" is exit 1 (`rev-parse --verify --quiet` on a
 * missing ref, `merge-base` with no common ancestor): null. Any other failure
 * is git not answering, and is thrown rather than read as "no".
 */
export const tryGit = (repo: Git, args: readonly string[]): string | null => {
  const result = spawnSync("git", args, {
    cwd: repo.cwd,
    env: repo.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0) return result.stdout;
  if (result.status === 1) return null;
  throw new Error(
    `git ${args[0] ?? ""} failed (${String(result.status ?? result.error)}): ${result.stderr}`,
  );
};

const splitZ = (out: string): string[] => out.split("\0").filter(Boolean);

/** Every path in the tree. */
export const listTree = (repo: Git, ref: TreeRef): string[] =>
  ref === ":"
    ? splitZ(git(repo, ["ls-files", "-z"]))
    : splitZ(git(repo, ["ls-tree", "-r", "-z", "--name-only", ref]));

/**
 * A path the tree lists whose object git cannot read. Nothing about it can be
 * vouched for, so the gate stops rather than read it as absent.
 */
export class UnreadableObject extends Error {
  // A plain field: type stripping has no parameter properties.
  readonly object: string;
  constructor(object: string) {
    super(`${object} is listed but its object cannot be read`);
    this.object = object;
  }
}

/** Of these paths, the ones the tree at `rev` lists (read from the root). */
export const listedIn = (
  repo: Git,
  rev: string,
  paths: readonly string[],
): Set<string> => {
  if (paths.length === 0) return new Set();
  const out = git(repo, [
    "ls-tree",
    "--full-tree",
    "--name-only",
    "-z",
    rev,
    "--",
    ...paths,
  ]);
  const wanted = new Set(paths);
  return new Set(out.split("\0").filter((p) => wanted.has(p)));
};

/** Is `path` in the tree at `rev`? Asks the tree, not the blob. */
export const treeLists = (repo: Git, rev: string, path: string): boolean =>
  listedIn(repo, rev, [path]).has(path);

/**
 * One object question outside the batch: its answer, or null when git has no
 * such object (cat-file exits 128 for a missing name, as the batch says
 * "missing").
 */
const askOne = (repo: Git, args: readonly string[]): string | null => {
  const result = spawnSync("git", args, {
    cwd: repo.cwd,
    env: repo.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
};

/**
 * The byte count in a `git cat-file --batch` header, `<oid> <type> <size>`.
 * Any other header throws: reading on from a wrong size would hand every
 * later blob in the batch the wrong bytes.
 */
export const batchObjectSize = (header: string): number => {
  const field = header.split(" ")[2] ?? "";
  if (!/^\d+$/.test(field))
    throw new Error(`git cat-file --batch: unexpected header "${header}"`);
  return Number(field);
};

/**
 * Contents of many blobs in one process. `names` are `rev:path` object names;
 * a missing one maps to null. Binary content comes back as text and is the
 * caller's to skip.
 */
export const readBlobs = (
  repo: Git,
  names: readonly string[],
): Map<string, string | null> => {
  const out = new Map<string, string | null>();
  // The batch protocol is one name per line: a path with a newline in it is
  // asked on its own.
  const batch = names.filter((name) => !name.includes("\n"));
  for (const name of names.filter((n) => n.includes("\n")))
    out.set(name, askOne(repo, ["cat-file", "blob", name]));
  if (batch.length === 0) return out;
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repo.cwd,
    env: repo.env ?? process.env,
    input: `${batch.join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`git cat-file --batch failed: ${String(result.stderr)}`);
  const buffer = result.stdout;
  let at = 0;
  for (const name of batch) {
    const newline = buffer.indexOf(10, at);
    const header = buffer.subarray(at, newline).toString("utf8");
    at = newline + 1;
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
      out.set(name, null);
      continue;
    }
    const size = batchObjectSize(header);
    out.set(name, buffer.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return out;
};

export const objectName = (ref: TreeRef, path: string): string =>
  ref === ":" ? `:${path}` : `${ref}:${path}`;

/**
 * The object type (commit, tree, blob, tag) of each of these names (ids or
 * `rev:path`) the object store has. git answers one line per name, in order;
 * a found name is echoed as its id, so answers are matched by position.
 */
export const objectTypes = (
  repo: Git,
  names: readonly string[],
): Map<string, string> => {
  const types = new Map<string, string>();
  // One name per line, as in readBlobs: a newline-bearing name goes alone.
  const batch = names.filter((name) => !name.includes("\n"));
  for (const name of names.filter((n) => n.includes("\n"))) {
    const type = askOne(repo, ["cat-file", "-t", name]);
    if (type !== null) types.set(name, type.trim());
  }
  if (batch.length === 0) return types;
  const out = git(repo, ["cat-file", "--batch-check"], `${batch.join("\n")}\n`);
  const lines = out.split("\n");
  batch.forEach((name, i) => {
    // `<oid> <type> <size>` for a found name, `<name> missing|ambiguous`
    // for any other: the type is the field between the first and last space.
    const line = lines[i];
    if (line === undefined || / (missing|ambiguous)$/.test(line)) return;
    types.set(name, line.slice(line.indexOf(" ") + 1, line.lastIndexOf(" ")));
  });
  return types;
};

/**
 * The merge base of `a` with `b`, or with the merge of every one of `b`:
 * `git merge-base A B C` answers for A against a hypothetical merge of B, C.
 */
export const mergeBase = (
  repo: Git,
  a: string,
  ...b: [string, ...string[]]
): string | null => {
  const out = tryGit(repo, ["merge-base", a, ...b]);
  return out === null ? null : out.trim();
};

export const resolveRef = (repo: Git, ref: string): string | null => {
  const out = tryGit(repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return out === null ? null : out.trim();
};

/** What the rules asked git about during a dry pass, to answer in batches. */
export interface Questions {
  readonly shas: Set<string>;
  readonly bases: Set<string>;
}

export const noQuestions = (): Questions => ({
  shas: new Set(),
  bases: new Set(),
});

export interface GitTreeContext extends TreeContext {
  /** The merge base branch rules compare with (see `TreeContext.baseText`). */
  readonly base: string | null | undefined;
  readonly pathExists: (path: string) => boolean;
  /** A listed path's text; null when the tree does not list it. */
  readonly read: (path: string) => string | null;
  /** Answer these questions in one git process per kind. */
  readonly warm: (asked: Questions) => void;
}

/**
 * A context that answers without git and records each question. Running the
 * rules over it first lets `warm` ask git once per kind of question instead
 * of once per file.
 */
export const recordingContext = (
  tree: Pick<GitTreeContext, "base">,
  asked: Questions,
): TreeContext => ({
  typesOf: (shas) => {
    for (const sha of shas) asked.shas.add(sha);
    return new Map(shas.map((sha) => [sha, "commit"]));
  },
  baseText: (path) => {
    if (typeof tree.base !== "string") return tree.base;
    asked.bases.add(path);
    return null;
  },
});

/** A tree context over one git tree, with an optional merge base for branch rules. */
export const treeContext = (
  repo: Git,
  ref: TreeRef,
  base: string | null | undefined,
  /** The path a file had at the base, when the branch renamed it. */
  renamedFrom: (path: string) => string | undefined = () => undefined,
): GitTreeContext => {
  const present = new Set(listTree(repo, ref));
  const cache = new Map<string, string | null>();
  const baseCache = new Map<string, string | null>();
  /** Object type by name; null when the store does not have it. */
  const objects = new Map<string, string | null>();

  const readInto = (
    into: Map<string, string | null>,
    rev: string,
    wanted: readonly string[],
  ): void => {
    const missing = wanted.filter((path) => !into.has(path));
    const names = missing.map((path) => objectName(rev, path));
    const blobs = readBlobs(repo, names);
    missing.forEach((path, i) =>
      into.set(path, blobs.get(names[i] ?? "") ?? null),
    );
  };
  const probe = (names: readonly string[]): void => {
    const missing = [...new Set(names)].filter((name) => !objects.has(name));
    if (missing.length === 0) return;
    const types = objectTypes(repo, missing);
    for (const name of missing) objects.set(name, types.get(name) ?? null);
  };
  // Base texts are read under the base-side path and cached by head path.
  const readBases = (rev: string, wanted: readonly string[]): void => {
    const missing = wanted.filter((path) => !baseCache.has(path));
    if (missing.length === 0) return;
    const direct = new Map<string, string | null>();
    readInto(direct, rev, missing);
    const renamed = missing.filter((path) => direct.get(path) === null);
    const sources = new Map<string, string>();
    for (const path of renamed) {
      const from = renamedFrom(path);
      if (from !== undefined) sources.set(path, from);
    }
    const old = new Map<string, string | null>();
    readInto(old, rev, [...new Set(sources.values())]);
    // Absent is what the base tree does not list: a listed path whose blob
    // cannot be read is a broken store, not a file the branch adds.
    const unread = [
      ...renamed,
      ...[...sources.values()].filter((from) => old.get(from) === null),
    ];
    const listed = listedIn(repo, rev, [...new Set(unread)]);
    const broken = unread.find((p) => listed.has(p));
    if (broken !== undefined) throw new UnreadableObject(`${rev}:${broken}`);
    for (const path of missing) {
      const from = sources.get(path);
      baseCache.set(
        path,
        direct.get(path) ??
          (from === undefined ? null : (old.get(from) ?? null)),
      );
    }
  };
  return {
    base,
    pathExists: (path) => present.has(path),
    read: (path) => {
      if (!present.has(path)) return null;
      readInto(cache, ref, [path]);
      const text = cache.get(path) ?? null;
      // Listed but unreadable is a broken store, not an absent file.
      if (text === null) throw new UnreadableObject(objectName(ref, path));
      return text;
    },
    typesOf: (shas) => {
      probe(shas);
      const types = new Map<string, string>();
      for (const sha of shas) {
        const type = objects.get(sha);
        if (type) types.set(sha, type);
      }
      return types;
    },
    baseText: (path) => {
      if (typeof base !== "string") return base;
      readBases(base, [path]);
      return baseCache.get(path) ?? null;
    },
    warm: (asked) => {
      if (typeof base === "string") readBases(base, [...asked.bases]);
      probe([...asked.shas]);
    },
  };
};
