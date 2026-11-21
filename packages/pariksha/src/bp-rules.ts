// bp-rules: deterministic queries and projections over a best-practice rule
// corpus, a folder of Markdown files each opening with a frontmatter block,
// and the index document that lists them in tables. Ported from athya_mono's
// `.claude/scripts/bp-rules.ts` and `bp-rules-cli.ts`.
//
// WHY. A skill that asks a model to read and parse every rule's frontmatter
// gets a different answer each run. The model keeps every judgement (is a
// rule mechanizable? does this diff violate it? is the guidance still
// current?); this check does the mechanical parse, filter, date compare,
// max+1 and projection, each of which has one correct answer.
//
// TWO ENFORCEMENT TIERS. A rule is ENFORCED when a hook or CI checks it
// (`eslint-rule`, `validator`) and GUIDANCE otherwise: an agent reads it when
// a change touches a path under `applies_to`, and nothing mechanical checks it.
//
// THE LAYOUT is the repository's, never pariksha's: `checks.bp-rules` in
// `.pariksha.json` names the corpus folder (`rules`), the index document
// (`index`) and the id family (`idPrefix`, so ids read `<idPrefix>-SEC-001`).
// An index row links a rule by its path relative to the index's folder, and a
// rule's section is the first folder under `rules` that holds it.
//
// The functions return values and never touch argv, stdout or the exit
// status; `bpRules` is the command line over them.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, posix, relative, sep } from 'node:path';
import { parseJson, path as repoPath, text as nonEmpty } from './registry-ratchet.ts';

/**
 * The two reads the corpus walk makes. A parameter, not a direct import, so a
 * test can fail each read in turn.
 */
export interface CorpusReader {
  /** Every path under `dir`, relative to it, recursively. */
  list(dir: string): string[];
  read(path: string): Buffer;
}

export const DISK: CorpusReader = {
  list: (dir) => readdirSync(dir, { recursive: true }) as string[],
  read: (path) => readFileSync(path),
};

/** Where a repository keeps its rules, and the id family they carry. */
export interface BpRulesConfig {
  /** The corpus folder, relative to the root (`docs/standards/best-practices`). */
  readonly rules: string;
  /** The index document, relative to the root (`docs/standards/BEST_PRACTICES.md`). */
  readonly index: string;
  /** The id family: ids read `<idPrefix>-<CATEGORY>-<NNN>` (`BP`). */
  readonly idPrefix: string;
}

const CONFIG_KEYS = ['rules', 'index', 'idPrefix'];

/** `{ "rules": "<dir>", "index": "<file>", "idPrefix": "<prefix>" }`, all three required; anything else throws. */
export const parseBpRulesConfig = (source: string): BpRulesConfig => {
  const raw = parseJson(source);
  const unknown = Object.keys(raw).find((k) => !CONFIG_KEYS.includes(k));
  if (unknown !== undefined) throw new Error(`unknown key "${unknown}"; bp-rules reads ${CONFIG_KEYS.join(', ')}`);
  // Normalized root-relative paths: a trailing slash or a leading `./` would
  // never prefix a rule's path, so every rule would fall out of its section.
  return { rules: repoPath(raw, 'rules', ''), index: repoPath(raw, 'index', ''), idPrefix: nonEmpty(raw, 'idPrefix', '') };
};

export type Severity = 'critical' | 'high' | 'medium' | 'low';
/** `eslint-rule` and `validator` are the enforced tier; `guidance` is read, never checked. */
export type Enforcement = 'eslint-rule' | 'validator' | 'guidance';

export interface Rule {
  id: string;
  title: string;
  category: string;
  severity: Severity;
  enforcement: Enforcement;
  enforcement_script?: string | undefined;
  verified?: string | undefined;
  verify_by?: string | undefined;
  sources: string[];
  applies_to: string[];
  status: 'active' | 'deprecated';
  deprecated_at?: string | undefined;
  /** root-relative path to the rule file */
  path: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── frontmatter (purpose-built: scalars, inline arrays, multi-line lists) ───

/** The block between a file's first two `---` lines, or null when it opens none or never closes it. */
const extractFrontmatter = (md: string): string | null => {
  const lines = md.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  return end === -1 ? null : lines.slice(1, end).join('\n');
};

const stripQuotes = (s: string): string => {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
};

const parseInlineArray = (value: string): string[] => {
  // e.g. ['scripts', '.agent']  or  ["a", "b"]
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  return inner
    .split(',')
    .map((part) => stripQuotes(part))
    .filter(Boolean);
};

/**
 * Parse frontmatter into a flat record. Scalars are strings; array fields
 * (inline `[...]` or multi-line `- item`) are string[]. Good enough for the
 * known rule schema, not a general YAML parser.
 */
export const parseFrontmatter = (fm: string): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  let pendingKey: string | null = null;
  for (const raw of fm.split(/\r?\n/)) {
    if (!raw.trim()) {
      pendingKey = null;
      continue;
    }
    const listItem = raw.match(/^\s*-\s+(.*)$/);
    if (listItem && pendingKey) {
      (out[pendingKey] as string[]).push(stripQuotes(listItem[1] as string));
      continue;
    }
    const kv = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) {
      pendingKey = null;
      continue;
    }
    const key = kv[1] as string;
    const value = (kv[2] as string).trim();
    if (value === '') {
      // Start of a multi-line list (or an empty scalar, told apart by whether
      // `- ` items follow on the next lines).
      out[key] = [];
      pendingKey = key;
    } else if (value.startsWith('[')) {
      out[key] = parseInlineArray(value);
      pendingKey = null;
    } else {
      out[key] = stripQuotes(value);
      pendingKey = null;
    }
  }
  return out;
};

