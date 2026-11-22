/**
 * hooks/ask-gate.sh, run as Claude Code runs it: the PreToolUse event on
 * stdin, the session's transcript on disk. Every transcript here is
 * synthetic, built from the entry shapes Claude Code writes: a person's
 * message carries `origin.kind: "human"` (older entries carry no marker, only
 * the text), while a background task's report, another session's message and
 * an app event are user-role entries too, marked otherwise.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
/** A Stop hook's feedback, as Claude Code writes it: a meta user-role entry. */
const stopFeedback = (): string =>
  line({ type: 'user', uuid: next(), isMeta: true, isSidechain: false, message: { role: 'user', content: 'Stop hook feedback:\n[command hook 1]: research before you ask.' } });

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
    ["a Stop hook's feedback", stopFeedback()],
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
    ['"or" glued between two URLs', { recap: 'r', ask: 'Ship (https://a.example/x)or(https://b.example/y)?', actions: [{ label: 'Yes' }] }],
    ['"or" glued to a URL by a comma', { recap: 'r', ask: 'Ship https://a.example/x,or https://b.example/y?', actions: [{ label: 'Yes' }] }],
    ['"or" glued to a URL by a semicolon', { recap: 'r', ask: 'Ship https://a.example/x;or https://b.example/y?', actions: [{ label: 'Yes' }] }],
    ['"or" glued to a URL by a pipe', { recap: 'r', ask: 'Ship https://a.example/x|or https://b.example/y?', actions: [{ label: 'Yes' }] }],
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
    ['a pull request reference', { recap: 'r', ask: 'Merge [acme/widgets#12](https://github.com/acme/widgets/pull/12) now?', actions: [{ label: 'Yes' }, { label: 'Not now' }] }],
    ['a path', { recap: 'r', ask: 'Delete src/old/parser.ts?', actions: [{ label: 'Yes' }, { label: 'No' }] }],
    ['a URL', { recap: 'r', ask: 'Publish to https://example.com/docs/page now?', actions: [{ label: 'Yes' }, { label: 'Not now' }] }],
    ['a shallow path with yes/no buttons', { recap: 'r', ask: 'Delete src/file?', actions: [{ label: 'Yes' }, { label: 'No' }] }],
    ['a URL with a slash in its query', { recap: 'r', ask: 'Open https://example.com?next=foo/bar now?' }],
    ['a URL with parentheses in its path', { recap: 'r', ask: 'Cite https://example.com/wiki/Fork_(which-way)?', actions: [{ label: 'Yes' }] }],
    ['a URL with an IPv6 host', { recap: 'r', ask: 'Open http://[::1]:8080/which/or now?', actions: [{ label: 'Yes' }] }],
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
  assert.deepEqual(readdirSync(state).sort(), ['ask-log.jsonl', 'ask-log.jsonl.lock', 'escape'], 'state is kept per session in the state folder');
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
  assert.deepEqual(readdirSync(state).sort(), [t.split('/').pop(), 'ask-log.jsonl', 'ask-log.jsonl.lock'].sort());
});

test('ask-gate: state goes under XDG_STATE_HOME, else ~/.local/state', () => {
  const xdg = join(TMP, 'xdg');
  const input = { tool_name: ASK, tool_input: QUESTION, transcript_path: transcript(owner()), session_id: 'xdg/../s' };
  assert.equal(gate(input, { SARATHI_ASK_GATE_DIR: '', XDG_STATE_HOME: xdg }).status, 2);
  assert.deepEqual(readdirSync(join(xdg, 'sarathi', 'ask-gate')).sort(), ['ask-log.jsonl', 'ask-log.jsonl.lock', 'xdg_.._s']);
  assert.equal(gate(input, { SARATHI_ASK_GATE_DIR: '' }).status, 2);
  assert.deepEqual(readdirSync(join(TMP, '.local', 'state', 'sarathi', 'ask-gate')).sort(), ['ask-log.jsonl', 'ask-log.jsonl.lock', 'xdg_.._s']);
});

test('ask-gate: runs the launcher interpreter when it names one', () => {
  const python = join(TMP, 'python-stub');
  writeFileSync(python, '#!/bin/bash\nexit 7\n', { mode: 0o755 });
  assert.equal(gate('{}', { HOOK_PYTHON: python }).status, 7);
});

// --- Stop: questions written as plain text ---------------------------------------
const CLOSING = 'The parser and the lexer both fail on the new input.\n\nFix the parser first or the lexer?';

