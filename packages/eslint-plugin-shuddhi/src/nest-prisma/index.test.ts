import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SUITE_QUALIFIERS, rules } from './index.js';
import noSelfMockSut from './no-self-mock-sut.js';
import requireOrderbyFindfirst from './require-orderby-findfirst.js';

describe('nest-prisma family entry', () => {
  it('exports every rule under its name', () => {
    assert.deepEqual(Object.keys(rules).sort(), [
      'nest-http-exception',
      'nest-param-pipe',
      'no-raw-sql-interpolation',
      'no-self-mock-sut',
      'no-unbound-test-app',
      'prisma-transaction-multiwrite',
      'require-orderby-findfirst',
    ]);
    assert.equal(rules['no-self-mock-sut'], noSelfMockSut);
    assert.equal(rules['require-orderby-findfirst'], requireOrderbyFindfirst);
  });

  it('exports the default suite qualifiers', () => {
    assert.ok(DEFAULT_SUITE_QUALIFIERS.qualifiers.includes('integration'));
  });
});
