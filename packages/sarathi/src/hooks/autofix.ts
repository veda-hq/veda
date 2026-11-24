/**
 * PostToolUse and PostToolUseFailure handler: keeps the list of pull requests
 * a session opened, marks each one when the desktop app says Auto-fix is on
 * for it, and tells the model, in its context, about every open one that is
 * neither on nor refused. Warn-only: it never blocks.
 *
 * - Record (PostToolUse, Bash): a command that runs `gh … pr create` adds
 *   every pull request URL its output names, whatever the repository, `-R`,
 *   `--repo` or folder. A background run (`run_in_background`) prints
 *   nothing to read, so it adds nothing.
 * - Confirm (`mcp__ccd_pr__set_monitor`): the app's reply "Auto-fix is on for
 *   owner/repo#N" marks that PR on; "Auto-fix is off for owner/repo#N" marks
 *   it off again. `mcp__ccd_pr__get_status` for this session marks its
 *   primary `pr` from `monitor.auto_fix`, and a primary or `otherBoundPrs`
 *   entry that is merged or closed as closed: the only way a PR leaves the
 *   list, since the handler makes no GitHub call.
 * - Refused (`mcp__ccd_pr__set_monitor`): the transcripts show the app's
 *   refusal as a tool error ("Auto-fix can't be enabled for owner/repo#N:
 *   <reason>", "owner/repo#N is on the session's PR bar, but … so Auto-fix
 *   can't be enabled for it", or "owner/repo#N is not bound to this
 *   session."). That PR is marked refused with the app's
 *   words. Which hook event carries an error is read, not assumed: the
 *   answer is looked for in both `tool_response` and `error`, on PostToolUse
 *   and PostToolUseFailure alike. An error that names no PR (a missing url)
 *   changes nothing.
 * - Warn (PostToolUse): `hookSpecificOutput.additionalContext`, which
 *   reaches the model, naming each waiting PR (`opened` or `off`) with the
 *   exact call that switches it on, and a `warned` row per PR:
 *   - on `mcp__ccd_turn__wrap_up`, every waiting PR on the list, so one
 *     another hook added (`sarathi autofix add`) is warned at the next one;
 *   - on the Bash call that records a PR, that PR at once;
 *   - on a Bash call with `run_in_background: true` that runs `gh pr create`,
 *     that the PR is not on the list and the way out in the foreground (no
 *     row: there is no PR to name).
 *   Silent in any session whose transcript does not show
 *   `mcp__ccd_pr__set_monitor` (a cloud session, a terminal), where the call
 *   cannot be made. Stop says nothing: a Stop `systemMessage` reached neither
 *   the model nor the user (veda#92), and a config that still wires Stop
 *   gets ''.
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
export const WRAP_UP = 'mcp__ccd_turn__wrap_up';

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
/** The app's answer for a PR not bound to the session: "owner/repo#N is not bound to this session." (veda#153). */
const NOT_BOUND = /([\w.-]+\/[\w.-]+)#(\d+) (is not bound to this session[^\n]*)/;

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

/** owner/repo#N and its URL, from one match of PR_URL. */
function prOf([whole, , owner, repo, number]: RegExpExecArray): { pr: string; url: string } {
  return { pr: `${owner}/${repo}#${number}`, url: whole };
}

/** owner/repo#N and its URL, from a PR URL. */
export function fromUrl(url: string): { pr: string; url: string } | undefined {
  const match = new RegExp(PR_URL.source).exec(url);
  return match === null ? undefined : prOf(match);
}

/** Every distinct PR a text names by URL, in order. */
export function prUrls(text: string): Array<{ pr: string; url: string }> {
  const found = new Map<string, { pr: string; url: string }>();
  for (const match of text.matchAll(PR_URL)) {
    const parsed = prOf(match);
    if (!found.has(key(parsed.pr))) found.set(key(parsed.pr), parsed);
  }
  return [...found.values()];
}

