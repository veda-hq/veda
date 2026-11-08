import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  addedLines,
  DEFAULTS,
  findUncited,
  formatClaims,
  hasCitation,
  listAdrs,
  mergeParents,
  phrasePattern,
  readOrUndefined,
  windowOf,
  type Source,
} from './authority-citations.ts';
import { run } from './cli.ts';
import type { Git } from './git.ts';

/**
 * Most cases run the check in a throwaway two-branch repository. The upstream
 * claim passed at its own commit: it was committed beside a pragma, and a
 * later commit removed only the pragma. Merging main into a branch must not
 * judge it again; a squash, which has one parent, must.
 */
const CLI = join(import.meta.dirname, 'cli.ts');
const UPSTREAM_CLAIM = 'Offers are read from the website, approved by Dana.';
const NEW_CLAIM = 'Prices round down, per the founder.';
const UPSTREAM_MATCH = '[approved by Dana]';
const NEW_MATCH = '[per the founder]';
const PRAGMA = 'ALLOW-AUTHORITY-PHRASE: drafted before the decision landed';
const PASS = 'pariksha authority-citations: every authority claim cites an anchor';

/** git with no user or system config, and no GITHEAD_ leaking in from an outer merge. */
const ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }).filter(
    ([k]) => !k.startsWith('GITHEAD_') && !k.startsWith('GIT_DIR') && k !== 'GIT_INDEX_FILE' && k !== 'GIT_WORK_TREE',
  ),
);
const git = (root: string, ...args: string[]): string => execFileSync('git', args, { cwd: root, env: ENV, encoding: 'utf8', timeout: 30_000 });
const gitMayFail = (root: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd: root, env: ENV, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
};
const write = (root: string, path: string, lines: string[]) => writeFileSync(join(root, path), `${lines.join('\n')}\n`);

const validate = (root: string, extra: NodeJS.ProcessEnv = {}, mode = 'staged', more: string[] = []) => {
  const lines: string[] = [];
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
  const status = run(['authority-citations', '--root', root, '--authority', 'Dana', '--mode', mode, ...more], io, '0', { ...ENV, ...extra });
  return { status, output: lines.join('\n') };
};

const commitThroughGate = (root: string, message: string) => {
  git(root, 'add', '--all');
  const r = validate(root);
  assert.equal(r.status, 0, r.output);
  git(root, 'commit', '--quiet', '--message', message);
};

const init = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-authority-'));
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
};

/** main: shared.md, then offers.md with the claim beside the pragma, then the pragma dropped. feature edits notes.md. */
const fixture = (): string => {
  const root = init();
  write(root, 'shared.md', ['# Shared', 'line one']);
  write(root, 'notes.md', ['# Notes']);
  commitThroughGate(root, 'base');
  git(root, 'checkout', '--quiet', '-b', 'feature');
  write(root, 'notes.md', ['# Notes', 'feature work']);
  commitThroughGate(root, 'feature work');
  git(root, 'checkout', '--quiet', 'main');
  write(root, 'offers.md', ['# Offers', UPSTREAM_CLAIM, PRAGMA]);
  commitThroughGate(root, 'offers, with pragma');
  write(root, 'offers.md', ['# Offers', UPSTREAM_CLAIM]);
  commitThroughGate(root, 'drop the pragma');
  git(root, 'checkout', '--quiet', 'feature');
  return root;
};

