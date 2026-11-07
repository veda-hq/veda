/**
 * The `nest-prisma` family: NestJS request boundaries, Prisma query and
 * transaction shapes, and the test-suite rules that keep a Nest app's tests
 * honest (loopback binding, no self-mocked subject).
 */
import { rules as nestPrismaRules } from './nest-prisma-rules.js';
import noSelfMockSut, { DEFAULT_SUITE_QUALIFIERS } from './no-self-mock-sut.js';
import requireOrderbyFindfirst from './require-orderby-findfirst.js';

export { DEFAULT_SUITE_QUALIFIERS };

export const rules = {
  ...nestPrismaRules,
  'require-orderby-findfirst': requireOrderbyFindfirst,
  'no-self-mock-sut': noSelfMockSut,
};
