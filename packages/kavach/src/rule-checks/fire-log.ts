/**
 * The fire log: one JSON line per check that refused, warned, was passed with
 * a stated reason, or crashed.
 *
 * Where: the folder the caller names (`firesDir`'s override: the runtime's
 * `firesDir` option, the CLI's `--fires-dir` or `KAVACH_RULE_FIRES_DIR`), else
 * `<primary checkout>/.tmp/rule-checks/fires.jsonl`, the checkout that owns
 * the git common directory, so rows from every worktree land in one file and
 * outlive the worktree.
 *
 * Shared state, written by hooks running in parallel across sessions:
 * - Ordering: nothing claims or waits on the file; readers only read history.
 * - Failure cleanup: a failed or short append leaves no row or one partial
 *   line, never a stale record another process trusts, and throws so the
 *   runtime reports the missed row. A short write is not retried: a second
 *   append could land after another writer's row and split this one. The next
 *   append starts on a fresh line, so only the partial line fails to parse,
 *   and a reader skips it.
 * - Overlap: every append is one write of whole lines (O_APPEND);
 *   rows are short (the excerpt is capped), nothing truncates, rewrites or
 *   sweeps the file, so writers cannot erase each other's rows. Two writers
 *   that both find a partial line both start a fresh one: one empty line.
 * - Input validity: rows are built here from typed values; nothing in this
 *   module reads the file back.
 * Accepted limit: an append on a network filesystem may interleave; keep the
 *   folder on a local disk.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Outcome = 'refused' | 'warned' | 'excepted' | 'crashed';

export type FireRow = {
  readonly ts: string;
  readonly rule: string;
  readonly outcome: Outcome;
  readonly branch: string;
  readonly excerpt: string;
  readonly reason?: string;
};

export const EXCERPT_MAX = 120;
export const FIRES_FILE = 'fires.jsonl';
/** The environment variable the CLI reads the fire-log folder from. */
export const FIRES_DIR_ENV = 'KAVACH_RULE_FIRES_DIR';

/** `value` on one line, at most `max` characters, an ellipsis marking a cut. */
export function clip(value: string, max: number = EXCERPT_MAX): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export type Git = (root: string, args: readonly string[]) => string;

/**
 * The folder the fire log lives in for a session whose checkout is `root`:
 * `override` when it names one, else `.tmp/rule-checks` in the primary checkout.
 */
export function firesDir(override: string | undefined, root: string, git: Git): string {
  if (override !== undefined && override !== '') return override;
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return join(dirname(common), '.tmp', 'rule-checks');
}

/** The branch checked out at `root`; `HEAD` when detached, `unknown` outside git. */
export function branchAt(root: string, git: Git): string {
  try {
    return git(root, ['branch', '--show-current']) || 'HEAD';
  } catch {
    // fail-open: a row without its branch still records the fire.
    return 'unknown';
  }
}

/** A newline when the log ends in a partial line a failed append left. */
function freshLine(fd: number): string {
  const { size } = fstatSync(fd);
  if (size === 0) return '';
  const last = Buffer.alloc(1);
  readSync(fd, last, 0, 1, size - 1);
  return last.toString() === '\n' ? '' : '\n';
}

/** `writeSync` of a whole buffer: the bytes it wrote. */
export type Write = (fd: number, bytes: Buffer) => number;

export function appendFires(dir: string, rows: readonly FireRow[], write: Write = writeSync): void {
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, FIRES_FILE), 'a+');
  try {
    const lines = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
    const bytes = Buffer.from(freshLine(fd) + lines);
    const wrote = write(fd, bytes);
    if (wrote !== bytes.length) throw new Error(`fire log: wrote ${wrote} of ${bytes.length} bytes`);
  } finally {
    closeSync(fd);
  }
}
