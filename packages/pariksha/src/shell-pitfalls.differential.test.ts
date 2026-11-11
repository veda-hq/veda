/**
 * The hand quote reading in shell-pitfalls.ts, against bash itself:
 * `shellValue` (the regex a grep pattern word passes, after quote removal)
 * through the grep-ere-perl-class rule, and `evaluatedText` (which
 * `$(( … ))` bash evaluates rather than prints) through the octal-arithmetic
 * rule. Both are private, so each is judged by the verdict `checkShellText`
 * gives.
 *
 * Model, grep: `grep -E W f`, `grep -E -e W f` or `egrep W f`, where the
 * pattern word W joins pieces of bare text, backslash escapes (`\s`, `\\s`,
 * `\\\s`, `\'`, `\"`, `\ `), single-quoted runs, double-quoted and locale
 * `$"…"` runs holding `\s`, `\\`, `\"`, `\$` or a blank, and ANSI-C `$'…'`
 * runs holding `\s`, `\\`, `\'`, `\n` or `\q`. bash prints the word's value;
 * the rule must fire exactly when that value holds an odd run of backslashes
 * before s, S, d or D (the class POSIX ERE lacks).
 *
 * Model, arithmetic: `printf '%s\n' <lead> <context>`, after `read X` for
 * the rule, where the context places `$((X + 1))` bare, inside double or
 * locale quotes (`$(((X) + 1))` too), inside single or ANSI-C quotes, after
 * `\$` or a bare `((` inside double quotes, or beside escaped quotes, the
 * other quote and `'it'\''s'`; the lead word is digit-free quote noise. bash
 * runs it with X=5; it evaluated the arithmetic exactly when a 6 is printed,
 * and the rule must fire exactly then.
 *
 * All sampled cases of each part run in one bash process. Out of model:
 * octal, hex and `\c` escapes inside `$'…'` (they can spell a backslash:
 * `$'\134s'` is `\s`), unterminated quotes, expansions ($VAR, $(…),
 * backticks, globs, ~, braces), quotes inside `$(( … ))` (bash rejects
 * them), and the `(( … ))` command. The seed is fixed so a failure names a
 * reproducible case; the original sampled with fast-check, this suite with
 * a seeded mulberry32, so the sampled cases differ but the model is the same.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { checkShellText } from './shell-pitfalls.ts';

const SEED = 20_089;
const RUNS = 300;

/** mulberry32: a small seeded PRNG, uniform on [0, 1). */
const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const pick = <T>(items: readonly T[], next: () => number): T => items[Math.floor(next() * items.length)] as T;

/** An odd run of backslashes before s/S/d/D: a Perl class in the regex. */
const PERL_CLASS = /(?:^|[^\\])(?:\\\\)*\\[sSdD]/;

/** Pieces of a grep pattern word; each closes every quote it opens. */
const PATTERN_PIECES: readonly string[] = [
  'a',
  's',
  String.raw`\s`,
  String.raw`\d`,
  String.raw`\S`,
  String.raw`\D`,
  String.raw`\\s`,
  String.raw`\\\s`,
  String.raw`\\`,
  String.raw`\a`,
  String.raw`\'`,
  String.raw`\"`,
  String.raw`\ `,
  String.raw`'\s'`,
  String.raw`'\\s'`,
  String.raw`'\'`,
  String.raw`'a b'`,
  String.raw`'it'\''s'`,
  String.raw`"\s"`,
  String.raw`"\\s"`,
  String.raw`"\\\s"`,
  String.raw`"\"\s"`,
  String.raw`"\$"`,
  String.raw`"\\"`,
  String.raw`"a b"`,
  String.raw`"'"`,
  String.raw`$"\s"`,
  String.raw`$"\\s"`,
  String.raw`$'\s'`,
  String.raw`$'\\s'`,
  String.raw`$'\\\s'`,
  String.raw`$'\'\s'`,
  String.raw`$'\n'`,
  String.raw`$'\q'`,
  String.raw`\\$"\s"`,
  String.raw`\\$'\s'`,
];

const GREP_SHAPES: readonly ((word: string) => string)[] = [(word) => `grep -E ${word} f`, (word) => `grep -E -e ${word} f`, (word) => `egrep ${word} f`];

/** One to four pattern pieces, in one of the grep shapes. */
const grepCases = (): { word: string; shape: (word: string) => string }[] => {
  const next = random(SEED);
  return Array.from({ length: RUNS }, () => ({
    word: Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(PATTERN_PIECES, next)).join(''),
    shape: pick(GREP_SHAPES, next),
  }));
};

/** Runs every statement in one bash; the output of each, in order. */
const bashOutputs = (statements: readonly string[], env: Readonly<Record<string, string>> = {}): string[] => {
  const script = statements.map((statement) => `${statement}; printf '\\1\\n'`).join('\n');
  const output = execFileSync('bash', ['--norc', '--noprofile', '-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', LC_ALL: 'C', ...env },
    // One bash process for every sampled case; a hung one fails the test.
    timeout: 120_000,
  });
  return output.split('\u0001\n').slice(0, statements.length);
};

/** The value bash passes for each word. */
const bashValues = (words: readonly string[]): string[] => bashOutputs(words.map((word) => `printf '%s' ${word}`));

const PITFALLS = { id: 'shell-pitfalls', validatorPaths: [] };
const fires = (text: string, rule: string): boolean => checkShellText('scripts/edge-12.sh', text, PITFALLS).some((finding) => finding.rule === rule);

const ARITHMETIC = '$((X + 1))';

