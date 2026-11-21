/**
 * `sarathi services prune`: an hourly launchd agent that clears what Docker
 * no longer uses: the whole service stack (running or not) of every archived
 * worktree, through the reaper (`reaper.ts`), which otherwise waits for the
 * next session start; stopped containers, unused images, anonymous volumes,
 * stale build cache and networks.
 *
 * Some things are kept on purpose, because deleting them costs more than the
 * disk they hold:
 *   - every named volume, except a worktree service volume (the services
 *     file's `project` prefix) whose `rootLabel` names a worktree root that is
 *     provably gone (`sarathi services` reopens the others; a prune would wipe
 *     a live session's data). An unlabelled one is kept: another clone on this
 *     daemon may own it;
 *   - images referenced by the primary checkout's code (outside docs/), so
 *     the next stack start or build does not re-pull them;
 *   - anything created or tagged in the last hour, so a sweep never races a
 *     build, scan or stack that is starting;
 *   - build cache that makes builds fast: layers reused by more than one build
 *     (dependency install, base images, toolchain) and the newest copy of each
 *     build step, until unused for three days. One-off layers (each commit's
 *     source copy) go after an hour, and 40 GB is a ceiling, least recently
 *     used first, measured on the sizes `buildx du` lists (recordsOverCeiling
 *     says why not `--max-used-space`). Records are deleted one id at a time
 *     because the BuildKit in some daemons ignores `--filter until=` and
 *     `unused-for=` (both have been seen to free 0 B of records unused for a
 *     day).
 *
 * Every name comes from the project: the agent is `com.<name>.docker-prune`
 * and its folder `~/Library/Application Support/<Name>/DockerPrune`, `name`
 * being `worktree.name` from `.claude/sarathi.json`.
 *
 * `install` copies RUNTIME_FILES, the compiled closure of this module, out of
 * the checkout (worktrees get archived, and node_modules changes), with a
 * snapshot of the project's settings, and registers the copy with launchd.
 * The copy runs under plain `node`, so every one of those modules uses Node
 * built-ins only.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { readSettings } from '../worktree/settings.ts';
import { isCliEntry } from './cli-entry.ts';
import { loadServicesFile, servicesPath } from './file.ts';
import { projectName, reapOrphanedServices, worktreeState, type Docker, type ReapSettings, type SweepResult, type WorktreeState } from './reaper.ts';
import { failure, runChild, type ChildOutcome } from './run-child.ts';

/**
 * This module and every module it imports, transitively, by their compiled
 * names under `dist/`: what the runtime copy needs. A test holds it to the
 * imports.
 */
export const RUNTIME_FILES = [
  'services/prune.js',
  'services/cli-entry.js',
  'services/file.js',
  'services/fixture-root.js',
  'services/reaper.js',
  'services/run-child.js',
  'worktree/settings.js',
] as const;
/** The extension of the running module: `.js` once built, `.ts` under the tests. */
const EXTENSION = extname(fileURLToPath(import.meta.url));
/** A RUNTIME_FILES name as the running tree has it. */
const asRunning = (file: string): string => file.replace(/\.js$/, EXTENSION);
/** The module launchd runs. */
const ENTRY = asRunning(RUNTIME_FILES[0]);

export const INTERVAL_SECONDS = 3600;
/** Docker's mark on a volume created without a name. */
const ANONYMOUS_LABEL = 'com.docker.volume.anonymous';
const HOUR_MS = 3_600_000;
/** Twenty minutes: a prune of a large build cache can take most of it. */
export const COMMAND_TIMEOUT_MS = 1_200_000;
/** `docker info` answers in seconds, or the daemon is not up. */
export const DAEMON_TIMEOUT_MS = 60_000;
export const LAUNCHCTL_TIMEOUT_MS = 20_000;
/** Build cache ceiling in bytes, least recently used evicted first. */
export const BUILD_CACHE_CAP = 40e9;
/** A build's chain is about a dozen records deep; each round peels one. */
const CEILING_ROUNDS = 30;
/** A one-off build layer is kept this long after its use. */
const ONE_OFF_HOURS = 1;
/** A reused layer, or the newest copy of a step, is kept this long unused. */
const REUSED_HOURS = 72;
/** Each round frees the parents the previous round's deletions exposed. */
const CACHE_ROUNDS = 5;
const HOURS_PER: Record<string, number> = {
  hour: 1,
  day: 24,
  week: 168,
  month: 720,
  year: 8760,
};
export const LOG_LIMIT_BYTES = 1_000_000;
/** Docker subcommands that only read; a dry run passes nothing else through. */
const READS = new Set<string | undefined>(['ps', 'info', 'ls', 'inspect', 'du']);