describe('authority-citations, staged, on a merge', () => {
  it('passes a clean merge of main through a real pre-merge-commit hook', () => {
    const root = fixture();
    const hook = join(root, '.git', 'hooks', 'pre-merge-commit');
    writeFileSync(hook, `#!/usr/bin/env bash\nexec '${process.execPath}' '${CLI}' authority-citations --authority Dana\n`);
    chmodSync(hook, 0o755);
    const merge = gitMayFail(root, 'merge', '--no-edit', 'main');
    assert.ok(merge.output.includes(PASS), merge.output);
    assert.equal(merge.status, 0);
    assert.equal(git(root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  });

  it('does not judge main lines again in a merge left open with --no-commit', () => {
    const root = fixture();
    git(root, 'merge', '--quiet', '--no-commit', '--no-ff', 'main');
    const r = validate(root);
    assert.equal(r.status, 0, r.output);
  });

  it('refuses an uncited claim written by the conflict resolution', () => {
    const root = fixture();
    write(root, 'shared.md', ['# Shared', 'feature wording']);
    commitThroughGate(root, 'feature edits shared');
    git(root, 'checkout', '--quiet', 'main');
    write(root, 'shared.md', ['# Shared', 'main wording']);
    commitThroughGate(root, 'main edits shared');
    git(root, 'checkout', '--quiet', 'feature');
    assert.ok(gitMayFail(root, 'merge', 'main').output.includes('CONFLICT'));
    write(root, 'shared.md', ['# Shared', NEW_CLAIM]);
    git(root, 'add', 'shared.md');
    const r = validate(root);
    assert.equal(r.status, 1);
    assert.ok(r.output.includes('uncited authority claim(s) in shared.md'));
    assert.ok(r.output.includes(`2: ${NEW_MATCH} ${NEW_CLAIM}`));
    assert.ok(!r.output.includes('offers.md'));
    assert.ok(r.output.includes('1 claim(s) across 1 file(s).'));
  });

  it('still reads the merge parent while a conflict is unresolved', () => {
    const root = fixture();
    write(root, 'shared.md', ['# Shared', 'feature wording']);
    commitThroughGate(root, 'feature edits shared');
    git(root, 'checkout', '--quiet', 'main');
    write(root, 'shared.md', ['# Shared', 'main wording']);
    commitThroughGate(root, 'main edits shared');
    git(root, 'checkout', '--quiet', 'feature');
    gitMayFail(root, 'merge', 'main');
    const main = git(root, 'rev-parse', 'main').trim();
    const parents = mergeParents({ run: (args) => gitMayFailOut(root, args) }, {}, readOrUndefined);
    assert.deepEqual(parents, [main]);
  });

  it('refuses an uncited claim in a file the merge adds that neither parent has', () => {
    const root = fixture();
    git(root, 'merge', '--quiet', '--no-commit', '--no-ff', 'main');
    write(root, 'evil.md', ['# Evil merge', 'filler', NEW_CLAIM]);
    git(root, 'add', 'evil.md');
    const r = validate(root);
    assert.equal(r.status, 1);
    assert.ok(r.output.includes(`3: ${NEW_MATCH}`));
    assert.ok(!r.output.includes('offers.md'));
  });

  it('judges only its own line when the merge edits a file holding the main claim', () => {
    const root = fixture();
    git(root, 'merge', '--quiet', '--no-commit', '--no-ff', 'main');
    write(root, 'offers.md', ['# Offers', UPSTREAM_CLAIM, 'merge note']);
    git(root, 'add', 'offers.md');
    assert.equal(validate(root).status, 0);
  });

  it('accepts a cited claim written by the merge', () => {
    const root = fixture();
    git(root, 'merge', '--quiet', '--no-commit', '--no-ff', 'main');
    write(root, 'notes.md', ['# Notes', 'feature work', `${NEW_CLAIM} PR #2067`]);
    git(root, 'add', 'notes.md');
    assert.equal(validate(root).status, 0);
  });

  it('fails closed to the HEAD diff when MERGE_HEAD does not resolve', () => {
    const root = fixture();
    git(root, 'merge', '--quiet', '--no-commit', '--no-ff', 'main');
    writeFileSync(join(root, '.git', 'MERGE_HEAD'), `${'0'.repeat(40)}\n`);
    const r = validate(root);
    assert.equal(r.status, 1);
    assert.ok(r.output.includes('uncited authority claim(s) in offers.md'));
  });
});

/** git's stdout, or undefined when it fails: the Git interface over a test repository. */
const gitMayFailOut = (root: string, args: readonly string[]): string | undefined => {
  const r = spawnSync('git', args, { cwd: root, env: ENV, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? r.stdout : undefined;
};

describe('authority-citations, staged, outside a merge', () => {
  it('judges every line a squash brings in, since a squash has one parent', () => {
    const root = fixture();
    git(root, 'merge', '--quiet', '--squash', 'main');
    const r = validate(root);
    assert.equal(r.status, 1);
    assert.ok(r.output.includes(`2: ${UPSTREAM_MATCH} ${UPSTREAM_CLAIM}`));
  });

  it('refuses an uncited claim an ordinary commit adds', () => {
    const root = fixture();
    write(root, 'notes.md', ['# Notes', 'feature work', NEW_CLAIM]);
    git(root, 'add', 'notes.md');
    const r = validate(root);
    assert.equal(r.status, 1);
    assert.ok(r.output.includes(`3: ${NEW_MATCH} ${NEW_CLAIM}`));
  });

  it('judges a renamed file whole, and a path that needs quoting or reads as a glob', () => {
    const root = fixture();
    git(root, 'mv', 'notes.md', 'renamed.md');
    write(root, 'renamed.md', ['# Notes', 'feature work', NEW_CLAIM]);
    write(root, 'é [x].md', [NEW_CLAIM]);
    write(root, '[x].md', ['plain']);
    git(root, 'add', '--all');
    const r = validate(root);
    assert.equal(r.status, 1, r.output);
    assert.ok(r.output.includes('uncited authority claim(s) in renamed.md'), r.output);
    assert.ok(r.output.includes('uncited authority claim(s) in é [x].md'), r.output);
    assert.ok(r.output.includes('2 claim(s) across 2 file(s).'), r.output);
  });

  it('reads the same diff whatever colour, external diff or textconv a user configures', () => {
    const root = fixture();
    git(root, 'config', 'color.diff', 'always');
    git(root, 'config', 'diff.external', 'false');
    git(root, 'config', 'diff.md.textconv', 'tr a-z A-Z <');
    writeFileSync(join(root, '.git', 'info', 'attributes'), '*.md diff=md\n');
    write(root, 'notes.md', ['# Notes', 'feature work', NEW_CLAIM]);
    git(root, 'add', 'notes.md');
    const r = validate(root);
    assert.equal(r.status, 1, r.output);
    assert.ok(r.output.includes(`3: ${NEW_MATCH} ${NEW_CLAIM}`), r.output);
  });

  it('ignores a GITHEAD_ variable that names no commit', () => {
    const root = fixture();
    write(root, 'notes.md', ['# Notes', 'feature work', NEW_CLAIM]);
    git(root, 'add', 'notes.md');
    assert.equal(validate(root, { [`GITHEAD_${'0'.repeat(40)}`]: 'main' }).status, 1);
  });

  it('ignores a GITHEAD_ commit whose clean merge is not the staged tree', () => {
    const root = fixture();
    const main = git(root, 'rev-parse', 'main').trim();
    write(root, 'offers.md', ['# Offers', UPSTREAM_CLAIM]);
    write(root, 'notes.md', ['# Notes', 'feature work', 'one more edit']);
    git(root, 'add', '--all');
    writeFileSync(join(root, '.git', 'AUTO_MERGE'), git(root, 'write-tree'));
    const r = validate(root, { [`GITHEAD_${main}`]: 'main' });
    assert.equal(r.status, 1);
    assert.ok(r.output.includes(`2: ${UPSTREAM_MATCH} ${UPSTREAM_CLAIM}`));
  });

  it('ignores a GITHEAD_ variable when git is not merging (no AUTO_MERGE)', () => {
    const root = fixture();
    git(root, 'read-tree', git(root, 'merge-tree', '--write-tree', 'feature', 'main').trim());
    const main = git(root, 'rev-parse', 'main').trim();
    assert.equal(validate(root, { [`GITHEAD_${main}`]: 'main' }).status, 1);
  });

  it('leaves an uncited claim already in HEAD alone when nearby lines change', () => {
    const root = fixture();
    git(root, 'checkout', '--quiet', 'main');
    write(root, 'offers.md', ['# Offers', UPSTREAM_CLAIM, 'more text']);
    git(root, 'add', 'offers.md');
    assert.equal(validate(root).status, 0);
  });

  it('judges a first commit, which has no HEAD to diff against', () => {
    const root = init();
    write(root, 'first.md', [NEW_CLAIM]);
    git(root, 'add', 'first.md');
    const r = validate(root);
    assert.equal(r.status, 1);
    assert.ok(r.output.includes(`1: ${NEW_MATCH} ${NEW_CLAIM}`));
  });

  it('runs from a subdirectory and reads the ADR directory it is given', () => {
    const root = init();
    mkdirSync(join(root, 'sub'));
    mkdirSync(join(root, 'decisions'));
    write(root, 'decisions/0007-prices.md', ['# Prices']);
    write(root, 'sub/a.md', [`${NEW_CLAIM} ADR-0007`]);
    git(root, 'add', '--all');
    assert.equal(validate(join(root, 'sub')).status, 1);
    const r = validate(join(root, 'sub'), {}, 'staged', ['--adr-dir', 'decisions']);
    assert.equal(r.status, 0, r.output);
  });
});

describe('authority-citations, tree', () => {
  it('judges every tracked file naming a phrase, skipping vendored paths, other extensions and files gone from disk', () => {
    const root = init();
    write(root, 'a.md', ['# A', NEW_CLAIM]);
    write(root, 'b.txt', [NEW_CLAIM]);
    mkdirSync(join(root, 'dist'));
    write(root, 'dist/c.md', [NEW_CLAIM]);
    write(root, 'gone.md', [NEW_CLAIM]);
    git(root, 'add', '--all');
    git(root, 'commit', '--quiet', '-m', 'a');
    git(root, 'rm', '--quiet', '--cached', 'gone.md');
    execFileSync('rm', [join(root, 'gone.md')]);
    git(root, 'add', '--all');
    const r = validate(root, {}, 'tree');
    assert.equal(r.status, 1);
    assert.ok(r.output.includes('uncited authority claim(s) in a.md'));
    assert.ok(!r.output.includes('b.txt'));
    assert.ok(!r.output.includes('dist/c.md'));
    assert.ok(!r.output.includes('gone.md'));
  });

  it('passes a tree whose claims are all cited, with issue prefixes from a list', () => {
    const root = init();
    write(root, 'a.md', [`${NEW_CLAIM} see ABC-12`]);
    git(root, 'add', '--all');
    git(root, 'commit', '--quiet', '-m', 'a');
    assert.equal(validate(root, {}, 'tree').status, 1);
    const r = validate(root, {}, 'tree', ['--issue-prefix', 'XYZ, ABC,']);
    assert.equal(r.status, 0, r.output);
    assert.ok(r.output.includes(PASS));
  });
});

describe('authority-citations, usage and failures', () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
  };

  it('refuses an unknown mode', () => {
    const c = capture();
    assert.equal(run(['authority-citations', '--mode', 'all'], c.io, '0', ENV), 2);
    assert.ok(c.lines.join('\n').includes('usage: pariksha authority-citations'));
  });

  it('exits 2 outside a repository', () => {
    const c = capture();
    const dir = mkdtempSync(join(tmpdir(), 'pariksha-no-repo-'));
    assert.equal(run(['authority-citations', '--root', dir], c.io, '0', ENV), 2);
    assert.ok(c.lines.join('\n').includes('is not in a git repository'));
  });

  it('exits 2 when git cannot read what it must, never passing unread work', () => {
    const root = init();
    write(root, 'a.md', [NEW_CLAIM]);
    git(root, 'add', '--all');
    // A corrupt index: git cannot list the staged change.
    writeFileSync(join(root, '.git', 'index'), 'not an index');
    const c = capture();
    assert.equal(run(['authority-citations', '--root', root], c.io, '0', ENV), 2);
    assert.ok(c.lines.join('\n').includes('nothing was checked, so this is not a pass'), c.lines.join('\n'));
  });
});

describe('citations', () => {
  const opts = { ...DEFAULTS, issuePrefixes: ['ABC'] };
  const none: Git = { run: () => undefined };
  const resolves: Git = { run: (args) => (args[0] === 'cat-file' && args[2] === 'f1a0da2d^{commit}' ? '' : undefined) };
  const adrs = ['docs/adr/0040-thing.md'];

  it('accepts the pragma with a reason, an issue id, a GitHub URL and PR #n', () => {
    for (const w of ['ALLOW-AUTHORITY-PHRASE: fixture text', 'see ABC-447', 'https://github.com/o/r/pull/12', 'https://github.com/o/r/issues/3', 'PR #269']) {
      assert.equal(hasCitation(w, 'x.md', opts, none, []), true, w);
    }
    for (const w of ['ALLOW-AUTHORITY-PHRASE:', 'ALLOW-AUTHORITY-PHRASE:\nnext line', 'XYZ-447', 'https://github.com/o/r/tree/main', 'PR #x']) {
      assert.equal(hasCitation(w, 'x.md', opts, none, []), false, w);
    }
    assert.equal(hasCitation('ABC-1', 'x.md', DEFAULTS, none, []), false);
  });

  it('accepts an ADR that exists and is not the claiming file', () => {
    assert.equal(hasCitation('ADR-0040', 'x.md', opts, none, adrs), true);
    assert.equal(hasCitation('docs/adr/0040', 'x.md', opts, none, adrs), true);
    assert.equal(hasCitation('ADR-0040', 'docs/adr/0040-thing.md', opts, none, adrs), false);
    assert.equal(hasCitation('ADR-0041', 'x.md', opts, none, adrs), false);
    assert.equal(hasCitation('ADR-0040', 'x.md', opts, none, ['docs/adr/0040-thing.txt']), false);
  });

  it('accepts a commit id only when it names a commit', () => {
    assert.equal(hasCitation('(owner decision, f1a0da2d)', 'x.md', opts, resolves, []), true);
    assert.equal(hasCitation('(owner decision, deadbeef)', 'x.md', opts, resolves, []), false);
  });

  it('lists the ADR directory, or nothing when there is none', () => {
    const root = mkdtempSync(join(tmpdir(), 'pariksha-adrs-'));
    assert.deepEqual(listAdrs(root, 'docs/adr'), []);
    mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(root, 'docs', 'adr', '0001-a.md'), '');
    assert.deepEqual(listAdrs(root, 'docs/adr'), ['docs/adr/0001-a.md']);
    assert.equal(readOrUndefined(join(root, 'missing.md')), undefined);
  });
});

describe('phrases and windows', () => {
  it('matches offices, configured names and handles, not mechanisms', () => {
    const p = phrasePattern(['Dana', 'a.b']);
    for (const s of ['an owner decision', 'Founder decided', 'a product rule', 'approved by the CTO', 'decided by Dana', 'mandated by @someone', 'per leadership', 'authorized by a.b']) {
      assert.ok(p.test(s), s);
    }
    for (const s of ['decided by the diff status', 'campaigns are decided by the brand', 'per cent', 'authorized by axb']) {
      assert.ok(!p.test(s), s);
    }
  });

  it('takes three lines either side', () => {
    const lines = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    assert.equal(windowOf(lines, 5), '2\n3\n4\n5\n6\n7\n8');
    assert.equal(windowOf(lines, 1), '1\n2\n3\n4');
  });

  it('reads added line numbers from a -U0 diff', () => {
    assert.deepEqual([...addedLines('@@ -1,0 +2,2 @@\n+a\n+b\n@@ -9 +11 @@\n-x\n+y\n@@ -3,1 +4,0 @@\n-z')], [2, 3, 11]);
  });
});

describe('findUncited and formatClaims', () => {
  const source = (files: Record<string, string | undefined>, judged?: Set<number>): Source => ({
    files: Object.keys(files),
    content: (f) => files[f],
    judged: () => judged,
  });
  const none: Git = { run: () => undefined };

  it('skips unread extensions, vendored paths, unreadable files and files with no phrase', () => {
    const claims = findUncited(
      source({ 'a.md': NEW_CLAIM, 'b.png': NEW_CLAIM, 'node_modules/x.md': NEW_CLAIM, 'c.md': 'nothing here', 'gone.md': undefined }),
      DEFAULTS,
      none,
      [],
    );
    assert.deepEqual(claims, [{ file: 'a.md', line: 1, phrase: 'per the founder', text: NEW_CLAIM }]);
  });

  it('judges only the lines asked for', () => {
    assert.deepEqual(findUncited(source({ 'a.md': `x\n${NEW_CLAIM}` }, new Set([1])), DEFAULTS, none, []), []);
  });

  it('formats a pass, and a refusal grouped by file with how to cite', () => {
    assert.deepEqual(formatClaims([], DEFAULTS), { ok: true, out: [PASS], err: [] });
    const r = formatClaims(
      [
        { file: 'a.md', line: 1, phrase: 'p', text: 't' },
        { file: 'a.md', line: 4, phrase: 'p', text: 't' },
        { file: 'b.md', line: 2, phrase: 'p', text: 't' },
      ],
      { ...DEFAULTS, issuePrefixes: ['ABC'] },
    );
    assert.equal(r.ok, false);
    assert.equal(r.err.filter((l) => l.startsWith('pariksha authority-citations: uncited')).length, 2);
    assert.ok(r.err.includes('  an issue id                       ABC-447'));
    assert.ok(r.err.includes('3 claim(s) across 2 file(s).'));
    assert.ok(!formatClaims([{ file: 'a.md', line: 1, phrase: 'p', text: 't' }], DEFAULTS).err.some((l) => l.includes('issue id')));
  });
});
