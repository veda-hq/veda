/**
 * Error-handling rules (catalogue ERR-01, ERR-02 with OBS-03, ERR-03, ERR-08).
 *
 * Each rule closes a failure-path defect reviewers kept reporting after push: a
 * catch that logs and carries on, a caller-supplied logger that throws out of
 * the containment meant to hold it, a caught value stringified in a way that
 * can itself throw, and a child process whose signal death is reported as an
 * ordinary exit code. Written against ESTree plus the scope manager only, so
 * every workspace can run them without typed linting.
 *
 * The helpers the messages point at (`safeLog`, `safeInvoke`, `errorDetail`,
 * `runChild`) live in the consuming project; the options name where.
 */

import { relative, sep } from 'node:path';

/** A file's path from `root`, with `/` separators. */
const rootPath = (root, filename) =>
  relative(root, filename).split(sep).join('/');

/**
 * Where a project's helpers are named in messages when it passes no
 * `helperModule`: neutral wording that reads as a sentence.
 */
const DEFAULT_HELPER_MODULE = 'your error-handling module';

/** The `helperModule` option: the module named in a rule's message. */
const HELPER_MODULE_SCHEMA = {
  type: 'string',
  minLength: 1,
  description:
    'The module the message tells the reader to import the helper from.',
};

const FAIL_OPEN = /^\s*fail-open:\s*\S/;

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

const isFunction = node => Boolean(node) && FUNCTION_TYPES.has(node.type);

/** `x.catch(fn)` / `x?.catch(fn)` with an inline function: the function. */
function catchCallback(call) {
  if (call.type !== 'CallExpression') return null;
  const { callee } = call;
  if (
    callee.type !== 'MemberExpression' ||
    callee.computed ||
    callee.property.type !== 'Identifier' ||
    callee.property.name !== 'catch'
  )
    return null;
  const handler = call.arguments[0];
  return isFunction(handler) ? handler : null;
}

const PROCESS_ERROR_EVENTS = new Set([
  'uncaughtException',
  'unhandledRejection',
]);

/** `process.on('uncaughtException', fn)` and friends: the function. */
function processErrorHandler(call) {
  if (call.type !== 'CallExpression') return null;
  const { callee } = call;
  if (
    callee.type !== 'MemberExpression' ||
    callee.object.type !== 'Identifier' ||
    callee.object.name !== 'process' ||
    callee.property.type !== 'Identifier' ||
    !['on', 'once', 'addListener', 'prependListener'].includes(
      callee.property.name,
    )
  )
    return null;
  const [event, handler] = call.arguments;
  if (
    event?.type !== 'Literal' ||
    !PROCESS_ERROR_EVENTS.has(event.value) ||
    !isFunction(handler)
  )
    return null;
  return handler;
}

/**
 * Walks `root` without entering nested functions. `visit` returns true to
 * stop the walk early; the walk returns whether it stopped.
 */
function walkSameFunction(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (visit(node)) return true;
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const value = node[key];
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (child && typeof child.type === 'string' && !isFunction(child)) {
          stack.push(child);
        }
      }
    }
  }
  return false;
}

const isMember = (node, object, property) =>
  node?.type === 'MemberExpression' &&
  !node.computed &&
  node.object.type === 'Identifier' &&
  node.object.name === object &&
  node.property.type === 'Identifier' &&
  node.property.name === property;

/** Is `fn` the executor of `new Promise(fn)`? */
const isExecutor = fn =>
  fn?.parent?.type === 'NewExpression' &&
  fn.parent.callee.type === 'Identifier' &&
  fn.parent.callee.name === 'Promise' &&
  fn.parent.arguments[0] === fn;

/** Is `variable` the second parameter (`reject`) of a promise executor? */
const isExecutorReject = variable =>
  Boolean(variable) &&
  variable.defs.some(
    def =>
      def.type === 'Parameter' &&
      isExecutor(def.node) &&
      def.node.params[1] === def.name,
  );

/** The function a variable is bound to (`function f`, `const f = () => …`). */
function boundFunction(variable) {
  for (const def of variable?.defs ?? []) {
    if (def.type === 'FunctionName') return def.node;
    if (def.type === 'Variable' && isFunction(def.node.init))
      return def.node.init;
  }
  return null;
}

