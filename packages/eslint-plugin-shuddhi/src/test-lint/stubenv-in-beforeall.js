/**
 * `vi.stubEnv` in a `beforeAll` (`no-stubenv-in-beforeall`).
 * `stubenv-in-beforeall.test.ts` owns it.
 *
 * WHY. With `unstubEnvs: true` in the Vitest config, Vitest calls
 * `vi.unstubAllEnvs()` before every test, so a variable stubbed in
 * `beforeAll` is gone by the first test, and the suite runs against the
 * machine's own value. A `beforeEach`, or the test itself, stubs it for each
 * test. Without that setting a `beforeAll` stub outlives the file instead,
 * which is the leak `unstubEnvs` exists to close.
 *
 * SCOPE. The call is reported wherever it runs inside a `beforeAll` callback,
 * nested functions included; a helper it calls is not read.
 */
import { enclosingFunctions, propertyName, unwrap } from './helpers.js';

const noStubenvInBeforeAll = {
  meta: {
    type: 'problem',
    docs: {
      description: 'vi.stubEnv runs per test, never in beforeAll',
    },
    schema: [],
    messages: {
      beforeAll:
        '`vi.stubEnv` in `beforeAll` is undone before the first test when the Vitest config sets `unstubEnvs: true`, so the tests run against the real value; without it, the stub outlives this file. Stub the variable in `beforeEach` or in the test.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (
          callee.type !== 'MemberExpression' ||
          unwrap(callee.object).type !== 'Identifier' ||
          unwrap(callee.object).name !== 'vi' ||
          propertyName(callee) !== 'stubEnv'
        ) {
          return;
        }
        const owner = enclosingFunctions(node, context).find(
          entry => entry.owner !== null,
        )?.owner;
        if (owner?.kind === 'hook' && owner.name === 'beforeAll') {
          context.report({ node, messageId: 'beforeAll' });
        }
      },
    };
  },
};

export { noStubenvInBeforeAll };
