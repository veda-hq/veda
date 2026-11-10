import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_SETTINGS, run } from './cli.ts';
import { findMissing, formatFindings, parseRequirements } from './required-settings.ts';

const REQUIRE = JSON.stringify({ advisorModel: { value: 'fable', why: 'the advisor reviews every session' } });
const BASELINE = new URL('../baselines/claude-settings.json', import.meta.url);

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
  it('reads values, lists and reasons, skipping $schema', () => {
    const text = JSON.stringify({ $schema: 'x', 'env.A': { value: 1, why: 'w' }, b: { value: null, why: 'v' }, 'p.allow': { includes: ['x', { y: 1 }], why: 'u' } });
    assert.deepEqual(parseRequirements(text), [
      { key: 'env.A', kind: 'value', expected: 1, why: 'w' },
      { key: 'b', kind: 'value', expected: null, why: 'v' },
      { key: 'p.allow', kind: 'includes', expected: ['x', { y: 1 }], why: 'u' },
    ]);
  });

  for (const [name, text, message] of [
    ['not JSON', '{', /not JSON/],
    ['an array', '[]', /object of keys/],
    ['an empty list', '{}', /list no key/],
    ['an empty key', JSON.stringify({ '': { value: 1, why: 'w' } }), /not a key/],
    ['an empty path part', JSON.stringify({ 'a..b': { value: 1, why: 'w' } }), /not a key/],
    ['a bare value', JSON.stringify({ a: 'fable' }), /needs \{ "value"/],
    ['neither value nor includes', JSON.stringify({ a: { why: 'w' } }), /needs \{ "value".* or \{ "includes"/],
    ['both value and includes', JSON.stringify({ a: { value: 1, includes: [1], why: 'w' } }), /needs \{ "value"/],
    ['an unknown key', JSON.stringify({ a: { value: 1, why: 'w', note: 'n' } }), /unknown key "note"/],
    ['no why', JSON.stringify({ a: { value: 1 } }), /needs a "why"/],
    ['a blank why', JSON.stringify({ a: { value: 1, why: ' ' } }), /needs a "why"/],
    ['includes that is not a list', JSON.stringify({ a: { includes: 'x', why: 'w' } }), /"includes" must list at least one entry/],
    ['an empty includes', JSON.stringify({ a: { includes: [], why: 'w' } }), /"includes" must list at least one entry/],
  ] as const) {
    it(`refuses ${name}`, () => assert.throws(() => parseRequirements(text), message));
  }
});

describe('findMissing', () => {
  const reqs = parseRequirements(
    JSON.stringify({
      advisorModel: { value: 'fable', why: 'w' },
      'env.X': { value: { a: [1] }, why: 'v' },
      'permissions.deny': { includes: ['Bash(a)', 'Bash(b)'], why: 'd' },
    }),
  );

  it('passes settings that hold every value and every listed entry, among others', () => {
    const settings = { advisorModel: 'fable', env: { X: { a: [1] } }, permissions: { deny: ['Bash(z)', 'Bash(b)', 'Bash(a)'] }, other: 1 };
    assert.deepEqual(findMissing(JSON.stringify(settings), reqs), []);
  });

  it('names a missing key, a different value and the entries a list lacks', () => {
    assert.deepEqual(findMissing(JSON.stringify({ env: { X: { a: [2] } }, permissions: { deny: ['Bash(a)'] } }), reqs), [
      { key: 'advisorModel', kind: 'value', expected: 'fable', why: 'w' },
      { key: 'env.X', kind: 'value', expected: { a: [1] }, found: { a: [2] }, why: 'v' },
      { key: 'permissions.deny', kind: 'includes', expected: ['Bash(b)'], found: ['Bash(a)'], why: 'd' },
    ]);
  });

  it('treats a path through a non-object as missing, and a list key that is no list as wrong', () => {
    assert.deepEqual(findMissing(JSON.stringify({ advisorModel: 'fable', env: 'flat', permissions: { deny: 'Bash(a)' } }), reqs), [
      { key: 'env.X', kind: 'value', expected: { a: [1] }, why: 'v' },
      { key: 'permissions.deny', kind: 'includes', expected: ['Bash(a)', 'Bash(b)'], found: 'Bash(a)', why: 'd' },
    ]);
    assert.deepEqual(findMissing(JSON.stringify({ advisorModel: 'fable', env: { X: { a: [1] } } }), reqs), [
      { key: 'permissions.deny', kind: 'includes', expected: ['Bash(a)', 'Bash(b)'], why: 'd' },
    ]);
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
        { key: 'a', kind: 'value', expected: 'fable', why: 'w' },
        { key: 'b', kind: 'value', expected: 1, found: 2, why: 'v' },
        { key: 'c', kind: 'includes', expected: ['x', 'y'], found: ['z'], why: 'u' },
        { key: 'd', kind: 'includes', expected: ['x'], why: 't' },
        { key: 'e', kind: 'includes', expected: ['x'], found: 'x', why: 's' },
      ],
      5,
      's.json',
      'r.json',
    );
    assert.equal(result.ok, false);
    const tail = 'Put it back; to change the requirement, edit r.json.';
    assert.deepEqual(result.err, [
      `pariksha required-settings: s.json: "a" is missing; it must be "fable" (w). ${tail}`,
      `pariksha required-settings: s.json: "b" holds 2; it must be 1 (v). ${tail}`,
      `pariksha required-settings: s.json: "c" lacks "x", "y" (u). ${tail}`,
      `pariksha required-settings: s.json: "d" is missing; it must be a list holding "x" (t). ${tail}`,
      `pariksha required-settings: s.json: "e" holds "x", not a list; it must be a list holding "x" (s). ${tail}`,
    ]);
  });
});

