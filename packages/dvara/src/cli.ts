#!/usr/bin/env node
// dvara: git hooks with cheap checks at commit and expensive ones once at push.
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configName, loadConfig } from "./config.ts";
import {
  frozen,
  parseArgs as parseFrozenArgs,
  USAGE as FROZEN_USAGE,
} from "./records/frozen.ts";
import {
  parseArgs as parseRecordsArgs,
  records,
  USAGE as RECORDS_USAGE,
} from "./records/gate.ts";
import { runner } from "./records/git.ts";
import { listFor, readStageLists } from "./stages.ts";
import { supervise, type Options } from "./supervisor.ts";

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const USAGE = [
  "usage: dvara run <hook-file> [hook args…]   run a git hook under the supervisor",
  "       dvara stages <hook>                  the hook stages the config lists, one per line",
  "       dvara shell <stages|keep-going>      the path of a shell helper to source",
  "       dvara records <--staged | --all [--base REF] [--write-baseline | --survey] | --base REF>",
  "                                            the record gate: no new non-durable paths, a baseline that only falls",
  "       dvara frozen <--staged | --base REF [--head REF]>",
  "                                            refuse changes to the frozen paths",
  "       dvara --version",
].join("\n");

const SHELL_HELPERS = new Set(["stages", "keep-going"]);

export const ownVersion = (): string => {
  const pkg = join(import.meta.dirname, "..", "package.json");
  return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
};

/** The path of a shell helper this package ships. */
export const shellHelper = (name: string): string =>
  resolve(import.meta.dirname, "..", "shell", `${name}.sh`);

export interface Context {
  readonly io: Io;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly supervise?: typeof supervise;
  readonly options?: Partial<Options>;
}

/**
 * `dvara records` or `dvara frozen` at the root `cwd`: 2 on bad arguments, a
 * config it cannot read, or git failing.
 */
const checkCommand = (
  command: "records" | "frozen",
  args: readonly string[],
  { io, cwd, env }: Context,
): number => {
  const parsed =
    command === "records" ? parseRecordsArgs(args) : parseFrozenArgs(args);
  if ("error" in parsed) {
    io.err(`dvara ${command}: ${parsed.error}`);
    io.err(command === "records" ? RECORDS_USAGE : FROZEN_USAGE);
    return 2;
  }
  try {
    const config = loadConfig(cwd, env);
    const repo = { cwd, env };
    if ("mode" in parsed)
      return records(parsed, repo, io.out, {
        records: config.records,
        baseRefs: config.baseRefs,
        own: [configName(env)],
      });
    const result = frozen(parsed, runner(repo), config.records.frozen, env);
    for (const line of result.stdout) io.out(line);
    for (const line of result.stderr) io.err(line);
    return result.code;
  } catch (error) {
    io.err(`dvara ${command}: ${(error as Error).message}`);
    return 2;
  }
};

/** Runs one command; resolves with the process's exit code. */
export const run = async (
  argv: readonly string[],
  context: Context,
): Promise<number> => {
  const { io, cwd, env } = context;
  const [command, ...rest] = argv;
  if (command === "--version") {
    io.out(ownVersion());
    return 0;
  }
  if (
    command === "shell" &&
    rest.length === 1 &&
    SHELL_HELPERS.has(rest[0] ?? "")
  ) {
    io.out(shellHelper(rest[0] ?? ""));
    return 0;
  }
  if (command === "records" || command === "frozen")
    return checkCommand(command, rest, context);
  if (
    (command === "run" && rest.length > 0) ||
    (command === "stages" && rest.length === 1)
  ) {
    // Git runs every hook at the top of the working tree.
    let config;
    try {
      config = loadConfig(cwd, env);
    } catch (error) {
      io.err((error as Error).message);
      return 2;
    }
    if (command === "stages") {
      let lists;
      try {
        lists = readStageLists(cwd, config);
      } catch (error) {
        io.err((error as Error).message);
        return 2;
      }
      for (const name of lists ? (listFor(lists, rest[0] ?? "") ?? []) : [])
        io.out(name);
      return 0;
    }
    return (context.supervise ?? supervise)(rest, {
      ...context.options,
      root: cwd,
      config,
      env,
    });
  }
  io.err(USAGE);
  return 2;
};

/** Whether this module is the script node was asked to run, through any symlink. */
export const isEntry = (
  entry: string | undefined,
  moduleUrl: string,
): boolean => {
  if (!entry) return false;
  try {
    return (
      realpathSync(resolve(entry)) === realpathSync(fileURLToPath(moduleUrl))
    );
  } catch {
    return false;
  }
};

/** The process's own output, one line per call. */
export const processIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), {
    io: processIo,
    cwd: process.cwd(),
    env: process.env,
  });
}
