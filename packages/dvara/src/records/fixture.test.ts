// Throwaway repositories for the record tests. No tests of its own: a
// `.test.ts` name keeps it out of the build and the coverage figures.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * This process's environment without git's own variables (a test run from a
 * hook inherits GIT_DIR and GIT_INDEX_FILE) or the user's git config.
 */
export const hermeticEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

export interface Repo {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly git: (...args: string[]) => string;
  readonly write: (path: string, text: string) => void;
  /** Stage everything and commit it. */
  readonly commit: (message: string) => void;
  /** The loose object behind `name`, deleted: the tree still lists it. */
  readonly breakObject: (name: string) => void;
}

/** A new repository on `main` with no commits. */
export const repo = (prefix = "dvara-records-"): Repo => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const r = at(root);
  r.git("init", "-q", "-b", "main");
  return r;
};

/**
 * A copy of the repository `make` builds, made once: each test gets its own
 * repository for a directory copy instead of a dozen git processes.
 */
export const template = (make: () => Repo): (() => Repo) => {
  let built: Repo | undefined;
  return () => {
    built ??= make();
    const root = mkdtempSync(join(tmpdir(), "dvara-copy-"));
    cpSync(built.root, root, { recursive: true });
    return at(root);
  };
};

const at = (root: string): Repo => {
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: root,
      env: hermeticEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  return {
    root,
    env: hermeticEnv,
    git,
    write,
    commit: (message) => {
      git("add", "-A");
      git("commit", "-q", "-m", message);
    },
    breakObject: (name) => {
      const id = git("rev-parse", name).trim();
      rmSync(join(root, ".git", "objects", id.slice(0, 2), id.slice(2)));
    },
  };
};
