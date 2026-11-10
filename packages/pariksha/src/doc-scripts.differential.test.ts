/**
 * The markdown reading in doc-scripts.ts (which lines are fenced code, where
 * inline code spans fall) against mdast-util-from-markdown (CommonMark).
 *
 * Model: top-level paragraphs, ATX headings and fenced code blocks separated
 * by blank lines; inline content mixes words, backtick runs of one to three,
 * escaped backticks and punctuation. Fences vary the character, length,
 * indentation, info string, and the closer (same or other character,
 * shorter, longer, over-indented, trailing text, missing). Out of model:
 * container blocks, indented code blocks and spans wrapping across lines.
 * Every document runs with LF and CRLF line endings. The seed is fixed, so a
 * failure names a reproducible document.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { fenceRoles, spanRanges } from './doc-scripts.ts';

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

/** One of `items`, drawn by `next`. */
const pick = <T>(items: readonly T[], next: () => number): T => items[Math.floor(next() * items.length)] as T;

/** An integer in [min, max], drawn by `next`. */
const int = (min: number, max: number, next: () => number): number => min + Math.floor(next() * (max - min + 1));

type LineEnding = 'lf' | 'crlf';
const LINE_ENDINGS: readonly LineEnding[] = ['lf', 'crlf'];
const withLineEnding = (text: string, ending: LineEnding): string => {
  const lf = text.replace(/\r\n?/g, '\n');
  return ending === 'lf' ? lf : lf.replace(/\n/g, '\r\n');
};

interface Node {
  readonly type: string;
  readonly children?: readonly Node[] | undefined;
  readonly position?: { readonly start: { line: number; column: number }; readonly end: { line: number; column: number } } | undefined;
}

const walk = (node: Node, visit: (node: Node) => void): void => {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

const tree = (document: string): Node => fromMarkdown(document);

const FENCE_START = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Lines outside the model, left out of both sides: an INDENTED code block
 * (the checker does not treat indentation as code, so list continuations
 * stay prose) and a paragraph running over several lines (a span can wrap
 * there; the checker reads line by line). The generator writes neither, but
 * a fence body surfaces at block level when an earlier fence closes on one
 * of its lines.
 */
const outOfModelLines = (document: string): Set<number> => {
  const lines = document.split('\n');
  const out = new Set<number>();
  walk(tree(document), (node) => {
    const position = node.position;
    if (position === undefined) return;
    const indented = node.type === 'code' && !FENCE_START.test(lines[position.start.line - 1] ?? '');
    const wrapping = node.type === 'paragraph' && position.end.line > position.start.line;
    if (!indented && !wrapping) return;
    for (let line = position.start.line; line <= position.end.line; line += 1) out.add(line);
  });
  return out;
};

interface Reading {
  readonly code: (boolean | null)[];
  readonly spans: string[];
}

/** The reference: code lines and code-span interiors, from mdast. */
const reference = (document: string, ignored: ReadonlySet<number>): Reading => {
  const lines = document.split('\n');
  const code: (boolean | null)[] = lines.map((_line, index) => (ignored.has(index + 1) ? null : false));
  const spans: string[] = [];
  walk(tree(document), (node) => {
    const position = node.position;
    if (position === undefined || ignored.has(position.start.line)) return;
    if (node.type === 'code') for (let line = position.start.line; line <= position.end.line; line += 1) code[line - 1] = true;
    if (node.type === 'inlineCode') {
      const text = lines[position.start.line - 1] ?? '';
      const start = position.start.column - 1;
      let fence = 0;
      while (text.charAt(start + fence) === '`') fence += 1;
      spans.push(`${position.start.line}:${start + fence}-${position.end.column - 1 - fence}`);
    }
  });
  return { code, spans: spans.sort() };
};

/** The module's answer, in the same shape. */
const ours = (document: string, ignored: ReadonlySet<number>): Reading => {
  const lines = document.split('\n');
  const roles = fenceRoles(lines);
  const spans = lines.flatMap((line, index) => (roles[index] === 'prose' && !ignored.has(index + 1) ? spanRanges(line).map(([start, end]) => `${index + 1}:${start}-${end}`) : []));
  return { code: roles.map((role, index) => (ignored.has(index + 1) ? null : role !== 'prose')), spans: spans.sort() };
};

/** The module on `variant` against mdast on the LF `text`. */
const compare = (text: string, variant: string = text): { ours: Reading; mdast: Reading } => {
  const ignored = outOfModelLines(text);
  return { ours: ours(variant, ignored), mdast: reference(text, ignored) };
};

const WORDS = ['pnpm', 'run', 'lint', 'test:ci', 'x', 'a-b'] as const;
const RUNS_OF_TICKS = ['`', '``', '```'] as const;
const OTHERS = ['\\`', '\\\\', '.', ':'] as const;
const HEADINGS = ['', '# '] as const;
const CHARS = ['`', '~'] as const;
const INFOS = ['', 'sh', 'js title', 'a`b'] as const;
const BODY_LINES = ['~~~', '```', '``', '    ```', '~~~ inner', '````'] as const;
const TAILS = ['', '  ', ' x'] as const;

/** Every kind the generator can draw, as `sample` names it. */
const KINDS = [
  ...WORDS.map((w) => `word ${w}`),
  ...RUNS_OF_TICKS.map((r) => `ticks ${r}`),
  ...OTHERS.map((o) => `other ${o}`),
  'space',
  'no space',
  ...HEADINGS.map((h) => `heading ${h}`),
  ...CHARS.map((c) => `char ${c}`),
  ...[3, 4, 5].map((n) => `length ${n}`),
  ...[0, 1, 2, 3].map((n) => `indent ${n}`),
  ...INFOS.map((i) => `info ${i}`),
  'body prose',
  ...BODY_LINES.map((b) => `body ${b}`),
  'close none',
  'close same',
  'close other',
  ...[-1, 0, 1, 2].map((n) => `delta ${n}`),
  ...[0, 1, 2, 3, 4].map((n) => `close indent ${n}`),
  ...TAILS.map((t) => `tail ${t}`),
  'block prose',
  'block fenced',
];

/** `RUNS` documents, and every kind drawn while writing them. */
const sample = (): { documents: string[]; drawn: Set<string> } => {
  const next = random(SEED);
  const drawn = new Set<string>();
  const draw = <T>(label: string, items: readonly T[]): T => {
    const item = pick(items, next);
    drawn.add(`${label} ${String(item)}`);
    return item;
  };
  const inline = (): string => {
    const count = int(1, 8, next);
    const tokens: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const weight = next() * 8;
      const token = weight < 4 ? draw('word', WORDS) : weight < 7 ? draw('ticks', RUNS_OF_TICKS) : draw('other', OTHERS);
      const spaced = next() < 0.5;
      drawn.add(spaced ? 'space' : 'no space');
      tokens.push(index > 0 && spaced ? ` ${token}` : token);
    }
    return tokens.join('');
  };
  /** A paragraph or heading line that starts with a word, so it opens no block. */
  const prose = (): string => `${draw('heading', HEADINGS)}${draw('word', WORDS)} ${inline()}`;
  const fenced = (): string => {
    const char = draw('char', CHARS);
    const length = int(3, 5, next);
    drawn.add(`length ${length}`);
    const indent = int(0, 3, next);
    drawn.add(`indent ${indent}`);
    const info = draw('info', INFOS);
    // "```a`b" opens nothing and its paragraph runs on into the next line,
    // where a span can wrap (out of model); a fixed case below covers it.
    const label = char === '`' && info.includes('`') ? 'sh' : info;
    const lines = [`${' '.repeat(indent)}${char.repeat(length)}${label}`];
    const bodyCount = int(0, 4, next);
    for (let index = 0; index < bodyCount; index += 1) {
      if (next() < 0.5) {
        drawn.add('body prose');
        lines.push(prose());
      } else {
        lines.push(draw('body', BODY_LINES));
      }
    }
    if (next() < 0.2) {
      drawn.add('close none');
    } else {
      const sameChar = next() < 0.5;
      drawn.add(sameChar ? 'close same' : 'close other');
      const delta = int(-1, 2, next);
      drawn.add(`delta ${delta}`);
      const closeIndent = int(0, 4, next);
      drawn.add(`close indent ${closeIndent}`);
      const tail = draw('tail', TAILS);
      const closeChar = sameChar ? char : char === '`' ? '~' : '`';
      lines.push(`${' '.repeat(closeIndent)}${closeChar.repeat(Math.max(1, length + delta))}${tail}`);
    }
    return lines.join('\n');
  };
  const documents = Array.from({ length: RUNS }, () => {
    const count = int(1, 6, next);
    return Array.from({ length: count }, () => {
      if (next() < 2 / 3) {
        drawn.add('block prose');
        return prose();
      }
      drawn.add('block fenced');
      return fenced();
    }).join('\n\n');
  });
  return { documents, drawn };
};

