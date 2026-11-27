import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Instrumenter } from '@stryker-mutator/instrumenter';

import { join, resolve } from 'node:path';

import { NESTED_REASON, nestedIn, parseSpans, RETRY_IGNORER_NAME, RETRY_SPANS_VAR, RetryIgnorer, strykerPlugins, within, type Span } from './retry-ignorer.ts';
import { mutantSpan } from './timeout-retry.ts';
import type { Mutant } from './verdict.ts';

const span = (text: string): Span => {
  const parsed = parseSpans(`f:${text}`, '/').get('/f')?.[0];
  if (parsed === undefined) throw new Error(`not a span: ${text}`);
  return parsed;
};

test('the names Stryker and the retry config read', () => {
  assert.equal(RETRY_SPANS_VAR, 'AGNIPARIKSHA_RETRY_SPANS');
  assert.equal(RETRY_IGNORER_NAME, 'agnipariksha-retry');
  assert.equal(NESTED_REASON, 'agnipariksha retries a timed-out mutant here, and this node lies inside it');
  assert.equal(strykerPlugins.length, 1);
  assert.deepEqual(strykerPlugins[0], { kind: 'Ignore', name: 'agnipariksha-retry', injectableClass: RetryIgnorer });
});

test('parseSpans reads file:line:column-endLine:endColumn lines, by file resolved against the directory, and nothing else', () => {
  const spans = parseSpans('src/a.ts:12:34-56:78\nsrc/b.ts:3:0-3:9\nsrc/a.ts:1:2-3:4', '/w');
  assert.deepEqual([...spans.keys()], ['/w/src/a.ts', '/w/src/b.ts']);
  assert.deepEqual(spans.get('/w/src/a.ts'), [
    { start: { line: 12, column: 34 }, end: { line: 56, column: 78 } },
    { start: { line: 1, column: 2 }, end: { line: 3, column: 4 } },
  ]);
  assert.deepEqual(spans.get('/w/src/b.ts'), [{ start: { line: 3, column: 0 }, end: { line: 3, column: 9 } }]);
  assert.deepEqual([...parseSpans('/abs/x:y.ts:1:0-2:0', '/w').keys()], ['/abs/x:y.ts'], 'an absolute file stays, colons and all');
  for (const text of [undefined, '', ':3:4-7:8', 'a.ts:3:4-7', 'a.ts:3:4:7:8', 'a.ts:x:4-7:8', 'a.ts:3:4-7:8 ', 'a.ts:3:4-7:-8', '3:4-7:8']) {
    assert.equal(parseSpans(text, '/w').size, 0, String(text));
  }
  assert.equal(parseSpans('a.ts:3:4-7:8\nnonsense\n\nb.ts:1:0-1:1', '/w').size, 2, 'a bad line is skipped, the rest read');
});

