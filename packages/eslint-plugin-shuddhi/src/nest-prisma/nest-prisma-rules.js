/**
 * NestJS and Prisma rules derived from a code-review corpus.
 *
 * Every rule here closes a defect class reviewers reported repeatedly across a
 * repository's PR history. Each carries the finding count that justified it,
 * and — where the rule is a heuristic rather than a proof — an explicit note on
 * what it deliberately does NOT claim.
 *
 * Rules are written against the ESTree AST only (no type information), so they
 * run in every workspace regardless of whether typed linting is configured.
 */

import {
  PRISMA_WRITES,
  bindings,
  enclosingFunction,
  insideTransaction,
  memberName,
  prismaCall,
  propertyName,
  unwrap,
} from './helpers.js';

// ---------------------------------------------------------------------------

/** 7 findings, 3 of them P1. */
const nestHttpException = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Throw a Nest HttpException, not a bare Error, from Nest code',
    },
    schema: [],
    messages: {
      bareError:
        'A bare `Error` leaves Nest with nothing to map, so the client gets 500 for what is usually a 4xx. Throw BadRequestException / NotFoundException / ForbiddenException from @nestjs/common.',
    },
  },
  create(context) {
    let isNestModule = false;
    return {
      ImportDeclaration(node) {
        // A TYPE-only import does not make a file Nest code: it is erased at
        // compile time and carries no request path. A test helper that does
        // `import type { INestApplication } from '@nestjs/common'` and throws
        // on a failed precondition was being told to throw a
        // BadRequestException, which has nothing to map it to a response.
        if (node.importKind === 'type') return;
        // An import's source is always a string literal.
        if (node.source.value.startsWith('@nestjs/')) isNestModule = true;
      },
      ThrowStatement(node) {
        if (!isNestModule) return;
        const argument = node.argument;
        // `Error('x')` without `new` constructs the same bare Error, so it
        // reaches Nest with the same nothing-to-map 500.
        if (
          (argument.type === 'NewExpression' ||
            argument.type === 'CallExpression') &&
          argument.callee.type === 'Identifier' &&
          argument.callee.name === 'Error'
        ) {
          context.report({ node, messageId: 'bareError' });
        }
      },
    };
  },
};

/** 28 findings, 17 of them P1. */
const prismaMultiWriteTransaction = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Two or more Prisma writes in one function belong in $transaction',
    },
    schema: [
      {
        type: 'object',
        properties: {
          // Helpers that open a transaction themselves and hand its client to
          // a callback, or run an array of writes as one `$transaction`.
          transactionWrappers: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ transactionWrappers: [] }],
    messages: {
      untransacted:
        'This function performs {{count}} Prisma writes outside a transaction. A failure between them leaves the rows partially updated — the audit-log and match-rebuild defects Cubic reported. Wrap them in `prisma.$transaction`.',
    },
  },
  create(context) {
    // ESLint merges `meta.defaultOptions` under what the config passes.
    const wrappers = new Set(context.options[0].transactionWrappers);
    /** function node -> write call nodes */
    const writesByFunction = new Map();

    return {
      CallExpression(node) {
        const call = prismaCall(node);
        if (!call || !PRISMA_WRITES.has(call.method)) return;
        if (insideTransaction(node, wrappers)) return;

        const fn = enclosingFunction(node);
        if (!fn) return;
        const list = writesByFunction.get(fn) ?? [];
        list.push(node);
        writesByFunction.set(fn, list);
      },
      'Program:exit'() {
        for (const [, writes] of writesByFunction) {
          if (writes.length < 2) continue;
          context.report({
            node: writes[0],
            messageId: 'untransacted',
            data: { count: String(writes.length) },
          });
        }
      },
    };
  },
};

