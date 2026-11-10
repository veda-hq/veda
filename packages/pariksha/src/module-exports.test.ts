import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { moduleExports, resolveRelative } from './module-exports.ts';
import { loadTypescript, type Ts } from './typescript.ts';

const loaded = loadTypescript();
if (typeof loaded === 'string') throw new Error(loaded);
const ts: Ts = loaded;

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-exports-'));
  roots.push(root);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
};
/** The exports of `m.ts` among these files, as a plain object. */
const of = (files: Record<string, string>): { exports: Record<string, string>; unfollowed: readonly string[] } => {
  const found = moduleExports(ts, repo(files), 'm.ts');
  return { exports: Object.fromEntries(found.exports), unfollowed: found.unfollowed };
};

describe('resolveRelative', () => {
  const root = repo({ 'src/a.ts': '', 'src/b/index.ts': '', 'src/c.mjs': '', 'top.ts': '' });

  it('resolves a relative specifier as TypeScript does: as written, by extension, .js naming .ts, or a folder index', () => {
    assert.equal(resolveRelative(root, 'src/m.ts', './a.ts'), 'src/a.ts');
    assert.equal(resolveRelative(root, 'src/m.ts', './a'), 'src/a.ts');
    assert.equal(resolveRelative(root, 'src/m.ts', './a.js'), 'src/a.ts');
    assert.equal(resolveRelative(root, 'src/m.ts', './b'), 'src/b/index.ts');
    assert.equal(resolveRelative(root, 'src/m.ts', './c.mjs'), 'src/c.mjs');
    assert.equal(resolveRelative(root, 'src/m.ts', '../top'), 'top.ts');
  });

  it('follows no package specifier, no missing file, and nothing outside the root', () => {
    assert.equal(resolveRelative(root, 'src/m.ts', '@acme/a'), undefined);
    assert.equal(resolveRelative(root, 'src/m.ts', 'a'), undefined);
    assert.equal(resolveRelative(root, 'src/m.ts', './gone'), undefined);
    assert.equal(resolveRelative(root, 'top.ts', '../outside'), undefined);
  });
});

