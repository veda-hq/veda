/**
 * PostToolUse, PostToolUseFailure and Stop handler: keeps the list of pull
 * requests a session opened, marks each one when the desktop app says
 * Auto-fix is on for it, and warns at turn end about every open one that is
 * neither on nor refused. Warn-only: it never blocks.
 *
 * - Record (PostToolUse, Bash): a command that runs `gh … pr create` adds
 *   every pull request URL its output names, whatever the repository, `-R`,
 *   `--repo` or folder. A background run prints nothing to read, so it adds
 *   nothing.
 * - Confirm (`mcp__ccd_pr__set_monitor`): the app's reply "Auto-fix is on for
 *   owner/repo#N" marks that PR on; "Auto-fix is off for owner/repo#N" marks
 *   it off again. `mcp__ccd_pr__get_status` for this session marks its
 *   primary `pr` from `monitor.auto_fix`, and a primary or `otherBoundPrs`
 *   entry that is merged or closed as closed: the only way a PR leaves the
 *   list, since the handler makes no GitHub call.
 * - Refused (`mcp__ccd_pr__set_monitor`): the transcripts show the app's
 *   refusal as a tool error ("Auto-fix can't be enabled for owner/repo#N:
 *   <reason>", or "owner/repo#N is on the session's PR bar, but … so Auto-fix
 *   can't be enabled for it"). That PR is marked refused with the app's
 *   words. Which hook event carries an error is read, not assumed: the
 *   answer is looked for in both `tool_response` and `error`, on PostToolUse
 *   and PostToolUseFailure alike. An error that names no PR (a missing url)
 *   changes nothing.
 * - Warn (Stop): one `systemMessage` naming each open PR on the list that is
 *   neither on nor refused, with the exact call that switches it on. Silent
 *   when `stop_hook_active` is set, and in any session whose transcript does
 *   not show `mcp__ccd_pr__set_monitor` (a cloud session, a terminal), where
 *   the call cannot be made.
 *
 * The list, the shared state: `<dir>/<session id>.jsonl`, one JSON row per
 * fact, where <dir> is `SARATHI_AUTOFIX_DIR`, else
 * `$XDG_STATE_HOME/sarathi/autofix`, else `~/.local/state/sarathi/autofix`.
 * It is keyed by the Claude session id, not by a folder, so nested clones and
 * other repositories land on the same list.
 * - Rows: `{ "at": ISO time, "pr": "owner/repo#N", "url": PR URL,
 *   "event": "opened" | "on" | "off" | "refused" | "closed" | "warned",
 *   "source": what wrote it, "reason"?: the app's words for a refusal }`.
 *   Another hook adds a PR it opened by appending an `opened` row, or with
 *   `sarathi autofix add <url> --session <id>` (`addOpened`).
 * - Ordering: a PR's state is its latest `on`, `off`, `refused` or `closed`
 *   row; `opened` only puts it on the list, so a second `opened` never undoes
 *   an `on`. `warned` rows are a log for the warn-only period.
 * - Failure cleanup: a short append leaves a partial line, which the next
 *   append's leading newline ends; readers skip lines that are not JSON rows.
 * - Overlap: rows are appended whole (O_APPEND); two hooks racing in one
 *   session each add their own rows.
 * - Input validity: the session id must match SESSION before it names a file;
 *   without one the handler does nothing.
 *
 * Run: node <sarathi>/dist/hooks/autofix.js
 */
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SET_MONITOR = 'mcp__ccd_pr__set_monitor';
export const GET_STATUS = 'mcp__ccd_pr__get_status';

