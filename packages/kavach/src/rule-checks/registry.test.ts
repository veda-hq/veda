/**
 * The rule registry: its shape, the count, loading a file, and the count CLI.
 * The registry here is a fake one; a consumer's real registry is its own.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

import { scratchDirs } from './fixture.test.ts';
import {
  count,
  DEFAULT_OWNER,
  isEnforced,
  loadRegistry,
  main,
  parseRegistry,
  REGISTRY_ENV,
  renderCount,
  type Rule,
  STDIO,
} from './registry.ts';

/** A table of cases, each row typed as its own tuple. */
const rows = <const T extends readonly (readonly unknown[])[]>(table: T): T => table;

/** `run` throws an Error whose message contains `expected`. */
function throwsWith(run: () => unknown, expected: string): void {
  assert.throws(run, (error: unknown) => error instanceof Error && error.message.includes(expected));
}

const { scratch, cleanup } = scratchDirs('rule-registry-');
afterEach(cleanup);

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'H-01',
    title: 'Resolve review threads only after fixes are pushed',
    notes: ['never-sync-threads-before-pushing-fixes'],
    origin: 'work 12',
    enforcer: null,
    ...overrides,
  };
}
function registry(rules: unknown[] = [row()]): Record<string, unknown> {
  return { owner: 'the release manager', rules };
}

describe('parseRegistry', () => {
  it('returns a valid registry as written', () => {
    const enforced = row({
      id: 'U-00',
      origin: 'the push gate',
      enforcer: { pr: 7, files: ['.githooks/pre-push'] },
    });
    assert.deepEqual(parseRegistry(registry([row(), enforced])), {
      owner: 'the release manager',
      rules: [row(), enforced],
    });
  });

  it('leaves out an owner and an origin that are not given, and ignores other keys', () => {
    const { origin: _origin, ...bare } = row();
    assert.deepEqual(parseRegistry({ rules: [{ ...bare, slice: 'x' }], work: 'y' }), {
      rules: [bare],
    });
  });

  for (const [name, value, expected] of rows([
    ['not an object', null, 'registry: expected an object'],
    ['a list', [], 'registry: expected an object'],
    ['an empty owner', { owner: ' ', rules: [] }, 'registry.owner: expected a non-empty string'],
    ['an owner that is not text', { owner: 7, rules: [] }, 'registry.owner: expected a non-empty string'],
    ['rules missing', {}, 'registry.rules: expected a list'],
    ['rules not a list', { rules: {} }, 'registry.rules: expected a list'],
  ])) {
    it(`refuses a registry that is ${name}`, () => {
      throwsWith(() => parseRegistry(value), expected);
    });
  }

  for (const [name, item, expected] of rows([
    ['a row that is not an object', 'H-01', 'registry.rules[0]: expected an object'],
    ['a malformed id', row({ id: 'H-1' }), 'registry.rules[0].id'],
    ['an id with a suffix', row({ id: 'H-011' }), 'registry.rules[0].id'],
    ['an id with a prefix', row({ id: 'XH-01' }), 'registry.rules[0].id'],
    ['an empty title', row({ title: '  ' }), 'registry.rules[0].title: expected a non-empty string'],
    ['a title that is not text', row({ title: 7 }), 'registry.rules[0].title'],
    ['no notes', row({ notes: [] }), 'registry.rules[0].notes: expected a non-empty list'],
    ['notes not a list', row({ notes: 'a-note' }), 'registry.rules[0].notes: expected a non-empty list'],
    ['a note that is not a slug', row({ notes: ['Not A Slug'] }), 'registry.rules[0].notes[0]'],
    ['a note with a trailing dash', row({ notes: ['note-'] }), 'registry.rules[0].notes[0]'],
    ['an empty origin', row({ origin: '' }), 'registry.rules[0].origin: expected a non-empty string'],
    ['an origin that is not text', row({ origin: 12 }), 'registry.rules[0].origin: expected a non-empty string'],
    ['a missing enforcer', row({ enforcer: undefined }), 'registry.rules[0].enforcer: expected an object'],
    ['an enforcer that is not an object', row({ enforcer: 'x' }), 'registry.rules[0].enforcer: expected an object'],
    [
      'an enforcer without a PR',
      row({ enforcer: { files: ['a.ts'] } }),
      'registry.rules[0].enforcer.pr: expected a positive integer',
    ],
    ['a zero PR', row({ enforcer: { pr: 0, files: ['a.ts'] } }), 'registry.rules[0].enforcer.pr'],
    ['a fractional PR', row({ enforcer: { pr: 1.5, files: ['a.ts'] } }), 'registry.rules[0].enforcer.pr'],
    [
      'no enforcer files',
      row({ enforcer: { pr: 1, files: [] } }),
      'registry.rules[0].enforcer.files: expected a non-empty list',
    ],
    [
      'an absolute enforcer file',
      row({ enforcer: { pr: 1, files: ['/etc/hosts'] } }),
      'registry.rules[0].enforcer.files[0]',
    ],
    [
      'an enforcer file above the checkout',
      row({ enforcer: { pr: 1, files: ['../x.ts'] } }),
      'registry.rules[0].enforcer.files[0]',
    ],
    [
      'an enforcer file through a parent folder',
      row({ enforcer: { pr: 1, files: ['a/../../x.ts'] } }),
      'registry.rules[0].enforcer.files[0]',
    ],
    [
      'an enforcer file with a space',
      row({ enforcer: { pr: 1, files: ['a b.ts'] } }),
      'registry.rules[0].enforcer.files[0]',
    ],
  ])) {
    it(`refuses ${name}`, () => {
      throwsWith(() => parseRegistry(registry([item])), expected);
    });
  }

  it('accepts dotted names that are not parent folders', () => {
    const files = ['.githooks/pre-push', 'a/..b/c.ts', 'a/b..c'];
    assert.deepEqual(parseRegistry(registry([row({ enforcer: { pr: 1, files } })])).rules[0]?.enforcer, {
      pr: 1,
      files,
    });
  });

  it('refuses an id listed twice', () => {
    throwsWith(() => parseRegistry(registry([row(), row()])), 'registry.rules[1].id: H-01 is listed twice');
  });

  it('names the offending value and shape', () => {
    throwsWith(
      () => parseRegistry(registry([row({ id: 'h-01' })])),
      'registry.rules[0].id: "h-01" does not match /^[A-Z]-\\d{2}$/',
    );
  });
});

