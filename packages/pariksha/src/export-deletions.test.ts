import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  checkExportDeletions,
  declaredExports,
  declaredFiles,
  formatReport,
  removedExports,
  usedOutsideComments,
} from './export-deletions.ts';
import { gitAt, gitAtTop, must, resolveBase, type Git } from './git.ts';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    timeout: 30_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });

const write = (root: string, files: Record<string, string | null>) => {
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    if (body === null) rmSync(full);
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
  }
};

/** A repository whose `main` holds `before`, with HEAD one commit later holding `after`. */
const branch = (before: Record<string, string>, after: Record<string, string | null>, message = 'change'): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-exports-'));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'a@example.com');
  sh(root, 'config', 'user.name', 'a');
  sh(root, 'config', 'commit.gpgsign', 'false');
  write(root, before);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'base');
  sh(root, 'checkout', '-q', '-b', 'work');
  write(root, after);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', message);
  return root;
};

describe('trailers', () => {
  it('reads Removes-Export symbols, any case, trailing punctuation dropped', () => {
    const body = ['subject', '', 'Removes-Export: oldThing — gone', '  removes-export: other, — x', 'Removes-Export:', 'Not-A: x'].join('\n');
    assert.deepEqual(declaredExports(body), ['oldThing', 'other']);
  });

  it('reads Removes-File paths up to the reason, spaces kept', () => {
    const body = ['Removes-File: src/a b.ts — gone', 'REMOVES-FILE: src/c.ts - also gone', 'Removes-File: src/d.ts;', 'Removes-File: '].join('\n');
    assert.deepEqual(declaredFiles(body), ['src/a b.ts', 'src/c.ts', 'src/d.ts']);
  });
});

describe('removedExports and usedOutsideComments', () => {
  it('finds removed named declarations only', () => {
    const diff = [
      '-export const a = 1;',
      '-  export default async function b() {}',
      '-export abstract class C {}',
      '-export interface I {}',
      '-export type T = 1;',
      '-export enum E {}',
      '-export let l = 1;',
      '-export var v = 1;',
      '-export const enum CE {}',
      '-export declare function d(): void;',
      '-export function* gen() {}',
      '-export async function *agen() {}',
      '-export namespace N {}',
      '-export const enumLike = 1;',
      '-export { x, y };',
      '+export const added = 1;',
      '-const notExported = 1;',
    ].join('\n');
    assert.deepEqual(removedExports(diff), ['a', 'b', 'C', 'I', 'T', 'E', 'l', 'v', 'CE', 'd', 'gen', 'agen', 'N', 'enumLike']);
  });

  it('counts a code hit, not a comment', () => {
    assert.equal(usedOutsideComments('HEAD:a.ts:3:  // old a\nHEAD:b.ts:1: * a\nHEAD:c.ts:2: /* a */'), false);
    assert.equal(usedOutsideComments('HEAD:a.ts:3:  // old a\nHEAD:b.ts:9:call(a);'), true);
    assert.equal(usedOutsideComments(''), false);
  });
});

