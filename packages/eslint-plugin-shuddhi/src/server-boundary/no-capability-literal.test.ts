import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';

import rule, { readCapabilityVocabulary } from './no-capability-literal.js';

/**
 * CONTRACT-03 `no-capability-literal`. The
 * catalogue example, reduced to the smallest shape that still reproduces it,
 * fails for its own messageId; the corrected code and at least one near-miss
 * pass; and deleting only the guard from the corrected code fails again ("guard
 * removal flips").
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const FIXTURES = join(import.meta.dirname, 'fixtures');

// ---------------------------------------------------------------------------
// CONTRACT-03 — no-capability-literal

const CAPABILITY_OPTIONS = [
  { capabilities: ['USER_VIEW', 'ATTENDANCE_VIEW', 'ATTENDANCE_VIEW_ALL'] },
];
const WEB_APP = '/repo/web/src/App.tsx';

/** The web half of CONTRACT-03: a route gate restating the server's token. */
const CAPABILITY_EXAMPLE = `
const routes = [
  { path: 'users', element: <ProtectedRoute requiredCapability="USER_VIEW"><UsersPage /></ProtectedRoute> },
];`;

const CAPABILITY_CORRECTED = `
import { WEB_ROUTE_CAPABILITIES } from '@acme/shared';
const routes = [
  { path: 'users', element: <ProtectedRoute requiredCapability={WEB_ROUTE_CAPABILITIES.users}><UsersPage /></ProtectedRoute> },
];`;

const jsxTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      ecmaFeatures: { jsx: true },
    },
  },
});

/** The remedy text a report carries when only `capabilities` is configured. */
const DEFAULT_REMEDY = {
  vocabulary: 'Capability',
  routeMap: '',
  contracts: 'the shared contracts package',
};

jsxTester.run('no-capability-literal', rule, {
  valid: [
    {
      code: CAPABILITY_CORRECTED,
      filename: WEB_APP,
      options: CAPABILITY_OPTIONS,
    },
    {
      code: "import { Capability } from '@acme/shared';\nif (hasPermission(Capability.ATTENDANCE_VIEW)) {}",
      filename: '/repo/web/src/pages/AttendancePage.tsx',
      options: CAPABILITY_OPTIONS,
    },
    // Near-miss: a role name and a lowercase look-alike are not tokens.
    {
      code: "const role = 'ADMIN'; const label = 'user_view'; const t = `USER_VIEW ${x}`;",
      filename: WEB_APP,
      options: CAPABILITY_OPTIONS,
    },
  ],
  invalid: [
    {
      code: CAPABILITY_EXAMPLE,
      filename: WEB_APP,
      options: CAPABILITY_OPTIONS,
      errors: [
        {
          messageId: 'capabilityLiteral',
          data: { value: 'USER_VIEW', ...DEFAULT_REMEDY },
        },
      ],
    },
    // Guard removal: the map lookup replaced by the literal again.
    {
      code: CAPABILITY_CORRECTED.replace(
        '{WEB_ROUTE_CAPABILITIES.users}',
        "{['USER_VIEW']}",
      ),
      filename: WEB_APP,
      options: CAPABILITY_OPTIONS,
      errors: [{ messageId: 'capabilityLiteral' }],
    },
    // A local constant and a template literal are the same copy.
    {
      code: "const CAP_VIEW = 'ATTENDANCE_VIEW';\nconst all = `ATTENDANCE_VIEW_ALL`;",
      filename: '/repo/web/src/pages/AttendancePage.tsx',
      options: CAPABILITY_OPTIONS,
      errors: [
        {
          messageId: 'capabilityLiteral',
          data: { value: 'ATTENDANCE_VIEW', ...DEFAULT_REMEDY },
        },
        {
          messageId: 'capabilityLiteral',
          data: { value: 'ATTENDANCE_VIEW_ALL', ...DEFAULT_REMEDY },
        },
      ],
    },
    // The remedy options are substituted into the message.
    {
      code: CAPABILITY_EXAMPLE,
      filename: WEB_APP,
      options: [
        {
          ...CAPABILITY_OPTIONS[0],
          vocabulary: 'Perm',
          routeMap: 'ROUTE_PERMS',
          contractsPackage: '@acme/shared',
        },
      ],
      errors: [
        {
          messageId: 'capabilityLiteral',
          data: {
            value: 'USER_VIEW',
            vocabulary: 'Perm',
            routeMap: " or the route's `ROUTE_PERMS` entry",
            contracts: '@acme/shared',
          },
        },
      ],
    },
  ],
});

