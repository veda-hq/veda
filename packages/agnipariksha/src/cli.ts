/**
 * agnipariksha: a mutation gate over stock StrykerJS. The bin, bin.ts, only
 * calls `entry` here.
 *
 * Usage: agnipariksha [--base <sha>] [--files a,b] [--lane <name>[,<name>]]... [--tracked-only] [--pushed-refs] [--no-reuse]
 * The lanes come from agnipariksha.json at the repository root (config.ts);
 * `--lane`, repeatable, runs only the lanes it names. `--tracked-only` leaves
 * out untracked files, which a push does not carry. `--pushed-refs` reads
 * git's pre-push ref lines on stdin and refuses a push of anything but the
 * checked-out HEAD from a clean tracked tree (pushed-refs.ts).
 * Exit: 0 pass, 1 a blocking mutant, 2 refused or unable to judge.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { dirname, join, resolve } from 'node:path';

import { lanesOf, loadConfig, type Config } from './config.ts';
import { changedFiles, commentOnly, entries, type Git } from './changed-files.ts';
import { judgeLane, MARKERS, overCutoff, planLane, type Lane, type LaneDeps, type LaneResult, type Plan } from './lanes.ts';
import { acquireLock, pidAlive, type LockDeps } from './machine-lock.ts';
import { checkPushedRefs, type PushCheck } from './pushed-refs.ts';
import { incrementalKey, keyInputPaths, type KeyPolicy } from './reuse-key.ts';
import { failedTestReader } from './failed-tests.ts';
import { notTheOwner, ownerOf, siblingSuites, type Exists } from './suite-owner.ts';
import { formatBlocking } from './verdict.ts';

export const REPORTS_DIR = 'reports/agnipariksha';
export const LOCK_FILE = 'agnipariksha.lock';
export const STRYKER_BIN = 'node_modules/.bin/stryker';

export interface Args {
  base?: string;
  files?: string[];
  /** The lanes `--lane` names, in the order given; absent means every lane. */
  lanes?: string[];
  reuse: boolean;
  /** Leave out untracked files: a push carries none (pre-push passes it). */
  trackedOnly: boolean;
  /** Read git's pre-push ref lines on stdin, and judge only a push of HEAD from a clean tracked tree. */
  pushedRefs: boolean;
}

const list = (value: string): string[] => value.split(',').filter((item) => item !== '');

export function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { reuse: true, trackedOnly: false, pushedRefs: false };
  // The loop steps itself, so no change to its body can make it spin in place.
  let isValue = false;
  for (const [i, flag] of argv.entries()) {
    if (isValue) {
      isValue = false;
      continue;
    }
    const value = argv[i + 1];
    if (flag === '--no-reuse') args.reuse = false;
    else if (flag === '--tracked-only') args.trackedOnly = true;
    else if (flag === '--pushed-refs') args.pushedRefs = true;
    else if ((flag === '--base' || flag === '--files' || flag === '--lane') && value !== undefined && !value.startsWith('--')) {
      isValue = true;
      if (flag === '--base') args.base = value;
      else if (flag === '--files') args.files = list(value);
      else if (list(value).length === 0) return '--lane names no lane';
      else args.lanes = [...(args.lanes ?? []), ...list(value)];
    } else return `unsupported or incomplete argument "${flag}"`;
  }
  return args;
}

