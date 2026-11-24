import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';

import rule, {
  regressingCursorColumns,
  splitTopLevel,
} from './compare-and-set.js';

/**
 * RACE-02 `compare-and-set`. The catalogue
 * example, reduced to the smallest shape that still reproduces it, fails for
 * its own messageId; the corrected code and at least one near-miss pass; and
 * deleting only the guard from the corrected code fails again ("guard removal
 * flips").
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

// ---------------------------------------------------------------------------
// RACE-02 — compare-and-set

/** An order service `updateStatus` as reviewers found it, reduced. */
const RACE02_EXAMPLE = `
class OrdersService {
  async updateStatus(clientId, dto) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { client_id: clientId },
    });
    if (!invoice) {
      throw new NotFoundException(\`Order \${clientId} not found\`);
    }
    const currentStatus = invoice.status;
    const newStatus = dto.status;
    const allowedTransitions = this.getAllowedTransitions(currentStatus);
    if (!allowedTransitions.includes(newStatus)) {
      throw new BadRequestException('Cannot transition');
    }
    const updated = await this.prisma.invoice.update({
      where: { client_id: clientId },
      data: { status: newStatus },
    });
    return updated;
  }
}`;

/** The fix review asked for: the current status in the WHERE, then the count. */
const RACE02_CORRECTED = RACE02_EXAMPLE.replace(
  `const updated = await this.prisma.invoice.update({
      where: { client_id: clientId },`,
  `const updated = await this.prisma.invoice.updateMany({
      where: { client_id: clientId, status: currentStatus },`,
);

