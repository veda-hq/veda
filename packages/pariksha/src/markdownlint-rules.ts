// markdownlint custom rules for Markdown that reads fine as source and renders
// mangled: a `> [!NOTE]` alert run onto its body line, a link broken by `] (`,
// a fence that swallows the next section, a table split by a blank line,
// `__DEV__` turned into bold "DEV". No markdownlint built-in rule fails these
// for that reason, so each shape is one rule here, on markdownlint's own
// micromark tokens. Every rule carries the tag `pariksha-markdown`, so
//
//   "config": { "default": false, "pariksha-markdown": true }
//
// turns on these rules and nothing else. The module's default export is the
// rules array, as markdownlint-cli2's `customRules` loads it.
//
// The rule API's types are declared here rather than imported, so the package
// depends on no markdownlint version.

/** A markdownlint micromark token (the fields these rules read). */
export interface Token {
  readonly type: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly text: string;
  readonly children: readonly Token[];
}

export interface RuleParams {
  readonly lines: readonly string[];
  readonly parsers: { readonly micromark: { readonly tokens: readonly Token[] } };
  /** The rule's configuration object; markdownlint always passes one (`{}` when the rule is only switched on). */
  readonly config?: unknown;
}

export interface RuleError {
  lineNumber: number;
  detail?: string;
  context?: string;
}

export interface MarkdownRule {
  readonly names: string[];
  readonly description: string;
  readonly tags: string[];
  readonly parser: 'micromark';
  readonly function: (params: RuleParams, onError: (error: RuleError) => void) => void;
}

export const TAG = 'pariksha-markdown';

/**
 * The options, each a list, with their defaults. A rule reads its own; since
 * options set under the tag reach every rule, a rule accepts the others'
 * names too, and refuses only a name no rule here reads.
 */
export const DEFAULT_OPTIONS = {
  /** `pariksha-alert-marker-inline`: the alert types GitHub renders as callouts. */
  alert_types: ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'],
  /** `pariksha-link-space-before-paren`: file extensions that make `] (name.ext)` look like a link target. */
  link_target_extensions: ['md', 'mdx', 'html', 'htm', 'ts', 'tsx', 'js', 'json', 'yaml', 'yml', 'png', 'svg', 'jpg', 'jpeg', 'pdf'],
  /** `pariksha-dunder-mangle`: names whose `__name__` a formatter rewrites as `**name**`; never an English word in bold. */
  dunder_words: ['DEV', 'proto', 'esModule', 'typename'],
  /** `pariksha-fence-swallows-heading`: fence languages where a `# Heading` line cannot be code. */
  no_hash_languages: ['ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript', 'json', 'jsonc', 'sql', 'css', 'swift', 'kotlin', 'java', 'go', 'rust', 'prisma'],
} as const satisfies Record<string, readonly string[]>;

export type OptionName = keyof typeof DEFAULT_OPTIONS;

/** What each option's entries must look like, and how the refusal says so. */
const OPTION_SHAPES: Record<OptionName, { readonly pattern: RegExp; readonly says: string }> = {
  alert_types: { pattern: /^[A-Za-z]+$/, says: 'letters only' },
  link_target_extensions: { pattern: /^[A-Za-z0-9]+$/, says: 'letters and digits, without the dot' },
  dunder_words: { pattern: /^(?!_)[\w$]+(?<!_)$/, says: 'an identifier without its surrounding underscores' },
  no_hash_languages: { pattern: /^\S+$/, says: 'no whitespace' },
};

const isOptionName = (key: string): key is OptionName => Object.hasOwn(DEFAULT_OPTIONS, key);

const describe = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return JSON.stringify(value);
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
};

/**
 * The rule's configuration as markdownlint passes it, checked: an object whose
 * every key is an option of this module. A key no rule here reads throws,
 * which fails the lint run with the message. A key another rule reads is
 * accepted, since options set under the tag reach every rule and a rule
 * cannot tell the tag's object from its own. markdownlint always passes an
 * object (a string or number becomes `{}`, an array its indexes as keys); the
 * non-object refusal is for a caller that runs a rule directly.
 */
export const readConfig = (rule: string, config: unknown): Readonly<Record<string, unknown>> => {
  if (config === undefined) return {};
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    throw new Error(`${rule}: its configuration must be true, false or an object of options; got ${describe(config)}`);
  for (const key of Object.keys(config)) {
    if (!isOptionName(key)) throw new Error(`${rule}: unknown option "${key}"; the options are ${Object.keys(DEFAULT_OPTIONS).join(', ')}`);
  }
  return config as Record<string, unknown>;
};

