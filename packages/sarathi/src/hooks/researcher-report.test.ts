/**
 * hooks/researcher-report.sh, run as Claude Code runs it: a PreToolUse event
 * on SubagentHandback (Claude Code 2.1.271 and later) or a SubagentStop event
 * on stdin. Every report and transcript here is synthetic.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../../hooks/researcher-report.sh', import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'sarathi-researcher-report-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

type Entry = Record<string, unknown>;
interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function hook(input: string | Entry, env: NodeJS.ProcessEnv = {}, state = join(TMP, 'state')): Run {
  const result = spawnSync('bash', [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', HOME: TMP, SARATHI_REPORT_CHECK_DIR: state, ...env },
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let agents = 0;
const handback = (message: unknown, extra: Entry = {}): Entry => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'SubagentHandback',
  tool_input: { message },
  agent_type: 'sarathi:researcher',
  agent_id: `a${agents++}`,
  session_id: 's',
  ...extra,
});
const stopped = (message: unknown, extra: Entry = {}): Entry => ({
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  last_assistant_message: message,
  agent_type: 'researcher',
  agent_id: `a${agents++}`,
  session_id: 's',
  ...extra,
});

const GOOD = [
  '- **Verdict:** `Settled`. Stop hooks accept additionalContext since 2.1.163.',
  '- **Claims:**',
  '  - Stop takes hookSpecificOutput.additionalContext: https://code.claude.com/docs/en/hooks#stop-decision-control, current docs, read 2026-11-19.',
  '  - The changelog entry: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md, 2.1.163, read 2026-11-19.',
  '- **Next:** act on it and cite it.',
].join('\n');

test('researcher-report: a report in the shape passes silently, on either event', () => {
  assert.deepEqual(hook(handback(GOOD)), { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(hook(stopped(GOOD)), { status: 0, stdout: '', stderr: '' });
  for (const [why, report] of [
    ['plain labels', 'Verdict: Conflicting. Two sources disagree.\nClaims:\n1. A says x: https://a.example/doc, v1, read 2026-11-19\n2) B says y: https://b.example/doc, v1, read 2026-11-19\nNext: decide by the source at the tag.'],
    ['a repository path as the source', 'Verdict: Settled. The flag defaults to off.\nClaims:\n* The default: packages/x/src/flags.ts:12, at 9a4b521, read 2026-11-19\nNext: act.'],
    ['a claim on the Claims line', 'Verdict: Settled. Yes.\nClaims: the cap is 8: https://code.claude.com/docs/en/hooks, read 2026-11-19\nNext: act.'],
    ['Not settled with no claims', 'Verdict: Not settled. Nothing documents it.\nClaims: none\nNext: ask the owner; it is a preference.'],
    ['Not settled with no Claims line', '**Verdict:** Not settled. A preference.\n**Next:** ask.'],
  ] as const) {
    assert.equal(hook(handback(report)).status, 0, why);
  }
});

test('researcher-report: a report that falls short is refused with what it lacks', () => {
  for (const [why, report, says] of [
    ['no verdict', 'I looked around and the answer is yes.\nhttps://a.example read 2026-11-19', /no Verdict line/],
    ['a verdict word not in the list', 'Verdict: Probably. Yes.\nClaims:\n- x: https://a.example, read 2026-11-19', /no Verdict line/],
    ['Settled with no claims', 'Verdict: Settled. Yes.\nNext: act.', /no claims under Claims for a Settled verdict/],
    ['Conflicting with an empty Claims', 'Verdict: Conflicting. Hm.\nClaims: none\nNext: decide.', /no claims under Claims for a Conflicting verdict/],
    ['a claim with no source', 'Verdict: Settled. Yes.\nClaims:\n- The cap is 8, read 2026-11-19\nNext: act.', /the claim "The cap is 8, read 2026-11-19" lacks a URL or repository path/],
    ['a claim with no date', 'Verdict: Settled. Yes.\nClaims:\n- The cap is 8: https://code.claude.com/docs/en/hooks\nNext: act.', /lacks a read date/],
    ['a claim with neither', 'Verdict: Settled. Yes.\nClaims:\n- The cap is 8\nNext: act.', /lacks a URL or repository path and a read date/],
  ] as const) {
    const run = hook(handback(report));
    assert.equal(run.status, 2, why);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^BLOCKED: researcher report: /, why);
    assert.match(run.stderr, says, why);
    assert.match(run.stderr, /under Claims, one line per claim with its URL/);
  }
  const long = `Verdict: Settled. Yes.\nClaims:\n- ${'x'.repeat(120)}\nNext: act.`;
  assert.match(hook(handback(long)).stderr, /"x{77}\.\.\." lacks/, 'a long claim is shortened');
  const next = 'Verdict: Settled. Yes.\nClaims:\n- x: https://a.example, read 2026-11-19\nNext:\n- this list is not claims';
  assert.equal(hook(handback(next)).status, 0, 'lines under Next are not claims');
});

test('researcher-report: on SubagentStop a short report keeps the subagent going', () => {
  const run = hook(stopped('The answer is yes.'));
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');
  const answer = JSON.parse(run.stdout) as { decision: string; reason: string };
  assert.equal(answer.decision, 'block');
  assert.match(answer.reason, /^researcher report: no Verdict line/);
  assert.deepEqual(hook(stopped('The answer is yes.', { stop_hook_active: true })), { status: 0, stdout: '', stderr: '' }, 'stop_hook_active passes');

  const transcript = join(TMP, 'agent.jsonl');
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: GOOD } }] } })}\n`,
  );
  assert.deepEqual(hook(stopped('Done.', { agent_transcript_path: transcript })), { status: 0, stdout: '', stderr: '' }, 'the report went through SubagentHandback');
  const mention = join(TMP, 'mention.jsonl');
  writeFileSync(mention, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'use SubagentHandback to report' } })}\n`);
  assert.equal(hook(stopped('Done.', { agent_transcript_path: mention })).stdout === '', false, 'a mere mention of the tool is no handback');
});

test('researcher-report: other agents, tools and events pass', () => {
  for (const [why, input] of [
    ['another agent type', handback('no shape', { agent_type: 'Explore' })],
    ['no agent type (the main session)', handback('no shape', { agent_type: undefined })],
    ['another tool', handback('no shape', { tool_name: 'Bash' })],
    ['another event', { ...handback('no shape'), hook_event_name: 'PostToolUse' }],
    ['another agent stopping', stopped('no shape', { agent_type: 'worker' })],
  ] as const) {
    assert.deepEqual(hook(input), { status: 0, stdout: '', stderr: '' }, why);
  }
});

test('researcher-report: anything it cannot read passes', () => {
  for (const [why, input] of [
    ['not json', 'not json'],
    ['no input', ''],
    ['not an object', '[1]'],
    ['a message that is not a string', handback(['Verdict'])],
    ['tool input not an object', { ...handback(''), tool_input: 'x' }],
    ['no message on SubagentStop', { ...stopped(''), last_assistant_message: undefined }],
    ['an unreadable agent transcript', stopped('Verdict: Settled. Yes.', { agent_transcript_path: join(TMP, 'missing.jsonl') })],
  ] as const) {
    assert.equal(hook(input).status === 2, false, why);
  }
  const odd = join(TMP, 'odd.jsonl');
  writeFileSync(odd, 'SubagentHandback but not json\n');
  assert.deepEqual(hook(stopped('no shape', { agent_transcript_path: odd })), { status: 0, stdout: '', stderr: '' }, 'an agent transcript it cannot parse');
  const blocker = join(TMP, 'a-file');
  writeFileSync(blocker, '');
  assert.equal(hook(handback('no shape'), {}, join(blocker, 'state')).status, 0, 'state it cannot write');
});

test('researcher-report: at most two refusals per subagent, then it passes', () => {
  const state = join(TMP, 'state-escape');
  const input = handback('no shape', { agent_id: 'agent/../1' });
  assert.equal(hook(input, {}, state).status, 2);
  assert.equal(hook(input, {}, state).status, 2);
  assert.equal(hook(input, {}, state).status, 0, 'the third try passes');
  assert.deepEqual(readdirSync(state), ['agent_.._1']);
  assert.equal(hook(handback('no shape', { agent_id: 'agent-2' }), {}, state).status, 2, 'another subagent has its own count');
  assert.equal(hook({ ...handback('no shape'), agent_id: undefined, session_id: undefined }, {}, state).status, 2, 'no agent id is keyed as unknown');
});

test('researcher-report: state goes under XDG_STATE_HOME, else ~/.local/state', () => {
  const xdg = join(TMP, 'xdg');
  assert.equal(hook(handback('no shape', { agent_id: 'x1' }), { SARATHI_REPORT_CHECK_DIR: '', XDG_STATE_HOME: xdg }).status, 2);
  assert.deepEqual(readdirSync(join(xdg, 'sarathi', 'researcher-report')), ['x1']);
  assert.equal(hook(handback('no shape', { agent_id: 'x2' }), { SARATHI_REPORT_CHECK_DIR: '' }).status, 2);
  assert.deepEqual(readdirSync(join(TMP, '.local', 'state', 'sarathi', 'researcher-report')), ['x2']);
});

test('researcher-report: through sarathi hook, matched on the agent type', () => {
  const bin = fileURLToPath(new URL('../bin.ts', import.meta.url));
  const dir = join(TMP, 'project');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const entry = { command: 'bash "$SARATHI_HOOKS"/researcher-report.sh', timeout: 10 };
  writeFileSync(
    join(dir, '.claude', 'sarathi.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'SubagentHandback', ...entry }], SubagentStop: [{ matcher: 'researcher|sarathi:researcher', ...entry }] } }),
  );
  const through = (event: string, input: Entry): Run => {
    const result = spawnSync(process.execPath, [bin, 'hook', event], {
      input: JSON.stringify({ ...input, cwd: dir }),
      env: { PATH: process.env['PATH'] ?? '', HOME: TMP, CLAUDE_PROJECT_DIR: dir, SARATHI_REPORT_CHECK_DIR: join(TMP, 'state-through') },
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const refused = through('PreToolUse', handback('no shape'));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^BLOCKED: researcher report: no Verdict line/);
  const kept = through('SubagentStop', stopped('no shape'));
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal((JSON.parse(kept.stdout) as { decision: string }).decision, 'block');
  assert.deepEqual(through('SubagentStop', stopped('no shape', { agent_type: 'Explore' })), { status: 0, stdout: '', stderr: '' }, 'the matcher leaves other agents alone');
});
