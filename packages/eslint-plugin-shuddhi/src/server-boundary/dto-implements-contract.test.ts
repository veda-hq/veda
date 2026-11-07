import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import rule from './dto-implements-contract.js';

/**
 * CONTRACT-03 `dto-implements-contract`.
 * The catalogue example, reduced to the smallest shape that still reproduces
 * it, fails for its own messageId; the corrected code and at least one
 * near-miss pass; and deleting only the guard from the corrected code fails
 * again ("guard removal flips").
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

/** Remove exactly one occurrence of `guard`, failing loudly if absent. */
function withoutGuard(code: string, guard: string): string {
  if (!code.includes(guard)) throw new Error(`guard not in code: ${guard}`);
  return code.replace(guard, '');
}

/** The contracts package every case names. */
const CONTRACTS = '@acme/shared';
const OPTIONS = [{ contractsPackage: CONTRACTS }];

// ---------------------------------------------------------------------------
// CONTRACT-03 — dto-implements-contract

/** The server half of a local wire copy: the sync DTOs restate the shape. */
const DTO_EXAMPLE = `
import { IsArray, IsUUID, ValidateNested } from 'class-validator';

export class SyncOrderDto {
  @IsUUID()
  id!: string;
}

export class SyncOrdersRequestDto {
  @IsArray()
  @ValidateNested({ each: true })
  orders!: SyncOrderDto[];
}`;

const DTO_CORRECTED = `
import { IsArray, IsUUID, ValidateNested } from 'class-validator';
import type {
  ClientId,
  SyncOrder as ISyncOrder,
  SyncOrdersRequest as ISyncOrdersRequest,
} from '@acme/shared';

export class SyncOrderDto implements ISyncOrder {
  @IsUUID()
  id!: ClientId;
}

export class SyncOrdersRequestDto implements ISyncOrdersRequest {
  @IsArray()
  @ValidateNested({ each: true })
  orders!: SyncOrderDto[];
}`;

const ORDERS_DTO = '/repo/server/src/orders/dto/orders.dto.ts';

tester.run('dto-implements-contract', rule, {
  valid: [
    { code: DTO_CORRECTED, filename: ORDERS_DTO, options: OPTIONS },
    // A namespace import and a generic contract both count.
    {
      code: "import * as Shared from '@acme/shared';\nexport class PageDto implements Shared.Paged<string> {}",
      filename: ORDERS_DTO,
      options: OPTIONS,
    },
    // Imports hoist: one written below the class still counts.
    {
      code: "export class ProductDto implements Product {}\nimport type { Product } from '@acme/shared';",
      filename: ORDERS_DTO,
      options: OPTIONS,
    },
    // A subpath export of the contracts package is the same package.
    {
      code: "import type { Product } from '@acme/shared/catalog';\nexport class ProductDto implements Product {}",
      filename: ORDERS_DTO,
      options: OPTIONS,
    },
    // Near-miss: not a DTO class.
    {
      code: 'export class OrdersService {}',
      filename: ORDERS_DTO,
      options: OPTIONS,
    },
    // Near-miss: an enum named *Dto is a vocabulary, not a wire shape.
    {
      code: "export enum InvoiceStatusDto { PAID = 'PAID' }",
      filename: ORDERS_DTO,
      options: OPTIONS,
    },
  ],
  invalid: [
    {
      code: DTO_EXAMPLE,
      filename: ORDERS_DTO,
      options: OPTIONS,
      errors: [
        {
          messageId: 'missingContract',
          data: { name: 'SyncOrderDto', contracts: CONTRACTS },
        },
        {
          messageId: 'missingContract',
          data: { name: 'SyncOrdersRequestDto', contracts: CONTRACTS },
        },
      ],
    },
    // Guard removal: drop one implements clause from the corrected file.
    {
      code: withoutGuard(DTO_CORRECTED, ' implements ISyncOrdersRequest'),
      filename: ORDERS_DTO,
      options: OPTIONS,
      errors: [
        {
          messageId: 'missingContract',
          data: { name: 'SyncOrdersRequestDto', contracts: CONTRACTS },
        },
      ],
    },
    // Near-miss: implementing a local type is not the shared contract.
    {
      code: "import type { HardwareEvent } from '../hardware.types';\nexport class HardwareEventDto implements HardwareEvent {}",
      filename: '/repo/server/src/hardware/dto/hardware.dto.ts',
      options: OPTIONS,
      errors: [{ messageId: 'missingContract' }],
    },
    // Near-miss: a shared import that the class does not implement.
    {
      code: "import { asClientId } from '@acme/shared';\nexport class UpdateOrderStatusDTO { status!: string }",
      filename: ORDERS_DTO,
      options: OPTIONS,
      errors: [{ messageId: 'missingContract' }],
    },
    // Near-miss: a package whose name only starts with the contracts package.
    {
      code: "import type { Product } from '@acme/shared-ui';\nexport class ProductDto implements Product {}",
      filename: ORDERS_DTO,
      options: OPTIONS,
      errors: [{ messageId: 'missingContract' }],
    },
  ],
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
  missingContract: 'write `implements`',
};

describe('dto-implements-contract meta', () => {
  const { meta } = rule as RuleMeta;

  it('reports problems and names the remedy in each text', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(
      meta.docs.description.includes('from the shared contracts package'),
    );
    assert.deepEqual(
      Object.keys(meta.messages).sort(),
      Object.keys(MESSAGES).sort(),
    );
    for (const [messageId, remedy] of Object.entries(MESSAGES)) {
      assert.ok(meta.messages[messageId].includes(remedy));
    }
  });

  const linter = new Linter({ cwd: '/repo' });
  const lint = (entry: Linter.RuleEntry) =>
    linter.verify(
      'export class OrdersDto {}',
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { b: { rules: { 'dto-implements-contract': rule } } },
        rules: { 'b/dto-implements-contract': entry },
      },
      '/repo/orders.dto.ts',
    );

  it('names the configured package in the message text', () => {
    const [message] = lint(['error', { contractsPackage: CONTRACTS }]);
    assert.equal(
      message?.message,
      '`OrdersDto` implements no contract type from @acme/shared, so the server can change this wire shape without the web or mobile client noticing (CONTRACT-03). Declare the shape in @acme/shared and write `implements` with it.',
    );
  });

  it('refuses a config that names no contracts package', () => {
    assert.throws(() => lint('error'), /contractsPackage/);
  });

  it('refuses an unknown option', () => {
    assert.throws(
      () => lint(['error', { contractsPackage: CONTRACTS, extra: true }]),
      /additional properties/,
    );
  });
});