describe('moduleExports', () => {
  it('tells a function from another value and from a type', () => {
    const source = [
      'export function f() {}',
      'export async function g() {}',
      'export const h = () => 1, n = 2;',
      'export const p = (function () {});',
      'export const q = (() => 1) as () => number;',
      'export const s = (() => 1) satisfies () => number;',
      'export let v = 1;',
      'export const { destructured } = { destructured: 1 };',
      'export class C {}',
      'export enum E { A }',
      'export interface I {}',
      'export type T = string;',
      'export default function d() {}',
      'function local() {}',
    ].join('\n');
    assert.deepEqual(of({ 'm.ts': source }), {
      exports: { f: 'function', g: 'function', h: 'function', n: 'value', p: 'function', q: 'function', s: 'function', v: 'value', C: 'value', E: 'value', I: 'type', T: 'type', default: 'function' },
      unfollowed: [],
    });
  });

  it('resolves an export list against locals declared after it, and imports followed to their modules', () => {
    const source = [
      "import def, { a as aa, type B, c } from './x';",
      "import type { D } from './x';",
      "import * as ns from './x';",
      "import type * as tns from './x';",
      "import type Tdef from './x';",
      "import './side-effect';",
      'export { aa, B, c, D, ns, tns, def, Tdef, later, missing, later as renamed };',
      'function later() {}',
    ].join('\n');
    const x = 'export function a() {}\nexport type B = 1;\nexport const c = 1;\nexport type D = 2;\nexport default class K {}\n';
    assert.deepEqual(of({ 'm.ts': source, 'x.ts': x }).exports, {
      aa: 'function',
      B: 'type',
      c: 'value',
      D: 'type',
      ns: 'value',
      tns: 'type',
      def: 'value',
      Tdef: 'type',
      later: 'function',
      missing: 'unresolved',
      renamed: 'function',
    });
  });

  it('marks a type-only re-export a type, and follows a named re-export to its declaration', () => {
    const source = "export type { a } from './x';\nexport { type b, c as cc, gone } from './x';\nexport { d } from './nowhere';\nexport * as space from './x';\nexport type * as tspace from './x';\n";
    const x = 'export function a() {}\nexport function b() {}\nexport const c = () => 1;\n';
    assert.deepEqual(of({ 'm.ts': source, 'x.ts': x }), {
      exports: { a: 'type', b: 'type', cc: 'function', gone: 'unresolved', d: 'unresolved', space: 'value', tspace: 'type' },
      unfollowed: ["m.ts: './nowhere'"],
    });
  });

  it('takes the names of export *, never its default and never over a name the module exports itself', () => {
    const source = "export * from './x';\nexport * from './y';\nexport type * from './z';\nexport const shared = 1;\n";
    assert.deepEqual(of({ 'm.ts': source, 'x.ts': 'export function a() {}\nexport function shared() {}\nexport default function d() {}\nexport { a as default };\n', 'y.ts': 'export type Y = 1;\nexport function a() {}\n', 'z.ts': 'export function z() {}\n' }).exports, {
      shared: 'value',
      a: 'function',
      Y: 'type',
    });
  });

  it('follows a chain through folders and reports a star it could not follow', () => {
    const files = { 'm.ts': "export * from './lib';\nexport * from '@acme/pkg';\nexport * from './gone';\n", 'lib/index.ts': "export * from './deep.js';\n", 'lib/deep.ts': 'export function deep() {}\n' };
    assert.deepEqual(of(files), { exports: { deep: 'function' }, unfollowed: ["m.ts: '@acme/pkg'", "m.ts: './gone'"] });
  });

  it('reports an import it could not follow once, however often it is named', () => {
    const files = { 'm.ts': "import { a, b } from '@acme/pkg';\nexport { a, b };\n" };
    assert.deepEqual(of(files), { exports: { a: 'unresolved', b: 'unresolved' }, unfollowed: ["m.ts: '@acme/pkg'"] });
  });

  it('ends a cycle of re-exports, keeping what each module declares', () => {
    const files = { 'm.ts': "export * from './x';\nexport function m() {}\n", 'x.ts': "export * from './m';\nexport function x() {}\n" };
    assert.deepEqual(of(files).exports, { m: 'function', x: 'function' });
  });

  it('records each default export’s kind and follows it, re-exported or imported', () => {
    const kinds = {
      'fn.ts': 'export default function () {}\n',
      'named-fn.ts': 'export default function impl() {}\n',
      'arrow.ts': 'export default async () => {};\n',
      'cls.ts': 'export default class {}\n',
      'local.ts': 'const run = () => 1;\nexport default run;\n',
      'later.ts': 'export default run;\nfunction run() {}\n',
      'obj.ts': 'export default { a: 1 };\n',
      'list.ts': 'function go() {}\nexport { go as default };\n',
      'eq.ts': 'export = 1;\n',
    };
    const source = [
      "export { default as fn } from './fn';",
      "export { default as namedFn } from './named-fn';",
      "export { default as arrow } from './arrow';",
      "export { default as cls } from './cls';",
      "export { default as local } from './local';",
      "export { default as later } from './later';",
      "export { default as obj } from './obj';",
      "export { default as list } from './list';",
      "export { default as eq } from './eq';",
      "import imported from './fn';",
      "import pkg from '@acme/pkg';",
      'export { imported, pkg };',
    ].join('\n');
    assert.deepEqual(of({ 'm.ts': source, ...kinds }), {
      exports: { fn: 'function', namedFn: 'function', arrow: 'function', cls: 'value', local: 'function', later: 'function', obj: 'value', list: 'function', eq: 'unresolved', imported: 'function', pkg: 'unresolved' },
      unfollowed: ["m.ts: '@acme/pkg'"],
    });
  });

  it('reads a module that does not exist as one exporting nothing', () => {
    assert.deepEqual(moduleExports(ts, repo({}), 'gone.ts'), { exports: new Map(), unfollowed: [] });
  });
});