tester.run('compare-and-set', rule, {
  valid: [
    { code: RACE02_CORRECTED },
    // Near-miss: an authorisation check on an immutable owner key.
    {
      code: `async function f(id, userId) {
        const row = await prisma.note.findUnique({ where: { id } });
        if (row.user_id !== userId) throw new ForbiddenException();
        await prisma.note.update({ where: { id }, data: { body: 'x' } });
      }`,
    },
    // Near-miss: the write addresses OTHER rows (id: { not: row.id }).
    {
      code: `async function f(id) {
        const row = await prisma.faceEnrollment.findUnique({ where: { id } });
        if (row.status !== 'PENDING') throw new ConflictException();
        await prisma.faceEnrollment.updateMany({
          where: { user_id: row.user_id, id: { not: row.id }, status: 'APPROVED' },
          data: { superseded_at: new Date() },
        });
      }`,
    },
    // Near-miss: a non-unique key of the read row (user_id) is not that row.
    {
      code: `async function f(id) {
        const row = await prisma.faceEnrollment.findUnique({ where: { id } });
        if (row.reference_key === null) throw new ConflictException();
        await prisma.faceEnrollment.updateMany({
          where: { user_id: row.user_id, status: 'APPROVED' },
          data: { superseded_at: new Date() },
        });
      }`,
    },
    // Near-miss: a loaded relation checked for emptiness is not a column.
    {
      code: `async function f(id) {
        const invoice = await prisma.invoice.findUnique({ where: { id }, include: { items: true } });
        if (invoice.items.length === 0) throw new BadRequestException();
        await prisma.invoice.update({ where: { id: invoice.id }, data: { note: 'x' } });
      }`,
    },
    // A row lock makes the read-then-write safe.
    {
      code: `async function f(id) {
        return prisma.$transaction(async tx => {
          await tx.$queryRaw\`SELECT 1 FROM "Invoice" WHERE id = \${id} FOR UPDATE\`;
          const inv = await tx.invoice.findUnique({ where: { id } });
          if (inv.status !== 'OPEN') throw new ConflictException();
          await tx.invoice.update({ where: { id }, data: { status: 'PAID' } });
        });
      }`,
    },
    // Serializable isolation also holds the guard.
    {
      code: `async function f(id) {
        return prisma.$transaction(async tx => {
          const inv = await tx.invoice.findUnique({ where: { id } });
          if (inv.status !== 'OPEN') throw new ConflictException();
          await tx.invoice.update({ where: { id }, data: { status: 'PAID' } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      }`,
    },
    // An OR over the claimed column is a compare on it.
    {
      code: `async function lock(id, userId) {
        await prisma.session.updateMany({
          where: { id, OR: [{ locked_by: null }, { locked_by: userId }] },
          data: { locked_by: userId },
        });
      }`,
    },
    // A WHERE built elsewhere cannot be judged.
    {
      code: 'async function f(where) { await prisma.invoice.update({ where, data: { status: "X" } }); }',
    },
    // Cursor upsert that only advances.
    {
      code: "db.execute('INSERT INTO c (k, cursor) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET cursor = MAX(cursor, excluded.cursor)');",
    },
    {
      code: 'db.execute(`INSERT INTO c (k, cursor) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET cursor = GREATEST(c.cursor, EXCLUDED.cursor)`);',
    },
    {
      code: 'db.execute(`INSERT INTO c (k, last_seen) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET last_seen = EXCLUDED.last_seen WHERE c.last_seen < EXCLUDED.last_seen`);',
    },
    {
      code: "db.execute('INSERT INTO p (k, name) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET name = excluded.name');",
    },
    // The mirrored comparison advances the cursor too.
    {
      code: 'db.execute(`INSERT INTO c (k, cursor) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET cursor = EXCLUDED.cursor WHERE EXCLUDED.cursor >= c.cursor RETURNING k`);',
    },
    // An OR whose every branch constrains the column still compares on it,
    // inside an AND conjunct as well.
    {
      code: `async function pay(id) {
        const inv = await prisma.invoice.findUnique({ where: { id } });
        if (inv.status !== 'OPEN') throw new ConflictException();
        await prisma.invoice.updateMany({
          where: { AND: [{ id }, { OR: [{ status: 'OPEN', paid_by: null }, { status: 'DRAFT' }] }] },
          data: { status: 'PAID' },
        });
      }`,
    },
  ],
  invalid: [
    {
      code: RACE02_EXAMPLE,
      errors: [
        {
          messageId: 'staleGuard',
          data: {
            method: 'update',
            delegate: 'invoice',
            variable: 'invoice',
            field: 'status',
          },
        },
      ],
    },
    // Guard removal: drop `status` from the corrected WHERE.
    {
      code: withoutGuard(RACE02_CORRECTED, ', status: currentStatus'),
      errors: [{ messageId: 'staleGuard' }],
    },
    // A session service: lock checked, id-only write.
    {
      code: `class SessionService {
        async updateStatus(id, userId, status) {
          const session = await this.prisma.reconciliationSession.findUnique({ where: { id } });
          if (session.locked_by !== userId) throw new ForbiddenException();
          return this.prisma.reconciliationSession.update({ where: { id }, data: { status } });
        }
      }`,
      errors: [{ messageId: 'staleGuard' }],
    },
    // A throwing assert helper is a guard too.
    {
      code: `async function f(id, next) {
        const order = await prisma.returnOrder.findUnique({ where: { id } });
        assertTransition(order.status, next);
        await prisma.returnOrder.update({ where: { id: order.id }, data: { status: next } });
      }`,
      errors: [{ messageId: 'staleGuard' }],
    },
    // Destructured guard field.
    {
      code: `async function f(id) {
        const row = await prisma.attendanceDay.findUnique({ where: { id } });
        const { source } = row;
        if (source !== 'PUNCH') return;
        await prisma.attendanceDay.update({ where: { id }, data: { minutes: 1 } });
      }`,
      errors: [{ messageId: 'staleGuard' }],
    },
    // An auth service consuming a token without used_at.
    {
      code: `async function consume(id) {
        await prisma.refreshToken.update({ where: { id }, data: { used_at: new Date() } });
      }`,
      errors: [{ messageId: 'blindTransition' }],
    },
    // A sync cursor upsert that regresses.
    {
      code: "db.execute('INSERT INTO sync_cursor (k, cursor) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET cursor = excluded.cursor');",
      errors: [{ messageId: 'cursorRegress' }],
    },
    {
      code: 'prisma.$executeRaw`INSERT INTO w (k, last_seen) VALUES (${k}, ${v}) ON CONFLICT (k) DO UPDATE SET last_seen = ${v}`;',
      errors: [{ messageId: 'cursorRegress' }],
    },
    // LEAST and MIN keep the SMALLER cursor.
    {
      code: 'db.execute(`INSERT INTO c (k, cursor) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET cursor = LEAST(c.cursor, EXCLUDED.cursor)`);',
      errors: [{ messageId: 'cursorRegress', data: { column: 'cursor' } }],
    },
    {
      code: "db.execute('INSERT INTO c (k, cursor) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET cursor = MIN(cursor, excluded.cursor)');",
      errors: [{ messageId: 'cursorRegress', data: { column: 'cursor' } }],
    },
    // A WHERE that does not compare the cursor guards nothing.
    {
      code: 'db.execute(`INSERT INTO c (k, cursor) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET cursor = EXCLUDED.cursor WHERE c.enabled`);',
      errors: [{ messageId: 'cursorRegress', data: { column: 'cursor' } }],
    },
    // A key in one OR branch alone does not guard the write.
    {
      code: `async function pay(id) {
        const inv = await prisma.invoice.findUnique({ where: { id } });
        if (inv.status !== 'OPEN') throw new ConflictException();
        await prisma.invoice.updateMany({
          where: { id, OR: [{ status: 'OPEN' }, { paid_by: null }] },
          data: { status: 'PAID' },
        });
      }`,
      errors: [
        {
          messageId: 'staleGuard',
          data: {
            method: 'updateMany',
            delegate: 'invoice',
            variable: 'inv',
            field: 'status',
          },
        },
      ],
    },
  ],
});

describe('regressingCursorColumns', () => {
  it('splits SET assignments outside parentheses', () => {
    assert.deepEqual(
      regressingCursorColumns(
        'INSERT INTO t VALUES (1) ON CONFLICT (k) DO UPDATE SET version = GREATEST(t.version, EXCLUDED.version), cursor = $2 RETURNING *',
      ),
      ['cursor'],
    );
  });

  it('reports nothing without an upsert', () => {
    assert.deepEqual(regressingCursorColumns('UPDATE t SET cursor = 1'), []);
  });
});

/** A read of `row`, a check that exits on `test`, then `write`. */
const readGuardWrite = (
  write: string,
  {
    read = 'prisma.invoice.findUnique({ where: { id } })',
    test = "row.status !== 'OPEN'",
  }: { read?: string; test?: string } = {},
): string => `async function f(id, otherId, base, me, strict, next) {
  const row = await ${read};
  if (${test}) throw new ConflictException();
  await ${write};
}`;