const SESSION = /^[\w.-]{1,128}$/;
/** A pull request URL on any GitHub host: https://<host>/<owner>/<repo>/pull/<N>. */
const PR_URL = /https:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/g;
/** `gh` running `pr create`, global flags such as `-R x` allowed between. */
const PR_CREATE = /(?:^|[\s;&|(`'"/])gh\s(?:[^;&|\n]*?\s)?pr\s+create(?![\w-])/;
const ON = /Auto-fix is on for ([\w.-]+\/[\w.-]+)#(\d+)/;
const OFF = /Auto-fix is off for ([\w.-]+\/[\w.-]+)#(\d+)/;
const REFUSED = /Auto-fix can't be enabled for ([\w.-]+\/[\w.-]+)#(\d+):\s*([^\n]*)/;
/** The app's own pre-call refusal: "owner/repo#N is on the session's PR bar, but … so Auto-fix can't be enabled for it; …". */
const REFUSED_BEFORE = /([\w.-]+\/[\w.-]+)#(\d+) (is on the session's PR bar, but [^\n]*Auto-fix can't be enabled for it[^\n]*)/;

export type State = 'opened' | 'on' | 'off' | 'refused' | 'closed';
export type RowEvent = State | 'warned';

export interface Row {
  readonly at: string;
  readonly pr: string;
  readonly url: string;
  readonly event: RowEvent;
  readonly source: string;
  readonly reason?: string;
}

export interface Pr {
  /** owner/repo#N, as the app writes it. */
  readonly pr: string;
  readonly url: string;
  readonly state: State;
  readonly reason?: string;
}

export interface Deps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The list's folder, from the environment. */
export function listDir(env: Readonly<Record<string, string | undefined>>): string {
  const override = env.SARATHI_AUTOFIX_DIR;
  if (override !== undefined && override !== '') return override;
  const state = env.XDG_STATE_HOME;
  return join(state !== undefined && state !== '' ? state : join(homedir(), '.local', 'state'), 'sarathi', 'autofix');
}

/** The session's list file, or undefined for an id that cannot name one. */
export function listFile(session: unknown, env: Readonly<Record<string, string | undefined>>): string | undefined {
  return typeof session === 'string' && SESSION.test(session) ? join(listDir(env), `${session}.jsonl`) : undefined;
}

/** The key two spellings of one PR share: owner/repo#N in lower case. */
function key(pr: string): string {
  return pr.toLowerCase();
}

/** owner/repo#N and its URL, from a PR URL. */
export function fromUrl(url: string): { pr: string; url: string } | undefined {
  const match = new RegExp(PR_URL.source).exec(url);
  if (match === null) return undefined;
  const [whole, , owner, repo, number] = match;
  return { pr: `${owner}/${repo}#${number}`, url: whole };
}

/** Every distinct PR a text names by URL, in order. */
export function prUrls(text: string): Array<{ pr: string; url: string }> {
  const found = new Map<string, { pr: string; url: string }>();
  for (const match of text.matchAll(PR_URL)) {
    const parsed = fromUrl(match[0]);
    if (parsed !== undefined && !found.has(key(parsed.pr))) found.set(key(parsed.pr), parsed);
  }
  return [...found.values()];
}

/** Does this shell command run `gh pr create`? */
export function runsPrCreate(command: string): boolean {
  return PR_CREATE.test(command);
}

/** The text of a tool's answer: a string, MCP text blocks, or an object holding them. */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (value.content !== undefined) return textOf(value.content);
  return ['stdout', 'stderr', 'output'].map(field => (typeof value[field] === 'string' ? value[field] : '')).join('\n');
}

/** Reads a list file into its rows; a missing file or a broken line gives none. */
export function readRows(file: string): Row[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // fail-open: no list file yet is an empty list
    return [];
  }
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row: unknown = JSON.parse(line);
      if (isRecord(row) && typeof row.pr === 'string' && typeof row.event === 'string') rows.push(row as unknown as Row);
    } catch {
      // fail-open: a partial line from a short append is skipped
    }
  }
  return rows;
}

/** The list: each PR once, in the order first seen, at its latest state. */
export function fold(rows: readonly Row[]): Pr[] {
  const prs = new Map<string, Pr>();
  for (const row of rows) {
    const id = key(row.pr);
    const known = prs.get(id);
    const url = known?.url !== undefined && known.url !== '' ? known.url : (row.url ?? '');
    if (row.event === 'warned') continue;
    if (row.event === 'opened') {
      if (known === undefined) prs.set(id, { pr: row.pr, url, state: 'opened' });
      else if (known.url === '' && url !== '') prs.set(id, { ...known, url });
      continue;
    }
    const next: Pr = { pr: known?.pr ?? row.pr, url, state: row.event };
    prs.set(id, row.event === 'refused' && typeof row.reason === 'string' ? { ...next, reason: row.reason } : next);
  }
  return [...prs.values()];
}

