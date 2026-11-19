#!/usr/bin/env node
/**
 * agnipariksha: a mutation gate over stock StrykerJS.
 *
 * Usage: agnipariksha [--base <sha>] [--files a,b] [--lane <name>[,<name>]]... [--tracked-only] [--no-reuse]
 * The lanes come from agnipariksha.json at the repository root (config.ts);
 * `--lane`, repeatable, runs only the lanes it names. `--tracked-only` leaves
 * out untracked files, which a push does not carry.
 * Exit: 0 pass, 1 a blocking mutant, 2 refused or unable to judge.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lanesOf, loadConfig, type Config } from './config.ts';
import { changedFiles, commentOnly, type Changes, type Git } from './changed-files.ts';
import { judgeLane, MARKERS, overCutoff, planLane, type Lane, type LaneDeps, type LaneResult, type Plan } from './lanes.ts';
import { acquireLock, pidAlive, type LockDeps } from './machine-lock.ts';
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
}

const list = (value: string): string[] => value.split(',').filter((item) => item !== '');

export function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { reuse: true, trackedOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--no-reuse') args.reuse = false;
    else if (flag === '--tracked-only') args.trackedOnly = true;
    else if ((flag === '--base' || flag === '--files' || flag === '--lane') && value !== undefined && !value.startsWith('--')) {
      if (flag === '--base') args.base = value;
      else if (flag === '--files') args.files = list(value);
      else if (list(value).length === 0) return '--lane names no lane';
      else args.lanes = [...(args.lanes ?? []), ...list(value)];
      i += 1;
    } else return `unsupported or incomplete argument "${String(flag)}"`;
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
  const sha = readFile(headPath)?.trim().split(/\s+/)[0] ?? '';
  const subject = readFile(gitPath('MERGE_MSG'))?.split('\n')[0]?.trim() ?? '';
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
    return await judgeAll(args, { ...deps, lanes });
  } catch (error: unknown) {
    // fail-open: a failed git or file read judged nothing: refuse (exit 2), never a blocking exit 1.
    deps.log(`agnipariksha REFUSED: ${(error as Error).message}`);
    return 2;
  } finally {
    release();
  }
}

async function judgeAll(args: Args, deps: CliDeps): Promise<number> {
  const changes: Changes =
    args.files === undefined
      ? changedFiles(deps.git, deps.upstream, args.base, args.trackedOnly)
      : { base: args.base ?? '', files: args.files, alwaysJudged: new Set(args.files) };
  let tracked: string[] | undefined;
  const listTracked = (): string[] =>
    (tracked ??= deps.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean));
  const laneDeps: LaneDeps = {
    ...deps,
    reuseKey: (lane) =>
      args.reuse ? incrementalKey(keyInputPaths(lane.cwd, lane.config, listTracked(), deps.keyPolicy), (path) => deps.readFile(join(deps.root, path))) : null,
  };
  const isCommentOnly = (file: string): boolean =>
    !changes.alwaysJudged.has(file) && commentOnly(deps.git(['diff', '-U0', '--no-color', changes.base, '--', file]));

  const totals = { counted: 0, caught: 0, blocking: 0, refused: 0, lanes: 0, cutOff: 0 };
  for (const lane of deps.lanes) {
    const plan = planLane(lane, changes.files, deps.exists, isCommentOnly);
    for (const line of plan.notJudged) deps.log(`  ${line}`);
    if (plan.targets.length === 0) {
      deps.log(`${lane.name}: nothing to judge - not run`);
      continue;
    }
    // A run that names its lanes judges them whatever their size: each CI job names its own.
    const over = args.lanes === undefined ? overCutoff(plan, (file) => deps.readFile(join(deps.root, file))) : null;
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
      const siblings = owner === null ? [] : siblingSuites(file, listTracked());
      if (owner !== null && siblings.length > 0) deps.log(`  ${notTheOwner(file, owner, siblings)}`);
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

/** Remove a run's temp directory; one that cannot be removed is left, never failing the run. */
export function removeScratchTmp(dir: string, rm: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true })): void {
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
  const keep = Math.max(...markers.map((marker) => marker.length));
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
        // One decoder a stream: a character split across two chunks is joined, never two U+FFFD.
        const decoder = new StringDecoder('utf8');
        let tail = '';
        // Whole lines go to the reader. A line past the cap keeps its first MAX_LINE characters and
        // drops the rest up to its newline, however the chunks split it.
        let line = '';
        let over = false;
        const add = (text: string): void => {
          if (over) return;
          line += text;
          if (line.length > MAX_LINE) {
            line = line.slice(0, MAX_LINE);
            over = true;
          }
        };
        const end = (): void => {
          failed.read(line);
          line = '';
          over = false;
        };
        const take = (text: string): void => {
          const [first = '', ...rest] = text.split('\n');
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
          const decoded = decoder.write(chunk);
          const text = tail + decoded;
          for (const marker of markers) if (text.includes(marker)) seen.add(marker);
          tail = text.slice(-keep);
          take(decoded);
        };
      };
      child.stdout?.on('data', tee(process.stdout));
      child.stderr?.on('data', tee(process.stderr));
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
    return undefined;
  }
}

export function realDeps(root: string, children: Set<ChildProcess>, config: Config): CliDeps {
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

/** Whether this module is the process entry (under `node` or `tsx`). */
export function isEntry(argv1: string | undefined): boolean {
  try {
    return argv1 !== undefined && realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // fail-open: a path that cannot be resolved is not this module.
    return false;
  }
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

if (isEntry(process.argv[1])) {
  const children = new Set<ChildProcess>();
  process.on('exit', () => {
    children.forEach((child) => child.kill('SIGTERM'));
    removeLiveScratch();
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(2));
  process.exitCode = await bootstrap(process.argv.slice(2), children);
}
