// regression-controls: the targeted regression controls stay whole.
//
// Ported from a product repository's TypeScript check, its gates and required
// findings moved from code into the registry.
//
// A targeted control answers one finding with four tests: a bad case (the
// historical test, shown blind to the fault), a fixed case, a near miss and a
// guard flip. Those four tests are the proof; a rename, a deletion or a skip
// silently ends it while every suite still passes. This check fails instead:
// every title the registry lists must be the title of a live `it(...)` or
// `test(...)` call in its file (a comment or a stray string names no case),
// the file must be collected by the gate the registry names, and the guarded
// production file must exist.
//
// `--staged` reads every file from the index, and the registry too when the
// index holds it, so a commit is judged on what it records.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { posix, relative, sep } from 'node:path';
import type * as TS from 'typescript';
import { gitEnv, PINNED, topOf } from './git.ts';
import { dict, formatOutcome, isRepoPath, list, object, onlyKeys, parseJson, path, readText, records, regexes, required, text } from './registry-ratchet.ts';
import type { Ts } from './typescript.ts';

export const CASE_KINDS = ['bad', 'fixed', 'nearMiss', 'guardFlip'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export interface Control {
  readonly id: string;
  readonly finding: string;
  readonly family: string;
  readonly file: string;
  readonly gate: string;
  readonly guard: string;
  readonly cases: Readonly<Record<CaseKind, string>>;
}

export interface Registry {
  /** Which test files each gate collects, by path pattern; undefined when `gates` is null. */
  readonly gates: Readonly<Record<string, readonly RegExp[]>> | undefined;
  /** The findings some control must answer; undefined when `requiredFindings` is null. */
  readonly requiredFindings: readonly string[] | undefined;
  readonly controls: readonly Control[];
  /** What the registry leaves unchecked, for the `not checked` line. */
  readonly skipped: readonly string[];
}

const CONTROL_KEYS = ['id', 'finding', 'family', 'file', 'gate', 'guard', 'cases'] as const;

/**
 * The registry a JSON text holds; throws naming the first key that is wrong.
 * `gates` and `requiredFindings` are required, `null` opting each check out:
 * a forgotten key would drop a check silently. An opt-out is recorded in
 * `skipped`, which the run prints as not checked.
 */
export const parseRegistry = (source: string): Registry => {
  const raw = parseJson(source);
  onlyKeys(raw, ['$comment', '$schema', 'gates', 'requiredFindings', 'controls'], '');
  const skipped: string[] = [];
  const gates = required(raw, 'gates', '', skipped, () => {
    const g = object(raw, 'gates', '');
    const out = dict<RegExp[]>();
    for (const name of Object.keys(g)) out[name] = regexes(g, name, 'gates: ');
    return out;
  });
  const requiredFindings = required(raw, 'requiredFindings', '', skipped, () =>
    list(raw, 'requiredFindings', '').map((v, i) => {
      if (typeof v !== 'string' || v.trim() === '') throw new Error(`requiredFindings[${i}] must be a non-empty string`);
      return v;
    }),
  );
  if (!Array.isArray(raw['controls'])) throw new Error('"controls" must be a list');
  if (raw['controls'].length === 0) throw new Error('"controls" is empty, so nothing would be checked');
  const controls = records(raw['controls'], 'controls').map(({ raw: c, where }, i): Control => {
    onlyKeys(c, CONTROL_KEYS, where);
    const fields = { id: text(c, 'id', where), finding: text(c, 'finding', where), family: text(c, 'family', where), file: path(c, 'file', where), gate: text(c, 'gate', where), guard: text(c, 'guard', where) };
    const cases = object(c, 'cases', where);
    const at = `controls[${i}].cases: `;
    onlyKeys(cases, CASE_KINDS, at);
    return { ...fields, cases: { bad: text(cases, 'bad', at), fixed: text(cases, 'fixed', at), nearMiss: text(cases, 'nearMiss', at), guardFlip: text(cases, 'guardFlip', at) } };
  });
  return { gates, requiredFindings, controls, skipped };
};

/**
 * Reads a root-relative path from the working tree or the index; null when
 * absent. `prefetch`, when present, loads many paths at once (one git process).
 */
export type Reader = ((path: string) => string | null) & {
  prefetch?: (paths: readonly string[]) => void;
};

/** The working tree under `root`; a folder or a missing path is absent. */
export const worktreeReader = (root: string): Reader => (p) => readText(root, p) ?? null;

/**
 * `git cat-file --batch` output for `asked`, path by path: a blob's text, or
 * null for a missing path or another kind of object. A size past 2^53 would
 * misplace every later entry, so reading stops there and the rest are null.
 */
export const parseBatch = (out: Buffer, asked: readonly string[]): Map<string, string | null> => {
  const blobs = new Map<string, string | null>(asked.map((p) => [p, null]));
  let at = 0;
  for (const p of asked) {
    const eol = out.indexOf(0x0a, at);
    if (eol === -1) break;
    const header = out.subarray(at, eol).toString('utf8');
    at = eol + 1;
    const found = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (found === null) continue; // `<object> missing`: no content follows
    const size = Number(found[2]);
    if (!Number.isSafeInteger(size)) break;
    // Every sized entry has a body and its newline: step past both, whatever
    // the object type, then keep the body only for a blob.
    const body = out.subarray(at, at + size);
    at += size + 1;
    if (found[1] === 'blob') blobs.set(p, body.toString('utf8'));
  }
  return blobs;
};

/**
 * The index of the repository holding `root`, paths read relative to `root`.
 * `env` keeps a hook's GIT_INDEX_FILE, so the index being committed is read.
 * Throws when `root` is in no git repository.
 */
export const indexReader = (root: string, env: NodeJS.ProcessEnv = process.env): Reader => {
  const top = topOf(root);
  if (top === undefined) throw new Error(`${root} is not in a git repository, so --staged has no index to read`);
  const prefix = relative(realpathSync(top), realpathSync(root)).split(sep).join('/');
  const blobs = new Map<string, string | null>();
  const prefetch = (paths: readonly string[]): void => {
    const wanted = [...new Set(paths)].filter((p) => !blobs.has(p));
    if (wanted.length === 0) return;
    for (const p of wanted) blobs.set(p, null);
    // One `cat-file --batch` for every path: a git process per file is most
    // of a pre-commit check's time. A path with a newline cannot be asked for.
    const asked = wanted.filter((p) => !p.includes('\n'));
    // spawnSync captures stderr unread, so no stdio list is needed. Git that
    // never started, or ran out its time, has no status and its own error,
    // thrown as it is. Any other ending is git's verdict, "Command failed:
    // <command>" when not 0: a signal, or an exit, an EPIPE on input git
    // exited without reading included, which only races git's exit.
    const args = [...PINNED, 'cat-file', '--batch'];
    const run = spawnSync('git', args, {
      cwd: top,
      env: gitEnv(env),
      input: asked.map((p) => `:${prefix === '' ? p : posix.join(prefix, p)}\n`).join(''),
      maxBuffer: 1 << 28,
      timeout: 120_000,
    });
    if (run.status === null && run.error !== undefined) throw run.error;
    if (run.status !== 0) throw Object.assign(new Error(`Command failed: git ${args.join(' ')}`), { status: run.status });
    for (const [p, body] of parseBatch(run.stdout, asked)) blobs.set(p, body);
  };
  // prefetch asks git only for a path it has not loaded.
  const read: Reader = (p) => {
    prefetch([p]);
    return blobs.get(p) ?? null;
  };
  read.prefetch = prefetch;
  return read;
};

/** The production file a guard description names: `<what> in <path>`. */
export const guardedPath = (guard: string): string | null => guard.match(/ in (\S+)$/)?.[1] ?? null;

const isCaseFunction = (ts: Ts, node: TS.Node): boolean => ts.isIdentifier(node) && (node.text === 'it' || node.text === 'test');

/** `it` / `test`, or a table of them: `it.each(rows)` / `test.each(rows)`. */
const isCaseCallee = (ts: Ts, callee: TS.Expression): boolean =>
  isCaseFunction(ts, callee) ||
  (ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === 'each' && isCaseFunction(ts, callee.expression.expression));

/**
 * The titles of a file's cases: the string first argument of each `it(...)`,
 * `test(...)`, `it.each(rows)(...)` or `test.each(rows)(...)` call. Read from
 * the syntax tree, so a title left in a comment, a string or a `describe`
 * after its case is deleted names nothing; any other modifier is not a case.
 */
export const caseTitles = (ts: Ts, file: string, source: string): Set<string> => {
  const titles = new Set<string>();
  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node) && isCaseCallee(ts, node.expression)) {
      const first = node.arguments[0];
      if (first !== undefined && ts.isStringLiteralLike(first)) titles.add(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest));
  return titles;
};

