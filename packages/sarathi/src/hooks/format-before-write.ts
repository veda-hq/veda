/**
 * PreToolUse handler (Edit|Write): hands the tool prettier-formatted input,
 * so the file is formatted as it is written.
 *
 * Formatting after the write (hooks/format-on-edit.sh) makes Claude Code tell
 * the model "PostToolUse hook modified <file> after your edit", one notice per
 * reformatting edit, kept in context for the rest of the session. Formatting
 * the input instead leaves the post-write formatter nothing to change, so no
 * notice. format-on-edit stays as the net for anything this skips.
 *
 * Write: `content` is formatted whole. Edit: the edit is applied to the file
 * in memory, the result formatted, and the edit rewritten as the smallest
 * unique old_string → new_string that yields the formatted file.
 *
 * Never blocks. On every doubt (unparseable code mid-edit, a non-unique old_string,
 * a file outside the checkout, no prettier) it prints nothing and the tool runs
 * as asked.
 *
 * Run: node <sarathi>/dist/hooks/format-before-write.js
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORMATTED = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.yml', '.yaml', '.css']);

/** The part of prettier's API this handler uses. */
export interface Prettier {
  getFileInfo(path: string, options: { ignorePath: string }): Promise<{ ignored: boolean; inferredParser: string | null }>;
  resolveConfig(path: string): Promise<Record<string, unknown> | null>;
  format(text: string, options: Record<string, unknown>): Promise<string>;
}

export interface ToolEvent {
  readonly tool_name?: unknown;
  readonly tool_input?: Record<string, unknown>;
  readonly cwd?: unknown;
}

export interface Edit {
  readonly old_string: string;
  readonly new_string: string;
}

/**
 * The session's checkout: the git toplevel of the hook input's `cwd`. Not
 * $CLAUDE_PROJECT_DIR: the desktop app sets that to the main checkout for a
 * worktree session, and every desktop worktree lies under main, so it would
 * admit any worktree's files and judge them by main's .prettierignore.
 * Without a usable `cwd`, $CLAUDE_PROJECT_DIR, then the current directory.
 */
export function sessionRoot(event: ToolEvent, env: NodeJS.ProcessEnv = process.env): string {
  const cwd = event.cwd;
  if (typeof cwd === 'string' && cwd !== '') {
    try {
      const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (top !== '') return realpathSync(top);
    } catch {
      // Not a directory or not a work tree: fall back.
    }
  }
  return realpathSync(env['CLAUDE_PROJECT_DIR'] || process.cwd());
}

/**
 * The session checkout's prettier; the project checkout's when that one has
 * none installed (a fresh worktree before its first install). `null` when
 * neither has one.
 */
export function loadPrettier(root: string, env: NodeJS.ProcessEnv = process.env): Prettier | null {
  const bases = [root, env['CLAUDE_PROJECT_DIR']].filter((b): b is string => typeof b === 'string' && b !== '');
  for (const base of bases) {
    try {
      return createRequire(join(base, 'package.json'))('prettier') as Prettier;
    } catch {
      // Try the next checkout.
    }
  }
  return null;
}

/** Same scope as format-on-edit.sh: inside the checkout, not scratch, not a link. */
function inScope(filePath: string, mustExist: boolean, repoRoot: string): boolean {
  if (!FORMATTED.has(extname(filePath))) return false;
  if (/(^|\/)\.(tmp|local)\//.test(filePath)) return false;
  let dir: string;
  try {
    dir = realpathSync(dirname(filePath));
  } catch {
    return false;
  }
  if (dir !== repoRoot && !dir.startsWith(repoRoot + sep)) return false;
  try {
    if (lstatSync(filePath).isSymbolicLink()) return false;
  } catch {
    if (mustExist) return false;
  }
  return true;
}

/** Index of the only occurrence of needle in haystack, or -1. */
function uniqueIndex(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle);
  if (at === -1 || haystack.indexOf(needle, at + 1) !== -1) return -1;
  return at;
}

/**
 * The smallest old → new replacement turning `before` into `after`, grown a
 * line at a time until old is non-empty and unique in `before`.
 */
export function minimalEdit(before: string, after: string): Edit | null {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < shortest - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  let from = start;
  let beforeEnd = before.length - tail;
  let afterEnd = after.length - tail;
  for (;;) {
    const old = before.slice(from, beforeEnd);
    if (old !== '' && uniqueIndex(before, old) === from) {
      return { old_string: old, new_string: after.slice(from, afterEnd) };
    }
    if (from === 0 && beforeEnd === before.length) return null;
    // Back to the start of this line, or of the previous one when already there.
    const lineStart = from < 2 ? -1 : before.lastIndexOf('\n', from - 2);
    from = lineStart === -1 ? 0 : lineStart + 1;
    const lineEnd = before.indexOf('\n', beforeEnd + 1);
    const grow = (lineEnd === -1 ? before.length : lineEnd) - beforeEnd;
    beforeEnd += grow;
    afterEnd += grow;
  }
}

/** The Edit tool's own semantics: exactly one match, or every match with replace_all. */
function applyEdit(current: string, input: Record<string, unknown>): string | null {
  const { old_string: oldString, new_string: newString, replace_all: all } = input;
  if (typeof oldString !== 'string' || typeof newString !== 'string' || oldString === '') return null;
  if (all === true) return current.split(oldString).join(newString);
  const at = uniqueIndex(current, oldString);
  if (at === -1) return null;
  return current.slice(0, at) + newString + current.slice(at + oldString.length);
}

async function format(prettier: Prettier, filePath: string, text: string, repoRoot: string): Promise<string | null> {
  const info = await prettier.getFileInfo(filePath, { ignorePath: join(repoRoot, '.prettierignore') });
  if (info.ignored || !info.inferredParser) return null;
  const options = (await prettier.resolveConfig(filePath)) ?? {};
  return prettier.format(text, { ...options, filepath: filePath });
}

/** The tool input to run instead, or `null` to let the tool run as asked. */
export async function updatedInput(
  event: ToolEvent,
  prettier: Prettier,
  root: string,
): Promise<Record<string, unknown> | null> {
  const input = event.tool_input ?? {};
  const filePath = input['file_path'];
  if (typeof filePath !== 'string' || filePath === '') return null;

  if (event.tool_name === 'Write') {
    const content = input['content'];
    if (typeof content !== 'string' || !inScope(filePath, false, root)) return null;
    const formatted = await format(prettier, filePath, content, root);
    if (formatted === null || formatted === content) return null;
    return { ...input, content: formatted };
  }

  if (event.tool_name === 'Edit') {
    if (!inScope(filePath, true, root)) return null;
    const current = readFileSync(filePath, 'utf8');
    const edited = applyEdit(current, input);
    if (edited === null) return null;
    const formatted = await format(prettier, filePath, edited, root);
    if (formatted === null || formatted === edited || formatted === current) return null;
    const edit = minimalEdit(current, formatted);
    if (edit === null) return null;
    return { file_path: filePath, ...edit, replace_all: false };
  }
  return null;
}

/** The hook's whole answer for one raw stdin: the JSON to print, or '' for none. Never throws. */
export async function respond(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const event = JSON.parse(raw) as ToolEvent;
    const root = sessionRoot(event, env);
    const prettier = loadPrettier(root, env);
    if (prettier === null) return '';
    const next = await updatedInput(event, prettier, root);
    if (next === null) return '';
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: next } });
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  let raw = '';
  for await (const chunk of process.stdin) raw += String(chunk);
  process.stdout.write(await respond(raw));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
