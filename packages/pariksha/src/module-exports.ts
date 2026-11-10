// What a module exports, by its syntax tree: each exported name and whether
// it is a function, another value or only a type. Re-exports are followed
// (`export { a } from './x'`, `export *`, a local name bound by an import), so
// a barrel's names resolve to their declarations. Only relative specifiers are
// followed; a package specifier is reported as unfollowed, never guessed.
import { posix } from 'node:path';
import type * as TS from 'typescript';
import { isFile, readText } from './registry-ratchet.ts';
import type { Ts } from './typescript.ts';

/** What an exported name is: a function, another value, only a type, or not resolved to a declaration. */
export type ExportKind = 'function' | 'value' | 'type' | 'unresolved';

export interface ModuleExports {
  readonly exports: ReadonlyMap<string, ExportKind>;
  /** `export * from` and import specifiers that were not followed: a package, or a file that does not exist. */
  readonly unfollowed: readonly string[];
}

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

/** The root-relative file a relative specifier in `from` names, as TypeScript and bundlers resolve it, or undefined. */
export const resolveRelative = (root: string, from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
  const base = posix.join(posix.dirname(from), specifier);
  // `./x.js` in TypeScript source names `./x.ts`.
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
  const candidates = [base, ...EXTENSIONS.map((e) => `${stem}${e}`), ...EXTENSIONS.map((e) => `${base}/index${e}`)];
  return candidates.find((c) => !c.startsWith('../') && isFile(root, c));
};

/** Whether a variable's initializer makes it a function: an arrow or a function expression, through parentheses and `as`/`satisfies`. */
const isFunctionInit = (ts: Ts, init: TS.Expression | undefined): boolean => {
  let e = init;
  while (e !== undefined && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))) e = e.expression;
  return e !== undefined && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
};

const hasExport = (ts: Ts, node: TS.Node): boolean => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const hasDefault = (ts: Ts, node: TS.Node): boolean => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

type Local = { kind: ExportKind } | { from: string | undefined; specifier: string; name: string };

/** The exports of the module at `file` (root-relative), following relative re-exports. */
export const moduleExports = (ts: Ts, root: string, file: string): ModuleExports => {
  const unfollowed: string[] = [];
  const cache = new Map<string, Map<string, ExportKind>>();
  const visiting = new Set<string>();

  const exportsOf = (at: string): Map<string, ExportKind> => {
    const cached = cache.get(at);
    if (cached !== undefined) return cached;
    const out = new Map<string, ExportKind>();
    // A cycle reads as no further exports; the outer visit fills the rest.
    if (visiting.has(at)) return out;
    visiting.add(at);
    const source = readText(root, at) ?? '';
    const tree = ts.createSourceFile(at, source, ts.ScriptTarget.Latest, true);
    const locals = new Map<string, Local>();
    const follow = (specifier: string): string | undefined => {
      const target = resolveRelative(root, at, specifier);
      if (target === undefined) unfollowed.push(`${at}: '${specifier}'`);
      return target;
    };
    /** What a local name is, following an import to the module it came from. */
    const kindOfLocal = (name: string): ExportKind => {
      const local = locals.get(name);
      if (local === undefined) return 'unresolved';
      if ('kind' in local) return local.kind;
      const target = local.from ?? follow(local.specifier);
      return target === undefined ? 'unresolved' : (exportsOf(target).get(local.name) ?? 'unresolved');
    };
    const stars: string[] = [];
    const named: Array<() => void> = [];
    for (const statement of tree.statements) {
      if (ts.isFunctionDeclaration(statement)) {
        if (statement.name !== undefined) locals.set(statement.name.text, { kind: 'function' });
        // `export default function` exports `default`, a function, named or not.
        if (hasExport(ts, statement) && hasDefault(ts, statement)) out.set('default', 'function');
        else if (hasExport(ts, statement) && statement.name !== undefined) out.set(statement.name.text, 'function');
      } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        // `export default <expression>`: a function expression, or a local resolved once every local is known.
        const e = statement.expression;
        if (isFunctionInit(ts, e)) out.set('default', 'function');
        else if (ts.isIdentifier(e)) named.push(() => out.set('default', kindOfLocal(e.text)));
        else out.set('default', 'value');
      } else if (ts.isVariableStatement(statement)) {
        for (const d of statement.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const kind: ExportKind = isFunctionInit(ts, d.initializer) ? 'function' : 'value';
          locals.set(d.name.text, { kind });
          if (hasExport(ts, statement)) out.set(d.name.text, kind);
        }
      } else if (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
        // An enum always has a name; a default class may not.
        const name = statement.name?.text;
        if (name !== undefined) locals.set(name, { kind: 'value' });
        if (hasExport(ts, statement) && hasDefault(ts, statement)) out.set('default', 'value');
        else if (hasExport(ts, statement) && name !== undefined) out.set(name, 'value');
      } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        locals.set(statement.name.text, { kind: 'type' });
        if (hasExport(ts, statement)) out.set(statement.name.text, 'type');
      } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause !== undefined) {
        const clause = statement.importClause;
        const specifier = statement.moduleSpecifier.text;
        // A default import is the module's `default` export, followed like a named one.
        if (clause.name !== undefined) locals.set(clause.name.text, clause.isTypeOnly ? { kind: 'type' } : { from: undefined, specifier, name: 'default' });
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) locals.set(bindings.name.text, { kind: clause.isTypeOnly ? 'type' : 'value' });
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            locals.set(el.name.text, clause.isTypeOnly || el.isTypeOnly ? { kind: 'type' } : { from: undefined, specifier, name: (el.propertyName ?? el.name).text });
          }
        }
      } else if (ts.isExportDeclaration(statement)) {
        const spec = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
        const clause = statement.exportClause;
        if (clause === undefined) {
          if (spec !== undefined && !statement.isTypeOnly) stars.push(spec);
        } else if (ts.isNamespaceExport(clause)) {
          out.set(clause.name.text, statement.isTypeOnly ? 'type' : 'value');
        } else {
          for (const el of clause.elements) {
            const exported = el.name.text;
            const original = (el.propertyName ?? el.name).text;
            if (statement.isTypeOnly || el.isTypeOnly) {
              out.set(exported, 'type');
              continue;
            }
            // Resolved after every local is known: an export list may precede the declarations it names.
            named.push(() => {
              if (spec === undefined) out.set(exported, kindOfLocal(original));
              else {
                const target = follow(spec);
                out.set(exported, target === undefined ? 'unresolved' : (exportsOf(target).get(original) ?? 'unresolved'));
              }
            });
          }
        }
      }
    }
    for (const resolve of named) resolve();
    for (const spec of stars) {
      const target = follow(spec);
      if (target === undefined) continue;
      for (const [name, kind] of exportsOf(target)) if (name !== 'default' && !out.has(name)) out.set(name, kind);
    }
    visiting.delete(at);
    cache.set(at, out);
    return out;
  };

  return { exports: exportsOf(file), unfollowed: [...new Set(unfollowed)] };
};
