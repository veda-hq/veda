/**
 * The adversarial corpus of the guards.
 *
 * ONE table that every guard is run against (consumers.ts), instead of each
 * guard keeping its own list of the cases its author thought of. Review found
 * the gaps one round at a time — `git -c core.hooksPath`, a flag in a
 * variable, a write through `xargs` — because nothing forced a new guard to
 * face the old tricks.
 *
 * A row is a command (or a script fragment) plus the INTENT it is evidence
 * for, and whether that intent really happens when bash runs it. That truth is
 * not trusted: corpus.test.ts executes every row in a fixture (oracle.ts) and
 * fails when the declared truth and bash disagree, so the table cannot drift
 * into describing what someone believed bash does.
 *
 * The rows are data: corpus.json, in table order, read through the schema
 * below, which refuses a row carrying a field it does not know or missing one
 * it needs. A row's `note` is the comment that explains it — why bash does
 * what the row says — and is dropped on load, so CORPUS holds rows only.
 *
 * Placeholders, filled per fixture by `render`:
 *   {P}    the main checkout (every write there is a breach)
 *   {GIT}  the absolute path of the git executable
 *   {UP}   the relative path up to the main checkout from the checkout the
 *          row runs or is judged in
 */

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export type Intent =
  /** A commit or push lands without the hook that would have run. */
  | 'hook-bypass'
  /** An existing remote branch is replaced by a non-descendant. */
  | 'force-push'
  /** The main checkout's files or HEAD change from a session worktree. */
  | 'outside-write'
  /** `pnpm mutate` runs and its failure reaches the caller (wired). */
  | 'gate-invocation'
  /** The line exits the shell with status 1 (a push-blocking statement). */
  | 'unconditional-exit'
  /** A failing gate command runs and the line still succeeds. */
  | 'masked-exit';

/**
 * - `example`: a reported bypass reproduced.
 * - `corrected`: the same command written safely; must pass every consumer.
 * - `near-miss`: looks like the attack but is not; must pass every consumer.
 * - `attack`: a bypass form; a consumer may never let it through.
 * - `inert`: text that mentions the target without running it; a guard may
 *   over-refuse it (fail closed), a validator may never count it.
 * - `positive`: a legitimate spelling of the target that a validator must
 *   count (quoted arguments, `$()` and multi-line forms).
 */
export type Role =
  'example' | 'corrected' | 'near-miss' | 'attack' | 'inert' | 'positive';

export interface CorpusRow {
  readonly id: string;
  readonly intent: Intent;
  readonly text: string;
  /** Does the intent really happen when bash runs `text`? Oracle-verified. */
  readonly happens: boolean;
  readonly role: Role;
  /** The trick family, for the evidence table. */
  readonly family: string;
  /** Run in the main checkout instead of the session worktree. */
  readonly inPrimary?: boolean;
  /**
   * The first git release that runs `text` (e.g. `git config set`, 2.46).
   * An older git refuses the command, so there the intent does not happen;
   * consumers are still judged against `happens`, the newer git's answer.
   */
  readonly gitSince?: string;
}

const INTENTS: readonly Intent[] = [
  'hook-bypass',
  'force-push',
  'outside-write',
  'gate-invocation',
  'unconditional-exit',
  'masked-exit',
];

const ROLES: readonly Role[] = [
  'example',
  'corrected',
  'near-miss',
  'attack',
  'inert',
  'positive',
];

/** Every field a row may carry; `note` is read and dropped. */
const FIELDS: ReadonlySet<string> = new Set([
  'id',
  'note',
  'intent',
  'role',
  'happens',
  'family',
  'text',
  'inPrimary',
  'gitSince',
]);

/**
 * The harness's own files: the hook and shim logs, the gate switch, the
 * fixture's hook scripts (`.hooks/`) and origin's hooks. They record what the
 * oracle sees, so a row naming one could forge its own truth (oracle.ts,
 * Residual). `core.hooksPath` and a `.claude/` hook directory are not among
 * them.
 */
const HARNESS_FILES =
  /CORPUS_HOOK_MARKER|hook-marker|shim-log|gate-passes|remote\.git|(?<!\.claude\/)hooks\/update|(?<!\w)\.hooks\b/g;

export interface Issue {
  /** `[index].field`, or `[index]` for the row as a whole. */
  readonly path: string;
  readonly code: 'not-array' | 'not-object' | 'unknown-key' | 'invalid' | 'custom';
  readonly message: string;
}

