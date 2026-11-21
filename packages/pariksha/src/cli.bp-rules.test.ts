// bp-rules through the command line: the corpus and index the settings
// name, each mode's output written as it is, and a regenerated index that
// round-trips byte for byte.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { CONFIGURABLE, consoleIo, run, type Io } from './cli.ts';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const SETTINGS = { rules: 'docs/bp', index: 'docs/BP.md', idPrefix: 'BP' };
const RULE = ['---', 'id: BP-SEC-001', 'title: Pin every action', 'category: security', 'severity: high', 'enforcement: validator', 'enforcement_script: scripts/pin.sh', 'verify_by: 2026-12-01', '---', '', 'Pin each action to a commit.', ''].join('\n');
const INDEX = ['# Rules', '', '## Security (0 rules)', '', '| ID | Rule | Severity | Enforcement |', '| --- | --- | --- | --- |', ''].join('\n');

/** A git repository holding `files`, outside any other, so its own `.pariksha.json` is the one read. */
const repo = (files: Record<string, string>): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-cli-bp-rules-')));
  temps.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, timeout: 30_000, killSignal: 'SIGKILL' });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

const corpus = (extra: Record<string, string> = {}): string => repo({ 'docs/bp/security/BP-SEC-001.md': RULE, 'docs/BP.md': INDEX, '.pariksha.json': JSON.stringify({ checks: { 'bp-rules': SETTINGS } }), ...extra });

/** An Io that keeps what is written raw, stream by stream, and the lines out and err get. */
const capture = (cwd: string, raw = true) => {
  const out: string[] = [];
  const err: string[] = [];
  const written = { out: '', err: '' };
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), cwd: () => cwd, bp: { now: () => new Date('2026-11-21T00:00:00Z') }, ...(raw ? { write: (stream: 'out' | 'err', text: string) => (written[stream] += text) } : {}) };
  return { io, out, err, written };
};

