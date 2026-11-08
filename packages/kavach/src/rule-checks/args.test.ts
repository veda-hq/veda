import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { onlyKnown, option } from './args.ts';

describe('option', () => {
  it('reads the value after the option, undefined without it', () => {
    assert.equal(option(['--root', '/r', '--json'], '--root'), '/r');
    assert.equal(option(['--json'], '--root'), undefined);
  });

  it('refuses an option with no value, or an option where its value should be', () => {
    assert.throws(() => option(['--root'], '--root'), { message: '--root needs a value' });
    assert.throws(() => option(['--root', '--json'], '--root'), { message: '--root needs a value' });
  });
});

describe('onlyKnown', () => {
  it('passes known options with their values, and known flags', () => {
    assert.doesNotThrow(() => onlyKnown(['--root', '--json', '--json'], ['--root'], ['--json']));
    assert.doesNotThrow(() => onlyKnown([], ['--root']));
  });

  it('refuses anything else', () => {
    assert.throws(() => onlyKnown(['--rot', 'x'], ['--root']), { message: 'unknown argument "--rot"' });
    assert.throws(() => onlyKnown(['--json'], ['--root']), { message: 'unknown argument "--json"' });
  });
});
