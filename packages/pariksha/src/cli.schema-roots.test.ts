// The CLI of schema-roots: which files it reads, what it prints, and its exit codes.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run, splitFiles } from './cli.ts';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A folder with these files written; its real path. */
const tree = (files: Record<string, string>): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-cli-schema-')));
  temps.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

const run0 = (args: string[], stdin?: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, { out: (l) => out.push(l), err: (l) => err.push(l), ...(stdin === undefined ? {} : { stdin: () => stdin }) }, '0');
  assert.equal(typeof code, 'number');
  return { code: code as number, out, err };
};

const BAD = JSON.stringify({ tools: [{ name: 'verdict', input_schema: { oneOf: [{ type: 'object' }] } }] });
const GOOD = JSON.stringify({ tools: [{ name: 'verdict', input_schema: { type: 'object' } }] });
const FIX = 'The API rejects tool and output schemas with oneOf, allOf or anyOf at the root; express the condition in code after the call returns.';

describe('run schema-roots', () => {
  it('refuses a named file with a combinator at a schema root, and passes a clean one', () => {
    const root = tree({ 'agents/bad.json': BAD, 'agents/good.json': GOOD });
    const bad = run0(['schema-roots', '--root', root, 'agents/bad.json', 'agents/good.json']);
    assert.deepEqual(bad, { code: 1, out: [], err: [`pariksha schema-roots: agents/bad.json: $.tools[0].input_schema: top-level oneOf. ${FIX}`] });
    const good = run0(['schema-roots', '--root', root, 'agents/good.json']);
    assert.deepEqual(good, { code: 0, out: ['pariksha schema-roots: 1 JSON file(s), no tool or output schema with oneOf, allOf or anyOf at its root'], err: [] });
  });

  it('reads the --files-from list, from stdin, with the named files, each once', () => {
    const root = tree({ 'a.json': BAD, 'b.json': GOOD, 'notes.md': 'not read' });
    const r = run0(['schema-roots', 'b.json', '--root', root, '--files-from', '-', './a.json'], 'a.json\nnotes.md\n\nb.json\n');
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, [`pariksha schema-roots: a.json: $.tools[0].input_schema: top-level oneOf. ${FIX}`]);
  });

  it('reads a list file, and an absolute path', () => {
    const root = tree({ 'schemas/verdict.schema.json': '{"anyOf": []}', 'list.txt': 'schemas/verdict.schema.json\n' });
    assert.equal(run0(['schema-roots', '--root', root, '--files-from', join(root, 'list.txt')]).err[0]?.startsWith('pariksha schema-roots: schemas/verdict.schema.json: $: top-level anyOf. '), true);
    assert.equal(run0(['schema-roots', '--root', root, join(root, 'schemas/verdict.schema.json')]).code, 1);
  });

  it('passes when no JSON file is named', () => {
    assert.deepEqual(run0(['schema-roots']), { code: 0, out: ['pariksha schema-roots: 0 JSON file(s), no tool or output schema with oneOf, allOf or anyOf at its root'], err: [] });
    assert.equal(run0(['schema-roots', 'config.yaml', '--files-from', '-'], '').code, 0);
  });

  it('exits 2 naming the file it cannot parse or read, printing no finding', () => {
    const root = tree({ 'broken.json': '{ "tools": [', 'bad.json': BAD });
    const broken = run0(['schema-roots', '--root', root, 'bad.json', 'broken.json', 'missing.json']);
    assert.equal(broken.code, 2);
    assert.deepEqual(broken.out, []);
    assert.equal(broken.err.length, 1);
    assert.match(broken.err[0] ?? '', /^pariksha schema-roots: broken\.json: not JSON: .*; nothing was checked, so this is not a pass$/);
    const missing = run0(['schema-roots', '--root', root, 'bad.json', 'missing.json']);
    assert.equal(missing.code, 2);
    assert.match(missing.err[0] ?? '', /^pariksha schema-roots: missing\.json: ENOENT.*; nothing was checked, so this is not a pass$/);
  });

  it('exits 2 on a list it cannot read', () => {
    const r = run0(['schema-roots', '--files-from', join(tree({}), 'nowhere.txt')]);
    assert.equal(r.code, 2);
    assert.match(r.err[0] ?? '', /^pariksha schema-roots: ENOENT.*; nothing was checked, so this is not a pass$/);
  });

  it('refuses an unknown, repeated or valueless flag with the usage', () => {
    for (const args of [['--config', 'x.json'], ['--root', '.', '--root', '.'], ['--files-from']]) {
      const r = run0(['schema-roots', ...args]);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.err[0] ?? '', /^usage: /);
      assert.ok(r.err[0]?.includes('pariksha schema-roots [--files-from <file>|-] [--root <dir>] [<file>...]'));
    }
  });
});

describe('splitFiles', () => {
  it('takes each --flag with the word after it, and the rest as files', () => {
    assert.deepEqual(splitFiles(['a.json', '--root', 'r', 'b.json', '--files-from', '-', 'c.json', '--x']), { flagArgs: ['--root', 'r', '--files-from', '-', '--x'], files: ['a.json', 'b.json', 'c.json'] });
  });
});
