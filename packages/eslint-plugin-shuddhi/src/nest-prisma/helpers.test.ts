import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import {
  NO_BINDINGS,
  PRISMA_MULTI_ROW,
  PRISMA_WRITES,
  bindings,
  enclosingFunction,
  insideTransaction,
  isPrismaRoot,
  isUndefined,
  memberName,
  prismaCall,
  prismaDelegate,
  property,
  propertyName,
  spreadObject,
  trackDelegateAlias,
  trackValue,
  unwrap,
  valueResolver,
} from './helpers.js';

/** An ESTree node as the helpers see it: loosely typed, as ESLint hands it. */
type Node = { type: string };
type Visitors = Record<string, (node: never) => void>;

/**
 * Lints `code` as TypeScript with a probe rule whose visitors `make` builds
 * from the rule context, and returns what the visitors recorded.
 */
function probe(
  code: string,
  make: (context: never, out: unknown[]) => Visitors,
): unknown[] {
  const out: unknown[] = [];
  const messages = new Linter({ configType: 'flat' }).verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
        },
        plugins: {
          probe: {
            rules: {
              probe: { meta: { schema: [] }, create: (context: never) => make(context, out) },
            },
          } as never,
        },
        rules: { 'probe/probe': 'error' },
      },
    ],
    { filename: 'probe.ts' },
  );
  assert.deepEqual(messages, []);
  return out;
}

/** What `fn` returns for the expression of each top-level statement. */
function eachExpression(code: string, fn: (expression: never) => unknown): unknown[] {
  return probe(code, (_context, out) => ({
    'Program > ExpressionStatement'(node: { expression: never }) {
      out.push(fn(node.expression));
    },
  }));
}

/** The type of a node, or the value itself when it is not a node. */
const typeOf = (value: unknown) =>
  value !== null && typeof value === 'object' ? (value as Node).type : value;

describe('the Prisma method sets', () => {
  it('lists every write, and only the multi-row methods as multi-row', () => {
    assert.deepEqual(
      [...PRISMA_WRITES],
      ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'],
    );
    assert.deepEqual(
      [...PRISMA_MULTI_ROW],
      ['findFirst', 'findMany', 'updateMany', 'deleteMany', 'count', 'aggregate', 'groupBy'],
    );
  });
});

describe('unwrap', () => {
  it('reads through every type-only wrapper and optional chain', () => {
    assert.deepEqual(
      eachExpression('x as T;\nx satisfies T;\nx!;\n<T>x;\n(x as T)!;\na?.b;\nx;', node =>
        typeOf(unwrap(node)),
      ),
      ['Identifier', 'Identifier', 'Identifier', 'Identifier', 'Identifier', 'MemberExpression', 'Identifier'],
    );
  });

  it('passes no node through as it is', () => {
    assert.equal(unwrap(undefined), undefined);
    assert.equal(unwrap(null), null);
  });
});

describe('memberName', () => {
  it('reads dotted, literal and plain-template keys alike', () => {
    assert.deepEqual(
      eachExpression("a.b;\na['b'];\na[`b`];\na[`${x}`];\na[name];\na[1];\nf();", memberName),
      ['b', 'b', 'b', null, null, null, null],
    );
  });

  it('has no name for a private field or no node', () => {
    assert.deepEqual(
      probe('class C { #p = 1; m() { this.#p; } }', (_context, out) => ({
        MemberExpression(node: never) {
          out.push(memberName(node));
        },
      })),
      [null],
    );
    assert.equal(memberName(undefined), null);
  });
});

describe('isUndefined', () => {
  it('is true for undefined and void, under wrappers too', () => {
    assert.deepEqual(
      eachExpression('undefined;\nvoid 0;\n(undefined as never);\nnull;\nx;\n-1;', isUndefined),
      [true, true, true, false, false, false],
    );
    assert.equal(isUndefined(undefined), false);
  });
});

describe('enclosingFunction', () => {
  it('finds the nearest function of every kind, or none at the top level', () => {
    assert.deepEqual(
      probe(
        'function a() { x(); }\nconst b = function () { x(); };\nconst c = () => { x(); };\nx();\nclass D { m() { x(); } }',
        (_context, out) => ({
          CallExpression(node: never) {
            out.push(typeOf(enclosingFunction(node)));
          },
        }),
      ),
      ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', null, 'FunctionExpression'],
    );
  });
});

