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
    ['a pull request reference', { recap: 'r', ask: 'Merge acme/widgets#12 now?', actions: [{ label: 'Yes' }, { label: 'Not now' }] }],
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
    ['an irreversible step, asked yes/no', 'Delete the branch?'],
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

  // A handler that exits 2 wins, and sarathi answers with its reason alone
  // (README, "Research before you ask"): the held question's feedback is not shown.
  const beside = through([gateEntry, { command: 'cat >/dev/null; echo "keep going" >&2; exit 2' }]);
  assert.deepEqual(beside, { status: 2, stdout: '', stderr: 'keep going\n' });
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
    ['#N', asking('Close #12 or keep it?')],
    ['owner/repo#N', asking('Which of acme/widgets#12 and #13 first?')],
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
  const wrapUp = { recap: 'r', ask: 'PR #12 failed CI: retry it or revert?', actions: [{ label: 'Retry' }, { label: 'Revert' }] };
  assert.equal(exit(looked, WRAP_UP, wrapUp), 0, 'a wrap_up ask');
  assert.equal(exit(looked, WRAP_UP, { ...wrapUp, ask: 'Which one first?', actions: [{ label: 'The PR' }, { label: 'The issue' }] }), 0, 'a wrap_up button');
  assert.equal(holds(looked, 'Done.\n\nPR #12 failed CI. Retry it or revert?'), false, "a closing question whose paragraph names the state");
  assert.equal(holds(looked, 'Edited `src/a.ts`.\n\nRetry it or revert?'), true, 'the state named only in another paragraph');
  assert.equal(holds(looked, 'Retry it or revert?'), true, 'a closing message that names none');
  for (const [why, input] of [
    ['a docs URL', asking('Which API does https://docs.example.com/api/v2.html describe?')],
    ['a version pair', asking('Target 1.2/1.3 or 2.0?')],
  ] as const) {
    assert.equal(exit(looked, ASK, input), 2, why);
  }
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
    questions: [{ question: 'Which name?', options: ['a', 'b'] }],
    researched: false,
    looked: false,
    names_state: false,
    kind: null,
    outcome: 'held',
  });
  assert.equal(second?.['outcome'], 'passed: second ask');
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
  assert.deepEqual([wrap?.['via'], wrap?.['questions'], wrap?.['outcome']], [WRAP_UP, [{ question: 'Which fix first?', options: ['The parser', 'The lexer'] }], 'held']);
  assert.deepEqual([stop?.['via'], stop?.['questions'], stop?.['tool_use_id'], stop?.['outcome']], ['Stop', [{ question: 'Fix the parser first or the lexer?', options: [] }], null, 'held']);
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
  assert.deepEqual(c.lines()[0]?.['questions'], [{ question: 'Pay ₹90k or ₹60k?', options: ['₹90k', '₹60k'] }], 'UTF-8 under the C locale');

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
  writeFileSync(file, `${'x'.repeat(5 * 1024 * 1024 + 1)}\n`);
  assert.equal(run(ask('rotate')).status, 2);
  assert.equal(existsSync(`${file}.1`), true, 'past 5 MB the log moves aside');
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
