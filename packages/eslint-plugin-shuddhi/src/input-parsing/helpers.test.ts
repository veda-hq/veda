import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TRANSPARENT,
  chainRoot,
  climb,
  hintFor,
  hintsSchema,
  isIdentifier,
  isMember,
  isNullishOrEmpty,
  isProcessMember,
  readsOf,
  typeNameTail,
  typeServices,
  variableOf,
} from './helpers.js';

/**
 * The readers two or more input-parsing rules share. Node, scope and
 * parser-service shapes are written out by hand: each case is one input on
 * which a reader and a one-token change to it disagree.
 */

interface Node {
  type: string;
  [key: string]: unknown;
}

const id = (name: string): Node => ({ type: 'Identifier', name });
const literal = (value: unknown): Node => ({ type: 'Literal', value });
const member = (object: Node, property: Node, computed = false): Node => ({
  type: 'MemberExpression',
  object,
  property,
  computed,
});

/** `it.each` for node:test: one case per row, titled by its first cell. */
const each = <Row extends readonly unknown[]>(
  rows: readonly Row[],
  title: string,
  run: (...row: Row) => void,
) => {
  for (const row of rows) {
    it(title.replace('%s', String(row[0])), () => run(...row));
  }
};

describe('TRANSPARENT', () => {
  it('names exactly the value-preserving wrappers', () => {
    assert.deepEqual(
      [...TRANSPARENT],
      ['ChainExpression', 'TSNonNullExpression', 'TSSatisfiesExpression'],
    );
  });
});

describe('climb', () => {
  it('climbs through every transparent wrapper to the outermost one', () => {
    const outer: Node = { type: 'CallExpression' };
    const satisfies: Node = { type: 'TSSatisfiesExpression', parent: outer };
    const nonNull: Node = { type: 'TSNonNullExpression', parent: satisfies };
    const chain: Node = { type: 'ChainExpression', parent: nonNull };
    const leaf: Node = { type: 'MemberExpression', parent: chain };
    assert.equal(climb(leaf), satisfies);
  });

  it('stops at a parent that changes the value', () => {
    const leaf: Node = {
      type: 'MemberExpression',
      parent: { type: 'CallExpression' },
    };
    assert.equal(climb(leaf), leaf);
  });

  it('returns a root node itself', () => {
    const root: Node = { type: 'Program' };
    assert.equal(climb(root), root);
  });

  it('climbs through both type assertions', () => {
    const outer: Node = { type: 'CallExpression' };
    const angle: Node = { type: 'TSTypeAssertion', parent: outer };
    const nonNull: Node = { type: 'TSNonNullExpression', parent: angle };
    const as: Node = { type: 'TSAsExpression', parent: nonNull };
    const leaf: Node = { type: 'MemberExpression', parent: as };
    assert.equal(climb(leaf), angle);
  });
});

describe('isIdentifier', () => {
  each(
    [
      ['the named identifier', id('process'), true],
      ['another identifier', id('proc'), false],
      [
        'a non-identifier carrying the name',
        { type: 'Literal', name: 'process' },
        false,
      ],
      ['no node', undefined, false],
    ] as const,
    'reads %s',
    (_name, node, expected) => {
      assert.equal(isIdentifier(node, 'process'), expected);
    },
  );
});

describe('isMember', () => {
  each(
    [
      ['Number.parseInt', member(id('Number'), id('parseInt')), true],
      ['a computed access', member(id('Number'), id('parseInt'), true), false],
      ['another object', member(id('Math'), id('parseInt')), false],
      ['another property', member(id('Number'), id('isNaN')), false],
      [
        'a non-identifier property carrying the name',
        member(id('Number'), { type: 'Literal', name: 'parseInt' }),
        false,
      ],
      [
        'a non-member carrying the fields',
        { ...member(id('Number'), id('parseInt')), type: 'CallExpression' },
        false,
      ],
      ['no node', undefined, false],
    ] as const,
    'reads %s',
    (_name, node, expected) => {
      assert.equal(isMember(node, 'Number', 'parseInt'), expected);
    },
  );
});

describe('isProcessMember', () => {
  const globalProcess = member(id('globalThis'), id('process'));
  each(
    [
      ['process.argv', member(id('process'), id('argv')), true],
      ['globalThis.process.argv', member(globalProcess, id('argv')), true],
      ['a computed access', member(id('process'), id('argv'), true), false],
      ['another property', member(id('process'), id('env')), false],
      [
        'a non-identifier property carrying the name',
        member(id('process'), { type: 'Literal', name: 'argv' }),
        false,
      ],
      ['another object', member(id('proc'), id('argv')), false],
      [
        'a non-member carrying the fields',
        { ...member(id('process'), id('argv')), type: 'CallExpression' },
        false,
      ],
      ['no node', undefined, false],
    ] as const,
    'reads %s',
    (_name, node, expected) => {
      assert.equal(isProcessMember(node, 'argv'), expected);
    },
  );
});