/** The project's names the sweep uses, and the checkout that outlives every worktree. */
export interface PruneSettings extends ReapSettings {
  /** The primary checkout: image references are looked up in its code. */
  readonly primary: string;
}

/** The launchd label for the project `name`. */
export function agentLabel(name: string): string {
  return `com.${name}.docker-prune`;
}

/** The agent's folder: the runtime copy, the settings snapshot and the logs. */
export function runtimeDirectory(home: string, name: string): string {
  return join(home, 'Library/Application Support', `${name.charAt(0).toUpperCase()}${name.slice(1)}`, 'DockerPrune');
}

/** A caught value as text; a value that throws when stringified cannot escape. */
export function detail(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    // fail-open: an unprintable value is reported as such; the step result stands.
    return 'an error that cannot be printed';
  }
}

export interface ServiceVolume {
  name: string;
  /** The `rootLabel` value; absent on volumes created before the label existed. */
  root: string | undefined;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A worktree service volume's name: `<project>-<16 hex>_<volume>`, the project captured. */
const serviceVolume = (prefix: string): RegExp => new RegExp(`^(${escape(prefix)}-[0-9a-f]{16})_`);

/**
 * Unused worktree service volumes whose worktree is provably gone: the label
 * names a root, the volume's project is that root's hash under `prefix` (so
 * `sarathi services` made it for exactly that directory), and the root is
 * missing on disk. An unlabelled volume proves nothing: this checkout's
 * worktree list cannot speak for another clone sharing the daemon, so it is
 * kept.
 */
export function orphanedServiceVolumes(volumes: ServiceVolume[], inspect: (path: string) => WorktreeState, prefix: string): string[] {
  const pattern = serviceVolume(prefix);
  return volumes
    .filter(({ name, root }) => root !== undefined && root !== '' && pattern.exec(name)?.[1] === projectName(prefix, root) && inspect(root) === 'gone')
    .map(({ name }) => name);
}

export interface ImageRecord {
  Id: string;
  RepoTags: string[] | null;
  Created: string;
  Metadata?: { LastTagTime?: string | undefined };
}

/**
 * Tags of images no container uses, older than an hour by both build and tag
 * time. Removing a tag without force deletes the image once its last tag is
 * gone. An unreadable time reads as old (NaN is never within the hour).
 */
export function staleImageTags(images: ImageRecord[], inUse: Set<string>, now: number): string[] {
  const recent = (stamp: string | undefined): boolean => now - Date.parse(String(stamp)) < HOUR_MS;
  return images.filter(image => !inUse.has(image.Id) && !recent(image.Created) && !recent(image.Metadata?.LastTagTime)).flatMap(image => image.RepoTags ?? []);
}

/** The space a prune command says it freed ("Total:" from `buildx prune`), if any. */
export function reclaimed(output: string): string | undefined {
  return /Total(?: reclaimed space)?:\s*(.+)/.exec(output)?.[1]?.trim();
}

const lines = (text: string): string[] => text.split('\n').filter(Boolean);

/** One record of `docker buildx du --format json` (one JSON object per line). */
export interface CacheRecord {
  ID: string;
  Description?: string;
  /**
   * A go-units HumanDuration ("About an hour ago", "3 days ago") from buildx
   * 0.33; other versions may print a timestamp instead.
   */
  LastUsedAt: string;
  UsageCount?: number;
  Parents?: string[] | null;
  InUse?: boolean;
  /** False while an image still holds the layer; BuildKit refuses to prune it. */
  Reclaimable?: boolean;
  /** A go-units size ("3.1GB", "512kB", "0B"); some buildx versions print bytes. */
  Size?: string;
}

const SIZE_POWERS: Record<string, number> = { '': 0, k: 1, M: 2, G: 3, T: 4, P: 5 };

/**
 * Bytes in a size as `buildx du` prints it: go units ("3.1GB", buildx 0.37)
 * or a bare byte count ("829889526"); undefined when unreadable.
 */
export function sizeBytes(size: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(?:([kMGTP]?)B)?$/.exec(String(size));
  const count = Number(match?.[1]);
  if (!Number.isFinite(count)) return undefined;
  // A finite count can still overflow once scaled: that fails closed too.
  const bytes = count * 1000 ** (SIZE_POWERS[`${match?.[2]}`] ?? 0);
  return Number.isFinite(bytes) ? bytes : undefined;
}

/** Each record's bytes by id; a size it cannot read throws. */
function recordSizes(records: CacheRecord[]): Map<string, number> {
  return new Map(
    records.map(record => {
      const bytes = sizeBytes(record.Size);
      if (bytes === undefined) throw new Error(`cannot measure build cache record ${record.ID}: size ${JSON.stringify(record.Size)}`);
      return [record.ID, bytes];
    }),
  );
}

/**
 * A note when the listed cache is still over `cap` once the ceiling's
 * rounds are done: what is left is in use, used within the hour, held by an
 * image, or failed to delete, and the sweep says so rather than report the
 * cap as met.
 */
export function overCeiling(records: CacheRecord[], cap: number): string | undefined {
  const total = [...recordSizes(records).values()].reduce((sum, bytes) => sum + bytes, 0);
  if (total <= cap) return undefined;
  return `still ${(total / 1e9).toFixed(1)} GB listed, over the ${cap / 1e9} GB cap: the rest is in use, recent, held by an image or would not delete`;
}

/**
 * Cache records to delete so the listed total falls to `cap` bytes: leaves,
 * least recently used first, last used an hour or more ago (a sweep never
 * races a build). Deleting a leaf exposes its parent to the next round.
 *
 * This replaces `buildx prune --max-used-space`. Under the containerd image
 * store BuildKit leaves "shared" records out of the usage it measures against
 * that limit: a 40 GB cap has been seen to free 0 B on every sweep while the
 * records `buildx du` lists grew to 792 GB (655 GB on the VM's disk).
 * A size it cannot read throws: the total, and so the cap, would be unknown.
 */
export function recordsOverCeiling(records: CacheRecord[], tried: Set<string>, now: number, cap: number): string[] {
  const sizes = recordSizes(records);
  let total = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
  const parents = new Set(records.flatMap(record => record.Parents ?? []));
  const leaves = records
    .filter(record => !parents.has(record.ID) && !tried.has(record.ID) && !record.InUse && record.Reclaimable !== false)
    .map(record => ({ record, hours: hoursAgo(record.LastUsedAt, now) }))
    .filter((leaf): leaf is { record: CacheRecord; hours: number } => leaf.hours !== undefined && leaf.hours >= ONE_OFF_HOURS)
    .sort((a, b) => b.hours - a.hours);
  const ids: string[] = [];
  for (const { record } of leaves) {
    if (total <= cap) break;
    ids.push(record.ID);
    total -= sizes.get(record.ID) ?? 0;
  }
  return ids;
}

/**
 * Hours since a HumanDuration "… ago", or since a timestamp, at `now`;
 * undefined when it cannot be read.
 */
export function hoursAgo(text: string, now: number): number | undefined {
  if (/^(Less than a second|\d+ seconds?|About a minute|\d+ minutes?) ago$/.test(text)) return 0;
  if (text === 'About an hour ago') return 1;
  const match = /^(\d+) (hour|day|week|month|year)s? ago$/.exec(text);
  if (match) {
    // A digit run past 2^53 is no count of hours: unreadable, so kept.
    const count = Number(match[1]);
    if (Number.isSafeInteger(count)) return count * (HOURS_PER[`${match[2]}`] ?? Number.NaN);
  }
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : (now - at) / HOUR_MS;
}

/**
 * Cache records to delete now: leaves (no record names them as a parent)
 * whose keep window has passed. A record reused by more than one build, or
 * the newest copy of its build step, keeps for REUSED_HOURS; any other keeps
 * for ONE_OFF_HOURS. Unreadable ages and ids already tried are kept.
 */
export function cacheRecordsToDelete(records: CacheRecord[], tried: Set<string>, now: number): string[] {
  const parents = new Set(records.flatMap(record => record.Parents ?? []));
  const newest = new Map<string, { id: string; hours: number }>();
  for (const record of records) {
    const hours = hoursAgo(record.LastUsedAt, now) ?? 0;
    const step = record.Description ?? record.ID;
    const current = newest.get(step);
    if (!current || hours < current.hours) newest.set(step, { id: record.ID, hours });
  }
  return records
    .filter(record => {
      if (parents.has(record.ID) || tried.has(record.ID) || record.InUse || record.Reclaimable === false) return false;
      const hours = hoursAgo(record.LastUsedAt, now);
      if (hours === undefined) return false;
      const keeper = (record.UsageCount ?? 1) > 1 || newest.get(record.Description ?? record.ID)?.id === record.ID;
      return hours >= (keeper ? REUSED_HOURS : ONE_OFF_HOURS);
    })
    .map(record => record.ID);
}

/** Runs `run` over items one at a time, so the daemon sees one request at once. */
async function inSequence<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  return items.reduce<Promise<R[]>>(async (done, item) => [...(await done), await run(item)], Promise.resolve([]));
}