describe('baselines/claude-settings.json', () => {
  const baseline = parseRequirements(readFileSync(BASELINE, 'utf8'));

  const allow = [
    'Edit(./**)', 'Write(./**)', 'NotebookEdit(./**)',
    'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git branch:*)', 'Bash(git ls-remote:*)', 'Bash(git worktree list:*)',
    'Bash(gh pr view:*)', 'Bash(gh pr list:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr comment:*)', 'Bash(gh run view:*)', 'Bash(gh run list:*)', 'Bash(gh issue list:*)',
    'Bash(git push -u origin:*)', 'Bash(gh pr create --draft:*)', 'Bash(gh pr ready:*)',
    'mcp__ccd_pr__bind_pr', 'mcp__ccd_pr__get_status', 'mcp__ccd_pr__set_monitor',
    'mcp__Claude_Browser__get_page_text', 'mcp__Claude_Browser__tabs_context', 'mcp__claude-code-remote__send_message',
  ];
  const deny = ['Bash(*--no-verify*)'];
  const ask = [
    'Bash(*git push*--force*)', 'Bash(*git push* -f*)', 'Bash(*git push*--for*)', 'Bash(*git push*--mi*)',
    'Bash(*git push*--de*)', 'Bash(*git push*--pru*)', 'Bash(*git push* -d *)', 'Bash(*git push* +*)', 'Bash(*git push* :*)',
    'Bash(*git branch* -D*)',
    'Bash(pnpm add:*)', 'Bash(pnpm remove:*)', 'Bash(pnpm update:*)',
    'Bash(npm install:*)', 'Bash(npm uninstall:*)', 'Bash(npm update:*)', 'Bash(yarn add:*)', 'Bash(yarn remove:*)',
  ];

  it('holds the permission baseline every agent repository keeps', () => {
    assert.deepEqual(
      baseline.map((r) => [r.key, r.kind, r.expected]),
      [
        ['permissions.allow', 'includes', allow],
        ['permissions.deny', 'includes', deny],
        ['permissions.ask', 'includes', ask],
      ],
    );
  });

  it('refuses settings with any baseline entry removed', () => {
    const full = { permissions: { allow, deny, ask } };
    assert.deepEqual(findMissing(JSON.stringify(full), baseline), []);
    for (const list of ['allow', 'deny', 'ask'] as const) {
      const emptied = { permissions: { ...full.permissions, [list]: [] } };
      assert.equal(findMissing(JSON.stringify(emptied), baseline)[0]?.key, `permissions.${list}`);
      full.permissions[list].forEach((rule, at) => {
        const dropped = { permissions: { ...full.permissions, [list]: full.permissions[list].filter((_, i) => i !== at) } };
        assert.equal(findMissing(JSON.stringify(dropped), baseline)[0]?.key, `permissions.${list}`, `${rule} dropped`);
      });
    }
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