/**
 * Does calling `callee` reject an enclosing promise? Resolved by binding, not
 * name: the executor's own `reject`, or a function declared inside that
 * executor which calls it (the settle-once `fail` wrapper).
 */
function rejectsPromise(sourceCode, callee) {
  if (callee.type !== 'Identifier') return false;
  const variable = resolve(sourceCode, callee);
  if (isExecutorReject(variable)) return true;
  const wrapper = boundFunction(variable);
  if (!wrapper) return false;
  let outer = wrapper.parent;
  while (outer && !(isFunction(outer) && isExecutor(outer)))
    outer = outer.parent;
  if (!outer) return false;
  return walkSameFunction(
    wrapper.body,
    node =>
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      isExecutorReject(resolve(sourceCode, node.callee)),
  );
}

/** Is `node` inside the block of a try (with a catch) nested under `root`? */
function caughtWithin(node, root) {
  let child = node;
  let current = node.parent;
  while (current && child !== root) {
    if (
      current.type === 'TryStatement' &&
      current.handler &&
      child === current.block
    )
      return true;
    child = current;
    current = current.parent;
  }
  return false;
}

/**
 * Does this handler body hand the failure on? A throw, a returned
 * `Promise.reject`, rejecting an enclosing promise, or ending the process
 * with a status all propagate; logging and returning a fallback do not.
 */
function propagates(sourceCode, body) {
  return walkSameFunction(body, node => {
    // A throw a nested try/catch takes back never leaves this handler.
    if (node.type === 'ThrowStatement') return !caughtWithin(node, body);
    if (node.type === 'CallExpression') {
      // Only a rejection the handler hands back: returned, awaited, or the
      // arrow's value. A floating `Promise.reject(e)` resolves the chain and
      // leaves an unhandled rejection behind.
      // An awaited rejection inside a nested try/catch is taken back there.
      if (isMember(node.callee, 'Promise', 'reject'))
        return (
          node.parent.type === 'ReturnStatement' ||
          (node.parent.type === 'AwaitExpression' &&
            !caughtWithin(node, body)) ||
          (node.parent.type === 'ArrowFunctionExpression' &&
            node.parent.body === node)
        );
      if (rejectsPromise(sourceCode, node.callee)) return true;
      if (isMember(node.callee, 'process', 'exit')) {
        // No argument exits with the current exit code, normally 0.
        const [status] = node.arguments;
        return (
          status !== undefined &&
          !(status.type === 'Literal' && status.value === 0)
        );
      }
    }
    if (
      node.type === 'AssignmentExpression' &&
      isMember(node.left, 'process', 'exitCode')
    ) {
      return !(node.right.type === 'Literal' && node.right.value === 0);
    }
    return false;
  });
}

/** Comments that may carry the handler's `fail-open:` annotation. */
function annotationComments(sourceCode, handler, body, anchor) {
  const comments = [...sourceCode.getCommentsBefore(handler)];
  if (anchor) {
    comments.push(...sourceCode.getCommentsBefore(anchor));
    const dot = sourceCode.getTokenBefore(anchor);
    if (dot) comments.push(...sourceCode.getCommentsBefore(dot));
  }
  if (body.type === 'BlockStatement') {
    const first = body.body[0];
    for (const comment of sourceCode.getCommentsInside(body)) {
      if (!first || comment.range[1] <= first.range[0]) comments.push(comment);
    }
  } else {
    comments.push(...sourceCode.getCommentsBefore(body));
  }
  return comments;
}

/** ERR-01 — no-swallowed-catch. */
const noSwallowedCatch = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A catch that neither rethrows nor rejects must say why it may fail open',
    },
    schema: [],
    messages: {
      swallowed:
        'This catch swallows the error: nothing rethrows, rejects or exits non-zero. Rethrow it, or, if carrying on is correct, put `// fail-open: <reason>` at the top of the handler (ERR-01).',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const check = (handler, body, anchor, reportNode) => {
      if (propagates(sourceCode, body)) return;
      const annotated = annotationComments(
        sourceCode,
        handler,
        body,
        anchor,
      ).some(comment => FAIL_OPEN.test(comment.value));
      if (!annotated)
        context.report({ node: reportNode, messageId: 'swallowed' });
    };
    return {
      CatchClause(node) {
        check(node, node.body, null, node);
      },
      CallExpression(node) {
        const handler = catchCallback(node);
        if (handler)
          check(handler, handler.body, node.callee.property, handler);
      },
    };
  },
};