export interface SweepDependencies {
  docker: Docker;
  /** The services file's names: worktree service volumes are `<project>-<16 hex>_…`, labelled `rootLabel`. */
  settings: Pick<ReapSettings, 'project' | 'rootLabel'>;
  referenced: (tag: string) => Promise<boolean>;
  inspect: (path: string) => WorktreeState;
  now: () => number;
  /** Removes the service stacks of worktrees that no longer exist. */
  reapArchived: () => Promise<SweepResult>;
}

export interface StepResult {
  step: string;
  ok: boolean;
  reclaimed?: string | undefined;
  removed?: string[];
  /** How many items went, where listing them would flood the log. */
  removedCount?: number;
  /** How many were left at the step's last look. */
  remainingCount?: number;
  /** What the step kept or could not do, without failing the step. */
  notes?: string[];
  error?: string;
}

type StepOutput = Omit<StepResult, 'step' | 'ok'>;

async function step(name: string, action: () => Promise<StepOutput>): Promise<StepResult> {
  try {
    return { step: name, ok: true, ...(await action()) };
  } catch (error) {
    // fail-open: one failed step is reported in the log; the others still run.
    return { step: name, ok: false, error: detail(error).split('\n')[0] ?? '' };
  }
}

/** Removes each item on its own so one refusal never stops the rest. */
async function removeEach(docker: Docker, command: string[], items: string[]): Promise<string[]> {
  const removed = await inSequence(items, async item => {
    try {
      await docker([...command, item]);
      return item;
    } catch {
      // fail-open: in use or already gone; either way it is not ours to force.
      return undefined;
    }
  });
  return removed.filter(item => item !== undefined);
}

