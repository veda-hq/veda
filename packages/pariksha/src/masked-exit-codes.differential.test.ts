/**
 * masked-exit-codes' and-or list reading (`handlerStarts`) and its printf
 * rendering (`renderPrintf`), against bash itself.
 *
 * Model 1: an and-or list of commands joined by `||`, every one of which
 * fails after printing its own index, so bash runs each top-level command in
 * turn and prints one line per command. A command is `m K` with argument
 * words holding `||` where it is no operator (single quotes, double quotes
 * with `\"`, backslash escapes, `$( … )`, `${ … }`), inside a `{ …; }` group
 * or a `( … )` subshell with an `||` list of its own, or bare.
 * `handlerStarts` must find exactly the operators bash ran a handler for,
 * each at the start of the command bash ran next. Out of model: comments,
 * here-documents, `case` patterns, arithmetic and line continuations, which
 * the callers handle before this reader.
 *
 * Model 2: what `printf FORMAT ARGS…` writes into a `| sh`: a format of
 * text, escapes and `%s`/`%b`/`%%`, and arguments with escapes of their own.
 * No `\u`/`\U`: macOS ships bash 3.2, which predates them.
 *
 * All sampled cases of a model run in one bash process. The seed is fixed,
 * so a failure names a reproducible case.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { handlerStarts, renderPrintf } from './masked-exit-codes.ts';

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

/** `min` to `max` draws of `draw`, the count uniform. */
const some = <T>(min: number, max: number, draw: () => T, next: () => number): T[] => Array.from({ length: min + Math.floor(next() * (max - min + 1)) }, draw);

/** Argument words that hold `||` or a quote without ending the command. */
const NOISE = ['a', "'a||b'", '"a||b"', '"x\\"||y"', "'it'\\''s||'", '\\|\\|', 'a\\|\\|b', '$(: || :)', '"$(: || :)"', '${U:-a||b}', '"${U:-a}||"', '"q\\\\"'];
const SHAPES = ['bare', 'group', 'subshell'] as const;
const OPERATORS = ['||', ' || ', '  ||\t'];

/** The command at `index`: it prints `index`, then fails. */
const render = (shape: (typeof SHAPES)[number], words: readonly string[], index: number): string => {
  const text = [`m ${index}`, ...words].join(' ');
  if (shape === 'group') return `{ ${text}; : || :; false; }`;
  if (shape === 'subshell') return `( ${text}; : || : ; false )`;
  return text;
};

/** `RUNS` sampled lists, the same on every run. */
const sampleLists = (): string[] => {
  const next = random(SEED);
  return Array.from({ length: RUNS }, () => {
    const parts = some(1, 5, () => ({ shape: pick(SHAPES, next), words: some(0, 3, () => pick(NOISE, next), next) }), next);
    const operators = Array.from({ length: 4 }, () => pick(OPERATORS, next));
    return parts.map((part, index) => `${index === 0 ? '' : operators[index - 1]}${render(part.shape, part.words, index)}`).join('');
  });
};

/** The index of each command bash ran, per case, in one run. */
const bashRuns = (cases: readonly string[]): string[][] => {
  const script = ['m() { printf "%s\\n" "$1"; return 1; }', ...cases.map((text) => `${text}; printf '\\1\\n'`)].join('\n');
  const output = execFileSync('bash', ['--norc', '--noprofile', '-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', LC_ALL: 'C' },
    // One bash process for every sampled case; a hung one fails the test.
    timeout: 120_000,
  });
  return output
    .split('\u0001\n')
    .slice(0, cases.length)
    .map((chunk) => chunk.split('\n').filter((line) => line !== ''));
};