const NOTE_BY_ID =
  "prisma.invoice.update({ where: { id }, data: { note: 'x' } })";

/** Mirrors PRISMA_ROOTS. */
const PRISMA_ROOT_NAMES = ['db', 'tx', 'trx', 'transaction', 'client'];
/** Mirrors READ_ONE. */
const READ_ONE_METHODS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
];
/** Mirrors GUARDED_WRITES. */
const GUARDED_WRITE_METHODS = ['update', 'updateMany', 'delete', 'deleteMany'];
/** Mirrors TRANSITION_WRITES. */
const TRANSITION_WRITE_METHODS = ['update', 'updateMany'];
/** Mirrors TRANSITION_COLUMNS. */
const TRANSITION_COLUMN_NAMES = [
  'status',
  'state',
  'locked_by',
  'lockedBy',
  'locked_at',
  'used_at',
  'usedAt',
  'consumed_at',
  'claimed_by',
  'claimed_at',
];
/** Mirrors ROW_KEYS. */
const ROW_KEY_NAMES = ['id', 'uuid', 'client_id', 'key'];
/** Mirrors COLLECTION_MEMBERS. */
const COLLECTION_MEMBER_NAMES = [
  'length',
  'some',
  'every',
  'find',
  'filter',
  'includes',
  'map',
  'forEach',
];

tester.run('compare-and-set (vocabulary)', rule, {
  valid: COLLECTION_MEMBER_NAMES.map(member => ({
    code: readGuardWrite(
      "prisma.invoice.update({ where: { id: row.id }, data: { note: 'x' } })",
      { test: `row.items.${member}(isBad)` },
    ),
  })),
  invalid: [
    ...PRISMA_ROOT_NAMES.map(root => ({
      code: `async function f(id) { await ${root}.invoice.update({ where: { id }, data: { status: 'X' } }); }`,
      errors: [
        {
          messageId: 'blindTransition',
          data: { method: 'update', delegate: 'invoice', field: 'status' },
        },
      ],
    })),
    ...READ_ONE_METHODS.map(method => ({
      code: readGuardWrite(NOTE_BY_ID, {
        read: `prisma.invoice.${method}({ where: { id } })`,
      }),
      errors: [{ messageId: 'staleGuard' }],
    })),
    ...GUARDED_WRITE_METHODS.map(method => ({
      code: readGuardWrite(`prisma.invoice.${method}({ where: { id } })`),
      errors: [
        {
          messageId: 'staleGuard',
          data: {
            method,
            delegate: 'invoice',
            variable: 'row',
            field: 'status',
          },
        },
      ],
    })),
    ...TRANSITION_WRITE_METHODS.map(method => ({
      code: `async function f(id) { await prisma.invoice.${method}({ where: { id }, data: { state: 'X' } }); }`,
      errors: [
        {
          messageId: 'blindTransition',
          data: { method, delegate: 'invoice', field: 'state' },
        },
      ],
    })),
    ...TRANSITION_COLUMN_NAMES.map(column => ({
      code: `async function f(id, v) { await prisma.session.update({ where: { id }, data: { ${column}: v } }); }`,
      errors: [
        {
          messageId: 'blindTransition',
          data: { method: 'update', delegate: 'session', field: column },
        },
      ],
    })),
    ...ROW_KEY_NAMES.map(key => ({
      code: readGuardWrite(
        `prisma.invoice.update({ where: { ${key}: row.${key} }, data: { note: 'x' } })`,
      ),
      errors: [{ messageId: 'staleGuard' }],
    })),
  ],
});

