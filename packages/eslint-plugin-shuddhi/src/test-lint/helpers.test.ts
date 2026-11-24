import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { format } from 'node:util';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import {
  assertion,
  calledMethod,
  constInit,
  enclosingFunctions,
  enclosingTest,
  inFinally,
  isNumber,
  isTeardownCallback,
  isTrueMatcher,
  ownerOf,
  propertyName,
  registeringBlock,
  registration,
  textOf,
  within,
} from './helpers.js';
import plugin from './index.js';

/**
 * The shared helpers in `helpers.js`, the module this suite owns. The
 * decision pins read them through the rules that call them, each case naming
 * the helper decision it pins; the direct reads at the end call each helper
 * on nodes of a parsed fixture and assert what it returns.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

/** Vitest's `it.each`: one `it` per row, its title printf-formatted. */
function each<const T>(rows: readonly T[]) {
  return (
    title: string,
    fn: (...args: T extends readonly unknown[] ? T : [T]) => void,
  ): void => {
    for (const row of rows) {
      const args = (Array.isArray(row) ? row : [row]) as T extends readonly unknown[]
        ? T
        : [T];
      it(format(title, ...args), () => {
        fn(...args);
      });
    }
  };
}

const TEST_FILE = 'probe.test.ts';

// ---------------------------------------------------------------------------
// Deleting the guard from a corrected case brings the rule back
// ---------------------------------------------------------------------------

function messageIds(
  rule: string,
  code: string,
  filename = TEST_FILE,
  options: unknown[] = [],
): string[] {
  const linter = new Linter({ configType: 'flat' });
  return linter
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          plugins: { 'shuddhi': plugin },
          rules: { [`shuddhi/${rule}`]: ['error', ...options] },
        },
      ],
      filename,
    )
    .map(message => message.messageId ?? message.message);
}

// ---------------------------------------------------------------------------
// Decision pins A: shared helpers, TEST-WEAK-03, TEST-STRUCT-02
// ---------------------------------------------------------------------------

/**
 * One fixture per rule decision a mutation run found unpinned: each
 * names the rule, the code, and the exact messageIds it must yield.
 */
interface CaseA {
  rule: string;
  code: string;
  ids: string[];
  filename?: string;
}

const nva = (code: string, ids: string[] = []): CaseA => ({
  rule: 'no-vacuous-assertion',
  code,
  ids,
});

const nested = (code: string, ids: string[] = []): CaseA => ({
  rule: 'no-nested-test-blocks',
  code,
  ids,
});

