// Ported from semver 7.8.1 (npm `semver`, https://github.com/npm/node-semver,
// ISC licence): `classes/range.js` (Range, parseComparator, replaceCarets,
// replaceTildes, replaceXRanges, replaceStars, replaceGTE0, hyphenReplace,
// testSet), with the parts of `classes/comparator.js`, `classes/semver.js`,
// `internal/re.js`, `internal/identifiers.js` and `internal/constants.js` it
// uses. 7.8.1 is the version the replaced check ran on; later releases changed
// tilde and caret lower bounds under includePrerelease, so this is not to be
// "updated" to them without the check's owner. Its licence:
//
// The ISC License
//
// Copyright (c) Isaac Z. Schlueter and Contributors
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
// IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
//
// A semver range matcher: the part of the `semver` package (strict mode)
// that pnpm-settings needs, `satisfies` with `includePrerelease: true`,
// `validRange` and `valid`, ported step for step so it reads every range the
// way `semver` does.
//
// A range is comparator sets joined by `||` (any set matches), each set
// comparators joined by spaces (every one matches). Before testing, `semver`
// rewrites the sugar into plain comparators, and so does this: hyphen ranges
// (`1.2.3 - 2.3`), carets (`^1.2.3`), tildes (`~1.2.3`, `~>1.2`), partial and
// x-range versions (`1`, `1.2`, `1.x`, `<8`, `>=0.9`), and stars (`*`).
// Build metadata is ignored. With includePrerelease a prerelease is just a
// version that sorts before its release, so `7.5.20-beta.1` is inside
// `<=7.5.20`, and a partial lower bound starts at `-0` (`>=1.2` is
// `>=1.2.0-0`).
//
// Not read: `semver`'s loose mode, which pnpm-settings never asks for.

/** semver's MAX_LENGTH: a longer version string is not one. */
const MAX_LENGTH = 256;
const MAX_SAFE_BUILD_LENGTH = MAX_LENGTH - 6;
const LETTER_DASH_NUMBER = '[a-zA-Z0-9-]';

/** semver's makeSafeRegex: bounds its greedy repeats, which changes what a long input matches. */
const bounded = (source: string): string => {
  let out = source;
  for (const [token, max] of [['\\s', 1], ['\\d', MAX_LENGTH], [LETTER_DASH_NUMBER, MAX_SAFE_BUILD_LENGTH]] as const) {
    out = out.split(`${token}*`).join(`${token}{0,${max}}`).split(`${token}+`).join(`${token}{1,${max}}`);
  }
  return out;
};
const re = (source: string, flags?: string): RegExp => new RegExp(bounded(source), flags);

const NUMERIC = '0|[1-9]\\d*';
const NUMERIC_LOOSE = '\\d+';
const NON_NUMERIC = `\\d*[a-zA-Z-]${LETTER_DASH_NUMBER}*`;
const MAIN = `(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})`;
const MAIN_LOOSE = `(${NUMERIC_LOOSE})\\.(${NUMERIC_LOOSE})\\.(${NUMERIC_LOOSE})`;
const PRERELEASE_ID = `(?:${NON_NUMERIC}|${NUMERIC})`;
const PRERELEASE_ID_LOOSE = `(?:${NON_NUMERIC}|${NUMERIC_LOOSE})`;
const PRERELEASE = `(?:-(${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*))`;
const PRERELEASE_LOOSE = `(?:-?(${PRERELEASE_ID_LOOSE}(?:\\.${PRERELEASE_ID_LOOSE})*))`;
const BUILD_ID = `${LETTER_DASH_NUMBER}+`;
const BUILD = `(?:\\+(${BUILD_ID}(?:\\.${BUILD_ID})*))`;
const FULL_PLAIN = `v?${MAIN}${PRERELEASE}?${BUILD}?`;
const LOOSE_PLAIN = `[v=\\s]*${MAIN_LOOSE}${PRERELEASE_LOOSE}?${BUILD}?`;
const GTLT = '((?:<|>)?=?)';
const X_ID = `${NUMERIC}|x|X|\\*`;
const X_PLAIN = `[v=\\s]*(${X_ID})(?:\\.(${X_ID})(?:\\.(${X_ID})(?:${PRERELEASE})?${BUILD}?)?)?`;

/** A version, as `new SemVer` reads one (after trimming). */
const FULL = re(`^${FULL_PLAIN}$`);
/** Build metadata anywhere in a set: `semver` strips it, with the unbounded pattern, before anything else. */
const BUILD_STRIP = new RegExp(BUILD, 'g');
const BUILD_ONE = re(BUILD);
const HYPHEN_RANGE = re(`^\\s*(${X_PLAIN})\\s+-\\s+(${X_PLAIN})\\s*$`);
/** `> 1.2.3` is `>1.2.3`. */
const COMPARATOR_TRIM = re(`(\\s*)${GTLT}\\s*(${LOOSE_PLAIN}|${X_PLAIN})`, 'g');
const TILDE_TRIM = re('(\\s*)(?:~>?)\\s+', 'g');
const CARET_TRIM = re('(\\s*)(?:\\^)\\s+', 'g');
const TILDE = re(`^(?:~>?)${X_PLAIN}$`);
const CARET = re(`^(?:\\^)${X_PLAIN}$`);
const X_RANGE = re(`^${GTLT}\\s*${X_PLAIN}$`);
const STAR = re('(<|>)?=?\\s*\\*');
/** `>=0.0.0-0` is every version, so `semver` drops it. */
const GTE0_PRERELEASE = re('^\\s*>=\\s*0\\.0\\.0-0\\s*$');
const COMPARATOR = re(`^${GTLT}\\s*(${FULL_PLAIN})$|^$`);