/** Each context, as the argument that places `$((X + 1))` in it. */
const CONTEXTS: Readonly<Record<string, string>> = {
  bare: ARITHMETIC,
  double: `"a ${ARITHMETIC} b"`,
  single: `'a ${ARITHMETIC} b'`,
  afterSingle: `'q'${ARITHMETIC}`,
  escapedSingles: String.raw`\'${ARITHMETIC}\'`,
  singlesInDouble: `"'"${ARITHMETIC}"'"`,
  doublesInSingle: `'"'${ARITHMETIC}'"'`,
  doubleInsideSingle: `'"${ARITHMETIC}"'`,
  escapedDoubles: String.raw`"\"${ARITHMETIC}\""`,
  itsQuote: String.raw`'it'\''s ${ARITHMETIC}'`,
  escapedBackslashInDouble: String.raw`"\\"'${ARITHMETIC}'`,
  escapedBackslashThenSingle: String.raw`\\'${ARITHMETIC}'`,
  escapedBackslash: String.raw`\\${ARITHMETIC}`,
  locale: `$"a ${ARITHMETIC} b"`,
  ansiC: `$'a ${ARITHMETIC} b'`,
  ansiCEscapedQuote: String.raw`$'a\' ${ARITHMETIC}'`,
  afterAnsiC: String.raw`$'\''${ARITHMETIC}`,
  escapedDollarInDouble: `"\\${ARITHMETIC}"`,
  escapedBackslashDollarInDouble: `"\\\\${ARITHMETIC}"`,
  bareParensInDouble: '"((X + 1))"',
  nestedInDouble: '"$(((X) + 1))"',
};

/** Digit-free lead words, so a printed 6 can only be the arithmetic. */
const LEADS: readonly string[] = ['', "'a' ", '"b" ', String.raw`\' `, String.raw`'it'\''s' `, String.raw`"q\"x" `, String.raw`\\ `, String.raw`"it's" `, String.raw`$'q\'' `, String.raw`$"b" `];

const arithmeticCases = (): string[] => {
  const next = random(SEED);
  const names = Object.keys(CONTEXTS);
  return Array.from({ length: RUNS }, () => {
    const context = pick(names, next);
    return `printf '%s\\n' ${pick(LEADS, next)}${CONTEXTS[context] as string}`;
  });
};

/** Whether bash evaluated the arithmetic in each statement (X=5 gives 6). */
const bashEvaluates = (statements: readonly string[]): boolean[] => bashOutputs(statements, { X: '5' }).map((output) => output.includes('6'));

const reportsArithmetic = (statement: string): boolean => fires(`read X\n${statement}`, 'octal-arithmetic');

describe('shell pitfalls read quoting as bash does', () => {
  it('grep-ere-perl-class fires exactly when bash passes a Perl class', () => {
    const cases = grepCases();
    const values = bashValues(cases.map(({ word }) => word));
    const wrong = cases
      .map(({ word, shape }, index) => ({
        line: shape(word),
        value: values[index],
        ours: fires(shape(word), 'grep-ere-perl-class'),
        bash: PERL_CLASS.test(values[index] as string),
      }))
      .filter((entry) => entry.ours !== entry.bash);
    assert.deepEqual(wrong, []);
  });

  it('octal-arithmetic fires exactly when bash evaluates the arithmetic', () => {
    const cases = arithmeticCases();
    const evaluated = bashEvaluates(cases);
    const wrong = cases.map((statement, index) => ({ statement, ours: reportsArithmetic(statement), bash: evaluated[index] })).filter((entry) => entry.ours !== entry.bash);
    assert.deepEqual(wrong, []);
  });

  it('is not vacuous: bash passes a class for some pieces and not others', () => {
    const values = bashValues(PATTERN_PIECES);
    assert.deepEqual(
      PATTERN_PIECES.filter((_, index) => PERL_CLASS.test(values[index] as string)),
      [
        String.raw`\\s`,
        String.raw`\\\s`,
        String.raw`'\s'`,
        String.raw`"\s"`,
        String.raw`"\\s"`,
        String.raw`"\"\s"`,
        String.raw`$"\s"`,
        String.raw`$"\\s"`,
        String.raw`$'\s'`,
        String.raw`$'\\s'`,
        String.raw`$'\'\s'`,
      ],
    );
  });

  it('is not vacuous: bash evaluates in some contexts and not others', () => {
    const names = Object.keys(CONTEXTS);
    const evaluated = bashEvaluates(names.map((name) => `printf '%s\\n' ${CONTEXTS[name] as string}`));
    assert.deepEqual(
      names.filter((_, index) => evaluated[index]),
      ['bare', 'double', 'afterSingle', 'escapedSingles', 'singlesInDouble', 'doublesInSingle', 'escapedDoubles', 'escapedBackslash', 'locale', 'afterAnsiC', 'escapedBackslashDollarInDouble', 'nestedInDouble'],
    );
  });

  it('is not vacuous: the sample holds words that fire and words that do not', () => {
    const verdicts = grepCases().map(({ word, shape }) => fires(shape(word), 'grep-ere-perl-class'));
    assert.ok(verdicts.includes(true) && verdicts.includes(false));
  });

  for (const piece of PATTERN_PIECES) {
    it(`the pattern piece ${piece} alone`, () => {
      const [value] = bashValues([piece]);
      assert.equal(fires(`grep -E ${piece} f`, 'grep-ere-perl-class'), PERL_CLASS.test(value as string));
    });
  }

  for (const context of Object.keys(CONTEXTS)) {
    it(`the ${context} context alone`, () => {
      const statement = `printf '%s\\n' ${CONTEXTS[context] as string}`;
      assert.equal(reportsArithmetic(statement), bashEvaluates([statement])[0]);
    });
  }
});
