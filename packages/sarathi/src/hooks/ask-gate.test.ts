/**
 * hooks/ask-gate.sh, run as Claude Code runs it: the PreToolUse event on
 * stdin, the session's transcript on disk. Every transcript here is
 * synthetic, built from the entry shapes Claude Code writes: a person's
 * message carries `origin.kind: "human"` (older entries carry no marker, only
 * the text), while a background task's report, another session's message and
 * an app event are user-role entries too, marked otherwise.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = fileURLToPath(new URL('../../hooks/ask-gate.sh', import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'sarathi-ask-gate-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

const ASK = 'AskUserQuestion';
const WRAP_UP = 'mcp__ccd_turn__wrap_up';

let ids = 0;
const next = (): string => `u${ids++}`;

// --- transcript entries --------------------------------------------------------
type Entry = Record<string, unknown>;
const line = (entry: Entry): string => JSON.stringify(entry);

/** The person's own message, as the desktop app writes it. */
const owner = (text = 'please add the flag', extra: Entry = {}): string =>
  line({ type: 'user', uuid: next(), origin: { kind: 'human' }, turnOrigin: 'human', promptSource: 'typed', message: { role: 'user', content: text }, ...extra });
/** The same, from a client that writes no origin marker, wrapped in a reminder. */
const ownerUnmarked = (text = 'please add the flag'): string =>
  line({ type: 'user', uuid: next(), message: { role: 'user', content: [{ type: 'text', text: `<system-reminder>context</system-reminder>\n${text}` }] } });
const toolUse = (name: string, input: Entry = {}): string =>
  line({ type: 'assistant', uuid: next(), message: { role: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: next(), name, input }] } });
const toolResult = (): string =>
  line({ type: 'user', uuid: next(), toolUseResult: { ok: true }, sourceToolAssistantUUID: 'a', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'result' }] } });
/** A background agent's or command's report. */
const handBack = (): string =>
  line({
    type: 'user',
    uuid: next(),
    origin: { kind: 'task-notification' },
    turnOrigin: 'task_notification',
    promptSource: 'system',
    message: { role: 'user', content: '<task-notification>\n<status>completed</status>\n<summary>agent finished</summary>\n</task-notification>' },
  });
const handBackUnmarked = (): string =>
  line({ type: 'user', uuid: next(), message: { role: 'user', content: '<system-reminder>notice</system-reminder><task-notification><status>completed</status></task-notification>' } });
const peer = (): string =>
  line({ type: 'user', uuid: next(), isMeta: true, origin: { kind: 'peer', from: 'local_x' }, turnOrigin: 'peer', message: { role: 'user', content: 'a message from another session' } });
const appEvent = (): string =>
  line({ type: 'user', uuid: next(), turnOrigin: 'auto_continuation', promptSource: 'sdk', message: { role: 'user', content: 'the side session finished its work' } });