/** The index of the command each handler this reader found starts. */
const ourRuns = (text: string): string[] => ['0', ...handlerStarts(text).map((at) => /^\|\|\s*[{(]?\s*m (\d+)/.exec(text.slice(at))?.[1] ?? '?')];

describe('masked-exit-codes reads and-or lists as bash does', () => {
  it('handlerStarts matches bash on sampled lists', () => {
    const cases = sampleLists();
    const expected = bashRuns(cases);
    const wrong = cases.map((text, index) => ({ text, ours: ourRuns(text), bash: expected[index] })).filter((entry) => JSON.stringify(entry.ours) !== JSON.stringify(entry.bash));
    assert.deepEqual(wrong, []);
  });

  it('draws every noise word and shape, the same lists on every run', () => {
    const cases = sampleLists();
    assert.deepEqual(sampleLists(), cases);
    const all = cases.join('\n');
    for (const word of NOISE) assert.ok(all.includes(word), word);
    assert.ok(all.includes('{ m') && all.includes('( m'));
  });

  const named: Array<[string, string, string[]]> = [
    ['a quoted operator', "m 0 'a||b' || m 1", ['0', '1']],
    ['an escaped operator', 'm 0 \\|\\| m 1', ['0']],
    ['a group keeps its own handler', '{ m 0; : || :; false; } || m 1', ['0', '1']],
    ['a substitution keeps its own handler', 'm 0 $(: || :) || m 1', ['0', '1']],
    ['a parameter default holds the text', 'm 0 ${U:-a||b} || m 1', ['0', '1']],
  ];
  for (const [label, text, runs] of named) {
    it(label, () => {
      assert.deepEqual(ourRuns(text), runs);
      assert.deepEqual(bashRuns([text]), [runs]);
    });
  }
});

const ESCAPES = ['\\n', '\\t', '\\\\', '\\x7c', '\\x7', '\\x', '\\174', '\\0174', '\\455', '\\"', "\\'", '\\?', '\\c', '\\q', '\\e'];
const FORMAT_PIECES = ['a', ' ', '|', '%s', '%b', '%%', '\\045', ...ESCAPES];
const ARGUMENT_PIECES = ['a', ' ', '%s', ...ESCAPES];

/** `RUNS` sampled printf calls, a format and its arguments. */
const samplePrintf = (): Array<readonly [string, string[]]> => {
  const next = random(SEED);
  return Array.from({ length: RUNS }, () => {
    const format = some(0, 5, () => pick(FORMAT_PIECES, next), next).join('');
    const args = some(0, 3, () => some(0, 3, () => pick(ARGUMENT_PIECES, next), next).join(''), next);
    return [format, args] as const;
  });
};

/** POSIX single quotes around `text`. */
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** What bash's printf writes for each case, in one run. */
const bashPrintf = (cases: readonly (readonly [string, readonly string[]])[]): string[] => {
  const script = cases.map(([text, args]) => `printf ${[text, ...args].map(quote).join(' ')}; printf '\\1'`).join('\n');
  const output = execFileSync('bash', ['--norc', '--noprofile', '-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', LC_ALL: 'C' },
    // `\x` with no digit warns on stderr, as printf does.
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
  });
  return output.split('\u0001').slice(0, cases.length);
};

describe('masked-exit-codes renders printf as bash does', () => {
  it('renderPrintf matches bash on sampled formats', () => {
    const cases = samplePrintf();
    const expected = bashPrintf(cases);
    const wrong = cases.map(([text, args], index) => ({ text, args, ours: renderPrintf([text, ...args]), bash: expected[index] })).filter((entry) => entry.ours !== entry.bash);
    assert.deepEqual(wrong, []);
  });

  it('draws every piece, the same calls on every run', () => {
    const cases = samplePrintf();
    assert.deepEqual(samplePrintf(), cases);
    const formats = cases.map(([format]) => format).join('');
    for (const piece of FORMAT_PIECES) assert.ok(formats.includes(piece), piece);
  });

  const named: Array<[string, string[], string]> = [
    ['a %b hex escape', ['%b\\n', 'eslint . \\x7c\\x7c true'], 'eslint . || true\n'],
    ['a %b \\c ends all output', ['%b|%s', 'a\\cb', 'c'], 'a'],
    ['a format \\c is text', ['a\\cb'], 'a\\cb'],
    ['format octal is three digits', ['\\0101'], '\b1'],
    ['%b octal follows a zero', ['%b', '\\0101'], 'A'],
  ];
  for (const [label, words, written] of named) {
    it(label, () => {
      assert.equal(renderPrintf(words), written);
      assert.deepEqual(bashPrintf([[words[0] as string, words.slice(1)]]), [written]);
    });
  }

  // bash 4.2 and later; macOS's bash 3.2 writes these as text.
  const modern: Array<[string, string[], string | null]> = [
    ['a \\u escape', ['\\u7c%b', '\\U0000007c'], '||'],
    ['the last code point', ['\\U0010FFFF'], '\u{10FFFF}'],
    ['a code point past Unicode, kept', ['%b', '\\UFFFFFFFF'], '\\UFFFFFFFF'],
    ['a directive this reader does not render', ['%d', '1'], null],
    ['no format', ['--'], null],
  ];
  for (const [label, words, written] of modern) {
    it(label, () => {
      assert.equal(renderPrintf(words), written);
    });
  }
});
