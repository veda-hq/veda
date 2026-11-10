/**
 * Round trip for the doc-references baseline: what serializeBaseline writes,
 * parseBaseline reads back as the same baseline, and the text is canonical:
 * the same baseline in any key order writes the same bytes, and a second
 * round trip changes nothing. Zero counts and files left with none are
 * dropped on write, as the gate relies on. Real producer output through the
 * real consumer, from a fixed-seed generator.
 *
 * Out of model: a file named `__proto__` (an assignment on a plain object,
 * not an own key; no tracked path has that name).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHECK_IDS, parseBaseline, serializeBaseline, type Baseline, type CheckId } from './doc-references.ts';

const SEED = 20_089;
const RUNS = 200;

/** mulberry32: a small seeded PRNG, uniform on [0, 1). */
const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** One of `items`, drawn by `next`. */
const pick = <T>(items: readonly T[], next: () => number): T => items[Math.floor(next() * items.length)] as T;

/** A whole number in [min, max], drawn by `next`. */
const between = (min: number, max: number, next: () => number): number => min + Math.floor(next() * (max - min + 1));

const SEGMENT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-'.split('');
/** Fixed segments: integer-like names JSON orders first, non-ASCII and blanks. */
const FIXED_SEGMENTS = ['docs', 'README.md', '10', '9', 'ü é', 'a b.md'];

/** What a draw used, so a test can show every kind is drawn. */
type Drawn = Set<string>;

/** A repo-relative path of one to three segments. */
const file = (next: () => number, drawn: Drawn): string => {
  for (;;) {
    const segments = Array.from({ length: between(1, 3, next) }, () => {
      if (next() < 0.5) {
        drawn.add('segment:random');
        return Array.from({ length: between(1, 8, next) }, () => pick(SEGMENT_CHARS, next)).join('');
      }
      const fixed = pick(FIXED_SEGMENTS, next);
      drawn.add(`segment:${fixed}`);
      return fixed;
    });
    drawn.add(`depth:${segments.length}`);
    const path = segments.join('/');
    if (path !== '__proto__') return path;
  }
};

/** A positive count: small, or anywhere up to the largest safe integer. */
const count = (next: () => number, drawn: Drawn): number => {
  if (next() < 0.5) {
    drawn.add('count:small');
    return between(1, 9, next);
  }
  drawn.add('count:large');
  return Math.max(1, Math.floor(next() * Number.MAX_SAFE_INTEGER));
};

/** Counts for a non-empty subset of the checks. */
const counts = (next: () => number, drawn: Drawn): Partial<Record<CheckId, number>> => {
  for (;;) {
    const entry: Partial<Record<CheckId, number>> = {};
    for (const check of CHECK_IDS) if (next() < 0.5) entry[check] = count(next, drawn);
    const size = Object.keys(entry).length;
    if (size > 0) {
      drawn.add(`checks:${size}`);
      return entry;
    }
  }
};

/** A valid baseline of up to eight files, each with at least one positive count. */
const baseline = (next: () => number, drawn: Drawn): Baseline => {
  const files: Record<string, Partial<Record<CheckId, number>>> = {};
  const size = between(0, 8, next);
  drawn.add(`files:${size === 0 ? 'none' : 'some'}`);
  for (let i = 0; i < size; i += 1) files[file(next, drawn)] = counts(next, drawn);
  return { version: 1, files };
};

interface Case {
  readonly value: Baseline;
  /** A shuffle order for the reordering test. */
  readonly order: readonly number[];
  /** A file and a check to pad with a zero count. */
  readonly pad: { readonly name: string; readonly check: CheckId };
}

/** `RUNS` cases from the fixed seed, and the kinds drawn. */
const sample = (): { cases: Case[]; drawn: Drawn } => {
  const next = random(SEED);
  const drawn: Drawn = new Set();
  const cases = Array.from({ length: RUNS }, (): Case => {
    const value = baseline(next, drawn);
    const order = Array.from({ length: between(1, 10, next) }, () => between(-1000, 1000, next));
    // Half the pads land on a file the baseline already has.
    const names = Object.keys(value.files);
    const reuse = names.length > 0 && next() < 0.5;
    drawn.add(`pad:${reuse ? 'existing' : 'new'}`);
    const name = reuse ? pick(names, next) : file(next, drawn);
    const check = pick(CHECK_IDS, next);
    drawn.add(`pad:${check}`);
    return { value, order, pad: { name, check } };
  });
  return { cases, drawn };
};

const { cases, drawn } = sample();

/** A baseline as plain objects, for a deep comparison (parseBaseline builds a prototype-free map). */
const plain = (value: Baseline): unknown => ({ version: value.version, files: Object.fromEntries(Object.entries(value.files).map(([name, entry]) => [name, { ...entry }])) });

/** The same baseline with files and checks inserted in a shuffled order. */
const reordered = (value: Baseline, order: readonly number[]): Baseline => {
  const shuffled = Object.entries(value.files)
    .map((entry, index) => ({ entry, key: order[index % order.length] ?? 0 }))
    .sort((a, b) => a.key - b.key)
    .map(({ entry: [name, entry] }) => {
      const out: Partial<Record<CheckId, number>> = {};
      for (const check of [...CHECK_IDS].reverse()) {
        const n = entry[check];
        if (n !== undefined) out[check] = n;
      }
      return [name, out] as const;
    });
  return { version: 1, files: Object.fromEntries(shuffled) };
};

describe('doc-references serializeBaseline → parseBaseline', () => {
  it('draws every case kind, the same sample on every run', () => {
    const kinds = [
      'segment:random',
      ...FIXED_SEGMENTS.map((s) => `segment:${s}`),
      'depth:1',
      'depth:2',
      'depth:3',
      'count:small',
      'count:large',
      'checks:1',
      'checks:2',
      'checks:3',
      'files:none',
      'files:some',
      'pad:existing',
      'pad:new',
      ...CHECK_IDS.map((c) => `pad:${c}`),
    ];
    assert.deepEqual(
      kinds.filter((kind) => !drawn.has(kind)),
      [],
    );
    assert.deepEqual([...drawn].sort(), [...kinds].sort());
    assert.deepEqual(sample(), { cases, drawn });
  });

  it('a written baseline reads back unchanged', () => {
    for (const { value } of cases) {
      assert.deepEqual(plain(parseBaseline(serializeBaseline(value), 'baseline.json')), plain(value), JSON.stringify(value));
    }
  });

  it('the text is canonical: key order does not matter, and it is stable', () => {
    for (const { value, order } of cases) {
      const text = serializeBaseline(value);
      assert.equal(serializeBaseline(reordered(value, order)), text, JSON.stringify(value));
      assert.equal(serializeBaseline(parseBaseline(text, 'baseline.json')), text);
      assert.ok(text.endsWith('}\n'));
    }
  });

  it('zero counts and emptied files are dropped on write', () => {
    for (const { value, pad } of cases) {
      const padded: Baseline = { version: 1, files: { ...value.files, [pad.name]: { ...value.files[pad.name], [pad.check]: 0 } } };
      const files = Object.entries(padded.files)
        .map(([path, entry]) => [path, Object.fromEntries(Object.entries(entry).filter(([, n]) => n !== 0))] as const)
        .filter(([, entry]) => Object.keys(entry).length > 0);
      assert.deepEqual(plain(parseBaseline(serializeBaseline(padded), 'baseline.json')), { version: 1, files: Object.fromEntries(files) }, JSON.stringify(padded));
    }
  });
});