describe('readCapabilityVocabulary', () => {
  it('reads every token of the shared vocabulary', () => {
    const tokens: string[] = readCapabilityVocabulary(
      join(FIXTURES, 'capability.ts'),
    );
    assert.deepEqual(tokens, [
      'USER_VIEW',
      'ATTENDANCE_VIEW',
      'ATTENDANCE_VIEW_ALL',
      'INVOICE_RECALCULATE',
    ]);
  });

  it('reads a file URL as well as a path', () => {
    const tokens: string[] = readCapabilityVocabulary(
      pathToFileURL(join(FIXTURES, 'capability.ts')),
    );
    assert.equal(tokens.length, 4);
  });

  it('refuses a file with no tokens rather than disabling the rule', () => {
    assert.throws(
      () => readCapabilityVocabulary(join(FIXTURES, 'file.ts')),
      /no capability tokens found/,
    );
  });
});

jsxTester.run('no-capability-literal (branches)', rule, {
  valid: [
    // An import source is a module path, not a capability.
    {
      code: "import x from 'USER_VIEW';",
      filename: WEB_APP,
      options: CAPABILITY_OPTIONS,
    },
  ],
  invalid: [],
});

interface RuleMeta {
  meta: {
    type: string;
    docs: { description: string };
    messages: Record<string, string>;
  };
}

/** Each message's remedy, which RuleTester's messageId checks never read. */
const MESSAGES: Record<string, string> = {
  capabilityLiteral: 'Use `{{vocabulary}}.{{value}}`',
};

describe('no-capability-literal meta', () => {
  const { meta } = rule as RuleMeta;
  // A config without `files` applies to ESLint's default .js pattern.
  const linter = new Linter({ cwd: '/repo' });
  const lint = (code: string, options: object) =>
    linter.verify(
      code,
      {
        plugins: { boundary: { rules: { 'no-capability-literal': rule } } },
        rules: { 'boundary/no-capability-literal': ['error', options] },
      },
      '/repo/a.js',
    );

  it('reports problems and names the remedy in each text', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(meta.docs.description.includes('shared vocabulary'));
    assert.deepEqual(
      Object.keys(meta.messages).sort(),
      Object.keys(MESSAGES).sort(),
    );
    for (const [messageId, remedy] of Object.entries(MESSAGES)) {
      assert.ok(meta.messages[messageId].includes(remedy));
    }
  });

  it('reads the full message with every remedy option substituted', () => {
    const [message] = lint("const c = 'USER_VIEW';", {
      capabilities: ['USER_VIEW'],
      routeMap: 'WEB_ROUTE_CAPABILITIES',
      contractsPackage: '@acme/shared',
    });
    assert.equal(
      message?.message,
      "'USER_VIEW' is a capability written as a string, so renaming or removing it on the server leaves this gate silently wrong (CONTRACT-03). Use `Capability.USER_VIEW` or the route's `WEB_ROUTE_CAPABILITIES` entry from @acme/shared.",
    );
  });

  it('refuses an unknown option', () => {
    assert.throws(
      () => lint('', { capabilities: [], extra: true }),
      /additional properties/,
    );
  });

  it('refuses a vocabulary or route map that is not an identifier path', () => {
    assert.throws(
      () => lint('', { capabilities: [], vocabulary: 'a b' }),
      /pattern/,
    );
    assert.throws(
      () => lint('', { capabilities: [], routeMap: '1x' }),
      /pattern/,
    );
  });
});
