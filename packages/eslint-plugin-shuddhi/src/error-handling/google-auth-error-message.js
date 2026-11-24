/**
 * google-auth-error-message: the error a google-auth-library verification
 * throws never reaches a log, a response or a new error.
 * `google-auth-error-message.test.ts` owns it.
 *
 * WHY. google-auth-library's ID-token verification errors concatenate the
 * raw token, or its decoded claims (`email`, `sub`), into `error.message`.
 * Logging the message, or wrapping it into an error a response or a log
 * shows, leaks a bearer credential. Classify the message by its constant
 * prefixes (`message.startsWith('Token used too late')`) and log only a
 * fixed code; `errorDetail(e)` would carry the token too.
 *
 * SCOPE. A catch clause whose `try` block calls `verifyIdToken`,
 * `verifySignedJwtWithCerts`, `verifySignedJwtWithCertsAsync` or
 * `getTokenInfo` (on any object: a client is often injected). In its body,
 * the caught value, or its `message` or `stack`, is reported where it lands
 * in a logging call (`log`, `info`, `warn`, `error`, `debug`, `trace`,
 * `fatal`, `safeLog`, `safeInvoke`), a `new` expression, a `throw`, a
 * `return`, or a `send`/`json` call. On the way it may pass through
 * templates, `+`, object and array literals, `String()`, `JSON.stringify`,
 * `errorDetail()` and a `const` it is stored in. Any other call takes it to
 * be classified, and a method called on the message (`startsWith`) reads it
 * without passing it on. A rethrow of the caught value itself (`throw e`) is
 * not reported: it adds nothing the original throw did not carry.
 */

const VERIFY_METHODS = new Set([
  'verifyIdToken',
  'verifySignedJwtWithCerts',
  'verifySignedJwtWithCertsAsync',
  'getTokenInfo',
]);

const LOG_METHODS = new Set([
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'fatal',
  'safeLog',
  'safeInvoke',
]);

const RESPONSE_METHODS = new Set(['send', 'json']);

/** Calls that turn the value into text and pass the text on. */
const CONVERSIONS = new Set(['String', 'errorDetail']);

const WRAPPERS = new Set([
  'TSAsExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSSatisfiesExpression',
  'ChainExpression',
]);

/** A call's method or function name, or null. */
function calleeName(call) {
  let callee = call.callee;
  while (WRAPPERS.has(callee.type)) callee = callee.expression;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed) {
    return callee.property.name ?? null;
  }
  return null;
}

/** `JSON.stringify(...)`. A member's object carries a `name` only as an Identifier. */
function isStringify(call) {
  const callee = call.callee;
  return (
    callee.type === 'MemberExpression' &&
    callee.object.name === 'JSON' &&
    calleeName(call) === 'stringify'
  );
}

/**
 * Does `node`'s subtree call a google-auth-library verification? `node` is
 * any field value of an ESTree node: a node, an array of them, null, or a
 * primitive (a node's own `type` is the string that tells it apart).
 */
function callsVerify(node) {
  if (!node || typeof node.type !== 'string') return false;
  if (node.type === 'CallExpression' && VERIFY_METHODS.has(calleeName(node))) {
    return true;
  }
  return Object.entries(node).some(
    ([key, value]) =>
      key !== 'parent' &&
      (Array.isArray(value) ? value.some(callsVerify) : callsVerify(value)),
  );
}

const googleAuthErrorMessage = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "A google-auth-library verification error's text never reaches a log, a response or a new error",
    },
    schema: [],
    messages: {
      leaks:
        "google-auth-library's verification errors embed the raw ID token or its claims in `message`, so `{{text}}` here puts a bearer credential into {{sink}}. Classify the message by its constant prefix (`message.startsWith(...)`) and log or return only a fixed code.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    /** Where `node`'s value lands: a sink's name, or null when it is classified or dropped. */
    function sinkOf(node, depth) {
      let child = node;
      let parent = node.parent;
      while (parent) {
        if (WRAPPERS.has(parent.type)) {
          child = parent;
          parent = parent.parent;
          continue;
        }
        switch (parent.type) {
          case 'MemberExpression':
            // The value climbs as the object: a non-computed property is a
            // name, and a computed one is a key.
            if (parent.computed) return null;
            if (parent.parent.type === 'CallExpression' && parent.parent.callee === parent) {
              // e.message.startsWith(...) reads it; e.toString() converts it.
              if (calleeName(parent.parent) !== 'toString') return null;
              child = parent.parent;
              parent = child.parent;
              continue;
            }
            if (!['message', 'stack'].includes(parent.property.name)) return null;
            break;
          case 'BinaryExpression':
            if (parent.operator !== '+') return null;
            break;
          case 'ConditionalExpression':
            if (parent.test === child) return null;
            break;
          case 'Property':
            if (parent.value !== child) return null;
            child = parent;
            parent = parent.parent; // the ObjectExpression
            continue;
          case 'CallExpression': {
            if (parent.callee === child) return null;
            const name = calleeName(parent);
            if (LOG_METHODS.has(name)) return `a \`${name}\` call`;
            if (RESPONSE_METHODS.has(name)) return `a \`${name}\` response`;
            if (CONVERSIONS.has(name) || isStringify(parent)) break;
            return null; // a classifier
          }
          case 'NewExpression':
            return parent.callee === child ? null : 'a new error';
          // A tagged template's literal climbs to its tag's call, which the
          // default case drops.
          case 'TemplateLiteral':
          case 'LogicalExpression':
          case 'ObjectExpression':
          case 'ArrayExpression':
          case 'SpreadElement':
            break;
          case 'ThrowStatement':
            return 'a thrown value';
          case 'ReturnStatement':
            return 'a returned value';
          case 'VariableDeclarator': {
            // Only an initialiser passes the value on. The declarator's own
            // id lands nowhere: it is one of its variable's references, and
            // a `var` redeclaring the caught name writes the caught binding.
            if (parent.init !== child || parent.id.type !== 'Identifier') {
              return null;
            }
            if (depth > 2) return null;
            const [variable] = sourceCode.getDeclaredVariables(parent);
            for (const reference of variable.references) {
              const sink = sinkOf(reference.identifier, depth + 1);
              if (sink) return sink;
            }
            return null;
          }
          default:
            return null;
        }
        child = parent;
        parent = parent.parent;
      }
      return null;
    }

    return {
      CatchClause(node) {
        if (node.param?.type !== 'Identifier') return;
        const tryStatement = node.parent;
        if (!callsVerify(tryStatement.block)) return;
        // An Identifier parameter declares the catch clause's one variable.
        const [variable] = sourceCode.getDeclaredVariables(node);
        for (const reference of variable.references) {
          const identifier = reference.identifier;
          // A bare rethrow or return of the caught value adds nothing.
          if (
            identifier.parent.type === 'ThrowStatement' ||
            identifier.parent.type === 'ReturnStatement'
          ) {
            continue;
          }
          const sink = sinkOf(identifier, 0);
          if (!sink) continue;
          // A reported value under a member is its object (sinkOf drops a key).
          const shown =
            identifier.parent.type === 'MemberExpression' ? identifier.parent : identifier;
          context.report({
            node: shown,
            messageId: 'leaks',
            data: { text: sourceCode.getText(shown), sink },
          });
        }
      },
    };
  },
};

export { googleAuthErrorMessage };
