/**
 * The Stryker ignorer a timeout retry round loads, so the round runs the
 * mutants it retries and not every mutant nested inside them.
 *
 * A round selects its mutants with `--mutate file:l:c-l:c,…`, and Stryker
 * mutates every node inside each range. For a BlockStatement that is every
 * mutant in the block, each run one by one at concurrency 1: one of
 * `cli.ts`'s retries ran 54. This ignorer drops every node strictly inside a
 * retried span of its own file, unless the node is a retried span itself or
 * holds one, and Stryker drops each ignored node's whole subtree with it. So
 * each retried node and its ancestors stay, and every retried mutant is still
 * made. A round never holds a span inside another (`planRounds`), so no
 * retried node is lost inside an ancestor's.
 *
 * Stryker loads it in its own process, from `dist/`, through the retry
 * config's `appendPlugins`; it imports only `node:path`.
 */
import { resolve } from 'node:path';

/**
 * The variable that carries the round's spans, one a line:
 * `file:line:column-endLine:endColumn`, the file relative to Stryker's working
 * directory, lines 1-based and columns 0-based, as Babel counts them.
 */
export const RETRY_SPANS_VAR = 'AGNIPARIKSHA_RETRY_SPANS';
/** The name the retry config lists in `ignorers`. */
export const RETRY_IGNORER_NAME = 'agnipariksha-retry';
/** Stryker reports it on each ignored mutant. */
export const NESTED_REASON = 'agnipariksha retries a timed-out mutant here, and this node lies inside it';

export interface Position {
  line: number;
  column: number;
}
export interface Span {
  start: Position;
  end: Position;
}

/** One `RETRY_SPANS_VAR` line: a file (which may hold colons), then its span. */
const ENTRY = /^(.+):(\d+):(\d+)-(\d+):(\d+)$/;

/**
 * The spans a `RETRY_SPANS_VAR` value names, by file resolved against `cwd`.
 * A line that names no file and span is left out. An unset variable reads as
 * "undefined", which names none.
 */
export function parseSpans(text: string | undefined, cwd: string): Map<string, Span[]> {
  const byFile = new Map<string, Span[]>();
  for (const entry of String(text).split('\n')) {
    const match = ENTRY.exec(entry);
    if (match === null) continue;
    const [file, line, column, endLine, endColumn] = match.slice(1) as [string, string, string, string, string];
    const span: Span = { start: { line: Number(line), column: Number(column) }, end: { line: Number(endLine), column: Number(endColumn) } };
    const key = resolve(cwd, file);
    byFile.set(key, [...(byFile.get(key) ?? []), span]);
  }
  return byFile;
}

const atOrBefore = (a: Position, b: Position): boolean => a.line < b.line || (a.line === b.line && a.column <= b.column);
const samePosition = (a: Position, b: Position): boolean => a.line === b.line && a.column === b.column;

/** Whether `inner` lies inside `outer`, ends included. */
export function within(outer: Span, inner: Span): boolean {
  return atOrBefore(outer.start, inner.start) && atOrBefore(inner.end, outer.end);
}

/** Whether `loc` lies inside `span` and is not `span` itself. */
export function nestedIn(span: Span, loc: Span): boolean {
  return within(span, loc) && !(samePosition(span.start, loc.start) && samePosition(span.end, loc.end));
}

/** The part of Babel's NodePath the ignorer reads: the node's place, and its file's name from the hub. */
export interface NodePathLike {
  node: { loc?: Span | null };
  hub?: { file?: { opts?: { filename?: string | null } } } | null;
}

/**
 * Ignores every node strictly inside a span `RETRY_SPANS_VAR` names for the
 * node's own file, unless it is or holds such a span. With no span it
 * ignores nothing, and the round runs its whole ranges.
 */
export class RetryIgnorer {
  readonly spans: Map<string, Span[]>;

  constructor(env: Readonly<Record<string, string | undefined>> = process.env, cwd: string = process.cwd()) {
    this.spans = parseSpans(env[RETRY_SPANS_VAR], cwd);
  }

  shouldIgnore(path: NodePathLike): string | undefined {
    const loc = path.node.loc;
    const name = path.hub?.file?.opts?.filename;
    const spans = typeof name === 'string' ? this.spans.get(resolve(name)) : undefined;
    if (loc == null || spans === undefined) return undefined;
    const inside = spans.some((span) => nestedIn(span, loc));
    return inside && !spans.some((span) => within(loc, span)) ? NESTED_REASON : undefined;
  }
}

/**
 * What `declareClassPlugin(PluginKind.Ignore, RETRY_IGNORER_NAME, RetryIgnorer)`
 * returns in Stryker 10.1.1, written out as `arid-nodes.mjs` does, so the
 * package needs no `@stryker-mutator/api` dependency.
 */
export const strykerPlugins = [{ kind: 'Ignore', name: RETRY_IGNORER_NAME, injectableClass: RetryIgnorer }];
