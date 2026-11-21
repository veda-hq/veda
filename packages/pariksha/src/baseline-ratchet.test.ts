// baseline-ratchet in throwaway repositories: a baseline read at the merge
// base, a confirmed absence, a real failure, and the renames since the base.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { atMergeBase, fileAt, mergeBaseOf, parseRenames, renamedSinceMergeBase, trackedFiles } from './baseline-ratchet.ts';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const gitIn = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL' });

/** BASE_BRANCH as this test sets it, put back after each test. */
const SAVED = process.env['BASE_BRANCH'];
const setBaseBranch = (value: string | undefined): void => {
  if (value === undefined) delete process.env['BASE_BRANCH'];
  else process.env['BASE_BRANCH'] = value;
};

const LONG = `${'x'.repeat(80)}.json`;

describe('baseline-ratchet', () => {
  let repo = '';

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'pariksha-baseline-ratchet-'));
    gitIn(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'baseline.json'), '{"at":"base"}\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'base');
    gitIn(repo, 'checkout', '-q', '-b', 'topic');
    writeFileSync(join(repo, 'baseline.json'), '{"at":"head"}\n');
    writeFileSync(join(repo, 'new.json'), '{}\n');
    // A listing longer than 64 bytes: a buffer sized in bytes, not MiB, fails.
    writeFileSync(join(repo, LONG), '{}\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'head');
    // The default base, as CI and pre-push name it.
    gitIn(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  });

  after(() => rmSync(repo, { recursive: true, force: true }));
  afterEach(() => setBaseBranch(SAVED));

  it('reads a baseline as the merge base has it', () => {
    assert.equal(atMergeBase(repo, 'baseline.json', 'main', ENV), '{"at":"base"}\n');
  });

  it('is null only when the merge base does not have the file', () => {
    assert.equal(atMergeBase(repo, 'new.json', 'main', ENV), null);
  });

  it("throws when the base cannot be read, rather than passing, with git's reason", () => {
    assert.throws(() => atMergeBase(repo, 'baseline.json', 'no-such-ref', ENV), /Not a valid object name no-such-ref/);
  });

  it('takes the base from BASE_BRANCH when none is given', () => {
    setBaseBranch('topic');
    assert.equal(atMergeBase(repo, 'baseline.json', undefined, ENV), '{"at":"head"}\n');
  });

  it('falls back to origin/main when BASE_BRANCH is unset', () => {
    setBaseBranch(undefined);
    assert.equal(atMergeBase(repo, 'baseline.json', undefined, ENV), '{"at":"base"}\n');
  });

  it('reads nothing when the hook found no base branch (BASE_BRANCH empty)', () => {
    setBaseBranch('');
    assert.equal(atMergeBase(repo, 'baseline.json', undefined, ENV), null);
    assert.equal(atMergeBase(repo, 'baseline.json', '', ENV), null);
  });

  it('names the merge base as a full sha, and none for an empty base', () => {
    const main = gitIn(repo, 'rev-parse', 'main').trim();
    assert.match(main, /^[0-9a-f]{40}$/);
    assert.equal(mergeBaseOf(repo, 'main', ENV), main);
    assert.equal(mergeBaseOf(repo, '', ENV), null);
    setBaseBranch(undefined);
    assert.equal(mergeBaseOf(repo, undefined, ENV), main);
  });

  it('reads the process environment when given none', () => {
    // The defaults: BASE_BRANCH from process.env, and git run under it.
    const cwd = process.cwd();
    setBaseBranch('main');
    try {
      process.chdir(repo);
      assert.equal(mergeBaseOf(repo), gitIn(repo, 'rev-parse', 'main').trim());
      assert.equal(fileAt(repo, 'main', 'baseline.json'), '{"at":"base"}\n');
      assert.equal(atMergeBase(repo, 'baseline.json'), '{"at":"base"}\n');
      assert.equal(renamedSinceMergeBase(repo).size, 0);
    } finally {
      process.chdir(cwd);
    }
  });

  it('reads a file at a commit, null where the commit lacks it', () => {
    assert.equal(fileAt(repo, 'main', 'baseline.json', ENV), '{"at":"base"}\n');
    assert.equal(fileAt(repo, 'topic', 'baseline.json', ENV), '{"at":"head"}\n');
    assert.equal(fileAt(repo, 'main', 'new.json', ENV), null);
  });

  it('lists tracked files that still exist, leaving out deleted ones', () => {
    // Tracked but deleted from the working tree: listed by git, dropped here.
    rmSync(join(repo, 'new.json'));
    try {
      assert.deepEqual(trackedFiles(repo, ENV, ['.']), ['baseline.json', LONG]);
    } finally {
      writeFileSync(join(repo, 'new.json'), '{}\n');
    }
  });
});

