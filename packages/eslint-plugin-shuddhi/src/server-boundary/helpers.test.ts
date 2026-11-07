import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  contractsLabel,
  CONTRACTS_PACKAGE_SCHEMA,
  decoratorName,
  decoratorNames,
  DEFAULT_CONTRACTS_LABEL,
  keyName,
  packagePattern,
} from './helpers.js';

/**
 * The ESTree readers the server-boundary rules share. Node shapes are written
 * out by hand: each case is one input on which a reader and a one-token
 * change to it disagree.
 */

const id = (name: string) => ({ type: 'Identifier', name });
const call = (callee: object) => ({ type: 'CallExpression', callee });
const member = (property: object) => ({
  type: 'MemberExpression',
  object: id('cv'),
  property,
});

describe('decoratorName', () => {
  for (const [name, expression, expected] of [
    ['a called identifier', call(id('IsString')), 'IsString'],
    ['a bare identifier', id('Type'), 'Type'],
    ['a called member', call(member(id('IsString'))), 'IsString'],
    ['a bare member', member(id('IsInt')), 'IsInt'],
  ] as const) {
    it(`names ${name}`, () => {
      assert.equal(decoratorName({ expression }), expected);
    });
  }

  for (const [name, expression] of [
    ['a computed member', call(member({ type: 'Literal', value: 'x' }))],
    ['a call of a call', call(call(id('factory')))],
    ['a literal', { type: 'Literal', value: 'IsString' }],
  ] as const) {
    it(`returns null for ${name}`, () => {
      assert.equal(decoratorName({ expression }), null);
    });
  }
});

describe('decoratorNames', () => {
  it('collects every named decorator and skips unnamed ones', () => {
    const names: Set<string> = decoratorNames({
      decorators: [
        { expression: call(id('IsString')) },
        { expression: call(call(id('factory'))) },
        { expression: call(member(id('IsNotEmpty'))) },
      ],
    });
    assert.deepEqual([...names], ['IsString', 'IsNotEmpty']);
  });

  it('reads a node with no decorators as none', () => {
    assert.equal(decoratorNames({}).size, 0);
  });
});

describe('keyName', () => {
  for (const [name, key, expected] of [
    ['an identifier', id('sku_id'), 'sku_id'],
    ['a string literal', { type: 'Literal', value: 'sku_id' }, 'sku_id'],
  ] as const) {
    it(`reads ${name}`, () => {
      assert.equal(keyName(key), expected);
    });
  }

  for (const [name, key] of [
    ['no key', undefined],
    ['a null key', null],
    ['a numeric literal', { type: 'Literal', value: 7 }],
    ['a computed expression', { type: 'MemberExpression', name: 'k' }],
  ] as const) {
    it(`returns null for ${name}`, () => {
      assert.equal(keyName(key), null);
    });
  }
});

describe('contractsLabel', () => {
  it('names the configured package', () => {
    assert.equal(
      contractsLabel({ contractsPackage: '@acme/shared' }),
      '@acme/shared',
    );
  });

  it('describes the package when no option names it', () => {
    assert.equal(contractsLabel(undefined), DEFAULT_CONTRACTS_LABEL);
    assert.equal(contractsLabel({}), DEFAULT_CONTRACTS_LABEL);
    assert.equal(DEFAULT_CONTRACTS_LABEL, 'the shared contracts package');
  });

  it('validates the option as a non-empty string', () => {
    assert.deepEqual(CONTRACTS_PACKAGE_SCHEMA, {
      type: 'string',
      minLength: 1,
    });
  });
});

describe('packagePattern', () => {
  const pattern = packagePattern('@acme/shared');

  for (const specifier of ['@acme/shared', '@acme/shared/access']) {
    it(`matches ${specifier}`, () => {
      assert.equal(pattern.test(specifier), true);
    });
  }

  for (const specifier of [
    '@acme/shared-ui',
    '@acme/sharedx',
    'x/@acme/shared',
    '@acmexshared',
  ]) {
    it(`does not match ${specifier}`, () => {
      assert.equal(pattern.test(specifier), false);
    });
  }

  it('escapes regular-expression characters in the specifier', () => {
    assert.equal(packagePattern('a.b').test('axb'), false);
    assert.equal(packagePattern('a.b').test('a.b/c'), true);
  });
});
