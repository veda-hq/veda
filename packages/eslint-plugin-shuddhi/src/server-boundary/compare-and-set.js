/**
 * RACE-02 `compare-and-set`: a guarded write names its guard
 * in WHERE.
 * Registered by ./index.js; ./configs.js mounts it under a plugin namespace.
 *
 * A heuristic over the AST (plus the type checker where one is configured).
 * It states below what it deliberately does NOT claim, because
 * a codebase that bans `eslint-disable` gives a rule that fires on correct
 * code no escape hatch except a suppression count.
 */

import { keyName } from './helpers.js';

const PRISMA_ROOTS = new Set(['db', 'tx', 'trx', 'transaction', 'client']);
const PRISMA_NAMED = /prisma/i;

function isPrismaRoot(node) {
  const named = name => PRISMA_ROOTS.has(name) || PRISMA_NAMED.test(name);
  if (node.type === 'Identifier') return named(node.name);
  if (
    node.type === 'MemberExpression' &&
    node.object.type === 'ThisExpression' &&
    node.property.type === 'Identifier'
  ) {
    return named(node.property.name);
  }
  if (node.type === 'CallExpression') return isPrismaRoot(node.callee);
  return false;
}

/** `prisma.model.method(...)` → `{ delegate, method }`, else null. */
function prismaCall(node) {
  if (!node || node.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (
    callee.type !== 'MemberExpression' ||
    callee.property.type !== 'Identifier'
  ) {
    return null;
  }
  const target = callee.object;
  if (
    target.type !== 'MemberExpression' ||
    target.property.type !== 'Identifier'
  ) {
    return null;
  }
  if (!isPrismaRoot(target.object)) return null;
  return { delegate: target.property.name, method: callee.property.name };
}

const READ_ONE = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
]);
const GUARDED_WRITES = new Set([
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);
const TRANSITION_WRITES = new Set(['update', 'updateMany']);
/** Columns whose write is a state transition or a claim. */
const TRANSITION_COLUMNS = new Set([
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
]);
/**
 * Guard fields that cannot change under a concurrent request: identity and
 * ownership keys. A read-then-check on these is an authorisation check, not a
 * race on the row's state. The `immutableFields` option adds a codebase's own
 * ownership columns (a tenant or owner field) by exact name.
 */
const IMMUTABLE_FIELD = /^(?:id|uuid|.*_id|.*Id|created_at|createdAt)$/;
/** Unique keys: `where: { id: row.id }` addresses exactly the read row. */
const ROW_KEYS = new Set(['id', 'uuid', 'client_id', 'key']);
/** Members that mark `row.field` as a loaded collection, not a column. */
const COLLECTION_MEMBERS = new Set([
  'length',
  'some',
  'every',
  'find',
  'filter',
  'includes',
  'map',
  'forEach',
]);
/** Cursor-like columns whose upsert must never move backwards. */
const CURSOR_COLUMN =
  /cursor|last_seen|high_water|watermark|_seq$|^seq$|sequence|version/i;
/** Locks that make a read-then-write safe without compare-and-set. */
const LOCK_SQL = /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|pg_advisory(?:_xact)?_lock/i;
const LOCK_CALL = /^(?:with\w*(?:Lock|Claim)|lock\w*|acquire\w*Lock)$/;

function isFunction(node) {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  );
}

/** The outermost function enclosing `node` (nested callbacks belong to it). */
function outermostFunction(node) {
  let found = null;
  for (let current = node.parent; current; current = current.parent) {
    if (isFunction(current)) found = current;
  }
  return found;
}

/**
 * Keys every row a `where` matches is constrained on: top-level keys, AND
 * conjuncts, and the keys EVERY branch of an OR constrains. Null when the
 * `where` is not literal.
 */