/** The Stop event, as Claude Code sends it. */
const stopEvent = (path: string, message: unknown, extra: Entry = {}): Entry => ({
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: message,
  transcript_path: path,
  session_id: `s${sessions++}`,
  ...extra,
});
/** Whether a Stop on this message and transcript holds the turn (true) or lets it end silently (false). */
function holds(path: string, message: unknown, extra: Entry = {}): boolean {
  const run = gate(stopEvent(path, message, extra));
  assert.equal(run.status, 0, 'Stop never exits 2');
  assert.equal(run.stderr, '');
  if (run.stdout === '') return false;
  const answer = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(answer.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(answer.hookSpecificOutput.additionalContext, /^research before you ask\. Your closing message asks the owner to choose/);
  return true;
}

test('ask-gate on Stop: a choice in the closing message, with no research, goes back as feedback', () => {
  const run = gate(stopEvent(transcript(owner()), CLOSING));
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');
  const answer = JSON.parse(run.stdout) as Entry;
  assert.deepEqual(Object.keys(answer), ['hookSpecificOutput'], 'context, not a block decision');
  const context = (answer['hookSpecificOutput'] as Entry)['additionalContext'] as string;
  assert.match(context, /\(Fix the parser first or the lexer\?\)/, 'it quotes the question');
  for (const part of [/official docs at the version in use/, /a preference/, /an approval/, /irreversible/, /end the turn again and it goes through: the owner already sees the question, so do not repeat it/]) {
    assert.match(context, part);
  }
  assert.equal(holds(transcript(owner(), toolUse('WebSearch'), toolResult()), CLOSING), false, 'research since the owner spoke');
  assert.equal(holds(transcript(owner(), toolUse('WebSearch'), owner('now the other one')), CLOSING), true, 'research before the owner last spoke');
});

test('ask-gate on Stop: only a choice-shaped question near the end counts', () => {
  const t = transcript(owner());
  for (const [why, message] of [
    ['which', 'Done.\n\nWhich one should go first?'],
    ['how should', 'How should the flag be named?'],
    ['either', 'Either works for me; pick one?'],
    ['a question in a list', 'Two ways:\n\n- Which do you want, the cache or none?'],
    ['dots inside words', 'Fix src/foo.ts or src/bar.ts?'],
    ['a question before the options', 'Which approach?\n\n1. Rewrite the parser\n2. Patch the lexer'],
    ['the last of three paragraphs back', 'Which one?\n\nOne.\n\nTwo.'],
  ] as const) {
    assert.equal(holds(t, message), true, why);
  }
  for (const [why, message] of [
    ['no question', 'Done. The parser and the lexer both pass.'],
    ['a yes/no approval', 'The branch is ready.\n\nForce-push to main?'],
    // Not "Delete the branch?": an agent deletes its own superseded or
    // closed branches itself and never asks the owner to (docs/lessons/git-github.md).
    ['an irreversible step, asked yes/no', 'Publish v1.0.0?'],
    ['"or not"', 'Ship it now or not?'],
    ['a bare A/B with no buttons', 'Keep the cache/drop it?'],
    ['a statement with "or", no question', 'I fixed the parser or the lexer, whichever failed.'],
    ['a choice four paragraphs back', 'Which one?\n\nOne.\n\nTwo.\n\nThree.'],
    ['a choice in fenced code', 'Done.\n\n```\nwhich = a or b?\n```'],
    ['a choice in an unclosed fence', 'Done.\n\n~~~\nwhich?'],
    ['a choice in inline code', 'Run `a or b?` next.'],
    ['a quoted choice', 'You asked:\n> Which one first?\n\nThe parser, done.'],
    ['a URL with a question in it', 'See https://example.com/which?or=either for the details.'],
    ['an empty message', ''],
  ] as const) {
    assert.equal(holds(t, message), false, why);
  }
});

test('ask-gate on Stop: a question in double quotes is someone else\'s, not the session\'s choice', () => {
  const t = transcript(owner());
  const asked = 'Which fruit should the test use: apple or pear?';
  // The report that was held (veda-hq/veda#341), a test session's question quoted.
  const report = (open: string, close: string): string =>
    `Checked in two sessions.\n\n- **Plain-text nudge:** a session that ended on ${open}${asked}${close} with no \`wrap_up\` was nudged and then called \`wrap_up\`.`;
  for (const [why, message] of [
    ['straight quotes', report('"', '"')],
    ['curly quotes', report('“', '”')],
  ] as const) {
    assert.equal(holds(t, message), false, why);
  }
  for (const [why, message] of [
    ['the same question, unquoted', `Checked in two sessions.\n\n${asked}`],
    ['a quoted question and the session\'s own on one line', `The test session ended on "${asked}" Should I keep that test or drop it?`],
    ['a curly-quoted question and the session\'s own on one line', `The test session ended on “${asked}” Should I keep that test or drop it?`],
    ['the session\'s own choice between quoted words', 'Rename the flag to "fast" or "quick"?'],
  ] as const) {
    assert.equal(holds(t, message), true, why);
  }
  // The held question keeps its quoted words: the log and the relabel check
  // compare them, so "fast" or "quick" is not "slow" or "late".
  const run = gate(stopEvent(t, 'Done.\n\nRename the flag to "fast" or “quick”?'));
  const context = (JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  assert.match(context, /\(Rename the flag to "fast" or “quick”\?\)/);
});

test('ask-gate on Stop: anything it cannot read lets the turn end', () => {
  const t = transcript(owner());
  for (const [why, input] of [
    ['a message that is not a string', stopEvent(t, ['Which one?'])],
    ['no message', { hook_event_name: 'Stop', transcript_path: t, session_id: 'nomessage' }],
    ['no transcript path', { hook_event_name: 'Stop', last_assistant_message: CLOSING, session_id: 'nopath' }],
    ['an unreadable transcript', stopEvent(join(TMP, 'missing.jsonl'), CLOSING)],
  ] as const) {
    assert.deepEqual(gate(input), { status: 0, stdout: '', stderr: '' }, why);
  }
});

test('ask-gate on Stop: once per turn, shared with the PreToolUse path', () => {
  const state = join(TMP, 'state-stop');
  const t = transcript(owner());
  const stop = (extra: Entry = {}): string => gate({ ...stopEvent(t, CLOSING), session_id: 'stop', ...extra }, {}, state).stdout;
  const ask = (): number | null => gate({ tool_name: ASK, tool_input: QUESTION, transcript_path: t, session_id: 'stop' }, {}, state).status;

  assert.equal(stop({ stop_hook_active: true }), '', 'stop_hook_active passes');
  assert.equal(existsSync(state), false, '... and spends nothing');
  assert.notEqual(stop(), '', 'held');
  assert.equal(stop(), '', 'the second Stop in the turn ends it');
  assert.equal(ask(), 0, 'an ask in the turn the Stop held passes too');

  writeFileSync(t, `${readFileSync(t, 'utf8')}${owner('next task')}\n`);
  assert.equal(ask(), 2, 'a new turn');
  assert.equal(stop(), '', 'a Stop in the turn an ask was held in ends it');
});

test('ask-gate on Stop: through sarathi hook Stop, alone and beside a handler that blocks', () => {
  const bin = fileURLToPath(new URL('../bin.ts', import.meta.url));
  const through = (handlers: Entry[]): Run => {
    const dir = join(TMP, `project-${files++}`);
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'sarathi.json'), JSON.stringify({ hooks: { Stop: handlers } }));
    const result = spawnSync(process.execPath, [bin, 'hook', 'Stop'], {
      input: JSON.stringify({ ...stopEvent(transcript(owner()), CLOSING), cwd: dir }),
      env: { PATH: process.env['PATH'] ?? '', HOME: TMP, CLAUDE_PROJECT_DIR: dir, SARATHI_ASK_GATE_DIR: join(TMP, 'state-through') },
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const gateEntry = { command: 'bash "$SARATHI_HOOKS"/ask-gate.sh', timeout: 10 };

  const alone = through([gateEntry]);
  assert.equal(alone.status, 0, alone.stderr);
  const answer = JSON.parse(alone.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(answer.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(answer.hookSpecificOutput.additionalContext, /^research before you ask\./);

  // A handler that exits 2 blocks, and the gate's feedback follows its reason
  // after a blank line (README, "Limits on Stop"; veda#307).
  const beside = through([gateEntry, { command: 'cat >/dev/null; echo "keep going" >&2; exit 2' }]);
  assert.equal(beside.status, 2);
  assert.equal(beside.stdout, '');
  assert.match(beside.stderr, /^keep going\n\nresearch before you ask\. /);
  assert.ok(beside.stderr.endsWith('\n') && !beside.stderr.endsWith('\n\n'), beside.stderr);
});

// --- repo and state research, for repo and state questions ---------------------------
const STATE_ASK = { questions: [{ question: 'Which branch should this land on?', header: 'Branch', options: [{ label: 'main' }, { label: 'next' }], multiSelect: false }] };

test('ask-gate: a look at the repository counts for an ask that names its state', () => {
  assert.equal(exit(transcript(owner()), ASK, STATE_ASK), 2, 'no look');
  for (const [name, input] of [
    ['Read', { file_path: '/x' }],
    ['Grep', { pattern: 'x' }],
    ['Glob', { pattern: '*.ts' }],
    ['mcp__ccd_pr__get_status', {}],
    ['Bash', { command: 'git status' }],
    ['Bash', { command: 'git -C /x log --oneline -5' }],
    ['Bash', { command: 'git --no-pager diff main...HEAD' }],
    ['Bash', { command: 'cd /x && git branch -a' }],
    ['Bash', { command: 'GIT_PAGER=cat git show HEAD' }],
    ['Bash', { command: 'gh pr view 12 --json state' }],
    ['Bash', { command: 'gh pr checks 12' }],
    ['Bash', { command: 'gh run list --limit 5' }],
    ['Bash', { command: 'gh search issues ask-gate' }],
    ['Bash', { command: 'gh api repos/o/r/pulls/12' }],
    ['Bash', { command: 'gh api -X GET repos/o/r/issues -f state=open' }],
    ['Bash', { command: 'pnpm test' }],
    ['Bash', { command: 'pnpm --filter x run check' }],
    ['Bash', { command: 'npx vitest run src/a.test.ts' }],
    ['Bash', { command: 'node --test src/a.test.ts' }],
    ['Bash', { command: 'pytest -q' }],
    ['Bash', { command: 'go test ./...' }],
    ['Bash', { command: 'git branch --list "feat*"' }],
    ['Bash', { command: 'git branch --contains abc123 -r' }],
    ['Bash', { command: 'git branch --show-current' }],
    ['Bash', { command: 'git reflog -5' }],
    ['Bash', { command: 'gh api --method=get repos/o/r/pulls' }],
    ['Bash', { command: 'pnpm test || true' }],
    ['Bash', { command: 'false; git status' }],
    ['Bash', { command: 'git grep -o needle' }],
    ['Bash', { command: 'git ls-files -o --exclude-standard' }],
    ['Bash', { command: 'git diff --output-indicator-new=+ HEAD' }],
  ] as const) {
    assert.equal(exit(transcript(owner(), toolUse(name, input), toolResult()), ASK, STATE_ASK), 0, `${name} ${JSON.stringify(input)}`);
  }
});

test('ask-gate: a write is no look, and a look before the owner spoke does not count', () => {
  for (const command of [
    'git commit -m x',
    'git push origin HEAD',
    'gh pr create --fill',
    'gh pr merge 12 --auto',
    'gh api -X POST repos/o/r/issues',
    'gh api --method=PATCH repos/o/r/issues/1',
    'gh api repos/o/r/issues -f title=x',
    'echo git status is clean',
    'pnpm install',
    'pnpm add -D vitest',
    'npm install jest',
    'pnpm --filter x add jest',
    'git branch -D old',
    'git branch new-feature',
    'git branch --set-upstream-to=origin/x',
    'git reflog expire --all',
    'git diff --output=x.patch',
    'git diff --out=x.patch',
    'git log -p --output x.patch',
    'METHOD=DELETE gh api --method "$METHOD" repos/o/r/x',
    'false && pnpm test',
    'true || pnpm test',
    'exit 1 && git status',
    'false && echo x && git log',
  ]) {
    assert.equal(exit(transcript(owner(), toolUse('Bash', { command }), toolResult()), ASK, STATE_ASK), 2, command);
  }
  assert.equal(exit(transcript(owner(), toolUse('Bash', {}), toolResult()), ASK, STATE_ASK), 2, 'a Bash with no command');
  assert.equal(exit(transcript(owner(), toolUse('Read'), owner('now this')), ASK, STATE_ASK), 2, 'a look before the owner last spoke');
  const subagentOwn = line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
  assert.equal(exit(transcript(owner(), subagentOwn), ASK, STATE_ASK), 2, "a subagent's own read, in its sidechain");
});

test('ask-gate: a look counts only when the ask names repository or session state', () => {
  const looked = transcript(owner(), toolUse('Read'), toolResult());
  const asking = (question: string, options: readonly string[] = ['a', 'b']): Entry => ({
    questions: [{ question, header: 'Q', options: options.map((label) => ({ label })), multiSelect: false }],
  });
  for (const [why, input] of [
    ['#N', asking('Close [#12](https://github.com/acme/widgets/pull/12) or keep it?')],
    ['owner/repo#N', asking('Which of [acme/widgets#12](https://github.com/acme/widgets/pull/12) and [#13](https://github.com/acme/widgets/pull/13) first?')],
    ['PR', asking('Which PR goes first?')],
    ['pull request', asking('Rebase the pull request or merge main in?')],
    ['branch', asking('Which branch?')],
    ['commit', asking('Squash the commits or keep them?')],
    ['CI', asking('CI is red: retry or revert?')],
    ['workflow', asking('Which workflow should run it?')],
    ['a path', asking('Edit src/hooks/ask-gate.sh or the test?')],
    ['a file name', asking('Edit README.md or SKILL.md?')],
    ['a pull request URL', asking('Merge https://github.com/o/r/pull/12 or wait?')],
    ['an option', asking('Where should it go?', ['packages/sarathi/README.md', 'docs/lessons/testing.md'])],
  ] as const) {
    assert.equal(exit(looked, ASK, input), 0, why);
  }
  for (const [why, input] of [
    ['a name', QUESTION],
    ['a version fact', asking('Which Node.js version supports type stripping?')],
    ['a design choice', asking('Should the flag be named --dry or --check?')],
    ['"process" is not a PR', asking('Which process should own it?')],
    ['#hashtag', asking('Tag it #urgent or #later?')],
  ] as const) {
    assert.equal(exit(looked, ASK, input), 2, why);
  }
  const wrapUp = { recap: 'r', ask: 'The PR failed CI: retry it or revert?', actions: [{ label: 'Retry' }, { label: 'Revert' }] };
  assert.equal(exit(looked, WRAP_UP, wrapUp), 0, 'a wrap_up ask');
  assert.equal(exit(looked, WRAP_UP, { ...wrapUp, ask: 'Which one first?', actions: [{ label: 'The PR' }, { label: 'The issue' }] }), 0, 'a wrap_up button');
  assert.equal(holds(looked, 'Done.\n\nThe PR failed CI. Retry it or revert?'), false, "a closing question whose paragraph names the state");
  assert.equal(holds(looked, 'Edited `src/a.ts`.\n\nRetry it or revert?'), true, 'the state named only in another paragraph');
  assert.equal(holds(looked, 'Retry it or revert?'), true, 'a closing message that names none');
  for (const [why, input] of [
    ['a docs URL', asking('Which API does https://docs.example.com/api/v2.html describe?')],
    ['a version pair', asking('Target 1.2/1.3 or 2.0?')],
  ] as const) {
    assert.equal(exit(looked, ASK, input), 2, why);
  }
});

test('ask-gate: a look counts question by question, and not for a question about something outside', () => {
  const looked = (): string => transcript(owner(), toolUse('Read'), toolResult());
  const asking = (...questions: (string | { question: string; descriptions: string[] })[]): Entry => ({
    questions: questions.map((q) => ({
      question: typeof q === 'string' ? q : q.question,
      header: 'Q',
      options: (typeof q === 'string' ? ['a', 'b'] : q.descriptions).map((description, n) => ({ label: `option ${n}`, description })),
      multiSelect: false,
    })),
  });
  assert.equal(exit(looked(), ASK, asking('Which branch?', 'Rebase the PR or merge main in?')), 0, 'every question names state');
  assert.equal(exit(looked(), ASK, asking('Which branch?', 'Which name?')), 2, 'one question names none');
  // The owner's log, 2026-11-19: four questions on credits, spend and scope,
  // with one option's description naming a file.
  const batch = asking('Which credits are these, and where does the key live?', 'Which fallback order?', 'How should it run?', {
    question: 'How far should it be enforced?',
    descriptions: ['Hook on Agent', 'As process.md says'],
  });
  assert.equal(exit(looked(), ASK, batch), 2, 'a file named in one option passes no other question');
  for (const [why, question] of [
    ['an API', 'Which branch should call the API?'],
    ['an api, lower case', 'Which branch should call the api?'],
    ['an SDK', 'Bump the SDK in package.json or pin it?'],
    ['an sdk, lower case', 'Bump the sdk in package.json or pin it?'],
    ['a price', 'The PR wants the larger runner at $0.08 a minute: take it or wait?'],
    ['pricing', 'Which pricing tier does the CI job need?'],
    ['credits', 'Spend the credits on the PR review or keep them?'],
    ['a quota', 'CI hit its quota: wait or move the workflow?'],
    ['a rate limit', 'The branch push hit a rate limit: retry now or later?'],
    ['credentials', 'Where should the workflow get its credentials?'],
    ['Keychain', 'Does the CI job read the key from Keychain or an env var?'],
    ['an API key', 'Which api key should the workflow use?'],
    ['Claude Code', 'Does Claude Code read .claude/settings.json from this branch?'],
    ['Anthropic', 'Which Anthropic plan covers the PR bot?'],
    ['a marketplace', 'Which plugin marketplace should README.md name?'],
    ['the documentation', 'What does the documentation say README.md should hold?'],
    ['release notes', 'Do the release notes of the pinned action change the workflow?'],
    ['the latest version', 'Is the latest version of the action safe for the workflow?'],
  ] as const) {
    assert.equal(exit(looked(), ASK, asking(question)), 2, why);
    assert.equal(exit(transcript(owner(), toolUse('WebSearch'), toolResult()), ASK, asking(question)), 0, `${why}, after research`);
  }
  for (const [why, question] of [
    ['a changelog file', 'Edit CHANGELOG.md or README.md?'],
    ['a credentials file', 'Move credentials.json to another branch or delete it?'],
    ['a docs path', 'Edit docs/lessons/testing.md or the PR body?'],
    ['what a choice costs', 'Make the PR docs-only, or fix the parser too at the cost of a CI run?'],
    ['a login in the repo', 'Should the login form in src/login.tsx validate on blur or on submit?'],
    ['an api folder', 'Split src/api/client.ts or keep it?'],
  ] as const) {
    assert.equal(exit(looked(), ASK, asking(question)), 0, why);
  }
  const wrapUp = { recap: 'r', ask: 'The PR hit the API rate limit: retry it or revert?', actions: [{ label: 'Retry' }, { label: 'Revert' }] };
  assert.equal(exit(looked(), WRAP_UP, wrapUp), 2, 'a wrap_up ask');
  assert.equal(holds(looked(), 'Done.\n\nThe PR failed CI on the API quota. Retry it or revert?'), true, 'a closing question');
  assert.equal(holds(looked(), 'Done.\n\nThe PR failed CI. Retry it or revert?'), false, 'a closing question about the state alone');
  const two = 'The PR failed CI. Retry it or revert?\n\nWhich name next, kebab or camel?';
  assert.equal(holds(looked(), two), true, 'state named in one closing paragraph passes no question in another');
  const { run, lines } = logged();
  run({ ...stopEvent(looked(), two), session_id: 'two-paragraphs' });
  assert.deepEqual((lines()[0]?.['questions'] as Entry[]).map((q) => [q['question'], q['names_state']]), [
    ['Retry it or revert?', true],
    ['Which name next, kebab or camel?', false],
  ]);
  assert.equal(holds(looked(), 'The PR failed CI. Retry it or revert?\n\nOn branch next, keep the commit or drop it?'), false, 'every paragraph names state');
});

test('ask-gate log: names_state and names_outside, per question and for the ask', () => {
  const { run, lines } = logged();
  const looked = transcript(owner(), toolUse('Read'), toolResult());
  const batch = {
    questions: [
      { question: 'Which branch?', header: 'Q', options: [{ label: 'main' }, { label: 'next' }], multiSelect: false },
      { question: 'Which name?', header: 'Q', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false },
      { question: 'Does the PR need the API key?', header: 'Q', options: [{ label: 'yes, it does' }, { label: 'no' }], multiSelect: false },
    ],
  };
  run({ tool_name: ASK, tool_input: batch, transcript_path: looked, session_id: 'scope' });
  run({ tool_name: ASK, tool_input: STATE_ASK, transcript_path: looked, session_id: 'scope-2' });
  const [held, passed] = lines();
  assert.deepEqual((held?.['questions'] as Entry[]).map((q) => [q['names_state'], q['names_outside']]), [
    [true, false],
    [false, false],
    [true, true],
  ]);
  assert.deepEqual([held?.['names_state'], held?.['names_outside'], held?.['looked'], held?.['outcome']], [false, true, true, 'held']);
  assert.deepEqual([passed?.['names_state'], passed?.['names_outside'], passed?.['outcome']], [true, false, 'passed: look']);
});

// --- the ask log -------------------------------------------------------------------
let logs = 0;
/** A fresh log file and a runner that writes to it. */
function logged(): { readonly file: string; readonly run: (input: Entry, env?: NodeJS.ProcessEnv, state?: string) => Run; readonly lines: () => Entry[] } {
  const index = logs++;
  const file = join(TMP, 'logs', `${index}.jsonl`);
  return {
    file,
    run: (input, env = {}, state = join(TMP, `state-log-${index}`)) => gate(input, { SARATHI_ASK_LOG: file, ...env }, state),
    lines: () => (existsSync(file) ? readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry) : []),
  };
}

test('ask-gate log: every gated ask is a line, with what came first and what the gate did', () => {
  const { run, lines } = logged();
  const t = transcript(owner());
  const turn = (JSON.parse(readFileSync(t, 'utf8').split('\n')[0] ?? '{}') as Entry)['uuid'];
  const ask = { tool_name: ASK, tool_input: QUESTION, transcript_path: t, session_id: 'log', tool_use_id: 'toolu_1' };
  assert.equal(run(ask).status, 2);
  assert.equal(run({ ...ask, tool_use_id: 'toolu_2' }).status, 0);
  const [held, second] = lines();
  assert.match(String(held?.['time']), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual({ ...held, time: undefined }, {
    time: undefined,
    session: 'log',
    turn,
    via: ASK,
    tool_use_id: 'toolu_1',
    questions: [{ question: 'Which name?', options: ['a', 'b'], kind: null, names_state: false, names_outside: false }],
    researched: false,
    looked: false,
    names_state: false,
    names_outside: false,
    kind: null,
    outcome: 'held',
  });
  assert.equal(second?.['outcome'], 'passed: second ask');
  assert.equal(second?.['relabelled'], false);
  assert.equal(second?.['tool_use_id'], 'toolu_2');
  assert.equal(lines().length, 2);

  run({ ...ask, session_id: 'r', transcript_path: transcript(owner(), toolUse('WebSearch')) });
  run({ ...ask, session_id: 'l', tool_input: STATE_ASK, transcript_path: transcript(owner(), toolUse('Read')) });
  assert.deepEqual(lines().slice(2).map((l) => [l['outcome'], l['researched'], l['looked'], l['names_state']]), [
    ['passed: research', true, false, false],
    ['passed: look', false, true, true],
  ]);
});

test('ask-gate log: a wrap_up ask and a closing question are logged too; asks the gate passes over are not', () => {
  const { run, lines } = logged();
  const t = transcript(owner());
  run({ tool_name: WRAP_UP, tool_input: { recap: 'r', ask: 'Which fix first?', actions: [{ label: 'The parser' }, { action: 'commit' }, { label: 'The lexer' }] }, transcript_path: t, session_id: 'w' });
  run({ ...stopEvent(t, CLOSING), session_id: 'st' });
  run({ tool_name: WRAP_UP, tool_input: { recap: 'r', ask: 'Fix it here?', actions: [{ label: 'Yes' }, { label: 'Not now' }] }, transcript_path: t, session_id: 'w2' });
  run({ tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: t, session_id: 'b' });
  run({ ...stopEvent(t, 'Done, nothing to ask.'), session_id: 'st2' });
  run({ ...stopEvent(t, CLOSING), session_id: 'st3', stop_hook_active: true });
  const [wrap, stop, ...rest] = lines();
  assert.deepEqual([wrap?.['via'], wrap?.['questions'], wrap?.['outcome']], [WRAP_UP, [{ question: 'Which fix first?', options: ['The parser', 'The lexer'], kind: null, names_state: false, names_outside: false }], 'held']);
  assert.deepEqual([stop?.['via'], stop?.['questions'], stop?.['tool_use_id'], stop?.['outcome']], ['Stop', [{ question: 'Fix the parser first or the lexer?', options: [], kind: null, names_state: false, names_outside: false }], null, 'held']);
  assert.deepEqual(rest, [], 'a go-ahead, another tool, a closing message with no question and a Stop already continuing are not logged');
});

test("ask-gate log: the owner's answer to an AskUserQuestion, from PostToolUse", () => {
  const { run, lines } = logged();
  const post = (response: unknown, tool = ASK): Run =>
    run({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: QUESTION, tool_response: response, tool_use_id: 'toolu_9', session_id: 'p', transcript_path: join(TMP, 'any.jsonl') });
  assert.deepEqual(post({ questions: QUESTION.questions, answers: { 'Which name?': 'a' } }), { status: 0, stdout: '', stderr: '' });
  const [answer] = lines();
  assert.deepEqual({ ...answer, time: undefined }, { time: undefined, session: 'p', via: 'answer', tool_use_id: 'toolu_9', answers: { 'Which name?': 'a' } });
  for (const [why, response, tool] of [
    ['a declined question (a string result)', 'The user declined to answer', ASK],
    ['no answers', { questions: [] }, ASK],
    ['another tool', { answers: { q: 'a' } }, 'Bash'],
  ] as const) {
    assert.deepEqual(post(response, tool), { status: 0, stdout: '', stderr: '' }, why);
  }
  assert.equal(lines().length, 1);
  // A multi-select answer can come as a list, and an owner can type their own.
  post({ questions: QUESTION.questions, answers: { 'Which parts?': ['a', 'b'], 'Which name?': 'my own words, ₹90k' } });
  assert.deepEqual(lines()[1]?.['answers'], { 'Which parts?': ['a', 'b'], 'Which name?': 'my own words, ₹90k' });
  // A hook may answer for the owner through the input's answers.
  run({ hook_event_name: 'PostToolUse', tool_name: ASK, tool_input: { ...QUESTION, answers: { 'Which name?': 'b' } }, tool_response: 'done', session_id: 'p', transcript_path: 'x' });
  assert.deepEqual(lines()[2]?.['answers'], { 'Which name?': 'b' });
  assert.deepEqual(gate({ hook_event_name: 'PostToolUse', tool_name: ASK, tool_response: { answers: { q: 'a' } } }, { SARATHI_ASK_LOG: join(TMP, 'logs', 'nopath.jsonl') }).status, 0, 'no transcript path or session');
  assert.equal((JSON.parse(readFileSync(join(TMP, 'logs', 'nopath.jsonl'), 'utf8')) as Entry)['session'], '');
});

test('ask-gate log: where it goes, how it is turned off, and that it never changes the answer', () => {
  const t = transcript(owner());
  const ask = (session: string): Entry => ({ tool_name: ASK, tool_input: QUESTION, transcript_path: t, session_id: session });

  const home = join(TMP, 'log-home', 'ask-gate');
  assert.equal(gate(ask('d'), { SARATHI_ASK_LOG: '' }, home).status, 2);
  const file0 = join(home, 'ask-log.jsonl');
  assert.equal(readFileSync(file0, 'utf8').split('\n').filter(Boolean).length, 1, 'in the state folder by default');
  assert.equal(statSync(file0).mode & 0o777, 0o600, "the owner's alone");
  chmodSync(file0, 0o644);
  gate(ask('d2'), { SARATHI_ASK_LOG: '' }, home);
  assert.equal(statSync(file0).mode & 0o777, 0o600, 'made so again if it was opened up');

  for (const off of ['0', 'false', 'OFF', 'no']) {
    const state = join(TMP, `log-off-${off}`, 'ask-gate');
    assert.equal(gate(ask(`off-${off}`), { SARATHI_ASK_LOG: off }, state).status, 2);
    assert.equal(existsSync(join(state, 'ask-log.jsonl')), false, off);
  }

  const c = logged();
  const rupee = { questions: [{ question: 'Pay ₹90k or ₹60k?', header: 'Pay', options: [{ label: '₹90k' }, { label: '₹60k' }], multiSelect: false }] };
  assert.equal(c.run({ tool_name: ASK, tool_input: rupee, transcript_path: t, session_id: 'c-locale' }, { LC_ALL: 'C', LANG: 'C' }).status, 2);
  assert.deepEqual(c.lines()[0]?.['questions'], [{ question: 'Pay ₹90k or ₹60k?', options: ['₹90k', '₹60k'], kind: null, names_state: false, names_outside: false }], 'UTF-8 under the C locale');

  const unreadable = join(TMP, 'log-unreadable');
  mkdirSync(join(unreadable, 'c-state'), { recursive: true });
  const u = logged();
  assert.equal(u.run(ask('c-state'), {}, unreadable).status, 0, 'a state entry it cannot read passes');
  assert.equal(u.lines()[0]?.['outcome'], 'passed: state unreadable');

  const blocker = join(TMP, 'log-blocker');
  writeFileSync(blocker, '');
  assert.equal(gate(ask('unwritable'), { SARATHI_ASK_LOG: join(blocker, 'log.jsonl') }).status, 2, 'a log it cannot write leaves the refusal as it is');

  const { file, run, lines } = logged();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${'x'.repeat(5 * 1024 * 1024 + 1)}\n`, { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.equal(run(ask('rotate')).status, 2);
  assert.equal(existsSync(`${file}.1`), true, 'past 5 MB the log moves aside');
  assert.equal(statSync(`${file}.1`).mode & 0o777, 0o600, 'the owner’s alone, even when it was opened up');
  assert.equal(lines().length, 1, 'and starts again');
});

test('ask-gate log: hooks running at once over a full log lose no line', async () => {
  const { file, lines } = logged();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${'x'.repeat(5 * 1024 * 1024 + 1)}\n`);
  const t = transcript(owner());
  const writers = 8;
  const codes = await Promise.all(
    Array.from({ length: writers }, (_, n) =>
      new Promise<number | null>((done) => {
        const child = spawn('bash', [GATE], {
          env: { PATH: process.env['PATH'] ?? '', HOME: TMP, SARATHI_ASK_GATE_DIR: join(TMP, `state-race-${n}`), SARATHI_ASK_LOG: file },
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          done(code);
        });
        child.stdin.end(JSON.stringify({ tool_name: ASK, tool_input: QUESTION, transcript_path: t, session_id: `race-${n}` }));
      }),
    ),
  );
  assert.deepEqual(codes, Array(writers).fill(2));
  assert.equal(lines().length, writers, 'one line from each, in the fresh log');
  assert.equal(readFileSync(`${file}.1`, 'utf8').length, 5 * 1024 * 1024 + 2, 'the full log moved aside once, whole');
});

// --- a declared kind ------------------------------------------------------------
/** An AskUserQuestion with these question texts (and headers). */
const asking = (...questions: (string | [string, string])[]): Entry => ({
  questions: questions.map((q) => ({
    question: typeof q === 'string' ? q : q[0],
    header: typeof q === 'string' ? 'Name' : q[1],
    options: [{ label: 'a' }, { label: 'b' }],
    multiSelect: false,
  })),
});
const wrapAsking = (ask: string): Entry => ({ recap: 'r', ask, actions: [{ label: 'The parser' }, { label: 'The lexer' }] });

test('ask-gate: an ask that declares an owner-only kind passes the first time', () => {
  const look = (): string => transcript(owner(), toolUse('Read', { file_path: '/x' }));
  for (const question of [
    'Merge now or wait?\n**Kind:** approval',
    'Merge now or wait? Kind: decision',
    'Which key?\nKind: money or credentials',
    'Delete the old tag or keep it?\nKind: irreversible',
    'Delete the old tag or keep it? (Kind: shared system)',
  ]) {
    assert.equal(exit(transcript(owner()), ASK, asking(question)), 0, `${question}, with no look`);
  }
  for (const question of [
    'Which name?\nKind: preference',
    'Which name? Kind: preference',
    'Which name? (Kind: taste)',
    'Which deploy step?\n- kind: Private fact.',
    'Which name?\nKind: Preference or taste',
    'Which name?\nKind: preference\nKind: approval',
  ]) {
    assert.equal(exit(look(), ASK, asking(question)), 0, `${question}, after a look`);
  }
  assert.equal(exit(transcript(owner()), ASK, asking(['Which name?', 'Kind: money'])), 0, 'in the header');
  assert.equal(exit(look(), WRAP_UP, wrapAsking('Which fix first? Kind: preference.')), 0, 'a wrap_up ask');
  assert.equal(exit(look(), ASK, asking('Which name?\nKind: preference', ['Which tone?', 'Kind: taste'])), 0, 'every question declares');
  assert.equal(holds(look(), `${CLOSING}\n\nKind: preference`), false, 'on Stop, a Kind: line of its own');
  assert.equal(holds(transcript(owner()), 'The parser and the lexer both fail.\n\nFix the parser first or the lexer? Kind: approval.'), false, 'on Stop, in the question');
});

test('ask-gate: a bare preference or private fact, with no research or look, is held once', () => {
  const { run, lines } = logged();
  const t = transcript(owner());
  const ask = (toolInput: Entry, session: string, tool = ASK): Run => run({ tool_name: tool, tool_input: toolInput, transcript_path: t, session_id: session });
  // The owner's log, 2026-11-19: a credential choice the official docs settle, declared a preference.
  const credential = { recap: 'r', ask: 'Build it on a login profile or a Keychain API key?\nKind: preference', actions: [{ label: 'Login profile' }, { label: 'Keychain key' }] };
  assert.equal(ask(credential, 'bare-w', WRAP_UP).status, 2, 'a wrap_up');
  assert.equal(ask(credential, 'bare-w', WRAP_UP).status, 0, 'asked again unchanged, it goes through');
  for (const [n, question] of ['Which name?\nKind: preference', 'Which name? (Kind: taste)', 'Which deploy step?\nKind: private', 'Which fix?\nKind: ambiguity'].entries()) {
    assert.equal(ask(asking(question), `bare-${n}`).status, 2, question);
  }
  assert.equal(holds(t, `${CLOSING}\n\nKind: private`), true, 'on Stop');
  assert.equal(exit(transcript(owner(), toolUse('WebFetch', { url: 'https://example.com' })), WRAP_UP, credential), 0, 'after research');
  assert.equal(exit(transcript(owner(), toolUse('Bash', { command: 'git status' })), ASK, asking('Which deploy step?\nKind: private')), 0, 'after a look');
  assert.equal(exit(t, ASK, asking('Which name?\nKind: preference', 'Ship it?\nKind: approval')), 2, 'beside an approval');
  // About something outside, a look is not enough: it takes research.
  const outside = asking('Which credits pay for the API tier?\nKind: preference', 'Where does the Keychain key live?\nKind: private');
  assert.equal(exit(transcript(owner(), toolUse('Read'), toolResult()), ASK, outside), 2, 'outside, after a look');
  assert.equal(exit(transcript(owner(), toolUse('WebSearch'), toolResult()), ASK, outside), 0, 'outside, after research');
  assert.equal(exit(transcript(owner(), toolUse('Read'), toolResult()), ASK, asking('Which credits pay for the API tier?\nKind: money')), 0, 'money about something outside still passes at once');
  assert.deepEqual(lines().map((l) => [l['kind'], l['outcome']]), [
    ['preference', 'held'],
    ['preference', 'passed: second ask'],
    ['preference', 'held'],
    ['preference', 'held'],
    ['private', 'held'],
    ['ambiguity', 'held'],
  ]);
});

test('ask-gate: a researchable, unknown, loose or partial declaration stays held', () => {
  for (const question of [
    'Which default?\nKind: default',
    'Which version?\nKind: version',
    'Which name?\nKind: urgent',
    'Which name?\nKind: decision about API defaults',
    'Which name?\nKind: preference\nKind: api',
    'Which name is the right kind: preference or style?',
    'Which name?\nKind:',
  ]) {
    assert.equal(exit(transcript(owner()), ASK, asking(question)), 2, question);
  }
  assert.equal(exit(transcript(owner()), ASK, asking('Which name?\nKind: preference', 'Which tone?')), 2, 'one question undeclared');
  assert.equal(exit(transcript(owner()), ASK, asking(['Which name?', 'Name'], ['Which tone?', 'Name'])), 2, 'no question declares');
  const options = { questions: [{ question: 'Which name?', header: 'Name', options: [{ label: 'a', description: 'Kind: preference' }, { label: 'b' }], multiSelect: false }] };
  assert.equal(exit(transcript(owner()), ASK, options), 2, 'an option is no declaration');
  assert.equal(holds(transcript(owner()), `${CLOSING}\n\nShould the field read \`Kind: preference\` or something else?`), true, 'on Stop, code is no declaration');
  assert.equal(holds(transcript(owner()), `${CLOSING}\n\n> Kind: preference`), true, 'on Stop, a quoted line is no declaration');
});

test('ask-gate: a declaration that runs into the question does not hide it', () => {
  const { run, lines } = logged();
  const t = transcript(owner());
  for (const [n, message] of ['Both fail.\n\nKind: api - fix the parser first or the lexer?', 'Both fail.\n\nKind: preference, fix the parser first or the lexer?'].entries()) {
    const answer = run({ ...stopEvent(t, message), session_id: `run-in-${n}` });
    assert.match(answer.stdout, /research before you ask/, message);
  }
  assert.equal(run({ tool_name: WRAP_UP, tool_input: { recap: 'r', ask: 'Kind: x - parser or lexer?' }, transcript_path: t, session_id: 'run-in-w' }).status, 2, 'a wrap_up with no buttons');
  assert.equal(run({ tool_name: WRAP_UP, tool_input: { recap: 'r', ask: 'Ship it? Kind: money or credentials', actions: [{ label: 'Yes' }, { label: 'Not now' }] }, transcript_path: t, session_id: 'run-in-g' }).status, 0, 'a known kind leaves a go-ahead a go-ahead');
  assert.deepEqual(lines().map((l) => [l['via'], l['kind'], l['outcome']]), [
    ['Stop', 'api fix the parser first or the lexer?', 'held'],
    ['Stop', 'preference, fix the parser first or the ', 'held'],
    [WRAP_UP, 'x parser or lexer?', 'held'],
  ]);
});

test('ask-gate: ambiguity passes only after a look', () => {
  const ambiguous = asking('Which fix?\nKind: ambiguity');
  assert.equal(exit(transcript(owner()), ASK, ambiguous), 2, 'no look');
  assert.equal(exit(transcript(owner(), toolUse('Read', { file_path: '/x' })), ASK, ambiguous), 0, 'after a Read');
  assert.equal(exit(transcript(owner(), toolUse('Bash', { command: 'git log -1' })), ASK, asking('Which fix?\nKind: ambiguity left after research')), 0, 'after a git read, the row name');
  assert.equal(exit(transcript(owner(), toolUse('Read', { file_path: '/x' })), ASK, asking('Which fix?\nKind: ambiguity\nKind: api')), 2, 'beside a researchable kind');
});

test('ask-gate: a declared pass spends nothing; the second-ask escape stays', () => {
  const state = join(TMP, 'state-declared');
  const t = transcript(owner());
  const run = (toolInput: Entry): number | null => gate({ tool_name: ASK, tool_input: toolInput, transcript_path: t, session_id: 'declared' }, {}, state).status;
  assert.equal(run(asking('Merge now or wait?\nKind: approval')), 0);
  assert.equal(run(QUESTION), 2, 'an undeclared ask after it is still held once');
  assert.equal(run(asking('Which version?\nKind: version')), 0, 'and the next ask goes through, declared or not');
  assert.equal(exit(transcript(owner()), WRAP_UP, { recap: 'r', ask: 'Ship it? Kind: approval', actions: [{ label: 'Yes' }, { label: 'Not now' }] }), 0, 'a go-ahead still passes');
});

test('ask-gate: the refusal and the Stop feedback say how to declare', () => {
  const refusal = gate({ tool_name: ASK, tool_input: QUESTION, transcript_path: transcript(owner()), session_id: 'how' }).stderr;
  const feedback = gate(stopEvent(transcript(owner()), CLOSING)).stdout;
  for (const text of [refusal, feedback]) {
    assert.match(text, /When you first ask such a question, declare it on a line of its own, Kind: approval \(or money, irreversible\), and it goes through/);
    assert.match(text, /Kind: preference \(or private, ambiguity\) goes through only after research or a look at the sources/);
    assert.match(text, /A Kind: line added once a question is held does not pass it/);
    assert.match(text, /there was none either, and a question about an outside tool, service, API, price or credentials needs that research/);
  }
  const lookedRefusal = gate({ tool_name: ASK, tool_input: QUESTION, transcript_path: transcript(owner(), toolUse('Read')), session_id: 'how-looked' }).stderr;
  assert.match(lookedRefusal, /there was a look, but a question about an outside tool/);
});

test('ask-gate log: the declared kind, per question and for the ask', () => {
  const { run, lines } = logged();
  const t = transcript(owner());
  run({ tool_name: ASK, tool_input: asking('Which name?\nKind: taste', ['Which key?', 'Kind: money']), transcript_path: transcript(owner(), toolUse('Read')), session_id: 'k1' });
  run({ tool_name: ASK, tool_input: asking('Which default?\nKind: defaults'), transcript_path: t, session_id: 'k2' });
  run({ tool_name: ASK, tool_input: asking('Which name?\nKind: Urgent'), transcript_path: t, session_id: 'k3' });
  run({ ...stopEvent(t, `${CLOSING}\n\nKind: approval`), session_id: 'k4' });
  const [owned, researchable, unknown, stop] = lines();
  assert.deepEqual([owned?.['kind'], owned?.['outcome'], (owned?.['questions'] as Entry[]).map((q) => q['kind'])], ['preference, money', 'passed: declared preference, money', ['preference', 'money']]);
  assert.deepEqual([researchable?.['kind'], researchable?.['outcome']], ['default', 'held']);
  assert.deepEqual([unknown?.['kind'], unknown?.['outcome']], ['urgent', 'held']);
  assert.deepEqual([stop?.['via'], stop?.['kind'], stop?.['outcome']], ['Stop', 'approval', 'passed: declared approval']);
});

test("ask-gate: every word and row in research-first's table declares", () => {
  const skill = readFileSync(fileURLToPath(new URL('../../skills/research-first/SKILL.md', import.meta.url)), 'utf8');
  const rows = skill.split('\n').filter((l) => /^\| [A-Z].* \| `[a-z]+` \|$/.test(l));
  assert.equal(rows.length, 6, 'six owner-only kinds, each with the word to declare');
  for (const row of rows) {
    const [name, , , word] = row.split(' | ').map((c) => c.replace(/^\| |`| \|$/g, ''));
    const look = toolUse('Read', { file_path: '/x' });
    assert.equal(exit(transcript(owner(), look), ASK, asking(`Which one?\nKind: ${word}`)), 0, String(word));
    assert.equal(exit(transcript(owner(), look), ASK, asking(`Which one?\nKind: ${name}`)), 0, String(name));
  }
});

// --- a relabel after a hold ------------------------------------------------------
interface Session {
  readonly path: string;
  readonly state: string;
  readonly ask: (tool: string, toolInput: Entry) => Run;
  readonly stop: (message: string, extra?: Entry) => Run;
  readonly lines: () => Entry[];
}
/** A runner in one session over one transcript, with its own log and state. */
function session(name: string, path = transcript(owner())): Session {
  const { run, lines } = logged();
  const state = join(TMP, `state-relabel-${name}`);
  return {
    path,
    state,
    ask: (tool, toolInput) => run({ tool_name: tool, tool_input: toolInput, transcript_path: path, session_id: name }, {}, state),
    stop: (message, extra = {}) => run({ ...stopEvent(path, message), session_id: name, ...extra }, {}, state),
    lines,
  };
}
const outcomes = (lines: Entry[]): unknown[][] => lines.map((l) => [l['via'], l['kind'], l['outcome'], l['relabelled']]);
const firstTurn = (path: string): string => String((JSON.parse(readFileSync(path, 'utf8').split('\n')[0] ?? '{}') as Entry)['uuid']);

test('ask-gate: a Kind: line added after a hold is held once more, then the turn passes', () => {
  // The owner's log, 2026-11-19: a wrap_up ask held, then asked again with only Kind: private added.
  const s = session('relabel-wrap', transcript(owner(), toolUse('Read'), toolResult()));
  const ask = 'Have you cloned the repository and added the key?';
  const buttons = [{ label: 'Both done' }, { label: 'Clone done, key later' }];
  assert.equal(s.ask(WRAP_UP, { recap: 'r', ask, actions: buttons }).status, 2, 'held');
  const relabel = s.ask(WRAP_UP, { recap: 'r', ask: `${ask}\nKind: private`, actions: buttons });
  assert.equal(relabel.status, 2, 'the relabel is held');
  assert.match(relabel.stderr, /^BLOCKED: research before you ask\. This question was held earlier in this turn, and only its Kind: line is new: a label added after a hold passes nothing, and the relabel is logged\./);
  assert.match(relabel.stderr, /asked once more, it goes through\.\n$/);
  assert.equal(s.ask(WRAP_UP, { recap: 'r', ask: `${ask}\nKind: private`, actions: buttons }).status, 0, 'asked once more, it goes through');
  assert.equal(s.ask(ASK, QUESTION).status, 0, 'and so does anything after it in the turn');
  assert.deepEqual(outcomes(s.lines()), [
    [WRAP_UP, null, 'held', undefined],
    [WRAP_UP, 'private', 'held: relabelled', undefined],
    [WRAP_UP, 'private', 'passed: second ask', true],
    [ASK, null, 'passed: second ask', false],
  ]);

  writeFileSync(s.path, `${readFileSync(s.path, 'utf8')}${owner('next task')}\n${toolUse('Read')}\n`);
  assert.equal(s.ask(WRAP_UP, { recap: 'r', ask: `${ask}\nKind: private`, actions: buttons }).status, 0, 'in a new turn it is a first ask, declared after a look');
  assert.equal(s.lines().at(-1)?.['outcome'], 'passed: declared private');
});

test('ask-gate: what a relabel is, and what it is not', () => {
  const relabelled = (held: Entry, again: Entry, tool = ASK): number | null => {
    const s = session(`relabel-${sessions++}`);
    assert.equal(s.ask(tool, held).status, 2, 'held first');
    return s.ask(tool, again).status;
  };
  assert.equal(relabelled(QUESTION, asking(['Which name?', 'Kind: money'])), 2, 'a kind added in the header');
  assert.equal(relabelled(asking('Which default?\nKind: default'), asking('Which default?\nKind: approval')), 2, 'a kind changed');
  assert.equal(relabelled(asking('Which  name?'), asking('which name ?\n**Kind:** approval')), 2, 'case, spacing and markup aside');
  assert.equal(relabelled(asking('Which name?', 'Which tone?'), asking('Which name?\nKind: approval', 'Which tone?\nKind: approval')), 2, 'a batch');
  assert.equal(relabelled(QUESTION, asking('Merge now or wait?\nKind: approval')), 0, 'another question, declared, passes as declared');
  assert.equal(relabelled(QUESTION, asking('Which name, given the README uses kebab case?\nKind: approval')), 0, 'a question with what was found');
  assert.equal(relabelled(QUESTION, QUESTION), 0, 'the same question unchanged');
  assert.equal(relabelled(asking('Which name?\nKind: preference'), asking('Which name?\nKind: preference')), 0, 'the same declaration again');
  assert.equal(relabelled(wrapAsking('Which fix first?'), wrapAsking('Which fix first?\nKind: approval'), WRAP_UP), 2, 'a wrap_up ask');
  // Research after the hold passes before the relabel is read.
  const s = session('relabel-research');
  assert.equal(s.ask(ASK, QUESTION).status, 2);
  writeFileSync(s.path, `${readFileSync(s.path, 'utf8')}${toolUse('WebSearch')}\n`);
  assert.equal(s.ask(ASK, asking('Which name?\nKind: preference')).status, 0, 'research after the hold');
  assert.equal(s.lines().at(-1)?.['outcome'], 'passed: research');
});

test('ask-gate on Stop: a relabel across the PreToolUse and Stop paths', () => {
  const s = session('relabel-stop');
  assert.equal(s.ask(WRAP_UP, wrapAsking('Fix the parser first or the lexer?')).status, 2, 'a wrap_up ask held');
  const feedback = s.stop(`${CLOSING}\n\nKind: preference`);
  assert.equal(feedback.status, 0);
  const context = (JSON.parse(feedback.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  assert.match(context, /^research before you ask\. This question was held earlier in this turn, and only its Kind: line is new/);
  assert.match(context, /ended again, the turn ends\.$/);
  assert.equal(s.stop(`${CLOSING}\n\nKind: preference`, { stop_hook_active: true }).stdout, '', 'the continuation ends');
  assert.equal(s.stop(`${CLOSING}\n\nKind: preference`).stdout, '', 'and any later Stop in the turn');

  const t = session('relabel-stop-2');
  assert.notEqual(t.stop(CLOSING).stdout, '', 'a closing question held');
  assert.equal(t.ask(WRAP_UP, wrapAsking('Fix the parser first or the lexer?\nKind: approval')).status, 2, 'the same question as a wrap_up ask, relabelled');
  assert.deepEqual(outcomes([...s.lines(), ...t.lines()]), [
    [WRAP_UP, null, 'held', undefined],
    ['Stop', 'preference', 'held: relabelled', undefined],
    ['Stop', 'preference', 'passed: second ask', true],
    ['Stop', null, 'held', undefined],
    [WRAP_UP, 'approval', 'held: relabelled', undefined],
  ]);
});

test('ask-gate: the state file, old and new, and what it cannot read', () => {
  const s = session('state-file');
  assert.equal(s.ask(ASK, QUESTION).status, 2);
  const [key, kept] = readFileSync(join(s.state, 'state-file'), 'utf8').split('\n');
  assert.equal(key, firstTurn(s.path), 'the turn first, as before');
  assert.deepEqual(JSON.parse(kept ?? '{}'), { held: [{ question: 'which name', kind: [] }], relabel_held: false });

  const old = session('state-old');
  mkdirSync(old.state, { recursive: true });
  writeFileSync(join(old.state, 'state-old'), `${firstTurn(old.path)}\n`);
  assert.equal(old.ask(ASK, asking(['Which name?', 'Kind: money'])).status, 0, "0.7.8's state, the turn alone, holds no question to relabel");
  assert.equal(old.ask(ASK, QUESTION).status, 0, '... and still spends the turn');

  const bad = session('state-bad');
  mkdirSync(bad.state, { recursive: true });
  writeFileSync(join(bad.state, 'state-bad'), `${firstTurn(bad.path)}\n{not json`);
  assert.equal(bad.ask(ASK, QUESTION).status, 0, 'a held list it cannot read passes');
  assert.equal(bad.ask(ASK, asking('Merge now or wait?\nKind: approval')).status, 0, 'a declared ask passes as declared');
  assert.deepEqual(bad.lines().map((l) => l['outcome']), ['passed: state unreadable', 'passed: declared approval']);

  for (const [n, kept] of [
    '{"held": 5, "relabel_held": false}',
    '{"held": [{"question": "which name", "kind": 5}], "relabel_held": false}',
    '{"held": [{"question": "which name", "kind": [1]}], "relabel_held": false}',
    '{"held": ["which name"], "relabel_held": false}',
    '{"held": [], "relabel_held": "yes"}',
    '[]',
  ].entries()) {
    const shape = session(`state-shape-${n}`);
    mkdirSync(shape.state, { recursive: true });
    writeFileSync(join(shape.state, `state-shape-${n}`), `${firstTurn(shape.path)}\n${kept}\n`);
    const answer = shape.ask(ASK, asking(['Which name?', 'Kind: money']));
    assert.deepEqual([answer.status, answer.stderr], [0, ''], kept);
    assert.equal(shape.ask(ASK, QUESTION).status, 0, `${kept}: an undeclared ask passes too`);
    assert.deepEqual(shape.lines().map((l) => l['outcome']), ['passed: declared money', 'passed: state unreadable'], kept);
  }
});

// --- Stop: an ask to the owner that no wrap_up carries -----------------------------
/** The desktop app names its wrap_up for the session's hooks. */
const DESKTOP = { CLAUDE_CODE_TERMINAL_MCP_TOOLS: WRAP_UP };
/** Two closing messages of a real side session that waited on the owner and was never filed (2026-11-19). */
const NEEDS_YOU_259 =
  '**Needs you:** to let the sarathi fix ship, please 👍 the [Proposal on veda-hq/veda#259](https://github.com/veda-hq/veda/issues/259#issuecomment-7008691971). Until you do, veda\'s rules refuse the push.\n' +
  '**Done:** the veda session committed the skill fix and the bump to sarathi 0.7.7 on its own branch (6faba89), and tests pass. Nothing is pushed or on npm yet.\n' +
  '**Next:** after your 👍 it pushes, merges and publishes the release.';
const NEEDS_YOU_261 =
  '**Needs you:** to unblock the second sarathi fix, please 👍 the [Proposal on veda-hq/veda#261](https://github.com/veda-hq/veda/issues/261#issuecomment-7008845476). The working-rules session needs it before it can edit anything.\n' +
  '**Done:** veda-hq/veda#260 is set to auto-merge but hasn\'t merged yet.\n' +
  '**Next:** once it merges, the veda session tags `v0.7.7` and checks npm.';
/** A side session's turn: another session's message starts it, and it works. */
const sideTurn = (...more: string[]): string => transcript(peer(), toolUse('Bash', { command: 'git status' }), toolResult(), ...more);

/** The feedback a Stop gives, or '' when the turn ends. */
function stopFeedbackOf(path: string, message: unknown, env: NodeJS.ProcessEnv = DESKTOP, extra: Entry = {}): string {
  const run = gate(stopEvent(path, message, extra), env);
  assert.equal(run.status, 0, 'Stop never exits 2');
  assert.equal(run.stderr, '');
  if (run.stdout === '') return '';
  return (JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

test('ask-gate on Stop: a plain-text ask with no wrap_up ask goes on once, to make the ask', () => {
  for (const message of [NEEDS_YOU_259, NEEDS_YOU_261]) {
    const feedback = stopFeedbackOf(sideTurn(), message);
    assert.match(feedback, /^file the ask\. Your closing message asks the owner something \(\*\*Needs you:\*\* /);
    assert.match(feedback, /Call wrap_up now with the question as ask, reply buttons as actions, and blocked: true if your work stops/);
    assert.match(feedback, /If the turn does not wait on the owner, end it again as it is\./);
  }
  assert.equal(stopFeedbackOf(sideTurn(), NEEDS_YOU_259, DESKTOP, { stop_hook_active: true }), '', 'once: a Stop already going on ends');
  for (const [why, message] of [
    ['a question that ends its line', 'The parser is fixed.\n\nShall I tag v0.7.11 now?'],
    ['a plain "Needs you:"', 'Needs you: add the approved label to https://github.com/veda-hq/veda/issues/289.'],
    ['a bulleted question', 'Two open points:\n- Should old files go by age, by size, or both?'],
    ['a question that ends on a URL', 'The page is published. Should we open https://example.com/page?'],
  ] as const) {
    assert.match(stopFeedbackOf(sideTurn(), message), /^file the ask\./, why);
  }
});

test('ask-gate on Stop: what is no ask to the owner ends the turn', () => {
  for (const [why, message] of [
    ['no question', 'Merged as 5bdcdd6, and v0.7.9 is on npm.'],
    ['a question answered on its own line', '**Can 0117 close?** Yes, once #2303 merges.'],
    ['a quoted title', 'I archived the leftover side session, "btw: How?".'],
    ['a question in code', 'Run `which node?` to see.'],
    ['a quoted line', 'You asked:\n> Which one first?\n\nThe parser, done.'],
    ['a URL with a query', 'See https://example.com/a?b=c for the run.'],
    ['a question four paragraphs back', 'Ship it?\n\nOne.\n\nTwo.\n\nThree.'],
  ] as const) {
    assert.equal(stopFeedbackOf(sideTurn(), message), '', why);
  }
});

test('ask-gate on Stop: a wrap_up ask this turn, or no wrap_up at all, ends the turn', () => {
  const wrapUp = (input: Entry): string => toolUse(WRAP_UP, input);
  assert.equal(stopFeedbackOf(sideTurn(wrapUp({ recap: 'r', ask: 'Approve #259?', actions: [{ label: 'Approved' }] })), NEEDS_YOU_259), '', 'the ask is filed');
  assert.match(stopFeedbackOf(sideTurn(wrapUp({ recap: 'r' })), NEEDS_YOU_259), /^file the ask\./, 'a wrap_up without an ask');
  assert.match(stopFeedbackOf(sideTurn(wrapUp({ recap: 'r', ask: '  ' })), NEEDS_YOU_259), /^file the ask\./, 'a blank ask');
  assert.match(
    stopFeedbackOf(transcript(peer(), wrapUp({ recap: 'r', ask: 'Approve #259?' }), toolResult(), owner('not yet'), toolUse('Read')), NEEDS_YOU_259),
    /^file the ask\./,
    'an ask in an earlier turn does not count',
  );
  assert.equal(
    stopFeedbackOf(transcript(peer(), wrapUp({ recap: 'r', ask: 'Approve #259?' }), stopFeedback()), NEEDS_YOU_259),
    '',
    "a Stop hook's feedback starts no turn",
  );
  for (const [why, report] of [['a marked task report', handBack()], ['an unmarked one', handBackUnmarked()]] as const) {
    assert.equal(
      stopFeedbackOf(transcript(peer(), wrapUp({ recap: 'r', ask: 'Approve #259?' }), toolResult(), report, toolUse('Read')), NEEDS_YOU_259),
      '',
      `${why} starts no new ask: the wrap_up ask before it stands`,
    );
  }
  // Many reminders ahead of a row cost one pass each, not a backtrack that doubles with every block.
  const reminders = line({ type: 'user', uuid: next(), message: { role: 'user', content: `${'<system-reminder>r</system-reminder>\n'.repeat(40)}<side-sessions-event>done` } });
  const started = Date.now();
  assert.match(stopFeedbackOf(transcript(peer(), wrapUp({ recap: 'r', ask: 'Approve #259?' }), reminders), NEEDS_YOU_261), /^file the ask\./, 'an app event behind reminders starts a turn');
  assert.ok(Date.now() - started < 3000, '40 leading reminders read in well under the hook timeout');
  // In a side session the answer comes relayed: another session's message, or an app event, starts the next turn.
  for (const [why, next] of [['a peer message', peer()], ['an app event', appEvent()]] as const) {
    assert.match(
      stopFeedbackOf(transcript(peer(), wrapUp({ recap: 'r', ask: 'Approve #259?' }), toolResult(), next, toolUse('Read')), NEEDS_YOU_261),
      /^file the ask\./,
      `an ask before ${why} does not count`,
    );
  }
  assert.equal(
    stopFeedbackOf(transcript(peer(), wrapUp({ recap: 'r', ask: 'Approve #259?' }), reminderOnly()), NEEDS_YOU_259),
    '',
    'a row of reminders alone starts no turn',
  );
  // A terminal session that only read a file naming wrap_up has no wrap_up: its research hold is as before.
  const readSettings = line({
    type: 'user',
    uuid: next(),
    toolUseResult: { ok: true },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: `"matcher": "AskUserQuestion|${WRAP_UP}"` }] },
  });
  assert.match(stopFeedbackOf(transcript(owner(), toolUse('Read', { file_path: '.claude/settings.json' }), readSettings), CLOSING, {}), /^research before you ask\./, 'a mention is no call');
  // A terminal session has no wrap_up: the research hold is as before.
  assert.equal(stopFeedbackOf(sideTurn(), NEEDS_YOU_259, {}), '', 'no wrap_up, no plain choice: the turn ends');
  assert.match(stopFeedbackOf(transcript(owner()), CLOSING, {}), /^research before you ask\./, 'no wrap_up: a choice is held for research');
  // A session that has called wrap_up has it, whatever the environment says.
  assert.match(stopFeedbackOf(sideTurn(wrapUp({ recap: 'r' })), NEEDS_YOU_259, {}), /^file the ask\./);
  assert.match(stopFeedbackOf(transcript(owner()), CLOSING, { CLAUDE_CODE_TERMINAL_MCP_TOOLS: `mcp__other__tool,${WRAP_UP}` }), /^file the ask\./, 'a list naming it');
});

test('ask-gate log: a nudge is a line, with the asking line', () => {
  const state = join(TMP, 'state-nudge');
  gate({ ...stopEvent(sideTurn(), NEEDS_YOU_259), session_id: 'nudge' }, DESKTOP, state);
  const lines = readFileSync(join(state, 'ask-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Entry);
  assert.deepEqual(
    lines.map((l) => [l['via'], l['outcome'], (l['questions'] as Entry[])[0]?.['question']]),
    [['Stop', 'nudged: no wrap_up ask', NEEDS_YOU_259.split('\n')[0]?.slice(0, 300)]],
  );
});

// --- links in asks ---------------------------------------------------------------
/** The real slip (2026-11-22): an ask that named the comment and its issue by number alone. */
const SLIP = '👍 the Guards Proposal on #376 (comment 7068450411)';
const COMMENT_URL = 'https://github.com/veda-hq/veda/issues/376#issuecomment-7068450411';
const linkRun = (tool: string, toolInput: Entry, path = transcript(owner())): Run =>
  gate({ tool_name: tool, tool_input: toolInput, transcript_path: path, session_id: `s${sessions++}` });
const askOf = (question: string): Entry => ({ questions: [{ question, header: 'Ask', options: [{ label: 'Done' }, { label: 'Later' }], multiSelect: false }] });
const goAhead = (ask: string, extra: Entry = {}): Entry => ({ recap: 'r', ask, actions: [{ label: 'Done' }, { label: 'Not now' }], ...extra });

test('ask-gate links: an ask that names an issue, pull request or comment by number alone is refused', () => {
  const run = linkRun(WRAP_UP, goAhead(SLIP));
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^BLOCKED: give the full link\. This ask names #376, comment 7068450411 by number alone\./);
  assert.match(run.stderr, /https:\/\/github\.com\/<owner>\/<repo>\/\.\.\. URL/);
  assert.match(run.stderr, /a URL in the recap covers its number too/);
  for (const [why, ask] of [
    ['the slip', SLIP],
    ['#N', 'Approve #376?'],
    ['owner/repo#N', 'Approve veda-hq/veda#376?'],
    ['PR N', 'Merge PR 382 now?'],
    ['PR #N', 'Merge PR #382 now?'],
    ['pull request N', 'Merge pull request 382 now?'],
    ['issue N', 'Close issue 382?'],
    ['comment N on #N', '👍 comment 7068450411 on #376'],
    ['a URL that carries another number', '👍 #376: https://github.com/veda-hq/veda/issues/3760'],
    ['a URL off github.com', '👍 #376: https://example.com/issues/376'],
    ['a comment fragment alone', '👍 #issuecomment-7068450411'],
    ['a review comment fragment alone', '👍 discussion_r99 first'],
    ['a GitHub search URL', '👍 #376: https://github.com/search?q=/issues/376'],
    ['a GitHub URL with no owner/repository route', '👍 #376: https://github.com/issues/376'],
    ['a comment number only in the query', '👍 comment 7 on https://github.com/veda-hq/veda/issues/376?c=issuecomment-7'],
  ] as const) {
    assert.equal(linkRun(WRAP_UP, goAhead(ask)).status, 2, `wrap_up: ${why}`);
    assert.equal(linkRun(ASK, askOf(ask)).status, 2, `AskUserQuestion: ${why}`);
  }
  assert.equal(linkRun(WRAP_UP, { recap: 'r', ask: 'Done?', actions: [{ label: 'Merge #382' }] }).status, 2, 'a button');
  assert.equal(
    linkRun(ASK, { questions: [{ question: 'Which goes first?', header: 'Order', options: [{ label: 'a', description: 'PR 382' }, { label: 'b' }], multiSelect: false }] }).status,
    2,
    'an option description',
  );
});

test('ask-gate links: the refusal comes before every pass', () => {
  const researched = transcript(owner(), toolUse('WebSearch', { query: 'q' }), toolResult());
  const looked = transcript(owner(), toolUse('Read'), toolResult());
  for (const [why, path, input] of [
    ['a go-ahead with yes/no buttons', transcript(owner()), goAhead(SLIP)],
    ['one button', transcript(owner()), { recap: 'r', ask: SLIP, actions: [{ label: 'Done' }] }],
    ['no buttons', transcript(owner()), { recap: 'r', ask: SLIP }],
    ['after research', researched, goAhead(SLIP)],
    ['after a look', looked, goAhead('Which of #376 and #377 first?')],
    ['a declared approval', transcript(owner()), goAhead(`${SLIP}. Kind: approval`)],
  ] as const) {
    assert.equal(linkRun(WRAP_UP, input, path).status, 2, why);
  }
  // Nothing lets a repeat through: the same ask, again in the same session and turn.
  const t = transcript(owner());
  const again = (): number | null => gate({ tool_name: WRAP_UP, tool_input: goAhead(SLIP), transcript_path: t, session_id: 'links-again' }).status;
  assert.deepEqual([again(), again(), again()], [2, 2, 2]);
});

test('ask-gate links: an ask with the full URL, and a number that is no reference, go through', () => {
  for (const [why, ask, extra] of [
    ['the URL in place of the numbers', `👍 the Guards Proposal on ${COMMENT_URL}`, {}],
    ['the numbers with the URL', `👍 the Guards Proposal on #376 (${COMMENT_URL})`, {}],
    ['a markdown link', '👍 [veda-hq/veda#376](https://github.com/veda-hq/veda/issues/376)', {}],
    ['a pull request URL', 'Merge PR 382 (https://github.com/veda-hq/veda/pull/382)?', {}],
    ['a review comment URL', '👍 comment 99 on https://github.com/veda-hq/veda/pull/382#discussion_r99', {}],
    ['the URL in the recap', SLIP, { recap: `The Proposal: ${COMMENT_URL}` }],
    ['no number', 'Tag v0.8.0 now?', {}],
    ['a version, a count, a time', 'Ship 0.7.20 with 3 fixes at 10:00?', {}],
  ] as const) {
    assert.equal(linkRun(WRAP_UP, goAhead(ask, extra)).status, 0, `wrap_up: ${why}`);
  }
  assert.equal(linkRun(ASK, askOf(`👍 the Guards Proposal on ${COMMENT_URL}. Kind: approval`)).status, 0, 'AskUserQuestion: the URL, declared');
  assert.equal(linkRun(WRAP_UP, { recap: 'Merged #383; CI is green.' }).status, 0, 'a bare number in a recap with no ask');
  assert.equal(linkRun(WRAP_UP, { recap: 'r', ask: 'Which goes first?', actions: [{ action: 'commit' }] }).status, 0, 'an app action');
});

test('ask-gate links on Stop: an ask by number alone goes back once, quoted, with the fix', () => {
  const feedback = stopFeedbackOf(sideTurn(), SLIP);
  assert.match(feedback, /^give the full link\. Your closing message asks the owner about #376, comment 7068450411 by number alone \(👍 the Guards Proposal on #376 \(comment 7068450411\)\)\./);
  assert.match(feedback, /issues\/N#issuecomment-M/);
  assert.match(feedback, /call wrap_up first with it as ask/, 'no wrap_up carried the ask');
  assert.match(feedback, /If the sentence asks the owner nothing, end the turn again as it is\.$/);
  assert.doesNotMatch(stopFeedbackOf(transcript(owner()), SLIP, {}), /call wrap_up/, 'a terminal session has no wrap_up');
  assert.equal(stopFeedbackOf(sideTurn(), SLIP, DESKTOP, { stop_hook_active: true }), '', 'once: a Stop already going on ends');
  for (const [why, message] of [
    ['the slip', SLIP],
    ['the slip, as a Needs you line', `Done.\n\n**Needs you:** ${SLIP}.`],
    ['a question', 'The fix is in. Can #383 merge now?'],
    ['please', 'Please 👍 the Proposal on #376.'],
    ['approve', 'Approve the slice on #376 when you can.'],
    ['read', 'Read comment 7068450411 first.'],
    ['your approval', 'It waits on your approval on veda-hq/veda#376.'],
    ['a numbered step', 'Two things:\n\n1. Approve PR 382.\n2. Then tag it.'],
    ['the id a sentence before the question', 'PR #382 is green. Merge it?'],
    ['check', 'Check PR #382.'],
    ['open', 'Open #376 when you are back.'],
    ['a comment fragment', 'Please 👍 #issuecomment-7068450411.'],
    ['a report, then a question, on one line', 'Fixed in #383. Anything else?'],
  ] as const) {
    assert.match(stopFeedbackOf(sideTurn(), message), /^give the full link\./, why);
  }
});

test('ask-gate links on Stop: a report, and an ask with its URL, end the turn', () => {
  for (const [why, message] of [
    ['a URL that ends the sentence', `Please 👍 ${COMMENT_URL}.`],
    ['a report that mentions #383','Merged https://github.com/veda-hq/veda/pull/390. The old branch from #383 is deleted, and Secret scans pass again.'],
    ['a report, then a question with no number', 'Fixed in #383.\n\nAnything else?'],
    ['a quoted ask in a report', 'The slip "👍 the Guards Proposal on #376 (comment 7068450411)" is now held.'],
    ['a curly-quoted ask in a report', 'The slip “Approve #376?” is now held.'],
    ['an ask in inline code', 'The test pins `Approve #376?` as held.'],
    ['a Done line beside a linked Needs you', NEEDS_YOU_261],
    ['a question answered on its own line', '**Can 0117 close?** Yes, once #2303 merges.'],
    ['a review report', 'Review of #383 found nothing. Reviewed by Cubic on #384.'],
    ['read-only', 'Read-only checks on #383 pass.'],
    ['the slip with its URL', `👍 the Guards Proposal on #376 (${COMMENT_URL})`],
    ['the URL elsewhere in the message', `The Proposal: ${COMMENT_URL}\n\n${SLIP}`],
    ['a number in fenced code', 'Done.\n\n```\nApprove #376?\n```'],
    ['a quoted line', 'You asked:\n> Approve #376?\n\nDone.'],
  ] as const) {
    assert.doesNotMatch(stopFeedbackOf(transcript(owner()), message, {}), /^give the full link/, why);
  }
});

test('ask-gate links log: a refusal is a line, with the references', () => {
  const log = logged();
  log.run({ tool_name: WRAP_UP, tool_input: goAhead(SLIP), transcript_path: transcript(owner()), session_id: 'links-log', tool_use_id: 't1' });
  log.run(stopEvent(transcript(owner()), SLIP));
  assert.deepEqual(
    log.lines().map((l) => [l['via'], l['outcome'], l['refs']]),
    [
      [WRAP_UP, 'held: bare reference', ['#376', 'comment 7068450411']],
      ['Stop', 'held: bare reference', ['#376', 'comment 7068450411']],
    ],
  );
});
