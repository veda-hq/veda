import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  BP_RULES_USAGE,
  DISK,
  bpRules,
  checkSummaryDrift,
  checkWiring,
  corpusFingerprint,
  due,
  gaps,
  inventory,
  loadRules,
  nextId,
  parseBpRulesConfig,
  parseFrontmatter,
  parseIsoDate,
  parseSummaryBlock,
  regenerateIndex,
  renderSummaryRows,
  ruleFromFrontmatter,
  summariseSections,
  totalCounts,
  type BpIo,
  type BpRulesConfig,
  type CorpusReader,
  type Enforcement,
  type Rule,
} from './bp-rules.ts';

/** athya_mono's layout: the values its `.pariksha.json` gives `checks.bp-rules`. */
const ATHYA: BpRulesConfig = { rules: 'docs/standards/best-practices', index: 'docs/standards/BEST_PRACTICES.md', idPrefix: 'BP' };
const SETTINGS = JSON.stringify(ATHYA);

const tempRoot = (): string => mkdtempSync(join(tmpdir(), 'pariksha-bp-rules-'));

// --- fixture helpers ----------------------------------------------------------

const rule = (partial: Partial<Rule> & { id: string }): Rule => ({
  title: partial.title ?? `Title ${partial.id}`,
  category: partial.category ?? 'security',
  severity: partial.severity ?? 'high',
  enforcement: partial.enforcement ?? 'guidance',
  sources: partial.sources ?? ['src'],
  applies_to: partial.applies_to ?? ['apps/server'],
  status: partial.status ?? 'active',
  path: partial.path ?? `docs/standards/best-practices/${partial.category ?? 'security'}/${partial.id}.md`,
  ...partial,
});

/** An in-memory corpus: `list` returns paths in insertion order, unsorted. */
const memoryReader = (files: Readonly<Record<string, string>>): CorpusReader => ({
  list: (dir) =>
    Object.keys(files)
      .filter((path) => path.startsWith(`${dir}/`))
      .map((path) => path.slice(dir.length + 1)),
  read: (path) => {
    const text = files[path];
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    return Buffer.from(text);
  },
});

const ruleBody = (id: string, category: string): string => `---\nid: ${id}\ncategory: ${category}\n---\n\nBody.\n`;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// ═══ ported from athya_mono .claude/scripts/bp-rules.test.ts ═══════════════════

describe('frontmatter parsing', () => {
  it('parseFrontmatter: tolerates CRLF line endings', () => {
    const p = parseFrontmatter(['id: BP-CR-001', "title: 'CRLF'", 'sources:', "  - 's'"].join('\r\n'));
    assert.equal(p['id'], 'BP-CR-001');
    assert.equal(p['title'], 'CRLF');
    assert.deepEqual(p['sources'], ['s']);
  });

  it('parseFrontmatter: scalars, inline arrays, multi-line lists, quotes', () => {
    const p = parseFrontmatter(['id: BP-DB-008', "title: 'SQLite Savepoints'", 'severity: critical', 'sources:', "  - 'SQLite docs'", "  - 'concurrency guide'", 'applies_to:', "  - 'apps/mobile'"].join('\n'));
    assert.equal(p['id'], 'BP-DB-008');
    assert.equal(p['title'], 'SQLite Savepoints');
    assert.equal(p['severity'], 'critical');
    assert.deepEqual(p['sources'], ['SQLite docs', 'concurrency guide']);
    assert.deepEqual(p['applies_to'], ['apps/mobile']);
  });

  it('parseFrontmatter: inline array form', () => {
    const p = parseFrontmatter("applies_to: ['scripts', '.agent']\nid: BP-SEC-007");
    assert.deepEqual(p['applies_to'], ['scripts', '.agent']);
    assert.equal(p['id'], 'BP-SEC-007');
  });

  it('parseFrontmatter: blank line resets a pending list key', () => {
    const p = parseFrontmatter('applies_to:\n  - a\n\ntitle: T');
    assert.deepEqual(p['applies_to'], ['a']);
    assert.equal(p['title'], 'T');
  });

  it('ruleFromFrontmatter: a rule that names no tier is guidance', () => {
    assert.equal(ruleFromFrontmatter({ id: 'BP-X-003', title: 'T' }, 'p.md')?.enforcement, 'guidance');
  });

  it('ruleFromFrontmatter: full rule, missing id -> null, deprecated', () => {
    assert.equal(ruleFromFrontmatter({ title: 'x' }, 'p.md'), null); // README/non-rule
    const r = ruleFromFrontmatter({ id: 'BP-X-001', title: 'T', category: 'sync', severity: 'low', enforcement: 'guidance', applies_to: ['apps/mobile'], sources: ['s'] }, 'docs/standards/best-practices/sync/t.md');
    assert.equal(r?.id, 'BP-X-001');
    assert.equal(r?.status, 'active');
    const dep = ruleFromFrontmatter({ id: 'BP-X-002', status: 'deprecated', deprecated_at: '2026-01-01' }, 'p.md');
    assert.equal(dep?.status, 'deprecated');
    assert.equal(dep?.deprecated_at, '2026-01-01');
  });
});

describe('inventory / gaps', () => {
  it('inventory: counts by tier, deprecated excluded from byTier', () => {
    const inv = inventory([rule({ id: 'BP-A-001', enforcement: 'eslint-rule' }), rule({ id: 'BP-A-002', enforcement: 'guidance' }), rule({ id: 'BP-A-003', enforcement: 'guidance', status: 'deprecated' })]);
    assert.equal(inv.total, 3);
    assert.equal(inv.active, 2);
    assert.equal(inv.deprecated, 1);
    assert.equal(inv.byTier['eslint-rule'], 1);
    assert.equal(inv.byTier['guidance'], 1); // the deprecated guidance rule is not counted
    assert.equal(inv.byTier['validator'], 0);
  });

  it('gaps: only active guidance rules, sorted critical->low', () => {
    const g = gaps([
      rule({ id: 'BP-A-001', enforcement: 'guidance', severity: 'low' }),
      rule({ id: 'BP-A-002', enforcement: 'guidance', severity: 'critical' }),
      rule({ id: 'BP-A-003', enforcement: 'validator', severity: 'critical' }),
      rule({ id: 'BP-A-004', enforcement: 'guidance', severity: 'critical', status: 'deprecated' }),
    ]);
    assert.equal(g.count, 2);
    assert.deepEqual(
      g.gaps.map((r) => r.id),
      ['BP-A-002', 'BP-A-001'], // critical before low; enforced + deprecated excluded
    );
  });
});

describe('due (freshness)', () => {
  it('due: stale / approaching / noDate with injected today', () => {
    const res = due(
      [
        rule({ id: 'BP-A-001', verify_by: '2026-01-01' }), // stale
        rule({ id: 'BP-A-002', verify_by: '2026-06-30' }), // approaching (<=30d)
        rule({ id: 'BP-A-003', verify_by: '2027-01-01' }), // fresh -> excluded
        rule({ id: 'BP-A-004', verify_by: undefined }), // no date
        rule({ id: 'BP-A-005', verify_by: '2026-01-01', status: 'deprecated' }), // excluded
      ],
      new Date('2026-06-14T00:00:00Z'),
      30,
    );
    assert.equal(res.today, '2026-06-14');
    assert.deepEqual(
      res.stale.map((r) => r.id),
      ['BP-A-001'],
    );
    assert.equal(res.stale[0]?.daysOverdue, 164);
    assert.deepEqual(
      res.approaching.map((r) => r.id),
      ['BP-A-002'],
    );
    assert.equal(res.approaching[0]?.daysLeft, 16);
    assert.deepEqual(
      res.noDate.map((r) => r.id),
      ['BP-A-004'],
    );
  });
});

describe('next-id', () => {
  it('nextId: max+1 zero-padded; empty prefix -> 001', () => {
    const rules = [rule({ id: 'BP-SEC-001' }), rule({ id: 'BP-SEC-008' }), rule({ id: 'BP-DB-003' })];
    assert.equal(nextId(rules, 'SEC', 'BP').nextId, 'BP-SEC-009');
    assert.equal(nextId(rules, 'PERF', 'BP').nextId, 'BP-PERF-001');
  });
});

