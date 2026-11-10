/**
 * The Markdown and YAML reading in doc-references.ts, `scanMarkdown`
 * (frontmatter, fenced code and its info string, HTML comments) and
 * `codeSpans`, against mdast-util-from-markdown (CommonMark) for the body and
 * js-yaml (failsafe) for the frontmatter.
 *
 * Every word in a generated document is unique (`w0`, `w1`, …), so each side
 * answers one question per word: is it frontmatter, fenced code (with which
 * info word), a code span, prose, or hidden in a comment. The suite also
 * compares the code-span interiors, and loads the lines the reader calls
 * frontmatter with js-yaml, which must give the model mapping back.
 *
 * Model: an optional frontmatter block of flat keys holding plain, quoted,
 * continued and literal-block scalars and flow and block sequences, several
 * of them holding `---` (quoted, indented, as an item), closed by `---` with
 * or without trailing spaces. Then top-level paragraphs, ATX headings, fenced
 * code blocks and HTML comment blocks separated by blank lines. Inline
 * content mixes words, backtick runs of one to three, escaped backticks and
 * backslashes, and single-line `<!-- -->` comments. Fences vary character,
 * length, indentation, info string (including a backtick in it), body lines
 * that look like fences, and the closer (same or other character, shorter,
 * longer, over-indented, trailing text or a backtick, missing). Comment
 * blocks span lines, hold blank and fence-looking lines, and carry words
 * after `-->`. Every document runs with LF and CRLF line endings.
 *
 * Out of model: container blocks (lists, block quotes), indented code blocks
 * and paragraphs running over several lines (the reader reads line by line);
 * tab indentation; strikethrough, which is GFM and which the reader drops on
 * purpose; an HTML comment and a code span on the same line, and a comment
 * that never closes (the reader strips comments before it finds spans); and
 * a frontmatter block that never closes (conventions differ: some readers
 * run it to the end, as this one does). The seed is fixed, so a failure
 * names a reproducible document.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FAILSAFE_SCHEMA, load as loadYaml } from 'js-yaml';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { CONFIG } from './doc-references.fixture.test.ts';
import { codeSpans, scanMarkdown } from './doc-references.ts';

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

/** One of `items`, drawn by `next`. */
const pick = <T>(items: readonly T[], next: () => number): T => items[Math.floor(next() * items.length)] as T;

/** A whole number in [min, max], drawn by `next`. */
const between = (min: number, max: number, next: () => number): number => min + Math.floor(next() * (max - min + 1));

/** One of `options` by weight. */
const weighted = <T>(options: ReadonlyArray<readonly [number, T]>, next: () => number): T => {
  const total = options.reduce((sum, [weight]) => sum + weight, 0);
  let at = next() * total;
  for (const [weight, value] of options) {
    if (at < weight) return value;
    at -= weight;
  }
  return (options.at(-1) as readonly [number, T])[1];
};

/** Stands for a word until the document is numbered. */
const W = '§';
const WORD = /w\d+/g;

interface Node {
  readonly type: string;
  readonly value?: string;
  readonly lang?: string | null;
  readonly children?: readonly Node[];
  readonly position?: {
    readonly start: { line: number; column: number };
    readonly end: { line: number; column: number };
  };
}

