import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import {
  hasShellShebang as hasShebang,
  isHook,
  isShellTarget as isTarget,
  readIndexBlobs,
  selectAll as all,
  selectChangedSince as changedSince,
  selectStaged as stagedSelection,
  shellByName as byName,
  type SourcesConfig,
  workingTreeSources as fromTree,
} from './shell-sources.ts';

/**
 * Wiring proof for the shell gates: which files the staged, CI and explicit
 * modes judge, and that staged mode judges the INDEX. Each case builds a
 * throwaway repository. The config is a product's: a vendored tree to skip
 * and a gate-input directory whose change re-judges everything.
 */

const GATE_INPUT_PREFIX = 'scripts/validations/shell/';
const SOURCES: SourcesConfig = {
  hooksDir: '.husky/',
  exclude: ['node_modules/', '.husky/_/', 'apps/mobile/ios/Pods/'],
  gateInputs: [GATE_INPUT_PREFIX],
};
const selectStaged = (root: string) => stagedSelection(root, SOURCES);
const selectAll = (root: string) => all(root, SOURCES);
const selectChangedSince = (root: string, base: string) => changedSince(root, base, SOURCES);
const workingTreeSources = (root: string, paths: readonly string[], options: { skipMissing?: boolean } = {}) => fromTree(root, paths, SOURCES, options);
const shellByName = (path: string) => byName(path, SOURCES);
const isShellTarget = (path: string, text: string) => isTarget(path, text, SOURCES);
const isHuskyHook = (path: string) => isHook(path, SOURCES.hooksDir);
const hasShellShebang = hasShebang;

/** vitest's `it.each`: an array row is spread into the test; `%s` takes the row's values in order. */
const each =
  <T,>(rows: readonly T[]) =>
  (name: string, fn: (...args: T extends readonly unknown[] ? T : [T]) => void): void => {
    for (const row of rows) {
      const args = (Array.isArray(row) ? row : [row]) as unknown[];
      let n = 0;
      it(
        name.replace(/%s/g, () => String(args[n++])),
        () => fn(...(args as unknown as T extends readonly unknown[] ? T : [T])),
      );
    }
  };

const OK = '#!/bin/bash\necho "ok"\n';
const BAD = '#!/bin/bash\necho $1\n';

let repo = '';
// Hermetic git: nothing from the developer's or a hook's git environment.
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TRACE2: '0',
  GIT_TRACE2_EVENT: '0',
  GIT_TRACE2_PERF: '0',
};

// The selectors spawn git with this process's environment, as they must in a
// hook (a partial commit's GIT_INDEX_FILE is the index to judge). Under test
// that environment is made the fixture's hermetic one, so an inherited
// GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE cannot point them elsewhere.
const inherited = { ...process.env };
before(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in env)) Reflect.deleteProperty(process.env, name);
  }
  Object.assign(process.env, env);
});
after(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in inherited)) Reflect.deleteProperty(process.env, name);
  }
  Object.assign(process.env, inherited);
});

const git = (...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      ...args,
    ],
    {
      cwd: repo,
      env,
      encoding: 'utf8',
    },
  );

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

const staged = () => selectStaged(repo).sources.map(source => source.path);

