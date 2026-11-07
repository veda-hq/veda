/**
 * `no-self-mock-sut` — forbid a colocated test from mocking its own subject.
 *
 * WHAT IT CATCHES
 * ---------------
 * In `foo.test.ts`, a `vi.mock('./foo')` replaces the System Under Test itself.
 * Every subsequent `expect()` then asserts against the mock, so the suite keeps
 * passing no matter what `foo.ts` does. Path forms that merely spell the same
 * module differently (`'../foo/foo'`, `'./foo.ts'`, `'.'` from an `index.test.ts`)
 * are the same violation and are normalised before comparison.
 *
 * HOW BIG A CONTROL THIS IS: SMALL, AND DELIBERATELY SO
 * -----------------------------------------------------
 * This rule is a fast-feedback BACKSTOP, never a primary control. Mocking away
 * the subject is ALREADY caught by a mutation gate: with the subject mocked,
 * its mutants come back Survived/NoCoverage and the mutation score drops below
 * threshold. The mutation gate is the control; this rule only moves the same
 * finding from a multi-minute Stryker run to the editor and to CI lint, with a
 * message that names the cause instead of a survived-mutant list. If this rule
 * were deleted tomorrow, the failure it guards would still be caught — later,
 * and less legibly.
 *
 * RESIDUAL GAP — OUT OF SCOPE (accepted risk)
 * -------------------------------------------
 * An over-mocked COLLABORATOR — the subject is real, but every dependency it
 * talks to is stubbed until the test only exercises glue — is NOT detected here
 * and has no control in this rule. There is no sound syntactic threshold for
 * "too many collaborator mocks": a genuine unit test of a service with five
 * injected ports legitimately mocks five modules. Detecting it needs a
 * behavioural signal (mutation survival inside the subject) or human judgement,
 * not an AST count.
 *
 * ✅ vi.mock('./telemetry')      // a collaborator of the subject
 * ✅ vi.mock('react-native')     // a package
 * ❌ vi.mock('./cache-service')  // from cache-service.test.ts — the subject
 */

import path from 'node:path';

/** `foo.test.ts`, `foo.test.tsx`, `foo.spec.js`, … — and the base name before it. */
const TEST_FILE_SUFFIX = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

/**
 * The suite qualifiers used when the config passes none: the trailing name
 * segments a colocated suite may carry between its subject and `.test`.
 */
export const DEFAULT_SUITE_QUALIFIERS = Object.freeze({
  qualifiers: Object.freeze(['integration', 'e2e', 'unit']),
});

/** A literal name, escaped for use inside a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Qualifiers a repository puts between the subject name and `.test`.
 *
 * `foo.integration.test.ts` tests `foo`, not `foo.integration`. Stripping only
 * `.test.ts` left the subject as `foo.integration`, which resolves to nothing,
 * so a `vi.mock('./foo')` in such a file — a self-mock of the real subject —
 * matched no subject path and went unreported.
 *
 * The list is the rule's option, so a repository whose mutation gate derives a
 * suite's subject from the same list can pass that one list to both and the
 * two cannot drift apart: `qualifiers` (`foo.integration.test.ts` tests foo),
 * and `stateMatrix` (`ProductsPage.states.test.tsx` tests ProductsPage), which
 * alone may carry one area segment matching the `stateMatrixArea` pattern
 * (`states.loading`). Null when no qualifier is configured.
 */
function qualifierPattern({ qualifiers, stateMatrix, stateMatrixArea }) {
  const alternatives = qualifiers.map(escapeRegExp);
  if (stateMatrix !== undefined) {
    const area =
      stateMatrixArea === undefined ? '' : `(?:\\.${stateMatrixArea})?`;
    alternatives.unshift(`${escapeRegExp(stateMatrix)}${area}`);
  }
  return alternatives.length === 0
    ? null
    : new RegExp(`\\.(?:${alternatives.join('|')})$`);
}

/** Module extensions a specifier may carry and Node/Vite would resolve away. */
const MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

/** Objects whose `.mock()` replaces a module: vitest's `vi`, jest's `jest`. */
const MOCK_OBJECTS = new Set(['vi', 'jest']);

