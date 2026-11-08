// Who started a run and on what machine: facts for the history row only.
import { execFileSync } from "node:child_process";

type Exec = (file: string, args: readonly string[]) => string;

const run: Exec = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", timeout: 5000 });

/**
 * A preflight runs the pre-push hook ahead of a push but is not one: its rows
 * get their own kind, so a reader of push rows never counts it. Git always
 * passes a real push its remote, so one that inherited the mode stays a push.
 */
export const hookKind = (
  hookName: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string =>
  hookName === "pre-push" && env.DVARA_MODE === "preflight" && args.length === 0
    ? "preflight"
    : hookName;

/** Parent of each pid in a `ps -axo pid=,ppid=,comm=` table. */
export const processTable = (
  text: string,
): Map<number, { parent: number; command: string }> => {
  const parents = new Map<number, { parent: number; command: string }>();
  for (const line of text.trim().split("\n")) {
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    // A digit run too long for a number is no process.
    if (!Number.isFinite(pid) || !Number.isFinite(parent)) continue;
    parents.set(pid, { parent, command: match[3] ?? "" });
  }
  return parents;
};

/**
 * Who started this run: a benchmark, a background preflight, git, or a person
 * (a parent chain that ends at init without passing git).
 */
export const invocationContext = (
  kind: string,
  env: NodeJS.ProcessEnv,
  ppid: number,
  exec: Exec = run,
): string => {
  if (env.DVARA_MEASUREMENT_CONTEXT === "manual-benchmark")
    return "manual-benchmark";
  // A detached background preflight's parent chain ends at init.
  if (kind === "preflight" && env.DVARA_BACKGROUND === "1") return "background";
  try {
    const parents = processTable(exec("ps", ["-axo", "pid=,ppid=,comm="]));
    const seen = new Set<number>();
    let pid = ppid;
    for (
      let entry = parents.get(pid);
      entry && !seen.has(pid);
      entry = parents.get(pid)
    ) {
      seen.add(pid);
      if (/(?:^|\/)git$/.test(entry.command)) return "git-hook";
      pid = entry.parent;
    }
    return pid <= 1 ? "manual" : "unknown";
  } catch {
    return "unknown";
  }
};

/** The CPU's performance-level names (macOS only), for a watchdog's mode. */
export const perfLevelNames = (
  platform: NodeJS.Platform,
  exec: Exec = run,
): string[] => {
  if (platform !== "darwin") return [];
  try {
    const levels = Number(exec("sysctl", ["-n", "hw.nperflevels"]));
    if (!Number.isFinite(levels)) return [];
    return Array.from({ length: levels }, (_, i) =>
      exec("sysctl", ["-n", `hw.perflevel${i}.name`]).trim(),
    );
  } catch {
    return [];
  }
};
