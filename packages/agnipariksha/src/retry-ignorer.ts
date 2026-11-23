/**
 * The Stryker ignorer a timeout retry loads, so the retry runs the mutant it
 * retries and not every mutant nested inside it.
 *
 * A retry selects its mutant with `--mutate file:l:c-l:c`, and Stryker mutates
 * every node inside that range. For a BlockStatement that is every mutant in
 * the block, each run one by one at concurrency 1: one of `cli.ts`'s retries
 * ran 54. This ignorer drops every node strictly inside the retried mutant's
 * span, and Stryker drops each such node's whole subtree with it. The node at
 * the span itself and its ancestors stay, so the retried mutant is still made.
 *
 * Stryker loads it in its own process, from `dist/`, through the retry
 * config's `appendPlugins`; it imports nothing.
 */

/**
 * The variable that carries the retried mutant's span, `line:column-endLine:endColumn`:
 * lines 1-based and columns 0-based, as Babel counts them.
 */
export const RETRY_SPAN_VAR = 'AGNIPARIKSHA_RETRY_SPAN';
/** The name the retry config lists in `ignorers`. */
export const RETRY_IGNORER_NAME = 'agnipariksha-retry';
/** Stryker reports it on each ignored mutant. */
export const NESTED_REASON = 'agnipariksha retries one mutant alone, and this node lies inside it';

export interface Position {
  line: number;
  column: number;
}
export interface Span {
  start: Position;
  end: Position;
}

/** The span a `RETRY_SPAN_VAR` value names, or null. */
export function parseSpan(text: string | undefined): Span | null {
  // An unset variable reads as "undefined", which is no span.
  const match = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(String(text));
  if (match === null) return null;
  const [line, column, endLine, endColumn] = match.slice(1).map(Number) as [number, number, number, number];
  return { start: { line, column }, end: { line: endLine, column: endColumn } };
}

const atOrBefore = (a: Position, b: Position): boolean => a.line < b.line || (a.line === b.line && a.column <= b.column);
const samePosition = (a: Position, b: Position): boolean => a.line === b.line && a.column === b.column;

/** Whether `loc` lies inside `span` and is not `span` itself. */
export function nestedIn(span: Span, loc: Span): boolean {
  const inside = atOrBefore(span.start, loc.start) && atOrBefore(loc.end, span.end);
  return inside && !(samePosition(span.start, loc.start) && samePosition(span.end, loc.end));
}

/** The part of Babel's NodePath the ignorer reads. */
export interface NodePathLike {
  node: { loc?: Span | null };
}

/**
 * Ignores every node nested in the span `RETRY_SPAN_VAR` names. With no span
 * it ignores nothing, and the retry runs the whole range, as it did before.
 */
export class RetryIgnorer {
  readonly span: Span | null;

  constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
    this.span = parseSpan(env[RETRY_SPAN_VAR]);
  }

  shouldIgnore(path: NodePathLike): string | undefined {
    const loc = path.node.loc;
    return this.span !== null && loc != null && nestedIn(this.span, loc) ? NESTED_REASON : undefined;
  }
}

/**
 * What `declareClassPlugin(PluginKind.Ignore, RETRY_IGNORER_NAME, RetryIgnorer)`
 * returns in Stryker 10.1.1, written out as `arid-nodes.mjs` does, so the
 * package needs no `@stryker-mutator/api` dependency.
 */
export const strykerPlugins = [{ kind: 'Ignore', name: RETRY_IGNORER_NAME, injectableClass: RetryIgnorer }];