const asString = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

const asArray = (v: string | string[] | undefined): string[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) return [v];
  return [];
};

/** A Rule from parsed frontmatter, or null when the file is not a rule (no id). */
export const ruleFromFrontmatter = (parsed: Record<string, string | string[]>, path: string): Rule | null => {
  const id = asString(parsed['id']);
  if (!id) return null; // README / non-rule markdown
  return {
    id,
    title: asString(parsed['title']) ?? '',
    category: asString(parsed['category']) ?? '',
    severity: (asString(parsed['severity']) ?? 'low') as Severity,
    // A rule that names no tier is guidance: read, never checked. There is
    // no third value for it to fall into.
    enforcement: (asString(parsed['enforcement']) ?? 'guidance') as Enforcement,
    enforcement_script: asString(parsed['enforcement_script']),
    verified: asString(parsed['verified']),
    verify_by: asString(parsed['verify_by']),
    sources: asArray(parsed['sources']),
    applies_to: asArray(parsed['applies_to']),
    status: asString(parsed['status']) === 'deprecated' ? 'deprecated' : 'active',
    deprecated_at: asString(parsed['deprecated_at']),
    path,
  };
};

/** Rule markdown under the corpus: `.md`, README excluded. */
const isRuleFile = (rel: string): boolean => rel.endsWith('.md') && !/(^|\/)README/i.test(rel);

/** Load and parse every rule file under rulesDir (recursive), sorted by id. */
export const loadRules = (rulesDir: string, repoRoot: string, reader: CorpusReader = DISK): Rule[] => {
  const rules: Rule[] = [];
  for (const rel of reader.list(rulesDir)) {
    if (!isRuleFile(rel)) continue;
    const abs = join(rulesDir, rel);
    const fm = extractFrontmatter(reader.read(abs).toString('utf-8'));
    if (!fm) continue;
    // Root-relative, with '/' separators whatever the platform; a file outside
    // the root (or the root itself) keeps its absolute path.
    const rel2 = relative(repoRoot, abs);
    const relPath = rel2.startsWith('..') || rel2 === '' ? abs : rel2.split(sep).join('/');
    const rule = ruleFromFrontmatter(parseFrontmatter(fm), relPath);
    if (rule) rules.push(rule);
  }
  rules.sort((a, b) => a.id.localeCompare(b.id));
  return rules;
};

/**
 * Content digest of the whole rule corpus: sha1 over `<relPath>\0<content>\0`
 * for every rule file, in sorted-path order. The same file set with the same
 * bytes always yields the same hex; a one-byte edit to any rule body, a
 * rename, an addition or a deletion changes it.
 *
 * Hashes the file bytes rather than the parsed rules: a rule file with no
 * frontmatter (which loadRules drops) still changes what a reviewer reads,
 * and so must change the digest.
 */