const walk = (node: Node, visit: (node: Node) => void): void => {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

const parsed = (text: string): Node => fromMarkdown(text) as Node;

const FENCE_START = /^ {0,3}(`{3,}|~{3,})/;

// ── the generated document ───────────────────────────────────────────────

type Value = string | readonly string[];

interface Frontmatter {
  /** The YAML between the delimiters, words still as `§`. */
  readonly block: string;
  readonly model: Readonly<Record<string, Value>>;
  readonly close: string;
}

interface Template {
  readonly frontmatter: Frontmatter | null;
  readonly body: string;
}

/** What a draw used, so a test can show every kind is drawn. */
type Drawn = Set<string>;

/** Number every `§` in order of appearance. */
const numbered = (text: string, counter: { next: number }): string => text.replaceAll(W, () => `w${String(counter.next++)}`);

const VALUE_SHAPES = ['plain', 'two', 'single', 'double', 'continued', 'literal', 'flow', 'block'] as const;

/** One key's rendering and the value js-yaml must read from it. */
const frontmatterEntry = (key: string, shape: (typeof VALUE_SHAPES)[number]): { text: string; value: Value } => {
  switch (shape) {
    case 'plain':
      return { text: `${key}: ${W}`, value: W };
    case 'two':
      return { text: `${key}: ${W} ${W}`, value: `${W} ${W}` };
    case 'single':
      return { text: `${key}: '${W} ---'`, value: `${W} ---` };
    case 'double':
      return { text: `${key}: "${W}: ---"`, value: `${W}: ---` };
    case 'continued':
      // A plain scalar continued on an indented `---` line.
      return { text: `${key}: ${W}\n  ---`, value: `${W} ---` };
    case 'literal':
      return { text: `${key}: |\n  ${W}\n  ---\n  ${W}`, value: `${W}\n---\n${W}\n` };
    case 'flow':
      return { text: `${key}: [${W}, '---']`, value: [W, '---'] };
    case 'block':
      return { text: `${key}:\n  - ${W}\n  - ---`, value: [W, '---'] };
  }
};

const KEYS = ['title', 'status', 'paths', 'related', 'owner'];
const FM_CLOSES = ['---', '---  '];

const frontmatter = (next: () => number, drawn: Drawn): Frontmatter => {
  // One to four distinct keys, in a drawn order (a Fisher-Yates shuffle).
  const keys = [...KEYS];
  for (let i = keys.length - 1; i > 0; i -= 1) {
    const j = between(0, i, next);
    [keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
  }
  keys.length = between(1, 4, next);
  const lines: string[] = [];
  const model: Record<string, Value> = {};
  for (const key of keys) {
    const shape = pick(VALUE_SHAPES, next);
    drawn.add(`yaml:${shape}`);
    const { text, value } = frontmatterEntry(key, shape);
    lines.push(text);
    model[key] = value;
  }
  const close = pick(FM_CLOSES, next);
  drawn.add(`yaml-close:${JSON.stringify(close)}`);
  return { block: lines.join('\n'), model, close };
};

/** Inline tokens on a line that may hold code spans. */
const spanInline = (next: () => number): string =>
  weighted<() => string>(
    [
      [4, () => W],
      [3, () => pick(['`', '``', '```'], next)],
      [1, () => pick(['\\`', '\\\\', '.', ':'], next)],
    ],
    next,
  )();

/** Inline tokens on a line that may hold comments (and so no backticks). */
const commentInline = (next: () => number): string =>
  weighted<() => string>(
    [
      [4, () => W],
      [2, () => `<!-- ${W} -->`],
      [1, () => pick(['.', ':'], next)],
    ],
    next,
  )();

const joined = (token: (next: () => number) => string, next: () => number): string =>
  Array.from({ length: between(1, 8, next) }, (_, index) => {
    const text = token(next);
    return index > 0 && next() < 0.5 ? ` ${text}` : text;
  }).join('');

/** A paragraph or heading line that starts with a word, so it opens no block. */
const prose = (next: () => number, drawn: Drawn): string => {
  const heading = pick(['', '# '], next);
  const spans = next() < 0.5;
  drawn.add(`prose:${heading === '' ? 'paragraph' : 'heading'}`).add(`inline:${spans ? 'spans' : 'comments'}`);
  return `${heading}${W} ${joined(spans ? spanInline : commentInline, next)}`;
};

const FENCE_INFOS = ['', 'sh', 'Bash', 'js title', 'a`b'];
const FENCE_LOOKALIKES = ['~~~', '```', '``', '    ```', '~~~ inner', '````', '``` `'];
const CLOSE_TAILS = ['', '  ', ' x', ' `'];