/** The config's lanes that `names` picks, in the config's order, or why a name is refused. */
export function selectLanes(lanes: readonly Lane[], names: readonly string[] | undefined): readonly Lane[] | string {
  if (names === undefined) return lanes;
  const known = new Set(lanes.map((lane) => lane.name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return `--lane names no lane in agnipariksha.json: ${unknown.map((name) => `"${name}"`).join(', ')} (its lanes: ${[...known].map((name) => `"${name}"`).join(', ')})`;
  }
  return lanes.filter((lane) => names.includes(lane.name));
}

export interface CliDeps extends Omit<LaneDeps, 'reuseKey'> {
  git: Git;
  exists: Exists;
  /** Whether an absolute path exists, readable or not. */
  pathExists: (absolutePath: string) => boolean;
  lock: LockDeps;
  pid: number;
  lanes: readonly Lane[];
  /** The ref a push is compared with (the config's `upstream`). */
  upstream: string;
  keyPolicy: KeyPolicy;
  /** Run `fn` when the process exits, signals included. */
  atExit: (fn: () => void) => void;
  log: (line: string) => void;
  /** All of stdin: git's pre-push ref lines, read only under `--pushed-refs`. */
  readStdin: () => string;
}

/**
 * Why no run may judge now, or null: a merge stopped before its commit
 * (`MERGE_HEAD` exists). Its working tree is half-merged and is judged
 * against the merge-base, so the verdict would say nothing about the branch.
 * `--git-path` is relative to the root in a plain repository and absolute in
 * a linked worktree. A `MERGE_HEAD` that exists but cannot be read refuses
 * too: the tree may still be half-merged.
 */
export function unfinishedMerge(
  git: Git,
  root: string,
  readFile: (path: string) => string | undefined,
  pathExists: (absolutePath: string) => boolean,
): string | null {
  const gitPath = (name: string): string => resolve(root, git(['rev-parse', '--git-path', name]).trim());
  const headPath = gitPath('MERGE_HEAD');
  if (!pathExists(headPath)) return null;
  const sha = readFile(headPath)?.trim().split(/\s/)[0] ?? '';
  const subject = ((readFile(gitPath('MERGE_MSG')) ?? '').split('\n')[0] as string).trim();
  const merge = `${subject === '' ? 'a merge' : `"${subject}"`} (${sha === '' ? `${headPath}, unreadable` : `MERGE_HEAD ${sha.slice(0, 12)}`})`;
  return `${merge} is not committed: the working tree is half-merged, so a verdict now would say nothing about the branch. Commit the merge (git commit) or abort it (git merge --abort), then run again`;
}

export function summaryLine(plan: Plan, result: LaneResult): string {
  const { judgement: j } = result;
  const statuses = Object.entries(j.byStatus).map(([status, count]) => `${count} ${status}`).join(', ');
  const verdict = result.refusals.length > 0 ? 'REFUSED' : j.blocking.length > 0 ? `${j.blocking.length} blocking` : 'pass';
  return `${plan.lane.name}: ${j.caught} killed of ${j.counted} in ${plan.targets.length} file(s) (${statuses || 'no mutants'}; ${result.retried} timeout(s) retried) - ${verdict}`;
}

export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    deps.log(`agnipariksha REFUSED: ${args}`);
    return 2;
  }
  const lanes = selectLanes(deps.lanes, args.lanes);
  if (typeof lanes === 'string') {
    deps.log(`agnipariksha REFUSED: ${lanes}`);
    return 2;
  }
  if (args.pushedRefs) {
    // Before the lock, as a merge's refusal is: a run that only refuses never waits.
    let push: PushCheck;
    try {
      push = checkPushedRefs(deps.readStdin(), deps.git);
    } catch (error: unknown) {
      // fail-open: ref lines that cannot be read, or shas git cannot resolve, refuse (exit 2).
      deps.log(`agnipariksha REFUSED: ${(error as Error).message}`);
      return 2;
    }
    if (push.verdict === 'refuse') {
      deps.log(`agnipariksha REFUSED: ${push.reason}`);
      return 2;
    }
    if (push.verdict === 'nothing') {
      deps.log(push.line);
      return 0;
    }
  }
  let merging: string | null;
  try {
    merging = unfinishedMerge(deps.git, deps.root, deps.readFile, deps.pathExists);
  } catch (error: unknown) {
    // fail-open: a git that cannot say whether a merge is in progress refuses (exit 2).
    deps.log(`agnipariksha REFUSED: ${(error as Error).message}`);
    return 2;
  }
  if (merging !== null) {
    // Before the lock: a run that only refuses never waits on another worktree's.
    deps.log(`agnipariksha REFUSED: ${merging}`);
    return 2;
  }
  const judged = { ...deps, lanes };
  let planned: Planned[];
  try {
    planned = planAll(args, judged);
  } catch (error: unknown) {
    // fail-open: a failed git or file read judged nothing: refuse (exit 2), never a blocking exit 1.
    deps.log(`agnipariksha REFUSED: ${(error as Error).message}`);
    return 2;
  }
  // Before the lock: a run that gives Stryker nothing never waits on another worktree's.
  if (!planned.some(runsStryker)) return judgeAll(args, judged, planned);
  let release: () => void;
  try {
    const lockPath = join(resolve(deps.root, deps.git(['rev-parse', '--git-common-dir']).trim()), LOCK_FILE);
    release = await acquireLock(lockPath, deps.pid, deps.lock);
  } catch (error: unknown) {
    // fail-open: a lock not taken refuses with exit 2.
    deps.log(`agnipariksha REFUSED: ${(error as Error).message}`);
    return 2;
  }
  deps.atExit(release);
  try {
    // Planned again under the lock: the tree can change while the run waits for it.
    return await judgeAll(args, judged, planAll(args, judged));
  } catch (error: unknown) {
    // fail-open: a failed git or file read judged nothing: refuse (exit 2), never a blocking exit 1.
    deps.log(`agnipariksha REFUSED: ${(error as Error).message}`);
    return 2;
  } finally {
    release();
  }
}

