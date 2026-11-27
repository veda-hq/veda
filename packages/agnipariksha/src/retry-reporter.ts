/**
 * The Stryker reporter a timeout retry round loads, so the gate learns each
 * result as Stryker finishes it, and keeps them if the round is stopped at
 * its budget before Stryker writes its JSON report.
 *
 * It appends one JSON line per event to the file `RETRY_EVENTS_VAR` names:
 * `{"kind":"dry-run","at":…}` when the initial test run ends, then
 * `{"kind":"mutant","at":…,"file":…,…}` for each tested mutant, located as
 * Stryker's JSON report locates it (1-based lines and columns, the file
 * relative to Stryker's working directory). It also prints one line for
 * each, so a watcher sees the round move.
 *
 * Stryker loads it in its own process, from `dist/`, through the retry
 * config's `appendPlugins` and `reporters`.
 */
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';

import type { Tested } from './timeout-retry.ts';
import type { Mutant } from './verdict.ts';

/** The variable that names the round's event file. */
export const RETRY_EVENTS_VAR = 'AGNIPARIKSHA_RETRY_EVENTS';
/** The name the retry config lists in `reporters`. */
export const RETRY_REPORTER_NAME = 'agnipariksha-retry-log';

/** The part of Stryker's `MutantResult` the reporter reads. */
export interface TestedLike {
  fileName: string;
  mutatorName: string;
  replacement?: string;
  status: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
}

export interface ReporterIo {
  append: (path: string, text: string) => void;
  print: (line: string) => void;
  now: () => number;
  cwd: string;
}

const defaultIo = (): ReporterIo => ({
  append: (path, text) => appendFileSync(path, text),
  print: (line) => void process.stdout.write(`${line}\n`),
  now: () => Date.now(),
  cwd: process.cwd(),
});

export class RetryReporter {
  readonly path: string | undefined;
  readonly io: ReporterIo;
  /** When the last event came: the dry run's end, then each mutant's. */
  last: number;

  constructor(env: Readonly<Record<string, string | undefined>> = process.env, io: ReporterIo = defaultIo()) {
    this.path = env[RETRY_EVENTS_VAR];
    this.io = io;
    this.last = io.now();
  }

  write(event: Record<string, unknown>): void {
    if (this.path !== undefined) this.io.append(this.path, `${JSON.stringify(event)}\n`);
  }

  onDryRunCompleted(): void {
    this.last = this.io.now();
    this.write({ kind: 'dry-run', at: this.last });
  }

  onMutantTested(result: Readonly<TestedLike>): void {
    const at = this.io.now();
    const file = relative(this.io.cwd, result.fileName);
    const { start, end } = result.location;
    this.write({
      kind: 'mutant',
      at,
      file,
      status: result.status,
      mutator: result.mutatorName,
      replacement: result.replacement,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
    });
    this.io.print(`agnipariksha retry: ${file}:${start.line}:${start.column} ${result.mutatorName}: ${result.status} in ${((at - this.last) / 1000).toFixed(1)} s`);
    this.last = at;
  }
}

const num = (value: unknown): number => (typeof value === 'number' ? value : Number.NaN);

/**
 * A round's events as the gate reads them: when its dry run ended (null if
 * no line says), and each tested mutant with a repo-relative file, as
 * `readMutants` gives one. A line that is not a whole event is skipped: a
 * stopped round can leave its last line cut off.
 */
export function readEvents(text: string | undefined, laneCwd: string): { dryRunEnd: number | null; tested: Tested[] } {
  let dryRunEnd: number | null = null;
  const tested: Tested[] = [];
  // An absent file reads as "undefined", which is no event.
  for (const line of String(text).split('\n')) {
    // Any JSON value: a line that is not an object has no numeric `at` (a string's `at` is a method), and is skipped.
    let event: Record<string, unknown> | null = null;
    try {
      event = JSON.parse(line) as Record<string, unknown> | null;
    } catch {
      // fail-open: a cut-off line is no event (it stays null); its mutant reads as unretried, never as retried.
    }
    if (typeof event?.at !== 'number') continue;
    if (event.kind === 'dry-run') dryRunEnd = event.at;
    if (event.kind !== 'mutant') continue;
    const path = String(event.file);
    const mutant: Mutant = {
      file: laneCwd === '' || path.startsWith(`${laneCwd}/`) ? path : `${laneCwd}/${path}`,
      status: String(event.status),
      mutator: String(event.mutator),
      replacement: String(event.replacement),
      line: num(event.line),
      column: num(event.column),
      endLine: num(event.endLine),
      endColumn: num(event.endColumn),
    };
    tested.push({ mutant, at: event.at });
  }
  return { dryRunEnd, tested };
}

/**
 * What `declareClassPlugin(PluginKind.Reporter, RETRY_REPORTER_NAME, RetryReporter)`
 * returns in Stryker 10.1.1, written out as the ignorer's is.
 */
export const strykerPlugins = [{ kind: 'Reporter', name: RETRY_REPORTER_NAME, injectableClass: RetryReporter }];
