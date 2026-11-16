/**
 * A script that installs its signal handlers after it spawns the child they
 * forward to (`signal-handler-before-spawn`), a SHELL-09 script rule.
 * `signal-handler-before-spawn.test.ts` owns it.
 *
 * WHY. `spawn()` returns with the child already running. Until the next
 * statement installs `process.on('SIGTERM', ...)`, the parent still has the
 * default action, and the OS can deschedule it in that gap: a SIGTERM then
 * kills the parent and orphans the child it meant to forward to. A warning:
 * a handler that only logs needs no order.
 *
 * SCOPE. A handler for SIGTERM, SIGINT or SIGHUP on `process` (`on`, `once`,
 * `addListener`, `prependListener`, `prependOnceListener`) is reported when a
 * call to `spawn` or `fork` (bare or as a member, `cp.spawn`) comes before it
 * in the same function body, or both are at the top of the file.
 */
import { calledMethod, isFunction, unwrap } from './helpers.js';

const SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP']);
const LISTENERS = new Set([
  'on',
  'once',
  'addListener',
  'prependListener',
  'prependOnceListener',
]);
const SPAWNS = new Set(['spawn', 'fork']);

/** The function (or the Program) whose body holds `node`. */
function ownBody(node) {
  let current = node.parent;
  while (current && !isFunction(current) && current.type !== 'Program') {
    current = current.parent;
  }
  return current;
}

/** The signal a `process.on('SIG…', …)` call handles, or null. */
function handledSignal(call) {
  const callee = unwrap(call.callee);
  if (callee.type !== 'MemberExpression') return null;
  const object = unwrap(callee.object);
  if (object.type !== 'Identifier' || object.name !== 'process') return null;
  if (!LISTENERS.has(calledMethod(call))) return null;
  const [signal] = call.arguments;
  return signal?.type === 'Literal' && SIGNALS.has(signal.value)
    ? signal.value
    : null;
}

/** `spawn(...)`, `fork(...)`, `cp.spawn(...)`. */
function isSpawn(call) {
  const callee = unwrap(call.callee);
  const name =
    callee.type === 'Identifier' ? callee.name : calledMethod(call);
  return SPAWNS.has(name);
}

const signalHandlerBeforeSpawn = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'A script installs its signal handlers before it spawns the child they forward to',
    },
    schema: [],
    messages: {
      after:
        'This {{signal}} handler is installed after `spawn()`, which returns with the child already running: a {{signal}} in between takes the default action, killing this process and orphaning the child. Install the handler before the spawn (it can forward to a `let child` it assigns later).',
    },
  },
  create(context) {
    const spawns = [];
    const handlers = [];
    return {
      CallExpression(node) {
        if (isSpawn(node)) spawns.push(node);
        const signal = handledSignal(node);
        if (signal) handlers.push({ node, signal });
      },
      'Program:exit'() {
        for (const { node, signal } of handlers) {
          const body = ownBody(node);
          if (
            spawns.some(
              spawn => ownBody(spawn) === body && spawn.range[0] < node.range[0],
            )
          ) {
            context.report({ node, messageId: 'after', data: { signal } });
          }
        }
      },
    };
  },
};

export { signalHandlerBeforeSpawn };