/**
 * Names of injected log sinks: `log`, `logError`, `logOnce`, any `…Log`
 * (`idleFillLog`). These count wherever the sink was handed in.
 */
const SINK_NAME =
  /^(?:log|logError|logOnce|logWarn|logInfo|[a-z][A-Za-z0-9]*Log)$/;

/**
 * Generic verbs the catalogue names (`deps.write`, optional `beat`). On their
 * own they are ordinary operations (`save(out) { out.write(data) }`), so they
 * count only when carried in a sink container or called optionally.
 */
const GENERIC_SINK = /^(?:write|beat)$/;

/**
 * An optional `on…` callback (`deps.onProgress?.(n)`) is a sink too: the
 * caller made it optional precisely because the work must not depend on it.
 * Not in JSX files, where `onClose?.()` is a React prop handler whose throw
 * React's own error boundary is meant to see.
 */
const OPTIONAL_CALLBACK = /^on[A-Z][A-Za-z0-9]*$/;

/** Containers a sink is carried in: `ctx.deps.log`, `this.options.onX`. */
const SINK_CONTAINER =
  /^(?:deps|options|opts|hooks|io|sinks?|reporters|callbacks)$/;

/** Wrappers that absorb a sink's sync throw and async rejection. */
const SAFE_WRAPPERS = new Set(['safeLog', 'safeInvoke']);

/**
 * Where the real wrappers live, as a regular expression over the import
 * specifier: by default a relative `error-handling` module. A project whose
 * wrappers ship in a package passes `helperSourcePattern` naming the package
 * as well as the module inside it.
 */
const DEFAULT_HELPER_SOURCE = '^\\.{1,2}/(?:.*/)?error-handling$';

/** Strips `a ?? b`, `a || b`, `a!`, `a as T` down to the left-hand value. */
function unwrapValue(node) {
  let current = node;
  for (;;) {
    if (
      current?.type === 'LogicalExpression' &&
      (current.operator === '??' || current.operator === '||')
    )
      current = current.left;
    else if (
      current?.type === 'TSNonNullExpression' ||
      current?.type === 'TSAsExpression' ||
      current?.type === 'ChainExpression'
    )
      current = current.expression;
    else return current;
  }
}

/** Resolves an identifier to its variable through the scope chain. */
function resolve(sourceCode, identifier) {
  let scope = sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return null;
}

const isParameter = variable =>
  Boolean(variable) && variable.defs.some(def => def.type === 'Parameter');

/** Is this object expression rooted in `this` or a function parameter? */
function injectedRoot(sourceCode, node) {
  const object = unwrapValue(node);
  if (!object) return false;
  if (object.type === 'ThisExpression') return true;
  if (object.type === 'Identifier')
    return isParameter(resolve(sourceCode, object));
  if (object.type === 'MemberExpression')
    return injectedRoot(sourceCode, object.object);
  return false;
}

/**
 * Does the class around `node` define `name` itself, as a method or a
 * function-valued field? Then `this.name()` is the class's own code, not a
 * sink someone handed it (`this.logError` in a Nest service).
 */
function ownMethod(node, name) {
  let current = node.parent;
  while (current && current.type !== 'ClassBody') current = current.parent;
  if (!current) return false;
  return current.body.some(
    member =>
      (member.type === 'MethodDefinition' ||
        (member.type === 'PropertyDefinition' && isFunction(member.value))) &&
      !member.computed &&
      member.key.type === 'Identifier' &&
      member.key.name === name,
  );
}

/**
 * Is the callee a caller-supplied sink (parameter, `deps.log`, `this.log`)?
 * `sinkKind(name)` is `'any'` for a sink name, `'container'` for a generic
 * verb that counts only inside a sink container, or null.
 */
