import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkPushedRefs } from './pushed-refs.ts';

// Shas with digits and letters, one starting and ending with 0, so a sha is never read as a deletion by its edges.
const HEAD = '1a'.repeat(20);
const OTHER = `0${'2b'.repeat(19)}0`;
const TAG = '3c'.repeat(20);
const ZERO = '0'.repeat(40);

/** A git that answers only the exact calls it is given, and throws on any other. */
function strictGit(outputs: Record<string, string>) {
  const calls: string[] = [];
  const git = (args: string[]): string => {
    const call = args.join(' ');
    calls.push(call);
    const out = outputs[call];
    if (out === undefined) throw new Error(`unexpected git ${call}`);
    return out;
  };
  return { git, calls };
}

const CLEAN = { 'diff --name-only -z HEAD --': '' };
const NOTHING = { verdict: 'nothing', line: 'agnipariksha: the push carries no commit (up to date, or deletions only) - nothing to judge' };
const unreadable = (line: string) => ({
  verdict: 'refuse',
  reason: `--pushed-refs cannot read the ref line "${line}": git's pre-push lines are "<local ref> <local sha> <remote ref> <remote sha>"`,
});

test('a push of HEAD from a clean tracked tree is judged as usual', () => {
  const { git, calls } = strictGit({ [`rev-parse HEAD^{commit} ${HEAD}^{commit}`]: `${HEAD}\n${HEAD}\n`, ...CLEAN });
  // As the hook's here-string hands it over: a trailing newline.
  assert.deepEqual(checkPushedRefs(`refs/heads/feat ${HEAD} refs/heads/feat ${ZERO}\n`, git), { verdict: 'judge' });
  assert.deepEqual(calls, [`rev-parse HEAD^{commit} ${HEAD}^{commit}`, 'diff --name-only -z HEAD --']);
});

test('a ref other than HEAD refuses, naming the ref and the way out, before reading the tree', () => {
  const { git, calls } = strictGit({ [`rev-parse HEAD^{commit} ${TAG}^{commit} ${OTHER}^{commit}`]: `${HEAD}\n${HEAD}\n${OTHER}\n`, ...CLEAN });
  // An annotated tag that peels to HEAD passes; the branch after it does not.
  const refs = `refs/tags/v1 ${TAG} refs/tags/v1 ${ZERO}\nrefs/heads/other ${OTHER} refs/heads/other ${HEAD}\n`;
  assert.deepEqual(checkPushedRefs(refs, git), {
    verdict: 'refuse',
    reason:
      'the push carries refs/heads/other at 02b2b2b2b2b2, not the checked-out HEAD (1a1a1a1a1a1a): the gate judges HEAD and the files on disk, so its verdict would not be about refs/heads/other. Check out refs/heads/other and push again',
  });
  assert.deepEqual(calls, [`rev-parse HEAD^{commit} ${TAG}^{commit} ${OTHER}^{commit}`]);
});

test('a tracked file that differs from HEAD refuses, naming every such file and the way out', () => {
  const { git } = strictGit({ [`rev-parse HEAD^{commit} ${HEAD}^{commit}`]: `${HEAD}\n${HEAD}\n`, 'diff --name-only -z HEAD --': 'a.ts\0dir/b.ts\0' });
  assert.deepEqual(checkPushedRefs(`refs/heads/feat ${HEAD} refs/heads/feat ${OTHER}\n`, git), {
    verdict: 'refuse',
    reason:
      'tracked files differ from HEAD: a.ts, dir/b.ts. The gate judges the files on disk and the push carries HEAD\'s, so its verdict would not be about the push. Commit or stash the change, then push again',
  });
});

test('a deletion is skipped: deletions only, or no lines at all, is nothing to judge, and asks git nothing', () => {
  const { git, calls } = strictGit({});
  assert.deepEqual(checkPushedRefs(`(delete) ${ZERO} refs/heads/old ${HEAD}\n`, git), NOTHING);
  // An up-to-date push: git runs the hook with no lines, and the here-string adds a newline.
  assert.deepEqual(checkPushedRefs('\n', git), NOTHING);
  assert.deepEqual(checkPushedRefs('', git), NOTHING);
  assert.deepEqual(calls, []);
});