describe('checkExportDeletions', () => {
  it('refuses an export gone from the whole tree', () => {
    const root = branch({ 'src/a.ts': 'export const keep = 1;\nexport function gone() {}\n' }, { 'src/a.ts': 'export const keep = 1;\n' });
    const report = checkExportDeletions(gitAt(root), 'main');
    assert.deepEqual(report.violations, [{ symbol: 'gone', file: 'src/a.ts' }]);
    const text = formatReport(report);
    assert.equal(text.ok, false);
    assert.match(text.err[0] ?? '', /1 export\(s\) removed from the whole tree since main/);
    assert.ok(text.err.includes('  gone   (removed from src/a.ts)'));
  });

  it('stays quiet when the symbol moved, and when only a comment still names it', () => {
    const moved = branch(
      { 'src/a.ts': 'export function moved() {}\n', 'src/c.ts': 'export function onlyComment() {}\n' },
      { 'src/a.ts': '// onlyComment was here\n', 'src/b.ts': 'export function moved() {}\n', 'src/c.ts': null },
    );
    const report = checkExportDeletions(gitAt(moved), 'main');
    assert.deepEqual(report.violations, [{ symbol: 'onlyComment', file: 'src/c.ts' }]);
  });

  it('accepts a Removes-Export trailer for the symbol', () => {
    const root = branch({ 'src/a.ts': 'export const gone = 1;\nexport const x = 2;\n' }, { 'src/a.ts': 'export const x = 2;\n' }, 'drop\n\nRemoves-Export: gone — unused');
    const report = checkExportDeletions(gitAt(root), 'main');
    assert.deepEqual(report.violations, []);
    assert.deepEqual(report.declared, [{ symbol: 'gone', file: 'src/a.ts' }]);
    assert.deepEqual(formatReport(report).out, [
      'pariksha export-deletions: gone removed from src/a.ts; a Removes-Export trailer declares it',
      'pariksha export-deletions: no undeclared export removals since main',
    ]);
  });

  it('accepts Removes-File for a deleted file only', () => {
    const deleted = branch({ 'src/old.ts': 'export const a = 1;\nexport const b = 2;\n' }, { 'src/old.ts': null }, 'drop\n\nRemoves-File: src/old.ts — pipeline gone');
    const r1 = checkExportDeletions(gitAt(deleted), 'main');
    assert.deepEqual(r1.violations, []);
    assert.deepEqual(r1.declaredFiles, ['src/old.ts']);
    assert.match(formatReport(r1).out[0] ?? '', /src\/old.ts deleted; a Removes-File trailer declares its exports/);
    const kept = branch({ 'src/old.ts': 'export const a = 1;\nexport const b = 2;\n' }, { 'src/old.ts': 'export const b = 2;\n' }, 'drop\n\nRemoves-File: src/old.ts — shrunk');
    assert.deepEqual(checkExportDeletions(gitAt(kept), 'main').violations, [{ symbol: 'a', file: 'src/old.ts' }]);
  });

  it('skips build output and non-source files', () => {
    const root = branch(
      { 'dist/a.js': 'export const built = 1;\n', 'docs/a.md': 'export const doc = 1;\n', 'src/generated/g.ts': 'export const gen = 1;\n' },
      { 'dist/a.js': '', 'docs/a.md': '', 'src/generated/g.ts': '' },
    );
    assert.deepEqual(checkExportDeletions(gitAt(root), 'main').violations, []);
  });

  it('checks a repeated symbol once', () => {
    const calls: string[][] = [];
    const real = gitAt(branch({ 'a.ts': 'export const dup = 1;\n', 'b.ts': 'export const dup = 2;\n' }, { 'a.ts': '', 'b.ts': '' }));
    const counting: Git = { run: (args) => (calls.push([...args]), real.run(args)) };
    assert.equal(checkExportDeletions(counting, 'main').violations.length, 2);
    assert.equal(calls.filter((c) => c[0] === 'grep').length, 1);
  });

  it('throws on a git failure rather than reading it as no changes', () => {
    const silent: Git = { run: () => undefined };
    assert.throws(() => checkExportDeletions(silent, 'main'), /git log --format=%B main\.\.HEAD failed/);
    const noDiff: Git = { run: (args) => (args[0] === 'log' ? '' : undefined) };
    assert.throws(() => checkExportDeletions(noDiff, 'main'), /git diff --no-renames .* --name-only .* failed$/);
  });

  it('reads a comment as a mention under grep.column, and in a path with a colon', () => {
    const root = branch(
      { 'src/a.ts': 'export function gone() {}\n', 'src/x:y.ts': 'export function other() {}\n' },
      { 'src/a.ts': null, 'src/x:y.ts': '// gone was here\n// other too\n' },
    );
    sh(root, 'config', 'grep.column', 'true');
    assert.deepEqual(checkExportDeletions(gitAt(root), 'main').violations, [
      { symbol: 'gone', file: 'src/a.ts' },
      { symbol: 'other', file: 'src/x:y.ts' },
    ]);
  });

  it('reads a file renamed and edited by its old path', () => {
    const root = branch(
      { 'src/old.ts': 'export const gone = 1;\nexport const kept = 2;\nconst a = 1;\nconst b = 2;\nconst c = 3;\n' },
      { 'src/old.ts': null, 'src/new.ts': 'export const kept = 2;\nconst a = 1;\nconst b = 2;\nconst c = 3;\n' },
    );
    assert.deepEqual(checkExportDeletions(gitAt(root), 'main').violations, [{ symbol: 'gone', file: 'src/old.ts' }]);
  });

  it('reads plain diffs and greps under colour, external diff and textconv settings', () => {
    const root = branch({ 'src/a.ts': 'export const gone = 1;\n', 'src/b.ts': 'export const other = 1;\n' }, { 'src/a.ts': '', 'src/b.ts': '// other\n' });
    for (const [k, v] of [
      ['color.diff', 'always'],
      ['color.grep', 'always'],
      ['diff.external', 'false'],
      ['diff.fake.textconv', 'false'],
    ] as const)
      sh(root, 'config', k, v);
    write(root, { '.gitattributes': '*.ts diff=fake\n' });
    assert.deepEqual(checkExportDeletions(gitAt(root), 'main').violations, [
      { symbol: 'gone', file: 'src/a.ts' },
      { symbol: 'other', file: 'src/b.ts' },
    ]);
  });

  it('does not count a committed build as a use', () => {
    const root = branch({ 'src/a.ts': 'export const gone = 1;\n', 'dist/a.js': 'export const gone = 1;\n' }, { 'src/a.ts': '' });
    assert.deepEqual(checkExportDeletions(gitAt(root), 'main').violations, [{ symbol: 'gone', file: 'src/a.ts' }]);
  });

  it('reads a name git would quote, and a name with glob characters as itself', () => {
    const root = branch(
      { 'src/a"b.ts': 'export const quoted = 1;\n', 'src/[id].ts': 'export const routed = 1;\n', 'src/i.ts': 'export const other = 1;\n' },
      { 'src/a"b.ts': '', 'src/[id].ts': '', 'src/i.ts': '' },
    );
    assert.deepEqual(checkExportDeletions(gitAt(root), 'main').violations, [
      { symbol: 'routed', file: 'src/[id].ts' },
      { symbol: 'quoted', file: 'src/a"b.ts' },
      { symbol: 'other', file: 'src/i.ts' },
    ]);
  });

  it('reads a non-ASCII path whatever core.quotePath says', () => {
    const root = branch({ 'src/é.ts': 'export const gone = 1;\n' }, { 'src/é.ts': '' });
    sh(root, 'config', 'core.quotePath', 'true');
    assert.deepEqual(checkExportDeletions(gitAt(root), 'main').violations, [{ symbol: 'gone', file: 'src/é.ts' }]);
  });

  it('reports a $-named symbol that only a longer name contains', () => {
    const root = branch({ 'src/a.ts': 'export const $gone = 1;\n', 'src/b.ts': 'const xgone = 2;\n' }, { 'src/a.ts': '' });
    assert.deepEqual(checkExportDeletions(gitAt(root), 'main').violations, [{ symbol: '$gone', file: 'src/a.ts' }]);
  });
});

describe('gitAtTop and must', () => {
  it('runs at the top level from a subdirectory, and is undefined outside a repository', () => {
    const root = branch({ 'src/a.ts': 'export const gone = 1;\n' }, { 'src/a.ts': '' });
    const top = gitAtTop(join(root, 'src'));
    assert.ok(top);
    assert.deepEqual(checkExportDeletions(top, 'main').violations, [{ symbol: 'gone', file: 'src/a.ts' }]);
    assert.equal(gitAtTop(mkdtempSync(join(tmpdir(), 'pariksha-norepo-'))), undefined);
  });

  it('returns output, or throws naming the command', () => {
    assert.equal(must({ run: () => 'x' }, ['status']), 'x');
    assert.throws(() => must({ run: () => undefined }, ['status', '-s']), /^Error: git status -s failed$/);
  });
});

describe('resolveBase', () => {
  it('takes the first ref that names a commit', () => {
    const root = branch({ 'a.ts': '' }, { 'a.ts': 'x' });
    assert.equal(resolveBase(gitAt(root)), 'main');
    assert.equal(resolveBase(gitAt(root), ['nope', 'work']), 'work');
    assert.equal(resolveBase(gitAt(root), ['nope']), undefined);
  });
});
