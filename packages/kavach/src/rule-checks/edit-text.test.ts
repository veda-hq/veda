/**
 * The text a Write or Edit proposes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { afterEdit } from './edit-text.ts';

describe('afterEdit', () => {
  it("is a Write's content, or empty for none", () => {
    assert.equal(afterEdit('Write', { content: 'new' }, 'old'), 'new');
    assert.equal(afterEdit('Write', {}, 'old'), '');
  });

  it('applies an Edit once, or everywhere with replace_all', () => {
    const given = { old_string: 'x', new_string: 'y' };
    assert.equal(afterEdit('Edit', given, 'x x'), 'y x');
    assert.equal(afterEdit('Edit', { ...given, replace_all: true }, 'x x'), 'y y');
    assert.equal(afterEdit('Edit', { old_string: 'x', new_string: '$&$&' }, 'x'), '$&$&');
  });

  it('judges new text beside the file when the old text is not in it', () => {
    assert.equal(afterEdit('Edit', { old_string: 'z', new_string: 'y' }, 'x'), 'x\ny');
    assert.equal(afterEdit('Edit', { old_string: '', new_string: 'y' }, 'x'), 'x\ny');
    assert.equal(afterEdit('Edit', { old_string: 'x', new_string: 'y' }, null), '\ny');
    assert.equal(afterEdit('Edit', {}, 'x'), 'x\n');
  });
});