/** 75 findings, the largest single cluster. */
const nestParamPipe = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Numeric route/query params need a parsing pipe',
    },
    schema: [],
    messages: {
      unparsed:
        '`{{name}}` is declared `{{declared}}` but arrives from the request unvalidated. Without a pipe (or a validated DTO) it reaches the query layer as-is — the NaN pagination and malformed-date defects Cubic reported. Add {{pipe}}, or take a validated DTO.',
    },
  },
  create(context) {
    const PARAM_DECORATORS = new Set(['Query', 'Param']);
    /** `id`, `uuid`, `brand_id`, `storeId` — names that carry an identifier. */
    const ID_SHAPED_PARAM = /^(id|uuid)$|(_id|Id|Uuid|UUID)$/;

    return {
      // A decorated parameter is a TSParameterProperty or an Identifier with
      // `decorators`; both surface here.
      'MethodDefinition > FunctionExpression > :matches(Identifier, TSParameterProperty)'(
        node,
      ) {
        const decorators = node.decorators ?? [];
        if (decorators.length === 0) return;

        const decorated = decorators.some(d => {
          const expression = d.expression;
          const callee =
            expression.type === 'CallExpression'
              ? expression.callee
              : expression;
          return (
            callee.type === 'Identifier' && PARAM_DECORATORS.has(callee.name)
          );
        });
        if (!decorated) return;

        // A pipe passed to the decorator is exactly the fix being asked for.
        const hasPipe = decorators.some(d => {
          const expression = d.expression;
          if (expression.type !== 'CallExpression') return false;
          return expression.arguments.some(argument => {
            const text = context.sourceCode.getText(argument);
            // A PARSING/validating pipe, not merely something named *Pipe.
            // `DefaultValuePipe` supplies a fallback and validates nothing, so
            // treating it as satisfying the gate let an unparsed value reach
            // the handler — the exact defect this rule exists to catch.
            return /\b(?:Parse[A-Za-z]*|Validation)Pipe\b/.test(text);
          });
        });
        if (hasPipe) return;

        // Only an Identifier parameter carries its own annotation (a
        // TSParameterProperty holds it on its inner `parameter`), so past
        // this line the node is an Identifier and has a name.
        const annotation = node.typeAnnotation?.typeAnnotation;
        if (!annotation) return;
        const paramName = node.name;

        const declared =
          annotation.type === 'TSNumberKeyword'
            ? 'number'
            : annotation.type === 'TSTypeReference' &&
                annotation.typeName.type === 'Identifier' &&
                annotation.typeName.name === 'Date'
              ? 'Date'
              : // An id-shaped param typed `string` is the UUID case. The
                // message always advertised ParseUUIDPipe; only `number` and
                // `Date` were ever implemented, so `@Param('id') id: string`
                // — the ordinary spelling of a route id — produced no
                // message at all, and the cluster shipped with false
                // confidence of lint coverage.
                //
                // Scoped to id-shaped NAMES, not every string: `@Query('q')
                // q: string` is free text and validating it as a UUID would
                // be wrong.
                annotation.type === 'TSStringKeyword' &&
                  ID_SHAPED_PARAM.test(paramName)
                ? 'string id'
                : null;
        if (declared === null) return;

        context.report({
          node,
          messageId: 'unparsed',
          data: {
            name: paramName,
            declared,
            pipe:
              declared === 'string id'
                ? '`ParseUUIDPipe`'
                : '`ParseIntPipe`/`ParseDatePipe`',
          },
        });
      },
    };
  },
};

/**
 * 10 findings, 4 of them P0: the highest-severity class in the corpus.
 *
 * Deliberately NOT taint analysis. Full source-to-sink tracking would need
 * Semgrep, and adding a Python toolchain to every dev machine and CI runner is
 * a real cost. This rule instead bans the specific construct the P0s were
 * written with — an Unsafe raw-SQL call whose argument is not a literal — which
 * catches the concrete defect without claiming to prove the general case.
 *
 * The safe tagged-template forms (`$queryRaw`...`) are untouched: Prisma
 * parameterises those.
 */