export interface Version {
  readonly main: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

type Operator = '' | '<' | '<=' | '>' | '>=';

/** A plain comparator; no version is semver's ANY, which every version passes. */
export interface Comparator {
  readonly operator: Operator;
  readonly version?: Version;
}

/** A full version, or undefined; trimmed first, as `semver` does. */
export const parseVersion = (text: unknown): Version | undefined => {
  if (typeof text !== 'string' || text.length > MAX_LENGTH) return undefined;
  const m = FULL.exec(text.trim());
  if (m === null) return undefined;
  const main = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  if (main.some((n) => n > Number.MAX_SAFE_INTEGER)) return undefined;
  return { main, prerelease: m[4] === undefined ? [] : m[4].split('.') };
};

/** `semver.valid`: whether `text` is a full version. */
export const validVersion = (text: unknown): boolean => parseVersion(text) !== undefined;

const NUMERIC_ID = /^[0-9]+$/;

/** semver's compareIdentifiers: numbers numerically and before words, words in ASCII order. */
export const compareIdentifiers = (a: string, b: string): number => {
  const aNum = NUMERIC_ID.test(a);
  const bNum = NUMERIC_ID.test(b);
  if (aNum && bNum) {
    const [x, y] = [Number(a), Number(b)];
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (a === b) return 0;
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : 1;
};

/** Semver precedence; build metadata plays no part. */
export const compareVersions = (a: Version, b: Version): number => {
  for (let i = 0; i < 3; i++) {
    const c = compareIdentifiers(String(a.main[i]), String(b.main[i]));
    if (c !== 0) return c;
  }
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  for (let i = 0; ; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined && y === undefined) return 0;
    if (y === undefined) return 1;
    if (x === undefined) return -1;
    if (x !== y) return compareIdentifiers(x, y);
  }
};

type Group = string | undefined;

/** semver's isX: a missing part, `x`, `X` or `*`. */
const isX = (id: Group): boolean => id === undefined || id.toLowerCase() === 'x' || id === '*';
const next = (id: Group | number): number => Number(id) + 1;

/** `1.2 - 3.4` is `>=1.2.0-0 <3.5.0-0`; a full upper bound `3.4.5` is `<3.4.6-0`. */
const hyphenReplace = (...g: Group[]): string => {
  const [, fromText, fM, fm, fp, fpr, , toText, tM, tm, tp, tpr] = g;
  let from: string;
  if (isX(fM)) from = '';
  else if (isX(fm)) from = `>=${fM}.0.0-0`;
  else if (isX(fp)) from = `>=${fM}.${fm}.0-0`;
  else if (fpr) from = `>=${fromText}`;
  else from = `>=${fromText}-0`;
  let to: string;
  if (isX(tM)) to = '';
  else if (isX(tm)) to = `<${next(tM)}.0.0-0`;
  else if (isX(tp)) to = `<${tM}.${next(tm)}.0-0`;
  else if (tpr) to = `<=${tM}.${tm}.${tp}-${tpr}`;
  else to = `<${tM}.${tm}.${next(tp)}-0`;
  return `${from} ${to}`.trim();
};

/** `^1.2.3` is `>=1.2.3-0 <2.0.0-0`; `^0.1.2` stops at `0.2.0-0`, `^0.0.1` at `0.0.2-0`. */
const replaceCaret = (comp: string): string =>
  comp.replace(CARET, (...g: Group[]) => {
    const [, M, m, p, pr] = g;
    if (isX(M)) return '';
    if (isX(m)) return `>=${M}.0.0-0 <${next(M)}.0.0-0`;
    if (isX(p)) return M === '0' ? `>=${M}.${m}.0-0 <${M}.${next(m)}.0-0` : `>=${M}.${m}.0-0 <${next(M)}.0.0-0`;
    if (pr) {
      if (M === '0') return m === '0' ? `>=${M}.${m}.${p}-${pr} <${M}.${m}.${next(p)}-0` : `>=${M}.${m}.${p}-${pr} <${M}.${next(m)}.0-0`;
      return `>=${M}.${m}.${p}-${pr} <${next(M)}.0.0-0`;
    }
    if (M === '0') return m === '0' ? `>=${M}.${m}.${p}-0 <${M}.${m}.${next(p)}-0` : `>=${M}.${m}.${p}-0 <${M}.${next(m)}.0-0`;
    return `>=${M}.${m}.${p} <${next(M)}.0.0-0`;
  });

/** `~1.2.3` is `>=1.2.3 <1.3.0-0`; `~1` is `>=1.0.0 <2.0.0-0`. No `-0` on the lower bound, as in `semver`. */
const replaceTilde = (comp: string): string =>
  comp.replace(TILDE, (...g: Group[]) => {
    const [, M, m, p, pr] = g;
    if (isX(M)) return '';
    if (isX(m)) return `>=${M}.0.0 <${next(M)}.0.0-0`;
    if (isX(p)) return `>=${M}.${m}.0 <${M}.${next(m)}.0-0`;
    if (pr) return `>=${M}.${m}.${p}-${pr} <${M}.${next(m)}.0-0`;
    return `>=${M}.${m}.${p} <${M}.${next(m)}.0-0`;
  });

/** `<8` is `<8.0.0-0`, `>1.2` is `>=1.3.0-0`, `1.2` is `>=1.2.0-0 <1.3.0-0`, `>*` is nothing. */
const replaceXRange = (comp: string): string =>
  comp.trim().replace(X_RANGE, (whole: string, gtltText: string, MText: Group, mText: Group, pText: Group) => {
    let gtlt = gtltText;
    let [M, m, p]: (Group | number)[] = [MText, mText, pText];
    const xM = isX(MText);
    const xm = xM || isX(mText);
    const xp = xm || isX(pText);
    if (gtlt === '=' && xp) gtlt = '';
    // includePrerelease: every bound starts at the lowest prerelease.
    const pr = '-0';
    if (xM) return gtlt === '>' || gtlt === '<' ? '<0.0.0-0' : '*';
    if (gtlt && xp) {
      if (xm) m = 0;
      p = 0;
      if (gtlt === '>') {
        gtlt = '>=';
        if (xm) {
          M = next(M);
          m = 0;
        } else m = next(m);
        p = 0;
      } else if (gtlt === '<=') {
        gtlt = '<';
        if (xm) M = next(M);
        else m = next(m);
      }
      return `${gtlt}${M}.${m}.${p}${pr}`;
    }
    if (xm) return `>=${M}.0.0${pr} <${next(M)}.0.0-0`;
    if (xp) return `>=${M}.${m}.0${pr} <${M}.${next(m)}.0-0`;
    return whole;
  });

/** semver's parseComparator: one space-free piece of a set to plain comparators. */
const desugar = (piece: string): string => {
  let comp = piece.replace(BUILD_ONE, '');
  comp = comp.trim().split(/\s+/).map(replaceCaret).join(' ');
  comp = comp.trim().split(/\s+/).map(replaceTilde).join(' ');
  comp = comp.split(/\s+/).map(replaceXRange).join(' ');
  return comp.trim().replace(STAR, '');
};

/** semver's Comparator constructor, or undefined where it throws. */
const comparator = (text: string): Comparator | undefined => {
  const m = COMPARATOR.exec(text.trim().split(/\s+/).join(' '));
  if (m === null) return undefined;
  const operator = (m[1] === undefined || m[1] === '=' ? '' : m[1]) as Operator;
  if (!m[2]) return { operator };
  const version = parseVersion(m[2]);
  return version === undefined ? undefined : { operator, version };
};

/** One `||` part as plain comparators, or undefined where `semver` throws. */
const parseSet = (part: string): Comparator[] | undefined => {
  let text = part.replace(BUILD_STRIP, '');
  text = text.replace(HYPHEN_RANGE, hyphenReplace);
  text = text.replace(COMPARATOR_TRIM, '$1$2$3');
  text = text.replace(TILDE_TRIM, '$1~');
  text = text.replace(CARET_TRIM, '$1^');
  const pieces = text
    .split(' ')
    .map(desugar)
    .join(' ')
    .split(/\s+/)
    .map((c) => c.trim().replace(GTE0_PRERELEASE, ''));
  const set = pieces.map(comparator);
  return set.every((c) => c !== undefined) ? (set as Comparator[]) : undefined;
};

/** The range's comparator sets, or undefined when `semver` refuses it. */
export const parseRange = (range: unknown): Comparator[][] | undefined => {
  if (typeof range !== 'string') return undefined;
  const sets: Comparator[][] = [];
  for (const part of range.trim().replace(/\s+/g, ' ').split('||')) {
    const set = parseSet(part.trim());
    if (set === undefined) return undefined;
    sets.push(set);
  }
  return sets;
};

/** `semver.validRange`, as a yes or no. */
export const validRange = (range: unknown): boolean => parseRange(range) !== undefined;

const test = (c: Comparator, v: Version): boolean => {
  if (c.version === undefined) return true;
  const order = compareVersions(v, c.version);
  switch (c.operator) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    default:
      return order === 0;
  }
};

/** `semver.satisfies(version, range, { includePrerelease: true })`; false when either does not parse. */
export const satisfies = (version: string, range: string): boolean => {
  const sets = parseRange(range);
  const v = parseVersion(version);
  if (sets === undefined || v === undefined) return false;
  return sets.some((set) => set.every((c) => test(c, v)));
};