describe('check-wiring', () => {
  it('checkWiring: validator rules need an existing enforcement_script', () => {
    const rules = [
      rule({ id: 'BP-A-001', enforcement: 'validator', enforcement_script: 'exists.ts' }),
      rule({ id: 'BP-A-002', enforcement: 'validator', enforcement_script: 'missing.ts' }),
      rule({ id: 'BP-A-003', enforcement: 'validator' }), // no script field
      rule({ id: 'BP-A-004', enforcement: 'guidance' }), // ignored
      rule({ id: 'BP-A-005', enforcement: 'validator', enforcement_script: 'x.ts', status: 'deprecated' }),
    ];
    const res = checkWiring(rules, (p) => p === 'exists.ts');
    assert.equal(res.ok, false);
    assert.deepEqual(res.missing.map((m) => m.id).sort(), ['BP-A-002', 'BP-A-003']);
  });

  it('checkWiring: a declared enforcement_script must exist whatever the tier', () => {
    // An eslint-rule that names a rule module which is not there documents an
    // enforcement it does not have: the same lie a validator-tier rule tells.
    const res = checkWiring(
      [
        rule({ id: 'BP-A-001', enforcement: 'eslint-rule', enforcement_script: 'scripts/eslint-rules/gone.js' }),
        rule({ id: 'BP-A-002', enforcement: 'eslint-rule', enforcement_script: 'scripts/eslint-rules/here.js' }),
        rule({ id: 'BP-A-003', enforcement: 'guidance' }), // declares none
      ],
      (p) => p === 'scripts/eslint-rules/here.js',
    );
    assert.equal(res.ok, false);
    assert.deepEqual(
      res.missing.map((m) => m.id),
      ['BP-A-001'],
    );
    assert.deepEqual(res.checked, ['BP-A-001', 'BP-A-002'], 'no-script tiers skipped');
  });

  it('check-wiring accepts an ids filter and still walks the corpus without one', () => {
    const rules = [
      rule({ id: 'BP-TEST-010', enforcement: 'validator', enforcement_script: 'ok.ts' }),
      rule({ id: 'BP-TEST-011', enforcement: 'eslint-rule', enforcement_script: 'ok.js' }),
      rule({ id: 'BP-TEST-012', enforcement: 'guidance' }),
      // Somebody else's broken rule, elsewhere in the corpus.
      rule({ id: 'BP-OTHER-001', enforcement: 'validator' }),
    ];
    const exists = (p: string): boolean => p === 'ok.ts' || p === 'ok.js';

    // Unfiltered: the whole corpus, so the unrelated breakage is still reported.
    const all = checkWiring(rules, exists);
    assert.equal(all.ok, false);
    assert.equal(all.ids, null, 'no filter recorded');
    assert.deepEqual(
      all.missing.map((m) => m.id),
      ['BP-OTHER-001'],
    );

    // Filtered: an assertion about exactly these three rules, green independently of the rest.
    const mine = checkWiring(rules, exists, ['BP-TEST-010', 'BP-TEST-011', 'BP-TEST-012']);
    assert.equal(mine.ok, true);
    assert.deepEqual(mine.ids, ['BP-TEST-010', 'BP-TEST-011', 'BP-TEST-012']);
    assert.deepEqual(mine.checked, ['BP-TEST-010', 'BP-TEST-011'], 'guidance declares no script, so there is nothing to wire');
    assert.deepEqual(mine.missing, []);

    // The filter still reports breakage inside its own scope.
    const broken = checkWiring(rules, exists, ['BP-TEST-010', 'BP-OTHER-001']);
    assert.equal(broken.ok, false);
    assert.deepEqual(
      broken.missing.map((m) => m.id),
      ['BP-OTHER-001'],
    );

    // An id no rule carries is NOT a pass: a filter that matches nothing would
    // make "my rules are wired" true by vacuity (a renamed or deleted rule id).
    const typo = checkWiring(rules, exists, ['BP-TEST-010', 'BP-TEST-999']);
    assert.equal(typo.ok, false);
    assert.deepEqual(typo.unknownIds, ['BP-TEST-999']);
    assert.deepEqual(typo.missing, []);
    assert.equal(checkWiring(rules, exists, ['BP-NOPE-001']).checkedCount, 0);
  });
});

const INDEX_FIXTURE = [
  '# Best Practices',
  '',
  '> Curated prose blurb that must be preserved.',
  '',
  '## Security (2 rules)',
  '',
  '| ID         | Rule                  | Severity | Enforcement |',
  '| ---------- | --------------------- | -------- | ----------- |',
  '| BP-SEC-001 | [Old Title](./best-practices/security/a.md) | critical | none |',
  '| BP-SEC-002 | [B](./best-practices/security/b.md) | high | none |',
  '',
  '---',
  '',
  '## Mobile (1 rules)',
  '',
  '| ID          | Rule | Severity | Enforcement |',
  '| ----------- | ---- | -------- | ----------- |',
  '| BP-MOB-001 | [M](./best-practices/mobile/m.md) | high | none |',
  '',
].join('\n');

describe('regenerate-index', () => {
  it('regenerateIndex: updates cells in place, preserves order + prose, fixes count', () => {
    const rules = [
      rule({ id: 'BP-SEC-001', title: 'New Title', category: 'security', severity: 'critical', enforcement: 'eslint-rule', path: 'docs/standards/best-practices/security/a.md' }),
      rule({ id: 'BP-SEC-002', title: 'B', category: 'security', severity: 'high', enforcement: 'guidance', path: 'docs/standards/best-practices/security/b.md' }),
      // New rule in security -> appended after existing rows
      rule({ id: 'BP-SEC-003', title: 'C', category: 'security', severity: 'low', enforcement: 'guidance', path: 'docs/standards/best-practices/security/c.md' }),
      // Discount rule filed under mobile/ but frontmatter category 'campaigns':
      // must still land in the Mobile section (grouped by path, not category).
      rule({ id: 'BP-DISC-001', title: 'Disc', category: 'campaigns', severity: 'critical', enforcement: 'validator', path: 'docs/standards/best-practices/mobile/disc.md' }),
      rule({ id: 'BP-MOB-001', title: 'M', category: 'mobile', severity: 'high', enforcement: 'guidance', path: 'docs/standards/best-practices/mobile/m.md' }),
    ];
    const { text, unplaced } = regenerateIndex(INDEX_FIXTURE, rules, ATHYA);
    assert.deepEqual(unplaced, []); // BP-DISC-001 placed via path grouping
    assert.ok(text.includes('> Curated prose blurb that must be preserved.'));
    const secIdx1 = text.indexOf('BP-SEC-001');
    const secIdx2 = text.indexOf('BP-SEC-002');
    const secIdx3 = text.indexOf('BP-SEC-003');
    assert.ok(secIdx1 < secIdx2 && secIdx2 < secIdx3, 'order preserved + appended');
    assert.ok(text.includes('[New Title](./best-practices/security/a.md)'));
    assert.ok(/BP-SEC-001 \| \[New Title\].* \| critical \| eslint-rule \|/.test(text));
    // Count fixed: Security now 3, Mobile now 2 (DISC appended)
    assert.ok(text.includes('## Security (3 rules)'));
    assert.ok(text.includes('## Mobile (2 rules)'));
    assert.ok(text.includes('BP-DISC-001'));
  });

  it('regenerateIndex: unknown-category rule is reported unplaced, keeps unknown row', () => {
    const idx = [
      '## Security (1 rules)',
      '',
      '| ID | Rule | Severity | Enforcement |',
      '| -- | ---- | -------- | ----------- |',
      '| BP-SEC-001 | [A](./best-practices/security/a.md) | high | none |',
      '| BP-OLD-099 | [Gone](./best-practices/security/gone.md) | low | none |',
      '',
    ].join('\n');
    const rules = [
      rule({ id: 'BP-SEC-001', category: 'security', enforcement: 'validator', path: 'docs/standards/best-practices/security/a.md' }),
      // A rule whose directory has no section in the index -> unplaced
      rule({ id: 'BP-NEW-001', category: 'testing', path: 'docs/standards/best-practices/testing/n.md' }),
    ];
    const { text, unplaced } = regenerateIndex(idx, rules, ATHYA);
    assert.deepEqual(unplaced, ['BP-NEW-001']);
    assert.ok(/BP-SEC-001 \|.*\| high \| validator \|/.test(text));
    assert.ok(text.includes('| BP-OLD-099 | [Gone](./best-practices/security/gone.md) | low | none |'));
  });

  it('regenerateIndex: a deprecated rule shows "deprecated" in the enforcement column', () => {
    const idx = ['## Security (1 rules)', '', '| ID | Rule | Severity | Enforcement |', '| -- | ---- | -------- | ----------- |', '| BP-SEC-001 | [A](./best-practices/security/a.md) | high | validator |', ''].join('\n');
    const { text } = regenerateIndex(idx, [rule({ id: 'BP-SEC-001', severity: 'high', enforcement: 'validator', status: 'deprecated', path: 'docs/standards/best-practices/security/a.md' })], ATHYA);
    assert.ok(/BP-SEC-001 \|.*\| high \| deprecated \|/.test(text));
  });
});

/**
 * A miniature index carrying the invariant athya's real one carries: BP-DISC-001
 * is listed under BOTH Mobile and Discount, so the Total counts ROWS (4), not
 * distinct rule files (3). The Summary numbers are deliberately STALE: what a
 * hand-maintained table looks like after a rule change.
 */
const SUMMARY_FIXTURE = [
  '# Best Practices',
  '',
  '## Mobile (2 rules)',
  '',
  '| ID | Rule | Severity | Enforcement |',
  '| -- | ---- | -------- | ----------- |',
  '| BP-MOB-001 | [M](./best-practices/mobile/m.md) | high | guidance |',
  '| BP-DISC-001 | [D](./best-practices/mobile/disc.md) | critical | validator |',
  '',
  '---',
  '',
  '## Discount (2 rules)',
  '',
  '| ID | Rule | Severity | Enforcement |',
  '| -- | ---- | -------- | ----------- |',
  '| BP-DISC-001 | [D](./best-practices/mobile/disc.md) | critical | validator |',
  '| BP-DISC-002 | [E](./best-practices/discount/e.md) | high | guidance |',
  '',
  '---',
  '',
  '## Summary',
  '',
  '| Category | Rules | Critical | Enforced | Guidance |',
  '| -------- | ----- | -------- | -------- | -------- |',
  '| Mobile | 1 | 0 | 1 | 0 |',
  '| Discount | 1 | 0 | 1 | 0 |',
  '| **Total** | **2** | **0** | **2** | **0** |',
  '',
  '> Prose after the Summary that must survive.',
  '',
].join('\n');

