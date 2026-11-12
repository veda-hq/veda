// duplicate-tests: test cases that look copied, by a weighted similarity of
// their assertion matchers, their names and their describe paths.
//
// Read with the TypeScript compiler API (the optional peer), walking the nodes
// a Babel CallExpression visitor would reach: an optional-chain call is not
// one, and parentheses are not nodes.
import { basename } from 'node:path';
import type * as TS from 'typescript';
import type { Ts } from './typescript.ts';

export interface TestSignature {
  readonly file: string;
  readonly testName: string;
  readonly describePath: readonly string[];
  readonly assertionPattern: readonly string[];
  readonly line: number;
}

export interface DuplicateMatch {
  readonly file1: string;
  readonly test1: string;
  readonly line1: number;
  readonly file2: string;
  readonly test2: string;
  readonly line2: number;
  readonly similarity: number;
}

export interface Config {
  /** Which listed paths are test files. */
  readonly include: RegExp;
  /** A pair at or above this score is a duplicate; across files the bar is at least 0.95. */
  readonly threshold: number;
  /** Names too generic to compare: equal to one, or starting with one and a space, lowercased. */
  readonly commonNames: readonly string[];
  /** Word pairs that mark two names as opposite cases. Matched against lowercased names, so a pair must be lowercase to match. */
  readonly oppositePairs: ReadonlyArray<readonly [string, string]>;
}