test('within: inside, ends included', () => {
  const outer = span('2:4-5:6');
  assert.equal(within(outer, span('2:4-5:6')), true);
  assert.equal(within(outer, span('3:0-4:0')), true);
  assert.equal(within(outer, span('2:3-5:6')), false);
  assert.equal(within(outer, span('2:4-5:7')), false);
  assert.equal(within(outer, span('1:9-5:6')), false);
  assert.equal(within(outer, span('2:4-6:0')), false);
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

/** A node at `text` in `file`, as Stryker's Babel traverse hands one over. */
const at = (text: string, file: string | null = '/w/a.ts') => ({ node: { loc: span(text) }, hub: { file: { opts: { filename: file } } } });

test("the ignorer drops nodes nested in a span of the node's own file, and keeps each span's node, its ancestors and its neighbours", () => {
  const ignorer = new RetryIgnorer({ [RETRY_SPANS_VAR]: 'a.ts:2:4-5:6\na.ts:8:0-9:0\nb.ts:20:0-30:0' }, '/w');
  assert.deepEqual(ignorer.spans.get('/w/a.ts'), [span('2:4-5:6'), span('8:0-9:0')]);
  assert.equal(ignorer.shouldIgnore(at('3:0-3:5')), NESTED_REASON);
  assert.equal(ignorer.shouldIgnore(at('8:2-8:9')), NESTED_REASON, 'inside the second span');
  assert.equal(ignorer.shouldIgnore(at('2:4-5:6')), undefined, 'the span itself');
  assert.equal(ignorer.shouldIgnore(at('1:0-9:0')), undefined, 'an ancestor');
  assert.equal(ignorer.shouldIgnore(at('6:0-6:3')), undefined, 'a neighbour');
  assert.equal(ignorer.shouldIgnore(at('21:0-22:0')), undefined, "another file's span leaves this file alone");
  assert.equal(ignorer.shouldIgnore(at('21:0-22:0', '/w/b.ts')), NESTED_REASON, 'and holds in its own file');
  assert.equal(ignorer.shouldIgnore(at('3:0-3:5', '/w/b.ts')), undefined);
  assert.equal(ignorer.shouldIgnore(at('3:0-3:5', '/w/c.ts')), undefined, 'a file with no span');
  assert.equal(ignorer.shouldIgnore(at('3:0-3:5', 'a.ts')), undefined, "a relative name resolves against the process's directory, not /w");
  assert.equal(ignorer.shouldIgnore({ node: { loc: null }, hub: at('3:0-3:5').hub }), undefined);
  assert.equal(ignorer.shouldIgnore({ node: {}, hub: at('3:0-3:5').hub }), undefined);
  assert.equal(ignorer.shouldIgnore({ node: { loc: span('3:0-3:5') } }), undefined, 'no hub, no file');
  assert.equal(ignorer.shouldIgnore({ node: { loc: span('3:0-3:5') }, hub: null }), undefined);
  assert.equal(ignorer.shouldIgnore({ node: { loc: span('3:0-3:5') }, hub: {} }), undefined);
  assert.equal(ignorer.shouldIgnore({ node: { loc: span('3:0-3:5') }, hub: { file: {} } }), undefined);
  assert.equal(ignorer.shouldIgnore(at('3:0-3:5', null)), undefined);
});

test('a node inside one span that holds another is kept, so the inner span is still made', () => {
  const ignorer = new RetryIgnorer({ [RETRY_SPANS_VAR]: 'a.ts:1:0-20:0\na.ts:5:0-6:0' }, '/w');
  assert.equal(ignorer.shouldIgnore(at('4:0-7:0')), undefined, 'holds 5:0-6:0');
  assert.equal(ignorer.shouldIgnore(at('5:0-6:0')), undefined, 'is 5:0-6:0');
  assert.equal(ignorer.shouldIgnore(at('5:1-5:9')), NESTED_REASON);
  assert.equal(ignorer.shouldIgnore(at('10:0-11:0')), NESTED_REASON);
});

test("with no span the ignorer drops nothing, and by default it reads process.env and the process's directory", () => {
  assert.equal(new RetryIgnorer({}).spans.size, 0);
  assert.equal(new RetryIgnorer({}).shouldIgnore(at('3:0-3:5')), undefined);
  assert.equal(new RetryIgnorer({ [RETRY_SPANS_VAR]: 'nonsense' }).shouldIgnore(at('3:0-3:5')), undefined);
  const before = process.env[RETRY_SPANS_VAR];
  process.env[RETRY_SPANS_VAR] = 'a.ts:2:4-5:6';
  try {
    const ignorer = new RetryIgnorer();
    assert.deepEqual([...ignorer.spans.keys()], [resolve('a.ts')]);
    assert.equal(ignorer.shouldIgnore(at('3:0-3:5', join(process.cwd(), 'a.ts'))), NESTED_REASON);
  } finally {
    if (before === undefined) delete process.env[RETRY_SPANS_VAR];
    else process.env[RETRY_SPANS_VAR] = before;
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

/** A `--mutate` range's `l:c-l:c`, as Stryker's reader makes it: lines 0-based. */
const range = (text: string) => {
  const parsed = span(text);
  return { start: { ...parsed.start, line: parsed.start.line - 1 }, end: { ...parsed.end, line: parsed.end.line - 1 } };
};

/** Instrument SOURCE under each name, each with its `--mutate` ranges, or whole for null. */
async function instrumentFiles(files: Record<string, string[] | null>, ignorers: RetryIgnorer[], excludedMutations: string[]): Promise<readonly (ApiMutant & { fileName: string })[]> {
  const instrumenter = new Instrumenter(quiet as never);
  const result = await instrumenter.instrument(
    Object.entries(files).map(([name, mutate]) => ({ name, content: SOURCE, mutate: mutate === null ? true : mutate.map(range) })),
    { plugins: null, excludedMutations, ignorers, noHeader: true } as never,
  );
  return result.mutants as readonly (ApiMutant & { fileName: string })[];
}

/** Instrument SOURCE as grade.ts; `mutate` is a `--mutate` range's `l:c-l:c`. */
const instrument = (mutate: string | null, ignorers: RetryIgnorer[], excludedMutations: string[]) =>
  instrumentFiles({ 'grade.ts': mutate === null ? null : [mutate] }, ignorers, excludedMutations);

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
    retry: await instrument(spanText, [new RetryIgnorer({ [RETRY_SPANS_VAR]: `grade.ts:${spanText}` })], excluded),
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

const spanOf = (m: ApiMutant): string => mutantSpan(reported(m)) ?? '';

test('one round retries two spans in one file: each is made, and what lies inside either is ignored', async () => {
  const whole = await instrument(null, [], []);
  const block = whole.find((m) => m.mutatorName === 'BlockStatement' && m.location.start.line === 1);
  const call = whole.find((m) => m.mutatorName === 'CallExpression' && m.location.start.line === 5);
  if (block === undefined || call === undefined) throw new Error('no such mutants');
  const spans = [spanOf(block), spanOf(call)];
  const ignorer = new RetryIgnorer({ [RETRY_SPANS_VAR]: spans.map((s) => `grade.ts:${s}`).join('\n') });
  const others = [...new Set(whole.map((m) => m.mutatorName))].filter((name) => name !== 'BlockStatement' && name !== 'CallExpression');
  const retry = await instrumentFiles({ 'grade.ts': spans }, [ignorer], others);
  assert.deepEqual(live(retry).map((m) => `${m.line} ${m.mutator}`).sort(), ['2 BlockStatement', '6 CallExpression']);
  assert.ok(retry.some((m) => m.status === 'Ignored'), 'the block held other mutants');
});

test('one round retries spans in two files: each file keeps its own, and neither is ignored by the other', async () => {
  const whole = await instrument(null, [], []);
  const condition = whole.find((m) => m.mutatorName === 'ConditionalExpression' && m.location.start.line === 1 && m.replacement === 'true');
  const block = whole.find((m) => m.mutatorName === 'BlockStatement' && m.location.start.line === 1);
  if (condition === undefined || block === undefined) throw new Error('no such mutants');
  // a.ts retries the condition; b.ts retries the block, which holds a.ts's span by place but not by file.
  const ignorer = new RetryIgnorer({ [RETRY_SPANS_VAR]: `a.ts:${spanOf(condition)}\nb.ts:${spanOf(block)}` });
  const retry = await instrumentFiles({ 'a.ts': [spanOf(condition)], 'b.ts': [spanOf(block)] }, [ignorer], []);
  const made = (file: string) => retry.filter((m) => m.status === undefined && m.fileName === file).map((m) => `${m.mutatorName} ${m.replacement}`);
  assert.ok(made('a.ts').includes('ConditionalExpression true'), made('a.ts').join(', '));
  assert.deepEqual(made('b.ts'), ['BlockStatement {}']);
});