const fenced = (next: () => number, drawn: Drawn): string => {
  const char = pick(['`', '~'], next);
  const length = between(3, 5, next);
  const indent = between(0, 3, next);
  const info = pick(FENCE_INFOS, next);
  drawn.add(`fence:${char}`).add(`fence-info:${info}`);
  const body = Array.from({ length: between(0, 4, next) }, () => (next() < 0.5 ? prose(next, drawn) : pick(FENCE_LOOKALIKES, next)));
  const opener = `${' '.repeat(indent)}${char.repeat(length)}${info}`;
  // "```a`b" opens nothing; a blank line keeps it a one-line paragraph.
  const lines = char === '`' && info.includes('`') ? [opener, '', ...body] : [opener, ...body];
  // Closed five times in six, as an optional value is drawn.
  if (next() < 5 / 6) {
    const sameChar = next() < 0.5;
    const delta = between(-1, 2, next);
    const closeIndent = between(0, 4, next);
    const tail = pick(CLOSE_TAILS, next);
    drawn.add(`close:${sameChar ? 'same' : 'other'}`).add(`close-delta:${delta}`).add(`close-indent:${closeIndent}`).add(`close-tail:${JSON.stringify(tail)}`);
    const closeChar = sameChar ? char : char === '`' ? '~' : '`';
    lines.push(`${' '.repeat(closeIndent)}${closeChar.repeat(Math.max(1, length + delta))}${tail}`);
  } else {
    drawn.add('close:none');
  }
  return lines.join('\n');
};

const COMMENT_MIDDLES = [W, '', '```', '```bash', '~~~', `${W} \`x\``];

/** An HTML comment block: one line, or several with odd lines inside. */
const commentBlock = (next: () => number, drawn: Drawn): string => {
  if (next() < 0.5) {
    const after = next() < 0.5;
    drawn.add(`comment:one-line${after ? '+after' : ''}`);
    return `<!-- ${W} -->${after ? ` ${W}` : ''}`;
  }
  const first = next() < 0.5;
  const middle = Array.from({ length: between(0, 3, next) }, () => pick(COMMENT_MIDDLES, next));
  const before = next() < 0.5;
  const after = next() < 0.5;
  drawn.add('comment:multi-line');
  return [`<!--${first ? ` ${W}` : ''}`, ...middle, `${before ? `${W} ` : ''}-->${after ? ` ${W}` : ''}`].join('\n');
};

const body = (next: () => number, drawn: Drawn): string =>
  Array.from({ length: between(1, 6, next) }, () =>
    weighted<() => string>(
      [
        [3, () => prose(next, drawn)],
        [2, () => fenced(next, drawn)],
        [1, () => commentBlock(next, drawn)],
      ],
      next,
    )(),
  ).join('\n\n');

const template = (next: () => number, drawn: Drawn): Template => {
  const withFrontmatter = next() < 5 / 6;
  drawn.add(`frontmatter:${withFrontmatter ? 'yes' : 'no'}`);
  return { frontmatter: withFrontmatter ? frontmatter(next, drawn) : null, body: body(next, drawn) };
};

interface Document {
  /** The LF document, words numbered. */
  readonly text: string;
  /** Lines before the body: the frontmatter and its delimiters. */
  readonly head: number;
  /** The mapping js-yaml must read from the frontmatter, or null. */
  readonly model: Readonly<Record<string, Value>> | null;
}

const realise = ({ frontmatter: fm, body: rest }: Template): Document => {
  const raw = fm === null ? rest : `---\n${fm.block}\n${fm.close}\n${rest}`;
  const text = numbered(raw, { next: 0 });
  if (fm === null) return { text, head: 0, model: null };
  // The frontmatter's words come first, in the order its model lists them.
  const counter = { next: 0 };
  const model = Object.fromEntries(Object.entries(fm.model).map(([key, value]) => [key, typeof value === 'string' ? numbered(value, counter) : value.map((item) => numbered(item, counter))]));
  return { text, head: fm.block.split('\n').length + 2, model };
};

/** `RUNS` documents from the fixed seed, and the kinds drawn. */
const sample = (): { documents: Document[]; drawn: Drawn } => {
  const next = random(SEED);
  const drawn: Drawn = new Set();
  const documents = Array.from({ length: RUNS }, () => realise(template(next, drawn)));
  return { documents, drawn };
};

const { documents, drawn } = sample();

// ── the two readings ─────────────────────────────────────────────────────

interface Reading {
  /** word → frontmatter | code:<info> | span | prose | hidden */
  readonly roles: Record<string, string>;
  /** `line:interior` of every code span. */
  readonly spans: string[];
  /** js-yaml's reading of the lines the reader calls frontmatter. */
  readonly frontmatter: unknown;
}

/**
 * Body lines outside the model, left out of both sides: an indented code
 * block and a paragraph running over several lines. The generator writes
 * neither, but a fence body surfaces at block level when an earlier fence
 * closes on one of its lines.
 */