beforeEach(() => {
  repo = join(
    realpathSync(mkdtempSync(join(tmpdir(), 'shell-sources-'))),
    'repo',
  );
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  write('scripts/a.sh', OK);
  write('scripts/b.sh', OK);
  write('.husky/pre-commit', 'echo hook\n');
  write('README.md', '# readme\n');
  write(`${GATE_INPUT_PREFIX}gate.ts`, 'export {};\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
});

afterEach(() => {
  rmSync(dirname(repo), { recursive: true, force: true });
});

describe('selectStaged', () => {
  it('selects nothing when nothing is staged', () => {
    assert.deepEqual(selectStaged(repo), { sources: [], gateChanged: false });
  });

  it('judges an added script (A)', () => {
    write('scripts/new.sh', BAD);
    git('add', 'scripts/new.sh');
    assert.deepEqual(selectStaged(repo).sources, [
      { path: 'scripts/new.sh', text: BAD },
    ]);
  });

  it('judges a modified script (M) and a modified hook', () => {
    write('scripts/a.sh', BAD);
    write('.husky/pre-commit', 'echo changed\n');
    git('add', '-A');
    assert.deepEqual(staged(), ['.husky/pre-commit', 'scripts/a.sh']);
  });

  it('judges nothing for a deleted script (D), without failing', () => {
    git('rm', '-q', 'scripts/a.sh');
    assert.deepEqual(staged(), []);
  });

  it('names a staged file whose path holds glob characters literally', () => {
    write('scripts/task-old.sh', BAD);
    git('add', 'scripts/task-old.sh');
    git('commit', '-q', '-m', 'old');
    write('scripts/task*.sh', OK);
    git('add', '--', ':(literal)scripts/task*.sh');
    assert.deepEqual(staged(), ['scripts/task*.sh']);
  });

  it('judges the new path of a renamed script (R)', () => {
    git('mv', 'scripts/a.sh', 'scripts/renamed.sh');
    assert.deepEqual(staged(), ['scripts/renamed.sh']);
  });

  it('judges a symlink replaced by a regular script (T), staged or on a branch', () => {
    symlinkSync('a.sh', join(repo, 'scripts/link.sh'));
    git('add', 'scripts/link.sh');
    git('commit', '-qm', 'link');
    git('checkout', '-q', '-b', 'feature');
    unlinkSync(join(repo, 'scripts/link.sh'));
    write('scripts/link.sh', BAD);
    git('add', 'scripts/link.sh');
    assert.deepEqual(staged(), ['scripts/link.sh']);
    git('commit', '-qm', 'type change');
    assert.deepEqual(selectChangedSince(repo, 'main').map(source => source.path), ['scripts/link.sh']);
  });

  it('judges the staged blob when the working tree is fixed (staged-invalid, worktree-valid)', () => {
    write('scripts/a.sh', BAD);
    git('add', 'scripts/a.sh');
    write('scripts/a.sh', OK);
    assert.deepEqual(selectStaged(repo).sources, [
      { path: 'scripts/a.sh', text: BAD },
    ]);
  });

  it('judges the staged blob when only the working tree is broken (the inverse)', () => {
    write('scripts/a.sh', `${OK}echo more\n`);
    git('add', 'scripts/a.sh');
    write('scripts/a.sh', BAD);
    assert.deepEqual(selectStaged(repo).sources, [
      { path: 'scripts/a.sh', text: `${OK}echo more\n` },
    ]);
  });

  it('re-judges the whole index when the gate itself is staged', () => {
    write(`${GATE_INPUT_PREFIX}gate.ts`, 'export const changed = 1;\n');
    git('add', '-A');
    assert.deepEqual(selectStaged(repo), {
      gateChanged: true,
      sources: [
        { path: '.husky/pre-commit', text: 'echo hook\n' },
        { path: 'scripts/a.sh', text: OK },
        { path: 'scripts/b.sh', text: OK },
      ],
    });
  });

  it('re-judges the whole index when a gate file is deleted', () => {
    git('rm', '-q', `${GATE_INPUT_PREFIX}gate.ts`);
    assert.equal(selectStaged(repo).gateChanged, true);
    assert.equal((staged()).length, 3);
  });

  it('ignores a staged non-shell file, a symlink and an excluded tree', () => {
    write('docs/notes.md', 'x\n');
    write('node_modules/pkg/run.sh', BAD);
    write('.husky/_/husky.sh', BAD);
    symlinkSync('a.sh', join(repo, 'scripts/link.sh'));
    git('add', '-f', '-A');
    assert.deepEqual(staged(), []);
  });

  it('judges an extensionless script by its shebang', () => {
    write('tools/run', '#!/usr/bin/env bash\necho $1\n');
    write('tools/data', 'not a script\n');
    write('tools/zshrun', '#!/usr/bin/env zsh\necho hi\n');
    git('add', '-A');
    assert.deepEqual(staged(), ['tools/run']);
  });
});

describe('readIndexBlobs', () => {
  it('reads several blobs in one batch, byte for byte', () => {
    write('scripts/a.sh', 'first\n');
    write('scripts/b.sh', 'second\nwith\nlines');
    git('add', '-A');
    assert.deepEqual(readIndexBlobs(repo, ['scripts/a.sh', 'scripts/b.sh']), new Map([
        ['scripts/a.sh', 'first\n'],
        ['scripts/b.sh', 'second\nwith\nlines'],
      ]));
  });

  it('reads a path containing a newline on its own', () => {
    const odd = 'scripts/odd\nname.sh';
    write(odd, OK);
    git('add', '-A');
    assert.equal(readIndexBlobs(repo, [odd, 'scripts/a.sh']).get(odd), OK);
  });

  it('fails loudly on a path the index does not hold', () => {
    assert.throws(() => readIndexBlobs(repo, ['scripts/absent.sh']), /could not read staged/);
  });
});

describe('selectAll, workingTreeSources and selectChangedSince', () => {
  it('selectAll reads every tracked target from the working tree', () => {
    write('scripts/a.sh', BAD);
    assert.deepEqual(selectAll(repo).map(source => [source.path, source.text]), [
      ['.husky/pre-commit', 'echo hook\n'],
      ['scripts/a.sh', BAD],
      ['scripts/b.sh', OK],
    ]);
  });

  it('workingTreeSources fails on a named file it cannot read, naming it', () => {
    unlinkSync(join(repo, 'scripts/b.sh'));
    assert.throws(() =>
      workingTreeSources(repo, ['scripts/a.sh', 'scripts/b.sh']), /cannot read scripts\/b\.sh/);
    mkdirSync(join(repo, 'scripts/dir.sh'));
    assert.throws(() => workingTreeSources(repo, ['scripts/dir.sh']), /cannot read scripts\/dir\.sh/);
    assert.deepEqual(workingTreeSources(repo, ['scripts/a.sh', 'README.md']).map(s => s.path), ['scripts/a.sh']);
  });

  it('workingTreeSources skips a missing file only when told to', () => {
    unlinkSync(join(repo, 'scripts/b.sh'));
    assert.deepEqual(workingTreeSources(repo, ['scripts/a.sh', 'scripts/b.sh'], {
        skipMissing: true,
      }).map(s => s.path), ['scripts/a.sh']);
    // Only a missing file: one that is there but unreadable still fails.
    mkdirSync(join(repo, 'scripts/dir.sh'));
    assert.throws(() =>
      workingTreeSources(repo, ['scripts/dir.sh'], { skipMissing: true }), /cannot read scripts\/dir\.sh/);
  });

  it('selectAll skips an unstaged deletion and a tracked symlink', () => {
    symlinkSync('a.sh', join(repo, 'scripts/link.sh'));
    git('add', 'scripts/link.sh');
    unlinkSync(join(repo, 'scripts/b.sh'));
    assert.deepEqual(selectAll(repo).map(s => s.path), [
      '.husky/pre-commit',
      'scripts/a.sh',
    ]);
  });

  it('selectChangedSince judges what the branch changed', () => {
    git('checkout', '-q', '-b', 'feature');
    write('scripts/a.sh', BAD);
    write('scripts/c.sh', OK);
    git('rm', '-q', 'scripts/b.sh');
    git('add', '-A');
    git('commit', '-qm', 'change');
    assert.deepEqual(selectChangedSince(repo, 'main').map(source => source.path), ['scripts/a.sh', 'scripts/c.sh']);
  });

  it('selectChangedSince judges everything when the branch changes the gate', () => {
    git('checkout', '-q', '-b', 'feature');
    write(`${GATE_INPUT_PREFIX}gate.ts`, 'export const changed = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'gate');
    assert.equal((selectChangedSince(repo, 'main')).length, 3);
  });
});

describe('target classification', () => {
  each<[string, boolean | 'shebang']>([
    ['scripts/x.sh', true],
    ['scripts/x.bash', true],
    ['.husky/pre-push', true],
    ['.husky/_/pre-push', false],
    ['.husky/README.md', false],
    ['node_modules/a/b.sh', false],
    ['apps/web/node_modules/a/b.sh', false],
    ['apps/mobile/ios/Pods/x.sh', false],
    ['apps/mobile/android/gradlew', 'shebang'],
    ['scripts/x.ts', false],
    // The file's own name decides, not a dotted directory above it.
    ['lib.d/run', 'shebang'],
    ['odd./run', 'shebang'],
  ])('shellByName(%s) is %s', (path, expected) => {
    assert.equal(shellByName(path), expected);
  });

  it('recognises sh, bash, dash and ksh shebangs, direct or through env', () => {
    for (const line of [
      '#!/bin/sh',
      '#!/bin/bash -e',
      '#!/usr/bin/env bash',
      '#!/usr/bin/env -S bash -e',
      '#! /bin/dash',
      '#!/bin/ksh',
    ]) {
      assert.equal(hasShellShebang(`${line}\necho\n`), true, line);
    }
    for (const line of [
      '#!/usr/bin/env zsh',
      '#!/usr/bin/env node',
      '#!/bin/bashful',
      'echo',
      '',
    ]) {
      assert.equal(hasShellShebang(`${line}\n`), false, line);
    }
    assert.equal(hasShellShebang('#!/bin/sh'), true);
  });

  it('isShellTarget combines name and shebang', () => {
    assert.equal(isShellTarget('tools/run', '#!/bin/sh\n'), true);
    assert.equal(isShellTarget('tools/run', 'data\n'), false);
    assert.equal(isShellTarget('x.sh', ''), true);
    assert.equal(isHuskyHook('.husky/pre-commit'), true);
    assert.equal(isHuskyHook('scripts/pre-commit'), false);
  });
});
