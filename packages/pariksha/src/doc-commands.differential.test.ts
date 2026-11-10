/**
 * Where doc-commands.ts ends a documented command (`documentedCommands`):
 * its comment, its operators and its line continuations, against bash itself.
 *
 * Model: a ```bash fence of one to three command lines. Each line is simple
 * commands joined by `&&`, `||`, `;` and `|`, with or without blanks round
 * them, optionally ended by `;` and a comment (opened by a blank or `;`,
 * holding quotes, operators, `pnpm b` and a trailing backslash). A command is
 * a function name and one to three words; a word joins parts: bare text (a
 * glued `#` included), single- and double-quoted runs holding `#`, ` # `,
 * `;`, `&&`, `||`, `|`, the other quote and escapes, and backslash escapes of
 * an operator, `#`, a quote, a blank or a backslash. Words are separated by
 * blanks and line continuations, and a continuation may join two parts of
 * one word. bash runs each fence with every command a function that writes
 * its argv and a mark between lines; a command followed by `&&` succeeds and
 * one followed by `||` fails, so every command runs, and each reads its
 * stdin to the end first, so a pipeline reports in order. The module's side
 * is bash again: each command's text, as the module cut it, is re-read by
 * `eval` with a sentinel word after it, so a cut inside quotes fails to
 * parse and a comment left in swallows the sentinel. The words themselves
 * are shellWords' (doc-commands.shell.differential.test.ts); this suite
 * judges only where each command starts and ends.
 *
 * Out of model: expansions ($VAR, $(…), backticks, globs, ~, braces), `&`,
 * redirections, heredocs, `cd` and assignments (documentedCommands reads
 * those itself), a quote or a comment spanning lines, `$ ` prompts, and a
 * `#` straight after an escaped blank or `;` (`a\ #b`, `a\;#b`):
 * shell-text.ts `stripComment` reads that `#` as a comment, bash as text.
 * Every fence runs with LF and CRLF line endings; bash reads the LF one. The
 * seed is fixed so a failure names a reproducible fence.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { documentedCommands } from './doc-commands.ts';
import { CONFIG } from './doc-references.fixture.test.ts';

const SEED = 20_089;
const RUNS = 200;

type LineEnding = 'lf' | 'crlf';
const LINE_ENDINGS: readonly LineEnding[] = ['lf', 'crlf'];

/** `text` with every line break (CRLF, LF or a lone CR) rewritten to `ending`. */
const withLineEnding = (text: string, ending: LineEnding): string => {
  const lf = text.replace(/\r\n?/g, '\n');
  return ending === 'lf' ? lf : lf.replace(/\n/g, '\r\n');
};

/** Commands bash runs as functions: the first two succeed, the rest fail. */
const SUCCEEDS = ['pnpm', 'tsx'] as const;
const FAILS = ['node', 'npx'] as const;

const BARE = ['a', '-x', '--k=v', 'a#b', 'x=1', './s.sh', '%'];
const QUOTED_TEXT = ['a', ' ', '#', ' # ', ';', '&&', '||', '|', '\\;'];
const SINGLE_TEXT = [...QUOTED_TEXT, '"', '\\'];
const DOUBLE_TEXT = [...QUOTED_TEXT, "'", '\\"', '\\\\', '\\a'];
const ESCAPED = ['\\;', '\\|', '\\&', '\\#', '\\ ', "\\'", '\\"', '\\\\'];
/** Parts that never start a word: a `#` there would open a comment. */
const GLUED = ['#b', '\\\n'];
const GAPS = [' ', '  ', '\t', ' \\\n  ', '\\\n '];
const OPERATORS = ['&&', ' && ', '||', ' || ', ';', '; ', ' ; ', '|', ' | '];
const COMMENT_OPENERS = [' #', ' # ', '\t#', ';#', '; # '];
const COMMENT_TEXT = ['a', ' ', "'", '"', '#', ';', '&&', '|', 'pnpm b'];
const SEMICOLON_TAILS = [';', ' ;'];

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