function isInjectedSink(sourceCode, callee, sinkKind) {
  if (callee.type === 'Identifier') {
    if (sinkKind(callee.name) !== 'any') return false;
    const variable = resolve(sourceCode, callee);
    if (!variable) return false;
    if (isParameter(variable)) return true;
    // `const idleFillLog = state.idleFillLog ?? (() => {})` (OBS-03).
    return variable.defs.some(
      def =>
        def.type === 'Variable' &&
        def.node.init &&
        unwrapValue(def.node.init)?.type === 'MemberExpression' &&
        injectedRoot(sourceCode, unwrapValue(def.node.init).object),
    );
  }
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    sinkKind(callee.property.name)
  ) {
    const anywhere = sinkKind(callee.property.name) === 'any';
    const object = unwrapValue(callee.object);
    if (object.type === 'ThisExpression')
      return anywhere && !ownMethod(callee, callee.property.name);
    if (object.type === 'Identifier')
      return (
        (anywhere || SINK_CONTAINER.test(object.name)) &&
        isParameter(resolve(sourceCode, object))
      );
    // `ctx.deps.log`, `this.deps.log` — one level of container.
    return (
      object.type === 'MemberExpression' &&
      !object.computed &&
      injectedRoot(sourceCode, object.object) &&
      object.property.type === 'Identifier' &&
      SINK_CONTAINER.test(object.property.name)
    );
  }
  return false;
}

/** The nearest catch handler whose body holds `node` without a function between. */
function enclosingCatchHandler(node) {
  let current = node.parent;
  let child = node;
  while (current) {
    if (current.type === 'CatchClause' && child === current.body)
      return current;
    if (isFunction(current)) {
      const call = current.parent;
      if (
        call &&
        (catchCallback(call) === current ||
          processErrorHandler(call) === current)
      )
        return current;
      return null;
    }
    child = current;
    current = current.parent;
  }
  return null;
}

/** Climbs from a call past `?.`, `await` and `void` to where its value goes. */
function valueHome(node) {
  let child = node;
  let current = node.parent;
  while (
    current &&
    (current.type === 'ChainExpression' ||
      current.type === 'AwaitExpression' ||
      (current.type === 'UnaryExpression' && current.operator === 'void'))
  ) {
    child = current;
    current = current.parent;
  }
  return { child, parent: current };
}

/**
 * Is the call's value thrown away (a statement, or an arrow's body)? A sink
 * whose result the caller reads (`if (!out.write(chunk))`, a returned
 * decision) is part of the contract, not fire-and-forget telemetry.
 */
function discarded(node) {
  const { child, parent } = valueHome(node);
  if (parent?.type === 'ExpressionStatement') return true;
  // An arrow's expression body is its return value. Bound or returned
  // (`const decide = deps => deps.onDecide?.(1)`) that value is the contract;
  // passed as a callback (`setTimeout(() => deps.log(x))`) the callee drops it.
  return (
    parent?.type === 'ArrowFunctionExpression' &&
    parent.body === child &&
    parent.parent?.type === 'CallExpression' &&
    parent.parent.arguments.includes(parent)
  );
}

const isAwaited = node => {
  const parent =
    node.parent.type === 'ChainExpression' ? node.parent.parent : node.parent;
  return parent.type === 'AwaitExpression';
};

/** Is the call's value returned, awaited, or its arrow's expression body? */
function handedBack(node) {
  const child = node.parent.type === 'ChainExpression' ? node.parent : node;
  const parent = child.parent;
  return (
    parent.type === 'ReturnStatement' ||
    parent.type === 'AwaitExpression' ||
    (parent.type === 'ArrowFunctionExpression' && parent.body === child)
  );
}

/**
 * Is `callee` the real helper, by binding? An import of `safeLog` or
 * `safeInvoke` under any local name counts; a local function that merely
 * shares the name does not. `helperSource` is the compiled
 * `helperSourcePattern`.
 */
function isSafeWrapper(sourceCode, callee, helperSource) {
  if (callee.type !== 'Identifier') return false;
  const variable = resolve(sourceCode, callee);
  return Boolean(
    variable?.defs.some(
      def =>
        def.type === 'ImportBinding' &&
        def.node.type === 'ImportSpecifier' &&
        helperSource.test(def.parent?.source?.value ?? '') &&
        SAFE_WRAPPERS.has(
          def.node.imported.type === 'Identifier'
            ? def.node.imported.name
            : def.node.imported.value,
        ),
    ),
  );
}

/**
 * Is the call contained where it stands? Inside a function passed to
 * `safeLog`/`safeInvoke`, or awaited inside the block of a try that has a
 * catch. The walk stops at the first function boundary: a try around
 * `setTimeout(() => deps.log(x))` does not see that throw, and a try without
 * `await` does not see an async sink's rejection (console is synchronous, so
 * its call needs no `await`).
 */