tester.run('compare-and-set (branches)', rule, {
  valid: [
    // An assertion whose result is kept is not a statement, so not a guard.
    {
      code: `async function f(id, next) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        const allowed = assertTransition(row.status, next);
        await ${NOTE_BY_ID};
      }`,
    },
    // A member chain that does not start at `this` is not a client root.
    {
      code: "async function f(id) { await deps.prisma.invoice.update({ where: { id }, data: { status: 'X' } }); }",
    },
    // A read in one function does not guard a write in another.
    {
      code: `async function a(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') throw new ConflictException();
      }
      async function b(id) {
        await ${NOTE_BY_ID};
      }`,
    },
    // A spread in the WHERE (top level, AND conjunct, OR branch) is unjudged.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { ...base, id }, data: { note: 'x' } })",
      ),
    },
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id, AND: [{ ...base }] }, data: { note: 'x' } })",
      ),
    },
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id, OR: [{ ...base }, { status: 'X' }] }, data: { note: 'x' } })",
      ),
    },
    // A compound unique key carries its inner columns.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id_version: { id: row.id, version: 3 } }, data: { note: 'x' } })",
        { test: 'row.version !== 3' },
      ),
    },
    // A compound key, or an operator object, that names another row.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id_version: { id: otherId, version: 3 } }, data: { note: 'x' } })",
      ),
    },
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id: { not: row.id } }, data: { note: 'x' } })",
      ),
    },
    // The same key with a different value is a different row.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id: otherId }, data: { note: 'x' } })",
      ),
    },
    // An if that does not exit is not a guard, nested or not.
    {
      code: `async function f(id, strict) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') if (strict) log();
        await ${NOTE_BY_ID};
      }`,
    },
    {
      code: `async function f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') log();
        await ${NOTE_BY_ID};
      }`,
    },
    // A nested function's reads are not the test's.
    { code: readGuardWrite(NOTE_BY_ID, { test: 'check(() => row.status)' }) },
    {
      code: readGuardWrite(NOTE_BY_ID, {
        test: 'check(function () { return row.status; })',
      }),
    },
    {
      code: readGuardWrite(NOTE_BY_ID, {
        test: 'class { static { function g() { return row.status; } } }',
      }),
    },
    // A computed member is not a column.
    { code: readGuardWrite(NOTE_BY_ID, { test: "row[me] !== 'X'" }) },
    // An object key is not a read of the derived local of the same name.
    {
      code: `async function f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        const { status } = row;
        if (isBad({ status: 'X' })) throw new ConflictException();
        await ${NOTE_BY_ID};
      }`,
    },
    // Aliasing the read row derives nothing.
    {
      code: `async function f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        const alias = row;
        await ${NOTE_BY_ID};
      }`,
    },
    // A numeric destructuring key names no column.
    {
      code: `async function f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        const { 0: first } = row;
        if (first) throw new ConflictException();
        await ${NOTE_BY_ID};
      }`,
    },
    // A lock helper, called as a method or a function, holds the guard.
    {
      code: `class S {
        async pay(id) {
          await this.lockInvoice(id);
          const row = await this.prisma.invoice.findUnique({ where: { id } });
          if (row.status !== 'OPEN') throw new ConflictException();
          await this.prisma.invoice.update({ where: { id }, data: { note: 'x' } });
        }
      }`,
    },
    {
      code: `async function f(id) {
        await lockInvoice(id);
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') throw new ConflictException();
        await ${NOTE_BY_ID};
      }`,
    },
    // A call through a call result has no name.
    { code: 'async function f() { factory()(); }' },
    // A statement call that is not an assertion guards nothing.
    {
      code: `async function f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        log(row.status);
        await ${NOTE_BY_ID};
      }`,
    },
    // Writes without a literal argument or data are not judged.
    { code: 'async function f() { await prisma.invoice.update(); }' },
    {
      code: 'async function f(id) { await prisma.invoice.update({ where: { id } }); }',
    },
    // A guard on one model does not cover a write on another.
    {
      code: readGuardWrite(
        "prisma.payment.update({ where: { id }, data: { note: 'x' } })",
      ),
    },
    // An escaped whitespace in the lock SQL still reads as FOR UPDATE.
    {
      code: `async function f(id) {
        await tx.$queryRaw\`SELECT 1 FROM "Invoice" WHERE id = \${id} FOR\\tUPDATE\`;
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') throw new ConflictException();
        await ${NOTE_BY_ID};
      }`,
    },
    // A check after the write guarded nothing it wrote.
    {
      code: `async function f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.note !== null) throw new ConflictException();
        await prisma.invoice.update({ where: { id, note: null }, data: { note: 'x' } });
        if (row.status !== 'OPEN') throw new ConflictException();
        await prisma.invoice.update({ where: { id, note: 'x', status: 'OPEN' }, data: { note: 'y' } });
      }`,
    },
    // A lock helper taking the guarded work as a callback holds it.
    {
      code: `async function f(id) {
        await withInvoiceLock(id, async () => {
          const row = await prisma.invoice.findUnique({ where: { id } });
          if (row.status !== 'OPEN') throw new ConflictException();
          await ${NOTE_BY_ID};
        });
      }`,
    },
  ],
  invalid: [
    // A lock covers the writes after it in its own
    // transaction, not every write in the function.
    {
      code: `async function f(id, jobId) {
        await prisma.$transaction(async tx => {
          await tx.$queryRaw\`SELECT 1 FROM "Invoice" WHERE id = \${id} FOR UPDATE\`;
        });
        await prisma.job.update({ where: { id: jobId }, data: { status: 'DONE' } });
      }`,
      errors: [{ messageId: 'blindTransition' }],
    },
    {
      code: `async function f(id, jobId) {
        await prisma.$transaction(async tx => {
          await tx.invoice.update({ where: { id, status: 'OPEN' }, data: { status: 'PAID' } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        await prisma.job.update({ where: { id: jobId }, data: { status: 'DONE' } });
      }`,
      errors: [{ messageId: 'blindTransition' }],
    },
    {
      code: `async function f(id, jobId) {
        await withInvoiceLock(id, async () => {});
        await prisma.job.update({ where: { id: jobId }, data: { status: 'DONE' } });
      }`,
      errors: [{ messageId: 'blindTransition' }],
    },
    {
      code: `async function f(id, jobId) {
        await prisma.job.update({ where: { id: jobId }, data: { status: 'DONE' } });
        await lockInvoice(id);
      }`,
      errors: [{ messageId: 'blindTransition' }],
    },
    // A write before the lock in the same
    // transaction, or in a lock helper's other arguments, runs unlocked.
    {
      code: `async function f(id, jobId) {
        await prisma.$transaction(async tx => {
          await tx.job.update({ where: { id: jobId }, data: { status: 'DONE' } });
          await tx.$queryRaw\`SELECT 1 FROM "Invoice" WHERE id = \${id} FOR UPDATE\`;
        });
      }`,
      errors: [{ messageId: 'blindTransition' }],
    },
    {
      code: `async function f(id, jobId) {
        await withInvoiceLock(await prisma.job.update({ where: { id: jobId }, data: { status: 'DONE' } }), async () => {});
      }`,
      errors: [{ messageId: 'blindTransition' }],
    },
    // A write repeating the read's compound unique key
    // addresses the read row.
    {
      code: `async function f(storeId, sku, n) {
        const row = await prisma.stock.findUnique({ where: { store_id_sku: { store_id: storeId, sku } } });
        if (row.quantity < n) throw new ConflictException();
        await prisma.stock.update({ where: { store_id_sku: { store_id: storeId, sku } }, data: { quantity: row.quantity - n } });
      }`,
      errors: [
        {
          messageId: 'staleGuard',
          data: {
            method: 'update',
            delegate: 'stock',
            variable: 'row',
            field: 'quantity',
          },
        },
      ],
    },
    // A client returned by a call is a client root.
    {
      code: "async function f(id) { await getPrisma().invoice.update({ where: { id }, data: { status: 'X' } }); }",
      errors: [
        {
          messageId: 'blindTransition',
          data: { method: 'update', delegate: 'invoice', field: 'status' },
        },
      ],
    },
    // A read with no WHERE, addressed by row.id.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id: row.id }, data: { note: 'x' } })",
        { read: "prisma.invoice.findFirst({ orderBy: { id: 'desc' } })" },
      ),
      errors: [{ messageId: 'staleGuard' }],
    },
    // An awaited assertion is a guard.
    {
      code: `async function f(id, next) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        await assertTransition(row.status, next);
        await ${NOTE_BY_ID};
      }`,
      errors: [{ messageId: 'staleGuard' }],
    },
    // An interpolation inside FOR ... UPDATE is not a lock.
    {
      code: `async function f(id, mode) {
        await tx.$queryRaw\`SELECT 1 FROM "Invoice" WHERE id = \${id} FOR \${mode} UPDATE\`;
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') throw new ConflictException();
        await ${NOTE_BY_ID};
      }`,
      errors: [{ messageId: 'staleGuard' }],
    },
    // An AND conjunct that repeats the read's key, without the guard.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { AND: [{ id }, { note: 'x' }] }, data: { note: 'y' } })",
      ),
      errors: [{ messageId: 'staleGuard' }],
    },
    // A compound unique key naming the read row, without the guard.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id_version: { id: row.id, version: 3 } }, data: { note: 'x' } })",
      ),
      errors: [
        {
          messageId: 'staleGuard',
          data: {
            method: 'update',
            delegate: 'invoice',
            variable: 'row',
            field: 'status',
          },
        },
      ],
    },
    // A relation filter's inner keys are not this row's columns.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id, owner: { version: 3 } }, data: { note: 'x' } })",
        { test: 'row.version !== 3' },
      ),
      errors: [
        {
          messageId: 'staleGuard',
          data: {
            method: 'update',
            delegate: 'invoice',
            variable: 'row',
            field: 'version',
          },
        },
      ],
    },
    // A nested if that throws is a guard.
    {
      code: `async function f(id, strict) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') if (strict) throw new ConflictException();
        await ${NOTE_BY_ID};
      }`,
      errors: [{ messageId: 'staleGuard' }],
    },
    // Arrow functions are units too.
    {
      code: `const f = async id => {
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') throw new ConflictException();
        await ${NOTE_BY_ID};
      };`,
      errors: [{ messageId: 'staleGuard' }],
    },
    // A shadowing local with no read does not erase the outer derivation.
    {
      code: `async function f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        const current = row.status;
        { const current = 1; }
        if (current !== 'OPEN') throw new ConflictException();
        await ${NOTE_BY_ID};
      }`,
      errors: [{ messageId: 'staleGuard' }],
    },
  ],
});

