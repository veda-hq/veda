/**
 * The fire log: where it lives, what a row keeps, and that appends add rows.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  appendFires,
  branchAt,
  clip,
  EXCERPT_MAX,
  FIRES_DIR_ENV,
  FIRES_FILE,
  firesDir,
  type FireRow,
  type Git,
  type Write,
} from './fire-log.ts';
import { realGit, repoWithWorktree, scratchDirs, sh } from './fixture.test.ts';

const { scratch, cleanup } = scratchDirs('rule-fires-');
afterEach(cleanup);

describe('clip', () => {
  it('keeps a short value on one line', () => {
    assert.equal(clip('  git   push\n  -u origin\tHEAD  '), 'git push -u origin HEAD');
  });

  it('cuts at the maximum with an ellipsis inside it', () => {
    assert.equal(EXCERPT_MAX, 120);
    assert.equal(clip('x'.repeat(120)), 'x'.repeat(120));
    const cut = clip('y'.repeat(121));
    assert.equal(cut, `${'y'.repeat(119)}…`);
    assert.equal(cut.length, 120);
    assert.equal(clip('abcdef', 4), 'abc…');
  });
});

describe('firesDir', () => {
  it('honours the override', () => {
    const git: Git = () => {
      throw new Error('git must not run');
    };
    assert.equal(firesDir('/x/fires', '/repo', git), '/x/fires');
    assert.equal(FIRES_DIR_ENV, 'KAVACH_RULE_FIRES_DIR');
  });

  it('puts a worktree session’s log in the primary checkout', () => {
    const { main, worktree } = repoWithWorktree(scratch);
    const expected = join(main, '.tmp', 'rule-checks');
    assert.equal(firesDir(undefined, worktree, realGit), expected);
    assert.equal(firesDir('', main, realGit), expected);
  });
});

describe('branchAt', () => {
  it('names the branch, or HEAD when detached', () => {
    const { main, worktree } = repoWithWorktree(scratch);
    assert.equal(branchAt(worktree, realGit), 'wt');
    sh(main, 'checkout', '-q', '--detach');
    assert.equal(branchAt(main, realGit), 'HEAD');
  });

  it('says unknown outside git', () => {
    assert.equal(branchAt(scratch(), realGit), 'unknown');
  });
});

describe('appendFires', () => {
  it('creates the folder and appends one JSON line per row', () => {
    const dir = join(scratch(), 'nested', 'fires');
    const row: FireRow = {
      ts: '2026-10-05T10:00:00.000Z',
      rule: 'H-14',
      outcome: 'excepted',
      branch: 'claude/x',
      excerpt: 'git merge origin/main',
      reason: 'GitHub reports a conflict',
    };
    const { reason: _reason, ...rest } = row;
    const second: FireRow = { ...rest, outcome: 'refused' };
    appendFires(dir, [row]);
    appendFires(dir, [second, row]);
    const lines = readFileSync(join(dir, FIRES_FILE), 'utf8').split('\n');
    assert.equal(FIRES_FILE, 'fires.jsonl');
    assert.equal(lines.length, 4);
    assert.equal(lines[3], '');
    assert.deepEqual(
      lines.slice(0, 3).map((line) => JSON.parse(line) as unknown),
      [row, second, row].map((item) => JSON.parse(JSON.stringify(item)) as unknown),
    );
  });

  it('throws on a short write rather than append the rest apart', () => {
    const dir = scratch();
    const row: FireRow = {
      ts: '2026-10-05T10:00:00.000Z',
      rule: 'H-14',
      outcome: 'warned',
      branch: 'claude/x',
      excerpt: 'x',
    };
    const writes: number[] = [];
    const short: Write = (fd, bytes) => {
      writes.push(bytes.length);
      return writeSync(fd, bytes, 0, 10);
    };
    const line = `${JSON.stringify(row)}\n`;
    assert.throws(() => appendFires(dir, [row], short), {
      message: `fire log: wrote 10 of ${line.length} bytes`,
    });
    assert.deepEqual(writes, [line.length]);
    appendFires(dir, [row]);
    assert.equal(readFileSync(join(dir, FIRES_FILE), 'utf8'), `${line.slice(0, 10)}\n${line}`);
  });

  it('starts on a fresh line after a partial row a failed append left', () => {
    const dir = scratch();
    const row: FireRow = {
      ts: '2026-10-05T10:00:00.000Z',
      rule: 'H-14',
      outcome: 'refused',
      branch: 'claude/x',
      excerpt: 'git merge origin/main',
    };
    writeFileSync(join(dir, FIRES_FILE), '{"ts":"2026');
    appendFires(dir, [row]);
    assert.equal(readFileSync(join(dir, FIRES_FILE), 'utf8'), `{"ts":"2026\n${JSON.stringify(row)}\n`);
  });
});
