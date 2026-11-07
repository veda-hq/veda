import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';

import rule, { DEFAULT_HINTS } from './no-hand-rolled-argv.js';

/**
 * VAL-08 (TS part) `no-hand-rolled-argv`. The first invalid case is the
 * catalogue example (the code a reviewer reported, reduced to the smallest
 * shape that still reproduces it), followed by the corrected code and
 * near-misses that must stay valid.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

// ---------------------------------------------------------------------------
// VAL-08: a helper that reads the token after a flag as its value.

/** Every array method the rule reads as a hand-rolled argv scan. */
const ARGV_SCAN_METHODS = [
  'at',
  'entries',
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'forEach',
  'includes',
  'indexOf',
  'join',
  'lastIndexOf',
  'map',
  'pop',
  'reduce',
  'shift',
  'some',
  'splice',
];

ruleTester.run('no-hand-rolled-argv', rule as never, {
  valid: [
    // A function with no name is no helper, and must not crash the rule.
    { code: 'export default function () { return 1; }' },
    // The fix: one declared spec, parsed strictly.
    {
      code: `
        import { parseCliArgsWithUsage } from '../lib/cli-args';
        const { options } = parseCliArgsWithUsage(process.argv.slice(2), {
          options: { r6: { type: 'string', required: true } },
        });`,
    },
    // Near-miss: entry-point detection reads argv[1], which is not parsing.
    { code: 'if (isCliEntry(process.argv[1], import.meta.url)) main();' },
    { code: 'const node = process.argv[0];' },
    // Near-miss: the slice bound to a name and only handed to a parser.
    {
      code: `
        const args = process.argv.slice(2);
        const parsed = parseCliArgs(args, spec);`,
    },
    // Near-miss: building an argv for a CHILD process is not parsing one.
    {
      code: "const args = ['--out', file]; args.push('--force'); spawn('x', args);",
    },
    // Near-miss: execArgv is Node's own flags, not this CLI's arguments.
    { code: "const inspecting = process.execArgv.includes('--inspect');" },
    // Near-miss: `parseArgs` (plural) is node:util's parser's name.
    {
      code: 'function parseArgs(tokens) { return parseCliArgs(tokens, spec); }',
    },
    {
      code: 'function main(argv) { return parseCliArgsWithUsage(argv, spec); }',
    },
    // Near-miss: `process` read through a computed key is not process.argv.
    { code: 'const t = globalThis[process].argv[2];' },
    // Near-miss: argv used as a KEY, assigned whole, or as a loop initialiser
    // is neither indexed nor scanned.
    { code: 'const v = table[process.argv];' },
    { code: 'let copy; copy = process.argv;' },
    { code: 'for (process.argv; ; ) break;' },
    { code: 'for (process.argv.slice(2); ; ) break;' },
    // Near-miss: a helper-shaped name bound to a value, not a function.
    { code: 'const argValue = parsed.values.arg;' },
    // Near-miss: indexing a binding not named like argv.
    { code: 'const items = load(); const first = items[0];' },
    // Near-miss: a configured global named argv has no declaration to follow.
    {
      code: 'const x = argv[2];',
      languageOptions: { globals: { argv: 'readonly' } },
    },
  ],
  invalid: [
    ...ARGV_SCAN_METHODS.map(method => ({
      code: `process.argv.${method}(x);`,
      errors: [{ messageId: 'scan' as const }],
    })),
    {
      code: 'for (const key in process.argv) use(key);',
      errors: [{ messageId: 'scan' }],
    },
    // A type assertion keeps the runtime value.
    {
      code: 'const i = (process.argv as string[]).indexOf(flag);',
      errors: [{ messageId: 'scan' }],
    },
    // `pop` takes the last token, whatever it is.
    {
      code: 'const last = process.argv.slice(2).pop();',
      errors: [{ messageId: 'scan' }],
    },
    // Index 0 of a SLICE is a user argument, not the entry point.
    {
      code: 'const command = process.argv.slice(2)[0];',
      errors: [{ messageId: 'index' }],
    },
    {
      code: 'const getArg = function (name) { return name; };',
      errors: [
        {
          messageId: 'helper',
          data: { name: 'getArg', hint: DEFAULT_HINTS.helper },
        },
      ],
    },
    // The catalogue example: argValue takes the next flag as the value.
    {
      code: `
        export function argValue(argv, flag) {
          const index = argv.indexOf(flag);
          return index >= 0 ? argv[index + 1] : undefined;
        }
        const r6Path = argValue(process.argv.slice(2), '--r6');`,
      errors: [
        { messageId: 'helper' },
        { messageId: 'scan' },
        { messageId: 'index' },
      ],
    },
    // A `--runs=` lookup: find on the sliced argv.
    {
      code: `
        const args = process.argv.slice(2);
        const runsArg = args.find(a => a.startsWith('--runs='));`,
      errors: [{ messageId: 'scan' }],
    },
    {
      code: "const dryRun = process.argv.includes('--dry-run');",
      errors: [{ messageId: 'scan' }],
    },
    {
      code: 'const target = process.argv[2];',
      errors: [{ messageId: 'index' }],
    },
    {
      code: 'const [, , command] = process.argv;',
      errors: [{ messageId: 'index' }],
    },
    {
      code: 'const [command] = process.argv.slice(2);',
      errors: [{ messageId: 'index' }],
    },
    {
      code: 'if (process.argv.length < 3) usage();',
      errors: [{ messageId: 'scan' }],
    },
    {
      code: 'for (const arg of process.argv.slice(2)) handle(arg);',
      errors: [{ messageId: 'scan' }],
    },
    {
      code: "const verbose = process.argv.slice(2).includes('-v');",
      errors: [{ messageId: 'scan' }],
    },
    {
      code: 'function main(argv) { for (let i = 0; i < argv.length; i++) use(argv[i]); }',
      errors: [{ messageId: 'scan' }, { messageId: 'index' }],
    },
    {
      code: 'const flagValue = (name) => lookup(name);',
      errors: [{ messageId: 'helper' }],
    },
    {
      code: 'function hasFlag(name) { return seen.has(name); }',
      errors: [{ messageId: 'helper' }],
    },
    {
      code: 'const rest = process.argv.slice(2); const next = rest.slice(1); next[0];',
      errors: [{ messageId: 'index' }],
    },
    {
      code: 'const t = globalThis.process.argv[3];',
      errors: [{ messageId: 'index' }],
    },
    // A caller's hint replaces the default for that message only.
    {
      code: 'const target = process.argv[2]; function getFlag() {}',
      options: [{ hints: { index: 'Use `parseCli` (lib/cli.ts).' } }],
      errors: [
        { messageId: 'index', data: { hint: 'Use `parseCli` (lib/cli.ts).' } },
        {
          messageId: 'helper',
          data: { name: 'getFlag', hint: DEFAULT_HINTS.helper },
        },
      ],
    },
  ],
});