async function prune(docker: Docker, args: string[]): Promise<StepOutput> {
  return { reclaimed: reclaimed(await docker(args)) };
}

async function imagesInUse(docker: Docker): Promise<Set<string>> {
  const containers = lines(await docker(['ps', '-a', '-q', '--no-trunc']));
  if (!containers.length) return new Set<string>();
  return new Set(lines(await docker(['container', 'inspect', '--format', '{{.Image}}', ...containers])));
}

async function pruneImages(deps: SweepDependencies): Promise<StepOutput> {
  const { docker } = deps;
  const inUse = await imagesInUse(docker);
  const ids = [...new Set(lines(await docker(['image', 'ls', '-a', '-q', '--no-trunc'])))];
  const images = ids.length ? (JSON.parse(await docker(['image', 'inspect', ...ids])) as ImageRecord[]) : [];
  const candidates = staleImageTags(images, inUse, deps.now());
  const verdicts = await Promise.all(candidates.map(tag => deps.referenced(tag)));
  const removed = await removeEach(
    docker,
    ['image', 'rm'],
    candidates.filter((_, index) => !verdicts[index]),
  );
  const dangling = await prune(docker, ['image', 'prune', '-f', '--filter', 'until=1h']);
  return { removed, ...dangling };
}

/** One element of `docker volume inspect` output. */
interface VolumeRecord {
  Name: string;
  Labels: Record<string, string> | null;
  CreatedAt: string;
}

/** Unused volumes, inspected; `filters` narrows `volume ls` further. */
async function danglingVolumes(docker: Docker, filters: string[], keep: (name: string) => boolean): Promise<VolumeRecord[]> {
  const names = lines(await docker(['volume', 'ls', '-q', '--filter', 'dangling=true', ...filters])).filter(keep);
  return names.length ? (JSON.parse(await docker(['volume', 'inspect', ...names])) as VolumeRecord[]) : [];
}

/**
 * Unused anonymous volumes created over an hour ago, so a volume made for a
 * container that is still starting is never taken. An unreadable creation
 * time reads as recent (NaN is never an hour old).
 */
async function pruneAnonymousVolumes(deps: SweepDependencies): Promise<StepOutput> {
  const now = deps.now();
  const volumes = await danglingVolumes(deps.docker, ['--filter', `label=${ANONYMOUS_LABEL}`], () => true);
  const old = volumes.filter(volume => now - Date.parse(volume.CreatedAt) >= HOUR_MS).map(volume => volume.Name);
  const removed = await removeEach(deps.docker, ['volume', 'rm'], old);
  return { removedCount: removed.length };
}