describe('run bp-rules', () => {
  it('is configurable from .pariksha.json', () => {
    assert.ok(CONFIGURABLE.includes('bp-rules'));
  });

  it('prints the inventory of the corpus the entry names, as JSON', () => {
    const root = corpus();
    const c = capture(root);
    assert.equal(run(['bp-rules', '--inventory', '--root', root], c.io, '1.0.0', {}), 0);
    const inventory = JSON.parse(c.written.out) as { total: number; byTier: Record<string, number>; rules: { id: string; path: string }[] };
    assert.equal(inventory.total, 1);
    assert.deepEqual(inventory.byTier, { 'eslint-rule': 0, validator: 1, guidance: 0 });
    assert.deepEqual(
      inventory.rules.map((r) => [r.id, r.path]),
      [['BP-SEC-001', 'docs/bp/security/BP-SEC-001.md']],
    );
    assert.equal(c.written.out, `${JSON.stringify(inventory, null, 2)}\n`);
    assert.equal(c.written.err, '');
  });

  it('regenerates the index raw, so writing it back round-trips byte for byte and checks clean', () => {
    const root = corpus();
    const regenerated = capture(root);
    assert.equal(run(['bp-rules', '--regenerate-index', '--root', root], regenerated.io, '1.0.0', {}), 0);
    const text = regenerated.written.out;
    assert.ok(text.includes('| BP-SEC-001 | [Pin every action](./bp/security/BP-SEC-001.md) | high | validator |'), text);
    assert.ok(text.includes('## Security (1 rule)'), text);
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n\n'), JSON.stringify(text.slice(-8)));
    // The stale index fails the check, saying how to recompute it.
    const stale = capture(root);
    assert.equal(run(['bp-rules', '--check-index', '--root', root], stale.io, '1.0.0', {}), 1);
    assert.match(stale.written.err, /BP\.md Summary is stale .* pariksha bp-rules --regenerate-index > \.tmp\/BP\.md && mv \.tmp\/BP\.md docs\/BP\.md\n$/);
    writeFileSync(join(root, 'docs/BP.md'), text);
    const again = capture(root);
    assert.equal(run(['bp-rules', '--regenerate-index', '--root', root], again.io, '1.0.0', {}), 0);
    assert.equal(again.written.out, text);
    assert.equal(readFileSync(join(root, 'docs/BP.md'), 'utf8'), text);
    const clean = capture(root);
    assert.equal(run(['bp-rules', '--check-index', '--root', root], clean.io, '1.0.0', {}), 0);
  });

  it('checks wiring against files under the root', () => {
    const root = corpus();
    const missing = capture(root);
    assert.equal(run(['bp-rules', '--check-wiring', '--root', root], missing.io, '1.0.0', {}), 1);
    assert.deepEqual((JSON.parse(missing.written.out) as { missing: unknown }).missing, [{ id: 'BP-SEC-001', enforcement_script: 'scripts/pin.sh' }]);
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/pin.sh'), '#!/bin/sh\n');
    const wired = capture(root);
    assert.equal(run(['bp-rules', '--check-wiring', '--ids', 'BP-SEC-001', '--root', root], wired.io, '1.0.0', {}), 0);
  });

  it('judges --due against the clock it is given, and --next-id from the corpus', () => {
    const root = corpus();
    const due = capture(root);
    assert.equal(run(['bp-rules', '--due', '--root', root], due.io, '1.0.0', {}), 0);
    assert.equal((JSON.parse(due.written.out) as { today: string; approachingCount: number }).today, '2026-11-21');
    const next = capture(root);
    assert.equal(run(['bp-rules', '--next-id', 'SEC', '--root', root], next.io, '1.0.0', {}), 0);
    assert.equal((JSON.parse(next.written.out) as { nextId: string }).nextId, 'BP-SEC-002');
  });

  it('reads a settings file named with --config', () => {
    const root = corpus({ 'bp.json': JSON.stringify({ ...SETTINGS, idPrefix: 'XR' }) });
    const c = capture(root);
    assert.equal(run(['bp-rules', '--next-id', 'SEC', '--config', 'bp.json', '--root', root], c.io, '1.0.0', {}), 0);
    assert.equal((JSON.parse(c.written.out) as { nextId: string }).nextId, 'XR-SEC-001');
  });

  it('writes through out and err a line at a time when the Io writes no raw text', () => {
    const root = corpus();
    const c = capture(root, false);
    assert.equal(run(['bp-rules', '--check-index', '--root', root], c.io, '1.0.0', {}), 1);
    // The JSON a line per entry, and stderr's leading blank line kept.
    assert.equal(c.out[0], '{');
    assert.equal(c.out.at(-1), '}');
    assert.equal(c.err[0], '');
    assert.match(c.err[1] as string, /^❌ BP\.md Summary is stale/);
    assert.equal(c.err.length, 2);
  });

  it('exits 2 with no settings, settings it cannot read, bad ones, or a usage error', () => {
    const bare = repo({});
    const none = capture(bare);
    assert.equal(run(['bp-rules', '--inventory', '--root', bare], none.io, '1.0.0', {}), 2);
    assert.deepEqual(none.err, ['pariksha bp-rules: no settings: name a settings file with --config or set checks.bp-rules in .pariksha.json; nothing was checked, so this is not a pass']);
    const missing = capture(bare);
    assert.equal(run(['bp-rules', '--inventory', '--config', 'nowhere.json', '--root', bare], missing.io, '1.0.0', {}), 2);
    assert.match(missing.err[0] as string, /^pariksha bp-rules: ENOENT.*; nothing was checked, so this is not a pass$/);
    const badRoot = repo({ '.pariksha.json': JSON.stringify({ checks: { 'bp-rules': { rules: 'docs' } } }) });
    const bad = capture(badRoot);
    assert.equal(run(['bp-rules', '--inventory', '--root', badRoot], bad.io, '1.0.0', {}), 2);
    assert.match(bad.written.err, /^pariksha bp-rules: /);
    const root = corpus();
    const twoModes = capture(root);
    assert.equal(run(['bp-rules', '--inventory', '--gaps', '--root', root], twoModes.io, '1.0.0', {}), 2);
    assert.match(twoModes.written.err, /^pariksha bp-rules: give exactly one mode, got --inventory --gaps\nusage: pariksha bp-rules /);
    // A flag no mode takes is the parser's: the whole usage.
    const unknown = capture(root);
    assert.equal(run(['bp-rules', '--inventry', '--root', root], unknown.io, '1.0.0', {}), 2);
    assert.equal(unknown.err.length, 1);
    assert.match(unknown.err[0] as string, /^usage: /);
  });

  it('reads the disk and the clock itself when the Io gives neither', () => {
    const root = corpus();
    const out: string[] = [];
    let written = '';
    const io: Io = { out: (l) => out.push(l), err: () => undefined, cwd: () => root, write: (_stream, text) => (written += text) };
    assert.equal(run(['bp-rules', '--due', '--root', root], io, '1.0.0', {}), 0);
    assert.equal((JSON.parse(written) as { today: string }).today, new Date().toISOString().slice(0, 10));
  });
});

describe('consoleIo.write', () => {
  it('writes the text to the stream as it is, adding no line ending', (t) => {
    const stdout = t.mock.method(process.stdout, 'write', () => true);
    const stderr = t.mock.method(process.stderr, 'write', () => true);
    consoleIo.write?.('out', 'a\nb');
    consoleIo.write?.('err', '\nc\n');
    assert.deepEqual(
      stdout.mock.calls.map((call) => call.arguments),
      [['a\nb']],
    );
    assert.deepEqual(
      stderr.mock.calls.map((call) => call.arguments),
      [['\nc\n']],
    );
  });
});
