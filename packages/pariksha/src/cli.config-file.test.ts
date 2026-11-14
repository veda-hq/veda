// `.pariksha.json`: one committed file holds every check's settings, found
// from the working directory and never from --root.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { CONFIGURABLE, run } from './cli.ts';
import { formatReport } from './doc-references-gate.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

const repo = (files: Record<string, string>): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-cfg-')));
  git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  git(root, 'add', '-A');
  return root;
};

const capture = (cwd: string) => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: () => cwd }, out, err };
};

/** A tracked note with a machine-local path; absolute-paths refuses it unless its include leaves notes/ out. */
const NOTE = { 'notes/a.md': 'see /Users/someone/x\n', 'docs/b.md': 'clean\n' };
const ONLY_DOCS = { include: '^docs/' };

describe('.pariksha.json', () => {
  it('lists the checks it can configure', () => {
    assert.ok(CONFIGURABLE.includes('absolute-paths') && CONFIGURABLE.includes('doc-budgets') && CONFIGURABLE.includes('authority-citations'));
    assert.ok(!CONFIGURABLE.includes('boundary') && !CONFIGURABLE.includes('export-deletions'));
  });

  it('applies an inline entry; without one the check runs on its defaults', () => {
    const bare = repo(NOTE);
    assert.equal(run(['absolute-paths', '--root', bare], capture(bare).io, '1.0.0', {}), 1);
    const root = repo({ ...NOTE, '.pariksha.json': JSON.stringify({ checks: { 'absolute-paths': ONLY_DOCS } }) });
    assert.equal(run(['absolute-paths', '--root', root], capture(root).io, '1.0.0', {}), 0);
  });

  it('reads a file entry from the config file’s folder, run from any folder of the checkout', () => {
    const root = repo({ ...NOTE, 'cfg/abs.json': JSON.stringify(ONLY_DOCS), '.pariksha.json': '{"checks": {"absolute-paths": "cfg/abs.json"}}', 'sub/dir/x': '' });
    assert.equal(run(['absolute-paths', '--root', root], capture(join(root, 'sub/dir')).io, '1.0.0', {}), 0);
  });

  it('is found from the working directory, never from --root (an index snapshot)', () => {
    const root = repo({ ...NOTE, '.pariksha.json': JSON.stringify({ checks: { 'absolute-paths': ONLY_DOCS } }) });
    // The snapshot holds the same documents and no config file: the checkout's settings still apply.
    const snapshot = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-snap-')));
    cpSync(join(root, 'notes'), join(snapshot, 'notes'), { recursive: true });
    cpSync(join(root, 'docs'), join(snapshot, 'docs'), { recursive: true });
    const files = 'notes/a.md\ndocs/b.md\n';
    assert.equal(run(['absolute-paths', '--root', snapshot, '--files-from', '-'], { ...capture(root).io, stdin: () => files }, '1.0.0', {}), 0);
    // A config file inside the snapshot is not read: here it would pass, the checkout's has none, so it refuses.
    const plain = repo(NOTE);
    writeFileSync(join(snapshot, '.pariksha.json'), JSON.stringify({ checks: { 'absolute-paths': ONLY_DOCS } }));
    assert.equal(run(['absolute-paths', '--root', snapshot, '--files-from', '-'], { ...capture(plain).io, stdin: () => files }, '1.0.0', {}), 1);
  });

  it('gives way to --config on the command line', () => {
    const root = repo({ ...NOTE, 'all.json': '{"include": "\\\\.md$"}', '.pariksha.json': JSON.stringify({ checks: { 'absolute-paths': ONLY_DOCS } }) });
    assert.equal(run(['absolute-paths', '--root', root, '--config', 'all.json'], capture(root).io, '1.0.0', {}), 1);
  });

  it('reads the file PARIKSHA_CONFIG names, and refuses one that is missing', () => {
    const root = repo({ ...NOTE, 'ci/p.json': JSON.stringify({ checks: { 'absolute-paths': ONLY_DOCS } }) });
    assert.equal(run(['absolute-paths', '--root', root], capture(root).io, '1.0.0', { PARIKSHA_CONFIG: 'ci/p.json' }), 0);
    const c = capture(root);
    assert.equal(run(['absolute-paths'], c.io, '1.0.0', { PARIKSHA_CONFIG: 'ci/none.json' }), 2);
    assert.match(c.err[0] ?? '', /^pariksha absolute-paths: cannot read .*ci\/none\.json \(PARIKSHA_CONFIG\) \(pariksha 1\.0\.0\).*nothing was checked, so this is not a pass$/);
  });

  it('refuses an unknown key or check, naming it and the version', () => {
    const key = capture(repo({ '.pariksha.json': '{"check": {}}' }));
    assert.equal(run(['absolute-paths'], key.io, '4.5.6', {}), 2);
    assert.match(key.err[0] ?? '', /\(pariksha 4\.5\.6\): unknown key "check"/);
    const check = capture(repo({ '.pariksha.json': '{"checks": {"boundary": {}}}' }));
    assert.equal(run(['absolute-paths'], check.io, '4.5.6', {}), 2);
    assert.match(check.err[0] ?? '', /\(pariksha 4\.5\.6\): unknown check "boundary"/);
  });

  it('is not read by a check that takes no settings', () => {
    const root = repo({ '.pariksha.json': '{', '.veda/deny.sha256': '' });
    assert.equal(run(['boundary', '--root', root], capture(root).io, '1.0.0', {}), 0);
  });

  it('stops when a file entry names no file', () => {
    const root = repo({ ...NOTE, '.pariksha.json': '{"checks": {"absolute-paths": "gone.json"}}' });
    const c = capture(root);
    assert.equal(run(['absolute-paths'], c.io, '1.0.0', {}), 2);
    assert.match(c.err[0] ?? '', /ENOENT.*gone\.json.*nothing was checked/);
  });

  it('judges every file when the selection changes the check’s own settings, and only then', () => {
    const MD = JSON.stringify({ include: '\\.md$' });
    const committed = (files: Record<string, string>): string => {
      const root = repo(files);
      git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
      return root;
    };
    const staged = (root: string, path: string, body: string): number => {
      writeFileSync(join(root, path), body);
      git(root, 'add', path);
      return run(['absolute-paths', '--root', root, '--staged'], capture(root).io, '1.0.0', {}) as number;
    };
    // A file entry: an edit elsewhere in .pariksha.json leaves its run to the staged files.
    const fileEntry = committed({ ...NOTE, 'cfg/abs.json': MD, '.pariksha.json': '{"checks": {"absolute-paths": "cfg/abs.json"}}' });
    assert.equal(staged(fileEntry, '.pariksha.json', '{"checks": {"absolute-paths": "cfg/abs.json", "flaky-tests": "cfg/abs.json"}}\n'), 0);
    // Its own file changed: every tracked document, the old note too.
    assert.equal(staged(fileEntry, 'cfg/abs.json', `${MD}\n`), 1);
    // An inline entry's settings are .pariksha.json itself.
    const inline = committed({ ...NOTE, '.pariksha.json': JSON.stringify({ checks: { 'absolute-paths': { include: '\\.md$' } } }) });
    assert.equal(staged(inline, '.pariksha.json', JSON.stringify({ checks: { 'absolute-paths': { include: '\\.mdx?$' } } })), 1);
  });

  it('names an inline entry by the config file in a check’s own messages', () => {
    const entry = { vitest: { configs: ['apps/a/vitest.config.mjs'], requiredExcludes: ['**/*.test.ts'] } };
    const root = repo({ 'x.md': '', '.pariksha.json': JSON.stringify({ checks: { 'coverage-exemptions': entry } }) });
    const c = capture(root);
    assert.equal(run(['coverage-exemptions', '--root', root], c.io, '1.0.0', {}), 2);
    assert.match(c.err[0] ?? '', /apps\/a\/vitest\.config\.mjs named in \.pariksha\.json \(checks\.coverage-exemptions\) but not a file/);
  });
});