export const corpusFingerprint = (rulesDir: string, reader: CorpusReader = DISK): string => {
  const rels = reader
    .list(rulesDir)
    .filter(isRuleFile)
    // Path separators are platform-dependent; the digest must not be.
    .map((rel) => rel.split(sep).join('/'))
    // Code-unit order, so the digest does not depend on the locale.
    .sort();
  const h = createHash('sha1');
  for (const rel of rels) {
    h.update(rel);
    h.update('\0');
    h.update(reader.read(join(rulesDir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
};

// ── inventory / gaps ────────────────────────────────────────────────────────

const project = (r: Rule) => ({
  id: r.id,
  title: r.title,
  category: r.category,
  severity: r.severity,
  enforcement: r.enforcement,
  enforcement_script: r.enforcement_script ?? null,
  verified: r.verified ?? null,
  verify_by: r.verify_by ?? null,
  applies_to: r.applies_to,
  status: r.status,
  path: r.path,
});

type Projected = ReturnType<typeof project>;

export const inventory = (rules: readonly Rule[]) => {
  const byTier: Record<string, number> = { 'eslint-rule': 0, validator: 0, guidance: 0 };
  for (const r of rules) {
    if (r.status === 'deprecated') continue;
    byTier[r.enforcement] = (byTier[r.enforcement] ?? 0) + 1;
  }
  return {
    total: rules.length,
    active: rules.filter((r) => r.status === 'active').length,
    deprecated: rules.filter((r) => r.status === 'deprecated').length,
    byTier,
    rules: rules.map(project),
  };
};

const bySeverity = (a: Rule, b: Rule): number => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id);

export const gaps = (rules: readonly Rule[]) => {
  const g = rules.filter((r) => r.status === 'active' && r.enforcement === 'guidance').sort(bySeverity);
  return { count: g.length, gaps: g.map(project) };
};

// ── due (freshness): date arithmetic, `today` injected ──────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A calendar date `YYYY-MM-DD` at UTC midnight, or null when it is no real
 * date (`2026-02-29`, `2026-13-01`, `2026-04-31`): `Date` silently carries
 * the overflow, so the month and day must read back unchanged.
 */
export const parseIsoDate = (raw: string): Date | null => {
  const match = ISO_DATE.exec(raw);
  if (!match) return null;
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(0);
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 to 1900-1999.
  date.setUTCFullYear(Number(match[1]), month, day);
  return date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
};

/** Whole days from `to` to `fromISO`, or null when `fromISO` is no real date. */
const daysBetween = (fromISO: string, to: Date): number | null => {
  const from = parseIsoDate(fromISO);
  if (from === null) return null;
  const toUTC = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  return Math.round((from.getTime() - toUTC.getTime()) / 86_400_000);
};

export const due = (rules: readonly Rule[], today: Date, withinDays = 30) => {
  const stale: Array<Projected & { daysOverdue: number }> = [];
  const approaching: Array<Projected & { daysLeft: number }> = [];
  const noDate: Projected[] = [];
  for (const r of rules) {
    if (r.status === 'deprecated') continue;
    if (!r.verify_by) {
      noDate.push(project(r));
      continue;
    }
    const delta = daysBetween(r.verify_by, today); // >0 future, <0 past
    // An unreadable date lands in no bucket.
    if (delta === null) continue;
    if (delta < 0) stale.push({ ...project(r), daysOverdue: -delta });
    else if (delta <= withinDays) approaching.push({ ...project(r), daysLeft: delta });
  }
  stale.sort((a, b) => b.daysOverdue - a.daysOverdue);
  approaching.sort((a, b) => a.daysLeft - b.daysLeft);
  return {
    today: today.toISOString().slice(0, 10),
    withinDays,
    staleCount: stale.length,
    approachingCount: approaching.length,
    noDateCount: noDate.length,
    stale,
    approaching,
    noDate,
  };
};

// ── next-id: max suffix + 1, zero-padded to 3 ───────────────────────────────

/** The next `<idPrefix>-<prefix>-NNN`. `prefix` goes into the pattern as given, as it always has. */
export const nextId = (rules: readonly Rule[], prefix: string, idPrefix: string) => {
  const re = new RegExp(`^${escapeRegex(idPrefix)}-${prefix}-(\\d+)$`);
  let max = 0;
  for (const r of rules) {
    const m = r.id.match(re);
    if (m) max = Math.max(max, parseInt(m[1] as string, 10));
  }
  const next = String(max + 1).padStart(3, '0');
  return { prefix, currentMax: max, nextId: `${idPrefix}-${prefix}-${next}` };
};

// ── check-wiring ────────────────────────────────────────────────────────────

/**
 * Two obligations, both about a rule's enforcement being REAL:
 *   1. a `validator`-tier rule must declare an `enforcement_script`, and that
 *      script must exist: the tier promises something executable enforces it;
 *   2. ANY rule that declares an `enforcement_script` must point at a file
 *      that exists: a dangling path documents an enforcement it does not have.
 *
 * `ids` narrows the walk so a caller can assert about ITS OWN rules. An id no
 * rule carries is reported in `unknownIds` and fails the check: a filter that
 * silently matches nothing would make "my rules are wired" a vacuous pass.
 */
export const checkWiring = (rules: readonly Rule[], fileExists: (relPath: string) => boolean, ids?: readonly string[]) => {
  const requested = ids && ids.length > 0 ? [...new Set(ids)] : null;
  const known = new Set(rules.map((r) => r.id));
  const unknownIds = requested ? requested.filter((id) => !known.has(id)).sort() : [];
  const scoped = requested ? rules.filter((r) => requested.includes(r.id)) : rules;

  const missing: Array<{ id: string; enforcement_script: string | null }> = [];
  const checked: string[] = [];
  for (const r of scoped) {
    if (r.status === 'deprecated') continue;
    const script = typeof r.enforcement_script === 'string' && r.enforcement_script !== '' ? r.enforcement_script : null;
    if (r.enforcement !== 'validator' && script === null) continue;
    checked.push(r.id);
    if (script === null || !fileExists(script)) missing.push({ id: r.id, enforcement_script: script });
  }
  return {
    ok: missing.length === 0 && unknownIds.length === 0,
    ids: requested,
    checkedCount: checked.length,
    checked,
    missingCount: missing.length,
    missing,
    unknownIds,
  };
};

// ── the index tables ────────────────────────────────────────────────────────

// The scans below test `lines[k]` with no bounds check: past the last line it
// is undefined, which `RegExp.test` reads as the text "undefined", and no
// pattern here matches that.

/** A rule row: `| <idPrefix>-CAT-NNN | … |`. */
const rowPattern = (idPrefix: string): RegExp => new RegExp(`^\\|\\s*${escapeRegex(idPrefix)}-[A-Z]+-\\d+\\s*\\|.*\\|\\s*$`);
const HEADER_RE = /^\|\s*ID\s*\|\s*Rule\s*\|\s*Severity\s*\|\s*Enforcement\s*\|/i;
const SEP_RE = /^\|[\s|:-]+\|$/;

/** `from` to `to`, both root-relative, as a link: `./x` inside `from`, `../x` outside it, `.` for `from` itself. */
const relativeLink = (from: string, to: string): string => {
  const rel = posix.relative(from, to);
  if (rel === '') return '.';
  return /^\.\.(\/|$)/.test(rel) ? rel : `./${rel}`;
};

/** A rule's link from the index: relative to the index's folder. A rule outside the root keeps its absolute path. */
const ruleLink = (r: Rule, indexDir: string): string => (posix.isAbsolute(r.path) ? r.path : relativeLink(indexDir, r.path));

const indexRow = (r: Rule, indexDir: string): string => {
  // Deprecated rules show "deprecated" in the enforcement column rather than
  // their (now-moot) tier, so the index reflects their real status.
  const enforcement = r.status === 'deprecated' ? 'deprecated' : r.enforcement;
  return `| ${r.id} | [${r.title}](${ruleLink(r, indexDir)}) | ${r.severity} | ${enforcement} |`;
};

// ── the Summary block: DERIVED FROM THE SECTION TABLES, never from inventory
//
// The distinction is load-bearing. `inventory` is keyed by each file's
// FRONTMATTER `category` and counts FILES; the Summary counts the ROWS a reader
// can see in the index. A rule listed under two sections is two rows over one
// file; deriving from the rows keeps that double count, deriving from the
// inventory would quietly erase it.

/** The Summary table's own header row. Deliberately NOT `HEADER_RE`. */
const SUMMARY_HEADER_RE = /^\|\s*Category\s*\|\s*Rules\s*\|\s*Critical\s*\|\s*Enforced\s*\|\s*Guidance\s*\|/i;
/**
 * The retired header (Agent-Review | Enforced). `regenerateIndex` REPLACES a
 * block under it in place, instead of inserting a second table above it and
 * leaving the stale totals visible; `checkSummaryDrift` reports it as drift,
 * never reads its columns as if they were the current ones.
 */
const LEGACY_SUMMARY_HEADER_RE = /^\|\s*Category\s*\|\s*Rules\s*\|\s*Critical\s*\|\s*Agent-Review\s*\|\s*Enforced\s*\|/i;
/** `## Heading` with its optional `(N rules)` suffix stripped. */
const SECTION_HEADING_RE = /^##\s+(.+?)(?:\s+\(\d+\s+rules?\))?\s*$/;
/** A rule row split into its four cells; the Rule cell is greedy so a title with a pipe cannot shift the columns. */
const ROW_CELLS_RE = /^\|([^|]*)\|(.*)\|([^|]*)\|([^|]*)\|\s*$/;
/** Any table row, used to find the end of the Summary block's body. */
const ANY_ROW_RE = /^\|/;

/** One Summary line: a section heading and the four tallies under it. */
export interface SummaryCounts {
  /** The section heading, verbatim minus its `(N rules)` suffix. */
  category: string;
  /** Rows in the section table, NOT distinct rule files. */
  rules: number;
  critical: number;
  /** Rows whose enforcement is `validator` or `eslint-rule`. */
  enforced: number;
  /** Rows whose enforcement is `guidance`. */
  guidance: number;
}

/** The label the Total row carries, so parse and render agree on one spelling. */
const TOTAL_LABEL = 'Total';

const emptyCounts = (category: string): SummaryCounts => ({ category, rules: 0, critical: 0, enforced: 0, guidance: 0 });

/**
 * Tally every `## Section` table in the index: ROWS, in the order the sections
 * appear, so a rule listed under two sections counts once per listing. A
 * section whose table has no rows still reports zeroes rather than vanishing.
 */
export const summariseSections = (lines: readonly string[], idPrefix: string): SummaryCounts[] => {
  const row = rowPattern(idPrefix);
  const out: SummaryCounts[] = [];
  let current: SummaryCounts | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const heading = line.match(SECTION_HEADING_RE);
    if (heading) {
      current = emptyCounts((heading[1] as string).trim());
      continue;
    }
    if (current === null || !HEADER_RE.test(line)) continue;
    let j = SEP_RE.test(lines[i + 1] as string) ? i + 2 : i + 1;
    for (; row.test(lines[j] as string); j++) {
      const cells = (lines[j] as string).match(ROW_CELLS_RE);
      if (!cells) continue;
      current.rules += 1;
      if ((cells[3] as string).trim().toLowerCase() === 'critical') current.critical += 1;
      const enforcement = (cells[4] as string).trim().toLowerCase();
      if (enforcement === 'validator' || enforcement === 'eslint-rule') current.enforced += 1;
      if (enforcement === 'guidance') current.guidance += 1;
    }
    out.push(current);
    current = null;
    i = j - 1;
  }
  return out;
};

/** The Total row: the column-wise sum of every section line. */
export const totalCounts = (counts: readonly SummaryCounts[]): SummaryCounts =>
  counts.reduce<SummaryCounts>(
    (acc, c) => ({
      category: TOTAL_LABEL,
      rules: acc.rules + c.rules,
      critical: acc.critical + c.critical,
      enforced: acc.enforced + c.enforced,
      guidance: acc.guidance + c.guidance,
    }),
    emptyCounts(TOTAL_LABEL),
  );

const summaryLine = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

/** The Summary body: one line per section, then a bolded Total. */
export const renderSummaryRows = (counts: readonly SummaryCounts[]): string[] => {
  const rows = counts.map((c) => summaryLine([c.category, String(c.rules), String(c.critical), String(c.enforced), String(c.guidance)]));
  const total = totalCounts(counts);
  rows.push(summaryLine([`**${TOTAL_LABEL}**`, `**${total.rules}**`, `**${total.critical}**`, `**${total.enforced}**`, `**${total.guidance}**`]));
  return rows;
};

const parseSummaryCell = (cell: string): string => cell.replace(/\*/g, '').trim();

/**
 * The Summary block as it is WRITTEN, so a drift check can compare it against
 * what the section tables say; null when the block is absent (a missing
 * Summary is a different failure from a wrong one).
 */
export const parseSummaryBlock = (lines: readonly string[]): SummaryCounts[] | null => {
  const headerIndex = lines.findIndex((line) => SUMMARY_HEADER_RE.test(line));
  if (headerIndex === -1) return null;
  let i = SEP_RE.test(lines[headerIndex + 1] as string) ? headerIndex + 2 : headerIndex + 1;
  const rows: SummaryCounts[] = [];
  for (; ANY_ROW_RE.test(lines[i] as string); i++) {
    const cells = (lines[i] as string).split('|').slice(1, -1).map(parseSummaryCell);
    if (cells.length < 5) continue;
    rows.push({ category: cells[0] as string, rules: Number(cells[1]), critical: Number(cells[2]), enforced: Number(cells[3]), guidance: Number(cells[4]) });
  }
  return rows;
};

/**
 * One disagreement between the written Summary and the section tables.
 * `duplicate` is its own column because it is not a wrong NUMBER: it is a
 * Summary that states two things about one category.
 */
export interface SummaryDrift {
  category: string;
  /** `header`: the block still carries the retired Agent-Review header. */
  column: 'header' | 'presence' | 'duplicate' | 'rules' | 'critical' | 'enforced' | 'guidance';
  written: number | null;
  derived: number | null;
}

/**
 * Recompute the Summary from the section tables and report every
 * disagreement: adding, retiring or re-tiering a rule changes a section row,
 * which changes a derived tally, which fails here until the Summary is
 * regenerated.
 */
export const checkSummaryDrift = (indexText: string, idPrefix: string): { ok: boolean; derived: SummaryCounts[]; written: SummaryCounts[] | null; drift: SummaryDrift[] } => {
  const lines = indexText.split('\n');
  const sections = summariseSections(lines, idPrefix);
  const total = totalCounts(sections);
  const derived = [...sections, total];
  const written = parseSummaryBlock(lines);

  // A legacy header is drift in its own right: its third and fourth columns
  // mean different things, so its numbers are never compared cell by cell.
  if (lines.some((line) => LEGACY_SUMMARY_HEADER_RE.test(line))) {
    return { ok: false, derived, written, drift: [{ category: TOTAL_LABEL, column: 'header', written: null, derived: null }] };
  }
  if (written === null) {
    return { ok: false, derived, written, drift: [{ category: TOTAL_LABEL, column: 'presence', written: null, derived: total.rules }] };
  }

  const drift: SummaryDrift[] = [];
  // Built by hand rather than with `new Map(written.map(...))`: that keeps the
  // LAST row for a repeated category and throws the earlier one away, so a
  // stale row above a correct one was never compared. A repeat is drift in its
  // own right, and the FIRST row stays in the map and is still cell-checked.
  const writtenByCategory = new Map<string, SummaryCounts>();
  for (const row of written) {
    if (writtenByCategory.has(row.category)) {
      drift.push({ category: row.category, column: 'duplicate', written: row.rules, derived: null });
      continue;
    }
    writtenByCategory.set(row.category, row);
  }
  for (const expected of derived) {
    const actual = writtenByCategory.get(expected.category);
    if (actual === undefined) {
      drift.push({ category: expected.category, column: 'presence', written: null, derived: expected.rules });
      continue;
    }
    writtenByCategory.delete(expected.category);
    for (const column of ['rules', 'critical', 'enforced', 'guidance'] as const) {
      if (actual[column] !== expected[column]) drift.push({ category: expected.category, column, written: actual[column], derived: expected[column] });
    }
  }
  // Anything left over is a Summary line for a section that no longer exists.
  for (const orphan of writtenByCategory.values()) drift.push({ category: orphan.category, column: 'presence', written: orphan.rules, derived: null });

  return { ok: drift.length === 0, derived, written, drift };
};

/** The heading the Summary block lives under, when one has to be created. */
const SUMMARY_HEADING = '## Summary';
const SUMMARY_HEADING_RE = /^##\s+Summary\s*$/i;
/** The header and separator emitted when the block has to be created. */
const SUMMARY_TABLE_HEADER = '| Category | Rules | Critical | Enforced | Guidance |';
const SUMMARY_TABLE_SEP = '| -------- | ----- | -------- | -------- | -------- |';

/**
 * Create the Summary block in a document that has none, so `--check-index`'s
 * "recompute it with --regenerate-index" is advice that works: under an
 * existing `## Summary` heading when there is one, in a new trailing section
 * otherwise.
 */
const insertSummaryBlock = (lines: readonly string[], counts: readonly SummaryCounts[]): string[] => {
  const block = [SUMMARY_TABLE_HEADER, SUMMARY_TABLE_SEP, ...renderSummaryRows(counts)];
  const headingIndex = lines.findIndex((line) => SUMMARY_HEADING_RE.test(line));
  if (headingIndex === -1) {
    const head = [...lines];
    while (head.length > 0 && (head[head.length - 1] as string).trim() === '') head.pop();
    return [...head, '', SUMMARY_HEADING, '', ...block, ''];
  }
  const rest = lines.slice(headingIndex + 1);
  let start = 0;
  while (start < rest.length && (rest[start] as string).trim() === '') start += 1;
  return [...lines.slice(0, headingIndex + 1), '', ...block, '', ...rest.slice(start)];
};

/** Rewrite the Summary block's body in place, everything else untouched; create the block when there is none. */
const rewriteSummaryBlock = (lines: readonly string[], idPrefix: string): string[] => {
  const counts = summariseSections(lines, idPrefix);
  const out: string[] = [];
  let rewrote = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!SUMMARY_HEADER_RE.test(line) && !LEGACY_SUMMARY_HEADER_RE.test(line)) {
      out.push(line);
      continue;
    }
    // Emit the current header and separator, whatever the file carried.
    out.push(SUMMARY_TABLE_HEADER, SUMMARY_TABLE_SEP, ...renderSummaryRows(counts));
    rewrote = true;
    // Skip the old separator and body: the separator is a table row too.
    let j = i + 1;
    while (ANY_ROW_RE.test(lines[j] as string)) j += 1;
    i = j - 1;
  }
  return rewrote ? out : insertSummaryBlock(out, counts);
};