export type Parsed =
  | { readonly success: true; readonly data: CorpusRow[] }
  | { readonly success: false; readonly issues: readonly Issue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** One row, or the issues that keep it from being one. */
function readRow(entry: unknown, at: string, issues: Issue[]): CorpusRow | null {
  if (!isRecord(entry)) {
    issues.push({ path: at, code: 'not-object', message: 'a row must be an object' });
    return null;
  }
  const before = issues.length;
  const invalid = (field: string, message: string): void => {
    issues.push({ path: `${at}.${field}`, code: 'invalid', message });
  };
  for (const key of Object.keys(entry)) {
    if (!FIELDS.has(key)) {
      issues.push({
        path: `${at}.${key}`,
        code: 'unknown-key',
        message: `unrecognized key: ${key}`,
      });
    }
  }
  const { id, note, intent, role, happens, family, text, inPrimary, gitSince } =
    entry;
  if (typeof id !== 'string') invalid('id', 'expected a string');
  if (note !== undefined && typeof note !== 'string') {
    invalid('note', 'expected a string');
  }
  if (!oneOf(INTENTS, intent)) invalid('intent', `expected one of ${INTENTS.join(', ')}`);
  if (!oneOf(ROLES, role)) invalid('role', `expected one of ${ROLES.join(', ')}`);
  if (typeof happens !== 'boolean') invalid('happens', 'expected a boolean');
  if (typeof family !== 'string') invalid('family', 'expected a string');
  if (typeof text !== 'string') {
    invalid('text', 'expected a string');
  } else {
    const named = [...new Set(text.match(HARNESS_FILES))];
    if (named.length > 0) {
      issues.push({
        path: `${at}.text`,
        code: 'custom',
        message: `names a harness file the oracle reads: ${named.join(', ')}`,
      });
    }
  }
  if (inPrimary !== undefined && typeof inPrimary !== 'boolean') {
    invalid('inPrimary', 'expected a boolean');
  }
  if (
    gitSince !== undefined &&
    (typeof gitSince !== 'string' || !/^\d+\.\d+$/.test(gitSince))
  ) {
    invalid('gitSince', 'expected a release such as 2.46');
  }
  if (
    issues.length > before ||
    typeof id !== 'string' ||
    !oneOf(INTENTS, intent) ||
    !oneOf(ROLES, role) ||
    typeof happens !== 'boolean' ||
    typeof family !== 'string' ||
    typeof text !== 'string'
  ) {
    return null;
  }
  return {
    id,
    intent,
    role,
    happens,
    family,
    text,
    ...(typeof inPrimary === 'boolean' ? { inPrimary } : {}),
    ...(typeof gitSince === 'string' ? { gitSince } : {}),
  };
}

/**
 * The whole table as corpus.json holds it, each row's `note` dropped: rows
 * with a field the schema does not know, or without one it needs, are
 * refused, with every issue named.
 */
export const CORPUS_SCHEMA = {
  safeParse(data: unknown): Parsed {
    if (!Array.isArray(data)) {
      return {
        success: false,
        issues: [{ path: '', code: 'not-array', message: 'the corpus must be an array' }],
      };
    }
    const issues: Issue[] = [];
    const rows: CorpusRow[] = [];
    data.forEach((entry: unknown, index) => {
      const row = readRow(entry, `[${String(index)}]`, issues);
      if (row !== null) rows.push(row);
    });
    return issues.length > 0
      ? { success: false, issues }
      : { success: true, data: rows };
  },
  parse(data: unknown): CorpusRow[] {
    const parsed = CORPUS_SCHEMA.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        `not a corpus: ${parsed.issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`,
      );
    }
    return parsed.data;
  },
};

/**
 * Two near-miss rows that name the git config file by its literal path, kept
 * in code: a data file a reader may follow should not point into git's own
 * state, and in code it is plainly a deliberate fixture. Reading .git/config
 * is not writing it: an input redirection and a copy's source name the file
 * without changing it. Run in the main checkout, where `.git` is a directory,
 * so both reads really succeed.
 */
const GIT_CONFIG_READS = CORPUS_SCHEMA.parse([
  {
    id: 'hb-config-input-redirect',
    intent: 'hook-bypass',
    role: 'near-miss',
    happens: false,
    family: 'redirect',
    text: 'wc -c < .git/config',
    inPrimary: true,
  },
  {
    id: 'hb-config-copied-out',
    intent: 'hook-bypass',
    role: 'near-miss',
    happens: false,
    family: 'cp',
    text: 'cp .git/config /dev/null',
    inPrimary: true,
  },
]);

export const CORPUS: readonly CorpusRow[] = [
  ...CORPUS_SCHEMA.parse(
    JSON.parse(readFileSync(join(import.meta.dirname, 'corpus.json'), 'utf8')),
  ),
  ...GIT_CONFIG_READS,
];

/**
 * What bash really does with `row` under the git that printed `gitVersion`
 * (`git version 2.43.0`): the declared truth, unless the row needs a newer
 * git than that one.
 */
export function happensUnder(row: CorpusRow, gitVersion: string): boolean {
  if (row.gitSince === undefined) return row.happens;
  const host = release(gitVersion);
  const since = release(row.gitSince);
  const newer =
    host.major > since.major ||
    (host.major === since.major && host.minor >= since.minor);
  return row.happens && newer;
}

function release(text: string): { major: number; minor: number } {
  const found = /(\d+)\.(\d+)/.exec(text);
  const major = Number(found?.[1]);
  const minor = Number(found?.[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new Error(`not a git version: ${text}`);
  }
  return { major, minor };
}

/** Rows every consumer must answer exactly, whatever its safe direction. */
export function isStrict(row: CorpusRow): boolean {
  return (
    row.role === 'example' ||
    row.role === 'corrected' ||
    row.role === 'near-miss' ||
    row.role === 'positive'
  );
}

export interface Placeholders {
  readonly primary: string;
  readonly gitPath: string;
  /** The checkout the row runs or is judged in, for `{UP}`. */
  readonly cwd: string;
}

/**
 * `{P}` is the main checkout, `{GIT}` git's path, and `{UP}` the relative
 * path from the row's checkout up to the main checkout (with a trailing
 * slash), so a relative row names the main checkout from every checkout.
 */
export function render(text: string, values: Placeholders): string {
  const up = relative(values.cwd, values.primary);
  return text
    .replaceAll('{P}', values.primary)
    .replaceAll('{GIT}', values.gitPath)
    .replaceAll('{UP}', up === '' ? '' : `${up}/`);
}