describe('.pariksha.json for flag-only checks', () => {
  const RULE = '# r\n\n## Sizes\n\n| Doc | Budget |\n| --- | --: |\n| `a.md` | 5 |\n| `rule.md` | 500 |\n';

  it('sets doc-budgets’ table and section, and a flag on the command line wins', () => {
    const root = repo({ 'rule.md': RULE, 'other.md': RULE.replace('| 5 |', '| 1 |'), 'a.md': 'abc', '.pariksha.json': JSON.stringify({ checks: { 'doc-budgets': { table: 'rule.md', section: 'Sizes' } } }) });
    assert.equal(run(['doc-budgets', '--root', root], capture(root).io, '1.0.0', {}), 0);
    assert.equal(run(['doc-budgets', '--root', root, '--table', 'other.md'], capture(root).io, '1.0.0', {}), 1);
  });

  it('reads doc-budgets’ table from the config file’s folder, not from --root', () => {
    const root = repo({ 'rule.md': RULE, '.pariksha.json': JSON.stringify({ checks: { 'doc-budgets': { table: 'rule.md', section: 'Sizes' } } }) });
    // A snapshot of the documents alone: the table stays the checkout's.
    const snapshot = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-snap-')));
    writeFileSync(join(snapshot, 'a.md'), 'abcdefgh');
    writeFileSync(join(snapshot, 'rule.md'), '');
    const c = capture(root);
    assert.equal(run(['doc-budgets', '--root', snapshot], c.io, '1.0.0', {}), 1);
    assert.match([...c.out, ...c.err].join('\n'), /a\.md/);
  });

  it('sets authority-citations’ authorities from a list, read from a file entry', () => {
    const files = { 'docs/a.md': 'Offers are read from the website, approved by Dana.\n' };
    const without = repo(files);
    assert.equal(run(['authority-citations', '--mode', 'tree', '--root', without], capture(without).io, '1.0.0', {}), 0);
    const root = repo({ ...files, 'cfg/auth.json': JSON.stringify({ authority: ['Dana'], issuePrefix: ['ATH'], adrDir: 'docs/adr' }), '.pariksha.json': '{"checks": {"authority-citations": "cfg/auth.json"}}' });
    assert.equal(run(['authority-citations', '--mode', 'tree', '--root', root], capture(root).io, '1.0.0', {}), 1);
  });

  it('refuses an unknown field or a wrongly typed one', () => {
    for (const [entry, message] of [
      [{ tabel: 'x' }, /checks\.doc-budgets: unknown field "tabel" \(pariksha 1\.0\.0\); doc-budgets reads table, section/],
      [{ table: ['x'] }, /checks\.doc-budgets\.table must be a string \(pariksha 1\.0\.0\)/],
      [{ table: '' }, /checks\.doc-budgets\.table must be a string/],
    ] as const) {
      const c = capture(repo({ '.pariksha.json': JSON.stringify({ checks: { 'doc-budgets': entry } }) }));
      assert.equal(run(['doc-budgets'], c.io, '1.0.0', {}), 2);
      assert.match(c.err[0] ?? '', message);
    }
    const c = capture(repo({ '.pariksha.json': JSON.stringify({ checks: { 'authority-citations': { authority: [1] } } }) }));
    assert.equal(run(['authority-citations'], c.io, '1.0.0', {}), 2);
    assert.match(c.err[0] ?? '', /checks\.authority-citations\.authority must be a string or a list of strings/);
  });
});

describe('doc-references’ baseline hint', () => {
  it('drops --config when the settings come from .pariksha.json', () => {
    const report = { failures: [], slack: [{ file: 'a.md', check: 'DOC-DRIFT-01', baseline: 2, actual: 1 }], growth: [], changed: [], checked: ['a.md'], problems: [], exitCode: 0 };
    const config = { baseline: 'b.json', exemptWord: 'ok', skipped: [] };
    const options = { config, mode: { kind: 'all' }, checks: ['DOC-DRIFT-01'] } as unknown as Parameters<typeof formatReport>[1];
    const asReport = report as unknown as Parameters<typeof formatReport>[0];
    assert.match(formatReport(asReport, options, undefined).out[0] ?? '', /lower it: pariksha doc-references --all --update-baseline$/);
    assert.match(formatReport(asReport, options, 'd.json').out[0] ?? '', /lower it: pariksha doc-references --config d\.json --all --update-baseline$/);
  });
});