interface RuleMeta {
  meta: {
    type: string;
    docs: { description: string };
    messages: Record<string, string>;
  };
}

/** The remedy each default hint names; the message ids are the complete set. */
const MESSAGES: Record<string, string> = {
  index: 'parseArgs',
  scan: 'parseArgs',
  helper: 'parseArgs',
};

/** The rule's messages on `code` under `options`. */
const messagesOf = (code: string, options: unknown[]) =>
  new Linter({ configType: 'flat' })
    .verify(code, {
      plugins: { t: { rules: { r: rule as never } } },
      rules: { 't/r': ['error', ...options] as never },
    })
    .map(message => message.message);

describe('no-hand-rolled-argv meta', () => {
  const { meta } = rule as RuleMeta;

  it('is a problem rule whose texts name the fix', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(meta.docs.description.includes('declared parser'));
    assert.deepEqual(
      Object.keys(meta.messages).sort(),
      Object.keys(MESSAGES).sort(),
    );
    assert.deepEqual(
      Object.keys(DEFAULT_HINTS).sort(),
      Object.keys(MESSAGES).sort(),
    );
    for (const [id, remedy] of Object.entries(MESSAGES)) {
      assert.ok(meta.messages[id]?.endsWith('{{hint}}'), id);
      assert.ok(
        DEFAULT_HINTS[id as keyof typeof DEFAULT_HINTS].includes(remedy),
        id,
      );
    }
  });

  it('renders a caller helper path in place of the default', () => {
    const parser = '`parseCliArgsWithUsage` (lib/cli-args.ts)';
    assert.deepEqual(
      messagesOf('process.argv[2]; process.argv.length; function getArg() {}', [
        {
          hints: {
            index: `Pass \`process.argv.slice(2)\` to ${parser}.`,
            scan: `Pass \`process.argv.slice(2)\` to ${parser}.`,
            helper: `Declare the options once and use ${parser}.`,
          },
        },
      ]),
      [
        'Indexing argv reads whatever token sits there: an omitted value yields the NEXT FLAG (`--out --force` writes to "--force") and a typo is silently ignored. Pass `process.argv.slice(2)` to `parseCliArgsWithUsage` (lib/cli-args.ts).',
        'Scanning argv (`indexOf`, `includes`, `find`, a loop...) is a hand-rolled parser: unknown, duplicate, empty and flag-shaped values all pass. Pass `process.argv.slice(2)` to `parseCliArgsWithUsage` (lib/cli-args.ts).',
        '`getArg` is an ad-hoc argv helper — the `argValue` shape that takes the next flag as a value. Declare the options once and use `parseCliArgsWithUsage` (lib/cli-args.ts).',
      ],
    );
  });

  it('refuses a hint for a message the rule does not have', () => {
    assert.throws(
      () => messagesOf('x;', [{ hints: { other: 'x' } }]),
      /should NOT have additional properties/,
    );
  });
});