/** One list option: its default when unset, else a non-empty array of well-formed strings. */
export const listOption = (rule: string, config: unknown, name: OptionName): readonly string[] => {
  const value = readConfig(rule, config)[name];
  if (value === undefined) return DEFAULT_OPTIONS[name];
  const shape = OPTION_SHAPES[name];
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${rule}: option "${name}" must be a non-empty array of strings (to turn the rule off, set it to false); got ${describe(value)}`);
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || !shape.pattern.test(entry))
      throw new Error(`${rule}: option "${name}" holds ${describe(entry)}; each entry must be a string of ${shape.says}`);
  }
  return value as string[];
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** Every token, depth first, in document order. */
export const walk = (tokens: readonly Token[]): Token[] => {
  const out: Token[] = [];
  const visit = (list: readonly Token[]): void => {
    for (const token of list) {
      out.push(token);
      visit(token.children);
    }
  };
  visit(tokens);
  return out;
};

const CODE_BLOCKS = new Set(['codeFenced', 'codeIndented', 'htmlFlow']);

/**
 * The document as rules see prose: lines inside code blocks and HTML blocks
 * are null, and on every other line each inline code span is blanked out.
 */
export const proseLines = (params: RuleParams): Array<string | null> => {
  const lines = [...params.lines];
  const all = walk(params.parsers.micromark.tokens);
  for (const token of all) {
    if (token.type !== 'codeText') continue;
    for (let line = token.startLine; line <= token.endLine; line += 1) {
      const text = lines[line - 1] ?? '';
      const from = line === token.startLine ? token.startColumn - 1 : 0;
      const to = line === token.endLine ? token.endColumn - 1 : text.length;
      lines[line - 1] = text.slice(0, from) + ' '.repeat(to - from) + text.slice(to);
    }
  }
  const prose: Array<string | null> = lines;
  for (const token of all) {
    if (!CODE_BLOCKS.has(token.type)) continue;
    for (let line = token.startLine; line <= token.endLine; line += 1) prose[line - 1] = null;
  }
  return prose;
};

const rule = (name: string, description: string, check: MarkdownRule['function']): MarkdownRule => ({
  names: [`pariksha-${name}`],
  description,
  tags: [TAG],
  parser: 'micromark',
  function: check,
});

/** An alert marker followed, on its own line, by more than whitespace. */
const alertPattern = (types: readonly string[]): RegExp => new RegExp(`^\\s*(?:>\\s*)+\\[!(?:${types.map(escapeRegExp).join('|')})\\][ \\t]*\\S`, 'i');

/**
 * `[text] (target)`: the space turns a link into literal text. Only targets
 * that look like a link (URL, path, anchor, file) count, so prose such as
 * "[1, 2] (sorted)" stays legal.
 */
const linkSpacePattern = (extensions: readonly string[]): RegExp =>
  new RegExp(String.raw`\[[^\]]*\][ \t]+\((?:https?:\/\/|mailto:|\.{0,2}\/|#|[\w./-]+\.(?:${extensions.map(escapeRegExp).join('|')})\b)`, 'g');

/** A letter, one `*`, a letter: what `store_id` becomes once `_` is re-read as emphasis. */
const EMPHASIS_MANGLE = /(?<=[A-Za-z])\*(?=[A-Za-z])/;

/** `**name**` for a dunder name a formatter re-read as `__bold__` and rewrote. */
const dunderPattern = (words: readonly string[]): RegExp => new RegExp(`\\*\\*(${words.map(escapeRegExp).join('|')})\\*\\*`, 'g');

const HEADING = /^#{1,6}\s+\S/;
const PIPE_ROW = /^\s*\|.*\|\s*$/;
const LETTERED_STEP = /^(\s*)(?:[-*+]\s+)?([a-z])[.)]\s+\S/;

const childrenOf = (token: Token, type: string): Token[] => token.children.filter((child) => child.type === type);

const fences = (params: RuleParams): Token[] => walk(params.parsers.micromark.tokens).filter((t) => t.type === 'codeFenced');

const alertMarkerInline = rule('alert-marker-inline', 'Alert marker shares its line with content', (params, onError) => {
  const alert = alertPattern(listOption('pariksha-alert-marker-inline', params.config, 'alert_types'));
  proseLines(params).forEach((line, index) => {
    if (line !== null && alert.test(line)) {
      onError({
        lineNumber: index + 1,
        detail: 'GitHub renders `> [!TYPE]` as a callout only alone on its line; put the body on the next `>` line',
      });
    }
  });
});

const linkSpaceBeforeParen = rule('link-space-before-paren', 'Space between `]` and `(` breaks a link', (params, onError) => {
  const linkSpace = linkSpacePattern(listOption('pariksha-link-space-before-paren', params.config, 'link_target_extensions'));
  proseLines(params).forEach((line, index) => {
    if (line === null) return;
    for (const match of line.matchAll(linkSpace)) {
      const label = match[0].slice(1, match[0].indexOf(']')).trim();
      // `- [ ] (optional)` and `- [x] (done)` are task boxes, not links.
      if (label === '' || label.toLowerCase() === 'x') continue;
      onError({ lineNumber: index + 1, detail: 'write `[text](target)`; with the space it renders as text' });
    }
  });
});

const codeSpanCrossesLine = rule('code-span-crosses-line', 'Code span broken across a line', (params, onError) => {
  readConfig('pariksha-code-span-crosses-line', params.config);
  const spans = walk(params.parsers.micromark.tokens).filter((t) => t.type === 'codeText');
  for (const span of spans) {
    if (span.endLine !== span.startLine) {
      onError({
        lineNumber: span.startLine,
        detail: `the span closes ${span.endLine - span.startLine} line(s) later; the line break renders as a space inside it`,
      });
      continue;
    }
    // One path wrapped into two spans, `a/b/` then `c.ts` on the next line,
    // renders as "a/b/ c.ts": a path nobody can copy.
    const rest = (params.lines[span.startLine - 1] ?? '').slice(span.endColumn - 1);
    if (rest.trim() !== '' || !span.text.replace(/`+$/, '').trimEnd().endsWith('/')) continue;
    // Document order: the first span on the next line is its leftmost.
    const following = spans.find((t) => t.startLine === span.startLine + 1);
    if (following !== undefined && (params.lines[following.startLine - 1] ?? '').slice(0, following.startColumn - 1).trim() === '') {
      onError({
        lineNumber: span.startLine,
        detail: "a path span ends in `/` at the line break and goes on in the next line's span; join them",
      });
    }
  }
});

const fenceUnclosed = rule('fence-unclosed', 'Code fence never closes', (params, onError) => {
  readConfig('pariksha-fence-unclosed', params.config);
  for (const fence of fences(params)) {
    if (childrenOf(fence, 'codeFencedFence').length < 2) onError({ lineNumber: fence.startLine, detail: 'everything after it renders as code' });
  }
});

const fenceEmpty = rule('fence-empty', 'Empty code fence', (params, onError) => {
  readConfig('pariksha-fence-empty', params.config);
  for (const fence of fences(params)) {
    const body = childrenOf(fence, 'codeFlowValue');
    if (body.every((value) => value.text.trim() === '')) {
      onError({ lineNumber: fence.startLine, detail: 'renders as a blank code block: a stray or orphan fence?' });
    }
  }
});

const fenceSwallowsHeading = rule('fence-swallows-heading', 'Markdown heading inside a code fence', (params, onError) => {
  const languages = new Set(listOption('pariksha-fence-swallows-heading', params.config, 'no_hash_languages').map((lang) => lang.toLowerCase()));
  for (const fence of fences(params)) {
    const open = childrenOf(fence, 'codeFencedFence')[0];
    const info = open === undefined ? undefined : childrenOf(open, 'codeFencedFenceInfo')[0];
    if (info === undefined) continue;
    const lang = info.text.toLowerCase();
    if (!languages.has(lang)) continue;
    const heading = childrenOf(fence, 'codeFlowValue').find((value) => HEADING.test(value.text));
    if (heading !== undefined) {
      onError({
        lineNumber: heading.startLine,
        detail: `a ${lang} fence opened ${heading.startLine - fence.startLine} line(s) above holds this heading: it is missing its close`,
      });
    }
  }
});

const tableRowOrphaned = rule('table-row-orphaned', 'Table row cut off from its table', (params, onError) => {
  readConfig('pariksha-table-row-orphaned', params.config);
  const paragraphs = walk(params.parsers.micromark.tokens).filter((t) => t.type === 'paragraph');
  for (const paragraph of paragraphs) {
    if (paragraph.text.split('\n').every((row) => PIPE_ROW.test(row))) {
      onError({
        lineNumber: paragraph.startLine,
        detail: 'pipe rows with no header render as text: a blank line split the table; keep its rows together',
      });
    }
  }
});

/** Ten characters and a letter: a line whose repeat is a mistake. */
const meaningful = (line: string): boolean => line.length >= 10 && /[A-Za-z]/.test(line);

const duplicateAdjacentLine = rule('duplicate-adjacent-line', 'Line repeats the one before it', (params, onError) => {
  readConfig('pariksha-duplicate-adjacent-line', params.config);
  let previous: { text: string; line: number } | null = null;
  proseLines(params).forEach((line, index) => {
    if (line === null) {
      previous = null;
      return;
    }
    const text = (params.lines[index] ?? '').trim();
    if (text === '') return;
    // Table rows repeat by design (templates, matrices).
    if (!PIPE_ROW.test(text) && meaningful(text) && previous?.text === text) {
      onError({ lineNumber: index + 1, detail: `identical to the line ${index + 1 - previous.line} above` });
    }
    previous = { text, line: index + 1 };
  });
});

const replacementCharacter = rule('replacement-character', 'U+FFFD replacement character', (params, onError) => {
  readConfig('pariksha-replacement-character', params.config);
  params.lines.forEach((line, index) => {
    if (line.includes('�')) onError({ lineNumber: index + 1, detail: 'bytes were lost in an encoding round-trip' });
  });
});

const emphasisMangle = rule('emphasis-mangle', 'Identifier lost its underscore to emphasis', (params, onError) => {
  readConfig('pariksha-emphasis-mangle', params.config);
  proseLines(params).forEach((line, index) => {
    if (line !== null && EMPHASIS_MANGLE.test(line)) {
      onError({ lineNumber: index + 1, detail: 'a single `*` between two letters (`store*id`): put the identifier in a code span' });
    }
  });
});

const dunderMangle = rule('dunder-mangle', 'Dunder identifier rewritten as bold', (params, onError) => {
  const dunder = dunderPattern(listOption('pariksha-dunder-mangle', params.config, 'dunder_words'));
  proseLines(params).forEach((line, index) => {
    if (line === null) return;
    for (const match of line.matchAll(dunder)) {
      const word = match[1] ?? '';
      onError({ lineNumber: index + 1, detail: `renders as bold "${word}"; the identifier is \`__${word}__\` in a code span` });
    }
  });
});