function whereKeys(where) {
  if (!where || where.type !== 'ObjectExpression') return null;
  const keys = new Set();
  const collect = (object, into) => {
    for (const property of object.properties) {
      if (property.type === 'SpreadElement') return false;
      const name = keyName(property.key);
      if (name === null) continue;
      if (name === 'AND' || name === 'OR') {
        const items =
          property.value.type === 'ArrayExpression'
            ? property.value.elements
            : [property.value];
        if (name === 'AND') {
          for (const item of items) {
            if (item?.type === 'ObjectExpression' && !collect(item, into))
              return false;
          }
          continue;
        }
        // An OR guards a column only when every branch constrains it
        // (`OR: [{ locked_by: null }, { locked_by: me }]`): a key in one branch
        // alone lets the other branch match a row in any state.
        let shared = null;
        for (const item of items) {
          const branch = new Set();
          if (item?.type === 'ObjectExpression' && !collect(item, branch))
            return false;
          shared =
            shared === null
              ? branch
              : new Set([...shared].filter(key => branch.has(key)));
        }
        for (const key of shared ?? []) into.add(key);
        continue;
      }
      into.add(name);
      // Compound unique input: `where: { id_status: { id, status } }`.
      if (property.value.type === 'ObjectExpression' && name.includes('_')) {
        for (const inner of property.value.properties) {
          const innerName =
            inner.type === 'Property' ? keyName(inner.key) : null;
          if (innerName) into.add(innerName);
        }
      }
    }
    return true;
  };
  return collect(where, keys) ? keys : null;
}

/** `key → value node` for a literal `where`, top level and AND conjuncts. */
function wherePairs(where, out = new Map()) {
  if (!where || where.type !== 'ObjectExpression') return out;
  for (const property of where.properties) {
    if (property.type !== 'Property') continue;
    const name = keyName(property.key);
    if (name === null) continue;
    if (name === 'AND') {
      const items =
        property.value.type === 'ArrayExpression'
          ? property.value.elements
          : [property.value];
      for (const item of items) wherePairs(item, out);
      continue;
    }
    out.set(name, property.value);
  }
  return out;
}

/**
 * Does the write address the row the read returned? Only then is the read's
 * check a guard on it. `where: { id: row.id }` and a `where` repeating the
 * read's own key do; `where: { user_id, id: { not: row.id } }` (the OTHER rows)
 * does not.
 */
function targetsReadRow(read, variable, writeWhere, sourceCode) {
  // `row.id`, not `row.user_id`: only a unique key of the read row names it.
  const fromRead = value =>
    value.type === 'MemberExpression' &&
    !value.computed &&
    value.object.type === 'Identifier' &&
    value.object.name === variable &&
    value.property.type === 'Identifier' &&
    ROW_KEYS.has(value.property.name);
  const readPairs = wherePairs(read.where);
  for (const [key, value] of wherePairs(writeWhere)) {
    if (value.type === 'ObjectExpression') {
      // A compound unique (`id_status: { id: row.id, status }`) names the row;
      // an operator object (`{ not: row.id }`, `{ in: ids }`) does not. Either
      // may still repeat the read's own value, compared below.
      const inner = value.properties.some(
        property => property.type === 'Property' && fromRead(property.value),
      );
      if (inner && key.includes('_')) return true;
    }
    if (fromRead(value)) return true;
    const readValue = readPairs.get(key);
    if (
      readValue &&
      sourceCode.getText(readValue) === sourceCode.getText(value)
    ) {
      return true;
    }
  }
  return false;
}

function objectProperty(object, name) {
  if (!object || object.type !== 'ObjectExpression') return null;
  return (
    object.properties.find(
      property =>
        property.type === 'Property' && keyName(property.key) === name,
    ) ?? null
  );
}

/** Does a statement (or block) exit the function — throw or return? */
function exits(statement) {
  if (!statement) return false;
  if (
    statement.type === 'ThrowStatement' ||
    statement.type === 'ReturnStatement'
  ) {
    return true;
  }
  if (statement.type === 'BlockStatement') return statement.body.some(exits);
  if (statement.type === 'IfStatement') {
    return exits(statement.consequent) || exits(statement.alternate);
  }
  return false;
}

/**
 * What an expression reads: `x.field` pairs and bare identifiers. Nested
 * functions are not entered — a callback's reads are not this expression's.
 */
