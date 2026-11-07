import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import rule from './no-local-api-contract.js';

/**
 * CONTRACT-03 `no-local-api-contract`. The
 * catalogue example, reduced to the smallest shape that still reproduces it,
 * fails for its own messageId; the corrected code and at least one near-miss
 * pass; and deleting only the guard from the corrected code fails again ("guard
 * removal flips").
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

// ---------------------------------------------------------------------------
// CONTRACT-03 — no-local-api-contract

/** A mobile API client (services/api.ts) keeping a local wire copy. */
const CONTRACT03_EXAMPLE = `
export interface SyncOrderItem {
  skuId: string;
  qty: number;
}

export interface SyncOrder {
  clientId: string;
  total: string;
  items: SyncOrderItem[];
}

export async function syncOrders(orders: SyncOrder[]): Promise<void> {
  await http.post('/orders/sync', { orders: orders.map(o => ({ client_id: o.clientId })) });
}`;

const CONTRACT03_CORRECTED = `
import type { SyncOrder } from '@acme/shared';

export async function syncOrders(orders: SyncOrder[]): Promise<void> {
  await http.post('/orders/sync', { orders });
}`;

const MOBILE_API = '/repo/mobile/src/services/api.ts';

tester.run('no-local-api-contract', rule, {
  valid: [
    { code: CONTRACT03_CORRECTED, filename: MOBILE_API },
    // Near-miss: the same interface in a component is not a wire contract.
    {
      code: CONTRACT03_EXAMPLE,
      filename: '/repo/mobile/src/components/cart.tsx',
    },
    // Near-miss: a union alias in an API client is a vocabulary, not a shape.
    {
      code: "export type SyncStatus = 'PAID' | 'CANCELLED';",
      filename: MOBILE_API,
    },
    { code: 'export type Orders = SyncOrder[];', filename: MOBILE_API },
    // Near-miss: an internal type in a service that is not contract-named.
    {
      code: 'interface CacheEntry { at: number }',
      filename: '/repo/server/src/x/x.service.ts',
    },
    // The one allowed home of AuthenticatedRequest.
    {
      code: 'export interface AuthenticatedRequest extends Request { user: JwtUser }',
      filename: '/repo/server/src/auth/types/auth-request.type.ts',
      options: [{ allow: ['src/auth/types/auth-request.type.ts'] }],
    },
    // Contract-named, but in a module that faces no wire.
    {
      code: 'export interface ParseResponse { ok: boolean }',
      filename: '/repo/server/src/x/parse.helpers.ts',
    },
  ],
  invalid: [
    {
      code: CONTRACT03_EXAMPLE,
      filename: MOBILE_API,
      errors: [
        { messageId: 'clientContract' },
        { messageId: 'clientContract' },
      ],
    },
    // Guard removal: replace the shared import with a local copy again.
    {
      code: CONTRACT03_CORRECTED.replace(
        "import type { SyncOrder } from '@acme/shared';",
        'interface SyncOrder { clientId: string }',
      ),
      filename: MOBILE_API,
      errors: [{ messageId: 'clientContract' }],
    },
    // A web API client module named *Api (lib/api/recoApi.ts).
    {
      code: 'export type RecoSession = { storeId: string; createdAt: string };',
      filename: '/repo/web/src/lib/api/recoApi.ts',
      errors: [{ messageId: 'clientContract' }],
    },
    // A controller keeping its own AuthenticatedRequest.
    {
      code: 'interface AuthenticatedRequest { user: { sub: string } }',
      filename: '/repo/server/src/admin/controllers/admin-stores.controller.ts',
      options: [{ allow: ['src/auth/types/auth-request.type.ts'] }],
      errors: [{ messageId: 'namedContract' }],
    },
    // Interface DTOs declared in a service.
    {
      code: 'export interface CreateCampaignDto { name: string }',
      filename: '/repo/server/src/admin/services/admin-campaigns.service.ts',
      errors: [{ messageId: 'namedContract' }],
    },
    {
      code: 'export type GuardrailPayload = { id: string } & Base;',
      filename: '/repo/web/src/services/guardrails.ts',
      errors: [{ messageId: 'namedContract' }],
    },
    // The configured contracts package is named in the message.
    {
      code: 'export interface CreateCampaignDto { name: string }',
      filename: '/repo/server/src/admin/services/admin-campaigns.service.ts',
      options: [{ contractsPackage: '@acme/shared' }],
      errors: [
        {
          messageId: 'namedContract',
          data: { name: 'CreateCampaignDto', contracts: '@acme/shared' },
        },
      ],
    },
    // Without the option the message describes the package instead.
    {
      code: 'interface SyncOrder { clientId: string }',
      filename: MOBILE_API,
      errors: [
        {
          messageId: 'clientContract',
          data: {
            name: 'SyncOrder',
            contracts: 'the shared contracts package',
          },
        },
      ],
    },
  ],
});

tester.run('no-local-api-contract (branches)', rule, {
  valid: [
    // A contract-named alias of a non-object type is not a shape.
    {
      code: 'export type SyncResponse = Paged<Order>;',
      filename: '/repo/server/src/x/x.service.ts',
    },
  ],
  invalid: [],
});

describe('no-local-api-contract on a Windows path', () => {
  it('normalises backslashes before matching the API-client path', () => {
    const handlers: object = rule.create({
      filename: 'C:\\repo\\mobile\\src\\services\\api.ts',
      options: [],
    });
    assert.deepEqual(Object.keys(handlers), [
      'TSInterfaceDeclaration',
      'TSTypeAliasDeclaration',
    ]);
  });
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
  clientContract: 'Import the contract from {{contracts}}',
  namedContract: 'Declare it once in {{contracts}}',
};

describe('no-local-api-contract meta', () => {
  const { meta } = rule as RuleMeta;

  it('reports problems and names the remedy in each text', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(
      meta.docs.description.includes('come from the shared contracts package'),
    );
    assert.deepEqual(
      Object.keys(meta.messages).sort(),
      Object.keys(MESSAGES).sort(),
    );
    for (const [messageId, remedy] of Object.entries(MESSAGES)) {
      assert.ok(meta.messages[messageId].includes(remedy));
    }
  });

  it('reads the full message with the package substituted', () => {
    const linter = new Linter({ cwd: '/repo' });
    const [message] = linter.verify(
      'export interface CreateCampaignDto { name: string }',
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { b: { rules: { 'no-local-api-contract': rule } } },
        rules: {
          'b/no-local-api-contract': [
            'error',
            { contractsPackage: '@acme/shared' },
          ],
        },
      },
      '/repo/server/src/x/x.service.ts',
    );
    assert.equal(
      message?.message,
      '`CreateCampaignDto` is a locally declared request/response contract. Server, web and mobile drift when each keeps its own copy (CONTRACT-03). Declare it once in @acme/shared and import it.',
    );
  });

  it('refuses an unknown option', () => {
    // A config without `files` applies to ESLint's default .js pattern.
    const linter = new Linter({ cwd: '/repo' });
    const config: Linter.Config = {
      plugins: {
        boundary: { rules: { 'no-local-api-contract': rule } },
      },
      rules: {
        'boundary/no-local-api-contract': ['error', { allow: [], extra: true }],
      },
    };
    assert.throws(
      () => linter.verify('', config, '/repo/a.js'),
      /additional properties/,
    );
  });
});