const outOfModelLines = (document: Document): Set<number> => {
  const lines = document.text.split('\n').slice(document.head);
  const out = new Set<number>();
  walk(parsed(lines.join('\n')), (node) => {
    const position = node.position;
    if (position === undefined) return;
    const indented = node.type === 'code' && !FENCE_START.test(lines[position.start.line - 1] ?? '');
    const wrapping = node.type === 'paragraph' && position.end.line > position.start.line;
    if (!indented && !wrapping) return;
    for (let line = position.start.line; line <= position.end.line; line += 1) out.add(line + document.head);
  });
  return out;
};

const wordsIn = (text: string): string[] => text.match(WORD) ?? [];

/** Every word with its line, so out-of-model lines can be dropped. */
const wordLines = (text: string): Map<string, number> => {
  const out = new Map<string, number>();
  text.split('\n').forEach((line, index) => {
    for (const word of wordsIn(line)) out.set(word, index + 1);
  });
  return out;
};

const loaded = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return loadYaml(text, { schema: FAILSAFE_SCHEMA });
  } catch (error) {
    return { unreadable: error instanceof Error ? error.name : 'error' };
  }
};

/** Every word gets a role (`hidden` when unread); out-of-model lines none. */
const settle = (roles: Record<string, string>, text: string, ignored: ReadonlySet<number>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [word, line] of wordLines(text)) if (!ignored.has(line)) out[word] = roles[word] ?? 'hidden';
  return out;
};

/** The reference: js-yaml for the frontmatter, mdast for the body. */
const reference = (document: Document, ignored: ReadonlySet<number>): Reading => {
  const all = document.text.split('\n');
  const lines = all.slice(document.head);
  const roles: Record<string, string> = {};
  for (const word of wordsIn(all.slice(0, document.head).join('\n'))) roles[word] = 'frontmatter';
  const spans: string[] = [];
  walk(parsed(lines.join('\n')), (node) => {
    const position = node.position;
    const value = node.value ?? '';
    if (node.type === 'code') {
      const info = (node.lang ?? '').toLowerCase();
      for (const word of wordsIn(value)) roles[word] = `code:${info}`;
    } else if (node.type === 'inlineCode' && position !== undefined) {
      for (const word of wordsIn(value)) roles[word] = 'span';
      const line = lines[position.start.line - 1] ?? '';
      const start = position.start.column - 1;
      let fence = 0;
      while (line.charAt(start + fence) === '`') fence += 1;
      const number = position.start.line + document.head;
      if (!ignored.has(number)) spans.push(`${String(number)}:${line.slice(start + fence, position.end.column - 1 - fence)}`);
    } else if (node.type === 'text') {
      for (const word of wordsIn(value)) roles[word] = 'prose';
    } else if (node.type === 'html') {
      // Raw HTML outside a comment is shown; inside one it is not.
      for (const word of wordsIn(value.replace(/<!--[\s\S]*?-->/g, ''))) roles[word] = 'prose';
    }
  });
  return { roles: settle(roles, document.text, ignored), spans: spans.sort(), frontmatter: document.model };
};

/** The module's answer, in the same shape. */
const ours = (document: Document, variant: string, ignored: ReadonlySet<number>): Reading => {
  const roles: Record<string, string> = {};
  const spans: string[] = [];
  const yaml: string[] = [];
  for (const line of scanMarkdown(variant, CONFIG.exemptMarker)) {
    if (line.frontmatter) {
      yaml.push(line.text);
      for (const word of wordsIn(line.text)) roles[word] = 'frontmatter';
      continue;
    }
    if (line.fence !== null) {
      for (const word of wordsIn(line.text)) roles[word] = `code:${line.fence}`;
      continue;
    }
    const found = codeSpans(line.text);
    for (const match of line.text.matchAll(WORD)) {
      const inSpan = found.some((span) => match.index >= span.start && match.index < span.end);
      roles[match[0]] = inSpan ? 'span' : 'prose';
    }
    if (!ignored.has(line.number)) for (const span of found) spans.push(`${String(line.number)}:${line.text.slice(span.start, span.end)}`);
  }
  return { roles: settle(roles, document.text, ignored), spans: spans.sort(), frontmatter: loaded(yaml.length === 0 ? null : yaml.join('\n')) };
};

const LINE_ENDINGS = ['lf', 'crlf'] as const;