/** A lane's plan, and why this run leaves it to CI (its cut-off), or null. */
export interface Planned {
  plan: Plan;
  over: string | null;
}

/**
 * Every lane's plan, reading git and the files but writing and logging
 * nothing, so it can run before the lock as well as under it.
 */
export function planAll(args: Args, deps: CliDeps): Planned[] {
  // `--files` names the files and judges each whatever its diff, so it needs no base and nothing is comment-only.
  const changes = args.files === undefined ? changedFiles(deps.git, deps.upstream, args.base, args.trackedOnly) : null;
  const files = changes?.files ?? (args.files as string[]);
  const isCommentOnly = (file: string): boolean =>
    changes !== null && !changes.alwaysJudged.has(file) && commentOnly(deps.git(['diff', '-U0', '--no-color', changes.base, '--', file]));
  return deps.lanes.map((lane) => {
    const plan = planLane(lane, files, deps.exists, isCommentOnly);
    // A run that names its lanes judges them whatever their size: each CI job names its own.
    const over = args.lanes === undefined ? overCutoff(plan, (file) => deps.readFile(join(deps.root, file))) : null;
    return { plan, over };
  });
}

/** Whether a lane's plan gives Stryker a file to run: one target or more, and not left to CI. */
export const runsStryker = ({ plan, over }: Planned): boolean => plan.targets.length > 0 && over === null;

async function judgeAll(args: Args, deps: CliDeps, planned: readonly Planned[]): Promise<number> {
  let tracked: string[] | undefined;
  const listTracked = (): string[] => (tracked ??= entries(deps.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])));
  const laneDeps: LaneDeps = {
    ...deps,
    reuseKey: (lane) =>
      args.reuse ? incrementalKey(keyInputPaths(lane.cwd, lane.config, listTracked(), deps.keyPolicy), (path) => deps.readFile(join(deps.root, path))) : null,
  };

  const totals = { counted: 0, caught: 0, blocking: 0, refused: 0, lanes: 0, cutOff: 0 };
  for (const { plan, over } of planned) {
    const { lane } = plan;
    for (const line of plan.notJudged) deps.log(`  ${line}`);
    if (plan.targets.length === 0) {
      deps.log(`${lane.name}: nothing to judge - not run`);
      continue;
    }
    if (over !== null) {
      deps.log(over);
      totals.cutOff += 1;
      continue;
    }
    deps.log(`agnipariksha: ${lane.name}: stryker run --mutate ${plan.targets.join(',')}`);
    const result = await judgeLane(plan, laneDeps);
    if (result.fellBack !== null) deps.log(`  fallback: ${lane.name} reran with its fallbackEnv: ${result.fellBack}`);
    if (result.flaky !== undefined) deps.log(`  flaky: ${lane.name}: ${result.flaky}`);
    for (const file of result.noMutants) deps.log(`  no mutants (absent from Stryker's report): ${file}`);
    for (const m of result.judgement.blocking) deps.log(`  ${formatBlocking(m)}`);
    // Only where the run was narrowed to the owning suites: under a related filter a sibling that imports the file ran.
    const narrowed = new Set(result.ownSuites);
    for (const file of new Set(result.judgement.blocking.map((m) => m.file).filter((file) => narrowed.has(file)))) {
      const owner = ownerOf(file, deps.exists);
      // A suite removed during the run owns nothing now, so there is no owner to name.
      if (owner === null) continue;
      const siblings = siblingSuites(file, listTracked());
      if (siblings.length > 0) deps.log(`  ${notTheOwner(file, owner, siblings)}`);
    }
    for (const reason of result.refusals) deps.log(`  REFUSED ${lane.name}: ${reason}`);
    deps.log(summaryLine(plan, result));
    totals.lanes += 1;
    totals.counted += result.judgement.counted;
    totals.caught += result.judgement.caught;
    totals.blocking += result.judgement.blocking.length;
    totals.refused += result.refusals.length > 0 ? 1 : 0;
  }
  const code = totals.blocking > 0 ? 1 : totals.refused > 0 ? 2 : 0;
  const cutOff = totals.cutOff > 0 ? `, ${totals.cutOff} over the cut-off for CI` : '';
  deps.log(
    `agnipariksha total: ${totals.caught} killed of ${totals.counted} in ${totals.lanes} lane(s), ${totals.blocking} blocking, ${totals.refused} refused${cutOff} - exit ${code}`,
  );
  return code;
}

