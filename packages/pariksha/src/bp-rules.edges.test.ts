// bp-rules on its edges: dates in the years 0000-0099, and a README that a
// listing names with either separator.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bpRules, corpusFingerprint, type CorpusReader, due, parseIsoDate, type Rule, ruleFromFrontmatter } from './bp-rules.ts';

const rule = (id: string, verifyBy: string): Rule => ({ id, title: id, category: 'security', severity: 'high', enforcement: 'guidance', verify_by: verifyBy, sources: [], applies_to: [], status: 'active', path: `r/security/${id}.md` });

/** A corpus `list` gives as written, `/` or `\`, under `r/`. */
const listed = (files: Readonly<Record<string, string>>): CorpusReader => ({
  list: () => Object.keys(files),
  read: (path) => {
    // The rule is read by the path its listing gives, under `r/`; any other path is a regression, not empty text.
    const text = files[path.slice('r/'.length)] ?? files[path.slice('r\\'.length)];
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    return Buffer.from(text);
  },
});

describe('bp-rules on its edges', () => {
  it('--due counts days in the years 0000-0099 as in any other year', () => {
    const result = due([rule('BP-SEC-001', '0050-01-31'), rule('BP-SEC-002', '0049-12-31')], parseIsoDate('0050-01-01') as Date, 30);
    assert.deepEqual(
      result.approaching.map((r) => [r.id, r.daysLeft]),
      [['BP-SEC-001', 30]],
    );
    assert.deepEqual(
      result.stale.map((r) => [r.id, r.daysOverdue]),
      [['BP-SEC-002', 1]],
    );
  });

  it('refuses a rule whose tier is not one of the three, naming it, so no count or check skips it', () => {
    assert.throws(() => ruleFromFrontmatter({ id: 'BP-SEC-001', enforcement: 'validater' }, 'r/sec/a.md'), {
      message: 'r/sec/a.md: BP-SEC-001\'s enforcement "validater" is not one of eslint-rule, validator, guidance',
    });
    for (const tier of ['eslint-rule', 'validator', 'guidance']) assert.equal(ruleFromFrontmatter({ id: 'BP-SEC-001', enforcement: tier }, 'r/a.md')?.enforcement, tier);
    assert.equal(ruleFromFrontmatter({ id: 'BP-SEC-001' }, 'r/a.md')?.enforcement, 'guidance');
    // Through the command line: nothing checked, exit 2.
    const files: Record<string, string> = { 'docs/bp/sec/a.md': '---\nid: BP-SEC-001\nenforcement: validater\n---\n' };
    const result = bpRules(new Map([['--check-wiring', '']]), JSON.stringify({ rules: 'docs/bp', index: 'docs/BP.md', idPrefix: 'BP' }), {
      root: 'repo',
      reader: { list: () => ['sec/a.md'], read: (path) => Buffer.from(files[path.slice('repo/'.length)] as string) },
      exists: () => true,
      now: () => new Date(0),
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^pariksha bp-rules: docs\/bp\/sec\/a\.md: BP-SEC-001's enforcement "validater" is not one of/);
  });

  it('corpusFingerprint leaves out a nested README whichever separator the listing uses', () => {
    const base = { 'sec/a.md': '---\nid: BP-SEC-001\n---\n' };
    const plain = corpusFingerprint('r', listed(base));
    assert.equal(corpusFingerprint('r', listed({ ...base, 'sec\\README.md': '# About\n' })), plain);
    assert.equal(corpusFingerprint('r', listed({ ...base, 'sec/README.md': '# About\n' })), plain);
    assert.notEqual(corpusFingerprint('r', listed({ ...base, 'sec/b.md': '# B\n' })), plain);
  });
});
