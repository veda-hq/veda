/**
 * The word splitting in doc-commands.ts (`shellWords`), against bash itself.
 *
 * Model: one simple command's words, the argv bash hands a program. Each
 * word joins one to four parts: bare characters (`--mode=`, `./s.sh`,
 * `x=1`), single-quoted runs, double-quoted runs (with `\"`, `\\`, `\$`,
 * `` \` `` and a backslash before a character it does not escape), backslash
 * escapes outside quotes, ANSI-C `$'…'` runs (hex, octal, control, named and
 * unknown escapes, a NUL), `$"…"` runs, and empty quotes; words are separated
 * by spaces and tabs. bash answers with `printf '%s\0'` over the same text,
 * all sampled cases in one bash run. Out of model: expansions (`$VAR`,
 * `$(…)`, backticks, globs, `~`, braces), operators, redirections, comments,
 * unterminated quotes and line continuations; documentedCommands and
 * scriptTarget split on operators, strip comments and join continuations
 * before shellWords reads one trimmed line, so it runs LF only. The seed is
 * fixed so a failure names a reproducible command.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { shellWords } from './doc-commands.ts';

const SEED = 20_089;
const RUNS = 300;

const BARE = ['a', 'pnpm', 'test:tooling', '-m', '--mode=', '--mode=v', 'x=1', './s.sh', 'a/b.ts'];
const SINGLE_TEXT = ['a', ' ', '\t', '"', '\\', 'b c', '#', '$x', '*', '--x'];
const DOUBLE_TEXT = ['a', ' ', "'", '\\"', '\\\\', '\\$', '\\`', '\\a', '#', '*', '~', '--x'];
// ANSI-C and locale quoting. No `\u`/`\U`: macOS ships bash 3.2, which
// predates them; their unit tests pin bash 5's reading.
const ANSI_C_TEXT = ['a', ' ', '--x', '\\x2d', '\\x2', '\\x', '\\055', '\\0101', '\\455', '\\0', '\\cB', '\\e', '\\n', '\\\\', "\\'", '\\"', '\\?', '\\q'];
const LOCALE_TEXT = ['a', ' ', '--x', '\\"', "'"];
const ESCAPED = ['\\ ', '\\\t', "\\'", '\\"', '\\\\', '\\a', '\\#', '\\$', '\\*'];
const GAPS = [' ', '  ', '\t', ' \t '];

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

/** One of `items`, drawn by `next`. */
const pick = <T>(items: readonly T[], next: () => number): T => items[Math.floor(next() * items.length)] as T;

/** An integer in [low, high], drawn by `next`. */
const between = (low: number, high: number, next: () => number): number => low + Math.floor(next() * (high - low + 1));

/** `RUNS` commands of one to five words, and every kind of piece drawn. */
const sample = (): { cases: string[]; drawn: Set<string> } => {
  const next = random(SEED);
  const drawn = new Set<string>();
  const constant = (kind: string, items: readonly string[]): string => {
    const item = pick(items, next);
    drawn.add(`${kind} ${JSON.stringify(item)}`);
    return item;
  };
  const run = (kind: string, open: string, close: string, items: readonly string[], most: number): string => {
    const length = between(0, most, next);
    if (length === 0) drawn.add(`${kind} empty`);
    return `${open}${Array.from({ length }, () => constant(kind, items)).join('')}${close}`;
  };
  const PARTS: ReadonlyArray<readonly [string, () => string]> = [
    ['bare', () => constant('bare', BARE)],
    ['single', () => run('single', "'", "'", SINGLE_TEXT, 4)],
    ['double', () => run('double', '"', '"', DOUBLE_TEXT, 4)],
    ['escaped', () => constant('escaped', ESCAPED)],
    ['ansiC', () => run('ansiC', "$'", "'", ANSI_C_TEXT, 4)],
    ['locale', () => run('locale', '$"', '"', LOCALE_TEXT, 3)],
  ];
  const word = (): string =>
    Array.from({ length: between(1, 4, next) }, () => {
      const [kind, draw] = pick(PARTS, next);
      drawn.add(`part ${kind}`);
      return draw();
    }).join('');
  const cases = Array.from({ length: RUNS }, () => {
    const first = word();
    const rest = Array.from({ length: between(0, 4, next) }, () => `${constant('gap', GAPS)}${word()}`);
    drawn.add(`words ${1 + rest.length}`);
    return `${first}${rest.join('')}`;
  });
  return { cases, drawn };
};