const TEST_APIS = new Set(['it', 'test', 'describe', 'suite']);
const MODIFIERS = new Set(['skip', 'todo', 'only', 'skipIf', 'runIf']);
const OPTION_MODIFIERS = new Set(['skip', 'todo', 'only']);

/** Whether a member or call chain starts at a test API: `it.each([])['skip']`. */
const onTestApi = (ts: Ts, node: TS.Expression): boolean => {
  let at = node;
  while (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at) || ts.isCallExpression(at) || ts.isParenthesizedExpression(at)) at = at.expression;
  return ts.isIdentifier(at) && TEST_APIS.has(at.text);
};

/**
 * Whether a property or binding is literally named one of `names`. Of the
 * names a property or binding can have, an identifier and a string literal
 * have the text a modifier is; a number or a private name has another text,
 * and a computed name or a binding pattern has none.
 */
const namedIn = (names: ReadonlySet<string>, name: TS.Node | undefined): boolean => name !== undefined && names.has(String((name as { readonly text?: unknown }).text));

/** Called, or reached through, as `x['skip'](` and `x['only'].each` are. */
const isUsed = (ts: Ts, node: TS.Expression): boolean => {
  const parent = node.parent;
  return (ts.isCallExpression(parent) || ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
};

const disables = (ts: Ts, node: TS.Node): boolean => {
  if (ts.isPropertyAccessExpression(node)) return MODIFIERS.has(node.name.text) && onTestApi(ts, node.expression);
  if (ts.isElementAccessExpression(node)) {
    const argument = node.argumentExpression;
    // Only a literal key is known; `it[mode]` could be any modifier.
    const key = ts.isStringLiteralLike(argument) ? argument.text : '';
    if (key === '') return onTestApi(ts, node.expression);
    return MODIFIERS.has(key) && (onTestApi(ts, node.expression) || isUsed(ts, node));
  }
  if (ts.isObjectBindingPattern(node)) {
    // A variable, a parameter's default or an outer binding's default.
    const from = node.parent.initializer;
    return from !== undefined && onTestApi(ts, from) && node.elements.some((element) => namedIn(MODIFIERS, element.propertyName ?? element.name));
  }
  return (
    ts.isCallExpression(node) &&
    onTestApi(ts, node.expression) &&
    node.arguments.some((argument) => ts.isObjectLiteralExpression(argument) && argument.properties.some((property) => namedIn(OPTION_MODIFIERS, ts.getNameOfDeclaration(property))))
  );
};

/**
 * The first syntax that disables a case the text scan cannot see: a test
 * API's modifier reached by computed access (`it['skip']`, `describe[mode]`)
 * or taken as an alias (`const s = it.skip;`, `const { only } = test`), and a
 * case's options object that sets skip, todo or only anywhere in it. A
 * property of any other object is not a case.
 */
export const disablingSyntax = (ts: Ts, file: string, source: string): string | null => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  // forEachChild stops at the first child that returns a node.
  const find = (node: TS.Node): TS.Node | undefined => (disables(ts, node) ? node : ts.forEachChild(node, find));
  const found = find(tree);
  return found === undefined ? null : found.getText(tree);
};

