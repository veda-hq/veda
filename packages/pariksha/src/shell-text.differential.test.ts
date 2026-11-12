/**
 * The shell lexing in shell-text.ts (`codeLines`, `words`), against bash
 * itself.
 *
 * Model: a script of `set -- <words>; printf '%s\n' "$#"` command lines,
 * here-documents fed to `cat`, comment-only lines and blank lines. Words mix
 * bare characters (a `#` glued inside one included), single-quoted runs and
 * double-quoted runs that may span lines and hold `#`, `;` and the other
 * quote, escapes inside and outside double quotes, and words are separated by
 * spaces, tabs and line continuations; a command line may end in a comment.
 * Here-documents use quoted and unquoted delimiters, `<<` and `<<-`, and
 * bodies holding quotes, `#`, `;` and text that reads like a command. bash
 * answers each command line with its word count (`$#`); all sampled scripts
 * run in one bash process. The lexer must give one logical line per command,
 * starting on the command's first physical line, with bash's word count for
 * each `set` line. Out of model: expansions ($VAR, $(…), backticks, globs,
 * ~, braces), operators other than `;`, redirections but the heredoc's,
 * arithmetic, here-strings, `case` patterns, and a backslash ending a line of
 * an unquoted here-document body (bash joins it to the next line before
 * looking for the delimiter; the lexer does not). The seed is fixed so a
 * failure names a reproducible script; the original sampled with fast-check,
 * this suite with a seeded mulberry32 over the same model.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { codeLines, words } from './shell-text.ts';

const SEED = 20_089;
const RUNS = 200;

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

type Draw<T> = (next: () => number) => T;
const pick = <T>(items: readonly T[], next: () => number): T => items[Math.floor(next() * items.length)] as T;
const constant =
  <T>(...items: readonly T[]): Draw<T> =>
  (next) =>
    pick(items, next);
const array =
  <T>(draw: Draw<T>, min: number, max: number): Draw<T[]> =>
  (next) =>
    Array.from({ length: min + Math.floor(next() * (max - min + 1)) }, () => draw(next));

const bare = constant('a', '-x', 'k=v', 'a#', '%', '.', ':');
const single: Draw<string> = (next) => `'${array(constant('a', ' ', '"', '\\', '#', ';', '\n'), 0, 4)(next).join('')}'`;
const double: Draw<string> = (next) => `"${array(constant('a', ' ', "'", '#', ';', '\\\\', '\\"', '\\a', '\n'), 0, 4)(next).join('')}"`;
const escaped = constant("\\'", '\\"', '\\#', '\\\\', '\\a', '\\ ', '\\;');
const piece: Draw<string> = (next) => pick([bare, single, double, escaped], next)(next);
const word: Draw<string> = (next) => array(piece, 1, 4)(next).join('');
const gap = constant(' ', '  ', '\t', ' \\\n ');
const comment: Draw<string> = (next) => `${constant(' # ', '\t#', ' #')(next)}${array(constant('a', ' ', "'", '"', '#', ';'), 0, 4)(next).join('')}`;

/** One command of the script: its text and what the lexer must make of it. */
interface Command {
  readonly text: string;
  /** `count`: a `set` line bash counts; `heredoc`: a `cat` line; `none`: no code. */
  readonly kind: 'count' | 'heredoc' | 'none';
}

const countLine: Draw<Command> = (next) => {
  const parts = array((n) => `${gap(n)}${word(n)}`, 0, 4)(next);
  const tail = next() < 0.5 ? '' : comment(next);
  return { text: `set --${parts.join('')}; printf '%s\\n' "$#"${tail}`, kind: 'count' };
};

const bodyLine: Draw<string> = (next) => array(constant('a', ' ', "'", '"', '#', ';', '\\a', 'set -- x'), 0, 4)(next).join('');

const heredoc: Draw<Command> = (next) => {
  const [operator, terminator] = constant(["'EOF'", 'EOF'], ['"EOF"', 'EOF'], ['EOF', 'EOF'], ["-'EOF'", '\tEOF'], ['-EOF', '\tEOF'])(next);
  return { text: [`cat >/dev/null <<${operator}`, ...array(bodyLine, 0, 3)(next), terminator].join('\n'), kind: 'heredoc' };
};

const quiet = constant<Command>({ text: '# a note; set -- a', kind: 'none' }, { text: '  # indented note', kind: 'none' }, { text: '', kind: 'none' });

/** Count lines four times as often as each other kind, as the original weighed them. */
const command: Draw<Command> = (next) => pick([countLine, countLine, countLine, countLine, heredoc, quiet], next)(next);

const scripts = (): Command[][] => {
  const next = random(SEED);
  return Array.from({ length: RUNS }, () => array(command, 1, 5)(next));
};

/** bash's `$#` for each `set` line of every script, all in one run. */
const bashCounts = (all: readonly (readonly Command[])[]): number[][] => {
  const text = all.map((commands) => `${commands.map((c) => c.text).join('\n')}\nprintf '\\1'`).join('\n');
  const output = execFileSync('bash', ['--norc', '--noprofile', '-c', text], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', LC_ALL: 'C' },
  });
  return output
    .split('\u0001')
    .slice(0, all.length)
    .map((chunk) => chunk.split('\n').filter(Boolean).map(Number));
};

type Lexed = readonly { readonly line: number; readonly read: string | undefined }[];

/** What the lexer makes of a script: each logical line's start and words. */
const ours = (commands: readonly Command[]): Lexed =>
  codeLines(commands.map((c) => c.text).join('\n')).map((entry) => {
    const found = words(entry.code);
    return { line: entry.line, read: found[0] === 'set' ? `count ${String(found.length - 2)}` : found[0] };
  });

/** What it must make of it: one logical line per command, bash's counts. */
const expected = (commands: readonly Command[], counts: readonly number[]): Lexed => {
  const out: { line: number; read: string }[] = [];
  let line = 1;
  let next = 0;
  for (const c of commands) {
    if (c.kind === 'count') {
      out.push({ line, read: `count ${String(counts[next])}` });
      next += 1;
    } else if (c.kind === 'heredoc') {
      out.push({ line, read: 'cat' });
    }
    line += c.text.split('\n').length;
  }
  return out;
};

describe('shell-text lexes commands as bash runs them', () => {
  it('codeLines and words match bash on sampled scripts', () => {
    const sampled = scripts();
    const counts = bashCounts(sampled);
    // Not vacuous: bash counted words on most sampled scripts.
    assert.ok(counts.flat().length > RUNS);
    const wrong = sampled
      .map((commands, index) => ({ script: commands.map((c) => c.text).join('\n'), ours: ours(commands), bash: expected(commands, counts[index] as number[]) }))
      .filter((entry) => JSON.stringify(entry.ours) !== JSON.stringify(entry.bash));
    assert.deepEqual(wrong, []);
  });

  for (const [label, line, tail] of [
    ['a glued `#` is part of the word', 'set -- a#b c', ''],
    ['a comment after a blank is dropped', 'set -- a', ' # b; c'],
    ['a quoted `;` and `#` stay in the word', `set -- 'a;#b' "c # d"`, ''],
    ['a continuation joins the line', 'set -- a \\\n b', ''],
    ['a quoted string spans lines', "set -- 'a\nb' c", ''],
  ] as const) {
    it(label, () => {
      const commands: Command[] = [{ text: `${line}; printf '%s\\n' "$#"${tail}`, kind: 'count' }];
      assert.deepEqual(ours(commands), expected(commands, bashCounts([commands])[0] as number[]));
    });
  }
});