/**
 * Rewrite the index's table ROWS from the rules and recompute its `(N rules)`
 * counts and Summary; all prose is kept. A section's category is its heading
 * when the heading names a rule folder, else the folder most of its rows link
 * into. A row no rule matches is kept verbatim; a rule no section takes is
 * reported in `unplaced`.
 */
export const regenerateIndex = (indexText: string, rules: readonly Rule[], config: BpRulesConfig): { text: string; placed: string[]; unplaced: string[] } => {
  const row = rowPattern(config.idPrefix);
  const rowId = new RegExp(`^\\|\\s*(${escapeRegex(config.idPrefix)}-[A-Z]+-\\d+)\\s*\\|`);
  const indexDir = posix.dirname(config.index);
  const linkCategory = new RegExp(`\\]\\(${escapeRegex(relativeLink(indexDir, config.rules))}/([^/]+)/`);
  const dirCategory = new RegExp(`^${escapeRegex(config.rules)}/([^/]+)/`);

  // Group by the rule file's FOLDER under `rules`, which is how the index
  // sections are organized (by link path), not by frontmatter category, which
  // can differ (a discount rule filed under mobile/).
  const pathCategory = (r: Rule): string => r.path.match(dirCategory)?.[1] ?? r.category;
  const byCategory = new Map<string, Rule[]>();
  for (const r of rules) {
    const key = pathCategory(r);
    if (!byCategory.has(key)) byCategory.set(key, []);
    (byCategory.get(key) as Rule[]).push(r);
  }
  for (const list of byCategory.values()) list.sort((a, b) => a.id.localeCompare(b.id));

  const lines = indexText.split('\n');
  const out: string[] = [];
  const placed = new Set<string>();
  // The section HEADING is the authoritative signal for which category a
  // table belongs to: a section's lead row may link into another folder (a
  // rule filed elsewhere for historical reasons), and taking its folder
  // regenerated every rule of that folder into the wrong section.
  const headingCategory = (heading: string): string =>
    heading
      .replace(/\s*\(\d+ rules?\)\s*$/, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  let sectionCategory: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const headingMatch = line.match(/^#{2,3}\s+(.+)$/);
    if (headingMatch) {
      const candidate = headingCategory(headingMatch[1] as string);
      sectionCategory = byCategory.has(candidate) ? candidate : null;
    }
    if (HEADER_RE.test(line)) {
      const sepLine = SEP_RE.test(lines[i + 1] as string) ? (lines[i + 1] as string) : null;
      let j = sepLine ? i + 2 : i + 1;
      // Without a known heading, the section's category is the one MOST of its
      // rows link to, not the first row's.
      const categoryVotes = new Map<string, number>();
      const start = j;
      while (row.test(lines[j] as string)) {
        const m = (lines[j] as string).match(linkCategory);
        if (m) categoryVotes.set(m[1] as string, (categoryVotes.get(m[1] as string) ?? 0) + 1);
        j++;
      }
      let category: string | null = sectionCategory;
      if (!category) {
        let bestVotes = 0;
        for (const [cat, votes] of categoryVotes) {
          if (votes > bestVotes) {
            category = cat;
            bestVotes = votes;
          }
        }
      }
      if (category && byCategory.has(category)) {
        out.push(line);
        if (sepLine) out.push(sepLine);
        const catList = byCategory.get(category) as Rule[];
        const catRules = new Map(catList.map((r) => [r.id, r]));
        const seen = new Set<string>();
        // Update existing rows in place (order kept); keep any unrecognized row
        // verbatim so a moved or removed rule is never silently dropped.
        for (let k = start; k < j; k++) {
          const id = (lines[k] as string).match(rowId)?.[1];
          if (id && catRules.has(id)) {
            out.push(indexRow(catRules.get(id) as Rule, indexDir));
            seen.add(id);
            placed.add(id);
          } else {
            out.push(lines[k] as string);
          }
        }
        // Append rules new to this section, sorted by id.
        for (const r of catList) {
          if (!seen.has(r.id)) {
            out.push(indexRow(r, indexDir));
            seen.add(r.id);
            placed.add(r.id);
          }
        }
        i = j; // skip the old rows
        continue;
      }
      // Unknown or empty table: leave it byte-identical.
      for (let k = i; k < start; k++) out.push(lines[k] as string);
      i = start;
      continue;
    }
    out.push(line);
    i++;
  }

  // Second pass: fix "(N rules)" counts to match the regenerated row blocks.
  const finalLines: string[] = [];
  for (let k = 0; k < out.length; k++) {
    const headingMatch = (out[k] as string).match(/^(##\s+.+?\s+)\((\d+)\s+rules?\)(\s*)$/);
    if (headingMatch) {
      // The next table header or heading, whichever comes first; only a table
      // header has rows to count. Not found is -1, and `rest[-1]` is
      // undefined, which no pattern matches.
      let count = 0;
      const rest = out.slice(k + 1);
      const m = rest.findIndex((l) => HEADER_RE.test(l) || /^##\s/.test(l));
      if (HEADER_RE.test(rest[m] as string)) {
        let n = SEP_RE.test(rest[m + 1] as string) ? m + 2 : m + 1;
        while (row.test(rest[n] as string)) {
          count++;
          n++;
        }
      }
      const noun = count === 1 ? 'rule' : 'rules';
      finalLines.push(`${headingMatch[1] as string}(${count} ${noun})${headingMatch[3] as string}`);
      continue;
    }
    finalLines.push(out[k] as string);
  }

  // Third pass: the Summary block is DERIVED from the rows the passes above
  // settled. Runs last so it reads the regenerated rows, not the input's.
  const withSummary = rewriteSummaryBlock(finalLines, config.idPrefix);
  const unplaced = rules
    .filter((r) => !placed.has(r.id))
    .map((r) => r.id)
    .sort();
  return { text: withSummary.join('\n'), placed: [...placed].sort(), unplaced };
};

// ── the command line ────────────────────────────────────────────────────────

/** What a run reads: the repository and the clock. */
export interface BpIo {
  /** The repository root; the corpus and the index are read under it. */
  readonly root: string;
  readonly reader: CorpusReader;
  exists(path: string): boolean;
  now(): Date;
}

/** What a run prints, each stream's text written as is, and the exit status it ends with. */
export interface BpResult {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export const BP_RULES_USAGE =
  'usage: pariksha bp-rules (--inventory | --gaps | --due [--within <0..3650>] [--today <YYYY-MM-DD>] | --next-id <PREFIX> | --corpus-fingerprint | --check-wiring [--ids <a,b>] | --regenerate-index | --check-index) [--config <file>] [--root <dir>]';

/** Every mode, in the order a usage error names them. */
const MODES = ['--inventory', '--gaps', '--due', '--next-id', '--corpus-fingerprint', '--check-wiring', '--regenerate-index', '--check-index'] as const;
type Mode = (typeof MODES)[number];

const P = 'pariksha bp-rules:';

const usageError = (message: string): BpResult => ({ code: 2, stdout: '', stderr: `${P} ${message}\n${BP_RULES_USAGE}\n` });

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const ok = (stdout: string): BpResult => ({ code: 0, stdout, stderr: '' });

/** `--within`: a plain decimal integer from 0 to 3650, or null. */
const parseWithin = (raw: string): number | null => {
  if (!/^[+-]?\d+$/.test(raw)) return null;
  // `-0` reads as 0.
  const value = Number(raw) + 0;
  return value >= 0 && value <= 3650 ? value : null;
};

/** One mode over the config's corpus and index; a failed read throws. */
const runMode = (mode: Mode, f: ReadonlyMap<string, string>, config: BpRulesConfig, io: BpIo, today: Date | undefined, within: number | undefined): BpResult => {
  const rulesDir = join(io.root, config.rules);
  const rules = (): Rule[] => loadRules(rulesDir, io.root, io.reader);
  switch (mode) {
    case '--inventory':
      return ok(json(inventory(rules())));
    case '--gaps':
      return ok(json(gaps(rules())));
    case '--due':
      return ok(json(due(rules(), today ?? io.now(), within)));
    case '--next-id':
      return ok(json(nextId(rules(), f.get('--next-id') as string, config.idPrefix)));
    case '--corpus-fingerprint':
      return ok(json({ corpusFingerprint: corpusFingerprint(rulesDir, io.reader) }));
    case '--check-wiring': {
      const ids = f
        .get('--ids')
        ?.split(',')
        .map((id) => id.trim())
        .filter((id) => id !== '');
      const result = checkWiring(rules(), (rel) => io.exists(join(io.root, rel)), ids);
      return { code: result.ok ? 0 : 1, stdout: json(result), stderr: '' };
    }
    default:
      break;
  }
  const index = io.reader.read(join(io.root, config.index)).toString('utf-8');
  if (mode === '--regenerate-index') {
    const { text, unplaced } = regenerateIndex(index, rules(), config);
    if (unplaced.length === 0) return ok(text);
    return { code: 1, stdout: text, stderr: `\n⚠️  Rules with no matching index section (add manually): ${unplaced.join(', ')}\n` };
  }
  const result = checkSummaryDrift(index, config.idPrefix);
  if (result.ok) return ok(json(result));
  const name = basename(config.index);
  return {
    code: 1,
    stdout: json(result),
    stderr: `\n❌ ${name} Summary is stale (${result.drift.length.toString()} mismatch(es)). Recompute it: mkdir -p .tmp && pariksha bp-rules --regenerate-index > .tmp/${name} && mv .tmp/${name} ${config.index}\n`,
  };
};

/**
 * bp-rules: exactly one mode per run. Every mode prints JSON except
 * --regenerate-index, which prints the rewritten index. Exit 0 clean; 1 a
 * check failed (--check-wiring, --check-index) or --regenerate-index left
 * rules unplaced; 2 a usage error, a bad config, or a read that failed, since
 * then nothing was checked.
 *
 * `f` is the flags pariksha's `flags()` split: a mode is a key, `--within`,
 * `--today`, `--next-id` and `--ids` carry their values. `settings` is the
 * config text (`checks.bp-rules`).
 */
export const bpRules = (f: ReadonlyMap<string, string>, settings: string, io: BpIo): BpResult => {
  const rawWithin = f.get('--within');
  const within = rawWithin === undefined ? undefined : parseWithin(rawWithin);
  if (within === null) return usageError('--within must be an integer from 0 to 3650');
  const modes = MODES.filter((m) => f.has(m));
  if (modes.length !== 1) return usageError(`give exactly one mode, got ${modes.length === 0 ? 'none' : modes.join(' ')}`);
  const mode = modes[0] as Mode;
  if (mode !== '--due' && rawWithin !== undefined) return usageError('--within applies to --due only');
  const rawToday = f.get('--today');
  if (mode !== '--due' && rawToday !== undefined) return usageError('--today applies to --due only');
  if (mode !== '--check-wiring' && f.has('--ids')) return usageError('--ids applies to --check-wiring only');
  const today = rawToday === undefined ? undefined : parseIsoDate(rawToday);
  if (today === null) return usageError(`--today must be a real YYYY-MM-DD date, got "${rawToday as string}"`);
  try {
    return runMode(mode, f, parseBpRulesConfig(settings), io, today, within);
  } catch (e) {
    // fail-open: the reason is reported and the run exits 2, never 0: a bad config or a failed read checked nothing.
    return { code: 2, stdout: '', stderr: `${P} ${(e as Error).message}; nothing was checked, so this is not a pass\n` };
  }
};