/** Run a command, tee its output, and note which of `markers` it printed. */
/** The variables `os.tmpdir()` reads: TMPDIR on POSIX, TEMP and TMP on Windows. */
export const TMPDIR_KEYS = ['TMPDIR', 'TEMP', 'TMP'] as const;
/** A run's temp directory is named with this, under the gate's own `tmpdir()`, so a leftover is recognisable. */
export const SCRATCH_TMP_PREFIX = 'agnipariksha-tmp-';

/**
 * A Stryker run's temp variables, all at `dir`. A test builds scratch paths
 * from `tmpdir()`, and a mutant can change what it removes: `rm(join(tmpdir(),
 * name))` mutated to name no child removes the machine's shared temp directory
 * and every other process's files in it. Under a fresh, empty directory made
 * for the one run, the worst such a mutant removes is that directory. Applied
 * after the lane's own env, so no lane points a run back at the shared one.
 */
export function scratchTmpEnv(dir: string): Record<(typeof TMPDIR_KEYS)[number], string> {
  return { TMPDIR: dir, TEMP: dir, TMP: dir };
}

/** Temp directories of runs still going, removed if the gate exits first. */
const liveScratch = new Set<string>();

/** Remove a run's temp directory; one that cannot be removed, or is gone already, is left, never failing the run. */
export function removeScratchTmp(dir: string, rm: (path: string) => void = (path) => rmSync(path, { recursive: true })): void {
  liveScratch.delete(dir);
  try {
    rm(dir);
  } catch {
    // fail-open: a leftover is the OS's to clear with the rest of its temp directory; the run has its verdict.
  }
}

/** Remove every live run's temp directory (the gate is exiting). */
export function removeLiveScratch(): void {
  for (const dir of [...liveScratch]) removeScratchTmp(dir);
}

/**
 * The run's temp directory vanished under it: something in the run removed
 * files outside its own scratch, so its results are not trusted.
 */
export const scratchVanished = (dir: string): string =>
  `the run's temp directory ${dir} vanished during the run: something in it removed files it should not have, so its results are not trusted`;

/** The longest partial line a run's tee holds while it waits for the newline. */
export const MAX_LINE = 4096;
/** A tee's line before its first character and after each newline. */
const NO_TEXT = '';

/** The gate's own environment, less the names `unset` removes. */
export function inheritedEnv(env: NodeJS.ProcessEnv, unset: readonly string[]): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const name of unset) delete kept[name];
  return kept;
}

/**
 * Runs Stryker. A child's environment is the gate's, less `unset` (the
 * config's `unsetEnv`), then the lane's `env`, then the run's temp variables.
 */
export function spawnStryker(
  command: readonly string[],
  children: Set<ChildProcess>,
  markers: readonly string[] = MARKERS,
  unset: readonly string[] = [],
): LaneDeps['runStryker'] {
  return (cwd, args, env) =>
    new Promise((done) => {
      // Short, under the gate's own tmpdir(): a Unix socket a test opens under it stays inside macOS's 104-byte limit.
      const scratch = mkdtempSync(join(tmpdir(), SCRATCH_TMP_PREFIX));
      liveScratch.add(scratch);
      const child = spawn(command[0] as string, [...command.slice(1), ...args], {
        cwd,
        env: { ...inheritedEnv(process.env, unset), ...env, ...scratchTmpEnv(scratch) },
        stdio: ['inherit', 'pipe', 'pipe'],
      });
      children.add(child);
      const seen = new Set<string>();
      const failed = failedTestReader();
      const flushes: (() => void)[] = [];
      const tee = (out: NodeJS.WritableStream) => {
        // One decoder a stream (UTF-8, its default): a character split across two chunks is joined, never two U+FFFD.
        const decoder = new StringDecoder();
        // Whole lines go to the markers and the reader; every marker is one line. A line past the cap
        // keeps its first MAX_LINE characters and drops the rest up to its newline, however the chunks split it.
        let line = NO_TEXT;
        const add = (text: string): void => {
          line = (line + text).slice(0, MAX_LINE);
        };
        const end = (): void => {
          for (const marker of markers) if (line.includes(marker)) seen.add(marker);
          failed.read(line);
          line = NO_TEXT;
        };
        const take = (text: string): void => {
          const [first, ...rest] = text.split('\n') as [string, ...string[]];
          add(first);
          for (const part of rest) {
            end();
            add(part);
          }
        };
        flushes.push(() => {
          take(decoder.end());
          end();
        });
        return (chunk: Buffer) => {
          out.write(chunk);
          take(decoder.write(chunk));
        };
      };
      child.stdout.on('data', tee(process.stdout));
      child.stderr.on('data', tee(process.stderr));
      child.on('error', () => {
        removeScratchTmp(scratch);
        done({ code: 127, seen: [] });
      });
      child.on('close', (code) => {
        children.delete(child);
        flushes.forEach((flush) => flush());
        const vanished = !existsSync(scratch);
        removeScratchTmp(scratch);
        const failedTests = failed.names();
        const result = { code: code ?? 1, seen: [...seen], ...(failedTests.length > 0 ? { failedTests } : {}) };
        done(vanished ? { ...result, refusal: scratchVanished(scratch) } : result);
      });
    });
}