const noRawSqlInterpolation = {
  meta: {
    type: 'problem',
    docs: { description: 'Raw SQL must be parameterised, never interpolated' },
    schema: [],
    messages: {
      unsafe:
        '`{{method}}` with a computed string is SQL injection by construction. Use the tagged-template form (prisma.$queryRaw`...`), which parameterises interpolations, or $queryRawUnsafe with explicit bound parameters.',
    },
  },
  create(context) {
    const UNSAFE = new Set(['$queryRawUnsafe', '$executeRawUnsafe']);
    /** Locals bound to an Unsafe method: `const { $queryRawUnsafe: q } = prisma`. */
    const unsafeLocals = bindings(context);
    // Calls are judged once the whole file is read: a function declared
    // before `const { $queryRawUnsafe: q } = prisma` still runs after it, so
    // an alias declared later in the file must be known when its calls are.
    const calls = [];

    /**
     * The Unsafe method this call invokes and the SQL argument it passes, or
     * null. Beyond `prisma.$queryRawUnsafe(sql)`, the same call is spelled
     * `prisma['$queryRawUnsafe'](sql)`, `q(sql)` after destructuring,
     * `.call(prisma, sql)` and `.apply(prisma, [sql])` — each passed the rule
     * unseen until an adversarial lint corpus spelled them out.
     */
    const unsafeCall = node => {
      const callee = unwrap(node.callee);
      const local = unsafeLocals.lookup(callee);
      if (local !== undefined) return { method: local, sql: node.arguments[0] };
      const name = memberName(callee);
      if (name !== null && UNSAFE.has(name)) {
        return { method: name, sql: node.arguments[0] };
      }
      const invoked = unwrap(callee.object);
      const inner = memberName(invoked);
      const viaIdentifier = unsafeLocals.lookup(invoked) ?? null;
      const method =
        inner !== null && UNSAFE.has(inner) ? inner : viaIdentifier;
      if (method === null) return null;
      if (name === 'call') return { method, sql: node.arguments[1] };
      if (name === 'apply') {
        const list = unwrap(node.arguments[1]);
        return list?.type === 'ArrayExpression'
          ? { method, sql: list.elements[0] }
          : null;
      }
      return null;
    };

    return {
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern') return;
        for (const entry of node.id.properties) {
          if (entry.type !== 'Property') continue;
          // `{ [name]: local }` takes the property named by name's VALUE;
          // only a literal computed key is known here.
          const key = propertyName(entry);
          if (UNSAFE.has(key) && entry.value.type === 'Identifier') {
            unsafeLocals.bind(entry.value, key);
          }
        }
      },
      CallExpression(node) {
        calls.push(node);
      },
      'Program:exit'() {
        for (const node of calls) checkCall(node);
      },
    };

    function checkCall(node) {
      const call = unsafeCall(node);
      if (call === null) return;
      const method = call.method;

      const first = unwrap(call.sql);
      // No argument at all is undefined; a hole in `.apply`'s list is null.
      if (first === undefined || first === null) return;

      // Report only VISIBLE interpolation: a template carrying `${}`, or a
      // string built by concatenation. Both put a value into the SQL text at
      // this call site, which is the injection.
      //
      // Anything else — an identifier, or a helper call like
      // `$queryRawUnsafe(buildQuery(table), userId)` — cannot be judged from
      // the AST, and `buildQuery` may well be parameterising correctly. The
      // rule must not claim a violation it has not proven; flagging the
      // helper-call form failed the exact pattern this rule's own message
      // recommends as safe, and a repository that bans `eslint-disable` has
      // no way out of it.
      //
      // Following a value from source to sink is a taint tool's job (Semgrep,
      // say), not a syntactic rule's.
      const interpolatedTemplate =
        first.type === 'TemplateLiteral' && first.expressions.length > 0;
      // `'SELECT '.concat(id)` concatenates as `+` does.
      const concatenated =
        (first.type === 'BinaryExpression' && first.operator === '+') ||
        (first.type === 'CallExpression' &&
          memberName(unwrap(first.callee)) === 'concat' &&
          first.arguments.length > 0);
      if (!interpolatedTemplate && !concatenated) return;

      context.report({ node, messageId: 'unsafe', data: { method } });
    }
  },
};