async function pruneServiceVolumes(deps: SweepDependencies): Promise<StepOutput> {
  const { docker, settings } = deps;
  const pattern = serviceVolume(settings.project);
  const inspected = await danglingVolumes(docker, [], name => pattern.test(name));
  const volumes = inspected.map(volume => ({ name: volume.Name, root: volume.Labels?.[settings.rootLabel] }));
  const orphans = orphanedServiceVolumes(volumes, deps.inspect, settings.project);
  return { removed: await removeEach(docker, ['volume', 'rm'], orphans) };
}

/** Deletes one cache record; true when BuildKit reports freeing it. */
async function pruneCacheRecord(docker: Docker, id: string): Promise<boolean> {
  try {
    const freed = reclaimed(await docker(['buildx', 'prune', '-f', '--filter', `id=${id}`]));
    return freed !== undefined && freed !== '0B';
  } catch {
    // fail-open: in use or already gone; the record stays for the next sweep.
    return false;
  }
}

/** The build cache's records as `buildx du` lists them now. */
async function listCache(docker: Docker): Promise<CacheRecord[]> {
  return lines(await docker(['buildx', 'du', '--format', 'json'])).map(line => JSON.parse(line) as CacheRecord);
}

/**
 * Deletes cache records `choose` picks, one id at a time, for up to `rounds`
 * rounds; each round lists the cache again, since a deletion exposes parents.
 */
async function pruneBuildCache(docker: Docker, rounds: number, choose: (records: CacheRecord[], tried: Set<string>) => string[]): Promise<{ removedCount: number; remainingCount: number }> {
  const tried = new Set<string>();
  let exhausted = false;
  let remainingCount = 0;
  const removed = await inSequence(Array.from({ length: rounds }), async () => {
    // A round that found nothing means no later round can find anything.
    if (exhausted) return 0;
    const records = await listCache(docker);
    remainingCount = records.length;
    const ids = choose(records, tried);
    exhausted = ids.length === 0;
    if (exhausted) return 0;
    ids.forEach(id => tried.add(id));
    const freed = await inSequence(ids, id => pruneCacheRecord(docker, id));
    const count = freed.filter(Boolean).length;
    remainingCount -= count;
    return count;
  });
  return { removedCount: removed.reduce((total, count) => total + count, 0), remainingCount };
}

/**
 * The stacks (containers, running or stopped, plus volume and network) of
 * worktrees whose directory is gone. Skips and failures are logged as notes;
 * a project the reaper could not judge is kept.
 */
async function reapArchived(deps: SweepDependencies): Promise<StepOutput> {
  const result = await deps.reapArchived();
  const notes = [
    ...result.skipped.map(({ project, reason }) => `kept ${project}: ${reason}`),
    ...result.failed.map(({ project, error }) => `failed ${project}: ${error}`),
    ...result.warnings,
  ];
  return { removed: result.reaped, ...(notes.length ? { notes } : {}) };
}

/** One full sweep. Every step runs; a failed step is reported, never thrown. */
export async function sweep(deps: SweepDependencies): Promise<StepResult[]> {
  const { docker } = deps;
  return inSequence<[string, () => Promise<StepOutput>], StepResult>(
    [
      ['archived worktree stacks', () => reapArchived(deps)],
      ['containers', () => prune(docker, ['container', 'prune', '-f', '--filter', 'until=1h'])],
      ['images', () => pruneImages(deps)],
      ['anonymous volumes', () => pruneAnonymousVolumes(deps)],
      ['worktree volumes', () => pruneServiceVolumes(deps)],
      [
        'build cache',
        () => {
          const now = deps.now();
          return pruneBuildCache(docker, CACHE_ROUNDS, (records, tried) => cacheRecordsToDelete(records, tried, now));
        },
      ],
      [
        'build cache ceiling',
        async () => {
          const now = deps.now();
          const result = await pruneBuildCache(docker, CEILING_ROUNDS, (records, tried) => recordsOverCeiling(records, tried, now, BUILD_CACHE_CAP));
          const over = overCeiling(await listCache(docker), BUILD_CACHE_CAP);
          return over === undefined ? result : { ...result, notes: [over] };
        },
      ],
      ['networks', () => prune(docker, ['network', 'prune', '-f', '--filter', 'until=1h'])],
    ],
    ([name, action]) => step(name, action),
  );
}

/**
 * A Docker that runs only reads (`ps`, `image ls`, `buildx du`, …) and prints
 * every other command instead, so no shape of removal, the reaper's included,
 * can reach the daemon.
 */
