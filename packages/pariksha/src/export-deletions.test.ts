import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  checkExportDeletions,
  declaredExports,
  declaredFiles,
  formatReport,
  removedAliases,
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

const temps: string[] = [];
/** A fresh temporary directory, removed when this file's tests end. */
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
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
  const root = temp('pariksha-exports-');
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'a@example.com');
  sh(root, 'config', 'user.name', 'a');
  sh(root, 'config', 'commit.gpgsign', 'false');
  // No detached auto-maintenance after a commit: it could write into the fixture as it is removed.
  sh(root, 'config', 'maintenance.auto', 'false');
  sh(root, 'config', 'gc.auto', '0');
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

  it('reads a comma list of symbols before the reason, so one line declares a module', () => {
    const body = ['Removes-Export: a, b,c — the module is gone', 'Removes-Export: d , e - also gone', 'Removes-Export: f, g', 'Removes-Export: h – en dash'].join('\n');
    assert.deepEqual(declaredExports(body), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('never declares a word of the reason: anything but a clean list names its first word only', () => {
    const body = ['Removes-Export: one, two words — why', 'Removes-Export: lone, because x, y', 'Removes-Export: p,q extra', 'Removes-Export: a.b, c — x'].join('\n');
    assert.deepEqual(declaredExports(body), ['a.b', 'lone', 'one', 'p,q']);
  });

  it('reads a list of longer names, a trailing space, a wider gap and doubled punctuation, and only a trailer that starts its line', () => {
    const body = [
      'Removes-Export: alpha, beta — gone',
      'Removes-Export: m, n ',
      'Removes-Export:  lone, because x',
      '  Removes-Export: thing),',
      'See-Removes-Export: nope',
    ].join('\n');
    assert.deepEqual(declaredExports(body), ['alpha', 'beta', 'lone', 'm', 'n', 'thing']);
  });

  it('reads a Removes-File path whole: indented, a trailing space, a comma inside, doubled punctuation, a bare dash reason', () => {
    const body = [
      '  Removes-File: src/in dented.ts — why',
      'Removes-File: src/b.ts ',
      'Removes-File: dir/a,b.ts — x',
      'Removes-File: src/c.ts),',
      'Removes-File: — no path',
      'Removes-File:',
      'See-Removes-File: nope.ts',
    ].join('\n');
    assert.deepEqual(declaredFiles(body), ['dir/a,b.ts', 'src/b.ts', 'src/c.ts', 'src/in dented.ts']);
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
      '-export  const wide = 1;',
      '-export default  function dflt() {}',
      '-export declare  const dcl: number;',
      '-export async  function asy() {}',
      '-export abstract  class Abs {}',
      '-export const  enum WideEnum {}',
      "+log('-export const fake = 1');",
      '-export { x, y };',
      '+export const added = 1;',
      '-const notExported = 1;',
    ].join('\n');
    assert.deepEqual(removedExports(diff), ['a', 'b', 'C', 'I', 'T', 'E', 'l', 'v', 'CE', 'd', 'gen', 'agen', 'N', 'enumLike', 'wide', 'dflt', 'dcl', 'asy', 'Abs', 'WideEnum']);
  });

  it('finds the aliases an export list loses, never its bare names or `as default`', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,2 +0,0 @@',
      "-export { internal as publicApi } from './internal.js';",
      "-  export type { Shape as PublicShape, bare } from './shape.js';",
      '@@ -4 +2 @@',
      "-export { type Raw as Cooked, default as Widget, kept,x  as  y, local as default } from './w.js';",
      '+export { other };',
      '@@ -9,4 +6,0 @@',
      '-export {',
      '-  first as One,',
      '-  second,',
      "-} from './many.js';",
      '@@ -20 +18 @@',
      '-// export { commented as Out }',
      '-const notAList = 1; export { trailing as Late };',
      '@@ -30 +28 @@',
      '-  loose as Stray,',
      '+  loose,',
      "-export { last as Final } from './l.js';",
      '-export  { wide as Wide };',
      '-export type  { WideType as PublicWide, type  Inner as Outer, not valid as Bad, x as Y z };',
    ].join('\n');
    assert.deepEqual(removedExports(diff), ['publicApi', 'PublicShape', 'Cooked', 'Widget', 'y', 'One', 'Final', 'Wide', 'PublicWide', 'Outer']);
  });

  it('reads a list only where removed lines hold it whole, never across a line the diff keeps or adds', () => {
    const diff = [
      '@@ -1 +0,0 @@',
      "-export { a as A } from './a.js';",
      '@@ -3,3 +1,2 @@',
      '-export {',
      '+  added as Added,',
      '-  orphan as Orphan,',
      '-}',
      '+export { fresh as New };',
      '-// a note',
      "-export { b as B } from './b.js';",
    ].join('\n');
    assert.deepEqual(removedExports(diff), ['A', 'B']);
    assert.deepEqual(removedAliases("export {\n  a as A,\n} from './a.js';\nexport { b as B }"), ['A', 'B']);
    assert.deepEqual(removedAliases('export {\0\n  a as A }'), []);
    const commented = "export {\n  /** the public name */\n  a as A, // a note, with a comma\n  /*x*/ b as B /* y */,\n  c as C, // last\n} from './a.js';";
    assert.deepEqual(removedAliases(commented), ['A', 'B', 'C']);
  });

  it('counts a code hit, not a comment', () => {
    assert.equal(usedOutsideComments('HEAD:a.ts:3:  // old a\nHEAD:b.ts:1: * a\nHEAD:c.ts:2: /* a */'), false);
    assert.equal(usedOutsideComments('HEAD:a.ts:3:  // old a\nHEAD:b.ts:9:call(a);'), true);
    assert.equal(usedOutsideComments('HEAD:a.ts:12:  // old a'), false);
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

  it('refuses an export that only a test still names, at the root or nested, as .test or .spec', () => {
    const root = branch(
      {
        'src/a.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const moved = 5;\n',
        'a.test.ts': 'import { a } from "./src/a.ts";\n',
        'src/deep/b.test.mjs': 'b();\n',
        'c.spec.js': 'c();\n',
        'src/deep/d.spec.tsx': 'd();\n',
        'src/testing.ts': 'export const moved = 5;\n',
      },
      { 'src/a.ts': '' },
    );
    assert.deepEqual(checkExportDeletions(gitAt(root), 'main').violations, [
      { symbol: 'a', file: 'src/a.ts' },
      { symbol: 'b', file: 'src/a.ts' },
      { symbol: 'c', file: 'src/a.ts' },
      { symbol: 'd', file: 'src/a.ts' },
    ]);
  });

  it('refuses an aliased re-export whose alias no source names, quiet while one does', () => {
    const root = branch(
      {
        'src/index.ts': "export { internal as publicApi } from './internal.js';\nexport { other as stillUsed } from './internal.js';\nexport { bare } from './internal.js';\n",
        'src/internal.ts': 'export const internal = 1;\nexport const other = 2;\nexport const bare = 3;\n',
        'src/user.ts': 'stillUsed();\n',
      },
      { 'src/index.ts': '' },
    );
    assert.deepEqual(checkExportDeletions(gitAt(root), 'main').violations, [{ symbol: 'publicApi', file: 'src/index.ts' }]);
    const declared = branch(
      { 'src/index.ts': "export { internal as publicApi } from './internal.js';\n", 'src/internal.ts': 'export const internal = 1;\n' },
      { 'src/index.ts': '' },
      'drop\n\nRemoves-Export: publicApi — no longer public',
    );
    assert.deepEqual(checkExportDeletions(gitAt(declared), 'main').declared, [{ symbol: 'publicApi', file: 'src/index.ts' }]);
  });

  it('prints the whole of a pass and of a refusal', () => {
    assert.deepEqual(formatReport({ base: 'main', violations: [], declared: [], declaredFiles: [] }), {
      ok: true,
      out: ['pariksha export-deletions: no undeclared export removals since main'],
      err: [],
    });
    assert.deepEqual(formatReport({ base: 'origin/main', violations: [{ symbol: 'gone', file: 'src/a.ts' }, { symbol: 'publicApi', file: 'src/index.ts' }], declared: [], declaredFiles: ['src/old.ts'] }), {
      ok: false,
      out: ['pariksha export-deletions: src/old.ts deleted; a Removes-File trailer declares its exports'],
      err: [
        'pariksha export-deletions: 2 export(s) removed from the whole tree since origin/main with no stated reason:',
        '  gone   (removed from src/a.ts)',
        '  publicApi   (removed from src/index.ts)',
        '',
        'Each is gone from every source file but the tests, not moved or renamed. If the removal is intended,',
        'say so in a commit body:',
        '',
        '  Removes-Export: <symbol> — <why it is safe to remove>',
        '',
        "One line can name several, so a module's exports fit a short commit body:",
        '',
        '  Removes-Export: <a>, <b>, <c> — <why they are safe to remove>',
        '',
        'A file deleted outright can be declared once, covering all its exports:',
        '',
        '  Removes-File: <path> — <why the file is gone>',
      ],
    });
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

  it('accepts one Removes-Export line naming every symbol a module lost', () => {
    const root = branch({ 'src/a.ts': 'export const p = 1;\nexport const q = 2;\nexport function r() {}\nexport const x = 3;\n' }, { 'src/a.ts': 'export const x = 3;\n' }, 'drop\n\nRemoves-Export: p, q, r — the old API');
    const report = checkExportDeletions(gitAt(root), 'main');
    assert.deepEqual(report.violations, []);
    assert.deepEqual(
      report.declared.map((d) => d.symbol),
      ['p', 'q', 'r'],
    );
    assert.ok(formatReport({ ...report, violations: [{ symbol: 's', file: 'src/a.ts' }] }).err.includes('  Removes-Export: <a>, <b>, <c> — <why they are safe to remove>'));
  });

  it('accepts Removes-File for a deleted file only', () => {
    const deleted = branch({ 'src/old.ts': 'export const a = 1;\nexport const b = 2;\n' }, { 'src/old.ts': null }, 'drop\n\nRemoves-File: src/old.ts — pipeline gone');
    const r1 = checkExportDeletions(gitAt(deleted), 'main');
    assert.deepEqual(r1.violations, []);
    assert.deepEqual(r1.declaredFiles, ['src/old.ts']);
    assert.match(formatReport(r1).out[0] ?? '', /src\/old.ts deleted; a Removes-File trailer declares its exports/);
    const kept = branch({ 'src/old.ts': 'export const a = 1;\nexport const b = 2;\n' }, { 'src/old.ts': 'export const b = 2;\n' }, 'drop\n\nRemoves-File: src/old.ts — shrunk');
    assert.deepEqual(checkExportDeletions(gitAt(kept), 'main').violations, [{ symbol: 'a', file: 'src/old.ts' }]);
    const noExports = branch({ 'src/plain.ts': 'const a = 1;\n' }, { 'src/plain.ts': null }, 'drop\n\nRemoves-File: src/plain.ts — nothing exported');
    assert.deepEqual(checkExportDeletions(gitAt(noExports), 'main').declaredFiles, [], 'a file that exported nothing has no exports to declare');
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
    assert.equal(gitAtTop(temp('pariksha-norepo-')), undefined);
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