describe('regressingCursorColumns (branches)', () => {
  const upsert = (set: string): string =>
    `INSERT INTO c (k, cursor) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET ${set}`;

  for (const [name, set, expected] of [
    ['ends at a semicolon', 'cursor = EXCLUDED.cursor;', ['cursor']],
    [
      'reads no guard from RETURNING',
      'cursor = EXCLUDED.cursor RETURNING c.cursor < EXCLUDED.cursor',
      ['cursor'],
    ],
    [
      'reads the WHERE right after an early keyword',
      'seq=WHERE seq < EXCLUDED.seq',
      [],
    ],
    [
      'strips quotes from the column',
      '"cursor" = EXCLUDED."cursor"',
      ['cursor'],
    ],
    [
      'matches a column with regex metacharacters literally',
      '"cursor.x" = EXCLUDED."cursor.x" WHERE "cursor.x" < EXCLUDED."cursor.x"',
      [],
    ],
    [
      'needs the stored column on the left',
      'cursor = EXCLUDED.cursor WHERE c.other < EXCLUDED.cursor',
      ['cursor'],
    ],
    [
      'needs the incoming column on the right',
      'cursor = EXCLUDED.cursor WHERE c.cursor < 5',
      ['cursor'],
    ],
    [
      'reads excluded case-insensitively',
      'cursor = excluded.cursor WHERE c.cursor < excluded.cursor',
      [],
    ],
    [
      'reads the mirrored comparison case-insensitively',
      'cursor = excluded.cursor WHERE excluded.cursor > c.cursor',
      [],
    ],
    [
      'keeps commas inside parentheses in one assignment',
      'seq = GREATEST(t.seq, CASE WHEN EXCLUDED.version = 1 THEN 0 END)',
      [],
    ],
  ] as const) {
    it(name, () => {
      assert.deepEqual(regressingCursorColumns(upsert(set)), [...expected]);
    });
  }
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
  staleGuard: 'Put `{{field}}` in the WHERE',
  blindTransition: 'add the expected `{{field}}` to the WHERE',
  cursorRegress: 'Use GREATEST(...)',
};

describe('compare-and-set meta', () => {
  const { meta } = rule as RuleMeta;

  it('reports problems and names the remedy in each text', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(meta.docs.description.includes('compare-and-set'));
    assert.deepEqual(
      Object.keys(meta.messages).sort(),
      Object.keys(MESSAGES).sort(),
    );
    for (const [messageId, remedy] of Object.entries(MESSAGES)) {
      assert.ok(meta.messages[messageId].includes(remedy));
    }
  });

  it('refuses an unknown option', () => {
    // A config without `files` applies to ESLint's default .js pattern.
    const linter = new Linter({ cwd: '/repo' });
    const config: Linter.Config = {
      plugins: { boundary: { rules: { 'compare-and-set': rule } } },
      rules: {
        'boundary/compare-and-set': [
          'error',
          { immutableFields: [], extra: true },
        ],
      },
    };
    assert.throws(
      () => linter.verify('', config, '/repo/a.js'),
      /additional properties/,
    );
  });
});