describe('doc-scripts reads markdown as CommonMark does', () => {
  for (const ending of LINE_ENDINGS) {
    it(`fenced lines and code spans match mdast (${ending})`, () => {
      const { documents } = sample();
      assert.equal(documents.length, RUNS);
      const wrong = documents
        .map((text) => ({ text, ...compare(text, withLineEnding(text, ending)) }))
        .filter((entry) => JSON.stringify(entry.ours) !== JSON.stringify(entry.mdast));
      assert.deepEqual(wrong, []);
    });
  }

  it('draws every kind, the same documents on every run', () => {
    const { documents, drawn } = sample();
    assert.deepEqual([...drawn].sort(), [...KINDS].sort());
    assert.deepEqual(sample().documents, documents);
  });

  it('is not vacuous: the sample holds fenced code and code spans, and lines out of model are few', () => {
    const { documents } = sample();
    const readings = documents.map((text) => compare(text).mdast);
    assert.ok(readings.some((r) => r.code.includes(true)));
    assert.ok(readings.some((r) => r.spans.length > 0));
    const lines = readings.flatMap((r) => r.code);
    assert.ok(lines.filter((line) => line === null).length < lines.length / 4);
  });

  // Shapes an earlier reader got wrong, kept as fixed cases.
  for (const [label, text] of [
    ['a ~~~ line inside a ``` fence does not close it', '```\n~~~\npnpm x\n```'],
    ['a shorter closer does not close', '````\n```\npnpm x\n````'],
    ['a four-space-indented fence is not a fence', 'x a\n    ```\nx `b`'],
    ['an info string with a backtick opens no backtick fence', '```a`b\n\nx `c`'],
    ['a closer with trailing text does not close', '```\n``` x\npnpm x\n```'],
  ] as const) {
    it(label, () => {
      const { ours: got, mdast } = compare(text);
      assert.deepEqual(got, mdast);
    });
  }

  for (const [label, line, expected] of [
    ['equal-length runs pair, others are literal', 'x ``a`b`` c', [[4, 7]]],
    ['an escaped backtick opens nothing', 'x \\`a` b', []],
    ['a backslash inside a span does not stop the closer', 'x `a\\` b', [[3, 5]]],
    ['an unmatched run is literal', 'x `` a', []],
  ] as const) {
    it(`code spans: ${label}`, () => {
      assert.deepEqual(spanRanges(line), expected);
    });
  }
});