/** Does this shell command run `gh pr create`? Anything but a string runs nothing. */
export function runsPrCreate(command: unknown): boolean {
  return typeof command === 'string' && PR_CREATE.test(command);
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
    try {
      const row: unknown = JSON.parse(line);
      if (isRecord(row) && typeof row.pr === 'string' && typeof row.event === 'string') rows.push(row as unknown as Row);
    } catch {
      // fail-open: a blank line, which JSON.parse refuses too, or a partial line from a short append is skipped
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
      // A second `opened` changes only a URL the PR did not have yet: `url` above keeps one it had.
      prs.set(id, known === undefined ? { pr: row.pr, url, state: 'opened' } : { ...known, url });
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

/** Puts the PR at `url` on the list in `file`: its owner/repo#N, or undefined when `url` names none. */
function putOpened(file: string, url: string, source: string, clock: Pick<Deps, 'now'>): string | undefined {
  const parsed = fromUrl(url);
  if (parsed === undefined) return undefined;
  appendRows(file, [{ at: clock.now().toISOString(), ...parsed, event: 'opened', source }]);
  return parsed.pr;
}

/** For another hook: put a PR it opened on a session's list. Returns false when nothing could be added. */
export function addOpened(url: string, session: unknown, source: string, deps: Deps): boolean {
  const file = listFile(session, deps.env);
  return file !== undefined && putOpened(file, url, source, deps) !== undefined;
}

interface HookEvent {
  readonly hook_event_name?: unknown;
  readonly session_id?: unknown;
  readonly transcript_path?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
  readonly error?: unknown;
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
  if (!runsPrCreate(isRecord(event.tool_input) ? event.tool_input.command : undefined)) return [];
  return prUrls(textOf(event.tool_response)).map(found => ({ ...found, event: 'opened', source: 'gh pr create' }));
}

/** The app's answer to set_monitor, wherever the hook event carries it: on, off or refused. */
function setMonitorFacts(text: string, input: unknown): Fact[] {
  for (const [pattern, state] of [
    [ON, 'on'],
    [OFF, 'off'],
    [REFUSED, 'refused'],
    [REFUSED_BEFORE, 'refused'],
    [NOT_BOUND, 'refused'],
  ] as const) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const pr = `${match[1]}#${match[2]}`;
    const fact: Fact = { pr, url: urlFor(pr, input), event: state, source: SET_MONITOR };
    // Every refusal pattern's third group takes part in any match it makes, if only as ''.
    return [state === 'refused' ? { ...fact, reason: (match[3] as string).trim() } : fact];
  }
  return [];
}

const ENDED = new Set(['merged', 'closed']);

/** Does a status's `state` say the PR merged or closed, in any case? */
function ended(state: unknown): boolean {
  return typeof state === 'string' && ENDED.has(state.toLowerCase());
}

function getStatusFacts(text: string, input: unknown): Fact[] {
  // Only this session's status says anything about this session's list.
  if (isRecord(input) && input.session_id !== undefined && input.session_id !== 'self') return [];
  let status: unknown;
  try {
    status = JSON.parse(text);
  } catch {
    // fail-open: a status that is not JSON says nothing about the list; status stays undefined, which the next line refuses
  }
  if (!isRecord(status)) return [];
  const facts: Fact[] = [];
  const primary = status.pr;
  if (isRecord(primary) && typeof primary.url === 'string') {
    const parsed = fromUrl(primary.url);
    const monitor = status.monitor;
    if (parsed !== undefined) {
      if (ended(primary.state)) facts.push({ ...parsed, event: 'closed', source: GET_STATUS });
      else if (isRecord(monitor) && typeof monitor.auto_fix === 'boolean') {
        facts.push({ ...parsed, event: monitor.auto_fix ? 'on' : 'off', source: GET_STATUS });
      }
    }
  }
  const others = status.otherBoundPrs;
  if (Array.isArray(others)) {
    for (const other of others) {
      if (!isRecord(other) || typeof other.repo !== 'string' || typeof other.number !== 'number' || !ended(other.state)) continue;
      const pr = `${other.repo}#${other.number}`;
      facts.push({ pr, url: urlFor(pr, undefined), event: 'closed', source: GET_STATUS });
    }
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
  const known = new Map<string, { readonly state: State; readonly reason?: string | undefined }>(list.map(pr => [key(pr.pr), pr]));
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
    // Only a PR's state and reason decide what changes it; a reason left undefined compares as one never given.
    known.set(key(fact.pr), { state: fact.event, reason: fact.reason });
  }
  return kept;
}

/**
 * Does the transcript show the app's set_monitor tool? Its deferred-tools
 * entries (`deferred_tools_record` entries, `deferred_tools_delta`
 * addedNames) or a call to it count; a mention in text does not.
 */
export function hasSetMonitor(path: unknown): boolean {
  // A number would name an open file descriptor; '' names no file, and the read below fails on it.
  if (typeof path !== 'string') return false;
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
      // fail-open: a line that is not JSON shows nothing; entry stays undefined, which the next line skips
    }
    if (!isRecord(entry)) continue;
    const record = entry.attachment;
    if (isRecord(record)) {
      if (Array.isArray(record.entries) && record.entries.some(item => isRecord(item) && item.name === SET_MONITOR)) return true;
      if (Array.isArray(record.addedNames) && record.addedNames.includes(SET_MONITOR)) return true;
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

/**
 * The warning for the PRs still waiting, or '' for none. `opened`: the Bash
 * call that just recorded them; `wrap_up`, the default: the turn's wrap-up.
 */
export function warning(waiting: readonly Pr[], when?: 'opened' | 'wrap_up'): string {
  if (waiting.length === 0) return '';
  const lines = waiting.map(pr => `- ${pr.pr}${pr.state === 'off' ? ' (switched off)' : ''}: ${callFor(pr)}`);
  const what = waiting.length === 1 ? 'a pull request' : `${waiting.length} pull requests`;
  const lead =
    when === 'opened'
      ? `sarathi: you just opened ${what}, and Auto-fix is not on for ${waiting.length === 1 ? 'it' : 'them'}, so nothing will wake this session for its CI failures, merge conflicts or review comments. Make this call now for each:`
      : `sarathi: Auto-fix is not on for ${what} this session opened, so nothing wakes this session for its CI failures, merge conflicts or review comments. Make this call for each before you end the turn:`;
  return [
    lead,
    ...lines,
    `If the app refuses one, tell the user its reason; they can switch it on themselves from the PR bar. One that has merged or closed leaves this list at the next ${GET_STATUS} that shows it so. (Warn-only: nothing is blocked.)`,
  ].join('\n');
}

/** What a background `gh pr create` gets: the PR is not on the list, and the way out in the foreground. */
export const BACKGROUND_NOTE = [
  'sarathi: this `gh pr create` runs in the background, so its output, the pull request URL, never reaches this hook: the PR is not on this session’s Auto-fix list, and the app will not trust it as this session’s PR, so Auto-fix cannot be switched on for it as it stands.',
  'For this PR: once the background run ends, take the PR URL from its output (or from `gh pr view --json url`), write `<pr-created>URL</pr-created>` with it in your reply, and do not run `gh pr create` again: the PR exists.',
  `Then call ${SET_MONITOR} {"url":"<the PR URL>","auto_fix":true,"address_comments":true}.`,
  'Next time, run `gh pr create` in the foreground, so its URL reaches the list and the app. (Warn-only: nothing is blocked.)',
].join('\n');

/** Can this session make the set_monitor call? Not in a cloud session, nor where the transcript does not show the tool. */
function canCall(event: HookEvent, deps: Deps): boolean {
  return deps.env.CLAUDE_CODE_REMOTE !== 'true' && hasSetMonitor(event.transcript_path);
}

/** The hook answer that puts `text` in the model's context after this tool call. */
function toModel(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
}

function isWaiting(pr: Pr): boolean {
  return pr.state === 'opened' || pr.state === 'off';
}

/** Warns the model about `waiting` and logs a `warned` row for each; '' for none or where the call cannot be made. */
function warn(waiting: readonly Pr[], when: 'opened' | 'wrap_up', event: HookEvent, file: string, deps: Deps): string {
  if (waiting.length === 0 || !canCall(event, deps)) return '';
  const at = deps.now().toISOString();
  const source = when === 'wrap_up' ? WRAP_UP : 'gh pr create';
  try {
    appendRows(
      file,
      waiting.map(pr => ({ at, pr: pr.pr, url: pr.url, event: 'warned', source })),
    );
  } catch {
    // fail-open: the warning still reaches the model when its log row cannot be written
  }
  return toModel(warning(waiting, when));
}

/** Does this Bash event run `gh pr create` with `run_in_background: true`? */
export function runsInBackground(event: HookEvent): boolean {
  const input = event.tool_input;
  return isRecord(input) && input.run_in_background === true && runsPrCreate(input.command);
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
export function keepRaw(event: HookEvent, file: string, deps: Deps): void {
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
    // JSON null throws at its first field read, into the catch below; any other value that is no object has no session id.
    const event = JSON.parse(raw) as HookEvent;
    const file = listFile(event.session_id, deps.env);
    if (file === undefined) return '';
    if (event.hook_event_name !== 'PostToolUse' && event.hook_event_name !== 'PostToolUseFailure') return '';
    keepRaw(event, file, deps);
    const post = event.hook_event_name === 'PostToolUse';
    if (post && event.tool_name === WRAP_UP) return warn(fold(readRows(file)).filter(isWaiting), 'wrap_up', event, file, deps);
    if (post && event.tool_name === 'Bash' && runsInBackground(event)) return canCall(event, deps) ? toModel(BACKGROUND_NOTE) : '';
    const facts = factsOf(event);
    if (facts.length === 0) return '';
    const fresh = news(facts, fold(readRows(file)));
    const at = deps.now().toISOString();
    appendRows(
      file,
      fresh.map(fact => ({ at, ...fact })),
    );
    // Bash gives facts only on PostToolUse (factsOf), so a Bash event here is one.
    if (event.tool_name !== 'Bash') return '';
    const named = new Set(facts.map(fact => key(fact.pr)));
    return warn(
      fold(readRows(file)).filter(pr => named.has(key(pr.pr)) && isWaiting(pr)),
      'opened',
      event,
      file,
      deps,
    );
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
  // One iterator for the loop and the flag values it takes, so a value is never read as an argument.
  const queue = rest.values();
  for (const arg of queue) {
    if (arg === '--session' || arg === '--source') {
      const value = queue.next().value;
      if (value === undefined || value === '') {
        io.err(`sarathi autofix: ${arg} needs a value\n${AUTOFIX_USAGE}`);
        return 1;
      }
      flags.set(arg, value);
    } else if (arg.startsWith('--')) {
      io.err(`sarathi autofix: unknown option ${arg}\n${AUTOFIX_USAGE}`);
      return 1;
    } else {
      positional.push(arg);
    }
  }
  // No session at all names no file, as an unusable one does.
  const session = flags.get('--session') ?? io.env.CLAUDE_CODE_SESSION_ID;
  const file = listFile(session, io.env);
  if (file === undefined) {
    io.err(`sarathi autofix: no usable session id (pass --session, or run inside a Claude Code session)\n`);
    return 1;
  }
  const [url, ...more] = positional;
  if (verb === 'add' && url !== undefined && more.length === 0) {
    const pr = putOpened(file, url, flags.get('--source') ?? 'sarathi autofix add', io);
    if (pr === undefined) {
      io.err(`sarathi autofix: ${url} is not a pull request URL (https://<host>/<owner>/<repo>/pull/<N>)\n`);
      return 1;
    }
    io.out(`sarathi autofix: ${pr} is on session ${session}'s list (${file})\n`);
    return 0;
  }
  if (verb === 'list' && positional.length === 0) {
    for (const pr of fold(readRows(file))) io.out(`${pr.pr}\t${pr.state}\t${pr.url}${pr.reason === undefined ? '' : `\t${pr.reason}`}\n`);
    return 0;
  }
  io.err(AUTOFIX_USAGE);
  return 1;
}

/**
 * The hook, when `script` (the path node was given) is this module at
 * `moduleUrl`: answers the event read from `stdin` through `write`.
 * Imported, it does nothing.
 */
export async function start(
  script: string | undefined,
  moduleUrl: string,
  stdin: AsyncIterable<unknown> | Iterable<unknown>,
  write: (text: string) => void,
  deps: Deps = { env: process.env, now: () => new Date() },
): Promise<void> {
  // An empty path is the working folder, never this file.
  if (script === undefined || realpathSync(script) !== fileURLToPath(moduleUrl)) return;
  let raw = '';
  for await (const chunk of stdin) raw += String(chunk);
  write(respond(raw, deps));
}

void start(process.argv[1], import.meta.url, process.stdin, text => process.stdout.write(text));