/** Appends rows as one write; the leading newline ends any partial row before them. */
export function appendRows(file: string, rows: readonly Row[]): void {
  if (rows.length === 0) return;
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, `\n${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

/** For another hook: put a PR it opened on a session's list. Returns false when nothing could be added. */
export function addOpened(url: string, session: string, source: string, deps: Deps): boolean {
  const parsed = fromUrl(url);
  const file = listFile(session, deps.env);
  if (parsed === undefined || file === undefined) return false;
  appendRows(file, [{ at: deps.now().toISOString(), ...parsed, event: 'opened', source }]);
  return true;
}

interface HookEvent {
  readonly hook_event_name?: unknown;
  readonly session_id?: unknown;
  readonly transcript_path?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
  readonly error?: unknown;
  readonly stop_hook_active?: unknown;
}

export type Fact = Omit<Row, 'at' | 'event'> & { readonly event: State };

/** The URL the call named for owner/repo#N, else GitHub's. */
function urlFor(pr: string, input: unknown): string {
  const named = isRecord(input) && typeof input.url === 'string' ? fromUrl(input.url) : undefined;
  if (named !== undefined && key(named.pr) === key(pr)) return named.url;
  const [repo, number] = pr.split('#');
  return `https://github.com/${repo}/pull/${number}`;
}

function bashFacts(event: HookEvent): Fact[] {
  const command = isRecord(event.tool_input) && typeof event.tool_input.command === 'string' ? event.tool_input.command : '';
  if (!runsPrCreate(command)) return [];
  return prUrls(textOf(event.tool_response)).map(found => ({ ...found, event: 'opened', source: 'gh pr create' }));
}

/** The app's answer to set_monitor, wherever the hook event carries it: on, off or refused. */
function setMonitorFacts(text: string, input: unknown): Fact[] {
  for (const [pattern, state] of [
    [ON, 'on'],
    [OFF, 'off'],
    [REFUSED, 'refused'],
    [REFUSED_BEFORE, 'refused'],
  ] as const) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const pr = `${match[1]}#${match[2]}`;
    const fact: Fact = { pr, url: urlFor(pr, input), event: state, source: SET_MONITOR };
    return [state === 'refused' ? { ...fact, reason: (match[3] ?? '').trim() } : fact];
  }
  return [];
}

const ENDED = new Set(['merged', 'closed']);

function getStatusFacts(text: string, input: unknown): Fact[] {
  // Only this session's status says anything about this session's list.
  if (isRecord(input) && input.session_id !== undefined && input.session_id !== 'self') return [];
  let status: unknown;
  try {
    status = JSON.parse(text);
  } catch {
    // fail-open: a status that is not JSON says nothing about the list
    return [];
  }
  if (!isRecord(status)) return [];
  const facts: Fact[] = [];
  const primary = status.pr;
  if (isRecord(primary) && typeof primary.url === 'string') {
    const parsed = fromUrl(primary.url);
    const monitor = status.monitor;
    if (parsed !== undefined) {
      const state = typeof primary.state === 'string' ? primary.state.toLowerCase() : '';
      if (ENDED.has(state)) facts.push({ ...parsed, event: 'closed', source: GET_STATUS });
      else if (isRecord(monitor) && typeof monitor.auto_fix === 'boolean') {
        facts.push({ ...parsed, event: monitor.auto_fix ? 'on' : 'off', source: GET_STATUS });
      }
    }
  }
  const others = Array.isArray(status.otherBoundPrs) ? status.otherBoundPrs : [];
  for (const other of others) {
    if (!isRecord(other) || typeof other.repo !== 'string' || typeof other.number !== 'number') continue;
    const state = typeof other.state === 'string' ? other.state.toLowerCase() : '';
    if (!ENDED.has(state)) continue;
    const pr = `${other.repo}#${other.number}`;
    facts.push({ pr, url: urlFor(pr, undefined), event: 'closed', source: GET_STATUS });
  }
  return facts;
}

/** What one tool event says about the list. */
export function factsOf(event: HookEvent): Fact[] {
  const name = event.hook_event_name;
  const tool = event.tool_name;
  if (name !== 'PostToolUse' && name !== 'PostToolUseFailure') return [];
  if (tool === SET_MONITOR) return setMonitorFacts(`${textOf(event.tool_response)}\n${textOf(event.error)}`, event.tool_input);
  if (name !== 'PostToolUse') return [];
  if (tool === 'Bash') return bashFacts(event);
  if (tool === GET_STATUS) return getStatusFacts(textOf(event.tool_response), event.tool_input);
  return [];
}