function references(node, out = { members: [], names: [] }) {
  if (
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionDeclaration'
  ) {
    return out;
  }
  if (node.type === 'Identifier') {
    out.names.push(node.name);
    return out;
  }
  if (node.type === 'MemberExpression') {
    if (
      !node.computed &&
      node.object.type === 'Identifier' &&
      node.property.type === 'Identifier'
    ) {
      // `invoice.items.length` / `row.user_roles.some(...)` test a loaded
      // relation, not a column the write could compare on.
      // An Identifier property means `node` is the parent's object: as a
      // computed property `node` would itself be that (MemberExpression) key.
      const parent = node.parent;
      const collection =
        parent?.type === 'MemberExpression' &&
        parent.property.type === 'Identifier' &&
        COLLECTION_MEMBERS.has(parent.property.name);
      if (!collection) out.members.push([node.object.name, node.property.name]);
    }
    references(node.object, out);
    if (node.computed) references(node.property, out);
    return out;
  }
  if (node.type === 'Property') {
    if (node.computed) references(node.key, out);
    references(node.value, out);
    return out;
  }
  // Only AST nodes are walked: array holes, `range` numbers and `loc`
  // objects are not.
  // Every field but the back-link to the parent, which would walk upward.
  for (const value of Object.values(node).filter(
    field => field !== node.parent,
  )) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child.type === 'string') references(child, out);
    }
  }
  return out;
}