/** Every kind of piece the model may draw. */
const ALL_KINDS: readonly string[] = [
  ...['bare', 'single', 'double', 'escaped', 'ansiC', 'locale'].map((kind) => `part ${kind}`),
  ...BARE.map((item) => `bare ${JSON.stringify(item)}`),
  ...SINGLE_TEXT.map((item) => `single ${JSON.stringify(item)}`),
  ...DOUBLE_TEXT.map((item) => `double ${JSON.stringify(item)}`),
  ...ANSI_C_TEXT.map((item) => `ansiC ${JSON.stringify(item)}`),
  ...LOCALE_TEXT.map((item) => `locale ${JSON.stringify(item)}`),
  ...ESCAPED.map((item) => `escaped ${JSON.stringify(item)}`),
  ...GAPS.map((item) => `gap ${JSON.stringify(item)}`),
  ...['single', 'double', 'ansiC', 'locale'].map((kind) => `${kind} empty`),
  ...[1, 2, 3, 4, 5].map((count) => `words ${count}`),
];

/** bash's words for every case, in one run. */
const bashWords = (cases: readonly string[]): string[][] => {
  const script = cases.map((text) => `printf '%s\\0' ${text}; printf '\\1'`).join('\n');
  const output = execFileSync('bash', ['--norc', '--noprofile', '-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', LC_ALL: 'C' },
    // One bash process for every sampled case; a hung one fails the test.
    timeout: 120_000,
  });
  return output
    .split('\u0001')
    .slice(0, cases.length)
    .map((chunk) => chunk.split('\u0000').slice(0, -1));
};

describe('doc-commands splits words as bash does', () => {
  it('shellWords matches bash on sampled commands', () => {
    const { cases } = sample();
    assert.equal(cases.length, RUNS);
    const expected = bashWords(cases);
    const wrong = cases.map((text, index) => ({ text, ours: shellWords(text), bash: expected[index] })).filter((entry) => JSON.stringify(entry.ours) !== JSON.stringify(entry.bash));
    assert.deepEqual(wrong, []);
  });

  it('draws every kind of piece, the same commands on every run', () => {
    const { cases, drawn } = sample();
    assert.deepEqual([...drawn].sort(), [...ALL_KINDS].sort());
    assert.deepEqual(sample().cases, cases);
  });

  it('is not vacuous: bash hands several words per sampled command', () => {
    const { cases } = sample();
    const words = bashWords(cases).flat().length;
    assert.ok(words > RUNS * 2, `${words} words`);
  });

  const fixed: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['a quoted empty word', "a '' b", ['a', '', 'b']],
    ['a quoted flag value loses its quotes', '--mode="v"', ['--mode=v']],
    ['a quoted value with spaces stays one word', '--reason="a --x b" c', ['--reason=a --x b', 'c']],
    ['adjacent quotes join one word', `'a'"b"c`, ['abc']],
    ['an escaped space joins a word', 'a\\ b', ['a b']],
    ['an escaped quote inside double quotes', '"a\\"b"', ['a"b']],
    ['a backslash stays inside double quotes', '"a\\b"', ['a\\b']],
    ['a backslash is literal inside single quotes', "'a\\'", ['a\\']],
    ['an ANSI-C flag', "$'\\x2d\\x2dunknown'", ['--unknown']],
    ['an ANSI-C string ends at its NUL', "a$'b\\0c'd", ['abd']],
    ['a locale string', '$"--x"', ['--x']],
  ];
  for (const [label, text, words] of fixed) {
    it(label, () => {
      assert.deepEqual(shellWords(text), words);
      assert.deepEqual(bashWords([text]), [words]);
    });
  }
});