const reminderOnly = (): string => line({ type: 'user', uuid: next(), message: { role: 'user', content: '<system-reminder>files changed</system-reminder>' } });
const meta = (): string => line({ type: 'user', uuid: next(), isMeta: true, message: { role: 'user', content: 'skill text loaded' } });
const compacted = (): string => line({ type: 'user', uuid: next(), isCompactSummary: true, message: { role: 'user', content: 'This session is being continued' } });
const sidechain = (text: string): string => line({ type: 'user', uuid: next(), isSidechain: true, message: { role: 'user', content: text } });
const interrupted = (): string => line({ type: 'user', uuid: next(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });

let files = 0;
function transcript(...lines: string[]): string {
  const path = join(TMP, 'transcripts', `${files++}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''));
  return path;
}

// --- running the gate -----------------------------------------------------------
interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

let sessions = 0;
function gate(input: string | Entry, env: NodeJS.ProcessEnv = {}, state = join(TMP, 'state')): Run {
  const result = spawnSync('bash', [GATE], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', HOME: TMP, SARATHI_ASK_GATE_DIR: state, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const QUESTION = { questions: [{ question: 'Which name?', header: 'Name', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false }] };
const CHOICE = { recap: 'r', ask: 'Which fix first?', actions: [{ label: 'The parser' }, { label: 'The lexer' }] };

/** The exit of one ask against a transcript, in a fresh session. */
function exit(path: string, tool = ASK, toolInput: Entry = QUESTION): number | null {
  return gate({ tool_name: tool, tool_input: toolInput, transcript_path: path, session_id: `s${sessions++}` }).status;
}

// --- cases ---------------------------------------------------------------------
test('ask-gate: research since the owner spoke lets the ask through', () => {
  assert.equal(exit(transcript(owner())), 2, 'no research');
  for (const [name, input] of [
    ['WebSearch', { query: 'q' }],
    ['WebFetch', { url: 'https://example.com' }],
    ['mcp__Claude_Browser__get_page_text', {}],
    ['mcp__Claude_Browser__read_page', {}],
    ['mcp__Claude_Browser__navigate', { url: 'https://example.com' }],
    ['mcp__remote-devices__Claude_Browser__get_page_text', {}],
    ['Agent', { subagent_type: 'researcher', prompt: 'p' }],
    ['Agent', { subagent_type: 'sarathi:researcher', prompt: 'p' }],
    ['Agent', { subagent_type: 'Explore', prompt: 'p' }],
    ['Agent', { subagent_type: 'claude-code-guide', prompt: 'p' }],
    ['Agent', { prompt: 'no type is general-purpose' }],
    ['Task', { subagent_type: 'general-purpose', prompt: 'p' }],
  ] as const) {
    assert.equal(exit(transcript(owner(), toolUse(name, input), toolResult())), 0, `${name} ${JSON.stringify(input)}`);
  }
});

test('ask-gate: what is not research does not count', () => {
  for (const [name, input] of [
    ['Read', { file_path: '/x' }],
    ['Bash', { command: 'curl https://example.com' }],
    ['Agent', { subagent_type: 'worker', prompt: 'p' }],
    ['mcp__Claude_Browser__computer', { action: 'left_click' }],
  ] as const) {
    assert.equal(exit(transcript(owner(), toolUse(name, input), toolResult())), 2, name);
  }
  const subagentOwn = line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'WebSearch', input: {} }] } });
  assert.equal(exit(transcript(owner(), subagentOwn)), 2, "a subagent's own search, in its sidechain");
});

test('ask-gate: research before the owner last spoke does not count', () => {
  assert.equal(exit(transcript(owner(), toolUse('WebSearch'), toolResult(), owner('now do the other thing'))), 2);
  assert.equal(exit(transcript(owner(), toolUse('WebSearch'), owner(), toolUse('WebFetch'))), 0, 'research again after it');
  assert.equal(exit(transcript(owner(), toolUse('WebSearch'), ownerUnmarked())), 2, 'an owner message with no origin marker');
  const image = line({ type: 'user', uuid: next(), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] } });
  assert.equal(exit(transcript(owner(), toolUse('WebSearch'), image)), 2, 'an owner message that is only an attachment');
});

test("ask-gate: a hand-back, a peer's message or an app event does not reset the window", () => {
  for (const [name, entry] of [
    ['task notification', handBack()],
    ['unmarked task notification', handBackUnmarked()],
    ['another session', peer()],
    ['an app event', appEvent()],
    ['a system reminder', reminderOnly()],
    ['a meta entry', meta()],
    ['a compaction summary', compacted()],
    ["a subagent's prompt", sidechain('search the web')],
    ['an interruption', interrupted()],
    ['a tool result', toolResult()],
  ] as const) {
    assert.equal(exit(transcript(owner(), toolUse('Agent', { subagent_type: 'researcher', run_in_background: true }), toolResult(), entry)), 0, name);
  }
});

test('ask-gate: the task that started a side session opens its window', () => {
  const task = line({ type: 'user', uuid: next(), turnOrigin: 'host_synthetic', promptSource: 'sdk', message: { role: 'user', content: '<system-reminder>worktree</system-reminder>\nbuild the flag' } });
  assert.equal(exit(transcript(toolUse('WebSearch'), task)), 2);
  assert.equal(exit(transcript(task, toolUse('WebSearch'))), 0);
});

test('ask-gate: with no owner message, the whole transcript is the window', () => {
  assert.equal(exit(transcript(handBack())), 2);
  assert.equal(exit(transcript(toolUse('WebSearch'), handBack())), 0);
});

test('ask-gate: a wrap_up is gated only when its ask offers a choice', () => {
  const t = transcript(owner());
  for (const [why, input] of [
    ['two reply buttons', CHOICE],
    ['the ask names alternatives', { recap: 'r', ask: 'Ship it now or after the release?', actions: [{ label: 'Yes' }] }],
    ['which', { recap: 'r', ask: 'Which one should go first?' }],
    ['how should', { recap: 'r', ask: 'How should the flag be named?' }],
    ['A/B', { recap: 'r', ask: 'Keep the cache/drop it?' }],
    ['a bare A/B', { recap: 'r', ask: 'A/B?' }],
    ['"go with" buttons', { recap: 'r', ask: 'Pick one?', actions: [{ label: 'Go with the parser' }, { label: 'Go with the lexer' }] }],
  ] as const) {
    assert.equal(exit(t, WRAP_UP, input), 2, why);
  }
  for (const [why, input] of [
    ['no ask', { recap: 'r' }],
    ['an empty ask', { recap: 'r', ask: '  ', actions: [{ label: 'One' }, { label: 'Two' }] }],
    ['a go-ahead', { recap: 'r', ask: 'Fix the parser here?', actions: [{ label: 'Yes, fix it' }, { label: 'Not now' }] }],
    ['one button', { recap: 'r', ask: 'Fix the parser here?', actions: [{ label: 'Fix it here' }] }],
    ['an app action first', { recap: 'r', ask: 'Which way to land it?', actions: [{ action: 'commit' }, { label: 'Hold it' }] }],
    ['odd actions', { recap: 'r', ask: 'Fix it?', actions: 'commit' }],
    ['a pull request reference', { recap: 'r', ask: 'Merge acme/widgets#12 now?', actions: [{ label: 'Yes' }, { label: 'Not now' }] }],
    ['a path', { recap: 'r', ask: 'Delete src/old/parser.ts?', actions: [{ label: 'Yes' }, { label: 'No' }] }],
    ['a URL', { recap: 'r', ask: 'Publish to https://example.com/docs/page now?', actions: [{ label: 'Yes' }, { label: 'Not now' }] }],
    ['a shallow path with yes/no buttons', { recap: 'r', ask: 'Delete src/file?', actions: [{ label: 'Yes' }, { label: 'No' }] }],
    ['a URL with a slash in its query', { recap: 'r', ask: 'Open https://example.com?next=foo/bar now?' }],
    ['a URL whose path holds a word that names alternatives', { recap: 'r', ask: 'Publish https://example.com/which/or now?', actions: [{ label: 'Yes' }] }],
  ] as const) {
    assert.equal(exit(t, WRAP_UP, input), 0, why);
  }
});

test('ask-gate: a second gated ask in the same turn passes, whatever it says', () => {
  const state = join(TMP, 'state-escape');
  const t = transcript(owner());
  const ask = (input: Entry, tool = ASK): number | null => gate({ tool_name: tool, tool_input: input, transcript_path: t, session_id: 'escape' }, {}, state).status;
  assert.equal(ask(QUESTION), 2);
  assert.equal(ask(CHOICE, WRAP_UP), 0, 'rephrased, through the other tool');
  assert.equal(readdirSync(state).join(), 'escape', 'state is kept per session in the state folder');
  // A new owner message is a new turn: the gate asks for research again.
  writeFileSync(t, `${readFileSync(t, 'utf8')}${owner('next task')}\n`);
  assert.equal(ask(QUESTION), 2);
  assert.equal(ask(QUESTION), 0);
  assert.equal(gate({ tool_name: ASK, tool_input: QUESTION, transcript_path: t, session_id: 'other' }, {}, state).status, 2, 'another session has its own turn');
});

test('ask-gate: the refusal carries the rule and the owner-only kinds', () => {
  const run = gate({ tool_name: ASK, tool_input: QUESTION, transcript_path: transcript(owner()), session_id: 'reason' });
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /^BLOCKED: research before you ask\./);
  for (const part of [/official docs at the version in use/, /a preference/, /an approval/, /a private fact/, /money or credentials/, /irreversible/, /ambiguity left after research/, /ask it again unchanged/]) {
    assert.match(run.stderr, part);
  }
});

test('ask-gate: a pass is silent, never an allow answer', () => {
  const run = gate({ tool_name: ASK, tool_input: QUESTION, transcript_path: transcript(owner(), toolUse('WebSearch')), session_id: 'quiet' });
  assert.deepEqual(run, { status: 0, stdout: '', stderr: '' });
});

test('ask-gate: anything it cannot read passes', () => {
  const t = transcript(owner());
  assert.equal(gate('not json').status, 0, 'malformed input');
  assert.equal(gate('').status, 0, 'no input');
  assert.equal(gate('[1]').status, 0, 'input not an object');
  assert.equal(gate({ tool_name: 'Bash', tool_input: {}, transcript_path: t }).status, 0, 'another tool');
  assert.equal(gate({ tool_name: ASK, tool_input: QUESTION }).status, 0, 'no transcript path');
  assert.equal(gate({ tool_name: ASK, tool_input: QUESTION, transcript_path: join(TMP, 'missing.jsonl') }).status, 0, 'an unreadable transcript');
  assert.equal(gate({ tool_name: WRAP_UP, tool_input: 'ask', transcript_path: t }).status, 0, 'tool input not an object');
  assert.equal(gate({ tool_name: ASK, transcript_path: t, session_id: 'noinput' }).status, 0, 'no tool input');
  assert.equal(gate({ tool_name: ASK, tool_input: '', transcript_path: t, session_id: 'emptyinput' }).status, 0, 'an empty tool input');
  assert.equal(gate({ tool_name: ASK, tool_input: {}, transcript_path: t, session_id: 'emptyobject' }).status, 0, 'an empty tool input object');
  const blocker = join(TMP, 'a-file');
  writeFileSync(blocker, '');
  assert.equal(gate({ tool_name: ASK, tool_input: QUESTION, transcript_path: t, session_id: 'nostate' }, {}, join(blocker, 'state')).status, 0, 'state it cannot write');
  const odd = transcript('not json', '[1]', line({ type: 'assistant', message: { content: ['text', { type: 'tool_use', name: 'Agent', input: 'x' }] } }), line({ type: 'user', message: { role: 'user', content: 7 } }), line({ type: 'user', message: { role: 'user', content: [7, { type: 'text', text: 1 }] } }));
  assert.equal(exit(odd), 2, 'odd lines are skipped and are no research');
});

test('ask-gate: a session without an id is keyed on its transcript', () => {
  const state = join(TMP, 'state-noid');
  const t = transcript(owner());
  assert.equal(gate({ tool_name: ASK, tool_input: QUESTION, transcript_path: t }, {}, state).status, 2);
  assert.equal(gate({ tool_name: ASK, tool_input: QUESTION, transcript_path: t }, {}, state).status, 0);
  assert.deepEqual(readdirSync(state), [t.split('/').pop()]);
});

test('ask-gate: state goes under XDG_STATE_HOME, else ~/.local/state', () => {
  const xdg = join(TMP, 'xdg');
  const input = { tool_name: ASK, tool_input: QUESTION, transcript_path: transcript(owner()), session_id: 'xdg/../s' };
  assert.equal(gate(input, { SARATHI_ASK_GATE_DIR: '', XDG_STATE_HOME: xdg }).status, 2);
  assert.deepEqual(readdirSync(join(xdg, 'sarathi', 'ask-gate')), ['xdg_.._s']);
  assert.equal(gate(input, { SARATHI_ASK_GATE_DIR: '' }).status, 2);
  assert.deepEqual(readdirSync(join(TMP, '.local', 'state', 'sarathi', 'ask-gate')), ['xdg_.._s']);
});

test('ask-gate: runs the launcher interpreter when it names one', () => {
  const python = join(TMP, 'python-stub');
  writeFileSync(python, '#!/bin/bash\nexit 7\n', { mode: 0o755 });
  assert.equal(gate('{}', { HOOK_PYTHON: python }).status, 7);
});