// ---------------------------------------------------------------------------
// immutableFields: a codebase's own ownership columns, by exact name.

/** A read, an ownership check on `row.${field}`, then an id-only write. */
const ownershipCheck = (field: string): string =>
  readGuardWrite(NOTE_BY_ID, { test: `row.${field} !== base` });

tester.run('compare-and-set (immutableFields)', rule, {
  valid: [
    // The built-in identity keys need no option.
    { code: ownershipCheck('created_at') },
    { code: ownershipCheck('owner_id') },
    {
      code: ownershipCheck('brand'),
      options: [{ immutableFields: ['brand', 'store'] }],
    },
    {
      code: ownershipCheck('store'),
      options: [{ immutableFields: ['brand', 'store'] }],
    },
  ],
  invalid: [
    // Without the option, a tenant column is a guard like any other.
    {
      code: ownershipCheck('brand'),
      errors: [
        {
          messageId: 'staleGuard',
          data: {
            method: 'update',
            delegate: 'invoice',
            variable: 'row',
            field: 'brand',
          },
        },
      ],
    },
    // Names match exactly: `brand` does not cover `brandName`.
    {
      code: ownershipCheck('brandName'),
      options: [{ immutableFields: ['brand'] }],
      errors: [{ messageId: 'staleGuard' }],
    },
    {
      code: ownershipCheck('store'),
      options: [{}],
      errors: [{ messageId: 'staleGuard' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// Inputs on which the rule and a one-token change to it disagree.

/** A lock taken by `sql`, then a read, a check and an id-only write. */
const lockedByRaw = (sql: string): string => `async function f(id) {
  await tx.$queryRaw\`${sql}\`;
  const row = await prisma.invoice.findUnique({ where: { id } });
  if (row.status !== 'OPEN') throw new ConflictException();
  await ${NOTE_BY_ID};
}`;

/** A call to `helper` before a read, a check and an id-only write. */
const lockedByCall = (helper: string): string => `async function f(id) {
  await ${helper}(id);
  const row = await prisma.invoice.findUnique({ where: { id } });
  if (row.status !== 'OPEN') throw new ConflictException();
  await ${NOTE_BY_ID};
}`;

/** A read, `{ status } = row`, a check that exits on `test`, then a write. */
const derivedGuard = (test: string): string => `async function f(id, base) {
  const row = await prisma.invoice.findUnique({ where: { id } });
  const { status } = row;
  if (${test}) throw new ConflictException();
  await ${NOTE_BY_ID};
}`;

const STALE_STATUS = {
  messageId: 'staleGuard',
  data: { method: 'update', delegate: 'invoice', variable: 'row', field: 'status' },
} as const;

tester.run('compare-and-set (sweep)', rule, {
  valid: [
    // A root named neither as a client nor as prisma is no client.
    {
      code: "async function f(id) { await api.invoice.update({ where: { id }, data: { status: 'X' } }); }",
    },
    // `#private` names are not a client, a delegate or a method.
    {
      code: "class S { #prisma; async f(id) { await this.#prisma.invoice.update({ where: { id }, data: { status: 'X' } }); } }",
    },
    {
      code: "class S { #invoice; async f(id) { await prisma.#invoice.update({ where: { id }, data: { status: 'X' } }); } }",
    },
    {
      code: "class S { #update() {} async f(id) { await prisma.invoice.#update({ where: { id }, data: { status: 'X' } }); } }",
    },
    // FOR UPDATE and its NO KEY form take any run of whitespace, and an
    // advisory lock need not be the transaction-scoped one.
    { code: lockedByRaw('SELECT 1 FROM "Invoice" WHERE id = 1 FOR  UPDATE') },
    { code: lockedByRaw('SELECT 1 FROM "Invoice" FOR NO  KEY UPDATE') },
    { code: lockedByRaw('SELECT 1 FROM "Invoice" FOR NO KEY  UPDATE') },
    { code: lockedByRaw('SELECT pg_advisory_lock(1)') },
    // acquire...Lock takes any word between.
    { code: lockedByCall('acquireRowLock') },
    // An identity key needs no option, whatever comes before `Id`.
    { code: ownershipCheck('ownerId') },
    // WHERE shapes that still name the read row and its status.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { [me]: { not: row.id }, id, status: 'OPEN' }, data: { note: 'x' } })",
      ),
    },
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { AND: { id, status: 'OPEN' } }, data: { note: 'x' } })",
      ),
    },
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { AND: [base, { id, status: 'OPEN' }] }, data: { note: 'x' } })",
      ),
    },
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { AND: [, { id, status: 'OPEN' }] }, data: { note: 'x' } })",
      ),
    },
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id, status: 'OPEN', OR: [base, { note: 'x' }] }, data: { note: 'y' } })",
      ),
    },
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id, status: 'OPEN', OR: [, { note: 'x' }] }, data: { note: 'y' } })",
      ),
    },
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id, status: 'OPEN', OR: [] }, data: { note: 'x' } })",
      ),
    },
    // A computed member, or another object's id, names another row.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id: row[id] }, data: { note: 'x' } })",
      ),
    },
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id: base.id }, data: { note: 'x' } })",
      ),
    },
    // Module scope is no function: nothing there is judged.
    {
      code: `const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') throw new ConflictException();
        await ${NOTE_BY_ID};`,
    },
    { code: 'await tx.$queryRaw`SELECT 1 FROM "Invoice" FOR UPDATE`;' },
    { code: 'assertOpen(row.status);' },
    // A declaration with no initialiser.
    { code: 'async function f() { let x; }' },
    // A rest element derives nothing.
    {
      code: `async function f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        const { ...rest } = row;
        await ${NOTE_BY_ID};
      }`,
    },
    // Only a name that starts with an assertion verb is one.
    {
      code: `async function f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        doValidate(row.status);
        await ${NOTE_BY_ID};
      }`,
    },
    // A read after the check is not a write.
    {
      code: readGuardWrite('prisma.invoice.findFirst({ where: { id } })'),
    },
    // A write with no WHERE, or with data built elsewhere, is not judged.
    {
      code: "async function f() { await prisma.invoice.update({ data: { status: 'X' } }); }",
    },
    {
      code: 'async function f(id, data) { await prisma.invoice.update({ where: { id }, data }); }',
    },
    // A #private field of the read row is not a column.
    {
      code: `class S { #status; async f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.#status) throw new ConflictException();
        await ${NOTE_BY_ID};
      } }`,
    },
    // A same-named field of another object is not the derived local.
    { code: derivedGuard("base.status !== 'OPEN'") },
    // A #private field of the read row is not its key.
    {
      code: `class S { #id; async f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') throw new ConflictException();
        await prisma.invoice.update({ where: { id: row.#id }, data: { note: 'x' } });
      } }`,
    },
    // A destructured read row is not a read variable.
    {
      code: `async function f(id) {
        const { note } = await prisma.invoice.findUnique({ where: { id } });
        if (this.cfg.status !== 'OPEN') throw new ConflictException();
        await ${NOTE_BY_ID};
      }`,
    },
  ],
  invalid: [
    // Names that only end, or only start, like an identity key are not one.
    {
      code: ownershipCheck('paid'),
      errors: [{ ...STALE_STATUS, data: { ...STALE_STATUS.data, field: 'paid' } }],
    },
    {
      code: ownershipCheck('idle'),
      errors: [{ ...STALE_STATUS, data: { ...STALE_STATUS.data, field: 'idle' } }],
    },
    // Lock helpers are named from their first word to their last.
    { code: lockedByCall('unlockInvoice'), errors: [STALE_STATUS] },
    { code: lockedByCall('withLockTimeout'), errors: [STALE_STATUS] },
    {
      code: `class S { #lockRow() {} async f(id) {
        await this.#lockRow(id);
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') throw new ConflictException();
        await ${NOTE_BY_ID};
      } }`,
      errors: [STALE_STATUS],
    },
    // A regular expression is not SQL.
    {
      code: `async function f(id) {
        const re = /FOR UPDATE/;
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') throw new ConflictException();
        await ${NOTE_BY_ID};
      }`,
      errors: [STALE_STATUS],
    },
    // An OR whose first branch lacks the column, and an AND written as an
    // object, do not compare on it.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id, OR: [{ paid_by: null }, { status: 'OPEN' }] }, data: { note: 'x' } })",
      ),
      errors: [STALE_STATUS],
    },
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { AND: { id, note: 'x' } }, data: { note: 'y' } })",
      ),
      errors: [STALE_STATUS],
    },
    // A compound key with a spread still names the read row.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id_note: { ...base, id: row.id } }, data: { note: 'x' } })",
      ),
      errors: [STALE_STATUS],
    },
    // A read whose arguments are built elsewhere, addressed by row.id.
    {
      code: readGuardWrite(
        "prisma.invoice.update({ where: { id: row.id }, data: { note: 'x' } })",
        { read: 'prisma.invoice.findUnique(args)' },
      ),
      errors: [STALE_STATUS],
    },
    // A block that exits after other statements is a guard.
    {
      code: `async function f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.status !== 'OPEN') { log(); throw new ConflictException(); }
        await ${NOTE_BY_ID};
      }`,
      errors: [STALE_STATUS],
    },
    // A #private member of a relation does not make it a collection.
    {
      code: `class S { #length; async f(id) {
        const row = await prisma.invoice.findUnique({ where: { id } });
        if (row.items.#length) throw new ConflictException();
        await ${NOTE_BY_ID};
      } }`,
      errors: [{ ...STALE_STATUS, data: { ...STALE_STATUS.data, field: 'items' } }],
    },
    // Serializable options hold the guard only on prisma's $transaction.
    ...[
      'prisma.run',
      '$transaction',
      'this.#$transaction',
    ].map(callee => ({
      code: `class S { #$transaction() {} async f(id) {
        await ${callee}(async tx => {
          const row = await tx.invoice.findUnique({ where: { id } });
          if (row.status !== 'OPEN') throw new ConflictException();
          await tx.invoice.update({ where: { id }, data: { note: 'x' } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } }`,
      errors: [STALE_STATUS],
    })),
    // A derived local read as a computed member, a computed key or a value.
    { code: derivedGuard('MAP[status]'), errors: [STALE_STATUS] },
    { code: derivedGuard('isBad({ [status]: true })'), errors: [STALE_STATUS] },
    { code: derivedGuard('isBad({ s: status })'), errors: [STALE_STATUS] },
  ],
});

