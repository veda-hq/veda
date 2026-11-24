/**
 * SHELL-09, the module format a script runs in: `import.meta.dirname` and
 * `import.meta.filename` in a file that runs as CommonJS
 * (`no-import-meta-dirname-cjs`). `import-meta-cjs.test.ts` owns it.
 *
 * WHY. tsx runs a `.ts`, `.tsx` or `.js` file as CommonJS when its nearest
 * package.json has no `"type": "module"` (or there is none). Its CJS
 * transform defines `import.meta.url` (except in `.cts` and `.cjs` files)
 * and nothing else, so `import.meta.dirname` is undefined and
 * `resolve(import.meta.dirname, ...)` throws when the script loads. Vitest
 * runs the same file as ESM, where both exist, so the script's tests pass.
 * Measured on tsx 4.21.
 *
 * SCOPE. `.mts` and `.mjs` files always run as ESM and are never reported;
 * `.cts` and `.cjs` files always run as CommonJS and are reported whatever
 * the package says. Test files (`*.test.*`, `*.spec.*`) are skipped: Vitest
 * runs them as ESM. A package.json that cannot be read or parsed leaves the
 * format unknown, and nothing is reported.
 *
 * ACCEPTED LIMIT. A `.js` file is reported as tsx runs it. Plain Node (not
 * tsx) may run a `.js` file in a package with no `type` field as ESM, from
 * its `import.meta` syntax (module syntax detection); that is not measured
 * here, and such a file may be a false positive.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { propertyName, WRAPPERS } from './helpers.js';

/** Extensions whose format the nearest package.json decides. */
const BY_PACKAGE = new Set(['.ts', '.tsx', '.js']);

/** Extensions that always run as CommonJS. */
const ALWAYS_CJS = new Set(['.cts', '.cjs']);

/** Vitest runs these as ESM. */
const TEST_FILE = /\.(?:test|spec)\./;

/** The `import.meta` properties tsx leaves undefined under CommonJS. */
const REPLACEMENTS = {
  cjsPackage: {
    dirname: 'dirname(fileURLToPath(import.meta.url))',
    filename: 'fileURLToPath(import.meta.url)',
  },
  cjsFile: { dirname: '__dirname', filename: '__filename' },
};

/**
 * A package.json's text, null when there is none at `path`, or undefined
 * when it exists but cannot be read.
 *
 * @param {string} path
 */
function readPackageJson(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    // fail-open: a missing file means no package.json here, any other read failure an unknown format; the rule then reports nothing.
    return error.code === 'ENOENT' ? null : undefined;
  }
}

/**
 * A lookup of the module format a directory's files run in: `'module'`,
 * `'commonjs'` (no package.json up to the root, or a nearest one with no
 * `"type": "module"`) or `'unknown'` (the nearest one cannot be read or
 * parsed). Each directory is looked up once: every directory a walk passes
 * is cached with its answer.
 *
 * @param {(path: string) => string | null | undefined} [read]
 */
function packageTypeLookup(read = readPackageJson) {
  const cache = new Map();
  /** The format in `dir`: its own package.json's, else its parent's. */
  function typeIn(dir) {
    const text = read(join(dir, 'package.json'));
    if (text !== null) return formatOf(text);
    return dirname(dir) === dir ? 'commonjs' : packageTypeOf(dirname(dir));
  }
  function packageTypeOf(dir) {
    if (!cache.has(dir)) cache.set(dir, typeIn(dir));
    return cache.get(dir);
  }
  return packageTypeOf;
}

/**
 * The format a package.json's text sets, or `'unknown'` when it does not
 * parse. An unreadable one (`undefined`) does not parse either.
 */
function formatOf(text) {
  try {
    return JSON.parse(text)?.type === 'module' ? 'module' : 'commonjs';
  } catch {
    // fail-open: a package.json that cannot be read or parsed leaves the format unknown, and the rule reports nothing.
    return 'unknown';
  }
}

/** The lookup the rule uses: one per lint process. */
const packageTypeOf = packageTypeLookup();

const noImportMetaDirnameCjs = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'import.meta.dirname and import.meta.filename in a file that tsx runs as CommonJS, where they are undefined (SHELL-09)',
    },
    schema: [],
    messages: {
      cjsPackage:
        'import.meta.{{property}} is undefined when this file runs as CommonJS (its nearest package.json, if any, has no "type": "module"; tsx runs it as CJS and defines only import.meta.url there). Use {{replacement}}.',
      cjsFile:
        'import.meta.{{property}} is undefined in a {{extension}} file, which always runs as CommonJS (tsx defines not even import.meta.url there). Use {{replacement}}.',
    },
  },
  create(context) {
    const given = context.physicalFilename ?? context.filename;
    const filename = resolve(context.cwd, given);
    const name = basename(filename);
    if (TEST_FILE.test(name)) return {};
    // `<input>` and `<text>`, ESLint's names for code with no file, end in
    // `>` and so have no extension the rule knows.
    const extension = extname(name);
    if (!ALWAYS_CJS.has(extension) && !BY_PACKAGE.has(extension)) return {};
    /** The message for this file; the package lookup is cached per directory. */
    const messageFor = () =>
      ALWAYS_CJS.has(extension)
        ? 'cjsFile'
        : packageTypeOf(dirname(filename)) === 'commonjs'
          ? 'cjsPackage'
          : null;
    const report = (node, property) => {
      if (property !== 'dirname' && property !== 'filename') return;
      const id = messageFor();
      if (id === null) return;
      context.report({
        node,
        messageId: id,
        data: {
          property,
          extension,
          replacement: REPLACEMENTS[id][property],
        },
      });
    };
    return {
      MetaProperty(node) {
        // `import.meta` is the one meta property `import` starts; the other
        // is `new.target`.
        if (node.meta.name !== 'import') return;
        // Through type-only wrappers: `(import.meta as Meta).dirname`. A
        // wrapper's one expression child is its `expression`.
        let inner = node;
        while (WRAPPERS.has(inner.parent.type)) inner = inner.parent;
        const parent = inner.parent;
        // `import.meta.dirname`; as a key (`x[import.meta]`) it names nothing.
        if (parent.type === 'MemberExpression') {
          report(parent, propertyName(parent));
          return;
        }
        // `const { dirname } = import.meta`: a declarator's one expression
        // child is its `init`.
        if (
          parent.type === 'VariableDeclarator' &&
          parent.id.type === 'ObjectPattern'
        ) {
          for (const property of parent.id.properties) {
            if (property.type === 'Property' && !property.computed) {
              const { key } = property;
              report(property, key.type === 'Identifier' ? key.name : key.value);
            }
          }
        }
      },
    };
  },
};

export { noImportMetaDirnameCjs, packageTypeLookup, readPackageJson };