function guarded(sourceCode, node, synchronous, helperSource) {
  let child = node;
  let current = node.parent;
  while (current) {
    if (
      current.type === 'TryStatement' &&
      child === current.block &&
      current.handler
    )
      return synchronous || isAwaited(node);
    if (isFunction(current)) {
      const call = current.parent;
      return (
        call?.type === 'CallExpression' &&
        isSafeWrapper(sourceCode, call.callee, helperSource) &&
        call.arguments.includes(current) &&
        // The wrapper absorbs only the rejection it is handed: an async sink
        // must be the callback's value (returned or awaited), not a statement.
        (synchronous || handedBack(node))
      );
    }
    child = current;
    current = current.parent;
  }
  return false;
}

const SAFE_LOG_DEFAULTS = {
  helperModule: DEFAULT_HELPER_MODULE,
  helperSourcePattern: DEFAULT_HELPER_SOURCE,
};

/** ERR-02 + OBS-03 — safe-log. */
const safeLogRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Injected loggers, and console calls on a catch path, go through safeLog/safeInvoke',
    },
    schema: [
      {
        type: 'object',
        properties: {
          helperModule: HELPER_MODULE_SCHEMA,
          helperSourcePattern: {
            type: 'string',
            minLength: 1,
            description:
              'A regular expression over import specifiers: an import of safeLog/safeInvoke from a matching module is the real wrapper.',
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [SAFE_LOG_DEFAULTS],
    messages: {
      injected:
        'A caller-supplied sink (`{{name}}`) can throw or reject, and that escapes the code meant to contain it. Call it through `safeLog(sink, ...args)` or `safeInvoke(() => ...)` from {{module}} (ERR-02, OBS-03).',
      catchConsole:
        '`console.{{name}}` on a catch path can throw and replace the error being handled. Use `safeInvoke(() => console.{{name}}(...))` from {{module}} (ERR-02).',
    },
  },
  create(context) {
    const options = { ...SAFE_LOG_DEFAULTS, ...context.options[0] };
    const helperSource = new RegExp(options.helperSourcePattern);
    const helperModule = options.helperModule;
    const sourceCode = context.sourceCode;
    const jsx = /\.[jt]sx$/.test(context.filename);
    return {
      CallExpression(node) {
        const callee =
          node.callee.type === 'ChainExpression'
            ? node.callee.expression
            : node.callee;
        const isConsole =
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'console';
        if (guarded(sourceCode, node, isConsole, helperSource)) return;
        const sinkKind = name => {
          if (SINK_NAME.test(name)) return 'any';
          if (node.optional && GENERIC_SINK.test(name)) return 'any';
          if (node.optional && !jsx && OPTIONAL_CALLBACK.test(name))
            return 'any';
          return GENERIC_SINK.test(name) ? 'container' : null;
        };
        if (discarded(node) && isInjectedSink(sourceCode, callee, sinkKind)) {
          context.report({
            node,
            messageId: 'injected',
            data: { name: sourceCode.getText(callee), module: helperModule },
          });
          return;
        }
        if (
          isConsole &&
          callee.property.type === 'Identifier' &&
          // Declared globals resolve too, but with no definition; a local
          // `console` binding (a parameter, an import) has one.
          !(resolve(sourceCode, callee.object)?.defs.length > 0) &&
          enclosingCatchHandler(node)
        ) {
          context.report({
            node,
            messageId: 'catchConsole',
            data: { name: callee.property.name, module: helperModule },
          });
        }
      },
    };
  },
};

const TRANSPARENT = new Set([
  'TSAsExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'ChainExpression',
]);

/** Climbs past casts and value-selecting wrappers to where the value lands. */
function landing(node) {
  let child = node;
  let current = node.parent;
  while (
    current &&
    (TRANSPARENT.has(current.type) ||
      current.type === 'LogicalExpression' ||
      (current.type === 'ConditionalExpression' && child !== current.test))
  ) {
    child = current;
    current = current.parent;
  }
  return { child, parent: current };
}

const isStringy = node =>
  (node.type === 'Literal' && typeof node.value === 'string') ||
  node.type === 'TemplateLiteral';

/** Climbs past casts only (`e as Error`, `e!`). */
function outerValue(node) {
  let value = node;
  while (TRANSPARENT.has(value.parent?.type)) value = value.parent;
  return value;
}

/** `String(value)` or `value.toString()`: the call node, else null. */
function explicitConversion(value) {
  const parent = value.parent;
  if (
    parent?.type === 'CallExpression' &&
    parent.callee.type === 'Identifier' &&
    parent.callee.name === 'String' &&
    parent.arguments[0] === value
  )
    return parent;
  if (
    parent?.type === 'MemberExpression' &&
    parent.object === value &&
    !parent.computed &&
    parent.property.type === 'Identifier' &&
    parent.property.name === 'toString' &&
    parent.parent?.type === 'CallExpression' &&
    parent.parent.callee === parent
  )
    return parent.parent;
  return null;
}

/** Is this value used as text: a template slot or `'…' + value`? */
function stringified(node) {
  const { child, parent } = landing(node);
  if (!parent) return false;
  // A tagged template hands its tag the raw values, not their text.
  if (parent.type === 'TemplateLiteral')
    return (
      parent.parent?.type !== 'TaggedTemplateExpression' &&
      parent.expressions.includes(child)
    );
  if (parent.type === 'BinaryExpression' && parent.operator === '+') {
    const other = parent.left === child ? parent.right : parent.left;
    return isStringy(other);
  }
  return false;
}

const RAW_ERROR_STRING_DEFAULTS = { helperModule: DEFAULT_HELPER_MODULE };

/** ERR-03 — no-raw-error-string. */
const noRawErrorString = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A caught value is turned into text only through errorDetail()',
    },
    schema: [
      {
        type: 'object',
        properties: { helperModule: HELPER_MODULE_SCHEMA },
        additionalProperties: false,
      },
    ],
    defaultOptions: [RAW_ERROR_STRING_DEFAULTS],
    messages: {
      raw: '`{{text}}` stringifies a caught value, which can itself throw (a hostile toString, a Symbol, a null `.message`) and abort the handler. Use `errorDetail(e)` from {{module}} (ERR-03).',
    },
  },
  create(context) {
    const { helperModule } = {
      ...RAW_ERROR_STRING_DEFAULTS,
      ...context.options[0],
    };
    const sourceCode = context.sourceCode;

    const report = node =>
      context.report({
        node,
        messageId: 'raw',
        data: { text: sourceCode.getText(node), module: helperModule },
      });

    // eslint-scope attaches a catch or parameter binding to its OWNER (the
    // CatchClause or the function), not to the identifier.
    const checkBinding = (owner, param) => {
      if (param?.type !== 'Identifier') return;
      const variable = sourceCode
        .getDeclaredVariables(owner)
        .find(candidate => candidate.defs.some(def => def.name === param));
      if (!variable) return;
      for (const reference of variable.references) {
        const value = outerValue(reference.identifier);
        const parent = value.parent;
        // String(e), e.toString()
        const converted = explicitConversion(value);
        if (converted) {
          report(converted);
          continue;
        }
        if (
          parent?.type === 'MemberExpression' &&
          parent.object === value &&
          !parent.computed &&
          parent.property.type === 'Identifier'
        ) {
          const name = parent.property.name;
          if (name !== 'message' && name !== 'stack') continue;
          // `${e.message}`, 'x: ' + e.message, String(e.message),
          // e.stack.toString(): the member can be null or a hostile object.
          const member = outerValue(parent);
          const memberConverted = explicitConversion(member);
          if (memberConverted) report(memberConverted);
          else if (stringified(parent)) report(parent);
          continue;
        }
        // `${e}`, 'x: ' + e
        if (stringified(value)) report(value);
      }
    };

    return {
      CatchClause(node) {
        checkBinding(node, node.param);
      },
      CallExpression(node) {
        const handler = catchCallback(node) ?? processErrorHandler(node);
        if (handler) checkBinding(handler, handler.params[0]);
      },
    };
  },
};