/**
 * Facts that change the list. `opened` adds a PR not on it; `on` and
 * `refused` count for any PR; `off` only undoes an `on`, and `closed` only
 * ends a PR on the list, so a status read of PRs this session never opened
 * adds nothing. A state the PR already has adds nothing either.
 */
export function news(facts: readonly Fact[], list: readonly Pr[]): Fact[] {
  const known = new Map(list.map(pr => [key(pr.pr), pr]));
  const kept: Fact[] = [];
  for (const fact of facts) {
    const pr = known.get(key(fact.pr));
    const changes =
      fact.event === 'opened'
        ? pr === undefined
        : fact.event === 'off'
          ? pr?.state === 'on'
          : fact.event === 'closed'
            ? pr !== undefined && pr.state !== 'closed'
            : pr === undefined || pr.state !== fact.event || pr.reason !== fact.reason;
    if (!changes) continue;
    kept.push(fact);
    known.set(key(fact.pr), {
      pr: fact.pr,
      url: fact.url,
      state: fact.event,
      ...(fact.reason === undefined ? {} : { reason: fact.reason }),
    });
  }
  return kept;
}

/**
 * Does the transcript show the app's set_monitor tool? Its deferred-tools
 * entries (`deferred_tools_record` entries, `deferred_tools_delta`
 * addedNames) or a call to it count; a mention in text does not.
 */
export function hasSetMonitor(path: unknown): boolean {
  if (typeof path !== 'string' || path === '') return false;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // fail-open: an unreadable transcript shows no tool, so nothing warns
    return false;
  }
  for (const line of text.split('\n')) {
    if (!line.includes(SET_MONITOR)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // fail-open: a line that is not JSON shows nothing
      continue;
    }
    if (!isRecord(entry)) continue;
    const record = entry.attachment;
    if (isRecord(record)) {
      const entries = Array.isArray(record.entries) ? record.entries : [];
      if (entries.some(item => isRecord(item) && item.name === SET_MONITOR)) return true;
      const added = Array.isArray(record.addedNames) ? record.addedNames : [];
      if (added.includes(SET_MONITOR)) return true;
    }
    const content = isRecord(entry.message) ? entry.message.content : undefined;
    if (Array.isArray(content) && content.some(item => isRecord(item) && item.type === 'tool_use' && item.name === SET_MONITOR)) {
      return true;
    }
  }
  return false;
}

/** The exact call that switches Auto-fix on for one PR. */
export function callFor(pr: Pr): string {
  return `${SET_MONITOR} ${JSON.stringify({ url: pr.url, auto_fix: true, address_comments: true })}`;
}

/** The turn-end warning for the PRs still waiting, or '' for none. */
export function warning(waiting: readonly Pr[]): string {
  if (waiting.length === 0) return '';
  const lines = waiting.map(pr => `- ${pr.pr}${pr.state === 'off' ? ' (switched off)' : ''}: ${callFor(pr)}`);
  return [
    `sarathi: Auto-fix is not on for ${waiting.length === 1 ? 'a pull request' : `${waiting.length} pull requests`} this session opened, so nothing wakes it for CI failures, conflicts or review comments. Make the call for each:`,
    ...lines,
    'If the app refuses one, tell the user its reason; they can switch it on themselves from the PR bar. One that has merged or closed leaves this list at the next mcp__ccd_pr__get_status that shows it so. (Warn-only for now: the turn ends either way.)',
  ].join('\n');
}

function stop(event: HookEvent, file: string, deps: Deps): string {
  if (event.stop_hook_active === true) return '';
  const waiting = fold(readRows(file)).filter(pr => pr.state === 'opened' || pr.state === 'off');
  if (waiting.length === 0) return '';
  if (deps.env.CLAUDE_CODE_REMOTE === 'true' || !hasSetMonitor(event.transcript_path)) return '';
  const at = deps.now().toISOString();
  try {
    appendRows(
      file,
      waiting.map(pr => ({ at, pr: pr.pr, url: pr.url, event: 'warned', source: 'Stop' })),
    );
  } catch {
    // fail-open: the warning still shows when its log row cannot be written
  }
  return JSON.stringify({ systemMessage: warning(waiting) });
}