/** A file's text, or undefined when it cannot be read. */
export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // fail-open: callers read undefined as missing, and refuse or run in full.
  }
  return undefined;
}

/** `stdin` is where `readStdin` reads: fd 0, or a file in a test. */
export function realDeps(root: string, children: Set<ChildProcess>, config: Config, stdin: number | string = 0): CliDeps {
  const readFile = readText;
  const writeFile = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  return {
    root,
    reportsDir: join(root, REPORTS_DIR),
    git: (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }),
    exists: (path) => existsSync(join(root, path)),
    pathExists: existsSync,
    runStryker: spawnStryker([join(root, STRYKER_BIN)], children, MARKERS, config.unsetEnv),
    readFile,
    writeFile,
    removeFile: (path) => rmSync(path, { force: true }),
    now: Date.now,
    pid: process.pid,
    lanes: lanesOf(config),
    upstream: config.upstream,
    keyPolicy: config.reuseKey,
    atExit: (fn) => process.on('exit', fn),
    log: (line) => process.stdout.write(`${line}\n`),
    readStdin: () => readFileSync(stdin, 'utf8'),
    lock: {
      create: (path, text) => {
        try {
          writeFileSync(path, text, { flag: 'wx' });
          return true;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
          throw error;
        }
      },
      read: readFile,
      remove: (path) => rmSync(path, { force: true }),
      alive: (pid) => pidAlive(pid),
      now: Date.now,
      sleep: (ms) => new Promise((wake) => setTimeout(wake, ms)),
      log: (line) => process.stderr.write(`${line}\n`),
    },
  };
}

/**
 * The process entry: a missing or bad agnipariksha.json refuses before any
 * work, and a throw refuses (exit 2), never reads as blocking (exit 1).
 */
export async function bootstrap(argv: readonly string[], children: Set<ChildProcess>): Promise<number> {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const config = loadConfig(root, readText);
    if (typeof config === 'string') {
      process.stdout.write(`agnipariksha REFUSED: ${config}\n`);
      return 2;
    }
    return await main(argv, realDeps(root, children, config));
  } catch (error: unknown) {
    // fail-open: any throw refuses with exit 2.
    process.stdout.write(`agnipariksha REFUSED: ${(error as Error).message}\n`);
    return 2;
  }
}

/** What `entry` needs of its process: the bin passes `process`, a test a fake. */
export interface EntryProcess {
  readonly argv: readonly string[];
  exitCode?: number | string | null | undefined;
  on: (event: string, listener: () => void) => unknown;
  exit: (code: number) => void;
}

/** The gate is exiting: stop its Stryker children and remove the live runs' temp directories. */
export function stopAll(children: Set<ChildProcess>): void {
  for (const child of children) child.kill('SIGTERM');
  removeLiveScratch();
}

/**
 * The bin's whole work (bin.ts only calls this): on exit stop the children,
 * on a signal exit 2, and set the exit code `run` returns. Imported, cli.ts
 * runs nothing, so no test's import starts a gate.
 */
export async function entry(proc: EntryProcess, run: typeof bootstrap = bootstrap): Promise<void> {
  const children = new Set<ChildProcess>();
  proc.on('exit', () => stopAll(children));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) proc.on(signal, () => proc.exit(2));
  proc.exitCode = await run(proc.argv.slice(2), children);
}
