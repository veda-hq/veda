import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Instrumenter } from '@stryker-mutator/instrumenter';

import { NESTED_REASON, nestedIn, parseSpan, RETRY_IGNORER_NAME, RETRY_SPAN_VAR, RetryIgnorer, strykerPlugins, type Span } from './retry-ignorer.ts';
import { mutantSpan } from './timeout-retry.ts';
import type { Mutant } from './verdict.ts';

const span = (text: string): Span => {
  const parsed = parseSpan(text);
  if (parsed === null) throw new Error(`not a span: ${text}`);
  return parsed;
};

test('the names Stryker and the retry config read', () => {
  assert.equal(RETRY_SPAN_VAR, 'AGNIPARIKSHA_RETRY_SPAN');
  assert.equal(RETRY_IGNORER_NAME, 'agnipariksha-retry');
  assert.equal(NESTED_REASON, 'agnipariksha retries one mutant alone, and this node lies inside it');
  assert.equal(strykerPlugins.length, 1);
  assert.deepEqual(strykerPlugins[0], { kind: 'Ignore', name: 'agnipariksha-retry', injectableClass: RetryIgnorer });
});

test('parseSpan reads line:column-endLine:endColumn and nothing else', () => {
  assert.deepEqual(parseSpan('12:34-56:78'), { start: { line: 12, column: 34 }, end: { line: 56, column: 78 } });
  assert.deepEqual(parseSpan('3:0-3:9'), { start: { line: 3, column: 0 }, end: { line: 3, column: 9 } });
  for (const text of [undefined, '', '3:4-7', '3:4:7:8', 'a:4-7:8', ' 3:4-7:8', '3:4-7:8 ', '3:4-7:-8', 'x3:4-7:8']) {
    assert.equal(parseSpan(text), null, String(text));
  }
});

test('nestedIn: inside the span and not the span itself', () => {
  const outer = span('2:4-5:6');
  const cases: [string, boolean][] = [
    ['2:4-5:6', false],
    ['3:0-4:9', true],
    ['3:4-4:6', true],
    ['2:4-5:5', true],
    ['2:5-5:6', true],
    ['2:4-2:9', true],
    ['5:0-5:6', true],
    ['2:3-5:6', false],
    ['1:9-5:6', false],
    ['2:4-5:7', false],
    ['2:4-6:0', false],
    ['1:0-9:0', false],
    ['1:0-1:3', false],
    ['6:0-6:3', false],
    ['2:0-2:3', false],
    ['5:7-5:9', false],
  ];
  for (const [loc, nested] of cases) assert.equal(nestedIn(outer, span(loc)), nested, loc);
});

const at = (text: string) => ({ node: { loc: span(text) } });

test('the ignorer drops nodes nested in the span from its variable, and keeps the node itself, its ancestors and its neighbours', () => {
  const ignorer = new RetryIgnorer({ [RETRY_SPAN_VAR]: '2:4-5:6' });
  assert.deepEqual(ignorer.span, span('2:4-5:6'));
  assert.equal(ignorer.shouldIgnore(at('3:0-3:5')), NESTED_REASON);
  assert.equal(ignorer.shouldIgnore(at('2:4-5:6')), undefined);
  assert.equal(ignorer.shouldIgnore(at('1:0-9:0')), undefined);
  assert.equal(ignorer.shouldIgnore(at('6:0-6:3')), undefined);
  assert.equal(ignorer.shouldIgnore({ node: { loc: null } }), undefined);
  assert.equal(ignorer.shouldIgnore({ node: {} }), undefined);
});

test('with no span the ignorer drops nothing, and by default it reads process.env', () => {
  assert.equal(new RetryIgnorer({}).span, null);
  assert.equal(new RetryIgnorer({}).shouldIgnore(at('3:0-3:5')), undefined);
  assert.equal(new RetryIgnorer({ [RETRY_SPAN_VAR]: 'nonsense' }).shouldIgnore(at('3:0-3:5')), undefined);
  const before = process.env[RETRY_SPAN_VAR];
  process.env[RETRY_SPAN_VAR] = '2:4-5:6';
  try {
    assert.deepEqual(new RetryIgnorer().span, span('2:4-5:6'));
  } finally {
    if (before === undefined) delete process.env[RETRY_SPAN_VAR];
    else process.env[RETRY_SPAN_VAR] = before;
  }
});

