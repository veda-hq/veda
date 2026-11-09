// The examples the markdownlint rules are judged on: data only, no tests. The
// rules suite drives them through hand-built tokens; a markdownlint run can
// lint the same texts through the real parser. Rule names are given without
// their `pariksha-` prefix.

export interface Case {
  readonly rule: string;
  /** What the finding tells the author. */
  readonly detail: string;
  /** A document that read fine as source and rendered wrong. */
  readonly example: string;
  /** Where the example fails. */
  readonly line: number;
  readonly corrected: string;
  /** Texts close to the example that must pass. */
  readonly nearMisses: readonly string[];
}

export const CASES: readonly Case[] = [
  {
    rule: 'alert-marker-inline',
    detail: 'GitHub renders `> [!TYPE]` as a callout only alone on its line; put the body on the next `>` line',
    example: '# RFC\n\n> [!NOTE] > **Implementation status:** phase 1 shipped.\n',
    line: 3,
    corrected: '# RFC\n\n> [!NOTE]\n> **Implementation status:** phase 1 shipped.\n',
    nearMisses: ['> [!WARNING]   \n> body\n', '> Write [!NOTE] markers alone.\n', '```md\n> [!NOTE] > inside a fence\n```\n'],
  },
  {
    rule: 'link-space-before-paren',
    detail: 'write `[text](target)`; with the space it renders as text',
    example: '| id | rule |\n| -- | ---- |\n| T-15 | [A test HTTP server must bind loopback] (./testing/test-servers-bind-loopback.md) |\n',
    line: 3,
    corrected: '| id | rule |\n| -- | ---- |\n| T-15 | [A test HTTP server must bind loopback](./testing/test-servers-bind-loopback.md) |\n',
    nearMisses: ['Sorted [1, 2] (ascending).\n', '- [ ] (./optional.md)\n- [x] (./done.md)\n', 'Shown as `[text] (./a.md)` on purpose.\n'],
  },
  {
    rule: 'code-span-crosses-line',
    detail: "a path span ends in `/` at the line break and goes on in the next line's span; join them",
    example: 'The reader in `apps/mobile/src/data/db/`\n`sync-sql.ts` owns it.\n',
    line: 1,
    corrected: 'The reader in `apps/mobile/src/data/db/sync-sql.ts`\nowns it.\n',
    nearMisses: ['Both `apps/` and\n`sync.ts` here.\n', 'Under `apps/mobile/`\nnothing else.\n', 'One `span` per line.\n'],
  },
  {
    rule: 'code-span-crosses-line',
    detail: 'the span closes 1 line(s) later; the line break renders as a space inside it',
    example: 'It fails (`fatal: the path\nis a nested git repository`) at once.\n',
    line: 1,
    corrected: 'It fails\n(`fatal: the path is a nested git repository`) at once.\n',
    nearMisses: ['It fails (`fatal`)\nat once.\n'],
  },
  {
    rule: 'fence-unclosed',
    detail: 'everything after it renders as code',
    example: '## Parse\n\n```ts\nconst a = 1;\n',
    line: 3,
    corrected: '## Parse\n\n```ts\nconst a = 1;\n```\n',
    nearMisses: ['~~~text\n```\n~~~\n'],
  },
  {
    rule: 'fence-empty',
    detail: 'renders as a blank code block: a stray or orphan fence?',
    example: 'Text.\n\n```\n```\n',
    line: 3,
    corrected: 'Text.\n',
    nearMisses: ['```text\nbody\n```\n'],
  },
  {
    rule: 'fence-swallows-heading',
    detail: 'a typescript fence opened 4 line(s) above holds this heading: it is missing its close',
    example: '```typescript\n  return defaultValue;\n}\n\n#### 1.4.2 Strict Configuration Validation\n\nText.\n```\n',
    line: 5,
    corrected: '```typescript\n  return defaultValue;\n}\n```\n\n#### 1.4.2 Strict Configuration Validation\n\nText.\n',
    nearMisses: ['```bash\n# a comment\n```\n', '```ts\n#!/usr/bin/env node\n// # not a heading\n```\n'],
  },
  {
    rule: 'table-row-orphaned',
    detail: 'pipe rows with no header render as text: a blank line split the table; keep its rows together',
    example: '| id | title |\n| -- | ----- |\n| P-06 | six |\n\n| P-07 | seven |\n| P-08 | eight |\n',
    line: 5,
    corrected: '| id | title |\n| -- | ----- |\n| P-06 | six |\n| P-07 | seven |\n| P-08 | eight |\n',
    nearMisses: ['a | b | c\n', '| not closed\n', '| a |\nplain text\n'],
  },
  {
    rule: 'duplicate-adjacent-line',
    detail: 'identical to the line 2 above',
    example: '> **Fail Fast:** validate at startup.\n\n> **Fail Fast:** validate at startup.\n',
    line: 3,
    corrected: '> **Fail Fast:** validate at startup.\n',
    nearMisses: [
      '| a | b |\n| - | - |\n| same row here | x |\n| same row here | x |\n',
      'Yes.\n\nYes.\n',
      'A repeated line here.\n\n```text\nx\n```\n\nA repeated line here.\n',
    ],
  },
  {
    rule: 'replacement-character',
    detail: 'bytes were lost in an encoding round-trip',
    example: 'HIGH ──── �\n',
    line: 1,
    corrected: 'HIGH ──── ┘\n',
    nearMisses: ['HIGH ────\n'],
  },
  {
    rule: 'emphasis-mangle',
    detail: 'a single `*` between two letters (`store*id`): put the identifier in a code span',
    example: 'Scope rows by store*id and region.\n',
    line: 1,
    corrected: 'Scope rows by `store_id` and region.\n',
    nearMisses: ['2 * 3 is six.\n', 'Write `store*id`.\n', '**bold**text\n'],
  },
  {
    rule: 'dunder-mangle',
    detail: 'renders as bold "DEV"; the identifier is `__DEV__` in a code span',
    example: 'Logging is gated on **DEV** builds.\n',
    line: 1,
    corrected: 'Logging is gated on `__DEV__` builds.\n',
    nearMisses: ['**NEVER** skip it.\n', '**Dev** builds.\n', 'Use `**DEV**`.\n'],
  },
  {
    rule: 'lettered-step-indent',
    detail: 'indented 5, its sibling 1 line(s) above 3: it renders under a different parent',
    example: '4. Commit:\n   a. Stage only modified files\n   b. Write the message\n     c. NEVER use --no-verify\n',
    line: 4,
    corrected: '4. Commit:\n   a. Stage only modified files\n   b. Write the message\n   c. NEVER use --no-verify\n',
    nearMisses: [
      'a. one\n\n## Next\n\n  b. two\n',
      'a. one\n  c. three\n',
      'a. one\n\n```text\n  b. two\n```\n',
      'a. one\n\nSome text between two lists.\n\n  b. two\n',
      '1. First\n   a. one\n2. Second\n     b. two\n',
      '   a. one\n   Text at the step indent.\n     b. two\n',
    ],
  },
];