const HELPER_CASES_A: CaseA[] = [
  // FUNCTION_TYPES: a function expression callback, a function declaration.
  nested(`it('a', function () { describe('b', () => {}); });`, ['nested']),
  {
    rule: 'no-collection-time-io',
    code: `import { readFileSync } from 'node:fs'; function read() { return readFileSync('x', 'utf8'); } it('a', () => { expect(read()).toBe('x'); });`,
    ids: [],
  },
  // WRAPPERS: each type-only wrapper and optional chaining is seen through.
  nva(`it('a', () => { expect(true as boolean).toBe(true); });`, [
    'staticSubject',
  ]),
  nva(`it('a', () => { expect(1!).toBe(1); });`, ['staticSubject']),
  nva(`it('a', () => { expect(<number>1).toBe(1); });`, ['staticSubject']),
  nva(`it('a', () => { expect(1 satisfies number).toBe(1); });`, [
    'staticSubject',
  ]),
  nva(`it('a', () => { expect(rows?.every(r => r.ok)).toBe(true); });`, [
    'vacuousEvery',
  ]),
  // propertyName: a computed identifier is no name; a computed string is.
  {
    rule: 'hermetic-config',
    code: `ConfigModule[forRoot]({ load: [] });`,
    ids: [],
  },
  {
    rule: 'hermetic-config',
    code: `ConfigModule['forRoot']({ load: [] });`,
    ids: ['configModule'],
  },
  // A computed number is no matcher, so the Date check stays the only one.
  nva(
    `it('a', () => { const d = parse(raw); expect(d).toBeInstanceOf(Date); expect(d)[1](); });`,
    ['soleInstanceOf'],
  ),
  // registration: every root, factory and source the runner provides.
  nested(`test('a', () => { describe('b', () => {}); });`, ['nested']),
  {
    rule: 'no-collection-time-io',
    code: `import { readFileSync } from 'node:fs'; suite('s', () => { const t = readFileSync('x', 'utf8'); it('a', () => { expect(t).toBe('x'); }); });`,
    ids: ['collectionIo'],
  },
  // An afterAll restore runs after the block, so a test's
  // fake leaks into every later test in it.
  {
    rule: 'fake-timers-restored',
    code: `afterAll(() => { vi.useRealTimers(); }); it('a', () => { vi.useFakeTimers(); expect(run()).toBe(1); });`,
    ids: ['leak'],
  },
  nested(
    `it('a', () => { it.each([1, 2])('b %s', v => { expect(run(v)).toBe(v); }); });`,
    ['nested'],
  ),
  nested(
    `it('a', () => { it.for([1, 2])('b %s', v => { expect(run(v)).toBe(v); }); });`,
    ['nested'],
  ),
  nested(
    `it('a', () => { it.skipIf(off)('b', () => { expect(run()).toBe(1); }); });`,
    ['nested'],
  ),
  nested(
    `it('a', () => { it.runIf(on)('b', () => { expect(run()).toBe(1); }); });`,
    ['nested'],
  ),
  nested(
    `it('a', () => { it.concurrent('b', () => { expect(run()).toBe(1); }); });`,
    ['nested'],
  ),
  nva(
    `it.runIf(cases.filter(c => c.on))('t', () => { expect(run()).toBe(1); });`,
  ),
  nva(
    `it.for(rows.filter(r => r.ok))('t %s', r => { expect(run(r)).toBe(1); });`,
    ['eachFilter'],
  ),
  {
    rule: 'no-collection-time-skip-state',
    code: `let rows: number[] = []; beforeAll(() => { rows = load(); }); it.each(rows)('r %s', r => { expect(run(r)).toBe(1); });`,
    ids: [],
  },
  {
    rule: 'no-collection-time-skip-state',
    code: `let ready = false; beforeAll(() => { ready = true; }); it.runIf(ready)('t', () => { expect(run()).toBe(1); });`,
    ids: ['hookState'],
  },
  nested(
    `import { it, describe } from 'vitest'; it('a', () => { describe('b', () => {}); });`,
    ['nested'],
  ),
  nested(
    `import { it, describe } from '@jest/globals'; it('a', () => { describe('b', () => {}); });`,
    ['nested'],
  ),
  nested(
    `import { it, describe } from 'node:test'; it('a', () => { describe('b', () => {}); });`,
    ['nested'],
  ),
  // The owner is the registration whose callback this is, not any argument.
  nested(`it('a', () => { describe('b', () => {}); }, () => {});`),
  // assertion: modifiers, expect.soft, and calls that are not assertions.
  nva(`it('a', () => { expect(1).not.toBe(2); });`, ['staticSubject']),
  nva(`it('a', async () => { await expect(1).resolves.toBe(1); });`, [
    'staticSubject',
  ]),
  nva(`it('a', async () => { await expect(1).rejects.toBe(1); });`, [
    'staticSubject',
  ]),
  nva(`it('a', () => { expect(1).not(1); });`),
  nva(`it('a', () => { x = 1; expect(run()).toBe(1); });`),
  nva(`it('a', () => { expect(new Foo()).not.toBeUndefined(); });`, [
    'typeFixed',
  ]),
  nva(`it('a', () => { expect(1).foo.toBe(1); });`),
  nva(`it('a', () => { check(1).toBe(1); });`),
  nva(`it('a', () => { other.soft(1).toBe(1); });`),
  nva(`it('a', () => { expect.soft(1).toBe(1); });`, ['staticSubject']),
  nva(`it('a', () => { expect.other(1).toBe(1); });`),
  // constInit: only a const binding has a fixed initial value.
  nva(`it('a', () => { let n = 10; expect(n).toBe(10); });`),
];