describe('regressingCursorColumns (sweep)', () => {
  const upsert = (set: string): string =>
    `INSERT INTO c (k, cursor) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET ${set}`;

  it('reads only cursor-like names as cursors', () => {
    for (const column of ['my_seqno', 'xseq', 'seqno']) {
      assert.deepEqual(
        regressingCursorColumns(upsert(`${column} = EXCLUDED.${column}`)),
        [],
      );
    }
    for (const column of ['my_seq', 'seq', 'sequence_no']) {
      assert.deepEqual(
        regressingCursorColumns(upsert(`${column} = EXCLUDED.${column}`)),
        [column],
      );
    }
  });

  it('takes any run of whitespace between the upsert keywords', () => {
    for (const sql of [
      'INSERT INTO c VALUES (1) ON  CONFLICT (k) DO UPDATE SET cursor = EXCLUDED.cursor',
      'INSERT INTO c VALUES (1) ON CONFLICT (k) DO  UPDATE SET cursor = EXCLUDED.cursor',
      'INSERT INTO c VALUES (1) ON CONFLICT (k) DO UPDATE  SET cursor = EXCLUDED.cursor',
      'INSERT INTO c VALUES (1) ON CONFLICT (k) DO UPDATE SET  cursor = EXCLUDED.cursor',
    ]) {
      assert.deepEqual(regressingCursorColumns(sql), ['cursor']);
    }
  });

  it('reads the DO UPDATE WHERE apart from the SET and RETURNING', () => {
    assert.deepEqual(
      regressingCursorColumns(
        upsert(
          'cursor = CASE WHEN c.cursor <= EXCLUDED.cursor THEN EXCLUDED.cursor ELSE c.cursor END WHERE c.enabled',
        ),
      ),
      ['cursor'],
    );
    assert.deepEqual(
      regressingCursorColumns(
        upsert(
          'cursor = EXCLUDED.cursor WHERE c.enabled RETURNING c.cursor < EXCLUDED.cursor',
        ),
      ),
      ['cursor'],
    );
    assert.deepEqual(
      regressingCursorColumns(
        upsert('cursor = EXCLUDED.cursor RETURNING GREATEST(c.cursor, 1)'),
      ),
      ['cursor'],
    );
  });

  it('skips a SET part with no assignment', () => {
    assert.deepEqual(
      regressingCursorColumns(upsert('cursor = EXCLUDED.cursor, junk')),
      ['cursor'],
    );
  });

  it('strips only the quotes around a column', () => {
    assert.deepEqual(
      regressingCursorColumns(upsert('"my""cursor" = EXCLUDED."my""cursor"')),
      ['my""cursor'],
    );
  });

  it('reads GREATEST with a space before its parenthesis', () => {
    assert.deepEqual(
      regressingCursorColumns(
        upsert('cursor = GREATEST (c.cursor, EXCLUDED.cursor)'),
      ),
      [],
    );
  });
});

