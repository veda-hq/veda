import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import compareAndSet, * as compareAndSetModule from './compare-and-set.js';
import dtoFieldConstraints, * as dtoFieldConstraintsModule from './dto-field-constraints.js';
import dtoImplementsContract from './dto-implements-contract.js';
import * as helpers from './helpers.js';
import * as entry from './index.js';
import {
  decoratorName,
  readCapabilityVocabulary,
  regressingCursorColumns,
  rules,
  zodChain,
} from './index.js';
import nestBodyDto from './nest-body-dto.js';
import noCapabilityLiteral, * as noCapabilityLiteralModule from './no-capability-literal.js';
import noLocalApiContract from './no-local-api-contract.js';

/**
 * The family entry. Each rule's behaviour is pinned by the suite beside its
 * module; this suite pins what the entry adds: the rule ids and the
 * re-exports a workspace config reads.
 */

describe('server-boundary entry', () => {
  it('registers each rule module under its id', () => {
    assert.deepEqual(Object.keys(rules), [
      'nest-body-dto',
      'dto-field-constraints',
      'no-local-api-contract',
      'dto-implements-contract',
      'no-capability-literal',
      'compare-and-set',
    ]);
    assert.equal(rules['nest-body-dto'], nestBodyDto);
    assert.equal(rules['dto-field-constraints'], dtoFieldConstraints);
    assert.equal(rules['no-local-api-contract'], noLocalApiContract);
    assert.equal(rules['dto-implements-contract'], dtoImplementsContract);
    assert.equal(rules['no-capability-literal'], noCapabilityLiteral);
    assert.equal(rules['compare-and-set'], compareAndSet);
  });

  it('re-exports the helpers its callers import', () => {
    assert.equal(decoratorName, helpers.decoratorName);
    assert.equal(zodChain, dtoFieldConstraintsModule.zodChain);
    assert.equal(
      readCapabilityVocabulary,
      noCapabilityLiteralModule.readCapabilityVocabulary,
    );
    assert.equal(
      regressingCursorColumns,
      compareAndSetModule.regressingCursorColumns,
    );
  });

  it('exports nothing else', () => {
    assert.deepEqual(Object.keys(entry).sort(), [
      'decoratorName',
      'readCapabilityVocabulary',
      'regressingCursorColumns',
      'rules',
      'zodChain',
    ]);
  });
});