export const DEFAULT_CONFIG: Config = {
  include: /\.(test|spec)\.(ts|tsx|js|jsx)$/,
  threshold: 0.85,
  commonNames: ['should be defined', 'should exist', 'should return', 'should throw', 'should create', 'should update', 'should delete', 'should get', 'should set'],
  oppositePairs: [
    ['success', 'failure'],
    ['success', 'error'],
    ['pass', 'fail'],
    ['valid', 'invalid'],
    ['correct', 'incorrect'],
    ['positive', 'negative'],
    ['zero', 'negative'],
    ['true', 'false'],
    ['enabled', 'disabled'],
    ['before', 'after'],
    ['start', 'end'],
    ['to', 'from'],
    ['forward', 'backward'],
    ['add', 'remove'],
    ['create', 'delete'],
  ],
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** The config a product passes; each field replaces its default, and an unknown field is refused. */
export const parseConfig = (text: string | undefined): Config => {
  if (text === undefined) return DEFAULT_CONFIG;
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error('the config is not a JSON object');
  const known = ['include', 'threshold', 'commonNames', 'oppositePairs'];
  const unknown = Object.keys(raw).filter((k) => !known.includes(k));
  if (unknown.length > 0) throw new Error(`the config has unknown field(s): ${unknown.join(', ')}`);
  const { include, threshold, commonNames, oppositePairs } = raw;
  if (include !== undefined && typeof include !== 'string') throw new Error('include is not a regex string');
  if (threshold !== undefined && (typeof threshold !== 'number' || !Number.isFinite(threshold))) throw new Error('threshold is not a number');
  if (commonNames !== undefined && !isStrings(commonNames)) throw new Error('commonNames is not a list of strings');
  if (oppositePairs !== undefined && !(Array.isArray(oppositePairs) && oppositePairs.every((p) => isStrings(p) && p.length === 2))) {
    throw new Error('oppositePairs is not a list of [word, word] pairs');
  }
  return {
    include: include === undefined ? DEFAULT_CONFIG.include : new RegExp(include),
    threshold: threshold ?? DEFAULT_CONFIG.threshold,
    commonNames: commonNames ?? DEFAULT_CONFIG.commonNames,
    oppositePairs: (oppositePairs as Array<[string, string]> | undefined) ?? DEFAULT_CONFIG.oppositePairs,
  };
};

/** Through parentheses, which Babel does not keep as nodes. */
const unwrap = (ts: Ts, node: TS.Expression): TS.Expression => {
  let n = node;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
};

const inChain = (ts: Ts, node: TS.Node): boolean => (node.flags & ts.NodeFlags.OptionalChain) !== 0;

/** A call Babel reads as a CallExpression: not one inside an optional chain. */
const isPlainCall = (ts: Ts, node: TS.Node): node is TS.CallExpression => ts.isCallExpression(node) && !inChain(ts, node);

const calleeName = (ts: Ts, call: TS.CallExpression): string | undefined => {
  const callee = unwrap(ts, call.expression);
  return ts.isIdentifier(callee) ? callee.text : undefined;
};

/**
 * The matcher a call names, as Babel's MemberExpression with an Identifier
 * property: `a.toBe()`, and `a[toBe]()` too; never `a?.toBe()` or `a['toBe']()`.
 */
const memberProperty = (ts: Ts, call: TS.CallExpression): string | undefined => {
  const callee = unwrap(ts, call.expression);
  if (inChain(ts, callee)) return undefined;
  if (ts.isPropertyAccessExpression(callee)) return ts.isIdentifier(callee.name) ? callee.name.text : undefined;
  if (ts.isElementAccessExpression(callee)) {
    const arg = unwrap(ts, callee.argumentExpression);
    return ts.isIdentifier(arg) ? arg.text : undefined;
  }
  return undefined;
};

const sourceText = (sf: TS.SourceFile, node: TS.Node): string => sf.text.slice(node.getStart(sf), node.end);

/**
 * The name a describe/test/it call gives its block. A string literal (or a
 * template without expressions) yields its value; `describe(X.name)` yields
 * `X`, the unit under test; any other argument its source text.
 */
export const extractTestName = (ts: Ts, sf: TS.SourceFile, call: TS.CallExpression): string => {
  const [arg] = call.arguments;
  if (arg === undefined) return 'unnamed test';
  const first = unwrap(ts, arg);
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  const named = ts.isPropertyAccessExpression(first) && !inChain(ts, first) && ts.isIdentifier(first.name) && first.name.text === 'name' ? unwrap(ts, first.expression) : first;
  return sourceText(sf, named);
};

/**
 * TS for a `.ts` file, TSX for the rest. Babel had JSX on everywhere but reads
 * `<T>(x) => …` in a `.ts` file as a generic arrow; TypeScript under TSX reads
 * it as an element and loses the rest of the file.
 */
const scriptKind = (ts: Ts, file: string): TS.ScriptKind => (/\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.TSX);

/** The syntax errors the parse recorded; `parseDiagnostics` is the source file's own list, read without a program. */
const syntaxErrors = (sf: TS.SourceFile): readonly TS.DiagnosticWithLocation[] => (sf as unknown as { parseDiagnostics?: readonly TS.DiagnosticWithLocation[] }).parseDiagnostics ?? [];

/**
 * Syntax TypeScript reads and the Babel parse this replaces (plugins
 * typescript, jsx and decorators-legacy) threw on, so the file gave no
 * signatures: a `<T>value` assertion in a `.ts` file, which JSX reads as an
 * unterminated element, and an `accessor` field, which needs a plugin it did
 * not have.
 */
const babelRefusal = (ts: Ts, kind: TS.ScriptKind, node: TS.Node): string | undefined => {
  if (kind === ts.ScriptKind.TS && ts.isTypeAssertionExpression(node)) return 'a <T>value type assertion, which a JSX parse reads as an unterminated element';
  if (ts.isPropertyDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AccessorKeyword) === true) return 'an accessor field, which needs the decoratorAutoAccessors parser plugin';
  if (ts.isClassLike(node)) {
    const modifiers = node.modifiers ?? [];
    const exported = modifiers.findIndex((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    // `export default @dec class` is a decorated class expression, which they do take.
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (exported >= 0 && !isDefault && modifiers.slice(exported).some((m) => ts.isDecorator(m))) return 'a decorator after export, which legacy decorators do not take';
  }
  return undefined;
};

/** Why the file gives no signatures: a syntax error, or what Babel refused; undefined when it reads. */
const parseError = (ts: Ts, sf: TS.SourceFile, refused: { readonly node: TS.Node; readonly why: string } | undefined): string | undefined => {
  const [first] = syntaxErrors(sf);
  const at = (pos: number): string => {
    const { line, character } = sf.getLineAndCharacterOfPosition(pos);
    return `(${String(line + 1)}:${String(character)})`;
  };
  if (first !== undefined) return `${ts.flattenDiagnosticMessageText(first.messageText, '\n')} ${at(first.start)}`;
  if (refused !== undefined) return `${refused.why} ${at(refused.node.getStart(sf))}`;
  return undefined;
};

export interface FileSignatures {
  readonly signatures: TestSignature[];
  /** Set when the file cannot be read as code; it then gives no signatures. */
  readonly parseError?: string;
}

/** Every test with an assertion in one file, in the order a depth-first walk meets them. */
export const extractTestSignatures = (ts: Ts, file: string, content: string): FileSignatures => {
  const parse = (k: TS.ScriptKind): TS.SourceFile => ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, k);
  let kind = scriptKind(ts, file);
  let sf = parse(kind);
  if (kind === ts.ScriptKind.TS && syntaxErrors(sf).length > 0) {
    // JSX in a `.ts` file, which Babel read: take the TSX parse when it is clean.
    const tsx = parse(ts.ScriptKind.TSX);
    if (syntaxErrors(tsx).length === 0) {
      kind = ts.ScriptKind.TSX;
      sf = tsx;
    }
  }
  const signatures: TestSignature[] = [];
  const describeStack: string[] = [];
  let refused: { node: TS.Node; why: string } | undefined;

  const assertions = (call: TS.CallExpression): string[] => {
    const pattern: string[] = [];
    const visit = (node: TS.Node): void => {
      if (isPlainCall(ts, node)) {
        if (calleeName(ts, node) === 'expect') pattern.push('expect()');
        const matcher = memberProperty(ts, node);
        if (matcher?.startsWith('to') === true) pattern.push(matcher);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(call, visit);
    return pattern;
  };

  const walk = (node: TS.Node): void => {
    if (refused === undefined) {
      const why = babelRefusal(ts, kind, node);
      if (why !== undefined) refused = { node, why };
    }
    const call = isPlainCall(ts, node) ? node : undefined;
    const name = call === undefined ? undefined : calleeName(ts, call);
    if (call !== undefined && name === 'describe') describeStack.push(extractTestName(ts, sf, call));
    if (call !== undefined && (name === 'test' || name === 'it')) {
      const assertionPattern = assertions(call);
      if (assertionPattern.length > 0) {
        signatures.push({
          file,
          testName: extractTestName(ts, sf, call),
          describePath: [...describeStack],
          assertionPattern,
          line: sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1,
        });
      }
    }
    ts.forEachChild(node, walk);
    if (name === 'describe') describeStack.pop();
  };
  walk(sf);
  const error = parseError(ts, sf, refused);
  return error === undefined ? { signatures } : { signatures: [], parseError: error };
};

const levenshtein = (a: string, b: string): number => {
  let prev = Array.from({ length: a.length + 1 }, (_, j) => j);
  for (let i = 1; i <= b.length; i++) {
    const row = [i];
    for (let j = 1; j <= a.length; j++) {
      row[j] = b.charAt(i - 1) === a.charAt(j - 1) ? (prev[j - 1] as number) : Math.min((prev[j - 1] as number) + 1, (row[j - 1] as number) + 1, (prev[j] as number) + 1);
    }
    prev = row;
  }
  return prev[a.length] as number;
};

/** 1 minus the edit distance over the longer length, case-insensitive; 1 for two empty strings. */
export const stringSimilarity = (a: string, b: string): number => {
  const max = Math.max(a.length, b.length);
  return max > 0 ? 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / max : 1;
};

/** Jaccard similarity of two matcher lists, as sets; 0 when both are empty. */
export const patternSimilarity = (a: readonly string[], b: readonly string[]): number => {
  const setA = new Set(a);
  const setB = new Set(b);
  const union = new Set([...setA, ...setB]);
  return union.size > 0 ? [...setA].filter((x) => setB.has(x)).length / union.size : 0;
};

/**
 * Two tests in no describe block: full credit in one file; across files the
 * file stems (the basename up to its first dot) are the only names they have.
 */
const neitherDescribed = (file1: string, file2: string): number => {
  if (file1 === file2) return 1;
  const stem = (f: string): string => basename(f).split('.')[0] as string;
  return stringSimilarity(stem(file1), stem(file2));
};

/** 50% matchers, 20% name, 30% describe path. */
export const compositeSimilarity = (a: TestSignature, b: TestSignature): number => {
  const path1 = a.describePath.join(' > ');
  const path2 = b.describePath.join(' > ');
  const describeSim = path1.length > 0 && path2.length > 0 ? stringSimilarity(path1, path2) : path1.length === 0 && path2.length === 0 ? neitherDescribed(a.file, b.file) : 0;
  return patternSimilarity(a.assertionPattern, b.assertionPattern) * 0.5 + stringSimilarity(a.testName, b.testName) * 0.2 + describeSim * 0.3;
};

const MIN_ASSERTIONS = 3;

const HTTP_INDICATORS = /\b(GET|POST|PUT|DELETE|PATCH|200|201|400|401|403|404|500|502)\b/gi;

// Case-sensitive on purpose: lowercase "and"/"or" are prose, uppercase AND/OR are domain tokens.
const COMBINATOR_INDICATORS = /\b(AND|OR)\b/g;

const isCommon = (config: Config, name: string): boolean => {
  const normalized = name.toLowerCase().trim();
  return config.commonNames.some((p) => normalized === p || normalized.startsWith(`${p} `));
};

/** Two names for opposite or complementary cases: an opposite pair, other HTTP tokens, other AND/OR tokens, another endpoint. */
export const areOppositeScenarios = (config: Config, name1: string, name2: string): boolean => {
  const lower1 = name1.toLowerCase();
  const lower2 = name2.toLowerCase();
  for (const [w1, w2] of config.oppositePairs) {
    if ((lower1.includes(w1) && lower2.includes(w2)) || (lower1.includes(w2) && lower2.includes(w1))) return true;
  }
  const http1 = Array.from(name1.matchAll(HTTP_INDICATORS), (m) => m[0]);
  const http2 = Array.from(name2.matchAll(HTTP_INDICATORS), (m) => m[0]);
  if (http1.length > 0 && http2.length > 0 && http1.some((m) => !http2.includes(m))) return true;
  const comb1 = Array.from(name1.matchAll(COMBINATOR_INDICATORS), (m) => m[0]);
  const comb2 = Array.from(name2.matchAll(COMBINATOR_INDICATORS), (m) => m[0]);
  if (comb1.length > 0 && comb2.length > 0 && (comb1.some((c) => !comb2.includes(c)) || comb2.some((c) => !comb1.includes(c)))) return true;
  const end1 = name1.match(/\/\w+/g) ?? [];
  const end2 = name2.match(/\/\w+/g) ?? [];
  return end1.length > 0 && end2.length > 0 && end1[0] !== end2[0];
};

const FILLER = new Set(['should', 'when', 'with', 'the', 'a', 'an', 'it', 'is', 'are', 'be', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'not', 'if', 'that', 'this', 'can', 'does']);

const words = (name: string): string[] =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !FILLER.has(w));

/**
 * Two tests in one file that are meant to differ: opposite names, the same
 * name (so different describe blocks), a word only one has, or the same words
 * in another order (a mirrored case).
 */
export const areSameFileComplementary = (config: Config, file1: string, file2: string, name1: string, name2: string): boolean => {
  if (file1 !== file2) return false;
  if (areOppositeScenarios(config, name1, name2)) return true;
  if (name1 === name2) return true;
  const words1 = new Set(words(name1));
  const words2 = new Set(words(name2));
  if ([...words1].some((w) => !words2.has(w)) || [...words2].some((w) => !words1.has(w))) return true;
  const seq1 = words(name1);
  const seq2 = words(name2);
  return [...seq1].sort().join(' ') === [...seq2].sort().join(' ') && seq1.join(' ') !== seq2.join(' ');
};

/** Every pair at or above the threshold, in signature order. */
export const findDuplicates = (config: Config, signatures: readonly TestSignature[]): DuplicateMatch[] => {
  const matches: DuplicateMatch[] = [];
  const processed = new Set<string>();
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      const a = signatures[i] as TestSignature;
      const b = signatures[j] as TestSignature;
      if (a.assertionPattern.length < MIN_ASSERTIONS || b.assertionPattern.length < MIN_ASSERTIONS) continue;
      if (isCommon(config, a.testName) || isCommon(config, b.testName)) continue;
      if (areOppositeScenarios(config, a.testName, b.testName)) continue;
      if (areSameFileComplementary(config, a.file, b.file, a.testName, b.testName)) continue;
      const key = `${a.file}:${a.testName}-${b.file}:${b.testName}`;
      if (processed.has(key)) continue;
      const similarity = compositeSimilarity(a, b);
      // Different files test different modules: a higher bar.
      const bar = a.file !== b.file ? Math.max(config.threshold, 0.95) : config.threshold;
      if (similarity >= bar) {
        matches.push({ file1: a.file, test1: a.testName, line1: a.line, file2: b.file, test2: b.testName, line2: b.line, similarity });
        processed.add(key);
      }
    }
  }
  return matches;
};