/**
 * skipIf/runIf disable a case on a condition, so they count as disabling; so
 * does node:test's `{ skip: ... }` / `{ todo: ... }` / `{ only: ... }`. Any
 * receiver counts (an aliased `it`, a chained `.each(...)`): a control file
 * has no other reason to call `.skip(` or `.only(`.
 */
const DISABLING_TEXT = /(?:\b\w+)?\.(?:skip|todo|only|skipIf|runIf)\b(?=\s*[(.])|\{\s*(?:skip|todo|only)\s*:/;

/** Every problem with the controls and the files they name; empty when whole. */
export const checkRegressionControls = (ts: Ts, read: Reader, registry: Registry): string[] => {
  const problems: string[] = [];
  const { controls, gates, requiredFindings } = registry;
  read.prefetch?.(controls.flatMap((control) => [control.file, guardedPath(control.guard) ?? control.file]));

  const ids = new Set<string>();
  for (const control of controls) {
    if (ids.has(control.id)) problems.push(`${control.id}: duplicate id`);
    ids.add(control.id);
  }
  for (const finding of requiredFindings ?? []) {
    if (!controls.some((control) => control.finding === finding)) problems.push(`${finding}: no control answers this finding`);
  }

  for (const control of controls) {
    const label = `${control.id} (${control.finding})`;
    if (gates !== undefined) {
      const collects = Object.hasOwn(gates, control.gate) ? gates[control.gate] : undefined;
      if (collects === undefined) problems.push(`${label}: unknown gate "${control.gate}"`);
      else if (!collects.some((pattern) => pattern.test(control.file))) problems.push(`${label}: ${control.file} is not collected by ${control.gate}`);
    }
    const guarded = guardedPath(control.guard);
    if (guarded === null) problems.push(`${label}: guard must read "<what> in <path>"`);
    else if (!isRepoPath(guarded)) problems.push(`${label}: guarded path ${guarded} is not a normalized root-relative path`);
    else if (read(guarded) === null) problems.push(`${label}: guarded file ${guarded} is missing`);
    const source = read(control.file);
    if (source === null) {
      problems.push(`${label}: ${control.file} is missing`);
      continue;
    }
    const titles = caseTitles(ts, control.file, source);
    for (const kind of CASE_KINDS) {
      const title = control.cases[kind];
      if (!titles.has(title)) problems.push(`${label}: ${kind} case "${title}" is not a case in ${control.file}`);
    }
    const disabled = source.match(DISABLING_TEXT)?.[0] ?? disablingSyntax(ts, control.file, source);
    if (disabled !== null) problems.push(`${label}: ${control.file} uses ${disabled}`);
  }
  return problems;
};

/** The verdict: problems on stderr with the way back, or one summary line on stdout. */
export const formatControls = (problems: readonly string[], registry: Registry, shown: string, staged: boolean): { ok: boolean; out: string[]; err: string[] } => {
  const answered = registry.requiredFindings === undefined ? '' : `, ${registry.requiredFindings.length} required finding(s) answered`;
  return formatOutcome(
    'pariksha regression-controls:',
    problems,
    `${registry.controls.length} control(s) whole${staged ? ' (staged)' : ''}${answered}`,
    `Each control's bad, fixed, near-miss and guard-flip tests prove its fix still bites; keep the titles in ${shown} in step with the tests.`,
    registry.skipped,
  );
};
