/**
 * The test-lint plugin's assertion-hygiene rules for silent early returns,
 * owned fixture removal and copied SQL oracles. `c05.test.ts`, the suite
 * that tests them, owns them. The plugin entry passes in the shared helpers,
 * so the import runs one way only. The plugin, its rule names and its config
 * blocks stay in the family entry.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function c05Rules({
  isFunction,
  unwrap,
  propertyName,
  registration,
  variableOf,
  constInit,
}) {
  // ---------------------------------------------------------------------------
  // Silent early returns, owned fixture removal, copied SQL oracles
  //
  // These extend the test-lint plugin rather than adding a second one: the
  // three rules below share its registration and assertion helpers. Each is
  // narrow on purpose; regression controls in the suites that use them carry
  // the semantic part a linter cannot prove.
  // ---------------------------------------------------------------------------

  /**
   * The AST nodes directly under `node`: every field but the back-link to
   * its parent (which would walk upward), arrays expanded. Array holes,
   * `range` numbers and `loc` objects are not nodes.
   */
  function childNodes(node) {
    return Object.values(node)
      .filter(value => value !== node.parent)
      .flat()
      .filter(child => typeof child?.type === 'string');
  }

  /** Does `root` or a node under it satisfy `test`? Nested functions are skipped. */
  function someNode(root, test) {
    const visit = node =>
      test(node) ||
      ((node === root || !isFunction(node)) && childNodes(node).some(visit));
    return visit(root);
  }

  /**
   * `expect(…)`, `expect.soft(…)`, `expect.fail(…)` or a helper named
   * `expect*`/`assert*`. Searched with {@link someNode}, so a matcher chain
   * `expect(x).toBe(y)` is found through the `expect(x)` call inside it.
   */
  function isAssertionLike(node) {
    if (node.type !== 'CallExpression') return false;
    const callee = unwrap(node.callee);
    if (callee.type === 'Identifier')
      return /^(expect|assert)/.test(callee.name);
    if (
      callee.type === 'MemberExpression' &&
      callee.object.type === 'Identifier' &&
      callee.object.name === 'expect'
    ) {
      return true;
    }
    return false;
  }

  /** `expect.hasAssertions()` / `expect.assertions(n)`: a return without one fails. */
  function isAssertionCount(node) {
    return (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.object.type === 'Identifier' &&
      node.callee.object.name === 'expect' &&
      ['hasAssertions', 'assertions'].includes(propertyName(node.callee))
    );
  }

  /** `console.log(...)` and its siblings. */
  function isConsoleCall(node) {
    if (node.type !== 'CallExpression') return false;
    const callee = unwrap(node.callee);
    return (
      callee.type === 'MemberExpression' &&
      callee.object.type === 'Identifier' &&
      callee.object.name === 'console'
    );
  }

  /** `return;`, `return undefined;` or `return void x;`. */
  function isBareReturn(statement) {
    const argument = statement.argument ? unwrap(statement.argument) : null;
    return (
      argument === null ||
      (argument.type === 'Identifier' && argument.name === 'undefined') ||
      (argument.type === 'UnaryExpression' && argument.operator === 'void')
    );
  }

  const noSilentEarlyReturn = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'A test never returns early before its first assertion (oracle family)',
      },
      schema: [],
      messages: {
        silentReturn:
          'This test returns before any assertion, so every case that takes this path passes having checked nothing (a parity oracle that "agrees" on nothing). Assert the condition you are returning on, filter those cases out of the table and assert the rest is non-empty, or call `expect.hasAssertions()`.',
        loggedSkip:
          'This branch logs and returns, so the run reports the test passed while the assertions after it never ran. Skip visibly with the test context (`ctx.skip(reason)`) or `it.skipIf`, so the report says skipped.',
      },
    },
    create(context) {
      return {
        CallExpression(node) {
          const owner = registration(node, context);
          if (!owner || owner.kind !== 'test' || !owner.callback) return;
          const body = owner.callback.body;
          if (body.type !== 'BlockStatement') return;
          if (someNode(body, isAssertionCount)) return;
          const statements = body.body;
          statements.forEach((statement, index) => {
            if (statement.type !== 'IfStatement' || statement.alternate) return;
            const consequent = statement.consequent;
            const path =
              consequent.type === 'BlockStatement'
                ? consequent.body
                : [consequent];
            const exit = path.at(-1);
            if (exit?.type !== 'ReturnStatement' || !isBareReturn(exit)) return;
            const asserts = list =>
              list.some(item => someNode(item, isAssertionLike));
            if (asserts(path)) return;
            // Nothing is skipped when no assertion follows (expect-expect's job).
            if (!asserts(statements.slice(index + 1))) return;
            // A branch that logs and returns is a hand-rolled skip: the run
            // reports the test passed while the assertions after it never ran,
            // whatever was asserted before.
            if (path.some(item => someNode(item, isConsoleCall))) {
              context.report({ node: exit, messageId: 'loggedSkip' });
              return;
            }
            // The return path asserted something before the branch.
            if (asserts(statements.slice(0, index))) return;
            context.report({ node: exit, messageId: 'silentReturn' });
          });
        },
      };
    },
  };

  const FS_MODULES = new Set([
    'fs',
    'node:fs',
    'fs/promises',
    'node:fs/promises',
  ]);
  const REMOVERS = new Set(['rmSync', 'rm', 'rmdirSync', 'rmdir']);
  /**
   * Calls whose result is a directory this test created for itself. A
   * repository adds its own fixture helpers through the `ownedRootCalls`
   * option of the rules that read this set.
   */
  const OWNED_ROOT_CALLS = new Set(['mkdtempSync', 'mkdtemp']);

  /** Is `identifier` bound by an import from `fs`/`fs/promises`? */
  function isFsBinding(identifier, context) {
    const variable = variableOf(identifier, context);
    const def = variable?.defs[0];
    return (
      def?.type === 'ImportBinding' && FS_MODULES.has(def.parent.source.value)
    );
  }

  /** `rmSync(…)`, `fs.rm(…)`, `fs.promises.rm(…)` → the method; else null. */
  function removerOf(call, context) {
    const callee = unwrap(call.callee);
    if (callee.type === 'Identifier') {
      return REMOVERS.has(callee.name) && isFsBinding(callee, context)
        ? callee.name
        : null;
    }
    const name = propertyName(callee);
    if (!name || !REMOVERS.has(name)) return null;
    let object = unwrap(callee.object);
    if (
      object.type === 'MemberExpression' &&
      propertyName(object) === 'promises'
    )
      object = unwrap(object.object);
    if (object.type !== 'Identifier') return null;
    return isFsBinding(object, context) || ['fs', 'fsp'].includes(object.name)
      ? name
      : null;
  }

  /** An options literal with `recursive: true`. */
  function isRecursive(options) {
    const value = unwrap(options);
    return (
      value?.type === 'ObjectExpression' &&
      value.properties.some(
        property =>
          property.type === 'Property' &&
          !property.computed &&
          (property.key.name ?? property.key.value) === 'recursive' &&
          property.value.type === 'Literal' &&
          property.value.value === true,
      )
    );
  }

  /**
   * A path this test provably created: the result of one of `owned` (an
   * `mkdtemp`), or a plain child of one.
   */
  function isOwnedRoot(node, context, owned, depth = 0) {
    let value = unwrap(node);
    if (value?.type === 'AwaitExpression') value = unwrap(value.argument);
    if (!value || depth > 3) return false;
    if (value.type === 'Identifier') {
      const init = constInit(value, context);
      return Boolean(init) && isOwnedRoot(init, context, owned, depth + 1);
    }
    if (value.type !== 'CallExpression') return false;
    const callee = unwrap(value.callee);
    const name =
      callee.type === 'Identifier' ? callee.name : propertyName(callee);
    if (owned.has(name)) return true;
    const [first, ...rest] = value.arguments;
    if (name === 'realpathSync' || name === 'realpath')
      return isOwnedRoot(first, context, owned, depth + 1);
    // `join(root, 'sub')` stays inside root; `..` or a computed segment may not.
    if (name === 'join') {
      return (
        isOwnedRoot(first, context, owned, depth + 1) &&
        rest.every(
          part =>
            part.type === 'Literal' &&
            typeof part.value === 'string' &&
            !part.value.split(/[\\/]/).some(segment => segment === '..'),
        )
      );
    }
    return false;
  }

  const OWNED_REMOVAL_DEFAULTS = {
    /** Further calls whose result is a directory the test owns. */
    ownedRootCalls: [],
    /** The guarded removal helper the message points to. */
    removeHelper: 'removeFixtureRoot',
    /** Where it lives, named in the message. */
    removeHelperModule: '',
  };

  const ownedFixtureRemoval = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Tests remove only directories they own (fixture family)',
      },
      schema: [
        {
          type: 'object',
          properties: {
            ownedRootCalls: { type: 'array', items: { type: 'string' } },
            removeHelper: { type: 'string' },
            removeHelperModule: { type: 'string' },
          },
          additionalProperties: false,
        },
      ],
      defaultOptions: [OWNED_REMOVAL_DEFAULTS],
      messages: {
        unowned:
          'A recursive `{{method}}` in a test deletes whatever this path resolves to; a cleanup like this once deleted the real generated Prisma client. Remove fixture roots with `{{removeHelper}}()`{{from}}, which refuses any path outside the OS temp directory, or remove the `const` that holds the `mkdtemp` result itself.',
      },
    },
    create(context) {
      const options = { ...OWNED_REMOVAL_DEFAULTS, ...context.options[0] };
      const owned = new Set([...OWNED_ROOT_CALLS, ...options.ownedRootCalls]);
      const from = options.removeHelperModule
        ? ` from ${options.removeHelperModule}`
        : '';
      return {
        CallExpression(node) {
          const method = removerOf(node, context);
          if (!method || !isRecursive(node.arguments[1])) return;
          if (isOwnedRoot(node.arguments[0], context, owned)) return;
          context.report({
            node,
            messageId: 'unowned',
            data: { method, removeHelper: options.removeHelper, from },
          });
        },
      };
    },
  };

  /** SQL statement shapes worth calling an oracle when copied. */
  const SQL_SHAPE =
    /\b(select\b[\s\S]+\bfrom|insert\s+(or\s+\w+\s+)?into|update\b[\s\S]+\bset|delete\s+from|create\s+(virtual\s+)?(table|index|trigger)|\bmatch\s+\?)/i;
  const COPY_WINDOW = 48;
  const COPY_STRIDE = 24;
  const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs'];

  const normalizeSql = text => text.replace(/\s+/g, ' ').trim().toLowerCase();

  /** Normalized module text, re-read when the file's mtime moves (editor sessions). */
  const moduleTexts = new Map();

  function moduleText(path) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      // fail-open: an unreadable module has no SQL to compare; the rule skips it.
      return null;
    }
    const cached = moduleTexts.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
    const text = normalizeSql(readFileSync(path, 'utf8'));
    moduleTexts.set(path, { mtimeMs: stat.mtimeMs, text });
    return text;
  }

  /** `./x` from `fromFile` → an existing non-test source file, or null. */
  function resolveRelativeImport(fromFile, specifier) {
    if (!specifier.startsWith('.')) return null;
    const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ''));
    const candidates = [
      ...SOURCE_EXTENSIONS.map(ext => `${base}${ext}`),
      join(base, 'index.ts'),
    ];
    for (const candidate of candidates) {
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(candidate)) continue;
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // fail-open: no file with this extension; try the next one.
      }
    }
    return null;
  }

  /** Does `source` contain this SQL text, whole or in two overlapping windows? */
  function copiedInto(sql, source) {
    if (sql.length <= COPY_WINDOW + COPY_STRIDE) return source.includes(sql);
    let found = 0;
    for (
      let start = 0;
      start + COPY_WINDOW <= sql.length;
      start += COPY_STRIDE
    ) {
      if (source.includes(sql.slice(start, start + COPY_WINDOW))) found += 1;
      if (found >= 2) return true;
    }
    return false;
  }

  const noCopiedProductionSql = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Tests import production SQL rather than copying it as an oracle (oracle family)',
      },
      schema: [],
      messages: {
        copied:
          'This SQL is copied from `{{module}}`, which this test imports. A copy keeps agreeing with itself after production changes, so the test stops testing the app. Import the production statement or call the production planner, and compare against independently written expected rows.',
      },
    },
    create(context) {
      const filename = context.filename;
      const modules = [];
      const check = (node, text) => {
        if (modules.length === 0) return;
        const sql = normalizeSql(text);
        if (sql.length < COPY_WINDOW || !SQL_SHAPE.test(sql)) return;
        const source = modules.find(module => copiedInto(sql, module.text));
        if (!source) return;
        context.report({
          node,
          messageId: 'copied',
          data: { module: source.specifier },
        });
      };
      return {
        ImportDeclaration(node) {
          const specifier = node.source.value;
          if (typeof specifier !== 'string') return;
          const path = resolveRelativeImport(filename, specifier);
          const text = path ? moduleText(path) : null;
          if (text) modules.push({ specifier, text });
        },
        // Raw text on both sides: the module is compared as written, so an
        // escaped `'\\'` in either file must stay escaped to match.
        Literal(node) {
          if (typeof node.value !== 'string') return;
          if (node.parent?.type === 'ImportDeclaration') return;
          check(node, node.raw.slice(1, -1));
        },
        TemplateLiteral(node) {
          for (const quasi of node.quasis) check(quasi, quasi.value.raw);
        },
      };
    },
  };

  return {
    noSilentEarlyReturn,
    ownedFixtureRemoval,
    noCopiedProductionSql,
    someNode,
    OWNED_ROOT_CALLS,
    SOURCE_EXTENSIONS,
  };
}
