import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_SETTINGS, run } from './cli.ts';
import { findMissing, formatFindings, parseRequirements } from './required-settings.ts';

const REQUIRE = JSON.stringify({ advisorModel: { value: 'fable', why: 'the advisor reviews every session' } });

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

/** A folder holding these files. */
const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-required-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

describe('parseRequirements', () => {
  it('reads keys, values and reasons, skipping $schema', () => {
    assert.deepEqual(parseRequirements(JSON.stringify({ $schema: 'x', 'env.A': { value: 1, why: 'w' }, b: { value: null, why: 'v' } })), [
      { key: 'env.A', value: 1, why: 'w' },
      { key: 'b', value: null, why: 'v' },
    ]);
  });

  for (const [name, text, message] of [
    ['not JSON', '{', /not JSON/],
    ['an array', '[]', /object of keys/],
    ['an empty list', '{}', /list no key/],
    ['an empty key', JSON.stringify({ '': { value: 1, why: 'w' } }), /not a key/],
    ['an empty path part', JSON.stringify({ 'a..b': { value: 1, why: 'w' } }), /not a key/],
    ['a bare value', JSON.stringify({ a: 'fable' }), /needs \{ "value"/],
    ['no value', JSON.stringify({ a: { why: 'w' } }), /needs \{ "value"/],
    ['an unknown key', JSON.stringify({ a: { value: 1, why: 'w', note: 'n' } }), /unknown key "note"/],
    ['no why', JSON.stringify({ a: { value: 1 } }), /needs a "why"/],
    ['a blank why', JSON.stringify({ a: { value: 1, why: ' ' } }), /needs a "why"/],
  ] as const) {
    it(`refuses ${name}`, () => assert.throws(() => parseRequirements(text), message));
  }
});

describe('findMissing', () => {
  const reqs = parseRequirements(JSON.stringify({ advisorModel: { value: 'fable', why: 'w' }, 'env.X': { value: { a: [1] }, why: 'v' } }));

  it('passes settings that hold every value, nested ones compared as JSON', () => {
    assert.deepEqual(findMissing(JSON.stringify({ advisorModel: 'fable', env: { X: { a: [1] } }, other: 1 }), reqs), []);
  });

  it('names a missing key and a different value', () => {
    assert.deepEqual(findMissing(JSON.stringify({ env: { X: { a: [2] } } }), reqs), [
      { key: 'advisorModel', expected: 'fable', why: 'w' },
      { key: 'env.X', expected: { a: [1] }, found: { a: [2] }, why: 'v' },
    ]);
  });

  it('treats a path through a non-object as missing', () => {
    assert.deepEqual(findMissing(JSON.stringify({ advisorModel: 'fable', env: 'flat' }), reqs), [{ key: 'env.X', expected: { a: [1] }, why: 'v' }]);
  });

  it('refuses settings that are not a JSON object', () => {
    assert.throws(() => findMissing('{', reqs), /settings are not JSON/);
    assert.throws(() => findMissing('[]', reqs), /must hold an object/);
  });
});

describe('formatFindings', () => {
  it('says how to fix each finding', () => {
    const result = formatFindings(
      [
        { key: 'a', expected: 'fable', why: 'w' },
        { key: 'b', expected: 1, found: 2, why: 'v' },
      ],
      2,
      's.json',
      'r.json',
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.err, [
      'pariksha required-settings: s.json: "a" is missing; it must be "fable" (w). Put it back; to change the requirement, edit r.json.',
      'pariksha required-settings: s.json: "b" holds 2; it must be 1 (v). Put it back; to change the requirement, edit r.json.',
    ]);
  });
});

describe('run required-settings', () => {
  it('passes settings that carry the value, reading .claude/settings.json by default', () => {
    const c = capture();
    const root = tree({ 'req.json': REQUIRE, [DEFAULT_SETTINGS]: JSON.stringify({ advisorModel: 'fable' }) });
    assert.equal(run(['required-settings', '--require', 'req.json', '--root', root], c.io, '0.1.0'), 0);
    assert.deepEqual(c.out, ['pariksha required-settings: .claude/settings.json carries all 1 required settings (req.json)']);
    assert.deepEqual(c.err, []);
  });

  it('refuses settings with the line removed', () => {
    const c = capture();
    const root = tree({ 'req.json': REQUIRE, 'other.json': JSON.stringify({ model: 'opus' }) });
    assert.equal(run(['required-settings', '--require', 'req.json', '--settings', 'other.json', '--root', root], c.io, '0.1.0'), 1);
    assert.match(c.err[0] ?? '', /other\.json: "advisorModel" is missing; it must be "fable" \(the advisor reviews every session\)/);
  });

  it('refuses a missing settings file and settings that are not JSON', () => {
    const missing = capture();
    const root = tree({ 'req.json': REQUIRE, 'bad.json': '{' });
    assert.equal(run(['required-settings', '--require', 'req.json', '--root', root], missing.io, '0.1.0'), 1);
    assert.match(missing.err[0] ?? '', /cannot read the settings/);
    const bad = capture();
    assert.equal(run(['required-settings', '--require', 'req.json', '--settings', 'bad.json', '--root', root], bad.io, '0.1.0'), 1);
    assert.match(bad.err[0] ?? '', /bad\.json: the settings are not JSON/);
  });

  it('exits 2 without --require, or with a requirements file it cannot read or parse', () => {
    const root = tree({ 'bad.json': '{}' });
    const none = capture();
    assert.equal(run(['required-settings', '--root', root], none.io, '0.1.0'), 2);
    assert.match(none.err[0] ?? '', /^usage:/);
    const unread = capture();
    assert.equal(run(['required-settings', '--require', 'nope.json', '--root', root], unread.io, '0.1.0'), 2);
    assert.match(unread.err[0] ?? '', /cannot read the requirements .*not a pass/);
    const empty = capture();
    assert.equal(run(['required-settings', '--require', 'bad.json', '--root', root], empty.io, '0.1.0'), 2);
    assert.match(empty.err[0] ?? '', /bad\.json: the requirements list no key; nothing was checked/);
  });
});