/**
 * A test HTTP server must bind the address its client will actually use.
 *
 * WHAT IT CATCHES
 * ---------------
 * supertest starts an unbound server for you with a HOSTLESS `app.listen(0)`
 * (supertest/lib/test.js:63) and then requests `http://127.0.0.1:<port>`
 * (test.js:69). A hostless listen binds `::` — IPv6 unspecified, dual-stack —
 * which does NOT collide with a socket another process already holds on
 * `127.0.0.1:<port>`. The bind succeeds, so the server looks healthy, and the
 * request is then routed by the kernel to the MORE SPECIFIC IPv4 socket: a
 * foreign process answers instead of the app.
 *
 * Measured where an IDE language server held 323 loopback ports, all inside the
 * ephemeral range: a hostless bind landed on one 71 times in 3000 (2.37%),
 * `listen(0, '127.0.0.1')` 0 times in 3000. The symptom is an HTTP 400 whose
 * body no code in the repository produced, on a different unrelated suite each
 * run.
 *
 * Patching supertest to follow the listener's family fixes the client half of
 * this. This rule holds the SERVER half, for the two things a client patch
 * cannot give: a wildcard bind publishes an app whose auth guards are stubbed
 * open on every interface, and a patch is a pinned fork that has to survive
 * every supertest upgrade. Route Nest test apps through a loopback helper (the
 * `loopbackHelper` option, `listenOnLoopback` by default), which binds
 * 127.0.0.1 before supertest sees the server, so the two controls fail
 * independently.
 *
 * WHY IT KEYS ON createNestApplication
 * ------------------------------------
 * Only servers built by `createNestApplication` are reported. A test that
 * stands up a raw `http.createServer` to DEMONSTRATE the wildcard behaviour is
 * not a violation, and in a repository that bans `eslint-disable` the rule has
 * to draw that line itself rather than rely on an escape hatch that does not
 * exist.
 *
 * ✅ await app.init(); await listenOnLoopback(app)
 * ✅ server.listen(0, '127.0.0.1')      // raw server, host named
 * ❌ app = moduleRef.createNestApplication(); await app.init()
 * ❌ await app.listen(0)                 // Nest app, no host
 */
