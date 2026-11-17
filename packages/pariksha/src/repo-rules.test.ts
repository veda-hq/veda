// The repo-rules engine: its settings, how a run reports, and how it reads a repository.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { diskRepo, lineAt, lineOf, parseConfig, parseGrep, positiveInteger, runRules, sideGrep, staleAllowances, stringList, type Rule } from './repo-rules.ts';
import { memoryRepo } from './repo-rules-memory.ts';

const RULE_A: Rule = {
  id: 'rule-a',
  lesson: 'A goes wrong; do B.',
  settings: { limit: positiveInteger },
  run: (repo, settings) => repo.files.filter((f) => f.endsWith('.bad')).map((file, i) => ({ file, ...(i === 0 ? { line: 3 } : {}), detail: `bad (limit ${String(settings['limit'] ?? 'none')})` })),
};
const RULE_B: Rule = { id: 'rule-b', lesson: 'Never C.', run: () => [] };
const RULES = [RULE_A, RULE_B];

describe('parseConfig', () => {
  it('reads off, allow and a rule\'s own settings', () => {
    const config = parseConfig(JSON.stringify({ rules: { 'rule-a': { allow: { 'x.bad': 'generated' }, limit: 2 }, 'rule-b': { off: 'not here' } } }), RULES);
    assert.deepEqual(config.rules.get('rule-a'), { allow: new Map([['x.bad', 'generated']]), own: { limit: 2 } });
    assert.deepEqual(config.rules.get('rule-b'), { off: 'not here', allow: new Map(), own: {} });
    assert.equal(parseConfig('{}', RULES).rules.size, 0);
  });

  it('refuses every setting nobody would apply', () => {
    const refused: Array<[unknown, RegExp]> = [
      ['{', /settings are not JSON/],
      [[], /must be a JSON object/],
      [{ other: 1 }, /unknown key "other"; repo-rules reads "rules"/],
      [{ rules: [] }, /"rules" must be an object of rule ids/],
      [{ rules: { nope: {} } }, /unknown rule "nope"; the rules are rule-a, rule-b/],
      [{ rules: { 'rule-a': 'off' } }, /rules\.rule-a must be an object/],
      [{ rules: { 'rule-a': { off: ' ' } } }, /rules\.rule-a\.off must say why/],
      [{ rules: { 'rule-a': { allow: [] } } }, /rules\.rule-a\.allow must be an object of paths/],
      [{ rules: { 'rule-a': { allow: { a: '' } } } }, /rules\.rule-a\.allow\["a"\] must say why/],
      [{ rules: { 'rule-a': { limit: 0 } } }, /rules\.rule-a\.limit must be a positive whole number/],
      [{ rules: { 'rule-a': { other: 1 } } }, /rules\.rule-a: unknown key "other"; rule-a reads off, allow, limit/],
      [{ rules: { 'rule-b': { other: 1 } } }, /rule-b reads off, allow$/],
      [{ rules: { 'rule-a': { off: 'x', allow: { a: 'y' } } } }, /"off" stands alone/],
      [{ rules: { 'rule-a': { off: 'x', limit: 1 } } }, /"off" stands alone/],
    ];
    for (const [value, message] of refused) assert.throws(() => parseConfig(typeof value === 'string' ? value : JSON.stringify(value), RULES), message, JSON.stringify(value));
  });

  it('names the setting when its check throws the problem', () => {
    const throwing: Rule = { id: 'rule-t', lesson: 'T.', settings: { pattern: () => { throw new Error('holds "(", which is not a regular expression'); } }, run: () => [] };
    assert.throws(() => parseConfig(JSON.stringify({ rules: { 'rule-t': { pattern: '(' } } }), [throwing]), /^Error: rules\.rule-t\.pattern holds "\(", which is not a regular expression$/);
  });

  it('names allowances for files git does not track', () => {
    const config = parseConfig(JSON.stringify({ rules: { 'rule-a': { allow: { 'gone.bad': 'x', 'kept.bad': 'y' } } } }), RULES);
    assert.deepEqual(staleAllowances(config, ['kept.bad']), ['rules.rule-a.allow["gone.bad"]']);
  });
});

describe('runRules', () => {
  it('passes when nothing fires, counting the rules that ran', () => {
    const config = parseConfig(JSON.stringify({ rules: { 'rule-b': { off: 'x' } } }), RULES);
    assert.deepEqual(runRules(memoryRepo({ 'a.ts': '' }), RULES, config), { ok: true, out: ['pariksha repo-rules: 1 file(s), 1 rule(s), nothing refused'], err: [] });
  });

  it('refuses with each finding, then each fired rule\'s lesson once, allowed files left out', () => {
    const config = parseConfig(JSON.stringify({ rules: { 'rule-a': { allow: { 'c.bad': 'kept on purpose' }, limit: 4 } } }), RULES);
    const outcome = runRules(memoryRepo({ 'a.bad': '', 'b.bad': '', 'c.bad': '' }), RULES, config);
    assert.deepEqual(outcome, {
      ok: false,
      out: [],
      err: [
        'pariksha repo-rules: a.bad:3: rule-a: bad (limit 4)',
        'pariksha repo-rules: b.bad: rule-a: bad (limit 4)',
        '',
        'rule-a: A goes wrong; do B.',
        '',
        'Not a mistake? Name the file under rules.<id>.allow in the repo-rules settings, with the reason.',
      ],
    });
  });
});