const withLineEnding = (text: string, ending: (typeof LINE_ENDINGS)[number]): string => {
  const lf = text.replace(/\r\n?/g, '\n');
  return ending === 'lf' ? lf : lf.replace(/\n/g, '\r\n');
};

/** Compare the module on `variant` with the references on the LF text. */
const compare = (document: Document, variant: string = document.text): void => {
  const ignored = outOfModelLines(document);
  assert.deepEqual(ours(document, variant, ignored), reference(document, ignored), `markdown/yaml diverge on ${JSON.stringify(variant)}`);
};

/** A fixed document, words already numbered. */
const fixed = (text: string): Document => {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { text, head: 0, model: null };
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
  const block = lines.slice(1, close).join('\n');
  return { text, head: close + 1, model: loadYaml(block, { schema: FAILSAFE_SCHEMA }) as Record<string, Value> };
};

describe('doc-references reads markdown and frontmatter as the references do', () => {
  it('draws every case kind, the same sample on every run', () => {
    const kinds = [
      ...VALUE_SHAPES.map((s) => `yaml:${s}`),
      ...FM_CLOSES.map((c) => `yaml-close:${JSON.stringify(c)}`),
      'frontmatter:yes',
      'frontmatter:no',
      'prose:paragraph',
      'prose:heading',
      'inline:spans',
      'inline:comments',
      'fence:`',
      'fence:~',
      ...FENCE_INFOS.map((i) => `fence-info:${i}`),
      'close:same',
      'close:other',
      'close:none',
      ...[-1, 0, 1, 2].map((d) => `close-delta:${d}`),
      ...[0, 1, 2, 3, 4].map((n) => `close-indent:${n}`),
      ...CLOSE_TAILS.map((t) => `close-tail:${JSON.stringify(t)}`),
      'comment:one-line',
      'comment:one-line+after',
      'comment:multi-line',
    ];
    assert.deepEqual(
      kinds.filter((kind) => !drawn.has(kind)),
      [],
    );
    assert.deepEqual([...drawn].sort(), [...kinds].sort());
    assert.deepEqual(sample(), { documents, drawn });
  });

  it('the sample gives the references every role to judge', () => {
    const roles = new Set<string>();
    let spans = 0;
    for (const document of documents) {
      const reading = reference(document, outOfModelLines(document));
      for (const role of Object.values(reading.roles)) roles.add(role.startsWith('code:') ? 'code' : role);
      spans += reading.spans.length;
    }
    assert.deepEqual([...roles].sort(), ['code', 'frontmatter', 'hidden', 'prose', 'span']);
    // Random backtick runs seldom pair up: the seed gives a couple of dozen spans to compare.
    assert.ok(spans >= 20, String(spans));
  });

  it('the generator writes frontmatter js-yaml reads as the model', () => {
    for (const document of documents) {
      if (document.model === null) continue;
      const block = document.text.split('\n').slice(1, document.head - 1).join('\n');
      assert.deepEqual(loadYaml(block, { schema: FAILSAFE_SCHEMA }), document.model, block);
    }
  });

  for (const ending of LINE_ENDINGS) {
    it(`frontmatter, fences, comments and code spans match (${ending})`, () => {
      for (const document of documents) compare(document, withLineEnding(document.text, ending));
    });
  }

  for (const [label, text] of [
    // Shapes an earlier reader got wrong, kept as fixed cases.
    ['an indented --- inside a literal block does not end frontmatter', '---\ntitle: |\n  w0\n  ---\n  w1\n---\nw2 a'],
    ['an indented --- continuing a scalar does not end frontmatter', '---\ntitle: w0\n  ---\n---\nw1 a'],
    ['an info string with a backtick opens no backtick fence', '```a`b\n\nw0 a'],
    ['a closer followed by a backtick does not close', '```\n``` `\nw0\n```'],
    ['a fence inside a comment is not a fence', '<!--\n```\nw0\n-->\n\nw1 a'],
    ['an escaped backtick opens no span', 'w0 \\`w1` w2'],
    ['a span opens at a whole backtick run', 'w0 ``w1` w2'],
    ['a tilde fence keeps a backtick in its info word', '~~~a`b\nw0\n~~~'],
  ] as const) {
    it(label, () => {
      compare(fixed(text));
    });
  }
});