/** The Summary heading kept, its table gone: a half-deleted block. */
const NO_SUMMARY_TABLE_FIXTURE = [
  '# Best Practices',
  '',
  '## Mobile (2 rules)',
  '',
  '| ID | Rule | Severity | Enforcement |',
  '| -- | ---- | -------- | ----------- |',
  '| BP-MOB-001 | [M](./best-practices/mobile/m.md) | high | guidance |',
  '| BP-DISC-001 | [D](./best-practices/mobile/disc.md) | critical | validator |',
  '',
  '---',
  '',
  '## Summary',
  '',
  '> Prose after the Summary that must survive.',
  '',
].join('\n');

describe('derived Summary block', () => {
  it('summariseSections: counts ROWS per section, so a twice-listed rule counts twice', () => {
    const counts = summariseSections(SUMMARY_FIXTURE.split('\n'), 'BP');
    assert.deepEqual(counts, [
      { category: 'Mobile', rules: 2, critical: 1, enforced: 1, guidance: 1 },
      { category: 'Discount', rules: 2, critical: 1, enforced: 1, guidance: 1 },
    ]);
    // 4 ROWS over 3 distinct rule files: the double count is kept, which a file-keyed count cannot produce.
    assert.deepEqual(totalCounts(counts), { category: 'Total', rules: 4, critical: 2, enforced: 2, guidance: 2 });
  });

  it('regenerateIndex: rewrites the stale Summary block from the section rows', () => {
    const rules = [
      rule({ id: 'BP-MOB-001', title: 'M', category: 'mobile', severity: 'high', enforcement: 'guidance', path: 'docs/standards/best-practices/mobile/m.md' }),
      rule({ id: 'BP-DISC-001', title: 'D', category: 'mobile', severity: 'critical', enforcement: 'validator', path: 'docs/standards/best-practices/mobile/disc.md' }),
      rule({ id: 'BP-DISC-002', title: 'E', category: 'discount', severity: 'high', enforcement: 'guidance', path: 'docs/standards/best-practices/discount/e.md' }),
    ];
    const { text } = regenerateIndex(SUMMARY_FIXTURE, rules, ATHYA);
    assert.ok(text.includes('| Mobile | 2 | 1 | 1 | 1 |'), 'Mobile line recomputed from its rows');
    assert.ok(text.includes('| Discount | 2 | 1 | 1 | 1 |'), 'Discount line recomputed from its rows');
    assert.ok(text.includes('| **Total** | **4** | **2** | **2** | **2** |'), 'Total counts rows (4), not distinct rule files (3)');
    assert.ok(!text.includes('| **Total** | **2** |'), 'the stale Total is gone, not emitted byte-identical');
    assert.ok(text.includes('> Prose after the Summary that must survive.'), 'prose after the Summary block is preserved');
    // The Summary block keeps exactly one body per header: no duplication.
    assert.equal(text.split('| **Total** |').length - 1, 1);
  });

  it('checkSummaryDrift: reports every stale cell, and is clean once regenerated', () => {
    const stale = checkSummaryDrift(SUMMARY_FIXTURE, 'BP');
    assert.equal(stale.ok, false);
    assert.ok(
      stale.drift.some((d) => d.category === 'Total' && d.column === 'rules' && d.written === 2 && d.derived === 4),
      'the Total row total is reported with both numbers',
    );
    assert.ok(
      stale.drift.some((d) => d.category === 'Mobile' && d.column === 'critical'),
      'a per-section column is reported too',
    );
    const { text } = regenerateIndex(SUMMARY_FIXTURE, [], ATHYA);
    assert.deepEqual(checkSummaryDrift(text, 'BP').drift, []);
    assert.equal(checkSummaryDrift(text, 'BP').ok, true);
  });

  it('checkSummaryDrift: a Summary line for a vanished section is reported', () => {
    const withGhost = SUMMARY_FIXTURE.replace('| **Total** |', '| Ghost | 3 | 0 | 0 | 0 |\n| **Total** |');
    assert.ok(
      checkSummaryDrift(withGhost, 'BP').drift.some((d) => d.category === 'Ghost' && d.column === 'presence' && d.derived === null),
      'a Summary row with no matching section is drift',
    );
  });

  it('checkSummaryDrift: a missing Summary block fails rather than passing vacuously', () => {
    const noSummary = SUMMARY_FIXTURE.split('\n')
      .filter((line) => !/^\| (Category|Mobile|Discount|\*\*Total\*\*) /.test(line))
      .join('\n');
    const result = checkSummaryDrift(noSummary, 'BP');
    assert.equal(result.ok, false);
    assert.equal(result.written, null);
    assert.deepEqual(
      result.drift.map((d) => d.column),
      ['presence'],
    );
  });

  it('checkSummaryDrift: a duplicate category row is rejected, never overwritten', () => {
    const { text } = regenerateIndex(SUMMARY_FIXTURE, [], ATHYA);
    assert.equal(checkSummaryDrift(text, 'BP').ok, true, 'baseline: the block is clean');
    // A STALE row above a correct one for the same category: a lookup keyed by
    // `new Map(written.map(...))` kept the LAST row, so the stale one was never compared.
    const result = checkSummaryDrift(text.replace('| Mobile | 2 | 1 | 1 | 1 |', '| Mobile | 99 | 0 | 0 | 0 |\n| Mobile | 2 | 1 | 1 | 1 |'), 'BP');
    assert.equal(result.ok, false, 'a Summary that says two things must fail');
    assert.ok(
      result.drift.some((d) => d.category === 'Mobile' && d.column === 'duplicate'),
      'the repeat itself is reported',
    );
    assert.ok(
      result.drift.some((d) => d.category === 'Mobile' && d.column === 'rules' && d.written === 99 && d.derived === 2),
      'the first row is still cell-checked, so its stale numbers are named',
    );
  });

  it('regenerateIndex: creates a missing Summary block under its heading', () => {
    // --check-index fails here and tells the reader to run --regenerate-index;
    // a regenerate that left the block absent could not repair what it reported.
    assert.equal(checkSummaryDrift(NO_SUMMARY_TABLE_FIXTURE, 'BP').ok, false);
    const { text } = regenerateIndex(NO_SUMMARY_TABLE_FIXTURE, [], ATHYA);
    assert.ok(text.includes('| **Total** | **2** | **1** | **1** | **1** |'), 'the created block carries the derived totals');
    assert.ok(text.includes('| Mobile | 2 | 1 | 1 | 1 |'));
    assert.equal(checkSummaryDrift(text, 'BP').ok, true, 'the recommended command now fixes the reported failure');
    assert.ok(text.includes('> Prose after the Summary that must survive.'), 'surrounding prose survives');
    assert.equal(text.split('## Summary').length - 1, 1, 'one heading, not two');
    assert.equal(regenerateIndex(text, [], ATHYA).text, text, 'and a second run is a no-op');
  });

  it('regenerateIndex: a legacy Agent-Review Summary block is replaced in place, not left beside a new one', () => {
    const legacy = SUMMARY_FIXTURE.replace('| Category | Rules | Critical | Enforced | Guidance |', '| Category | Rules | Critical | Agent-Review | Enforced |').replace(
      '| -------- | ----- | -------- | -------- | -------- |',
      '| -------- | ----- | -------- | ------------ | -------- |',
    );
    // A legacy header is drift by itself: its columns are never read as the current ones.
    const stale = checkSummaryDrift(legacy, 'BP');
    assert.equal(stale.ok, false, 'a legacy header is drift');
    assert.deepEqual(
      stale.drift.map((d) => d.column),
      ['header'],
    );
    const { text } = regenerateIndex(legacy, [], ATHYA);
    assert.equal(text.split('| Category |').length - 1, 1, 'one Summary table');
    assert.ok(!text.includes('Agent-Review'), 'the legacy header is gone');
    assert.ok(text.includes('| Category | Rules | Critical | Enforced | Guidance |'));
    assert.equal(text.split('| **Total** |').length - 1, 1, 'one Total row');
    assert.equal(checkSummaryDrift(text, 'BP').ok, true);
    assert.equal(regenerateIndex(text, [], ATHYA).text, text, 'idempotent');
  });

  it('regenerateIndex: creates the Summary section when even the heading is gone', () => {
    const noHeading = NO_SUMMARY_TABLE_FIXTURE.split('\n')
      .filter((line) => line !== '## Summary')
      .join('\n');
    assert.equal(checkSummaryDrift(noHeading, 'BP').ok, false);
    const { text } = regenerateIndex(noHeading, [], ATHYA);
    assert.ok(text.includes('## Summary'), 'a heading is created to hold it');
    assert.equal(checkSummaryDrift(text, 'BP').ok, true);
    assert.equal(regenerateIndex(text, [], ATHYA).text, text, 'idempotent');
  });
});