/** `RUNS` fences of one to three command lines, and every kind of piece drawn. */
const sample = (): { fences: string[][]; drawn: Set<string> } => {
  const next = random(SEED);
  const drawn = new Set<string>();
  const constant = (kind: string, items: readonly string[]): string => {
    const item = pick(items, next);
    drawn.add(`${kind} ${JSON.stringify(item)}`);
    return item;
  };
  const quoted = (kind: string, quote: string, items: readonly string[]): string => `${quote}${Array.from({ length: between(0, 3, next) }, () => constant(kind, items)).join('')}${quote}`;
  const PARTS: ReadonlyArray<readonly [string, () => string]> = [
    ['bare', () => constant('bare', BARE)],
    ['single', () => quoted('single', "'", SINGLE_TEXT)],
    ['double', () => quoted('double', '"', DOUBLE_TEXT)],
    ['escaped', () => constant('escaped', ESCAPED)],
  ];
  const part = (kinds: ReadonlyArray<readonly [string, () => string]>): string => {
    const [kind, draw] = pick(kinds, next);
    drawn.add(`part ${kind}`);
    return draw();
  };
  const word = (): string => {
    for (;;) {
      const parts = [part(PARTS), ...Array.from({ length: between(0, 3, next) }, () => part([...PARTS, ['glued', () => constant('glued', GLUED)]]))];
      // `\ #b` and `\;#b` are out of model (see above), a continuation between
      // them included; a `\` + newline part never ends a word, where it would
      // join the next word or end the line.
      if (parts.at(-1) !== '\\\n' && !/\\[ ;](?:\\\n)*#/.test(parts.join(''))) return parts.join('');
    }
  };
  const tail = (): string => {
    // Weights 2 : 1 : 2, as nothing, a `;`, a comment.
    const kind = pick(['none', 'none', 'semicolon', 'comment', 'comment'], next);
    drawn.add(`tail ${kind}`);
    if (kind === 'none') return '';
    if (kind === 'semicolon') return constant('semicolon', SEMICOLON_TAILS);
    const open = constant('opener', COMMENT_OPENERS);
    const text = Array.from({ length: between(0, 3, next) }, () => constant('comment', COMMENT_TEXT)).join('');
    const backslash = next() < 0.5;
    drawn.add(`comment backslash ${backslash}`);
    return `${open}${text}${backslash ? '\\' : ''}`;
  };
  /** One command line, its commands' names chosen so every one of them runs. */
  const commandLine = (): string => {
    const count = between(1, 3, next);
    drawn.add(`commands ${count}`);
    const commands = Array.from({ length: count }, () => Array.from({ length: between(1, 3, next) }, () => [constant('gap', GAPS), word()] as const));
    const operators = [constant('operator', OPERATORS), constant('operator', OPERATORS)];
    const end = tail();
    return commands
      .map((words, index) => {
        const after = index < commands.length - 1 ? String(operators[index % 2]) : '';
        const names = after.includes('||') ? FAILS : after.includes('&&') ? SUCCEEDS : [...SUCCEEDS, ...FAILS];
        const name = pick(names, next);
        drawn.add(`name ${name}`);
        return `${name}${words.map(([space, text]) => `${space}${text}`).join('')}${after}`;
      })
      .join('')
      .concat(end);
  };
  const fences = Array.from({ length: RUNS }, () => {
    const count = between(1, 3, next);
    drawn.add(`lines ${count}`);
    return Array.from({ length: count }, commandLine);
  });
  return { fences, drawn };
};

/** Every kind of piece the model may draw. */
const ALL_KINDS: readonly string[] = [
  ...['bare', 'single', 'double', 'escaped', 'glued'].map((kind) => `part ${kind}`),
  ...BARE.map((item) => `bare ${JSON.stringify(item)}`),
  ...SINGLE_TEXT.map((item) => `single ${JSON.stringify(item)}`),
  ...DOUBLE_TEXT.map((item) => `double ${JSON.stringify(item)}`),
  ...ESCAPED.map((item) => `escaped ${JSON.stringify(item)}`),
  ...GLUED.map((item) => `glued ${JSON.stringify(item)}`),
  ...GAPS.map((item) => `gap ${JSON.stringify(item)}`),
  ...OPERATORS.map((item) => `operator ${JSON.stringify(item)}`),
  ...['none', 'semicolon', 'comment'].map((kind) => `tail ${kind}`),
  ...SEMICOLON_TAILS.map((item) => `semicolon ${JSON.stringify(item)}`),
  ...COMMENT_OPENERS.map((item) => `opener ${JSON.stringify(item)}`),
  ...COMMENT_TEXT.map((item) => `comment ${JSON.stringify(item)}`),
  'comment backslash true',
  'comment backslash false',
  ...[1, 2, 3].map((count) => `commands ${count}`),
  ...[1, 2, 3].map((count) => `lines ${count}`),
  ...[...SUCCEEDS, ...FAILS].map((name) => `name ${name}`),
];

/** Commands' argv, grouped by line: one array per line, one per command. */
type Reading = string[][][];

const parse = (output: string, cases: number): Reading[] =>
  output
    .split('\u0001')
    .slice(0, cases)
    .map((chunk) =>
      chunk
        .split('\u0003')
        .slice(0, -1)
        .map((line) =>
          line
            .split('\u0002')
            .slice(0, -1)
            .map((command) => command.split('\u0000').slice(0, -1)),
        ),
    );

const bash = (script: string, input = ''): string =>
  execFileSync('bash', ['--norc', '--noprofile', '-c', script], {
    encoding: 'utf8',
    input,
    env: { PATH: process.env['PATH'] ?? '', LC_ALL: 'C' },
    // A hung bash fails the test instead of holding the run.
    timeout: 30_000,
  });

const RUNNER = [
  'exec 3>&1 >/dev/null',
  'drain() { while read -r _; do :; done; }',
  "argv() { drain; printf '%s\\0' \"$@\" >&3; printf '\\2' >&3; }",
  ...SUCCEEDS.map((name) => `${name}() { argv ${name} "$@"; }`),
  ...FAILS.map((name) => `${name}() { argv ${name} "$@"; return 1; }`),
  "mark() { printf '\\3' >&3; }",
].join('\n');

/** bash's reading of every fence, in one run. */
const bashReadings = (fences: readonly (readonly string[])[]): Reading[] => {
  const script = fences.map((lines) => `${lines.map((line) => `${line}\nmark`).join('\n')}\nprintf '\\1' >&3`).join('\n');
  return parse(bash(`${RUNNER}\n${script}`), fences.length);
};

/** The module's commands for `lines`, grouped by the line each starts on. */
const ourCommands = (lines: readonly string[], ending: LineEnding): string[][] => {
  const markdown = withLineEnding(`\`\`\`bash\n${lines.join('\n')}\n\`\`\`\n`, ending);
  const commands = documentedCommands('x.md', markdown, CONFIG.exemptMarker);
  // Line 1 is the fence; each command line starts after the ones before it.
  let start = 2;
  return lines.map((line) => {
    const mine = commands.filter((command) => command.line === start).map((command) => command.text);
    start += line.split('\n').length;
    return mine;
  });
};

const CASE = '<case>';
const LINE = '<line>';
const END = '__end__';

/** Each command text re-read by bash, a sentinel word after it. */
const reread = (cuts: readonly (readonly string[][])[]): Reading[] => {
  const records = cuts.flatMap((lines) => [...lines.flatMap((line) => [...line, LINE]), CASE]);
  const loop = [
    "while IFS= read -r -d '' text; do",
    `  if [ "$text" = '${CASE}' ]; then printf '\\1'; continue; fi`,
    `  if [ "$text" = '${LINE}' ]; then printf '\\3'; continue; fi`,
    `  eval "printf '%s\\\\0' $text ${END}" 2>/dev/null || printf 'unparsed\\0'`,
    "  printf '\\2'",
    'done',
  ].join('\n');
  return parse(bash(loop, records.map((record) => `${record}\u0000`).join('')), cuts.length).map((lines) => lines.map((line) => line.map((words) => (words.at(-1) === END ? words.slice(0, -1) : [...words, 'comment kept']))));
};

/** Fences where the module and bash disagree, with both readings. */
const disagreements = (fences: readonly (readonly string[])[], ending: LineEnding): unknown[] => {
  const expected = bashReadings(fences);
  const cuts = fences.map((lines) => ourCommands(lines, ending));
  const actual = reread(cuts);
  return fences
    .map((lines, index) => ({ fence: lines.join('\n'), cut: cuts[index], ours: actual[index], bash: expected[index] }))
    .filter((entry) => JSON.stringify(entry.ours) !== JSON.stringify(entry.bash));
};

describe('doc-commands ends commands where bash does', () => {
  const { fences } = sample();

  it('draws every kind of piece, the same fences on every run', () => {
    const again = sample();
    assert.equal(fences.length, RUNS);
    assert.deepEqual([...again.drawn].sort(), [...ALL_KINDS].sort());
    assert.deepEqual(again.fences, fences);
  });

  it('is not vacuous: bash ran several commands per sampled fence', () => {
    const commands = bashReadings(fences).flat(2).length;
    assert.ok(commands > RUNS * 2, `${commands} commands`);
  });

  for (const ending of LINE_ENDINGS) {
    it(`documentedCommands cuts sampled fences as bash does (${ending})`, () => {
      assert.deepEqual(disagreements(fences, ending), []);
    });
  }

  const fixed: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['a quoted `#` starts no comment', ['pnpm a \'#\' "x # y" b # c']],
    ['an escaped `#` starts no comment', ['pnpm a \\# b']],
    ['a `#` after `;` starts one', ['pnpm a;# node b']],
    ['a quoted operator joins no commands', ["pnpm 'a;b' \"c && d\" && node 'e|f' || tsx g"]],
    ['an escaped operator joins no commands', ['pnpm a\\;b \\| c\\&\\& d']],
    ['a backslash in a comment continues nothing', ['pnpm a # c \\', 'tsx b']],
    ['an escaped backslash ends the line', ['pnpm a\\\\', 'tsx b']],
    ['a continuation joins a glued `#` to its word', ['pnpm a\\\n#b c']],
    ['a continuation before a comment', ['pnpm a \\\n  # c', 'tsx b']],
  ];
  for (const [label, lines] of fixed) {
    it(label, () => {
      assert.deepEqual(disagreements([lines], 'lf'), []);
    });
  }

  it('re-reads a cut inside quotes as unparsed, and a comment left in as kept', () => {
    assert.deepEqual(reread([[["pnpm 'a"], ['pnpm a # b']]]), [[[['unparsed', 'comment kept']], [['pnpm', 'a', 'comment kept']]]]);
  });
});