// Stryker's own instrumenter, as a retry runs it: the `--mutate` range over
// the mutant's span, the retry ignorer and the mutators the retry leaves out.
const SOURCE = [
  'export function grade(score: number): string {',
  '  if (score > 50) {',
  "    const bonus = score * 2 + 1;",
  "    return bonus > 100 ? 'top' : 'pass';",
  '  }',
  '  notify(score);',
  "  return 'fail';",
  '}',
  '',
].join('\n');

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, isDebugEnabled: () => false };
interface ApiMutant {
  mutatorName: string;
  replacement: string;
  status?: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
}

/** Instrument SOURCE; `mutate` is a `--mutate` range's `l:c-l:c`, which Stryker's reader makes 0-based in lines. */
async function instrument(mutate: string | null, ignorers: RetryIgnorer[], excludedMutations: string[]): Promise<readonly ApiMutant[]> {
  const range = mutate === null ? null : span(mutate);
  const description = range === null ? true : [{ start: { ...range.start, line: range.start.line - 1 }, end: { ...range.end, line: range.end.line - 1 } }];
  const instrumenter = new Instrumenter(quiet as never);
  const result = await instrumenter.instrument([{ name: 'grade.ts', content: SOURCE, mutate: description }], {
    plugins: null,
    excludedMutations,
    ignorers,
    noHeader: true,
  } as never);
  return result.mutants as readonly ApiMutant[];
}

/** A report's mutant, as Stryker's JSON report counts: lines and columns 1-based. */
const reported = (m: ApiMutant): Mutant => ({
  file: 'grade.ts',
  status: m.status ?? 'Pending',
  mutator: m.mutatorName,
  replacement: m.replacement,
  line: m.location.start.line + 1,
  column: m.location.start.column + 1,
  endLine: m.location.end.line + 1,
  endColumn: m.location.end.column + 1,
});

async function retried(target: (m: ApiMutant) => boolean): Promise<{ range: readonly ApiMutant[]; retry: readonly ApiMutant[]; target: Mutant }> {
  const whole = await instrument(null, [], []);
  const found = whole.find(target);
  if (found === undefined) throw new Error('no such mutant');
  const all = whole.map(reported);
  const mutant = reported(found);
  const spanText = mutantSpan(mutant) ?? '';
  const excluded = [...new Set(all.filter((o) => o.mutator !== mutant.mutator).map((o) => o.mutator))];
  return {
    range: await instrument(spanText, [], []),
    retry: await instrument(spanText, [new RetryIgnorer({ [RETRY_SPAN_VAR]: spanText })], excluded),
    target: mutant,
  };
}

const live = (mutants: readonly ApiMutant[]) => mutants.filter((m) => m.status === undefined).map(reported);
const sameAs = (a: Mutant, b: Mutant) => a.line === b.line && a.column === b.column && a.mutator === b.mutator && a.replacement === b.replacement;

test("a BlockStatement's retry makes only that mutant, where its range alone makes every mutant in the block", async () => {
  const { range, retry, target } = await retried((m) => m.mutatorName === 'BlockStatement' && m.location.start.line === 1);
  assert.ok(live(range).length > 5, `the range alone made ${live(range).length}`);
  assert.equal(live(retry).length, 1);
  assert.ok(sameAs(live(retry)[0] as Mutant, target));
  assert.ok(retry.filter((m) => m.status === 'Ignored').length > 0);
});

test("a node's retry keeps only its own mutator's replacements: Stryker's options select no finer", async () => {
  const { retry, target } = await retried((m) => m.mutatorName === 'EqualityOperator' && m.location.start.line === 1 && m.replacement === 'score >= 50');
  assert.deepEqual(live(retry).map((m) => `${m.mutator} ${m.replacement}`).sort(), ['EqualityOperator score <= 50', 'EqualityOperator score >= 50']);
  assert.ok(live(retry).some((m) => sameAs(m, target)));
});

// The CallExpression mutator keeps its mutant only when no other live mutant
// shares its subtree. A retry only takes mutants out of that scope, so it keeps it.
test("a CallExpression's retry keeps it through its mutator's filter", async () => {
  const { retry, target } = await retried((m) => m.mutatorName === 'CallExpression' && m.location.start.line === 5);
  assert.deepEqual(live(retry).map((m) => `${m.mutator} ${m.replacement}`), ['CallExpression ;']);
  assert.ok(sameAs(live(retry)[0] as Mutant, target));
});