/** Module-replacing methods on those objects. */
const MOCK_METHODS = new Set(['mock', 'doMock']);

/**
 * Absolute paths that mean "the subject of this test file".
 *
 * For `dir/foo.test.ts` that is `dir/foo`. For `dir/index.test.ts` it is both
 * `dir/index` AND `dir` itself, because `'.'` and `'../dir'` resolve to the
 * directory and Node then loads its `index`.
 */
function subjectPathsFor(filename, testQualifier) {
  const directory = path.dirname(filename);
  const stem = path.basename(filename).replace(TEST_FILE_SUFFIX, '');
  const base = testQualifier === null ? stem : stem.replace(testQualifier, '');
  const subjects = new Set([path.resolve(directory, base)]);
  if (base === 'index') {
    subjects.add(path.resolve(directory));
  }
  return subjects;
}

/**
 * Normalise a relative specifier to an absolute, extensionless path.
 * Returns null for bare package specifiers ('react', '@scope/pkg'), aliases
 * ('@/foo') and anything that is not a relative path — those can never be the
 * sibling subject.
 */
function resolveRelativeSpecifier(directory, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const withoutTrailingSlash = specifier.replace(/\/+$/, '');
  const withoutExtension = withoutTrailingSlash.replace(MODULE_EXTENSION, '');
  return path.resolve(directory, withoutExtension);
}

/** Match `vi.mock(...)` / `vi.doMock(...)` / `jest.mock(...)`, else null. */
function mockSpecifierOf(node) {
  const { callee } = node;
  if (
    callee.type !== 'MemberExpression' ||
    callee.computed ||
    callee.object.type !== 'Identifier' ||
    !MOCK_OBJECTS.has(callee.object.name) ||
    callee.property.type !== 'Identifier' ||
    !MOCK_METHODS.has(callee.property.name)
  ) {
    return null;
  }

  const [first] = node.arguments;
  if (
    first === undefined ||
    first.type !== 'Literal' ||
    typeof first.value !== 'string'
  ) {
    return null;
  }
  return first;
}

const NAMES = { type: 'array', items: { type: 'string', minLength: 1 } };

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a colocated test from mocking the module it is testing (fast-feedback backstop to the mutation gate)',
    },
    messages: {
      selfMockSut:
        "This test mocks '{{specifier}}' — its own subject. Every assertion below then " +
        'checks the mock, not the module under test, so the suite passes whatever the ' +
        'subject does. Import the subject for real and mock its collaborators instead.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          // Literal segment names: `foo.<qualifier>.test.ts` tests foo.
          qualifiers: NAMES,
          // The one qualifier that may carry an area segment after it.
          stateMatrix: { type: 'string', minLength: 1 },
          // A RegExp fragment the area segment must match whole.
          stateMatrixArea: { type: 'string', minLength: 1 },
          // Near-misses a shared list records as staying out. Not read here:
          // accepted so the list can be passed as it is.
          notQualifiers: NAMES,
        },
        // `// …` keys are comments in a shared JSON list.
        patternProperties: { '^//': {} },
        additionalProperties: false,
      },
    ],
    defaultOptions: [DEFAULT_SUITE_QUALIFIERS],
  },

  create(context) {
    const filename = context.filename;

    // Only colocated test files have a "subject" to self-mock.
    if (!TEST_FILE_SUFFIX.test(filename)) {
      return {};
    }

    const directory = path.dirname(filename);
    // ESLint merges `meta.defaultOptions` under what the config passes.
    const subjects = subjectPathsFor(
      filename,
      qualifierPattern(context.options[0]),
    );

    return {
      CallExpression(node) {
        const specifierNode = mockSpecifierOf(node);
        if (specifierNode === null) {
          return;
        }

        const resolved = resolveRelativeSpecifier(
          directory,
          specifierNode.value,
        );
        if (resolved === null || !subjects.has(resolved)) {
          return;
        }

        context.report({
          node,
          messageId: 'selfMockSut',
          data: { specifier: specifierNode.value },
        });
      },
    };
  },
};
