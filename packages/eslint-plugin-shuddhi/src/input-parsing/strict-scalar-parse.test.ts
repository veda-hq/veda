import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';

import rule, { DEFAULT_HINTS } from './strict-scalar-parse.js';

/**
 * VAL-05 = EDGE-03 `strict-scalar-parse`. The first invalid case is the
 * catalogue example (the code a reviewer reported, reduced to the smallest
 * shape that still reproduces it), followed by the corrected code and
 * near-misses that must stay valid.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

/** This suite's directory, which holds fixtures/. */
const ROOT = dirname(fileURLToPath(import.meta.url));

/** The page readers a caller names, as passed by the cases that use them. */
const READERS = [{ pageReaders: ['parsePageParam', 'usePageParam'] }];

/** `pageParam` data with the default hint the message carries. */
const page = (name: string) => ({ name, hint: DEFAULT_HINTS.pageParam });

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

/**
 * Type-aware: the shape a typed workspace lints with, strict as such
 * workspaces are (fixtures/tsconfig.json). A non-null assertion only changes
 * a type under strictNullChecks.
 */
const typedTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ['*.ts'],
        defaultProject: 'fixtures/tsconfig.json',
      },
      tsconfigRootDir: ROOT,
    },
  },
});

// ---------------------------------------------------------------------------
// VAL-05 = EDGE-03 (one rule).
// VAL-05: `parseInt` of a junk flag value is NaN, and the run loop never ran.
// EDGE-03: `Date.parse` repaired 2026-02-29 into 1 March.