describe('insideTransaction', () => {
  const code = [
    'prisma.$transaction(async tx => { tx.a.create(); });',
    "prisma['$transaction'](async tx => { tx.a.create(); });",
    'withClaim(prisma, async tx => { tx.a.create(); });',
    'retry(async () => { prisma.a.create(); });',
    'prisma.a.create();',
  ].join('\n');
  /** For each `.create()` call: is it inside a transaction? */
  const judged = (wrappers?: Set<string>) =>
    probe(code, (_context, out) => ({
      'CallExpression[callee.property.name="create"]'(node: never) {
        out.push(wrappers === undefined ? insideTransaction(node) : insideTransaction(node, wrappers));
      },
    }));

  it('sees $transaction in either spelling, and no wrapper by default', () => {
    assert.deepEqual(judged(), [true, true, false, false, false]);
  });

  it('sees a named wrapper as a transaction', () => {
    assert.deepEqual(judged(new Set(['withClaim'])), [true, true, true, false, false]);
  });
});

describe('isPrismaRoot', () => {
  it('accepts the client by name, on this, and from a call named for it', () => {
    assert.deepEqual(
      eachExpression(
        [
          'prisma;',
          'db;',
          'tx;',
          'trx;',
          'transaction;',
          '_prismaClient;',
          'cache;',
          'this.prisma;',
          'this.prismaService;',
          'this.cache;',
          'this[key];',
          'holder.prisma;',
          'getPrismaClient();',
          'this.getPrisma();',
          'repository();',
          '(prisma as Client);',
          '"prisma";',
        ].join('\n'),
        isPrismaRoot,
      ),
      [true, true, true, true, true, true, false, true, true, false, false, false, true, true, false, true, false],
    );
  });
});

describe('prismaDelegate', () => {
  it('names a delegate of the client, never a $ member or another root', () => {
    assert.deepEqual(
      eachExpression(
        "prisma.product;\nthis.prisma['order'];\nprisma.$metrics;\ncache.product;\nprisma[key];\nprisma;",
        prismaDelegate,
      ),
      ['product', 'order', null, null, null, null],
    );
    assert.equal(prismaDelegate(undefined), null);
  });
});

describe('bindings', () => {
  it('binds a declaration per variable, never a reassigned one or a pattern', () => {
    const code = [
      'const a = 1;',
      'let b = 2;',
      'b = 3;',
      'const [c] = [4];',
      'function f() { const a = 5; a; }',
      'a;',
      'b;',
      'c;',
      'undeclared;',
      'a.b;',
    ].join('\n');
    const out = probe(code, (context, out) => {
      const values = bindings(context);
      const reads: never[] = [];
      return {
        VariableDeclarator(node: { id: never; init: never }) {
          values.bind(node.id, node.init);
        },
        'Program > ExpressionStatement'(node: { expression: never }) {
          reads.push(node.expression);
        },
        'FunctionDeclaration ExpressionStatement'(node: { expression: never }) {
          out.push(['inner', (values.lookup(node.expression) as { value: number }).value]);
        },
        'Program:exit'() {
          for (const read of reads) {
            const bound = values.lookup(read) as { value?: number } | undefined;
            out.push(bound === undefined ? undefined : bound.value);
          }
        },
      };
    });
    // The inner `a` is its own binding. At the top level the assignment
    // `b = 3` is no identifier, `a` reads 1, then nothing for the reassigned
    // `b`, the pattern, the undeclared name and a member.
    assert.deepEqual(out, [['inner', 5], undefined, 1, undefined, undefined, undefined, undefined]);
  });

  it('has a stand-in that holds nothing', () => {
    assert.equal(NO_BINDINGS.lookup(), undefined);
  });
});