describe('decision pins A: helpers', () => {
  each(HELPER_CASES_A.map(c => [`${c.rule}: ${c.code}`, c] as const))(
    '%s',
    (_name, c) => {
      assert.deepEqual(messageIds(c.rule, c.code, c.filename ?? TEST_FILE), c.ids);
    },
  );
  // A local named `expect` is not the runner's.
  each([
    `function expect(v: unknown) { return { toBe: (_: unknown) => v }; } it('a', () => { expect(true).toBe(true); });`,
    `const expect = makeHarness(); it('a', () => { expect(true).toBe(true); });`,
    `const expect = makeHarness(); it('a', () => { expect.soft(true).toBe(true); });`,
    `it('a', () => { harness.soft(true).toBe(true); });`,
    `it('a', () => { expect.extend(true).toBe(true); });`,
  ])('leaves a non-runner expect alone: %s', code => {
    assert.deepEqual(messageIds('no-vacuous-assertion', code), []);
  });
  each([
    `import { expect } from 'vitest'; it('a', () => { expect(true).toBe(true); });`,
    `import { expect } from '@jest/globals'; it('a', () => { expect.soft(true).toBe(true); });`,
    `it('a', () => { expect.soft(true).toBe(true); });`,
  ])('still reads the runner expect: %s', code => {
    assert.deepEqual(messageIds('no-vacuous-assertion', code), ['staticSubject']);
  });
  // COMPARISONS: each operator makes a boolean.
  each(['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'instanceof', 'in'])(
    'typeof (x %s y) is always boolean',
    operator => {
      assert.deepEqual(
        messageIds(
          'no-vacuous-assertion',
          `it('a', () => { expect(typeof (x ${operator} y)).toBe('boolean'); });`,
        ),
        ['typeFixed'],
      );
    },
  );
  it('leaves arithmetic untyped: it may be a number or a bigint', () => {
    assert.deepEqual(
      messageIds(
        'no-vacuous-assertion',
        `it('a', () => { expect(typeof (x - y)).toBe('number'); });`,
      ),
      [],
    );
  });
  // INDEX_METHODS: each one finds a position an order check compares.
  each(['indexOf', 'lastIndexOf', 'findIndex', 'search'])(
    'reads r.%s as a position',
    method => {
      assert.deepEqual(
        messageIds(
          'no-vacuous-assertion',
          `it('a', () => { expect(r.${method}('A')).toBeLessThan(r.${method}('B')); });`,
        ),
        ['unguardedOrder'],
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Direct reads: each helper called on the nodes of a parsed fixture
// ---------------------------------------------------------------------------

/** An ESTree node as the helpers see it. */
interface AstNode {
  type: string;
  parent: AstNode | null;
  [key: string]: unknown;
}

interface ProbeContext {
  sourceCode: { getText(node: AstNode): string; ast: { body: AstNode[] } };
}

/**
 * `read(node, context)` for each node `selector` matches in `code`, in the
 * order ESLint visits them. A helper that throws fails the test.
 */
function probe<T>(
  code: string,
  selector: string,
  read: (node: AstNode, context: ProbeContext) => T,
  globals: Record<string, 'readonly'> = {},
): T[] {
  const results: T[] = [];
  const rule = {
    create: (context: ProbeContext) => ({
      [selector]: (node: AstNode) => {
        results.push(read(node, context));
      },
    }),
  };
  const messages = new Linter({ configType: 'flat' }).verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser, globals },
        plugins: { probe: { rules: { read: rule } } },
        rules: { 'probe/read': 'error' },
      },
    ],
    TEST_FILE,
  );
  assert.deepEqual(messages, []);
  return results;
}

/** A node's source text, or null for no node. */
const text = (node: unknown, context: ProbeContext): string | null =>
  node ? context.sourceCode.getText(node as AstNode) : null;

/** The statement-level calls in `code`. */
const STATEMENT_CALL =
  'Program > ExpressionStatement > CallExpression, Program > ExpressionStatement > NewExpression';

/** Each `use(...)` call, whose argument a fixture reads. */
const USE = 'CallExpression[callee.name="use"]';

/** The argument of a `use(...)` call. */
const argument = (node: AstNode): AstNode => (node.arguments as AstNode[])[0]!;

/** The identifier `MARK`, the node a fixture places. */
const MARK = 'Identifier[name="MARK"]';

describe('propertyName', () => {
  it('names a plain or string key, and nothing else', () => {
    const names = probe(
      'class C { #x = 1; m() { return this.#x; } } a.b; a["c"]; a[d]; a[1]; a[`e`];',
      'MemberExpression',
      node => propertyName(node),
    );
    assert.deepEqual(names, [null, 'b', 'c', null, null, null]);
  });
});

describe('calledMethod', () => {
  it('names the method a call calls, through wrappers; never a constructor', () => {
    const names = probe(
      'a.b(); new a.c(); (a.d as F)(); a?.e(); f();',
      'CallExpression, NewExpression',
      node => calledMethod(node),
    );
    assert.deepEqual(names, ['b', null, 'd', 'e', null]);
  });
});

/** What `registration` found for each statement-level call in `code`. */
function registrations(code: string, globals: Record<string, 'readonly'> = {}) {
  return probe(
    code,
    STATEMENT_CALL,
    (node, context) => {
      const found = registration(node, context);
      return (
        found && {
          kind: found.kind,
          name: found.name,
          table: text(found.table, context),
          tableCall: text(found.tableCall, context),
          condition: text(found.condition, context),
          callback: text(found.callback, context),
          title: text(found.title, context),
        }
      );
    },
    globals,
  );
}

const PLAIN = {
  table: null,
  tableCall: null,
  condition: null,
};

describe('registration', () => {
  each([
    [
      `it('t', () => {});`,
      { kind: 'test', name: 'it', ...PLAIN, callback: '() => {}', title: "'t'" },
    ],
    [
      `test('t', function () {});`,
      {
        kind: 'test',
        name: 'test',
        ...PLAIN,
        callback: 'function () {}',
        title: "'t'",
      },
    ],
    [
      `describe('s', () => {});`,
      { kind: 'suite', name: 'describe', ...PLAIN, callback: '() => {}', title: "'s'" },
    ],
    [
      `suite('s', () => {});`,
      { kind: 'suite', name: 'suite', ...PLAIN, callback: '() => {}', title: "'s'" },
    ],
    [
      `beforeEach(() => {});`,
      { kind: 'hook', name: 'beforeEach', ...PLAIN, callback: '() => {}', title: '() => {}' },
    ],
    [
      `afterEach(() => {});`,
      { kind: 'hook', name: 'afterEach', ...PLAIN, callback: '() => {}', title: '() => {}' },
    ],
    [
      `beforeAll(() => {});`,
      { kind: 'hook', name: 'beforeAll', ...PLAIN, callback: '() => {}', title: '() => {}' },
    ],
    [
      `afterAll(() => {});`,
      { kind: 'hook', name: 'afterAll', ...PLAIN, callback: '() => {}', title: '() => {}' },
    ],
    [
      `it.each(rows)('t %s', r => {});`,
      {
        kind: 'test',
        name: 'it',
        table: 'rows',
        tableCall: 'it.each(rows)',
        condition: null,
        callback: 'r => {}',
        title: "'t %s'",
      },
    ],
    [
      `it.for(rows)('t %s', r => {});`,
      {
        kind: 'test',
        name: 'it',
        table: 'rows',
        tableCall: 'it.for(rows)',
        condition: null,
        callback: 'r => {}',
        title: "'t %s'",
      },
    ],
    [
      `it.each()('t', () => {});`,
      {
        kind: 'test',
        name: 'it',
        table: null,
        tableCall: 'it.each()',
        condition: null,
        callback: '() => {}',
        title: "'t'",
      },
    ],
    [
      `it.skipIf(off)('t', () => {});`,
      { kind: 'test', name: 'it', ...PLAIN, condition: 'off', callback: '() => {}', title: "'t'" },
    ],
    [
      `it.runIf(on)('t', () => {});`,
      { kind: 'test', name: 'it', ...PLAIN, condition: 'on', callback: '() => {}', title: "'t'" },
    ],
    [
      `it.skipIf()('t', () => {});`,
      { kind: 'test', name: 'it', ...PLAIN, callback: '() => {}', title: "'t'" },
    ],
    [
      `describe.skip.each(rows)('s %s', r => {});`,
      {
        kind: 'suite',
        name: 'describe',
        table: 'rows',
        tableCall: 'describe.skip.each(rows)',
        condition: null,
        callback: 'r => {}',
        title: "'s %s'",
      },
    ],
    [
      `it.concurrent('t', () => {});`,
      { kind: 'test', name: 'it', ...PLAIN, callback: '() => {}', title: "'t'" },
    ],
    [
      `it('t', () => 1, () => 2);`,
      { kind: 'test', name: 'it', ...PLAIN, callback: '() => 2', title: "'t'" },
    ],
    [`it();`, { kind: 'test', name: 'it', ...PLAIN, callback: null, title: null }],
  ])('reads %s', (code, expected) => {
    assert.deepEqual(registrations(code), [expected]);
  });

  each([
    `afterEach.skip(() => {});`,
    `it.each(rows);`,
    `it.for(rows);`,
    `it.skipIf(off);`,
    `it.runIf(on);`,
    `run('t', () => {});`,
    `this.it('t', () => {});`,
    `new it('t', () => {});`,
    `(() => {})('t');`,
  ])('registers nothing: %s', code => {
    assert.deepEqual(registrations(code), [null]);
  });

  it('reads a local of a runner name as ordinary code', () => {
    assert.deepEqual(
      registrations(
        `const it = makeHarness(); it('t', () => {}); function test() {} test('t', () => {});`,
      ),
      [null, null],
    );
  });

  it('reads the runner imported from a test API, and only from one', () => {
    assert.deepEqual(
      registrations(`import { it } from 'vitest'; it('t', () => {});`).map(
        found => found?.kind,
      ),
      ['test'],
    );
    assert.deepEqual(
      registrations(`import { it } from './harness'; it('t', () => {});`),
      [null],
    );
  });

  it('reads a declared global as the runner', () => {
    assert.deepEqual(
      registrations(`it('t', () => {});`, { it: 'readonly' }).map(
        found => found?.kind,
      ),
      ['test'],
    );
  });
});

describe('ownerOf', () => {
  it('is the registration whose callback the function is', () => {
    const owners = probe(
      `it('t', () => 1, () => 2); (() => 3)(); describe('s', () => 4); run(() => 5); const f = () => 6;`,
      'ArrowFunctionExpression',
      (node, context) => ownerOf(node, context)?.name ?? null,
    );
    assert.deepEqual(owners, [null, 'it', null, 'describe', null, null]);
  });
});

describe('enclosingFunctions and enclosingTest', () => {
  it('lists every enclosing function, innermost first, with its owner', () => {
    const chains = probe(
      `describe('s', () => { it('t', function () { rows.map(r => MARK); }); });`,
      MARK,
      (node, context) =>
        enclosingFunctions(node, context).map(entry => [
          entry.fn.type,
          entry.owner?.name ?? null,
        ]),
    );
    assert.deepEqual(chains, [
      [
        ['ArrowFunctionExpression', null],
        ['FunctionExpression', 'it'],
        ['ArrowFunctionExpression', 'describe'],
      ],
    ]);
  });

  it('finds the nearest test callback, past plain functions and suites', () => {
    const tests = probe(
      `describe('s', () => { it('t', function () { rows.map(r => MARK); }); MARK; });`,
      MARK,
      (node, context) => enclosingTest(node, context)?.type ?? null,
    );
    assert.deepEqual(tests, ['FunctionExpression', null]);
  });
});

/** What `assertion` found for each statement-level call in `code`. */
function assertions(code: string) {
  return probe(code, STATEMENT_CALL, (node, context) => {
    const found = assertion(node, context);
    return (
      found && {
        matcher: found.matcher,
        negated: found.negated,
        subject: text(found.subject, context),
        args: found.args.map((arg: unknown) => text(arg, context)),
      }
    );
  });
}

describe('assertion', () => {
  each([
    [`expect(x).toBe(1);`, { matcher: 'toBe', negated: false, subject: 'x', args: ['1'] }],
    [`expect(x).not.toBe(1);`, { matcher: 'toBe', negated: true, subject: 'x', args: ['1'] }],
    [
      `expect(x).not.not.toBe(1);`,
      { matcher: 'toBe', negated: false, subject: 'x', args: ['1'] },
    ],
    [
      `expect(x).resolves.toBe(1);`,
      { matcher: 'toBe', negated: false, subject: 'x', args: ['1'] },
    ],
    [
      `expect(x).rejects.toThrow();`,
      { matcher: 'toThrow', negated: false, subject: 'x', args: [] },
    ],
    [
      `expect(x).not.resolves.toBe(1);`,
      { matcher: 'toBe', negated: true, subject: 'x', args: ['1'] },
    ],
    [`expect.soft(x).toBe(1);`, { matcher: 'toBe', negated: false, subject: 'x', args: ['1'] }],
    [
      `expect(x as number).toBe(y!);`,
      { matcher: 'toBe', negated: false, subject: 'x', args: ['y'] },
    ],
    [`expect().toBe(1);`, { matcher: 'toBe', negated: false, subject: null, args: ['1'] }],
  ])('reads %s', (code, expected) => {
    assert.deepEqual(assertions(code), [expected]);
  });

  each([
    `expect(x).not(1);`,
    `toBe(1);`,
    `expect(x).foo.toBe(1);`,
    `check(x).toBe(1);`,
    `other.soft(x).toBe(1);`,
    `expect.other(x).toBe(1);`,
    `this.expect(x).toBe(1);`,
    `expect(x)[m](1);`,
  ])('is no assertion: %s', code => {
    assert.deepEqual(assertions(code), [null]);
  });

  it('reads a local named expect as ordinary code', () => {
    assert.deepEqual(
      assertions(`const expect = makeHarness(); expect(x).toBe(1);`),
      [null],
    );
  });
});

describe('isTrueMatcher', () => {
  each([
    [`expect(x).toBe(true);`, true],
    [`expect(x).toEqual(true);`, true],
    [`expect(x).toStrictEqual(true);`, true],
    [`expect(x).toBeTruthy();`, true],
    [`expect(x).not.toBeTruthy();`, false],
    [`expect(x).not.toBe(true);`, false],
    [`expect(x).toBe(false);`, false],
    [`expect(x).toBe(1);`, false],
    [`expect(x).toBe(yes);`, false],
    [`expect(x).toBe();`, false],
    [`expect(x).toContain(true);`, false],
  ])('reads %s as %s', (code, expected) => {
    const found = probe(code, STATEMENT_CALL, (node, context) =>
      isTrueMatcher(assertion(node, context)),
    );
    assert.deepEqual(found, [expected]);
  });
});

describe('constInit', () => {
  it('follows only a single const binding to an identifier', () => {
    const inits = probe(
      `const a = 1 as number; let b = 2; const c = 3; const c = 4; const { d } = o;
      declare const e: number; import f from 'f';
      function g(p: number) { use(p); }
      use(a); use(b); use(c); use(d); use(e); use(f); use(z);
      for (const h of xs) use(h);`,
      USE,
      (node, context) => text(constInit(argument(node), context), context),
    );
    assert.deepEqual(inits, [null, '1', null, null, null, null, null, null, null]);
  });
});

describe('textOf', () => {
  it('keys an expression by its tokens, kept apart', () => {
    const keys = probe(
      'use(typeof x); use(typeofx); use(a  /* c */ + b);',
      USE,
      (node, context) => textOf(argument(node), context),
    );
    assert.deepEqual(keys, ['["typeof","x"]', '["typeofx"]', '["a","+","b"]']);
  });
});

describe('isNumber', () => {
  it('reads a number literal and a negated one', () => {
    const reads = probe(
      `use(0); use(-1); use(1); use(+1); use(-x); use('0'); use(!1);`,
      USE,
      node => [
        isNumber(argument(node), 0),
        isNumber(argument(node), -1),
        isNumber(argument(node), 1),
      ],
    );
    assert.deepEqual(reads, [
      [true, false, false],
      [false, true, false],
      [false, false, true],
      [false, false, false],
      [false, false, false],
      [false, false, false],
      [false, false, false],
    ]);
  });

  it('is false for a missing argument', () => {
    assert.equal(isNumber(undefined, 0), false);
  });
});

describe('inFinally', () => {
  each([
    [`try { a(); } finally { MARK; }`, true],
    [`try { a(); } finally { if (x) { MARK; } }`, true],
    [`function f() { try { a(); } finally { MARK; } }`, true],
    [`try { MARK; } finally { a(); }`, false],
    [`try { a(); } catch { MARK; } finally { b(); }`, false],
    [`try { a(); } finally { const f = () => MARK; }`, false],
    [`MARK;`, false],
  ])('reads %s as %s', (code, expected) => {
    assert.deepEqual(
      probe(code, MARK, node => inFinally(node)),
      [expected],
    );
  });
});

describe('isTeardownCallback', () => {
  each([
    [`afterEach(() => { MARK; });`, true],
    [`afterAll(() => { MARK; });`, true],
    [`onTestFinished(() => { MARK; });`, true],
    [`onTestFailed(() => { MARK; });`, true],
    [`beforeEach(() => { MARK; });`, false],
    [`beforeAll(() => { MARK; });`, false],
    [`it('t', () => { MARK; });`, false],
    [`onTestSkipped(() => { MARK; });`, false],
    [`ctx.onTestFinished(() => { MARK; });`, false],
    [`new onTestFinished(() => { MARK; });`, false],
    [`const f = () => { MARK; };`, false],
  ])('reads the callback in %s as %s', (code, expected) => {
    assert.deepEqual(
      probe(code, MARK, (node, context) =>
        isTeardownCallback(enclosingFunctions(node, context)[0]),
      ),
      [expected],
    );
  });
});

describe('registeringBlock', () => {
  each([
    [`afterEach(() => { MARK; });`, ['Program', null]],
    [
      `describe('s', () => { afterEach(() => { MARK; }); });`,
      ['ArrowFunctionExpression', 'describe'],
    ],
    [
      `describe('s', () => { if (x) { afterEach(() => { MARK; }); } });`,
      ['ArrowFunctionExpression', 'describe'],
    ],
    [`function setup() { afterEach(() => { MARK; }); }`, ['FunctionDeclaration', null]],
  ])('finds the block of the hook in %s', (code, expected) => {
    assert.deepEqual(
      probe(code, MARK, (node, context) => {
        const block = registeringBlock(enclosingFunctions(node, context)[0].fn);
        return [block.type, ownerOf(block, context)?.name ?? null];
      }),
      [expected],
    );
  });
});

describe('within', () => {
  it('holds for the node itself and its ancestors, never for an absent block', () => {
    const reads = probe(
      'function a() { MARK; } function b() {}',
      MARK,
      (node, context) => {
        const [a, b] = context.sourceCode.ast.body;
        return [
          within(node, a),
          within(node, b),
          within(node, node),
          within(node, null),
          within(node, undefined),
        ];
      },
    );
    assert.deepEqual(reads, [[true, false, true, false, false]]);
  });
});