const letteredStepIndent = rule('lettered-step-indent', 'Lettered step indented unlike its sibling', (params, onError) => {
  readConfig('pariksha-lettered-step-indent', params.config);
  let last: { letter: number; indent: number; line: number } | null = null;
  proseLines(params).forEach((line, index) => {
    if (line === null || HEADING.test(line)) {
      last = null;
      return;
    }
    const step = LETTERED_STEP.exec(line);
    if (step === null) {
      // Text at or left of the last step's indent ends its list, so a later
      // `b.` belongs to another list; a deeper line continues it.
      const lead = line.length - line.trimStart().length;
      if (line.trim() !== '' && last !== null && lead <= last.indent) last = null;
      return;
    }
    const indent = (step[1] ?? '').length;
    const letter = (step[2] ?? '').charCodeAt(0);
    if (last !== null && letter === last.letter + 1 && indent !== last.indent) {
      onError({
        lineNumber: index + 1,
        detail: `indented ${indent}, its sibling ${index + 1 - last.line} line(s) above ${last.indent}: it renders under a different parent`,
      });
    }
    last = { letter, indent, line: index + 1 };
  });
});

export const RULES: readonly MarkdownRule[] = [
  alertMarkerInline,
  linkSpaceBeforeParen,
  codeSpanCrossesLine,
  fenceUnclosed,
  fenceEmpty,
  fenceSwallowsHeading,
  tableRowOrphaned,
  duplicateAdjacentLine,
  replacementCharacter,
  emphasisMangle,
  dunderMangle,
  letteredStepIndent,
];

export default RULES;
// `require()` of this ES module returns the rules array itself, as a CommonJS
// rules module would, rather than its namespace.
export { RULES as 'module.exports' };