describe('splitTopLevel', () => {
  it('splits only on commas outside every parenthesis', () => {
    assert.deepEqual(splitTopLevel('f(g(a), b), c'), ['f(g(a), b)', ' c']);
  });

  it('keeps one part when there is no comma', () => {
    assert.deepEqual(splitTopLevel('a = 1'), ['a = 1']);
  });

  it('reads a stray closing parenthesis as depth zero', () => {
    assert.deepEqual(splitTopLevel('a), b'), ['a)', ' b']);
  });
});

describe('compare-and-set options', () => {
  // A config without `files` applies to ESLint's default .js pattern.
  const lint = (immutableFields: unknown) =>
    new Linter({ cwd: '/repo' }).verify(
      '',
      {
        plugins: { boundary: { rules: { 'compare-and-set': rule } } },
        rules: { 'boundary/compare-and-set': ['error', { immutableFields }] },
      },
      '/repo/a.js',
    );

  it('takes a list of distinct non-empty names', () => {
    assert.deepEqual(lint(['brand', 'store']), []);
  });

  it('refuses anything else', () => {
    assert.throws(() => lint('brand'), /should be array/);
    assert.throws(() => lint([7]), /should be string/);
    assert.throws(() => lint(['']), /should NOT be shorter than 1 characters/);
    assert.throws(() => lint(['brand', 'brand']), /duplicate items/);
  });
});
