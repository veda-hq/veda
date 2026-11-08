import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkBudgets, dataRows, parseBudgets, section } from './doc-budgets.ts';

const TABLE = ['# Rule', '| `outside.md` | 1 |', '## Budgets', '| Doc | Budget |', '| --- | -----: |', '| `a.md` | 1,200 |', '| `b.md` | 10 |', '| `rule.md` | 500 |', '## Next', '| `c.md` | 9 |'].join('\n');

describe('parsing', () => {
  it('reads only the named section', () => {
    const s = section(TABLE, 'Budgets');
    assert.deepEqual(parseBudgets(s), [
      { path: 'a.md', bytes: 1200 },
      { path: 'b.md', bytes: 10 },
      { path: 'rule.md', bytes: 500 },
    ]);
    assert.equal(dataRows(s).length, 3);
  });

  it('reads a last section to the end, and an absent one as empty', () => {
    assert.deepEqual(parseBudgets(section('x\n## Budgets\n| D | B |\n| - | - |\n| `z.md` | 5 |', 'Budgets')), [{ path: 'z.md', bytes: 5 }]);
    assert.equal(section('no table', 'Budgets'), '');
    assert.deepEqual(dataRows(''), []);
  });
});

describe('checkBudgets', () => {
  const sizes: Record<string, number> = { 'a.md': 1200, 'b.md': 11, 'rule.md': 300 };
  const size = (p: string) => sizes[p];

  it('passes files within budget and refuses one over it', () => {
    const r = checkBudgets(TABLE, 'Budgets', 'rule.md', size);
    assert.equal(r.ok, false);
    assert.deepEqual(r.out, ['pariksha doc-budgets: a.md 1200 / 1200 bytes', 'pariksha doc-budgets: rule.md 300 / 500 bytes']);
    assert.deepEqual(r.err, ['pariksha doc-budgets: b.md is 11 bytes, over its budget of 10; cut it']);
  });

  it('refuses a table that does not budget itself', () => {
    const r = checkBudgets(TABLE, 'Budgets', 'other.md', () => 1);
    assert.equal(r.ok, false);
    assert.deepEqual(r.err, ['pariksha doc-budgets: other.md sets budgets but has no row for itself; add "| `other.md` | <bytes> |"']);
  });

  it('refuses a budgeted file that does not exist', () => {
    const r = checkBudgets(TABLE, 'Budgets', 'rule.md', (p) => (p === 'b.md' ? undefined : 1));
    assert.deepEqual(r.err, ['pariksha doc-budgets: b.md has a budget but does not exist']);
  });

  it('refuses a malformed row, which nothing would enforce', () => {
    const r = checkBudgets(`${TABLE.replace('## Next', '| not a path | 5 |\n## Next')}`, 'Budgets', 'rule.md', () => 1);
    assert.deepEqual(r.err, ['pariksha doc-budgets: rule.md: 1 row(s) under "## Budgets" are not "| `path` | bytes |", so nothing enforces them']);
  });

  it('refuses a table file with no such section', () => {
    const r = checkBudgets('# nothing', 'Budgets', 'rule.md', () => 1);
    assert.deepEqual(r.err, ['pariksha doc-budgets: rule.md has no table under "## Budgets"']);
    assert.equal(r.ok, false);
  });

  it('passes a table whose files all fit', () => {
    assert.equal(checkBudgets(TABLE, 'Budgets', 'rule.md', () => 1).ok, true);
  });
});