export function dryRun(docker: Docker, print: (line: string) => void): Docker {
  return async args => {
    if (READS.has(args[0]) || READS.has(args[1])) return docker(args);
    print(`would run: docker ${args.join(' ')}`);
    return '';
  };
}

/** Runs one child with a deadline; resolves how it ended, never rejects. */
export type Run = (command: string, args: string[], timeoutMs: number) => Promise<ChildOutcome>;

/** A command's trimmed stdout; any other ending throws, naming how it ended. */
async function output(run: Run, command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
  const outcome = await run(command, args, timeoutMs);
  if (outcome.kind !== 'ok') throw new Error(`${command} ${args.slice(0, 2).join(' ')}: ${failure(outcome)}`);
  return outcome.stdout.trim();
}

/** Whether the primary checkout's code (outside docs/) mentions an image tag. */
function referencedIn(run: Run, primary: string): (tag: string) => Promise<boolean> {
  return async tag => {
    const outcome = await run('git', ['-C', primary, 'grep', '-q', '-F', '-e', tag, '--', '.', ':!docs'], COMMAND_TIMEOUT_MS);
    // Exit 1 is "no match"; any other failure keeps the image.
    return !(outcome.kind === 'exit' && outcome.code === 1);
  };
}

/** What one sweep needs. */
export interface SweepRequest {
  /** The Docker CLI binary every step, the reap included, runs. */
  readonly docker: string;
  /** The project's names and primary checkout. */
  readonly settings: PruneSettings;
  /** Only reads reach the daemon; every removal is printed as "would run". */
  readonly dryRun: boolean;
  /** Where a dry run's "would run" lines go. */
  readonly print: (line: string) => void;
  /** Runs the children; runChild with the deadline by default. */
  readonly run?: Run;
  readonly now?: () => number;
}

/** A sweep that ran, or why it did not: the daemon did not answer. */
export type SweepOutcome = { readonly kind: 'skipped'; readonly reason: string } | { readonly kind: 'swept'; readonly results: StepResult[] };

const defaultRun: Run = (command, args, timeoutMs) => runChild(command, args, { timeoutMs });

/**
 * One sweep in-process: the daemon check, then every step, the reap of
 * archived worktrees' stacks included, all through `request.docker`. In a
 * dry run the reaper gets the dry-run Docker too, so the preview covers it.
 */
export async function sweepOnce(request: SweepRequest): Promise<SweepOutcome> {
  const run = request.run ?? defaultRun;
  const { settings } = request;
  const daemon = await run(request.docker, ['info', '--format', '{{.ServerVersion}}'], DAEMON_TIMEOUT_MS);
  if (daemon.kind !== 'ok') return { kind: 'skipped', reason: `docker: ${failure(daemon)}` };
  const live: Docker = args => output(run, request.docker, args);
  const docker = request.dryRun ? dryRun(live, request.print) : live;
  const results = await sweep({
    docker,
    settings,
    referenced: referencedIn(run, settings.primary),
    inspect: worktreeState,
    now: request.now ?? Date.now,
    reapArchived: () => reapOrphanedServices(docker, { project: settings.project, rootLabel: settings.rootLabel, name: settings.name }),
  });
  return { kind: 'swept', results };
}

/** What the command line touches outside its own logic; tests pass their own. */
export interface Env {
  run: Run;
  /** The user's home: launchd agents and the runtime copy live under it. */
  home: string;
  /** The tree RUNTIME_FILES are copied from: the folder holding `services/` and `worktree/`. */
  source: string;
  /** The node binary launchd will run the copy with. */
  execPath: string;
  uid: number;
  /** The environment a package path in `worktree.services` resolves with. */
  variables: Readonly<Record<string, string | undefined>>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  now: () => number;
}

export function defaultEnv(): Env {
  return {
    run: defaultRun,
    home: homedir(),
    source: dirname(dirname(fileURLToPath(import.meta.url))),
    execPath: process.execPath,
    uid: userInfo().uid,
    variables: process.env,
    stdout: line => console.log(line),
    stderr: line => console.error(line),
    now: () => Date.now(),
  };
}

/** Appends one JSON line to the folder's `prune.log`, first moving a log past LOG_LIMIT_BYTES to `.1`. */
export function appendLog(directory: string, entry: object): void {
  const log = join(directory, 'prune.log');
  mkdirSync(directory, { recursive: true });
  if (existsSync(log) && statSync(log).size > LOG_LIMIT_BYTES) renameSync(log, `${log}.1`);
  appendFileSync(log, `${JSON.stringify(entry)}\n`);
}