describe('variableOf', () => {
  const outerX = { name: 'x', scope: 'outer' };
  const innerX = { name: 'x', scope: 'inner' };
  const contextFor = (scope: object) => ({
    sourceCode: { getScope: () => scope },
  });
  const outer = { set: new Map([['x', outerX]]), upper: null };

  it('finds the binding in an enclosing scope', () => {
    const scope = { set: new Map(), upper: outer };
    assert.equal(variableOf(contextFor(scope), id('x')), outerX);
  });

  it('prefers the innermost binding', () => {
    const scope = { set: new Map([['x', innerX]]), upper: outer };
    assert.equal(variableOf(contextFor(scope), id('x')), innerX);
  });

  it('returns null for an unbound name', () => {
    assert.equal(variableOf(contextFor(outer), id('y')), null);
  });
});

describe('readsOf', () => {
  it('keeps read references and drops writes', () => {
    const read = { isRead: () => true };
    const write = { isRead: () => false };
    assert.deepEqual(readsOf({ references: [write, read] }), [read]);
  });
});

describe('typeServices', () => {
  const contextWith = (parserServices: unknown) => ({
    sourceCode: { parserServices },
  });
  const program = {
    getTypeChecker: () => ({
      getTypeAtLocation: (tsNode: string) => `type of ${tsNode}`,
    }),
  };
  const map = { get: (node: string) => `ts ${node}` };

  each(
    [
      ['no parser services', undefined],
      ['no program', { program: null, esTreeNodeToTSNodeMap: map }],
      ['no node map', { program }],
    ] as const,
    'returns null with %s',
    (_name, services) => {
      assert.equal(typeServices(contextWith(services)), null);
    },
  );

  it('reads a node type through the node map and the checker', () => {
    const types = typeServices(
      contextWith({ program, esTreeNodeToTSNodeMap: map }),
    );
    assert.equal(types?.typeOf('n'), 'type of ts n');
  });
});

describe('isNullishOrEmpty', () => {
  each(
    [
      ['undefined', id('undefined'), true],
      ['another identifier', id('fallback'), false],
      ['null', literal(null), true],
      ["''", literal(''), true],
      ["'x'", literal('x'), false],
      ['0', literal(0), false],
      [
        'void 0',
        { type: 'UnaryExpression', operator: 'void', argument: literal(0) },
        true,
      ],
      [
        'void x',
        { type: 'UnaryExpression', operator: 'void', argument: id('x') },
        false,
      ],
      [
        '!0',
        { type: 'UnaryExpression', operator: '!', argument: literal(0) },
        false,
      ],
      ['a template', { type: 'TemplateLiteral', value: '' }, false],
    ] as const,
    'reads %s',
    (_name, node, expected) => {
      assert.equal(isNullishOrEmpty(node), expected);
    },
  );
});

describe('chainRoot', () => {
  it('walks calls, members and optional chains to the root', () => {
    const z = id('z');
    const object = member(z, id('object'));
    const built: Node = { type: 'CallExpression', callee: object };
    const strict: Node = {
      type: 'ChainExpression',
      expression: {
        type: 'CallExpression',
        callee: member(built, id('strict')),
      },
    };
    assert.equal(chainRoot(strict), z);
  });

  it('returns a node that is no chain itself', () => {
    const literalNode = literal('x');
    assert.equal(chainRoot(literalNode), literalNode);
  });
});

describe('typeNameTail', () => {
  each(
    [
      ['an identifier', id('Lease'), 'Lease'],
      [
        'a qualified name',
        { type: 'TSQualifiedName', left: id('z'), right: id('ZodType') },
        'ZodType',
      ],
      ['anything else', { type: 'ThisType', right: id('Lease') }, null],
    ] as const,
    'reads %s',
    (_name, node, expected) => {
      assert.equal(typeNameTail(node), expected);
    },
  );
});

describe('hintFor', () => {
  it("reads the message's entry from the merged hints option", () => {
    const context = { options: [{ hints: { a: 'fix a', b: 'fix b' } }] };
    assert.equal(hintFor(context, 'b'), 'fix b');
  });
});

describe('hintsSchema', () => {
  it('allows one string per message id and nothing else', () => {
    assert.deepEqual(hintsSchema(['a', 'b']), {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      additionalProperties: false,
    });
  });
});