describe('loadRules and section categories', () => {
  it('loadRules: strips repoRoot separator-agnostically, no hardcoded slash', () => {
    // A CRLF rule file under a nested dir must load, and its path must be the
    // root-relative path with '/' separators and no leading slash.
    const root = tempRoot();
    try {
      const dir = join(root, 'docs', 'standards', 'best-practices', 'security');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'a.md'), ['---', 'id: BP-SEC-001', "title: 'T'", '---', 'body'].join('\r\n'), 'utf-8');
      const rules = loadRules(join(root, 'docs', 'standards', 'best-practices'), root);
      assert.equal(rules.length, 1, 'CRLF rule file loaded');
      assert.equal(rules[0]?.path, 'docs/standards/best-practices/security/a.md', 'relative path with / separators, no leading slash');
      assert.ok(!rules[0]?.path.startsWith('/'), 'no leading separator');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loadRules: parses a corpus consistently (ported from "parses the real corpus consistently")', () => {
    const rules = loadRules(RULES_DIR, ROOT, memoryReader(CORPUS));
    assert.ok(rules.length > 0, 'found rule files');
    assert.ok(
      rules.every((r) => /^BP-[A-Z]+-\d+$/.test(r.id)),
      'all ids well-formed',
    );
    // byTier sums to the active count (no rule miscounted or dropped)
    const inv = inventory(rules);
    assert.equal(
      Object.values(inv.byTier).reduce((a, b) => a + b, 0),
      inv.active,
    );
    assert.deepEqual(Object.keys(inv.byTier).sort(), ['eslint-rule', 'guidance', 'validator']);
  });

  it('regenerateIndex: a section takes its category from its HEADING, not a row path', () => {
    // Regression: the section category came from the FIRST data row's link
    // path. A Discount section leading with a rule filed under mobile/ read as
    // 'mobile', and every mobile rule was regenerated into it.
    const idx = [
      '# Best Practices',
      '',
      '## Discount (2 rules)',
      '',
      '| ID | Rule | Severity | Enforcement |',
      '| --- | --- | --- | --- |',
      '| BP-DISC-001 | [Lead](./best-practices/mobile/disc.md) | critical | validator |',
      '| BP-DISC-002 | [Real](./best-practices/discount/two.md) | high | guidance |',
      '',
      '## Mobile (1 rule)',
      '',
      '| ID | Rule | Severity | Enforcement |',
      '| --- | --- | --- | --- |',
      '| BP-MOB-001 | [M](./best-practices/mobile/m.md) | high | guidance |',
      '',
    ].join('\n');
    const rules = [
      rule({ id: 'BP-DISC-001', title: 'Lead', category: 'campaigns', severity: 'critical', enforcement: 'validator', path: 'docs/standards/best-practices/mobile/disc.md' }),
      rule({ id: 'BP-DISC-002', title: 'Real', category: 'discount', severity: 'high', enforcement: 'guidance', path: 'docs/standards/best-practices/discount/two.md' }),
      rule({ id: 'BP-MOB-001', title: 'M', category: 'mobile', severity: 'high', enforcement: 'guidance', path: 'docs/standards/best-practices/mobile/m.md' }),
    ];
    const { text } = regenerateIndex(idx, rules, ATHYA);
    const discountSection = text.slice(text.indexOf('## Discount'), text.indexOf('## Mobile'));
    assert.ok(!discountSection.includes('BP-MOB-001'), 'mobile rule leaked into the Discount section');
    assert.ok(text.includes('## Discount (2 rules)'));
  });

  it('regenerateIndex: an unrecognized heading falls back to the majority row path', () => {
    // A renamed or ad-hoc section names no known category: then the rows
    // decide, by MAJORITY. Two mobile rows outvote the lone security lead row.
    const idx = [
      '# Best Practices',
      '',
      '## Assorted Legacy Notes (3 rules)',
      '',
      '| ID | Rule | Severity | Enforcement |',
      '| --- | --- | --- | --- |',
      '| BP-SEC-001 | [Lead](./best-practices/security/a.md) | critical | validator |',
      '| BP-MOB-001 | [M1](./best-practices/mobile/m1.md) | high | guidance |',
      '| BP-MOB-002 | [M2](./best-practices/mobile/m2.md) | high | guidance |',
      '',
    ].join('\n');
    const rules = [
      rule({ id: 'BP-MOB-001', title: 'M1', category: 'mobile', severity: 'high', enforcement: 'guidance', path: 'docs/standards/best-practices/mobile/m1.md' }),
      rule({ id: 'BP-MOB-002', title: 'M2 renamed', category: 'mobile', severity: 'high', enforcement: 'guidance', path: 'docs/standards/best-practices/mobile/m2.md' }),
      rule({ id: 'BP-MOB-003', title: 'M3 new', category: 'mobile', severity: 'low', enforcement: 'guidance', path: 'docs/standards/best-practices/mobile/m3.md' }),
    ];
    const { text } = regenerateIndex(idx, rules, ATHYA);
    assert.ok(text.includes('M2 renamed'), 'majority category was not resolved');
    assert.ok(text.includes('BP-MOB-003'), 'new rule not appended to the section');
  });
});

// --- corpus fingerprint: it must move when, and only when, the bytes a reviewer reads change.

