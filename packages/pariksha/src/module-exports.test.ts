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
/**
 * TypeScript that refuses to parse a file twice, recording what it parsed:
 * each module is read once, so a cycle that is not ended throws here at
 * once rather than running on.
 */
const once = (parsed: string[] = []): Ts => ({
  ...ts,
  createSourceFile: (...args: Parameters<Ts['createSourceFile']>) => {
    if (parsed.includes(args[0])) throw new Error(`${args[0]} parsed twice`);
    parsed.push(args[0]);
    return ts.createSourceFile(...args);
  },
});
/** The exports of `m.ts` among these files, as a plain object. */
const of = (files: Record<string, string>): { exports: Record<string, string>; unfollowed: readonly string[] } => {
  const found = moduleExports(once(), repo(files), 'm.ts');
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

  it('tries each source extension, by stem and as a folder index', () => {
    const exts = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];
    const r = repo(Object.fromEntries(exts.flatMap((e, i) => [[`f${String(i)}${e}`, ''], [`d${String(i)}/index${e}`, '']])));
    assert.deepEqual(
      exts.map((_, i) => resolveRelative(r, 'm.ts', `./f${String(i)}`)),
      ['f0.ts', 'f1.tsx', 'f2.mts', 'f3.cts', 'f4.js', 'f5.mjs', 'f6.cjs', 'f7.jsx'],
    );
    assert.deepEqual(
      exts.map((_, i) => resolveRelative(r, 'm.ts', `./d${String(i)}`)),
      ['d0/index.ts', 'd1/index.tsx', 'd2/index.mts', 'd3/index.cts', 'd4/index.js', 'd5/index.mjs', 'd6/index.cjs', 'd7/index.jsx'],
    );
  });

  it('reads `.mjs` as naming `.mts`, and `.js` only as the whole extension', () => {
    const r = repo({ 'a.mts': '', 'b.json.ts': '' });
    assert.equal(resolveRelative(r, 'm.ts', './a.mjs'), 'a.mts');
    assert.equal(resolveRelative(r, 'm.ts', './b.json'), 'b.json.ts');
  });

  it('follows no file outside the root, even one that is there', () => {
    const parent = repo({ 'outside.ts': '', 'in/m.ts': '' });
    assert.equal(resolveRelative(join(parent, 'in'), 'm.ts', '../outside'), undefined);
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

  it('exports only what is exported, and resolves a list to each local by its kind', () => {
    const source = [
      'const hidden = 1;',
      'let bare;',
      'export let open;',
      'class Hidden {}',
      'class C {}',
      'enum E { A }',
      'interface HiddenI {}',
      'interface I {}',
      'type T = 1;',
      'function f() {}',
      "import { missing } from './x';",
      "import { type Ty } from './x';",
      "import type { Ty2 } from './x';",
      "import './side-effect';",
      // A specifier that is no string names no module to follow.
      'import y from z;',
      'export { C, E, I, T, bare, missing, Ty, Ty2, y };',
      "export type * from './x';",
      'export class {}',
    ].join('\n');
    // Imported as types, Ty and Ty2 are types here, whatever x.ts holds.
    assert.deepEqual(of({ 'm.ts': source, 'x.ts': 'export const shown = 1;\nexport const Ty = 1;\nexport const Ty2 = 2;\n', 'side-effect.ts': '' }), {
      exports: {
        open: 'value',
        C: 'value',
        E: 'value',
        I: 'type',
        T: 'type',
        bare: 'value',
        missing: 'unresolved',
        Ty: 'type',
        Ty2: 'type',
        y: 'unresolved',
      },
      unfollowed: [],
    });
    assert.deepEqual(of({ 'm.ts': 'export default class {}\nclass K {}\nexport { K };\n' }).exports, { default: 'value', K: 'value' });
    assert.deepEqual(of({ 'm.ts': 'const a = 1;\nexport { a };\n' }).exports, { a: 'value' });
    // An import for its side effects re-exports nothing; nor does a star that names no module.
    assert.deepEqual(of({ 'm.ts': "import './side';\nexport * ;\n", 'side.ts': 'export const s = 1;\n' }), { exports: {}, unfollowed: [] });
  });

  it('parses each module once, however often and however circularly it is reached', () => {
    const parsed: string[] = [];
    const counting = once(parsed);
    const root = repo({
      'm.ts': "export * from './b';\nexport * from './c';\n",
      'b.ts': "export * from './d';\nexport * from './m';\n",
      'c.ts': "export * from './d';\n",
      'd.ts': 'export const d = 1;\n',
    });
    assert.deepEqual(Object.fromEntries(moduleExports(counting, root, 'm.ts').exports), { d: 'value' });
    assert.deepEqual(parsed.sort(), ['b.ts', 'c.ts', 'd.ts', 'm.ts']);
  });

  it('reads a module that does not exist as one exporting nothing', () => {
    assert.deepEqual(moduleExports(once(), repo({}), 'gone.ts'), { exports: new Map(), unfollowed: [] });
  });
});