describe('renamedSinceMergeBase', () => {
  let repo = '';
  const BODY = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('');

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'pariksha-baseline-renames-'));
    gitIn(repo, 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'old'));
    writeFileSync(join(repo, 'old/moved.ts'), BODY);
    writeFileSync(join(repo, 'old/edited.ts'), BODY);
    writeFileSync(join(repo, 'old/café.ts'), BODY);
    writeFileSync(join(repo, 'kept.ts'), BODY);
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'base');
    gitIn(repo, 'checkout', '-q', '-b', 'topic');
    mkdirSync(join(repo, 'new'));
    gitIn(repo, 'mv', 'old/moved.ts', 'new/moved.ts');
    gitIn(repo, 'mv', 'old/café.ts', 'new/café.ts');
    gitIn(repo, 'mv', 'old/edited.ts', 'new/edited.ts');
    // A move with a path edit, as a moved script's root depth changes.
    writeFileSync(join(repo, 'new/edited.ts'), `${BODY}line 40\n`);
    writeFileSync(join(repo, 'kept.ts'), `${BODY}more\n`);
    gitIn(repo, 'add', '-A');
  });

  after(() => rmSync(repo, { recursive: true, force: true }));
  afterEach(() => setBaseBranch(SAVED));

  it('maps each renamed file, an edited one included, to its old path', () => {
    assert.deepEqual([...renamedSinceMergeBase(repo, 'main', ENV)].sort(), [
      ['new/café.ts', 'old/café.ts'],
      ['new/edited.ts', 'old/edited.ts'],
      ['new/moved.ts', 'old/moved.ts'],
    ]);
  });

  it('maps a non-ASCII name as committed, not as git quotes it', () => {
    // Plain --name-status prints "old/caf\303\251.ts", which no baseline holds.
    assert.equal(renamedSinceMergeBase(repo, 'main', ENV).get('new/café.ts'), 'old/café.ts');
  });

  it('counts a rename only, never a copy, an edit or an addition', () => {
    const fields = [
      'C075',
      'src/b.ts',
      'R-copy/b.ts',
      // A path is never read as a status, however it begins.
      'M',
      'RENAMED.md',
      'R087',
      'old/a.ts',
      'new/a.ts',
      'A',
      'added.ts',
      'R100',
      'old/c d.ts',
      'new/c d.ts',
      'D',
      'gone.ts',
      '',
    ];
    assert.deepEqual(
      [...parseRenames(fields.join('\0'))],
      [
        ['new/a.ts', 'old/a.ts'],
        ['new/c d.ts', 'old/c d.ts'],
      ],
    );
  });

  it('reads nothing from a truncated rename', () => {
    assert.equal(parseRenames(['R100', 'old/a.ts'].join('\0')).size, 0);
    assert.equal(parseRenames('').size, 0);
  });

  it('is empty when the hook found no base branch', () => {
    assert.equal(renamedSinceMergeBase(repo, '', ENV).size, 0);
    setBaseBranch('');
    assert.equal(renamedSinceMergeBase(repo, undefined, ENV).size, 0);
  });

  it('throws when the base cannot be read, rather than finding no renames', () => {
    assert.throws(() => renamedSinceMergeBase(repo, 'no-such-ref', ENV), /Not a valid object name no-such-ref/);
  });
});