/** The most of one event `keepRaw` keeps. */
const RAW_LIMIT = 16_384;

/**
 * Keeps each `mcp__ccd_pr__*` event as the hook received it, beside the
 * list (`<session id>.raw.jsonl`), so the first real install shows the exact
 * `tool_response` and `error` the app's tools hand a hook: what the list is
 * read from, so far known only from transcripts. Rare and small; Bash events
 * are not kept.
 */
function keepRaw(event: HookEvent, file: string, deps: Deps): void {
  if (typeof event.tool_name !== 'string' || !event.tool_name.startsWith('mcp__ccd_pr__')) return;
  const text = JSON.stringify(event);
  const row = { at: deps.now().toISOString(), event: text.length > RAW_LIMIT ? `${text.slice(0, RAW_LIMIT)}…` : event };
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    appendFileSync(file.replace(/\.jsonl$/, '.raw.jsonl'), `\n${JSON.stringify(row)}\n`);
  } catch {
    // fail-open: the copy is evidence only; the list is still kept
  }
}

/** The hook's whole answer for one raw stdin: the JSON to print, or '' for none. Never throws. */
export function respond(raw: string, deps: Deps): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return '';
    const event = parsed as HookEvent;
    const file = listFile(event.session_id, deps.env);
    if (file === undefined) return '';
    if (event.hook_event_name === 'Stop') return stop(event, file, deps);
    keepRaw(event, file, deps);
    const facts = factsOf(event);
    if (facts.length === 0) return '';
    const fresh = news(facts, fold(readRows(file)));
    const at = deps.now().toISOString();
    appendRows(
      file,
      fresh.map(fact => ({ at, ...fact })),
    );
    return '';
  } catch {
    // fail-open: a warning is advice; on any doubt the call goes ahead with none
    return '';
  }
}

export const AUTOFIX_USAGE = `usage: sarathi autofix add <pr-url> [--session <id>] [--source <name>]
       sarathi autofix list [--session <id>]
`;

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/**
 * `sarathi autofix`: another hook's way onto a session's list (`add`), and a
 * look at it (`list`). The session defaults to CLAUDE_CODE_SESSION_ID, which
 * the CLI sets for every command and hook it runs.
 */
export function autofixCommand(args: readonly string[], io: CliIo): number {
  const [verb, ...rest] = args;
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? '';
    if (arg === '--session' || arg === '--source') {
      const value = rest[index + 1];
      if (value === undefined || value === '') {
        io.err(`sarathi autofix: ${arg} needs a value\n${AUTOFIX_USAGE}`);
        return 1;
      }
      flags.set(arg, value);
      index += 1;
    } else if (arg.startsWith('--')) {
      io.err(`sarathi autofix: unknown option ${arg}\n${AUTOFIX_USAGE}`);
      return 1;
    } else {
      positional.push(arg);
    }
  }
  const session = flags.get('--session') ?? io.env.CLAUDE_CODE_SESSION_ID ?? '';
  const file = listFile(session, io.env);
  if (file === undefined) {
    io.err(`sarathi autofix: no usable session id (pass --session, or run inside a Claude Code session)\n`);
    return 1;
  }
  if (verb === 'add' && positional.length === 1) {
    const url = positional[0] ?? '';
    if (!addOpened(url, session, flags.get('--source') ?? 'sarathi autofix add', io)) {
      io.err(`sarathi autofix: ${url} is not a pull request URL (https://<host>/<owner>/<repo>/pull/<N>)\n`);
      return 1;
    }
    io.out(`sarathi autofix: ${fromUrl(url)?.pr} is on session ${session}'s list (${file})\n`);
    return 0;
  }
  if (verb === 'list' && positional.length === 0) {
    for (const pr of fold(readRows(file))) io.out(`${pr.pr}\t${pr.state}\t${pr.url}${pr.reason === undefined ? '' : `\t${pr.reason}`}\n`);
    return 0;
  }
  io.err(AUTOFIX_USAGE);
  return 1;
}

async function main(): Promise<void> {
  let raw = '';
  for await (const chunk of process.stdin) raw += String(chunk);
  process.stdout.write(respond(raw, { env: process.env, now: () => new Date() }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
