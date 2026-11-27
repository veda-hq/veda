/**
 * PreToolUse handler for a session's direct claude.ai publishes: refuses a
 * `publish_version`, `publish_files` or `edit_version` call whose page has
 * no whole action box, as `sarathi page` refuses to send one
 * (`requireActionBox`, README "The action box").
 *
 * - `publish_version`: its `content` is judged.
 * - `publish_files`: each file it serves as `index.html`, read from its
 *   `path`. A republish that sends no `index.html` leaves the page as it was,
 *   and passes.
 * - `edit_version` on the page (no `path`, or `index.html`): the live page is
 *   not in the hook's input, so only what the edits themselves show is
 *   judged: an edit that takes out an action-box marker is refused. An edit
 *   to another file passes.
 *
 * Tools are matched by suffix, not by the server's id, which a reconnected
 * server can change (docs/lessons/claude-code.md). A refusal exits 2 with its
 * reason. So does any fault: an uncaught throw would exit 1, which Claude
 * Code lets through.
 *
 * Run: node <sarathi>/dist/hooks/action-box.js
 */
import { readFileSync } from 'node:fs';
import { detail, isEntry, readInput } from '../page/guard.ts';
import { requireActionBox } from '../page/page.ts';

/** The publishing tools this handler judges, by suffix. */
export const PUBLISH_TOOL = /^mcp__.+__(publish_version|publish_files|edit_version)$/;

/** The attributes an action box is made of; an edit may not take one out. */
export const MARKERS = ['data-action-box', 'data-action-link', 'data-if-silent'] as const;

const PAGE = 'index.html';

export interface ToolEvent {
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A served path as the artifact names it: `./index.html` and `/index.html` are `index.html`. */
export function servedPath(path: string): string {
  return path.replace(/^(?:\.?\/)+/, '');
}

/** How many times `marker` occurs in `text`. */
export function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/** Each served-as-`index.html` file `publish_files` sends, read through `read`. */
function filesSent(input: Record<string, unknown>, read: (path: string) => string): Array<[string, string]> {
  const files = input.files;
  if (!Array.isArray(files)) throw new Error('publish_files names no files list');
  const pages: Array<[string, string]> = [];
  for (const file of files) {
    if (!isRecord(file) || typeof file.as !== 'string' || servedPath(file.as) !== PAGE) continue;
    if (typeof file.path !== 'string' || file.path === '') {
      throw new Error(`publish_files serves ${PAGE} with no path to read it from`);
    }
    pages.push([file.path, read(file.path)]);
  }
  return pages;
}

/** The markers an `edit_version` call's edits take out: fewer in all its new texts than in all its old ones. */
export function markersRemoved(input: Record<string, unknown>): string[] {
  const edits = input.edits;
  if (!Array.isArray(edits)) throw new Error('edit_version names no edits');
  let before = '';
  let after = '';
  for (const edit of edits) {
    if (!isRecord(edit) || typeof edit.old_text !== 'string' || typeof edit.new_text !== 'string') {
      throw new Error('edit_version has an edit without old_text and new_text');
    }
    before += `${edit.old_text}\n`;
    after += `${edit.new_text}\n`;
  }
  return MARKERS.filter(marker => occurrences(after, marker) < occurrences(before, marker));
}

/** Why the call is refused, or undefined to let it run. Throws on input it cannot judge. */
export function decide(event: ToolEvent, read: (path: string) => string): string | undefined {
  if (typeof event.tool_name !== 'string') throw new Error('hook input names no tool');
  const tool = PUBLISH_TOOL.exec(event.tool_name)?.[1];
  if (tool === undefined) return undefined;
  const input = event.tool_input;
  if (!isRecord(input)) throw new Error(`${tool} has no input`);
  try {
    if (tool === 'publish_version') {
      if (typeof input.content !== 'string') throw new Error('publish_version sends no content');
      requireActionBox('the page publish_version sends', input.content);
    } else if (tool === 'publish_files') {
      for (const [path, html] of filesSent(input, read)) requireActionBox(path, html);
    } else {
      if (typeof input.path === 'string' && servedPath(input.path) !== PAGE) return undefined;
      const removed = markersRemoved(input);
      if (removed.length > 0) {
        return `this edit_version takes ${removed.join(', ')} out of the page; an action box keeps all of ${MARKERS.join(', ')} before the page's first <h2>`;
      }
    }
  } catch (error) {
    // fail-open: the error becomes the refusal's reason, so the call is refused.
    return detail(error);
  }
  return undefined;
}

/** Hook entry: the exit code, 2 with the reason on `err` for a refusal or a fault. */
export function main(stdin: string, read: (path: string) => string, err: (text: string) => void): number {
  try {
    const reason = decide(JSON.parse(stdin) as ToolEvent, read);
    if (reason === undefined) return 0;
    err(`sarathi action box: ${reason}\n`);
  } catch (error) {
    // fail-open: the fault becomes code 2, which refuses the call.
    err(`sarathi action box: ${detail(error)}; the call is refused\n`);
  }
  return 2;
}

export const readText = (path: string): string => readFileSync(path, 'utf8');

/** The hook run on real input: the verdict becomes the process exit code. */
export function hook(stdin: string): void {
  process.exitCode = main(stdin, readText, text => process.stderr.write(text));
}

/** Reads the hook input from `stdin` into `run` when `script` is this module; imported, it does nothing. */
export function start(script: string | undefined, moduleUrl: string, stdin: NodeJS.ReadableStream, run: (text: string) => void): void {
  if (isEntry(script, moduleUrl)) readInput(stdin, run);
}

start(process.argv[1], import.meta.url, process.stdin, hook);