describe('loadRegistry', () => {
  it('reads and validates a registry file', () => {
    const path = join(scratch(), 'registry.json');
    writeFileSync(path, JSON.stringify(registry()));
    assert.deepEqual(loadRegistry(path), parseRegistry(registry()));
    writeFileSync(path, JSON.stringify({ rules: 'x' }));
    throwsWith(() => loadRegistry(path), 'registry.rules: expected a list');
    assert.equal(DEFAULT_OWNER, 'the repository owner');
  });
});

describe('count', () => {
  const rules = (enforcer: Rule['enforcer']): Rule => ({
    id: 'H-01',
    title: 'T',
    notes: ['n'],
    origin: 'work 12',
    enforcer,
  });

  it('counts a rule enforced only when every enforcer file exists', () => {
    const root = scratch();
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'a', 'one.ts'), '');
    writeFileSync(join(root, 'two.ts'), '');
    assert.equal(isEnforced(rules(null), root), false);
    assert.equal(isEnforced(rules({ pr: 1, files: ['a/one.ts', 'two.ts'] }), root), true);
    assert.equal(isEnforced(rules({ pr: 1, files: ['a/one.ts', 'gone.ts'] }), root), false);
    assert.equal(isEnforced(rules({ pr: 1, files: ['a', 'two.ts'] }), root), false);
  });

  it('lists the unenforced rules and the total', () => {
    const root = scratch();
    writeFileSync(join(root, 'there.ts'), '');
    const open: Rule = { ...rules(null), id: 'H-02', title: 'Open rule', origin: 'work 13' };
    const { origin: _origin, ...bare } = { ...open, id: 'H-03', title: 'Bare rule' };
    const done = rules({ pr: 9, files: ['there.ts'] });
    const result = count({ rules: [done, open, bare] }, root);
    assert.deepEqual(result, { total: 3, unenforced: [open, bare] });
    assert.equal(
      renderCount(result),
      '2 of 3 checkable memory rules unenforced\n  H-02  Open rule  (work 13)\n  H-03  Bare rule',
    );
  });
});