/** Hosts that keep a test server off the network. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const noUnboundTestApp = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Nest test apps must bind loopback via a loopback helper, not a hostless listen',
    },
    schema: [
      {
        type: 'object',
        properties: {
          // The function that binds a Nest app to 127.0.0.1: `helper(app)`.
          loopbackHelper: { type: 'string', minLength: 1 },
          // Where the author imports it from, named in the message only.
          loopbackHelperModule: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      { loopbackHelper: 'listenOnLoopback', loopbackHelperModule: '' },
    ],
    messages: {
      bareInit:
        'This suite drives a Nest app over supertest but only calls `.init()`, so supertest binds it with a hostless `listen(0)` (`::`). That can silently share a port another process holds on 127.0.0.1, and the foreign process answers the request. Use `{{helper}}(...)`{{from}}.',
      hostlessListen:
        "`listen()` on a Nest test app with no host binds `::`, which does not collide with a 127.0.0.1 socket another process already holds — the request can then be answered by that process. Pass the host (`{{helper}}(...)`, or `listen(0, '127.0.0.1')`).",
    },
  },
  create(context) {
    // ESLint merges `meta.defaultOptions` under what the config passes.
    const [{ loopbackHelper: helper, loopbackHelperModule: helperModule }] =
      context.options;
    const data = {
      helper,
      from: helperModule === '' ? '' : ` from ${helperModule}`,
    };
    /** Identifiers holding a Nest application built in this file. */
    const nestApps = new Set();
    /**
     * Identifiers routed through the loopback helper. Tracked PER APP: a
     * file-level flag meant that one harnessed app silenced `bareInit` for
     * every OTHER app in the same file, so a second unbound application went
     * unreported.
     */
    const harnessed = new Set();
    const bareInits = [];
    const hostlessListens = [];
    let usesSupertest = false;

    /** Is this call `<something>.createNestApplication(...)`? */
    const createsNestApp = input => {
      const node = unwrap(input);
      return node.type === 'AwaitExpression'
        ? createsNestApp(node.argument)
        : node.type === 'CallExpression' &&
            memberName(unwrap(node.callee)) === 'createNestApplication';
    };

    /**
     * The name an app is held under: `app`, or `this.app` for a field. A
     * suite that keeps its app on `this` (or casts it, or calls
     * `app['listen']`) is the same suite; reading only a bare identifier
     * let all three bind `::` unreported.
     */
    const holderName = input => {
      const node = unwrap(input);
      if (node?.type === 'Identifier') return node.name;
      if (
        node?.type === 'MemberExpression' &&
        node.object.type === 'ThisExpression'
      ) {
        const name = memberName(node);
        return name === null ? null : `this.${name}`;
      }
      return null;
    };

    /** The receiver of `x.method()` / `this.x.method()`, by holder name. */
    const receiverName = node => {
      const callee = unwrap(node.callee);
      return callee.type === 'MemberExpression'
        ? holderName(callee.object)
        : null;
    };

    /**
     * A host argument that actually keeps the server off the network.
     *
     * Restricted to loopback literals, not any string: `listen(0, '0.0.0.0')`
     * names a host and still publishes an app whose auth guards are stubbed
     * open on every interface, which is half of what this rule exists to
     * prevent.
     */
    const namesHost = args =>
      args.some(
        argument =>
          argument.type === 'Literal' && LOOPBACK_HOSTS.has(argument.value),
      );

    return {
      ImportDeclaration(node) {
        if (node.source.value === 'supertest') usesSupertest = true;
        // Importing the harness proves nothing about whether a given app is
        // routed through it; only an actual helper(app) call does. The
        // import used to set a file-level flag, which is precisely how a
        // second unbound app in the same file went unreported.
      },
      // `const app = moduleRef.createNestApplication()` and `app = ...`
      VariableDeclarator(node) {
        if (
          node.init &&
          createsNestApp(node.init) &&
          node.id.type === 'Identifier'
        ) {
          nestApps.add(node.id.name);
        }
      },
      AssignmentExpression(node) {
        const holder = holderName(node.left);
        if (createsNestApp(node.right) && holder !== null) {
          nestApps.add(holder);
        }
      },
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type === 'Identifier' && callee.name === helper) {
          // `helper(app)` harnesses that holder specifically.
          const holder = holderName(node.arguments[0]);
          if (holder !== null) harnessed.add(holder);
          return;
        }
        const method = memberName(callee);
        if (method === null) return;
        const receiver = receiverName(node);
        if (receiver === null) return;

        if (method === 'init' && node.arguments.length === 0) {
          bareInits.push({ node, receiver });
        }
        if (method === 'listen') {
          if (namesHost(node.arguments)) {
            // `app.listen(0, '127.0.0.1')` binds loopback directly, without
            // going through the helper. The suite is harnessed either way —
            // what matters is that the server owns the address supertest
            // dials before supertest sees it, not which call did it. Suites
            // that already listened are written this way.
            harnessed.add(receiver);
          } else {
            hostlessListens.push({ node, receiver });
          }
        }
      },
      'Program:exit'() {
        for (const { node, receiver } of hostlessListens) {
          if (nestApps.has(receiver)) {
            context.report({ node, messageId: 'hostlessListen', data });
          }
        }
        // A bare init only matters when the suite actually makes HTTP requests.
        if (!usesSupertest) return;
        for (const { node, receiver } of bareInits) {
          if (nestApps.has(receiver) && !harnessed.has(receiver)) {
            context.report({ node, messageId: 'bareInit', data });
          }
        }
      },
    };
  },
};

export const rules = {
  'no-raw-sql-interpolation': noRawSqlInterpolation,
  'nest-http-exception': nestHttpException,
  'prisma-transaction-multiwrite': prismaMultiWriteTransaction,
  'nest-param-pipe': nestParamPipe,
  'no-unbound-test-app': noUnboundTestApp,
};

export default { rules };