export interface Listed {
  /** The path as the report prints it: relative to the root. */
  readonly file: string;
  /** The absolute path, which a reading failure names. */
  readonly path: string;
  /** Its text; throws when it cannot be read. */
  readonly read: () => string;
}

/** The report, line by line, and the exit code; reading failures warn on stderr and the file is skipped. */
export const runDuplicateTests = (ts: Ts, config: Config, mode: string, files: readonly Listed[]): { code: 0 | 1; out: string[]; err: string[] } => {
  const out = [`🔍 Searching for duplicate tests (Threshold: ${String(config.threshold)})...`, `   Mode: ${mode}`];
  const err: string[] = [];
  if (files.length === 0) {
    out.push('No files found to analyze.');
    return { code: 0, out, err };
  }
  out.push(`   Analyzing ${String(files.length)} files...`);
  const signatures: TestSignature[] = [];
  for (const f of files) {
    try {
      const read = extractTestSignatures(ts, f.file, f.read());
      if (read.parseError !== undefined) err.push(`❌ Parse error: ${read.parseError}`);
      signatures.push(...read.signatures);
    } catch (e) {
      err.push(`⚠️  Failed to parse ${f.path}: ${(e as Error).message}`);
    }
  }
  out.push(`   Extracted ${String(signatures.length)} test signatures.`);
  const duplicates = findDuplicates(config, signatures);
  if (duplicates.length === 0) {
    out.push('', '✅ No duplicates found.');
    return { code: 0, out, err };
  }
  out.push('', '❌ Found potential duplicate tests:');
  for (const d of [...duplicates].sort((x, y) => y.similarity - x.similarity)) {
    out.push('', `   ${(d.similarity * 100).toFixed(0)}% Match:`, `     A: ${d.file1}:${String(d.line1)} "${d.test1}"`, `     B: ${d.file2}:${String(d.line2)} "${d.test2}"`);
  }
  out.push('', `Total potential duplicates: ${String(duplicates.length)}`);
  return { code: 1, out, err };
};