describe('main', () => {
  /** A checkout holding `registry.json` with one enforced and one open rule. */
  function checkout(): string {
    const root = scratch();
    writeFileSync(join(root, 'there.ts'), '');
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify(registry([row({ enforcer: { pr: 1, files: ['there.ts'] } }), row({ id: 'H-02' })])),
    );
    return root;
  }
  function capture(): { io: { out: (l: string) => void; err: (l: string) => void }; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
  }

  it('prints the count of the registry named, in the checkout named', () => {
    const root = checkout();
    const c = capture();
    assert.equal(main(['--registry', 'registry.json'], c.io, root, {}), 0);
    assert.deepEqual(c.out, [renderCount(count(loadRegistry(join(root, 'registry.json')), root))]);
    assert.deepEqual(c.out, ['1 of 2 checkable memory rules unenforced\n  H-02  Resolve review threads only after fixes are pushed  (work 12)']);
    const elsewhere = capture();
    assert.equal(main(['--registry', join(root, 'registry.json'), '--root', scratch()], elsewhere.io, root, {}), 0);
    assert.match(elsewhere.out[0] ?? '', /^2 of 2 /);
  });

  it('prints JSON with --json, the registry taken from the environment', () => {
    const root = checkout();
    const c = capture();
    assert.equal(main(['--json'], c.io, root, { [REGISTRY_ENV]: 'registry.json' }), 0);
    assert.deepEqual(JSON.parse(c.out[0] ?? ''), { total: 2, unenforced: ['H-02'] });
  });

  for (const [name, argv, env, expected] of rows([
    ['no registry', [], {}, 'count: no registry: pass --registry or set KAVACH_RULE_REGISTRY'],
    ['an empty registry variable', [], { [REGISTRY_ENV]: '' }, 'count: no registry'],
    ['a registry option with no value', ['--registry'], {}, 'count: --registry needs a value'],
    ['an unknown argument', ['--registry', 'registry.json', '--all'], {}, 'count: unknown argument "--all"'],
    ['a registry that does not load', ['--registry', 'missing.json'], {}, 'count: ENOENT'],
  ])) {
    it(`exits 2 with the usage on ${name}`, () => {
      const c = capture();
      assert.equal(main(argv, c.io, checkout(), env), 2);
      assert.equal(c.out.length, 0);
      assert.ok(c.err[0]?.startsWith(expected), c.err[0]);
      assert.equal(c.err[1], 'usage: count --registry <json> [--root <dir>] [--json]');
    });
  }

  it('reports a registry that is not JSON', () => {
    const c = capture();
    const path = join(scratch(), 'registry.json');
    writeFileSync(path, 'not json');
    assert.equal(main(['--registry', path], c.io, '/', {}), 2);
    assert.match(c.err[0] ?? '', /^count: .*JSON/);
  });

  it('writes CLI lines to standard output and standard error', () => {
    const out = mock.method(process.stdout, 'write', () => true);
    const err = mock.method(process.stderr, 'write', () => true);
    try {
      STDIO.out('one line');
      STDIO.err('two line');
      assert.deepEqual(
        out.mock.calls.map((call) => call.arguments),
        [['one line\n']],
      );
      assert.deepEqual(
        err.mock.calls.map((call) => call.arguments),
        [['two line\n']],
      );
    } finally {
      out.mock.restore();
      err.mock.restore();
    }
  });
});
