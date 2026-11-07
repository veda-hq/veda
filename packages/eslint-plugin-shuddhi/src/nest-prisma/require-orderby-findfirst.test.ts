import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';

import rule from './require-orderby-findfirst.js';

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

describe('require-orderby-findfirst', () => {
  it('documents itself as a problem rule', () => {
    assert.equal(rule.meta.type, 'problem');
    assert.match(rule.meta.docs.description, /orderBy/);
  });

  ruleTester.run('require-orderby-findfirst', rule as never, {
    valid: [
      {
        name: 'an orderBy named by an identifier key',
        code: "prisma.user.findFirst({ where: { id }, orderBy: { createdAt: 'desc' } });",
      },
      {
        name: 'an orderBy named by a string key',
        code: "prisma.user.findFirst({ where: { id }, 'orderBy': { id: 'asc' } });",
      },
      {
        // A variable cannot be judged statically; reporting it would be a
        // guess.
        name: 'an options object the rule cannot read',
        code: 'prisma.user.findFirst(args);',
      },
      {
        name: 'a different method',
        code: 'prisma.user.findMany({ where: { id } });',
      },
      {
        name: 'a bare call named findFirst is not a member call',
        code: 'findFirst({ where: { id } });',
      },
      {
        // Only a dotted `.findFirst` is matched.
        name: 'a computed member is not read',
        code: "prisma.user['findFirst']({ where: { id } });",
      },
      {
        // The key is read by its identifier, computed or not, so a computed
        // key spelled `orderBy` passes as the plain one does.
        name: 'a computed key spelled orderBy reads as orderBy',
        code: 'prisma.user.findFirst({ [orderBy]: { id: 1 } });',
      },
      {
        name: 'a private name is not an identifier key',
        code: 'class C { #findFirst() {} run() { this.#findFirst(); } }',
      },
    ],
    invalid: [
      {
        name: 'no arguments at all',
        code: 'prisma.user.findFirst();',
        errors: [{ messageId: 'missingOrderBy' }],
      },
      {
        name: 'a where without an orderBy',
        code: 'prisma.user.findFirst({ where: { id } });',
        errors: [{ messageId: 'missingOrderBy' }],
      },
      {
        name: 'an empty options object',
        code: 'tx.order.findFirst({});',
        errors: [{ messageId: 'missingOrderBy' }],
      },
      {
        // A spread may carry an orderBy, but the rule cannot see it.
        name: 'a spread is not an orderBy',
        code: 'prisma.user.findFirst({ ...base, where: { id } });',
        errors: [{ messageId: 'missingOrderBy' }],
      },
      {
        name: 'an orderBy nested below the top level does not count',
        code: "prisma.user.findFirst({ where: { orderBy: 'x' } });",
        errors: [{ messageId: 'missingOrderBy' }],
      },
      {
        name: 'a string key that is not orderBy',
        code: "prisma.user.findFirst({ 'where': { id } });",
        errors: [{ messageId: 'missingOrderBy' }],
      },
      {
        name: 'a computed key holding another name is neither form',
        code: 'prisma.user.findFirst({ [sortKey]: { id: 1 } });',
        errors: [{ messageId: 'missingOrderBy' }],
      },
    ],
  });
});