/** The fence languages in which a heading means a missing close, by default. */
export const NO_HASH_LANGUAGES = ['ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript', 'json', 'jsonc', 'sql', 'css', 'html', 'swift', 'kotlin', 'java', 'go', 'rust', 'prisma', 'graphql'];

export interface Extra {
  readonly name: string;
  readonly text: string;
  /** `rule@line` of every finding, in markdownlint's order. */
  readonly findings: readonly string[];
  /** Behaviour of the markdownlint engine, not of the rules: only a real run shows it. */
  readonly engineOnly?: true;
}

export const EXTRAS: readonly Extra[] = [
  { name: 'counts each `] (` link on a line', text: '[a] (./a.md) and [b] (./b.md)\n', findings: ['link-space-before-paren@1', 'link-space-before-paren@1'] },
  { name: 'counts each mangled dunder on a line', text: '**DEV** and **proto**\n', findings: ['dunder-mangle@1', 'dunder-mangle@1'] },
  { name: 'reports lines after front matter where they are', text: '---\ntitle: x\n---\n\n> [!TIP] > y\n', findings: ['alert-marker-inline@5'], engineOnly: true },
  { name: 'reads an info string case-insensitively', text: '```TS\n# Heading\n```\n', findings: ['fence-swallows-heading@2'] },
  ...NO_HASH_LANGUAGES.map((lang) => ({ name: `takes a heading in a ${lang} fence as a missing close`, text: `\`\`\`${lang}\n# Heading\n\`\`\`\n`, findings: ['fence-swallows-heading@2'] })),
  { name: 'leaves a heading-shaped comment in a fence of no language', text: '```\n# a shell comment\n```\n', findings: [] },
  { name: 'leaves a heading-shaped comment in a fence of another language', text: '```bash\n# a shell comment\n```\n', findings: [] },
  { name: 'takes a fence of blank lines as empty', text: '```\n   \n```\n', findings: ['fence-empty@1'] },
  { name: 'joins a path span wrapped onto an indented line', text: '- In `apps/mobile/`\n  `src/` lives.\n', findings: ['code-span-crosses-line@1'] },
  { name: 'leaves a path span followed by text', text: 'See `apps/mobile/`,\n`src/` too.\n', findings: [] },
  { name: 'joins only a path span', text: 'Run `pnpm test`\n`pnpm lint` after.\n', findings: [] },
  { name: 'leaves a path span at the end of the document', text: 'Under `apps/mobile/`', findings: [] },
  { name: 'counts a repeated line from ten characters', text: 'abcdefghij\nabcdefghij\n', findings: ['duplicate-adjacent-line@2'] },
  { name: 'leaves a repeated line under ten characters', text: 'abcdefghi\nabcdefghi\n', findings: [] },
  { name: 'keeps a lettered list across continuation lines', text: '   a. one\n      more of a\n     b. two\n', findings: ['lettered-step-indent@3'] },
  { name: 'keeps a lettered list across blank lines', text: 'a. one\n\nb. two\n\n  c. three\n', findings: ['lettered-step-indent@5'] },
];
