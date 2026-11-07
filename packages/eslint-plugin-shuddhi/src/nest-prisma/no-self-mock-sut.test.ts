import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';

import rule, { DEFAULT_SUITE_QUALIFIERS } from './no-self-mock-sut.js';

/**
 * Unit tests for the `no-self-mock-sut` ESLint rule.
 *
 * Every case that depends on the qualifier list passes it explicitly: the
 * shared list in fixtures/suite-qualifiers.json, in the shape a repository
 * hands the rule (comment keys and near-misses included).
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

interface SuiteQualifiers {
  stateMatrix: string;
  stateMatrixArea: string;
  qualifiers: string[];
  notQualifiers: string[];
}

const suiteQualifiers = JSON.parse(
  readFileSync(new URL('./fixtures/suite-qualifiers.json', import.meta.url), 'utf8'),
) as SuiteQualifiers;

const QUALIFIERS = [suiteQualifiers];

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 2022, sourceType: 'module' } },
});

/** A colocated service test: subject is `<dir>/cache-service`. */
const SERVICES = '/repo/mobile/src/services';
const CACHE_TEST = `${SERVICES}/cache-service.test.ts`;

/** A colocated test living in a directory of the same name. */
const DISCOUNT_DIR = '/repo/shared/src/discount';

const PAGES = '/repo/web/src/pages';

const SELF = [{ messageId: 'selfMockSut' as const }];

