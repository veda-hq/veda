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
  return function packageTypeOf(start) {
    const passed = [];
    let type = 'commonjs';
    for (let dir = start; ; dir = dirname(dir)) {
      if (cache.has(dir)) {
        type = cache.get(dir);
        break;
      }
      passed.push(dir);
      const text = read(join(dir, 'package.json'));
      if (text !== null) {
        type = formatOf(text);
        break;
      }
      if (dirname(dir) === dir) break;
    }
    for (const dir of passed) cache.set(dir, type);
    return type;
  };
}

/** The format a package.json's text sets, or `'unknown'` when unreadable. */
function formatOf(text) {
  if (text === undefined) return 'unknown';
  try {
    return JSON.parse(text)?.type === 'module' ? 'module' : 'commonjs';
  } catch {
    // fail-open: a package.json that does not parse leaves the format unknown, and the rule reports nothing.
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
    // `<input>` and `<text>`: ESLint's names for code with no file.
    if (/^<.*>$/.test(given)) return {};
    const filename = resolve(context.cwd, given);
    const name = basename(filename);
    if (TEST_FILE.test(name)) return {};
    const extension = extname(name);
    if (!ALWAYS_CJS.has(extension) && !BY_PACKAGE.has(extension)) return {};
    /** The message for this file, decided on the first hit. */
    let messageId;
    const messageFor = () => {
      if (messageId === undefined) {
        messageId = ALWAYS_CJS.has(extension)
          ? 'cjsFile'
          : packageTypeOf(dirname(filename)) === 'commonjs'
            ? 'cjsPackage'
            : null;
      }
      return messageId;
    };
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
        if (node.meta.name !== 'import' || node.property.name !== 'meta') {
          return;
        }
        // Through type-only wrappers: `(import.meta as Meta).dirname`.
        let inner = node;
        while (
          WRAPPERS.has(inner.parent.type) &&
          inner.parent.expression === inner
        ) {
          inner = inner.parent;
        }
        const parent = inner.parent;
        if (parent.type === 'MemberExpression' && parent.object === inner) {
          report(parent, propertyName(parent));
          return;
        }
        // `const { dirname } = import.meta`
        if (
          parent.type === 'VariableDeclarator' &&
          parent.init === inner &&
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

export { noImportMetaDirnameCjs, packageTypeLookup };