describe('lines and settings checks', () => {
  it('reads lines by offset and by needle', () => {
    assert.equal(lineAt('a\nb\nc', 0), 1);
    assert.equal(lineAt('a\nb\nc', 4), 3);
    assert.equal(lineAt('a', 9), 1);
    assert.equal(lineOf('a\nb\na', 'a'), 1);
    assert.equal(lineOf('a\nb\na', 'a', 2), 3);
    assert.equal(lineOf('a\nb', /^b$/), 2);
    assert.equal(lineOf('a', 'z'), undefined);
    assert.equal(lineOf('a', 'a', 0), 1);
  });

  it('checks list and number settings', () => {
    assert.equal(stringList(['a']), undefined);
    for (const bad of [[], [''], [1], 'a']) assert.match(stringList(bad) ?? '', /non-empty list of strings/);
    assert.equal(positiveInteger(3), undefined);
    for (const bad of [0, -1, 1.5, '3']) assert.match(positiveInteger(bad) ?? '', /positive whole number/);
  });
});

describe('grep', () => {
  it("reads git grep's lines, a commit's prefix dropped", () => {
    assert.deepEqual(parseGrep('HEAD:a.ts:3:x: y\nb.ts:1:z\nnot a hit\n', 'HEAD:'), [
      { file: 'a.ts', line: 3, text: 'x: y' },
      { file: 'b.ts', line: 1, text: 'z' },
    ]);
  });

  it('greps the index, a commit or the tree, and reads no match as no hit', () => {
    const calls: string[][] = [];
    const git = {
      run: (args: readonly string[]) => {
        calls.push([...args]);
        if (args.includes('miss')) return undefined;
        return args.includes('--cached') ? 'a.ts:1:x\n' : 'c0:b.ts:2:y\n';
      },
    };
    assert.deepEqual(sideGrep(git, { kind: 'index' })(['x'], ['*.ts']), [{ file: 'a.ts', line: 1, text: 'x' }]);
    assert.deepEqual(sideGrep(git, { kind: 'commit', commit: 'c0' })(['y'], ['.']), [{ file: 'b.ts', line: 2, text: 'y' }]);
    assert.deepEqual(sideGrep(git, { kind: 'tree' })(['miss'], ['.']), []);
    assert.deepEqual(sideGrep(git, { kind: 'tree' })([], ['.']), []);
    assert.deepEqual(calls, [
      ['grep', '--no-color', '-n', '-I', '-F', '-e', 'x', '--cached', '--', '*.ts'],
      ['grep', '--no-color', '-n', '-I', '-F', '-e', 'y', 'c0', '--', '.'],
      ['grep', '--no-color', '-n', '-I', '-F', '-e', 'miss', '--', '.'],
    ]);
  });
});

describe('diskRepo', () => {
  const temps: string[] = [];
  after(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('reads files from the working tree, and nothing for a folder, a link or a missing path', () => {
    const root = mkdtempSync(join(tmpdir(), 'pariksha-repo-rules-'));
    temps.push(root);
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'a.txt'), 'hello');
    symlinkSync(join(root, 'a.txt'), join(root, 'link'));
    const repo = diskRepo(root, ['a.txt'], () => ['a.txt'], () => ['old.txt'], { run: () => undefined }, { kind: 'tree' });
    assert.equal(repo.read('a.txt'), 'hello');
    assert.deepEqual(repo.bytes('a.txt'), Buffer.from('hello'));
    assert.equal(repo.size('a.txt'), 5);
    for (const path of ['dir', 'link', 'missing']) {
      assert.equal(repo.read(path), undefined, path);
      assert.equal(repo.bytes(path), undefined, path);
      assert.equal(repo.size(path), undefined, path);
    }
    assert.deepEqual([repo.root, repo.files, repo.tracked(), repo.removed(), repo.grep(['x'], ['.'])], [root, ['a.txt'], ['a.txt'], ['old.txt'], []]);
  });
});

describe('memoryRepo', () => {
  it('holds text and bytes, the selection, removals and a git', () => {
    const repo = memoryRepo({ 'b.txt': Buffer.from('x\ny'), 'a.txt': 'y' }, { selected: ['a.txt'], removed: ['c.txt'], run: () => 'ok' });
    assert.deepEqual([repo.files, repo.tracked(), repo.removed(), repo.git.run([]), repo.size('b.txt'), repo.read('zz')], [['a.txt'], ['a.txt', 'b.txt'], ['c.txt'], 'ok', 3, undefined]);
    assert.deepEqual(repo.grep(['y'], ['.']), [
      { file: 'a.txt', line: 1, text: 'y' },
      { file: 'b.txt', line: 2, text: 'y' },
    ]);
    assert.deepEqual(repo.grep(['y'], [':(glob)a.*']), [{ file: 'a.txt', line: 1, text: 'y' }]);
    assert.equal(memoryRepo({}).git.run([]), undefined);
  });
});