test('a deletion beside a push of HEAD is skipped, and HEAD is judged', () => {
  const { git, calls } = strictGit({ [`rev-parse HEAD^{commit} ${HEAD}^{commit}`]: `${HEAD}\n${HEAD}\n`, ...CLEAN });
  const refs = `(delete) ${ZERO} refs/heads/old ${OTHER}\nrefs/heads/feat ${HEAD} refs/heads/feat ${ZERO}\n`;
  assert.deepEqual(checkPushedRefs(refs, git), { verdict: 'judge' });
  assert.equal(calls[0], `rev-parse HEAD^{commit} ${HEAD}^{commit}`);
});

test('a line not in git\'s shape refuses, quoting it, and asks git nothing', () => {
  const { git, calls } = strictGit({});
  for (const line of [
    `refs/heads/feat ${HEAD} refs/heads/feat`,
    `refs/heads/feat ${HEAD} refs/heads/feat ${ZERO} extra`,
    `refs/heads/feat  refs/heads/feat ${ZERO}`,
    `refs/heads/feat HEAD refs/heads/feat ${ZERO}`,
    `refs/heads/feat x${HEAD} refs/heads/feat ${ZERO}`,
    `refs/heads/feat ${HEAD}x refs/heads/feat ${ZERO}`,
  ]) {
    assert.deepEqual(checkPushedRefs(`refs/heads/main ${HEAD} refs/heads/main ${ZERO}\n${line}\n`, git), unreadable(line));
  }
  assert.deepEqual(calls, []);
});

test('on real git: HEAD and a tag at it pass, another branch refuses, and a staged or unstaged tracked change refuses; an untracked file does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-'));
  // Hermetic: none of the machine's git config, trace or maintenance reaches the fixture, and it has its own identity.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|CONFIG)/.test(key)));
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' });
  const settings = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
  const repo = join(dir, 'repo');
  const git = (args: string[]): string =>
    execFileSync('git', [...settings, ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL' });
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env, stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' });
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(['add', 'a.txt']);
    git(['commit', '-qm', 'one']);
    git(['switch', '-qc', 'other']);
    git(['commit', '-q', '--allow-empty', '-m', 'other']);
    const other = git(['rev-parse', 'HEAD']).trim();
    git(['switch', '-q', 'main']);
    git(['tag', '-a', '-m', 'v1', 'v1']);
    const head = git(['rev-parse', 'HEAD']).trim();
    const tag = git(['rev-parse', 'v1']).trim();
    assert.notEqual(tag, head, 'the fixture tag is annotated: its sha is the tag object');

    const ofHead = `refs/heads/main ${head} refs/heads/main ${ZERO}\nrefs/tags/v1 ${tag} refs/tags/v1 ${ZERO}\n`;
    assert.deepEqual(checkPushedRefs(ofHead, git), { verdict: 'judge' });
    const refused = checkPushedRefs(`refs/heads/other ${other} refs/heads/other ${ZERO}\n`, git);
    assert.equal(refused.verdict === 'refuse' && refused.reason.startsWith(`the push carries refs/heads/other at ${other.slice(0, 12)}, not the checked-out HEAD (${head.slice(0, 12)})`), true, JSON.stringify(refused));

    writeFileSync(join(repo, 'untracked.txt'), 'new\n');
    assert.deepEqual(checkPushedRefs(ofHead, git), { verdict: 'judge' }, 'a push carries no untracked file');
    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    assert.match(JSON.stringify(checkPushedRefs(ofHead, git)), /"reason":"tracked files differ from HEAD: a\.txt\. /);
    git(['add', 'a.txt', 'untracked.txt']);
    assert.match(JSON.stringify(checkPushedRefs(ofHead, git)), /"reason":"tracked files differ from HEAD: a\.txt, untracked\.txt\. /, 'staged changes count');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