/** Write a small rule corpus under `root` and return its rules dir. */
const writeCorpus = (root: string, files: Readonly<Record<string, string>>): string => {
  const rulesDir = join(root, 'docs', 'standards', 'best-practices');
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(rulesDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return rulesDir;
};

const CORPUS_FILES = {
  'database/postgres.md': ['---', 'id: BP-DB-001', "title: 'Postgres'", 'severity: critical', '---', 'Every mutable table carries updated_at.', ''].join('\n'),
  'testing/vacuous.md': ['---', 'id: BP-TEST-012', "title: 'Test validity'", 'severity: high', '---', 'An assertion must be able to fail.', ''].join('\n'),
  // Excluded by the same filter loadRules uses.
  'README.md': '# Index of rules\n',
  // NOT a rule (loadRules drops it for having no frontmatter) but still bytes a reviewer reads.
  'testing/NOTES.md': 'Scratch notes about the testing rules.\n',
};

describe('corpus fingerprint', () => {
  it('corpusFingerprint: identical corpora hash the same, wherever they live', () => {
    const a = tempRoot();
    const b = tempRoot();
    try {
      const fpA = corpusFingerprint(writeCorpus(a, CORPUS_FILES));
      const fpB = corpusFingerprint(writeCorpus(b, CORPUS_FILES));
      assert.match(fpA, /^[0-9a-f]{40}$/, 'sha1 hex');
      assert.equal(fpA, fpB, 'byte-identical corpora hash identically; the absolute path is not an input');
      // Stable across calls on the same directory too (no time or random input).
      assert.equal(corpusFingerprint(writeCorpus(a, CORPUS_FILES)), fpA);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('corpusFingerprint: one byte of a rule body flips it; a README edit does not', () => {
    const root = tempRoot();
    try {
      const rulesDir = writeCorpus(root, CORPUS_FILES);
      const base = corpusFingerprint(rulesDir);
      writeFileSync(join(rulesDir, 'database/postgres.md'), CORPUS_FILES['database/postgres.md'].replace('carries updated_at.', 'carries updated_at!'), 'utf-8');
      assert.notEqual(corpusFingerprint(rulesDir), base, 'a one-byte rule-body edit changes the digest');
      // Restoring the byte restores the digest (content-addressed, not a counter).
      writeCorpus(root, CORPUS_FILES);
      assert.equal(corpusFingerprint(rulesDir), base);
      writeFileSync(join(rulesDir, 'README.md'), '# Index of rules (v2)\n');
      assert.equal(corpusFingerprint(rulesDir), base, 'a README edit does not move it');
      // A frontmatter-less .md IS inside the digest: a reviewer still reads it.
      writeFileSync(join(rulesDir, 'testing/NOTES.md'), 'Scratch notes, revised.\n');
      assert.notEqual(corpusFingerprint(rulesDir), base, 'a frontmatter-less rule-dir .md still changes the digest');
      // Adding and deleting a rule file both move it.
      writeCorpus(root, CORPUS_FILES);
      writeFileSync(join(rulesDir, 'testing/new-rule.md'), '---\nid: BP-X-001\n---\n');
      assert.notEqual(corpusFingerprint(rulesDir), base, 'a new rule file changes the digest');
      rmSync(join(rulesDir, 'testing/new-rule.md'));
      assert.equal(corpusFingerprint(rulesDir), base, 'deleting it restores it');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('corpusFingerprint: a corpus hashes the same wherever it is copied (ported from "the real corpus")', () => {
    const root = tempRoot();
    try {
      const corpus = writeCorpus(join(root, 'a'), CORPUS_FILES);
      const copy = join(root, 'copy');
      cpSync(corpus, copy, { recursive: true });
      assert.equal(corpusFingerprint(copy), corpusFingerprint(corpus), 'a copied corpus hashes identically');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const TABLE_HEADER = '| ID | Rule | Severity | Enforcement |';
const TABLE_SEP = '| -- | ---- | -------- | ----------- |';
const SUMMARY_HEADER = '| Category | Rules | Critical | Enforced | Guidance |';
const SUMMARY_SEP = '| -------- | ----- | -------- | -------- | -------- |';
const MOB_ROW = '| BP-MOB-001 | [M](./best-practices/mobile/m.md) | critical | validator |';
const DISC_ROW = '| BP-DISC-001 | [E](./best-practices/discount/e.md) | high | guidance |';
const EMPTY_SUMMARY = [SUMMARY_HEADER, SUMMARY_SEP, '| **Total** | **0** | **0** | **0** | **0** |'];

describe('edges each line of the toolkit decides', () => {
  it('parseFrontmatter: strips a quote pair only when both ends carry it', () => {
    const p = parseFrontmatter(["a: 'open", "b: close'", 'c: "open', 'd: close"', 'e: \'mixed"', "f: 'single'", 'g: "double"'].join('\n'));
    assert.deepEqual(p, { a: "'open", b: "close'", c: '"open', d: 'close"', e: '\'mixed"', f: 'single', g: 'double' });
  });

  it('parseFrontmatter: a line that is no key ends a pending list, so later items are not its own', () => {
    assert.deepEqual(parseFrontmatter('sources:\n  - a\n# a comment\n  - b\n- c\nid: X'), { sources: ['a'], id: 'X' });
  });

  it('ruleFromFrontmatter: missing fields take their defaults; present ones are kept', () => {
    const bare = ruleFromFrontmatter({ id: 'BP-X-010' }, 'p.md');
    assert.equal(bare?.title, '');
    assert.equal(bare?.category, '');
    assert.equal(bare?.severity, 'low');
    const full = ruleFromFrontmatter({ id: 'BP-X-011', title: 'T', category: 'c', severity: 'high' }, 'p.md');
    assert.equal(full?.title, 'T');
    assert.equal(full?.category, 'c');
    assert.equal(full?.severity, 'high');
  });

  it('ruleFromFrontmatter: a scalar list field is one item; an empty one is none', () => {
    const r = ruleFromFrontmatter({ id: 'BP-X-012', sources: 'one', applies_to: '' }, 'p.md');
    assert.deepEqual(r?.sources, ['one']);
    assert.deepEqual(r?.applies_to, []);
  });

  it('loadRules: a rule outside repoRoot, or at it, keeps its absolute path', () => {
    const reader = memoryReader({ '/corpus/cat/x.md': ruleBody('BP-OUT-001', 'cat') });
    assert.deepEqual(
      loadRules('/corpus', '/elsewhere', reader).map((r) => r.path),
      ['/corpus/cat/x.md'],
    );
    assert.deepEqual(
      loadRules('/corpus', '/corpus/cat/x.md', reader).map((r) => r.path),
      ['/corpus/cat/x.md'],
    );
    assert.deepEqual(
      loadRules('/corpus', '/', reader).map((r) => r.path),
      ['corpus/cat/x.md'],
    );
  });

  it('corpusFingerprint: sha1 of path NUL bytes NUL, in code-unit path order', () => {
    const files = { '/c/b/z.md': 'zed', '/c/README.md': 'ignored', '/c/a/y.md': 'why', '/c/B/w.md': 'upper' };
    const h = createHash('sha1');
    for (const [rel, body] of [
      ['B/w.md', 'upper'],
      ['a/y.md', 'why'],
      ['b/z.md', 'zed'],
    ]) {
      h.update(`${rel as string}\0${body as string}\0`);
    }
    assert.equal(corpusFingerprint('/c', memoryReader(files)), h.digest('hex'));
  });

  it('inventory: projects the optional dates and script when a rule has them', () => {
    const [projected] = inventory([rule({ id: 'BP-X-020', enforcement: 'validator', enforcement_script: 'scripts/x.ts', verified: '2026-01-01', verify_by: '2026-06-01' })]).rules;
    assert.equal(projected?.enforcement_script, 'scripts/x.ts');
    assert.equal(projected?.verified, '2026-01-01');
    assert.equal(projected?.verify_by, '2026-06-01');
  });

  it('due: today is approaching, the window edge is in, past it is out; both lists sort', () => {
    const result = due(
      [
        rule({ id: 'BP-D-001', verify_by: '2026-02-27' }), // 2 days overdue
        rule({ id: 'BP-D-002', verify_by: '2026-02-24' }), // 5 days overdue
        rule({ id: 'BP-D-003', verify_by: '2026-03-31' }), // 30 days left
        rule({ id: 'BP-D-004', verify_by: '2026-03-01' }), // due today
        rule({ id: 'BP-D-005', verify_by: '2026-04-01' }), // 31 days left
        rule({ id: 'BP-D-006', verify_by: '2026-02-30' }), // no such date
      ],
      new Date('2026-03-01T12:00:00Z'),
      30,
    );
    assert.deepEqual(
      result.stale.map((r) => [r.id, r.daysOverdue]),
      [
        ['BP-D-002', 5],
        ['BP-D-001', 2],
      ],
    );
    assert.deepEqual(
      result.approaching.map((r) => [r.id, r.daysLeft]),
      [
        ['BP-D-004', 0],
        ['BP-D-003', 30],
      ],
    );
    assert.equal(result.noDateCount, 0);
  });

  it('checkWiring: an empty ids list is no filter; an empty script is no script', () => {
    const rules = [rule({ id: 'BP-W-001', enforcement: 'validator', enforcement_script: 'a.ts' }), rule({ id: 'BP-W-002', enforcement: 'guidance', enforcement_script: '' })];
    const result = checkWiring(rules, () => true, []);
    assert.equal(result.ids, null);
    assert.deepEqual(result.checked, ['BP-W-001']);
    assert.equal(result.ok, true);
  });

  it('summariseSections: a table with no separator, and a heading straight after rows', () => {
    const lines = ['## Mobile (1 rule)', TABLE_HEADER, MOB_ROW, '## Discount (1 rule)', TABLE_HEADER, TABLE_SEP, DISC_ROW];
    assert.deepEqual(summariseSections(lines, 'BP'), [
      { category: 'Mobile', rules: 1, critical: 1, enforced: 1, guidance: 0 },
      { category: 'Discount', rules: 1, critical: 0, enforced: 0, guidance: 1 },
    ]);
  });

  it('checkSummaryDrift: reads a Summary table that has no separator line', () => {
    const text = ['## Mobile (1 rule)', '', TABLE_HEADER, TABLE_SEP, MOB_ROW, '', '## Summary', '', SUMMARY_HEADER, '| Mobile | 1 | 1 | 1 | 0 |', '| **Total** | **1** | **1** | **1** | **0** |', ''].join('\n');
    assert.deepEqual(checkSummaryDrift(text, 'BP').drift, []);
  });

  it('checkSummaryDrift: a missing block reports the derived total; a missing line names its section', () => {
    const sections = ['## Mobile (1 rule)', '', TABLE_HEADER, TABLE_SEP, MOB_ROW, '', '## Discount (1 rule)', '', TABLE_HEADER, TABLE_SEP, DISC_ROW, ''];
    assert.deepEqual(checkSummaryDrift(sections.join('\n'), 'BP').drift, [{ category: 'Total', column: 'presence', written: null, derived: 2 }]);
    const withoutDiscount = [...sections, '## Summary', '', SUMMARY_HEADER, SUMMARY_SEP, '| Mobile | 1 | 1 | 1 | 0 |', '| **Total** | **2** | **1** | **1** | **1** |'].join('\n');
    assert.deepEqual(checkSummaryDrift(withoutDiscount, 'BP').drift, [{ category: 'Discount', column: 'presence', written: null, derived: 1 }]);
  });

  it('regenerateIndex: a created Summary section replaces the trailing blank lines', () => {
    assert.equal(regenerateIndex(['# T', 'Prose.', '', '', ''].join('\n'), [], ATHYA).text, ['# T', 'Prose.', '', '## Summary', '', ...EMPTY_SUMMARY, ''].join('\n'));
    assert.equal(regenerateIndex('\n\n', [], ATHYA).text, ['', '## Summary', '', ...EMPTY_SUMMARY, ''].join('\n'));
  });

  it('regenerateIndex: a block created under the heading drops the blank lines that followed it', () => {
    assert.equal(regenerateIndex(['# T', '## Summary', '', '', 'Prose.'].join('\n'), [], ATHYA).text, ['# T', '## Summary', '', ...EMPTY_SUMMARY, '', 'Prose.'].join('\n'));
    assert.equal(regenerateIndex(['# T', '## Summary', '', ''].join('\n'), [], ATHYA).text, ['# T', '## Summary', '', ...EMPTY_SUMMARY, ''].join('\n'));
  });

  it('regenerateIndex: a heading of several words names the hyphenated directory', () => {
    const ci = rule({ id: 'BP-CI-001', title: 'C', category: 'ci-cd', path: 'docs/standards/best-practices/ci-cd/c.md' });
    const result = regenerateIndex(['## CI/CD! (0 rules)', '', TABLE_HEADER, TABLE_SEP, ''].join('\n'), [ci], ATHYA);
    assert.deepEqual(result.unplaced, []);
    assert.ok(result.text.startsWith('## CI/CD! (1 rule)\n'));
  });

  it('regenerateIndex: rows of a table with no separator are rewritten and counted', () => {
    const m = rule({ id: 'BP-MOB-001', title: 'Renamed', category: 'mobile', severity: 'critical', enforcement: 'validator', path: 'docs/standards/best-practices/mobile/m.md' });
    const lines = regenerateIndex(['## Mobile (5 rules)', TABLE_HEADER, MOB_ROW, ''].join('\n'), [m], ATHYA).text.split('\n');
    assert.deepEqual(lines.slice(0, 3), ['## Mobile (1 rule)', TABLE_HEADER, '| BP-MOB-001 | [Renamed](./best-practices/mobile/m.md) | critical | validator |']);
  });

  it('regenerateIndex: under an unknown heading, a tie in link votes goes to the first row', () => {
    const m = rule({ id: 'BP-MOB-001', category: 'mobile', path: 'docs/standards/best-practices/mobile/m.md' });
    const d = rule({ id: 'BP-DISC-001', category: 'discount', path: 'docs/standards/best-practices/discount/e.md' });
    const text = ['## Odd (2 rules)', '', TABLE_HEADER, TABLE_SEP, MOB_ROW, DISC_ROW].join('\n');
    assert.deepEqual(regenerateIndex(text, [m, d], ATHYA).unplaced, ['BP-DISC-001']);
  });
});

// ═══ ported from athya_mono .claude/scripts/bp-rules-cli.test.ts ═══════════════

const ROOT = '/repo';
const RULES_DIR = `${ROOT}/docs/standards/best-practices`;
const INDEX = `${ROOT}/docs/standards/BEST_PRACTICES.md`;
const TODAY = new Date('2026-03-01T00:00:00Z');

const ruleFile = (fields: readonly string[]): string => ['---', ...fields, '---', '', 'Body.', ''].join('\n');

const STALE_INDEX = [
  '# Best Practices',
  '',
  '## Mobile (2 rules)',
  '',
  '| ID | Rule | Severity | Enforcement |',
  '| -- | ---- | -------- | ----------- |',
  '| BP-MOB-001 | [M](./best-practices/mobile/m.md) | high | guidance |',
  '| BP-MOB-002 | [D](./best-practices/mobile/d.md) | critical | validator |',
  '',
  '---',
  '',
  '## Discount (1 rule)',
  '',
  '| ID | Rule | Severity | Enforcement |',
  '| -- | ---- | -------- | ----------- |',
  '| BP-DISC-001 | [E](./best-practices/discount/e.md) | high | guidance |',
  '',
  '---',
  '',
  '## Summary',
  '',
  '| Category | Rules | Critical | Enforced | Guidance |',
  '| -------- | ----- | -------- | -------- | -------- |',
  '| Mobile | 1 | 0 | 1 | 0 |',
  '| Discount | 1 | 0 | 0 | 1 |',
  '| **Total** | **2** | **0** | **1** | **1** |',
  '',
].join('\n');

/** Three rules: one approaching (19 days), one stale, one undated. */
const CORPUS: Readonly<Record<string, string>> = {
  [`${RULES_DIR}/README.md`]: '# Rules\n',
  [`${RULES_DIR}/mobile/m.md`]: ruleFile(['id: BP-MOB-001', "title: 'M'", 'category: mobile', 'severity: high', 'enforcement: guidance', 'verify_by: 2026-03-20']),
  [`${RULES_DIR}/mobile/d.md`]: ruleFile(['id: BP-MOB-002', "title: 'D'", 'category: mobile', 'severity: critical', 'enforcement: validator', 'enforcement_script: scripts/check-d.ts', 'verify_by: 2026-02-01']),
  [`${RULES_DIR}/discount/e.md`]: ruleFile(['id: BP-DISC-001', "title: 'E'", 'category: discount', 'severity: high', 'enforcement: guidance']),
  [INDEX]: STALE_INDEX,
};

const io = (files: Readonly<Record<string, string>> = CORPUS, present: readonly string[] = [`${ROOT}/scripts/check-d.ts`]): BpIo => ({
  root: ROOT,
  reader: memoryReader(files),
  exists: (path) => present.includes(path),
  now: () => TODAY,
});

const rules = (files: Readonly<Record<string, string>> = CORPUS): Rule[] => loadRules(RULES_DIR, ROOT, memoryReader(files));

const VALUED = ['--within', '--today', '--next-id', '--ids', '--root', '--config'];

/** The map pariksha's `flags()` hands over: a switch as '', a valued flag with its value. */
const toFlags = (tokens: readonly string[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const name = tokens[i] as string;
    if (VALUED.includes(name)) {
      out.set(name, tokens[i + 1] as string);
      i += 1;
    } else out.set(name, '');
  }
  return out;
};

const main = (tokens: readonly string[], runIo: BpIo = io(), settings = SETTINGS) => bpRules(toFlags(tokens), settings, runIo);

const usageFails = (tokens: readonly string[], message: string): void => {
  assert.deepEqual(main(tokens), { code: 2, stdout: '', stderr: `pariksha bp-rules: ${message}\n${BP_RULES_USAGE}\n` });
};

describe('bpRules modes', () => {
  it('--inventory prints every rule with the tier counts', () => {
    const expected = inventory(rules());
    assert.equal(expected.total, 3);
    assert.deepEqual(main(['--inventory']), { code: 0, stdout: json(expected), stderr: '' });
  });

  it('--gaps prints the guidance rules', () => {
    const expected = gaps(rules());
    assert.equal(expected.count, 2);
    assert.deepEqual(main(['--gaps']), { code: 0, stdout: json(expected), stderr: '' });
  });

  it('--due judges against the clock, 30 days ahead by default', () => {
    const result = main(['--due']);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed['today'], '2026-03-01');
    assert.equal(parsed['withinDays'], 30);
    assert.equal(parsed['staleCount'], 1);
    assert.equal(parsed['approachingCount'], 1);
    assert.equal(parsed['noDateCount'], 1);
  });

  it('--due --within narrows what counts as approaching', () => {
    const parsed = JSON.parse(main(['--due', '--within', '10']).stdout) as { withinDays: number; approachingCount: number };
    assert.equal(parsed.withinDays, 10);
    assert.equal(parsed.approachingCount, 0);
  });

  it('--due --today replaces the clock with that UTC date', () => {
    const parsed = JSON.parse(main(['--due', '--today', '2026-03-25']).stdout) as { today: string; staleCount: number; approachingCount: number };
    assert.equal(parsed.today, '2026-03-25');
    assert.equal(parsed.staleCount, 2);
    assert.equal(parsed.approachingCount, 0);
  });

  it('--next-id prints the next id for the prefix', () => {
    assert.deepEqual(main(['--next-id', 'MOB']), { code: 0, stdout: json(nextId(rules(), 'MOB', 'BP')), stderr: '' });
    assert.equal((JSON.parse(main(['--next-id', 'MOB']).stdout) as { nextId: string }).nextId, 'BP-MOB-003');
  });

  it('--corpus-fingerprint prints the digest of the rule files', () => {
    const digest = corpusFingerprint(RULES_DIR, memoryReader(CORPUS));
    assert.match(digest, /^[0-9a-f]{40}$/);
    assert.deepEqual(main(['--corpus-fingerprint']), { code: 0, stdout: json({ corpusFingerprint: digest }), stderr: '' });
  });

  it('--check-wiring exits 0 when every enforcement_script exists under the root', () => {
    const result = main(['--check-wiring']);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, ids: null, checkedCount: 1, checked: ['BP-MOB-002'], missingCount: 0, missing: [], unknownIds: [] });
  });

  it('--check-wiring exits 1 on a missing script; a path outside the root does not count', () => {
    const result = main(['--check-wiring'], io(CORPUS, ['/scripts/check-d.ts']));
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual((JSON.parse(result.stdout) as { missing: unknown[] }).missing, [{ id: 'BP-MOB-002', enforcement_script: 'scripts/check-d.ts' }]);
  });

  it('--check-wiring --ids trims each id and drops empty ones', () => {
    const result = main(['--check-wiring', '--ids', ' BP-MOB-002, ,BP-DISC-001']);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as { ids: string[]; unknownIds: string[] };
    assert.deepEqual(parsed.ids, ['BP-MOB-002', 'BP-DISC-001']);
    assert.deepEqual(parsed.unknownIds, []);
  });

  it('--check-wiring --ids fails on an id no rule carries', () => {
    const result = main(['--check-wiring', '--ids', 'BP-NOPE-001']);
    assert.equal(result.code, 1);
    assert.deepEqual((JSON.parse(result.stdout) as { unknownIds: string[] }).unknownIds, ['BP-NOPE-001']);
  });

  it('--regenerate-index prints the rebuilt index and exits 0 when every rule is placed', () => {
    const { text, unplaced } = regenerateIndex(STALE_INDEX, rules(), ATHYA);
    assert.deepEqual(unplaced, []);
    assert.notEqual(text, STALE_INDEX);
    assert.deepEqual(main(['--regenerate-index']), { code: 0, stdout: text, stderr: '' });
  });

  it('--regenerate-index exits 1 and names each rule with no index section', () => {
    const files = {
      ...CORPUS,
      [`${RULES_DIR}/ghost/g.md`]: ruleFile(['id: BP-GHOST-001', "title: 'G'", 'category: ghost', 'severity: low', 'enforcement: guidance']),
      [`${RULES_DIR}/ghost/h.md`]: ruleFile(['id: BP-GHOST-002', "title: 'H'", 'category: ghost', 'severity: low', 'enforcement: guidance']),
    };
    assert.deepEqual(main(['--regenerate-index'], io(files)), {
      code: 1,
      stdout: regenerateIndex(STALE_INDEX, rules(files), ATHYA).text,
      stderr: '\n⚠️  Rules with no matching index section (add manually): BP-GHOST-001, BP-GHOST-002\n',
    });
  });

  it('--check-index exits 1 on a stale Summary and says how to recompute it', () => {
    const drift = checkSummaryDrift(STALE_INDEX, 'BP');
    assert.equal(drift.drift.length, 6);
    assert.deepEqual(main(['--check-index']), {
      code: 1,
      stdout: json(drift),
      stderr:
        '\n❌ BEST_PRACTICES.md Summary is stale (6 mismatch(es)). ' +
        'Recompute it: mkdir -p .tmp && pariksha bp-rules --regenerate-index > .tmp/BEST_PRACTICES.md && mv .tmp/BEST_PRACTICES.md docs/standards/BEST_PRACTICES.md\n',
    });
  });

  it('--check-index exits 0 once the index is regenerated', () => {
    const fresh = regenerateIndex(STALE_INDEX, rules(), ATHYA).text;
    assert.deepEqual(main(['--check-index'], io({ ...CORPUS, [INDEX]: fresh })), { code: 0, stdout: json(checkSummaryDrift(fresh, 'BP')), stderr: '' });
  });

  it('a failed read exits 2: nothing was checked, so it is not a pass', () => {
    const files: Record<string, string> = { ...CORPUS };
    delete files[INDEX];
    assert.deepEqual(main(['--check-index'], io(files)), { code: 2, stdout: '', stderr: `pariksha bp-rules: ENOENT: ${INDEX}; nothing was checked, so this is not a pass\n` });
  });
});

describe('bpRules usage errors', () => {
  it('no mode is a usage error', () => {
    usageFails([], 'give exactly one mode, got none');
  });

  it('two or more modes are a usage error naming each', () => {
    usageFails(
      ['--inventory', '--gaps', '--due', '--next-id', 'X', '--corpus-fingerprint', '--check-wiring', '--regenerate-index', '--check-index'],
      'give exactly one mode, got --inventory --gaps --due --next-id --corpus-fingerprint --check-wiring --regenerate-index --check-index',
    );
  });

  it('an option is refused outside its mode', () => {
    usageFails(['--gaps', '--within', '5'], '--within applies to --due only');
    usageFails(['--gaps', '--today', '2026-03-01'], '--today applies to --due only');
    usageFails(['--due', '--ids', 'BP-MOB-001'], '--ids applies to --check-wiring only');
  });

  it('--today must name a real date', () => {
    usageFails(['--due', '--today', '2026-02-30'], '--today must be a real YYYY-MM-DD date, got "2026-02-30"');
  });

  it('a non-numeric or out-of-range --within is refused, before the mode count', () => {
    for (const within of ['abc', '1.5', '0x10', '-1', '3651', '99999999999999999999']) usageFails(['--due', '--within', within], '--within must be an integer from 0 to 3650');
    // As the original's parser did: the value is judged before the modes are counted.
    usageFails(['--gaps', '--within', 'abc'], '--within must be an integer from 0 to 3650');
  });

  it('--within takes a signed decimal integer at either end of its range', () => {
    for (const [within, days] of [
      ['0', 0],
      ['-0', 0],
      ['+5', 5],
      ['3650', 3650],
    ] as const) {
      const parsed = JSON.parse(main(['--due', '--within', within]).stdout) as { withinDays: number };
      assert.ok(Object.is(parsed.withinDays, days), `--within ${within}`);
    }
  });

  it('--root and --config in the map are not modes', () => {
    assert.equal(main(['--gaps', '--root', '/x', '--config', 'c.json']).code, 0);
  });
});

// ERR-09: fail each read a mode makes (listing, rule file, index, script
// lookup) in turn. None may end in exit 0; here every one ends in 2, with
// nothing on stdout. The command writes no file: no artifact to tear.
describe('ERR-09: a failed read never exits 0', () => {
  const fresh = { ...CORPUS, [INDEX]: regenerateIndex(STALE_INDEX, rules(), ATHYA).text };
  for (const tokens of [['--inventory'], ['--gaps'], ['--due'], ['--next-id', 'MOB'], ['--corpus-fingerprint'], ['--check-wiring'], ['--regenerate-index'], ['--check-index']]) {
    it(`ERR-09: ${tokens.join(' ')} never exits 0 after a failed read`, () => {
      const clean = io(fresh);
      const faulty = (failAt: number): { io: BpIo; calls: () => number } => {
        let calls = 0;
        const step = (): void => {
          calls += 1;
          if (calls === failAt) throw new Error(`injected fault ${failAt}`);
        };
        return {
          io: {
            ...clean,
            reader: {
              list: (dir) => (step(), clean.reader.list(dir)),
              read: (path) => (step(), clean.reader.read(path)),
            },
            exists: (path) => (step(), clean.exists(path)),
          },
          calls: () => calls,
        };
      };
      const counted = faulty(0);
      assert.equal(main(tokens, counted.io).code, 0, 'the clean run passes');
      const explored = counted.calls();
      assert.ok(explored > 0, 'the mode reads something');
      for (let k = 1; k <= explored; k += 1) {
        assert.deepEqual(main(tokens, faulty(k).io), { code: 2, stdout: '', stderr: `pariksha bp-rules: injected fault ${k}; nothing was checked, so this is not a pass\n` }, `read ${k} of ${explored} failed`);
      }
    });
  }
});

// ═══ new in the port: the config, and the layout it carries ════════════════════

describe('parseBpRulesConfig', () => {
  it('reads the three keys', () => {
    assert.deepEqual(parseBpRulesConfig(SETTINGS), ATHYA);
  });

  it('refuses text that is not a JSON object', () => {
    assert.throws(() => parseBpRulesConfig('{'), /^Error: not JSON: /);
    assert.throws(() => parseBpRulesConfig('[]'), { message: 'the config must be a JSON object' });
    assert.throws(() => parseBpRulesConfig('null'), { message: 'the config must be a JSON object' });
  });

  it('refuses an unknown key', () => {
    assert.throws(() => parseBpRulesConfig(JSON.stringify({ ...ATHYA, prefix: 'BP' })), { message: 'unknown key "prefix"; bp-rules reads rules, index, idPrefix' });
  });

  it('refuses a missing, blank or non-string value for each key', () => {
    for (const key of ['rules', 'index', 'idPrefix'] as const) {
      for (const value of [undefined, '', '  ', 3]) {
        assert.throws(() => parseBpRulesConfig(JSON.stringify({ ...ATHYA, [key]: value })), { message: `"${key}" must be a non-empty string` }, `${key}: ${String(value)}`);
      }
    }
  });

  it('refuses a path that is not normalized and root-relative, which would never prefix a rule path', () => {
    for (const bad of ['docs/rules/', './docs/rules', '/docs/rules', '../rules', 'docs//rules', '.']) {
      assert.throws(() => parseBpRulesConfig(JSON.stringify({ ...ATHYA, rules: bad })), { message: `"rules": "${bad}" is not a normalized root-relative path` });
      assert.throws(() => parseBpRulesConfig(JSON.stringify({ ...ATHYA, index: bad })), { message: `"index": "${bad}" is not a normalized root-relative path` });
    }
  });

  it('bpRules exits 2 on a bad config, after the usage checks', () => {
    assert.deepEqual(main(['--gaps'], io(), JSON.stringify({ rules: 'r' })), { code: 2, stdout: '', stderr: 'pariksha bp-rules: "index" must be a non-empty string; nothing was checked, so this is not a pass\n' });
    const notJson = main(['--gaps'], io(), 'not json');
    assert.equal(notJson.code, 2);
    assert.equal(notJson.stdout, '');
    assert.match(notJson.stderr, /^pariksha bp-rules: not JSON: .*; nothing was checked, so this is not a pass\n$/);
    // A usage error is reported before the config is read.
    assert.deepEqual(main([], io(), 'not json'), { code: 2, stdout: '', stderr: `pariksha bp-rules: give exactly one mode, got none\n${BP_RULES_USAGE}\n` });
  });
});

describe('parseIsoDate', () => {
  it('reads a real date at UTC midnight and refuses one that does not exist', () => {
    assert.equal(parseIsoDate('2024-02-29')?.toISOString(), '2024-02-29T00:00:00.000Z');
    assert.equal(parseIsoDate('0050-01-01')?.getUTCFullYear(), 50);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-04-31', '2026-00-10', '2026-1-01', '2026-01-01T00:00:00Z', '']) assert.equal(parseIsoDate(bad), null, bad);
  });
});

describe('loadRules: what is not a rule', () => {
  it('skips a non-Markdown file, a nested README, a file with no or an unclosed frontmatter block, and one with no id', () => {
    const files = {
      '/c/a/x.md': ruleBody('BP-A-001', 'a'),
      '/c/a/notes.txt': ruleBody('BP-A-002', 'a'),
      '/c/a/README.md': ruleBody('BP-A-003', 'a'),
      '/c/a/plain.md': 'no frontmatter\n',
      '/c/a/open.md': '---\nid: BP-A-004\n',
      '/c/a/noid.md': '---\ntitle: T\n---\n',
    };
    assert.deepEqual(
      loadRules('/c', '/', memoryReader(files)).map((r) => r.id),
      ['BP-A-001'],
    );
  });

  it('reads the disk through DISK by default', () => {
    const root = tempRoot();
    try {
      const rulesDir = writeCorpus(root, CORPUS_FILES);
      assert.deepEqual(
        loadRules(rulesDir, root).map((r) => r.id),
        ['BP-DB-001', 'BP-TEST-012'],
      );
      assert.equal(DISK.read(join(rulesDir, 'README.md')).toString(), '# Index of rules\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inventory counts a tier it does not know under its own name', () => {
    assert.equal(inventory([rule({ id: 'BP-A-001', enforcement: 'none' as Enforcement })]).byTier['none'], 1);
  });
});

describe('Summary helpers', () => {
  it('renderSummaryRows and parseSummaryBlock read each other back; a short row is skipped', () => {
    const counts = [{ category: 'Mobile', rules: 2, critical: 1, enforced: 1, guidance: 1 }];
    const rows = renderSummaryRows(counts);
    assert.deepEqual(rows, ['| Mobile | 2 | 1 | 1 | 1 |', '| **Total** | **2** | **1** | **1** | **1** |']);
    assert.deepEqual(parseSummaryBlock([SUMMARY_HEADER, SUMMARY_SEP, '| short | 1 |', ...rows]), [...counts, { category: 'Total', rules: 2, critical: 1, enforced: 1, guidance: 1 }]);
    assert.equal(parseSummaryBlock(['no block']), null);
  });

  it('a table before any heading, and a row whose cells do not split, are not counted', () => {
    assert.deepEqual(summariseSections([TABLE_HEADER, TABLE_SEP, MOB_ROW], 'BP'), []);
    assert.deepEqual(summariseSections(['## S', TABLE_HEADER, '| BP-S-001 | x |'], 'BP'), [{ category: 'S', rules: 0, critical: 0, enforced: 0, guidance: 0 }]);
  });

  it('a heading count with no table under it becomes 0 rules', () => {
    assert.ok(regenerateIndex('## Empty (4 rules)\n\nprose\n## Next\n', [], ATHYA).text.startsWith('## Empty (0 rules)\n'));
    assert.ok(regenerateIndex('## Last (4 rules)\n', [], ATHYA).text.startsWith('## Last (0 rules)\n'));
  });

  it('a table no rule folder claims stays byte-identical', () => {
    const idx = ['## Odd (1 rule)', '', TABLE_HEADER, TABLE_SEP, '| BP-ODD-001 | [O](elsewhere.md) | low | guidance |', ''].join('\n');
    const { text } = regenerateIndex(idx, [], ATHYA);
    assert.ok(text.startsWith(`${idx}\n## Summary`), text);
  });
});

describe('the configured layout is honoured', () => {
  // The index is not in the folder above `rules`, and the id family has a
  // regex metacharacter: `R.X` must not take `RAX-…` for one of its ids.
  const OTHER: BpRulesConfig = { rules: 'kb/rules', index: 'docs/INDEX.md', idPrefix: 'R.X' };
  const r1 = rule({ id: 'R.X-SEC-001', title: 'One', category: 'security', path: 'kb/rules/sec/one.md' });
  const r2 = rule({ id: 'R.X-SEC-002', title: 'Two', category: 'security', path: 'kb/rules/sec/two.md' });

  it('links rows relative to the index folder and counts only the configured id family', () => {
    const idx = ['## Sec (1 rule)', '', TABLE_HEADER, TABLE_SEP, '| R.X-SEC-001 | [Old](../kb/rules/sec/one.md) | high | guidance |', '| RAX-SEC-009 | [Look-alike](x.md) | high | guidance |', ''].join('\n');
    const { text, unplaced } = regenerateIndex(idx, [r1, r2], OTHER);
    assert.deepEqual(unplaced, []);
    assert.deepEqual(text.split('\n').slice(0, 7), [
      '## Sec (2 rules)',
      '',
      TABLE_HEADER,
      TABLE_SEP,
      '| R.X-SEC-001 | [One](../kb/rules/sec/one.md) | high | guidance |',
      '| R.X-SEC-002 | [Two](../kb/rules/sec/two.md) | high | guidance |',
      '| RAX-SEC-009 | [Look-alike](x.md) | high | guidance |',
    ]);
    assert.deepEqual(summariseSections(text.split('\n'), 'R.X'), [{ category: 'Sec', rules: 2, critical: 0, enforced: 0, guidance: 2 }]);
    assert.deepEqual(summariseSections(text.split('\n'), 'BP'), [{ category: 'Sec', rules: 0, critical: 0, enforced: 0, guidance: 0 }], 'BP rows are not this family');
    assert.equal(checkSummaryDrift(text, 'R.X').ok, true);
  });

  it('nextId uses the configured family, and a look-alike id is not one of it', () => {
    assert.deepEqual(nextId([r1, rule({ id: 'RAX-SEC-005' }), rule({ id: 'BP-SEC-007' })], 'SEC', 'R.X'), { prefix: 'SEC', currentMax: 1, nextId: 'R.X-SEC-002' });
  });

  it('under an unknown heading the rows vote by links into the configured rules folder', () => {
    const idx = ['## Misc (1 rule)', TABLE_HEADER, '| R.X-SEC-001 | [Old](../kb/rules/sec/one.md) | high | guidance |'].join('\n');
    assert.deepEqual(regenerateIndex(idx, [r1, r2], OTHER).unplaced, []);
    // athya's link form names no folder of this layout: the section has no category.
    const athyaLinks = ['## Misc (1 rule)', TABLE_HEADER, '| R.X-SEC-001 | [Old](./best-practices/sec/one.md) | high | guidance |'].join('\n');
    assert.deepEqual(regenerateIndex(athyaLinks, [r1], OTHER).unplaced, ['R.X-SEC-001']);
  });

  it('a rule straight under `rules`, or outside it, falls back to its frontmatter category', () => {
    const flat = rule({ id: 'R.X-SEC-003', category: 'sec', path: 'kb/rules/flat.md' });
    const outside = rule({ id: 'R.X-SEC-004', category: 'sec', path: 'other/sec/x.md' });
    const { text, unplaced } = regenerateIndex(['## Sec (0 rules)', TABLE_HEADER, TABLE_SEP].join('\n'), [flat, outside], OTHER);
    assert.deepEqual(unplaced, []);
    assert.ok(text.includes('| R.X-SEC-003 | [Title R.X-SEC-003](../kb/rules/flat.md) | high | guidance |'));
    assert.ok(text.includes('| R.X-SEC-004 | [Title R.X-SEC-004](../other/sec/x.md) | high | guidance |'));
  });

  it('links from an index beside, inside or above the rules folder, and keeps an absolute path', () => {
    const cases: Array<[BpRulesConfig, string, string]> = [
      [{ rules: 'docs', index: 'docs/INDEX.md', idPrefix: 'BP' }, 'docs/sec/a.md', './sec/a.md'],
      [{ rules: 'rules', index: 'INDEX.md', idPrefix: 'BP' }, 'rules/sec/a.md', './rules/sec/a.md'],
      [{ rules: 'kb', index: 'kb/idx/INDEX.md', idPrefix: 'BP' }, 'kb/sec/a.md', '../sec/a.md'],
    ];
    for (const [config, path, link] of cases) {
      const r = rule({ id: 'BP-SEC-001', title: 'A', category: 'x', path });
      // An unknown heading, so the row's link must vote the section into `sec`.
      const idx = ['## Misc (1 rule)', TABLE_HEADER, `| BP-SEC-001 | [Old](${link}) | high | guidance |`].join('\n');
      const { text, unplaced } = regenerateIndex(idx, [r], config);
      assert.deepEqual(unplaced, [], config.index);
      assert.ok(text.includes(`| BP-SEC-001 | [A](${link}) | high | guidance |`), text);
    }
    const abs = rule({ id: 'BP-SEC-001', title: 'A', category: 'security', path: '/abs/security/a.md' });
    assert.ok(regenerateIndex(['## Security (0 rules)', TABLE_HEADER].join('\n'), [abs], ATHYA).text.includes('| BP-SEC-001 | [A](/abs/security/a.md) | high | guidance |'));
  });

  it('bpRules reads the configured folder and index on disk, names that index when stale, and round-trips --regenerate-index', () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'kb', 'rules', 'sec'), { recursive: true });
      mkdirSync(join(root, 'docs'), { recursive: true });
      mkdirSync(join(root, 'tools'), { recursive: true });
      writeFileSync(join(root, 'kb', 'rules', 'sec', 'one.md'), ruleFile(['id: R.X-SEC-001', "title: 'One'", 'severity: critical', 'enforcement: validator', 'enforcement_script: tools/check.ts']));
      writeFileSync(join(root, 'tools', 'check.ts'), '');
      const indexPath = join(root, 'docs', 'INDEX.md');
      writeFileSync(indexPath, ['# Index', '', '## Sec (0 rules)', '', TABLE_HEADER, TABLE_SEP, ''].join('\n'));
      const disk: BpIo = { root, reader: DISK, exists: existsSync, now: () => TODAY };
      const settings = JSON.stringify(OTHER);
      const run = (tokens: readonly string[]) => bpRules(toFlags(tokens), settings, disk);

      assert.deepEqual(
        (JSON.parse(run(['--inventory']).stdout) as { rules: Array<{ path: string }> }).rules.map((r) => r.path),
        ['kb/rules/sec/one.md'],
      );
      assert.equal(run(['--check-wiring']).code, 0);
      assert.equal((JSON.parse(run(['--next-id', 'SEC']).stdout) as { nextId: string }).nextId, 'R.X-SEC-002');

      const stale = run(['--check-index']);
      assert.equal(stale.code, 1);
      assert.equal(
        stale.stderr,
        '\n❌ INDEX.md Summary is stale (1 mismatch(es)). Recompute it: mkdir -p .tmp && pariksha bp-rules --regenerate-index > .tmp/INDEX.md && mv .tmp/INDEX.md docs/INDEX.md\n',
      );

      const first = run(['--regenerate-index']);
      assert.equal(first.code, 0);
      assert.ok(first.stdout.includes('| R.X-SEC-001 | [One](../kb/rules/sec/one.md) | critical | validator |'));
      writeFileSync(indexPath, first.stdout);
      assert.equal(readFileSync(indexPath, 'utf8'), first.stdout, 'written raw, byte for byte');
      assert.deepEqual(run(['--regenerate-index']), first, 'a second run over its own output is a no-op');
      assert.equal(run(['--check-index']).code, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