const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const ASYNC_CHILD_APIS = new Set(['spawn', 'exec', 'execFile']);

/**
 * The name a key spells statically: `spawn`, `'spawn'`, `['spawn']` and
 * `` [`spawn`] `` all name spawn; a computed identifier or an interpolated
 * template names nothing knowable.
 */
function staticKey(key, computed) {
  if (key.type === 'Identifier') return computed ? null : key.name;
  if (key.type === 'Literal')
    return typeof key.value === 'string' ? key.value : null;
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0)
    return key.quasis[0].value.cooked;
  return null;
}

const CHILD_PROCESS_DEFAULTS = {
  allow: [],
  runner: 'your process-runner module',
};

/** ERR-08 — no-direct-child-process. */
const noDirectChildProcess = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Async child processes run through runChild(), which reports signal deaths as signals',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Files, as paths from `root` with `/` separators, that may use the async child_process APIs (the runner itself).',
          },
          runner: {
            type: 'string',
            minLength: 1,
            description:
              'Where `runChild()` lives, as the message names it (a path or a module specifier).',
          },
          root: {
            type: 'string',
            minLength: 1,
            description:
              'The directory `allow` paths are relative to. Defaults to the ESLint working directory.',
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [CHILD_PROCESS_DEFAULTS],
    messages: {
      direct:
        '`{{name}}` from child_process reports a signal death as whatever exit code the caller guesses (SIGINT and SIGHUP became 143). Use `runChild()` from {{runner}}, whose outcome union separates ok, exit, signal, spawn-error and timeout (ERR-08).',
    },
  },
  create(context) {
    const { allow, runner, root } = {
      ...CHILD_PROCESS_DEFAULTS,
      ...context.options[0],
    };
    // `allow` names files from the root, matched exactly: a suffix match
    // would also exempt any nested file of the same name.
    if (allow.includes(rootPath(root ?? context.cwd, context.filename)))
      return {};

    // Namespace bindings by variable, not name: a parameter `cp` that shadows
    // `import * as cp from 'child_process'` is someone else's object.
    const sourceCode = context.sourceCode;
    const namespaces = new Set();
    const bindNamespace = (declaration, name) => {
      for (const variable of sourceCode.getDeclaredVariables(declaration))
        if (variable.name === name) namespaces.add(variable);
    };
    const report = (node, name) =>
      context.report({ node, messageId: 'direct', data: { name, runner } });

    const isChildProcessRequire = node =>
      node?.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments[0]?.type === 'Literal' &&
      CHILD_PROCESS_MODULES.has(node.arguments[0].value);

    const checkPattern = declarator => {
      const pattern = declarator.id;
      if (pattern.type === 'Identifier') {
        bindNamespace(declarator, pattern.name);
        return;
      }
      if (pattern.type !== 'ObjectPattern') return;
      for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        const name = staticKey(property.key, property.computed);
        if (ASYNC_CHILD_APIS.has(name)) report(property, name);
      }
    };

    // An alias (`const cp2 = cp`, `const { spawn } = cp`) may be declared
    // before or after the binding it copies, so aliases and member uses are
    // collected and resolved once the whole file is known.
    const aliases = [];
    const members = [];

    return {
      'Program:exit'() {
        let pending = aliases;
        let grew = true;
        while (grew) {
          const before = pending.length;
          pending = pending.filter(declarator => {
            if (!namespaces.has(resolve(sourceCode, declarator.init)))
              return true;
            checkPattern(declarator);
            return false;
          });
          grew = pending.length < before;
        }
        for (const { node, name } of members)
          if (namespaces.has(resolve(sourceCode, node.object)))
            report(node, name);
      },
      ImportDeclaration(node) {
        if (!CHILD_PROCESS_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier') {
            const name =
              specifier.imported.type === 'Identifier'
                ? specifier.imported.name
                : specifier.imported.value;
            if (ASYNC_CHILD_APIS.has(name)) report(specifier, name);
          } else {
            bindNamespace(specifier, specifier.local.name);
          }
        }
      },
      VariableDeclarator(node) {
        const init =
          node.init?.type === 'AwaitExpression'
            ? node.init.argument
            : node.init;
        if (isChildProcessRequire(init)) checkPattern(node);
        else if (
          init?.type === 'ImportExpression' &&
          init.source.type === 'Literal' &&
          CHILD_PROCESS_MODULES.has(init.source.value)
        )
          checkPattern(node);
        else if (init?.type === 'Identifier') aliases.push(node);
      },
      MemberExpression(node) {
        const name = staticKey(node.property, node.computed);
        if (!ASYNC_CHILD_APIS.has(name)) return;
        if (isChildProcessRequire(node.object)) report(node, name);
        else if (node.object.type === 'Identifier')
          members.push({ node, name });
      },
    };
  },
};

export const errorHandlingRules = {
  'no-swallowed-catch': noSwallowedCatch,
  'safe-log': safeLogRule,
  'no-raw-error-string': noRawErrorString,
  'no-direct-child-process': noDirectChildProcess,
};