describe('no-self-mock-sut', () => {
  it('documents itself as a problem rule', () => {
    assert.equal(rule.meta.type, 'problem');
    assert.match(rule.meta.docs.description, /mutation gate/);
  });

  describe('flags vi.mock of the sibling subject and allows a collaborator mock', () => {
    ruleTester.run('no-self-mock-sut', rule as never, {
      valid: [
        {
          // A collaborator of the subject — the whole point of mocking.
          filename: CACHE_TEST,
          code: "vi.mock('./telemetry', () => ({ emitCacheMetric: vi.fn() }));",
          options: QUALIFIERS,
        },
        {
          // A package, not a relative sibling.
          filename: CACHE_TEST,
          code: "vi.mock('react-native');",
          options: QUALIFIERS,
        },
        {
          // A sibling whose name merely SHARES A PREFIX with the subject.
          filename: CACHE_TEST,
          code: "vi.mock('./cache-service-helpers');",
          options: QUALIFIERS,
        },
        {
          // The control on the qualifier strip: a collaborator mock from a
          // qualified test is still legitimate.
          filename: `${SERVICES}/cache-service.integration.test.ts`,
          code: "vi.mock('./telemetry');",
          options: QUALIFIERS,
        },
      ],
      invalid: [
        {
          filename: CACHE_TEST,
          code: "vi.mock('./cache-service');",
          options: QUALIFIERS,
          errors: SELF,
        },
        {
          // A QUALIFIED colocated test still tests `cache-service`, not
          // `cache-service.integration`. Stripping only `.test.ts` left a
          // subject that resolves to nothing, so this self-mock of the real
          // subject matched no path and went unreported.
          filename: `${SERVICES}/cache-service.integration.test.ts`,
          code: "vi.mock('./cache-service');",
          options: QUALIFIERS,
          errors: SELF,
        },
        {
          // The mock method variants replace a module just the same.
          filename: CACHE_TEST,
          code: "vi.doMock('./cache-service');\njest.mock('./cache-service');",
          options: QUALIFIERS,
          errors: [...SELF, ...SELF],
        },
      ],
    });
  });

  describe('flags a self-mock that passes through importOriginal', () => {
    ruleTester.run('no-self-mock-sut', rule as never, {
      valid: [],
      invalid: [
        {
          // A pass-through factory looks harmless but is not: it still routes
          // the subject through the mock registry, so a later `vi.mocked()`
          // or partial override silently swaps the code under test out.
          filename: CACHE_TEST,
          code: [
            "vi.mock('./cache-service', async importOriginal => {",
            '  return await importOriginal();',
            '});',
          ].join('\n'),
          options: QUALIFIERS,
          errors: SELF,
        },
      ],
    });
  });

  describe('normalises specifier spellings that resolve to the same subject', () => {
    ruleTester.run('no-self-mock-sut', rule as never, {
      valid: [],
      invalid: [
        {
          // Up-and-back-down: `../discount/discount-engine` is `./discount-engine`.
          filename: `${DISCOUNT_DIR}/discount-engine.test.ts`,
          code: "vi.mock('../discount/discount-engine');",
          options: QUALIFIERS,
          errors: SELF,
        },
        {
          // An explicit extension resolves to the same module.
          filename: CACHE_TEST,
          code: "vi.mock('./cache-service.ts');",
          options: QUALIFIERS,
          errors: SELF,
        },
        {
          // An index test's subject is also its own DIRECTORY: both `'.'` and
          // `'../discount'` load `discount/index`, and a trailing slash too.
          filename: `${DISCOUNT_DIR}/index.test.ts`,
          code: "vi.mock('.');\nvi.mock('../discount');\nvi.mock('./index');\nvi.mock('../discount/');",
          options: QUALIFIERS,
          errors: [...SELF, ...SELF, ...SELF, ...SELF],
        },
      ],
    });
  });

  describe('ignores non-test files, non-colocated tests and dynamic specifiers', () => {
    ruleTester.run('no-self-mock-sut', rule as never, {
      valid: [
        {
          // Not a test file — there is no subject to self-mock.
          filename: `${SERVICES}/cache-service.ts`,
          code: "vi.mock('./cache-service');",
          options: QUALIFIERS,
        },
        {
          // An integration test is not colocated with any one subject, so
          // mocking a service from it is a collaborator mock.
          filename: '/repo/mobile/__tests__/integration/sync-flow.test.ts',
          code: "vi.mock('../../src/services/cache-service');",
          options: QUALIFIERS,
        },
        {
          // Not statically analysable — never guess.
          filename: CACHE_TEST,
          code: 'vi.mock(subjectPath);',
          options: QUALIFIERS,
        },
        {
          // A literal that is not a string names no module.
          filename: CACHE_TEST,
          code: 'vi.mock(42);\nvi.mock();',
          options: QUALIFIERS,
        },
        {
          // A same-named method on something that is not vi/jest.
          filename: CACHE_TEST,
          code: "server.mock('./cache-service');",
          options: QUALIFIERS,
        },
        {
          // Neither a computed member, a member of a member, a bare call nor
          // another vi method replaces a module.
          filename: CACHE_TEST,
          code: "vi['mock']('./cache-service');\na.vi.mock('./cache-service');\nmock('./cache-service');\nvi.fn('./cache-service');",
          options: QUALIFIERS,
        },
        {
          // A private name is not an identifier property.
          filename: CACHE_TEST,
          code: "class C { #mock() {} run() { const vi = this; vi.#mock('./cache-service'); } }",
          options: QUALIFIERS,
        },
      ],
      invalid: [],
    });
  });

  describe('strips every qualifier the mutation gate strips', () => {
    // Every entry of the shared list, each pinned by its own case, so a
    // builder that joined or anchored them wrongly drops at least one.
    const qualifiers = [...suiteQualifiers.qualifiers, suiteQualifiers.stateMatrix];
    it('has more than one qualifier to pin', () => {
      assert.ok(qualifiers.length > 1);
    });

    ruleTester.run('no-self-mock-sut', rule as never, {
      valid: [],
      invalid: qualifiers.map(qualifier => ({
        filename: `${SERVICES}/cache-service.${qualifier}.test.ts`,
        code: "vi.mock('./cache-service');",
        options: QUALIFIERS,
        errors: SELF,
      })),
    });
  });

  describe('strips one lowercase area segment after states, and nothing more', () => {
    ruleTester.run('no-self-mock-sut', rule as never, {
      valid: [
        {
          // An area is lowercase, as on disk; this names some other subject.
          filename: `${PAGES}/ProductsPage.states.Loading.test.tsx`,
          code: "vi.mock('./ProductsPage');",
          options: QUALIFIERS,
        },
        {
          // One area segment only.
          filename: `${PAGES}/ProductsPage.states.loading.empty.test.tsx`,
          code: "vi.mock('./ProductsPage');",
          options: QUALIFIERS,
        },
        {
          // The area belongs to a state matrix, not to any other qualifier.
          filename: `${PAGES}/ProductsPage.integration.loading.test.tsx`,
          code: "vi.mock('./ProductsPage');",
          options: QUALIFIERS,
        },
      ],
      invalid: [
        {
          filename: `${PAGES}/ProductsPage.states.loading.test.tsx`,
          code: "vi.mock('./ProductsPage');",
          options: QUALIFIERS,
          errors: SELF,
        },
        {
          filename: `${PAGES}/ProductsPage.states.a11y-2.test.tsx`,
          code: "vi.mock('./ProductsPage');",
          options: QUALIFIERS,
          errors: SELF,
        },
      ],
    });
  });

  describe('leaves names that are not a whole trailing qualifier alone', () => {
    ruleTester.run('no-self-mock-sut', rule as never, {
      valid: [
        {
          // `usecase` is a source suffix: this suite tests
          // `day-receipt.usecase.ts`, and `day-receipt` is a collaborator.
          filename: `${SERVICES}/day-receipt.usecase.test.ts`,
          code: "vi.mock('./day-receipt');",
          options: QUALIFIERS,
        },
        {
          // `meta` tests the property suites, not a source called `foo`.
          filename: `${SERVICES}/foo.meta.test.ts`,
          code: "vi.mock('./foo');",
          options: QUALIFIERS,
        },
        {
          // Only the LAST qualifier is stripped.
          filename: `${SERVICES}/cache-service.integration.unit.test.ts`,
          code: "vi.mock('./cache-service');",
          options: QUALIFIERS,
        },
        {
          // A qualifier must be the whole segment, not its prefix.
          filename: `${SERVICES}/cache-service.integration-helpers.test.ts`,
          code: "vi.mock('./cache-service');",
          options: QUALIFIERS,
        },
        {
          // ...nor its suffix without the dot.
          filename: `${SERVICES}/cache-serviceunit.test.ts`,
          code: "vi.mock('./cache-service');",
          options: QUALIFIERS,
        },
      ],
      invalid: [
        {
          filename: `${SERVICES}/day-receipt.usecase.test.ts`,
          code: "vi.mock('./day-receipt.usecase');",
          options: QUALIFIERS,
          errors: SELF,
        },
        {
          filename: `${SERVICES}/foo.meta.test.ts`,
          code: "vi.mock('./foo.meta');",
          options: QUALIFIERS,
          errors: SELF,
        },
        {
          filename: `${SERVICES}/cache-service.integration.unit.test.ts`,
          code: "vi.mock('./cache-service.integration');",
          options: QUALIFIERS,
          errors: SELF,
        },
      ],
    });
  });

  describe('without options: the generic default list', () => {
    it('strips integration, e2e and unit only', () => {
      assert.deepEqual([...DEFAULT_SUITE_QUALIFIERS.qualifiers], ['integration', 'e2e', 'unit']);
    });

    ruleTester.run('no-self-mock-sut', rule as never, {
      valid: [
        {
          // No state matrix by default: `states` is part of the subject name.
          filename: `${PAGES}/ProductsPage.states.test.tsx`,
          code: "vi.mock('./ProductsPage');",
        },
        {
          filename: `${SERVICES}/cache-service.properties.test.ts`,
          code: "vi.mock('./cache-service');",
        },
      ],
      invalid: [
        ...['integration', 'e2e', 'unit'].map(qualifier => ({
          filename: `${SERVICES}/cache-service.${qualifier}.test.ts`,
          code: "vi.mock('./cache-service');",
          errors: SELF,
        })),
        {
          filename: `${PAGES}/ProductsPage.states.test.tsx`,
          code: "vi.mock('./ProductsPage.states');",
          errors: SELF,
        },
        {
          // `.spec` and other module extensions mark a colocated test too.
          filename: `${SERVICES}/cache-service.spec.mjs`,
          code: "jest.doMock('./cache-service.mjs');",
          errors: SELF,
        },
      ],
    });
  });

  describe('with options of other shapes', () => {
    ruleTester.run('no-self-mock-sut', rule as never, {
      valid: [
        {
          // An empty list strips nothing: `foo.integration` is the subject.
          filename: `${SERVICES}/cache-service.integration.test.ts`,
          code: "vi.mock('./cache-service');",
          options: [{ qualifiers: [] }],
        },
        {
          // A qualifier is a literal name: its `.` matches only a dot.
          filename: `${SERVICES}/cache-service.aXb.test.ts`,
          code: "vi.mock('./cache-service');",
          options: [{ qualifiers: ['a.b'] }],
        },
        {
          // A state matrix with no area pattern carries no area segment.
          filename: `${PAGES}/ProductsPage.states.loading.test.tsx`,
          code: "vi.mock('./ProductsPage');",
          options: [{ qualifiers: [], stateMatrix: 'states' }],
        },
      ],
      invalid: [
        {
          filename: `${SERVICES}/cache-service.a.b.test.ts`,
          code: "vi.mock('./cache-service');",
          options: [{ qualifiers: ['a.b'] }],
          errors: SELF,
        },
        {
          filename: `${PAGES}/ProductsPage.states.test.tsx`,
          code: "vi.mock('./ProductsPage');",
          options: [{ qualifiers: [], stateMatrix: 'states' }],
          errors: SELF,
        },
        {
          // A list that omits `qualifiers` keeps the default ones.
          filename: `${SERVICES}/cache-service.unit.test.ts`,
          code: "vi.mock('./cache-service');",
          options: [{ stateMatrix: 'states' }],
          errors: SELF,
        },
      ],
    });
  });

  it('refuses an option it does not define, and accepts comment keys', () => {
    const lint = (options: unknown) =>
      new Linter({ configType: 'flat' }).verify(
        "vi.mock('./foo');",
        [
          {
            files: ['**/*.js'],
            plugins: { shuddhi: { rules: { 'no-self-mock-sut': rule } } as never },
            rules: { 'shuddhi/no-self-mock-sut': ['error', options] as never },
          },
        ],
        // Relative to the linter's cwd: a file outside it matches no config.
        { filename: 'foo.test.js' },
      );
    // A misspelt key would otherwise fall back to the default list silently.
    assert.throws(() => lint({ qualifier: ['unit'] }), /additional properties/);
    assert.equal(lint({ '// note': ['why'], qualifiers: [] }).length, 1);
  });
});