ruleTester.run('strict-scalar-parse (syntax only)', rule as never, {
  valid: [
    // The fixes.
    {
      code: 'const runs = parseFiniteNumber(text, { integer: true, min: 1, max: 100 });',
    },
    { code: 'const at = parseIsoInstant(value);' },
    // Near-miss: a guarded Number() result.
    {
      code: 'const n = Number(text); if (!Number.isFinite(n)) throw new Error("x");',
    },
    {
      code: 'let n; n = Number(text); return Number.isSafeInteger(n) ? n : null;',
    },
    { code: 'const ok = Number.isInteger(Number(text) as number);' },
    // Every read sits where the guard already passed —
    // after `if (!guard) <exit>`, in the passing branch, right of `&&`
    // (or of a failed guard's `||`), or behind a flag holding the verdict.
    ...[
      'function f(t) { const n = Number(t); if (!Number.isFinite(n)) return 0; return n * 2; }',
      'function f(t) { const n = Number(t); if (!Number.isFinite(n)) { log("bad"); throw new Error("x"); } return n; }',
      'for (const t of ts) { const n = Number(t); if (!Number.isInteger(n)) continue; use(n); }',
      'for (const t of ts) { const n = Number(t); if (!Number.isInteger(n)) break; use(n); }',
      'const n = Number(t); if (!Number.isFinite(n)) process.exit(2); use(n);',
      'const n = Number(t); if (!Number.isFinite(n)) {} else { use(n); }',
      'const n = Number(t); const r = Number.isFinite(n) && use(n);',
      'const n = Number(t); const r = !Number.isFinite(n) || use(n);',
      'const n = Number(t); if (Number.isFinite(n) && n > 0) use(n);',
      'const n = Number(t); if (!(Number.isFinite(n) && n > 0)) throw 1; use(n);',
      'const n = Number(t); const r = !Number.isFinite(n) ? 0 : n;',
      'function f(raw, fallback) { const value = Number(raw); const usable = Number.isInteger(value) && value > 0; return usable ? value : fallback; }',
      // A flag whose declarator reads itself (var redeclared, so no TDZ:
      // ok is true, the verdict is Number.isFinite(n)); the flag walk
      // must stop at the declarator it has already followed.
      'var ok = true; const n = Number(t); var ok = ok && Number.isFinite(n); if (ok) use(n);',
    ].map(code => ({ code })),
    // A presence check reads no number (a percentage read from a request).
    ...['p !== undefined', 'undefined === p', 'p == null', 'p != null'].map(
      check => ({
        code: `const p = d ? Number(d) : undefined; const pct = ${check} && Number.isFinite(p) ? p : undefined;`,
      }),
    ),
    // Near-miss: numeric and argument-free construction.
    {
      code: 'const zero = Number(0); const d = new Date(); const e = new Date(ms);',
    },
    { code: 'const d = new Date(2026, 1, 28);' },
    // Near-miss: a local function that shadows the global name.
    { code: 'function parseInt(x) { return x; } parseInt("1");' },
    { code: 'const Number = (x) => x; Number(text);' },
    // Near-miss: syntax-only workspaces do not judge unary + or string <.
    { code: 'const t = +new Date(); const less = a < b;' },
    // Near-miss: the whole text validated before coercion, and a
    // conditional whose result is guarded further out (as in a test-database
    // setup script).
    { code: 'const n = /^[1-9]\\d*$/.test(raw) ? Number(raw) : 0;' },
    {
      code: 'const n = /^-?\\d+(?:\\.\\d{1,2})?$/.test(raw) ? Number(raw) : 0;',
    },
    // Alternatives grouped inside both anchors.
    { code: 'const n = /^(?:[+-]?[0-9]+|0)$/.test(raw) ? Number(raw) : 0;' },
    { code: 'const n = /^(\\d+)(\\.\\d+)?$/.test(raw) ? Number(raw) : 0;' },
    // Not claimed: junk only longer than the four probed characters.
    { code: 'const n = /^(?:\\d{4}-|\\d+)$/.test(raw) ? Number(raw) : 0;' },
    {
      code: 'const n = raw ? Number(raw) : Number.NaN; if (Number.isSafeInteger(n)) use(n);',
    },
    // EDGE-03 page parameters: the fixes, read through the one reader.
    { code: "const currentPage = usePageParam('ptPage');" },
    {
      code: "const page = parsePageParam(searchParams.get('page'), { max: 50 });",
      options: READERS,
    },
    // Near-miss: other parameters, other receivers, a dynamic key.
    { code: "const tab = searchParams.get('tab');" },
    { code: "const limit = cache.get('limit');" },
    { code: 'const value = searchParams.get(key);' },
    { code: 'const label = String(filters.page);' },
    // Near-miss: signed numeric literals and a spread are not text.
    { code: 'const n = Number(-1);' },
    { code: 'const n = Number(+1);' },
    { code: 'const n = Number(...args);' },
    { code: 'const d = new Date(+ms);' },
    // Near-miss: the raw read handed straight to the page reader; a
    // URLSearchParams CALL (no `new`) is not recognised as search params.
    {
      code: "const p = usePageParam(searchParams.get('page'));",
      options: READERS,
    },
    { code: "const p = URLSearchParams(qs).get('page');" },
    // Near-miss: an angle-bracket cast inside the guard keeps it a guard.
    { code: 'const ok = Number.isInteger(<number>Number(text));' },
  ],
  invalid: [
    // Page fields through every coercion.
    {
      code: 'const p = parseFloat(filters.page);',
      errors: [{ messageId: 'pageParam', data: page('page') }],
    },
    {
      code: 'const p = Number.parseInt(filters.page, 10);',
      errors: [{ messageId: 'pageParam', data: page('page') }],
    },
    {
      code: 'const p = Number.parseFloat(filters.limit);',
      errors: [{ messageId: 'pageParam', data: page('limit') }],
    },
    // A computed key read through a variable is not a page field.
    {
      code: 'const p = parseInt(filters[page], 10);',
      errors: [{ messageId: 'parseCall', data: { name: 'parseInt', hint: DEFAULT_HINTS.parseCall } }],
    },
    {
      code: 'const x = Number.parseFloat(text);',
      errors: [{ messageId: 'parseCall', data: { name: 'Number.parseFloat', hint: DEFAULT_HINTS.parseCall } }],
    },
    // Not numeric literals.
    {
      code: 'const n = Number(a - b);',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    {
      code: 'const n = Number(!1);',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    // Pre-checks that do not validate the whole text as a number: not
    // `.test`, not a regex literal, one anchor only, digits plus junk, no
    // digit at all.
    ...[
      '/^\\d+$/.exec(raw)',
      "'^1$'.test(raw)",
      '/^\\d+1/.test(raw)',
      '/1\\d$/.test(raw)',
      '/^\\d+px$/.test(raw)',
      '/^-$/.test(raw)',
      // An alternative outside the anchors
      // (`42junk` matches the first), a group then a stray alternative,
      // the empty text (`Number('')` is 0), and per-line anchors.
      '/^[+-]?[0-9]+|0$/.test(raw)',
      '/^(\\d)+|\\d+$/.test(raw)',
      '/^[0-9]*$/.test(raw)',
      '/^\\d+$/m.test(raw)',
      // Numeric tokens, but a lone sign, a lone point or a
      // sign after digits matches, and `Number` reads each as NaN.
      '/^(?:[+-]?[0-9]+|[+-])$/.test(raw)',
      '/^\\d*\\.\\d*$/.test(raw)',
      '/^\\d+-?$/.test(raw)',
      '/^(?:7-|\\d+)$/.test(raw)',
      '/^(?:\\d{3}-|\\d+)$/.test(raw)',
      // A class range between tokens spans `,` and `/` too.
      '/^[+-9]\\d$/.test(raw)',
      // Only the anchor checks see these: every text of four characters or
      // fewer that they accept is a number, but `x1234` or `1234x` matches.
      '/\\d{4}$/.test(raw)',
      '/^\\d{4}/.test(raw)',
      '/^(?:\\d{4})|\\d{4}$/.test(raw)',
      // A numeric body that survives the anchor slice: only `^`/`$` refuse these.
      '/0\\d{4}$/.test(raw)',
      '/^\\d{4}0/.test(raw)',
    ].map(check => ({
      code: `const n = ${check} ? Number(raw) : 0;`,
      errors: [{ messageId: 'unguardedNumber' as const }],
    })),
    // Guards that do not reach the coerced value: a loop initialiser, a
    // default parameter, a compound assignment.
    {
      code: 'for (Number(text); ; ) break;',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    {
      code: 'function f(x = Number(text)) { return Number.isFinite(x) ? x : 0; }',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    {
      code: 'let x = 0; x += Number(text); if (Number.isFinite(x)) use(x);',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    // EDGE-03 page parameters, hand-parsed: the shape the list pages had,
    // guarded or not, and a raw read.
    {
      code: `
        const parsedPage = Number(filters.page);
        const currentPage =
          Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;`,
      errors: [{ messageId: 'pageParam', data: page('page') }],
    },
    {
      code: 'const p = Number(filters.ptPage);',
      errors: [{ messageId: 'pageParam', data: page('ptPage') }],
    },
    {
      code: "const limit = parseInt(query['limit'], 10);",
      errors: [{ messageId: 'pageParam', data: page('limit') }],
    },
    {
      code: "const page = searchParams.get('page');",
      errors: [{ messageId: 'pageParam', data: page('page') }],
    },
    {
      code: "const size = new URL(href).searchParams.get('pageSize');",
      errors: [{ messageId: 'pageParam', data: page('pageSize') }],
    },
    {
      code: "const page = parseFiniteNumber(new URLSearchParams(qs).get('page'));",
      options: READERS,
      errors: [{ messageId: 'pageParam', data: page('page') }],
    },
    // A reader the caller did not name is no page reader (none by default).
    {
      code: "const p = usePageParam(searchParams.get('page'));",
      errors: [{ messageId: 'pageParam', data: page('page') }],
    },
    {
      code: "const p = readPage(searchParams.get('page'));",
      options: READERS,
      errors: [{ messageId: 'pageParam', data: page('page') }],
    },
    // VAL-05's example: parseInt('abc') is NaN and the run loop never runs.
    {
      code: "const runs = runsArg ? parseInt(runsArg.split('=')[1], 10) : DEFAULT_RUNS;",
      errors: [{ messageId: 'parseCall' }],
    },
    // EDGE-03's example: Date.parse normalises 2026-02-29 into 1 March.
    {
      code: `
        if (!/^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?(?:Z|[+-]\\d\\d:\\d\\d)$/.test(result) ||
            !Number.isFinite(Date.parse(result))) throw new Error('Expected timestamp');`,
      errors: [{ messageId: 'dateParse' }],
    },
    {
      code: 'const x = parseFloat(text);',
      errors: [{ messageId: 'parseCall' }],
    },
    {
      code: 'const x = Number.parseInt(text, 10);',
      errors: [{ messageId: 'parseCall' }],
    },
    {
      code: "const d = new Date('2026-02-29');",
      errors: [{ messageId: 'dateString' }],
    },
    {
      code: 'const d = new Date(`${day}T00:00:00Z`);',
      errors: [{ messageId: 'dateString' }],
    },
    {
      code: "const d = new Date(day + 'T00:00:00Z');",
      errors: [{ messageId: 'dateString' }],
    },
    // Unguarded, or guarded only by isNaN / `|| default`.
    {
      code: 'const n = Number(text);',
      errors: [{ messageId: 'unguardedNumber', data: { form: 'Number(...)', hint: DEFAULT_HINTS.unguardedNumber } }],
    },
    {
      code: 'const n = Number(text) || 1;',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    {
      code: 'const n = Number(text); if (isNaN(n)) throw new Error("x");',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    {
      code: 'const n = Number(text); if (Number.isNaN(n)) throw new Error("x");',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    // An unanchored or different-text pre-check validates nothing whole.
    {
      code: 'const n = /\\d+/.test(raw) ? Number(raw) : 0;',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    {
      code: 'const n = /^\\d+$/.test(other) ? Number(raw) : 0;',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    {
      code: 'const n = /^\\d+$/.test(raw) ? 0 : Number(raw);',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    {
      code: 'const n = check(raw) ? Number(raw) : 0;',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    // Anchors alone are not a numeric check.
    {
      code: 'const n = /^.*$/.test(raw) ? Number(raw) : 0;',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    {
      code: 'const n = /^\\w+$/.test(raw) ? Number(raw) : 0;',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    // A guard whose verdict is thrown away rejects nothing.
    {
      code: 'function f(text) { const n = Number(text); Number.isFinite(n); return n; }',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    {
      code: 'Number.isFinite(Number(text));',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    // The guards check their first argument only, and a
    // local `Number` is not the global's guard.
    ...[
      'const n = Number(t); if (!Number.isFinite(0, n)) throw 1; use(n);',
      'const r = Number.isInteger(1, Number(t));',
      'const n = Number(t); { const Number = { isFinite: () => true }; if (!Number.isFinite(n)) throw 1; use(n); }',
      'const n = Number(t); function f(Number) { if (!Number.isFinite(n)) throw 1; return n; }',
    ].map(code => ({
      code,
      errors: [{ messageId: 'unguardedNumber' as const }],
    })),
    // A guard whose verdict does not stand in front of
    // every read — an empty passing branch, a failing branch that falls
    // through, a read before the guard, a guard on the wrong side, `??`,
    // or a flag the rule cannot follow.
    ...[
      'function f(t) { const n = Number(t); if (Number.isFinite(n)) {} return n; }',
      'const n = Number(t); if (!Number.isFinite(n)) log("bad"); use(n);',
      'const n = Number(t); if (!Number.isFinite(n)) {} use(n);',
      'const n = Number(t); if (!Number.isFinite(n)) { log("bad"); } use(n);',
      'const n = Number(t); if (!Number.isFinite(n)) exit(2); use(n);',
      'const n = Number(t); if (!Number.isFinite(n)) process.abort(); use(n);',
      'const n = Number(t); if (!Number.isFinite(n)) bad = true; use(n);',
      'const n = Number(t); log(n); if (!Number.isFinite(n)) throw 1;',
      'const n = Number(t); const r = Number.isFinite(n) ?? use(n);',
      'const n = Number(t); const r = !Number.isFinite(n) && use(n);',
      'const n = Number(t); const r = Number.isFinite(n) || use(n);',
      'const n = Number(t); const r = use(n) && Number.isFinite(n);',
      'const n = Number(t); const r = x ? use(n) : Number.isFinite(n);',
      'const n = Number(t); const { ok } = Number.isFinite(n) && x; if (ok) use(n);',
      'const n = Number(t); const ok = Number.isFinite(n); use(n);',
      'const n = Number(t); const r = n > 0 && Number.isFinite(n);',
      // Only `!` flips a verdict; only an `if` that exits protects what
      // follows it; arithmetic is no presence check; a compound
      // assignment binds nothing the guard could have checked.
      'const n = Number(t); if (void Number.isFinite(n)) {} else { use(n); }',
      'const n = Number(t); f(!Number.isFinite(n) ? 0 : 1, use(n));',
      'const n = Number(t); const m = n * 2; if (!Number.isFinite(n)) throw 1;',
      "const n = Number(t); const s = n + ''; if (!Number.isFinite(n)) throw 1;",
      // A PASSING guard's exit protects nothing after the `if`.
      'function f(t) { const n = Number(t); if (Number.isFinite(n)) return 1; return n; }',
      'let x = 0; if (Number.isFinite(x)) { x += Number(text); use(x); }',
    ].map(code => ({
      code,
      errors: [{ messageId: 'unguardedNumber' as const }],
    })),
  ],
});

typedTester.run('strict-scalar-parse (typed)', rule as never, {
  valid: [
    // Near-miss: a number is not coerced from text.
    {
      code: 'declare const ms: number; const d = new Date(ms); const n = Number(ms);',
    },
    { code: 'declare const d: Date; const t = +d;' },
    {
      code: 'declare const a: number; declare const b: number; const less = a < b;',
    },
    {
      code: 'declare const a: string; declare const b: number; const x = a.length < b;',
    },
    {
      code: 'declare const s: string; const n = +s; if (!Number.isFinite(n)) throw 1;',
    },
    // Near-miss: a page field that is already a number, and a Map's `get`.
    {
      code: 'declare const meta: { page: number }; const p = Number(meta.page);',
    },
    {
      code: "declare const m: Map<string, string>; const l = m.get('limit');",
    },
    // Near-miss: only ONE side is a string.
    {
      code: 'declare const a: string; declare const n: number; const x = a < n;',
    },
    // Near-miss: a spread argument is not judged.
    {
      code: 'declare const parts: [string]; const d = new Date(...parts);',
    },
  ],
  invalid: [
    ...['>', '<=', '>='].map(operator => ({
      code: `declare const a: string; declare const b: string; const x = a ${operator} b;`,
      errors: [{ messageId: 'stringCompare' as const, data: { operator, hint: DEFAULT_HINTS.stringCompare } }],
    })),
    {
      code: "declare const params: URLSearchParams; const p = params.get('page');",
      errors: [{ messageId: 'pageParam' }],
    },
    {
      code: 'declare const filters: { page: string }; const p = +filters.page;',
      errors: [{ messageId: 'pageParam' }],
    },
    {
      code: 'declare const iso: string; const d = new Date(iso);',
      errors: [{ messageId: 'dateString' }],
    },
    {
      code: 'declare const raw: unknown; const n = Number(raw);',
      errors: [{ messageId: 'unguardedNumber' }],
    },
    {
      code: 'declare const s: string | number; const n = +s;',
      errors: [{ messageId: 'unguardedNumber', data: { form: 'unary +', hint: DEFAULT_HINTS.unguardedNumber } }],
    },
    {
      code: 'declare const a: string; declare const b: string; const earlier = a < b;',
      errors: [{ messageId: 'stringCompare' }],
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
  pageParam: 'pageReaders',
  parseCall: 'strict parser',
  dateParse: 'strict ISO parser',
  dateString: 'strict ISO parser',
  unguardedNumber: 'strict number parser',
  stringCompare: 'localeCompare',
};

/** The product-shaped hints: helper names and paths a caller passes. */
const CALLER_HINTS: Record<string, string> = {
  pageParam:
    'Read it with `usePageParam(key)` (web lib/hooks) or `parsePageParam(text, { max })` (shared parsing/scalars), which floor, clamp to [1, max] and fall back to 1.',
  parseCall:
    'Use `parseFiniteNumber(text, { integer, min, max })` (shared parsing/scalars).',
  dateParse: 'Use `parseIsoInstant` / `parseIsoDate` (shared parsing/scalars).',
  dateString:
    'Use `parseIsoInstant` / `parseIsoDate` (shared parsing/scalars).',
  unguardedNumber: 'Use `parseFiniteNumber`, or guard the result.',
  stringCompare:
    'Parse first (`parseIsoInstant`, `parseFiniteNumber`), or use `localeCompare` for text.',
};

describe('strict-scalar-parse meta', () => {
  const { meta } = rule as RuleMeta;

  it('is a problem rule whose texts name the fix', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(meta.docs.description.includes('strict helpers'));
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

  it('renders caller hints in place of the defaults', () => {
    const code = [
      "params.get('page');",
      'parseInt(text, 10);',
      'Date.parse(text);',
      "new Date('2026-02-29');",
      'Number(text);',
    ].join('\n');
    const messages = new Linter({ configType: 'flat' })
      .verify(code, {
        plugins: { parse: { rules: { r: rule as never } } },
        rules: { 'parse/r': ['error', { hints: CALLER_HINTS }] as never },
      })
      .map(message => message.message);
    assert.deepEqual(messages, [
      'The `page` search parameter is hand-editable (`?page=abc`, `=0`, `=-3`, `=1e9`). Read it with `usePageParam(key)` (web lib/hooks) or `parsePageParam(text, { max })` (shared parsing/scalars), which floor, clamp to [1, max] and fall back to 1.',
      '`parseInt` accepts trailing junk (`parseInt("12abc")` is 12) and returns NaN for junk, which compares false against everything: `--runs=abc` once silently skipped every run. Use `parseFiniteNumber(text, { integer, min, max })` (shared parsing/scalars).',
      '`Date.parse` repairs impossible dates (`2026-02-29` becomes 1 March) and reads offset-less text as local time. Use `parseIsoInstant` / `parseIsoDate` (shared parsing/scalars).',
      '`new Date(text)` repairs impossible dates and reads offset-less text as local time. Use `parseIsoInstant` / `parseIsoDate` (shared parsing/scalars).',
      'This `Number(...)` result is used without `Number.isFinite` / `isInteger` / `isSafeInteger`: blank text is 0 and junk is NaN (an `isNaN` or `|| default` guard misses Infinity and keeps 0). Use `parseFiniteNumber`, or guard the result.',
    ]);
  });

  it('refuses a page reader list that is not a list of names', () => {
    const verify = (option: unknown) =>
      new Linter({ configType: 'flat' }).verify('x;', {
        plugins: { parse: { rules: { r: rule as never } } },
        rules: { 'parse/r': ['error', option] as never },
      });
    assert.deepEqual(verify({ pageReaders: ['readPage'] }), []);
    assert.throws(() => verify({ pageReaders: 'readPage' }), /should be array/);
  });
});