/** SET assignments of an `ON CONFLICT ... DO UPDATE SET` that can regress a cursor. */
export function regressingCursorColumns(sql) {
  const match = /ON\s+CONFLICT[\s\S]*?DO\s+UPDATE\s+SET\s+([\s\S]*)$/i.exec(
    sql,
  );
  if (!match) return [];
  let assignments = match[1];
  /** The DO UPDATE's own WHERE clause, when it has one. */
  let where = null;
  const tail = /\b(WHERE|RETURNING)\b|;/i.exec(assignments);
  if (tail) {
    if (tail[1] && tail[1].toUpperCase() === 'WHERE') {
      const rest = assignments.slice(tail.index + tail[0].length);
      const end = /\bRETURNING\b|;/i.exec(rest);
      where = { text: end ? rest.slice(0, end.index) : rest };
    }
    assignments = assignments.slice(0, tail.index);
  }
  const columns = [];
  for (const assignment of splitTopLevel(assignments)) {
    // Split at the first `=`: the column on the left, its new value right.
    const parts = /^([^=]*)=([\s\S]*)$/.exec(assignment);
    if (parts === null) continue;
    const column = parts[1].trim().replace(/^"|"$/g, '');
    const value = parts[2];
    if (!CURSOR_COLUMN.test(column)) continue;
    // GREATEST in Postgres; SQLite (an offline client) spells the scalar MAX. LEAST and
    // MIN pick the smaller value, so they can move the cursor back.
    if (/\b(?:GREATEST|MAX)\s*\(/i.test(value)) continue;
    // A WHERE on the DO UPDATE only advances the cursor when it compares the
    // column with the incoming value: `t.cursor < EXCLUDED.cursor`.
    if (where !== null && advancesInWhere(where.text, column)) continue;
    columns.push(column);
  }
  return columns;
}

/**
 * Does a DO UPDATE's WHERE let the write land only when `column` moves
 * forward? `col < EXCLUDED.col`, `col <= EXCLUDED.col`, or the mirrored
 * `EXCLUDED.col > col` / `>=`, the stored side optionally table-qualified.
 * Any other predicate (`WHERE enabled`) proves nothing about the cursor.
 */
function advancesInWhere(where, column) {
  const name = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stored = `(?:\\b\\w+\\.)?"?\\b${name}\\b"?`;
  const incoming = `\\bEXCLUDED\\."?${name}\\b"?`;
  return (
    new RegExp(`${stored}\\s*<=?\\s*${incoming}`, 'i').test(where) ||
    new RegExp(`${incoming}\\s*>=?\\s*${stored}`, 'i').test(where)
  );
}

/** Split on commas outside parentheses: `a = f(x, y), b = 1` → two parts. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (const { 0: char, index } of text.matchAll(/[(),]/g)) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const compareAndSet = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A write guarded by a read must be compare-and-set: the guarded column belongs in its WHERE',
    },
    schema: [
      {
        type: 'object',
        properties: {
          immutableFields: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      staleGuard:
        'This {{method}} acts on `{{delegate}}` after checking `{{variable}}.{{field}}`, but its WHERE does not include `{{field}}`. A concurrent request can change the row between the read and the write (RACE-02). Put `{{field}}` in the WHERE (updateMany, then check `count`), or take a row lock.',
      blindTransition:
        'This {{method}} sets `{{field}}` on `{{delegate}}` without `{{field}}` in its WHERE, so it overwrites whatever state a concurrent request left (RACE-02). Compare-and-set: add the expected `{{field}}` to the WHERE and check the affected count.',
      cursorRegress:
        '`ON CONFLICT ... DO UPDATE SET {{column}}` overwrites unconditionally, so a slower writer moves the cursor backwards (RACE-02). Use GREATEST(...) (SQLite: MAX(...)) or a WHERE that only advances it.',
    },
  },
  create(context) {
    const immutableNames = new Set(context.options[0]?.immutableFields ?? []);
    const immutable = field =>
      IMMUTABLE_FIELD.test(field) || immutableNames.has(field);
    /** function → { reads: Map, guards: Map, writes: [], lockScopes: Set } */
    const units = new Map();
    const unitFor = node => {
      const fn = outermostFunction(node);
      if (!fn) return null;
      let unit = units.get(fn);
      if (!unit) {
        unit = {
          reads: new Map(),
          derived: new Map(),
          guards: new Map(),
          writes: [],
          lockScopes: new Set(),
        };
        units.set(fn, unit);
      }
      return unit;
    };
    /**
     * A lock holds the writes after it in its own transaction: the innermost
     * function around it (a `$transaction` callback), or `scope` itself (a
     * Serializable `$transaction`, the callback a lock helper is given).
     * Writes count as locked only when visited after the lock, in source order.
     * Not claimed: WHICH rows it locks. A `FOR UPDATE` on one row covers
     * every write in its transaction: the SQL's table and a Prisma delegate
     * meet only through the schema's `@@map`, which the rule does not read.
     */
    const lock = (node, scope) => {
      const unit = unitFor(node);
      if (unit) {
        unit.lockScopes.add(
          scope ?? context.sourceCode.getAncestors(node).findLast(isFunction),
        );
      }
    };
    /**
     * The read fields an expression depends on: `invoice.status` directly, or
     * through a local derived from it (`const current = invoice.status;
     * const allowed = transitionsFrom(current)`).
     */
    const readFields = (unit, node) => {
      const { members, names } = references(node);
      const pairs = members.filter(([variable]) => unit.reads.has(variable));
      for (const name of names) pairs.push(...(unit.derived.get(name) ?? []));
      return pairs;
    };
    const guard = (unit, node) => {
      for (const [variable, field] of readFields(unit, node)) {
        if (immutable(field)) continue;
        const fields = unit.guards.get(variable) ?? new Set();
        fields.add(field);
        unit.guards.set(variable, fields);
      }
    };
    // Called for template literals and string literals only.
    const sqlText = node =>
      node.type === 'TemplateLiteral'
        ? node.quasis
            .map(quasi => quasi.value.cooked ?? quasi.value.raw)
            .join('$n')
        : node.value;

    function checkSql(node) {
      const text = sqlText(node);
      if (!text) return;
      if (LOCK_SQL.test(text)) lock(node);
      if (!/ON\s+CONFLICT/i.test(text)) return;
      for (const column of regressingCursorColumns(text)) {
        context.report({ node, messageId: 'cursorRegress', data: { column } });
      }
    }

    return {
      VariableDeclarator(node) {
        if (!node.init) return;
        const unit = unitFor(node);
        if (!unit) return;
        const init =
          node.init.type === 'AwaitExpression' ? node.init.argument : node.init;
        const call = prismaCall(init);
        if (
          call &&
          READ_ONE.has(call.method) &&
          node.id.type === 'Identifier'
        ) {
          unit.reads.set(node.id.name, {
            delegate: call.delegate,
            where: objectProperty(init.arguments[0], 'where')?.value ?? null,
          });
          return;
        }
        // `const { status } = invoice` derives `status` from the read row.
        if (
          node.id.type === 'ObjectPattern' &&
          init.type === 'Identifier' &&
          unit.reads.has(init.name)
        ) {
          for (const property of node.id.properties) {
            if (property.type !== 'Property') continue;
            const field = keyName(property.key);
            const local =
              property.value.type === 'Identifier' ? property.value.name : null;
            if (field && local) unit.derived.set(local, [[init.name, field]]);
          }
          return;
        }
        if (node.id.type !== 'Identifier') return;
        const pairs = readFields(unit, init);
        if (pairs.length > 0) unit.derived.set(node.id.name, pairs);
      },
      IfStatement(node) {
        if (!exits(node.consequent)) return;
        const unit = unitFor(node);
        if (unit) guard(unit, node.test);
      },
      CallExpression(node) {
        const callee = node.callee;
        const calleeName =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' &&
                callee.property.type === 'Identifier'
              ? callee.property.name
              : null;
        if (calleeName !== null && LOCK_CALL.test(calleeName)) {
          // `withInvoiceLock(id, async () => ...)` holds only its callback:
          // the other arguments run before the lock is taken.
          lock(node, node.arguments.find(isFunction));
        }
        // `assertTransition(invoice.status, next)` as a statement (awaited or
        // not) is a guard: a throwing helper exits exactly as an if/throw does.
        const statement =
          node.parent.type === 'AwaitExpression'
            ? node.parent.parent
            : node.parent;
        if (
          statement.type === 'ExpressionStatement' &&
          calleeName !== null &&
          /^(?:assert|ensure|validate|check|require)/i.test(calleeName)
        ) {
          const unit = unitFor(node);
          if (unit) for (const arg of node.arguments) guard(unit, arg);
        }
        if (
          callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === '$transaction'
        ) {
          const options = node.arguments[1];
          const isolation = objectProperty(options, 'isolationLevel');
          if (
            isolation &&
            /Serializable/.test(context.sourceCode.getText(isolation.value))
          ) {
            lock(node, node);
          }
        }
        const call = prismaCall(node);
        if (!call || !GUARDED_WRITES.has(call.method)) return;
        const unit = unitFor(node);
        if (!unit) return;
        const argument = node.arguments[0];
        if (!argument || argument.type !== 'ObjectExpression') return;
        const where = objectProperty(argument, 'where');
        const data = objectProperty(argument, 'data');
        unit.writes.push({
          node,
          ...call,
          // The reads already made when this write runs. ESLint visits in
          // source order, so a read recorded later comes after the write.
          readsBefore: new Set(unit.reads.values()),
          // Likewise the checks already made: a check after the write
          // guarded nothing it wrote.
          guardsBefore: new Map(
            [...unit.guards].map(([variable, fields]) => [
              variable,
              new Set(fields),
            ]),
          ),
          // Inside a lock's scope, and after the lock was taken.
          locked: context.sourceCode
            .getAncestors(node)
            .some(ancestor => unit.lockScopes.has(ancestor)),
          where: where?.value ?? null,
          keys: where ? whereKeys(where.value) : null,
          data: data?.value ?? null,
        });
      },
      TemplateLiteral: checkSql,
      Literal(node) {
        if (typeof node.value === 'string') checkSql(node);
      },
      'Program:exit'() {
        for (const unit of units.values()) {
          for (const write of unit.writes) {
            if (write.locked || write.keys === null) continue;
            let reported = false;
            for (const [variable, fields] of write.guardsBefore) {
              const read = unit.reads.get(variable);
              if (
                read.delegate !== write.delegate ||
                !write.readsBefore.has(read)
              )
                continue;
              if (
                !targetsReadRow(read, variable, write.where, context.sourceCode)
              )
                continue;
              const missing = [...fields].find(field => !write.keys.has(field));
              if (missing === undefined) continue;
              context.report({
                node: write.node,
                messageId: 'staleGuard',
                data: {
                  method: write.method,
                  delegate: write.delegate,
                  variable,
                  field: missing,
                },
              });
              reported = true;
              break;
            }
            if (reported || !TRANSITION_WRITES.has(write.method)) continue;
            if (!write.data || write.data.type !== 'ObjectExpression') continue;
            for (const property of write.data.properties) {
              const field =
                property.type === 'Property' ? keyName(property.key) : null;
              if (field === null || !TRANSITION_COLUMNS.has(field)) continue;
              if (write.keys.has(field)) continue;
              context.report({
                node: write.node,
                messageId: 'blindTransition',
                data: { method: write.method, delegate: write.delegate, field },
              });
              break;
            }
          }
        }
      },
    };
  },
};

export default compareAndSet;