describe('prismaCall and trackDelegateAlias', () => {
  it('reads inline calls and calls through a delegate alias', () => {
    const code = [
      'const products = this.prisma.product;',
      'const other = cache.entry;',
      'let later;',
      'products.findMany();',
      "this.prisma['order']['create']();",
      '(prisma as Client).user.count();',
      'other.findMany();',
      'cache.entry.create();',
      'prisma.$transaction();',
      'run();',
      'prisma.user[method]();',
    ].join('\n');
    const out = probe(code, (context, out) => {
      const aliases = bindings(context);
      const calls: never[] = [];
      return {
        VariableDeclarator(node: never) {
          trackDelegateAlias(aliases, node);
        },
        CallExpression(node: never) {
          calls.push(node);
        },
        'Program:exit'() {
          for (const call of calls) out.push(prismaCall(call, aliases));
        },
      };
    });
    assert.deepEqual(out, [
      { delegate: 'product', method: 'findMany' },
      { delegate: 'order', method: 'create' },
      { delegate: 'user', method: 'count' },
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('reads no alias by default, and no call from a non-call', () => {
    assert.deepEqual(
      eachExpression('prisma.user.findMany();\nproducts.findMany();\nprisma.user;', node =>
        prismaCall(node),
      ),
      [{ delegate: 'user', method: 'findMany' }, null, null],
    );
  });
});

describe('propertyName and property', () => {
  it('names identifier, literal and literal-computed keys, not value-computed ones', () => {
    assert.deepEqual(
      probe("({ a: 1, 'b': 2, ['c']: 3, [k]: 4, 5: 6 });", (_context, out) => ({
        Property(node: never) {
          out.push(propertyName(node));
        },
      })),
      ['a', 'b', 'c', null, 5],
    );
  });

  it('finds a top-level property by name, past spreads, or null', () => {
    assert.deepEqual(
      eachExpression("({ ...rest, where: 1, 'select': 2 });", node => [
        typeOf(property(node, 'where')),
        typeOf(property(node, 'select')),
        property(node, 'orderBy'),
      ]),
      [['Property', 'Property', null]],
    );
  });
});

describe('valueResolver, trackValue and spreadObject', () => {
  const code = [
    'const base = { a: 1 };',
    'const alias = base;',
    'const loop1 = loop2;',
    'const loop2 = loop1;',
    'let none;',
    'let changed = { b: 2 };',
    'changed = {};',
    'const [p] = [{}];',
    'function f(param) { return param; }',
    '({ ...{ c: 3 }, ...base, ...alias, ...(alias as T), ...param, ...changed, ...none, ...make(), ...p });',
    'alias;',
    'loop1;',
    'none;',
    'f;',
  ].join('\n');

  it('follows consts to the object a spread holds, and nothing else', () => {
    const out = probe(code, (context, out) => {
      const values = bindings(context);
      const resolve = valueResolver(values);
      const spreads: never[] = [];
      return {
        VariableDeclarator(node: never) {
          trackValue(values, node);
        },
        SpreadElement(node: never) {
          spreads.push(node);
        },
        'Program:exit'() {
          for (const spread of spreads) out.push(typeOf(spreadObject(spread, resolve)));
        },
      };
    });
    assert.deepEqual(out, [
      'ObjectExpression',
      'ObjectExpression',
      'ObjectExpression',
      'ObjectExpression',
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('resolves chains, stops on a cycle and keeps an unbound name', () => {
    const out = probe(code, (context, out) => {
      const values = bindings(context);
      const resolve = valueResolver(values);
      const reads: never[] = [];
      return {
        VariableDeclarator(node: never) {
          trackValue(values, node);
        },
        'Program > ExpressionStatement'(node: { expression: never }) {
          reads.push(node.expression);
        },
        'Program:exit'() {
          // Past `changed = {}` and the spread object: the bare names.
          for (const read of reads.slice(2)) {
            const value = resolve(read) as { type: string; name?: string } | null;
            out.push(value === null ? null : value.name ?? value.type);
          }
        },
      };
    });
    // `alias` → base's object; the loop ends on the first name it meets
    // twice; `let none;` bound null; `f` is a function declaration, not a
    // declarator, so stays itself.
    assert.deepEqual(out, ['ObjectExpression', 'loop2', null, 'f']);
  });
});
