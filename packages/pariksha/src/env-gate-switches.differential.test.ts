/**
 * The shell reader (through `findSwitchReads`) against bash itself.
 *
 * Model: a shell file of statements, each reading its own switch (`S0_SKIP`,
 * `S1_SKIP`, …) in one context: bare, braced, with a default, inside double
 * quotes (on one line or across two), single quotes (on one line or across
 * two), ANSI-C quotes, after a backslash, after a `#` that starts a comment or
 * one inside a word, beside a quoted `<<`, after `$(( … ))`, and in a
 * here-document body, unquoted, quoted (`'EOF'`, `"EOF"`, `\EOF`),
 * tab-stripped (`<<-`) or escaped (`\$`). Each statement may start with a
 * quoted or escaped word. bash runs the file with every switch set to its own
 * marker; a switch is read exactly where its marker is printed. Out of model:
 * assignments (the initialised-first rule has its own unit tests), arithmetic
 * reads without `$`, `case` and control flow, and `eval`. The seed is fixed,
 * so a failure names a reproducible file.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { parseConfig, readerFor } from './env-gate-switches.ts';

const SEED = 20_089;
const RUNS = 200;

/** Each context, as the statement that reads `name` in it. */
const CONTEXTS: ReadonlyArray<readonly [string, (name: string) => string]> = [
  ['bare', (name) => `printf '%s\\n' $${name}`],
  ['braced', (name) => `printf '%s\\n' \${${name}}`],
  ['defaulted', (name) => `printf '%s\\n' "\${${name}:-d}"`],
  ['double', (name) => `printf '%s\\n' "a $${name} b"`],
  ['doubleAcross', (name) => `printf '%s\\n' "a\n$${name} b"`],
  ['single', (name) => `printf '%s\\n' 'a $${name} b'`],
  ['singleAcross', (name) => `printf '%s\\n' 'a\n$${name} b'`],
  ['ansiC', (name) => `printf '%s\\n' $'a \\' $${name}'`],
  ['escaped', (name) => `printf '%s\\n' \\$${name}`],
  ['escapedInDouble', (name) => `printf '%s\\n' "\\$${name}"`],
  ['comment', (name) => `printf '%s\\n' a # $${name}`],
  ['hashInWord', (name) => `printf '%s\\n' a#$${name}`],
  ['quotedHeredocMark', (name) => `printf '%s\\n' '<<EOF' $${name}`],
  ['afterArithmetic', (name) => `printf '%s\\n' $(( 1 << 2 )) $${name}`],
  ['heredoc', (name) => `cat <<EOF\n$${name}\nEOF`],
  ['heredocSingle', (name) => `cat <<'EOF'\n$${name}\nEOF`],
  ['heredocDouble', (name) => `cat <<"EOF"\n$${name}\nEOF`],
  ['heredocEscaped', (name) => `cat <<\\EOF\n$${name}\nEOF`],
  ['heredocTabs', (name) => `cat <<-EOF\n\t$${name}\n\tEOF`],
  ['heredocBodyEscape', (name) => `cat <<EOF\n\\$${name}\nEOF`],
  // `<<<` is a here-string: the next line is code, not a heredoc body.
  ['hereString', (name) => `cat <<<'EOF'\nprintf '%s\\n' $${name}`],
  // A `$` closing a string an earlier line opened is no `$'…'` quote.
  ['doubleAcrossDollar', (name) => `printf '%s\\n' "a\n$"'x\\' $${name}`],
];

const LEADS = ['', "'it'\\''s' ", '"q\\"x" ', 'a\\ b '];

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

/** `RUNS` files of one to six statements, each a context and a lead word, and what was drawn. */
const sample = (): { files: Array<{ count: number; text: string }>; drawn: Set<string> } => {
  const next = random(SEED);
  const drawn = new Set<string>();
  const files = Array.from({ length: RUNS }, () => {
    const count = 1 + Math.floor(next() * 6);
    const statements = Array.from({ length: count }, (_, index) => {
      const [context, read] = pick(CONTEXTS, next);
      const before = pick(LEADS, next);
      drawn.add(context).add(`lead ${before}`);
      const text = read(`S${index}_SKIP`);
      // A lead word goes before the statement's arguments, not before `cat`.
      return before === '' || context.startsWith('heredoc') ? text : text.replace("printf '%s\\n' ", `printf '%s\\n' ${before}`);
    });
    return { count, text: statements.join('\n') };
  });
  return { files, drawn };
};

/** The switches bash expands in `text`, of `S0_SKIP` … `S<count-1>_SKIP`. */
const bashReads = (text: string, count: number): string[] => {
  const names = Array.from({ length: count }, (_, index) => `S${index}_SKIP`);
  const output = execFileSync('bash', ['--norc', '--noprofile', '-c', text], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', LC_ALL: 'C', ...Object.fromEntries(names.map((name, index) => [name, `@${index}@`])) },
    // A hung bash fails the test instead of holding the run.
    timeout: 60_000,
  });
  return names.filter((_, index) => output.includes(`@${index}@`));
};

const reader = readerFor(parseConfig('{"gatePaths": ["^scripts/"]}'));

/** The switches this reader reports in `text`, once each, in order. */
const ourReads = (text: string): string[] => {
  const names = reader.findSwitchReads('scripts/differential.sh', text, undefined).map((read) => read.name);
  return [...new Set(names)].sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
};

describe('env-gate-switches reads shell as bash does', () => {
  it('matches bash on sampled files', () => {
    const { files } = sample();
    assert.equal(files.length, RUNS);
    const wrong = files.map(({ count, text }) => ({ text, ours: ourReads(text), bash: bashReads(text, count) })).filter((entry) => JSON.stringify(entry.ours) !== JSON.stringify(entry.bash));
    assert.deepEqual(wrong, []);
  });

  it('draws every context and every lead word, the same files on every run', () => {
    const { files, drawn } = sample();
    assert.deepEqual([...drawn].sort(), [...CONTEXTS.map(([context]) => context), ...LEADS.map((lead) => `lead ${lead}`)].sort());
    assert.deepEqual(sample().files, files);
  });

  it('is not vacuous: bash expands in some contexts and not in others', () => {
    const read = CONTEXTS.filter(([, statement]) => bashReads(statement('S0_SKIP'), 1).length === 1).map(([context]) => context);
    assert.deepEqual(read, ['bare', 'braced', 'defaulted', 'double', 'doubleAcross', 'hashInWord', 'quotedHeredocMark', 'afterArithmetic', 'heredoc', 'heredocTabs', 'hereString', 'doubleAcrossDollar']);
  });

  for (const [context, statement] of CONTEXTS) {
    it(`the ${context} context alone`, () => {
      const text = statement('S0_SKIP');
      assert.deepEqual(ourReads(text), bashReads(text, 1));
    });
  }
});
