/**
 * A sandbox for a test that runs hooks under dvara as a separate process.
 *
 * dvara roots a run at its working directory and writes history.jsonl, its
 * stage files and the watchdog's hang dumps under the config's historyDir
 * there. Each sandbox is a fresh temp directory with its own .dvara.json, so
 * a run's rows and dumps land in it and nowhere else, and removing the
 * directory removes all of them.
 *
 * `node <cli> run <hook> [args]`, with `cwd: dir`, is `dvara run` from this
 * package's own source, not an installed release.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUILT_IN_WATCHDOG, CONFIG_FILE, DEFAULTS } from "./config.ts";

/** dvara's command line, from this source tree. */
export const DVARA_CLI = resolve(import.meta.dirname, "cli.ts");

/** The stage helpers a hook sources. */
export const STAGE_HELPERS = resolve(
  import.meta.dirname,
  "..",
  "shell",
  "stages.sh",
);

export interface SupervisorSandbox {
  /** The sandbox root: what dvara roots its runs at. */
  readonly dir: string;
  /** The temp folder for the hooks run there, so what a killed child leaves goes with the sandbox. */
  readonly tmp: string;
  readonly history: string;
  readonly hangs: string;
}

/**
 * A fresh temp directory whose .dvara.json attaches the built-in watchdog.
 * The path is canonical (on macOS tmpdir() is behind the /var → /private/var
 * symlink), so paths dvara prints compare equal to the ones returned here.
 */
export function supervisorSandbox(prefix: string): SupervisorSandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  writeFileSync(
    join(dir, CONFIG_FILE),
    `${JSON.stringify({ watchdog: BUILT_IN_WATCHDOG })}\n`,
  );
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  const output = join(dir, DEFAULTS.historyDir);
  return {
    dir,
    tmp,
    history: join(output, "history.jsonl"),
    hangs: join(output, "hangs"),
  };
}