function dockerBinary(env: Env): Promise<string> {
  return output(env.run, '/usr/bin/which', ['docker']);
}

/** The main checkout, which outlives every worktree this may be run from. */
async function primaryCheckout(env: Env): Promise<string> {
  return dirname(await output(env.run, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

/** The project's names, as far as `<root>/.claude/sarathi.json` gives them. */
type Known = Pick<PruneSettings, 'name' | 'primary'> & { readonly project?: string; readonly rootLabel?: string };

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** The snapshot `install` wrote; anything else is refused. */
export function readSnapshot(path: string): PruneSettings {
  const refuse = (why: string): Error => new Error(`${path} is not a prune settings snapshot (${why}); run \`sarathi services prune install\` again`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw refuse(detail(error));
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw refuse('not an object');
  const fields = new Map(Object.entries(raw));
  const text = (key: string): string => {
    const value = fields.get(key);
    if (typeof value !== 'string' || value === '') throw refuse(`"${key}" must be text`);
    return value;
  };
  const settings = { name: text('name'), project: text('project'), rootLabel: text('rootLabel'), primary: text('primary') };
  if (!NAME.test(settings.name)) throw refuse('"name" must be lowercase letters, digits and dashes');
  if (!isAbsolute(settings.primary)) throw refuse('"primary" must be an absolute path');
  return settings;
}

interface Options {
  docker?: string | undefined;
  settings?: string | undefined;
  'dry-run'?: boolean | undefined;
}

/**
 * The project's names: from `--settings` (launchd's snapshot), else from the
 * primary checkout's `.claude/sarathi.json` and its services file.
 */
async function known(env: Env, options: Options): Promise<Known> {
  if (options.settings !== undefined) return readSnapshot(options.settings);
  const primary = await primaryCheckout(env);
  const settings = readSettings(primary);
  if (settings.services === undefined) return { name: settings.name, primary };
  const file = loadServicesFile(servicesPath(settings.services, primary, env.variables));
  return { name: settings.name, primary, project: file.project, rootLabel: file.rootLabel };
}

/** The names, with the services file's, which the sweep cannot run without. */
async function complete(env: Env, options: Options): Promise<PruneSettings> {
  const { name, primary, project, rootLabel } = await known(env, options);
  if (project === undefined || rootLabel === undefined) {
    throw new Error(`${join(primary, '.claude', 'sarathi.json')} names no services file; set "worktree.services"`);
  }
  return { name, primary, project, rootLabel };
}

async function sweepNow(env: Env, options: Options): Promise<void> {
  const docker = options.docker ?? (await dockerBinary(env));
  const settings = await complete(env, options);
  const preview = options['dry-run'] === true;
  const directory = runtimeDirectory(env.home, settings.name);
  const started = env.now();
  const at = new Date(started).toISOString();
  const outcome = await sweepOnce({ docker, settings, dryRun: preview, print: env.stdout, run: env.run, now: env.now });
  if (outcome.kind === 'skipped') {
    if (preview) env.stdout(outcome.reason);
    else appendLog(directory, { at, skipped: outcome.reason });
    return;
  }
  const seconds = Math.round((env.now() - started) / 1000);
  if (preview) {
    // Every write only printed "would run", so the results are a plan.
    env.stdout(JSON.stringify({ at, seconds, planned: outcome.results }, null, 2));
    return;
  }
  const entry = { at, seconds, results: outcome.results };
  appendLog(directory, entry);
  env.stdout(JSON.stringify(entry, null, 2));
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function plist(label: string, program: string[], path: string, logFile: string): string {
  const strings = (items: string[]): string => items.map(item => `\t\t<string>${xml(item)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${strings(program)}
\t</array>
\t<key>StartInterval</key>
\t<integer>${INTERVAL_SECONDS}</integer>
\t<key>RunAtLoad</key>
\t<false/>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>LowPriorityIO</key>
\t<true/>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${xml(path)}</string>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${xml(logFile)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

/** Where launchd knows this project's agent, and the plist that defines it. */
function agentOf(env: Env, name: string): { domain: string; target: string; plistFile: string } {
  const domain = `gui/${env.uid}`;
  const label = agentLabel(name);
  return { domain, target: `${domain}/${label}`, plistFile: join(env.home, 'Library/LaunchAgents', `${label}.plist`) };
}

async function loaded(env: Env, target: string): Promise<boolean> {
  const outcome = await env.run('/bin/launchctl', ['print', target], LAUNCHCTL_TIMEOUT_MS);
  return outcome.kind === 'ok';
}

function launchctl(env: Env, args: string[]): Promise<string> {
  return output(env.run, '/bin/launchctl', args, LAUNCHCTL_TIMEOUT_MS);
}

/**
 * Writes `content` as a new regular file at `path`. Whatever was there is
 * removed first, so a symlink is replaced, never written through. The mode is
 * set after the write because the umask narrows a create mode: launchd refuses
 * a group-writable plist, which a 002 umask would otherwise produce.
 */
function writeFresh(path: string, content: string | Buffer): void {
  rmSync(path, { force: true });
  writeFileSync(path, content);
  chmodSync(path, 0o644);
}

/**
 * Copies RUNTIME_FILES from `source` into `target`, keeping their layout,
 * with a `package.json` that makes them ES modules. The result runs alone.
 */
export function copyRuntime(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  writeFresh(join(target, 'package.json'), '{ "type": "module" }\n');
  for (const file of RUNTIME_FILES.map(asRunning)) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFresh(join(target, file), readFileSync(join(source, file)));
  }
}

/**
 * Copies the runtime out, snapshots the project's settings beside it, and
 * registers the copy. The snapshot is read at every run: a change to the
 * services file's `project` or `rootLabel`, or to `worktree.name`, reaches
 * the agent only with another `install`.
 */
async function install(env: Env, options: Options): Promise<void> {
  const docker = await dockerBinary(env);
  const settings = await complete(env, options);
  const { domain, target, plistFile } = agentOf(env, settings.name);
  const directory = runtimeDirectory(env.home, settings.name);
  copyRuntime(env.source, directory);
  const snapshot = join(directory, 'settings.json');
  writeFresh(snapshot, `${JSON.stringify(settings, null, 2)}\n`);
  const node = realpathSync(env.execPath);
  const path = [
    ...new Set([dirname(realpathSync(docker)), dirname(docker), dirname(node)]),
    join(env.home, '.orbstack/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].join(':');
  if (await loaded(env, target)) await launchctl(env, ['bootout', target]);
  mkdirSync(dirname(plistFile), { recursive: true });
  writeFresh(
    plistFile,
    plist(agentLabel(settings.name), [node, join(directory, ENTRY), 'run', '--docker', docker, '--settings', snapshot], path, join(directory, 'launchd.log')),
  );
  await launchctl(env, ['bootstrap', domain, plistFile]);
  env.stdout(`installed ${target}: every ${INTERVAL_SECONDS}s, docker ${docker}, repo ${settings.primary}`);
}

async function uninstall(env: Env, options: Options): Promise<void> {
  const { name } = await known(env, options);
  const { target, plistFile } = agentOf(env, name);
  if (await loaded(env, target)) await launchctl(env, ['bootout', target]);
  rmSync(plistFile, { force: true });
  env.stdout(`removed ${target}; logs kept in ${runtimeDirectory(env.home, name)}`);
}

async function runNow(env: Env, options: Options): Promise<void> {
  const { name } = await known(env, options);
  const { target } = agentOf(env, name);
  await launchctl(env, ['kickstart', target]);
  env.stdout(`started ${target}; log: ${join(runtimeDirectory(env.home, name), 'prune.log')}`);
}

async function status(env: Env, options: Options): Promise<void> {
  const { name } = await known(env, options);
  const { target } = agentOf(env, name);
  env.stdout((await loaded(env, target)) ? 'loaded' : 'not loaded');
  const log = join(runtimeDirectory(env.home, name), 'prune.log');
  if (existsSync(log)) env.stdout(lines(readFileSync(log, 'utf8')).pop() ?? '');
}

export const USAGE = 'usage: sarathi services prune install|run|run-now|status|uninstall [--dry-run] [--docker <path>] [--settings <file>]';

const ACTIONS = new Map<string | undefined, (env: Env, options: Options) => Promise<void>>([
  ['run', sweepNow],
  ['install', install],
  ['uninstall', uninstall],
  ['run-now', runNow],
  ['status', status],
]);

/** Runs one action; never rejects. Resolves the process exit code. */
export async function cli(argv: readonly string[], env: Env): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { docker: { type: 'string' }, settings: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    });
    const action = ACTIONS.get(positionals[0]);
    if (!action || positionals.length > 1) throw new Error(USAGE);
    await action(env, values);
    return 0;
  } catch (error) {
    // fail-open: reported on stderr; the exit code carries the failure.
    env.stderr(detail(error));
    return 1;
  }
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  void cli(process.argv.slice(2), defaultEnv()).then(code => {
    process.exitCode = code;
  });
}
