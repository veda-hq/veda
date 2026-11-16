/**
 * The Auto-fix list: record from `gh pr create`, confirm from the desktop
 * app's replies, warn at turn end. Tool answers below are the app's, copied
 * from session transcripts (`toolUseResult`). That a hook receives the same
 * value as `tool_response`, and an error as PostToolUseFailure's `error`, is
 * the working assumption, so the handler reads both fields on both events.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  addOpened,
  autofixCommand,
  callFor,
  fold,
  fromUrl,
  GET_STATUS,
  hasSetMonitor,
  listDir,
  listFile,
  news,
  prUrls,
  readRows,
  respond,
  runsPrCreate,
  SET_MONITOR,
  textOf,
  warning,
  BACKGROUND_NOTE,
  WRAP_UP,
  type Deps,
  type Row,
} from './autofix.ts';

const HOOK = fileURLToPath(new URL('./autofix.ts', import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'sarathi-autofix-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
function setup(): { deps: Deps; dir: string; session: string; file: string; transcript: string } {
  counter += 1;
  const dir = join(TMP, `list-${counter}`);
  const session = `s-${counter}`;
  const transcript = join(TMP, `transcript-${counter}.jsonl`);
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'attachment', attachment: { type: 'deferred_tools_record', entries: [{ name: GET_STATUS }, { name: SET_MONITOR }] } })}\n`,
  );
  const deps: Deps = { env: { SARATHI_AUTOFIX_DIR: dir }, now: () => new Date('2026-11-15T10:00:00Z') };
  return { deps, dir, session, file: join(dir, `${session}.jsonl`), transcript };
}

const VEDA = 'https://github.com/veda-hq/veda/pull/90';
const RULES = 'https://github.com/acme/rules/pull/50';

function bash(session: string, command: string, stdout: string, extra: Record<string, unknown> = {}, transcript?: string): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: session,
    ...(transcript === undefined ? {} : { transcript_path: transcript }),
    tool_name: 'Bash',
    tool_input: { command, ...extra },
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
  });
}

function onReply(pr: string): unknown {
  return [
    {
      type: 'text',
      text: `Auto-fix is on for ${pr}: the app will wake this session with a \`<ci-monitor-event>\` on CI failures, merge conflicts and new review comments. No need to poll CI.`,
    },
  ];
}

function monitor(session: string, url: string, response: unknown): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: session,
    tool_name: SET_MONITOR,
    tool_input: { auto_fix: true, address_comments: true, url },
    tool_response: response,
  });
}

function refusal(session: string, url: string, error: string): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUseFailure',
    session_id: session,
    tool_name: SET_MONITOR,
    tool_input: { auto_fix: true, address_comments: true, url },
    error,
  });
}

function status(session: string, body: Record<string, unknown>, input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: session,
    tool_name: GET_STATUS,
    tool_input: input,
    tool_response: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  });
}

function primary(url: string, state: string, autoFix: boolean): Record<string, unknown> {
  const parsed = fromUrl(url);
  return {
    bound: true,
    pr: { number: Number(url.split('/').pop()), url, repo: parsed?.pr.split('#')[0], host: 'github.com', state },
    monitor: { auto_fix: autoFix, address_comments: autoFix, auto_merge: true, auto_archive_on_close: false },
  };
}

/** PostToolUse on the app's wrap_up, as a transcript shows its input. */
function wrapUp(session: string, transcript: string): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: session,
    transcript_path: transcript,
    tool_name: WRAP_UP,
    tool_input: { recap: 'Done.' },
    tool_response: [{ type: 'text', text: 'Recap shown.' }],
  });
}

function stop(session: string, transcript: string): string {
  return JSON.stringify({ hook_event_name: 'Stop', session_id: session, transcript_path: transcript, stop_hook_active: false });
}

interface ToModel {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

/** The context an answer gives the model, checking its shape. */
function context(answer: string): string {
  const parsed = JSON.parse(answer) as ToModel;
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(parsed.hookSpecificOutput), ['hookEventName', 'additionalContext']);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  return parsed.hookSpecificOutput.additionalContext;
}

function warned(file: string): Array<[string, string]> {
  return readRows(file)
    .filter(row => row.event === 'warned')
    .map(row => [row.pr, row.source]);
}

function states(file: string): Array<[string, string]> {
  return fold(readRows(file)).map(pr => [pr.pr, pr.state]);
}

describe('recognising gh pr create', () => {
  it('finds it with global flags, a folder change, or an environment prefix', () => {
    for (const command of [
      'gh pr create --title t --body-file .tmp/b.md',
      'gh -R acme/rules pr create --fill',
      'cd .tmp/rules && gh pr create --fill',
      'GH_REPO=veda-hq/veda gh pr  create',
      '(gh pr create --draft)',
      '/opt/homebrew/bin/gh pr create',
    ]) {
      assert.equal(runsPrCreate(command), true, command);
    }
  });

  it('leaves other gh and git commands alone', () => {
    for (const command of ['gh pr view 90', 'gh pr list', 'git push -u origin HEAD', 'gh issue create', 'ghx pr create', 'gh pr create-ish']) {
      assert.equal(runsPrCreate(command), false, command);
    }
  });
});

describe('reading tool answers', () => {
  it('takes text from a string, MCP text blocks, a content field, or Bash output', () => {
    assert.equal(textOf('Error: x'), 'Error: x');
    assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
    assert.equal(textOf({ content: [{ type: 'text', text: 'c' }] }), 'c');
    assert.equal(textOf({ stdout: 'out', stderr: 'err' }), 'out\nerr\n');
    assert.equal(textOf(42), '');
    assert.equal(textOf(null), '');
  });

  it('finds each PR URL once, on any GitHub host', () => {
    assert.deepEqual(prUrls(`${VEDA}\n${VEDA}\nhttps://ghe.example.com/a/b/pull/7 and ${RULES}`), [
      { pr: 'veda-hq/veda#90', url: VEDA },
      { pr: 'a/b#7', url: 'https://ghe.example.com/a/b/pull/7' },
      { pr: 'acme/rules#50', url: RULES },
    ]);
    assert.equal(fromUrl('https://github.com/veda-hq/veda/issues/9'), undefined);
  });
});

describe('the list file', () => {
  it('lives in SARATHI_AUTOFIX_DIR, else the XDG state folder, else ~/.local/state', () => {
    assert.equal(listDir({ SARATHI_AUTOFIX_DIR: '/x' }), '/x');
    assert.equal(listDir({ XDG_STATE_HOME: '/state' }), '/state/sarathi/autofix');
    assert.equal(listDir({}), join(homedir(), '.local', 'state', 'sarathi', 'autofix'));
    assert.equal(listFile('abc-1', { SARATHI_AUTOFIX_DIR: '/x' }), '/x/abc-1.jsonl');
    assert.equal(listFile('../escape', {}), undefined);
    assert.equal(listFile(7, {}), undefined);
  });

  it('skips blank and partial lines and rows of another shape', () => {
    const path = join(TMP, 'rows.jsonl');
    writeFileSync(path, `\n{"pr":"a/b#1","url":"u","event":"opened"}\n{"pr":"a/b#1","ev\n[1]\n{"pr":2,"event":"on"}\n`);
    assert.deepEqual(
      readRows(path).map(row => row.pr),
      ['a/b#1'],
    );
    assert.deepEqual(readRows(join(TMP, 'missing.jsonl')), []);
  });

  it('folds to each PR at its latest state; a second opened never undoes on', () => {
    const at = 't';
    const rows: Row[] = [
      { at, pr: 'a/b#1', url: '', event: 'opened', source: 'x' },
      { at, pr: 'A/B#1', url: 'https://github.com/a/b/pull/1', event: 'opened', source: 'x' },
      { at, pr: 'a/b#1', url: 'https://github.com/a/b/pull/1', event: 'on', source: 'x' },
      { at, pr: 'a/b#1', url: 'https://github.com/a/b/pull/1', event: 'opened', source: 'x' },
      { at, pr: 'a/b#1', url: 'https://github.com/a/b/pull/1', event: 'warned', source: 'x' },
      { at, pr: 'c/d#2', url: 'https://github.com/c/d/pull/2', event: 'refused', source: 'x', reason: 'not yours' },
    ];
    assert.deepEqual(fold(rows), [
      { pr: 'a/b#1', url: 'https://github.com/a/b/pull/1', state: 'on' },
      { pr: 'c/d#2', url: 'https://github.com/c/d/pull/2', state: 'refused', reason: 'not yours' },
    ]);
  });

  it('keeps off and closed to PRs already on the list', () => {
    const fact = (pr: string, event: 'opened' | 'on' | 'off' | 'refused' | 'closed') => ({ pr, url: 'u', event, source: 's' });
    assert.deepEqual(news([fact('a/b#1', 'off'), fact('a/b#1', 'closed')], []), []);
    assert.deepEqual(
      news([fact('a/b#1', 'on'), fact('a/b#1', 'on'), fact('a/b#1', 'off'), fact('a/b#1', 'closed'), fact('a/b#1', 'closed')], []).map(f => f.event),
      ['on', 'off', 'closed'],
    );
    assert.deepEqual(news([fact('a/b#1', 'off')], [{ pr: 'a/b#1', url: 'u', state: 'opened' }]), []);
  });
});

describe('recording', () => {
  it('puts every PR a gh pr create printed on the session list, any repository', () => {
    const { deps, session, file } = setup();
    respond(bash(session, 'gh pr create --fill', `${VEDA}\n`), deps);
    respond(bash(session, 'cd .tmp/rules && gh -R acme/rules pr create --fill', `Creating pull request\n${RULES}\n`), deps);
    respond(bash(session, 'gh pr create --fill', `${VEDA}\n`), deps);
    assert.deepEqual(states(file), [
      ['veda-hq/veda#90', 'opened'],
      ['acme/rules#50', 'opened'],
    ]);
    assert.equal(readRows(file).length, 2);
  });

  it('ignores PR URLs from other commands, and a background run, which prints none', () => {
    const { deps, session, file } = setup();
    respond(bash(session, 'gh pr view 90 --json url', `${VEDA}\n`), deps);
    respond(bash(session, 'gh pr create --fill', '', { run_in_background: true }), deps);
    assert.deepEqual(readRows(file), []);
  });

  it('takes a PR another hook adds', () => {
    const { deps, session, file } = setup();
    assert.equal(addOpened(RULES, session, 'pr-autocreate', deps), true);
    assert.equal(addOpened('not a url', session, 'pr-autocreate', deps), false);
    assert.equal(addOpened(RULES, '../x', 'pr-autocreate', deps), false);
    assert.deepEqual(readRows(file), [
      { at: '2026-11-15T10:00:00.000Z', pr: 'acme/rules#50', url: RULES, event: 'opened', source: 'pr-autocreate' },
    ]);
  });
});

describe('confirming', () => {
  it('marks a PR on from the app’s set_monitor reply, keeping the URL the call named', () => {
    const { deps, session, file } = setup();
    respond(bash(session, 'gh pr create', `${RULES}\n`), deps);
    respond(monitor(session, RULES, onReply('acme/rules#50')), deps);
    assert.deepEqual(fold(readRows(file)), [{ pr: 'acme/rules#50', url: RULES, state: 'on' }]);
  });

  it('records an on for a PR not on the list, at its GitHub URL when the call named another', () => {
    const { deps, session, file } = setup();
    respond(monitor(session, VEDA, onReply('veda-hq/veda#91')), deps);
    assert.deepEqual(fold(readRows(file)), [{ pr: 'veda-hq/veda#91', url: 'https://github.com/veda-hq/veda/pull/91', state: 'on' }]);
  });

  it('marks it off again from an off reply', () => {
    const { deps, session, file } = setup();
    respond(monitor(session, VEDA, onReply('veda-hq/veda#90')), deps);
    respond(monitor(session, VEDA, [{ type: 'text', text: 'Auto-fix is off for veda-hq/veda#90.' }]), deps);
    assert.deepEqual(states(file), [['veda-hq/veda#90', 'off']]);
  });

  it('records the app’s refusal with its reason, from PostToolUseFailure', () => {
    const { deps, session, file } = setup();
    respond(bash(session, 'gh pr create', `${VEDA}\n`), deps);
    respond(
      refusal(
        session,
        VEDA,
        "Error: Auto-fix can't be enabled for veda-hq/veda#90: you can turn it on only for a PR the app is sure this session opened; the user can turn on Auto-fix for it themselves.",
      ),
      deps,
    );
    assert.deepEqual(fold(readRows(file)), [
      {
        pr: 'veda-hq/veda#90',
        url: VEDA,
        state: 'refused',
        reason: 'you can turn it on only for a PR the app is sure this session opened; the user can turn on Auto-fix for it themselves.',
      },
    ]);
  });

  it('finds a refusal in a PostToolUse answer too, and the app’s pre-call refusal', () => {
    const { deps, session, file } = setup();
    respond(monitor(session, VEDA, "Error: Auto-fix can't be enabled for veda-hq/veda#90: GitHub does not list the account"), deps);
    respond(
      refusal(
        session,
        RULES,
        "Error: PreToolUse:mcp__ccd_pr__set_monitor hook error: acme/rules#50 is on the session's PR bar, but its repository could not be matched to the session's folders, so Auto-fix can't be enabled for it; tell the user.",
      ),
      deps,
    );
    assert.deepEqual(
      fold(readRows(file)).map(pr => [pr.pr, pr.state, pr.reason]),
      [
        ['veda-hq/veda#90', 'refused', 'GitHub does not list the account'],
        [
          'acme/rules#50',
          'refused',
          "is on the session's PR bar, but its repository could not be matched to the session's folders, so Auto-fix can't be enabled for it; tell the user.",
        ],
      ],
    );
  });

  it('takes the app’s off reply as off', () => {
    const { deps, session, file } = setup();
    respond(monitor(session, VEDA, onReply('veda-hq/veda#90')), deps);
    respond(monitor(session, VEDA, [{ type: 'text', text: 'Auto-fix is off for veda-hq/veda#90; the app will no longer wake this session for it.' }]), deps);
    assert.deepEqual(states(file), [['veda-hq/veda#90', 'off']]);
  });

  it('takes an error that names no PR as no answer', () => {
    const { deps, session, file } = setup();
    respond(refusal(session, VEDA, "Error: Pass the pull request's url (get_status reports it)."), deps);
    respond(refusal(session, VEDA, 'Error: veda-hq/veda#90 is not bound to this session.'), deps);
    respond(JSON.stringify({ hook_event_name: 'Notification', session_id: session, tool_name: SET_MONITOR }), deps);
    respond(JSON.stringify({ hook_event_name: 'PostToolUseFailure', session_id: session, tool_name: 'Bash', error: 'Exit code 1' }), deps);
    respond(monitor(session, VEDA, [{ type: 'text', text: 'Something else.' }]), deps);
    assert.deepEqual(readRows(file), []);
  });

  it('reads get_status: the primary PR’s auto_fix, and merged or closed PRs leaving the list', () => {
    const { deps, session, file } = setup();
    respond(bash(session, 'gh pr create', `${VEDA}\n${RULES}\nhttps://github.com/veda-hq/veda/pull/92\n`), deps);
    respond(status(session, primary(VEDA, 'open', true)), deps);
    respond(
      status(session, {
        ...primary(VEDA, 'open', true),
        otherBoundPrs: [
          { number: 50, repo: 'acme/rules', state: 'merged' },
          { number: 92, repo: 'veda-hq/veda', state: 'open' },
          { number: 7, repo: 'x/y', state: 'closed' },
          { repo: 'bad' },
          'junk',
        ],
      }),
      deps,
    );
    assert.deepEqual(states(file), [
      ['veda-hq/veda#90', 'on'],
      ['acme/rules#50', 'closed'],
      ['veda-hq/veda#92', 'opened'],
    ]);
    respond(status(session, primary(VEDA, 'open', false)), deps);
    respond(status(session, primary(VEDA, 'MERGED', false)), deps);
    assert.deepEqual(states(file)[0], ['veda-hq/veda#90', 'closed']);
  });

  it('ignores another session’s status, a status with no PR, and one that is not JSON', () => {
    const { deps, session, file } = setup();
    respond(bash(session, 'gh pr create', `${VEDA}\n`), deps);
    respond(status(session, primary(VEDA, 'open', true), { session_id: 'local_other' }), deps);
    respond(status(session, { bound: false }), deps);
    respond(status(session, { pr: { url: 'https://example.com/nope' }, monitor: { auto_fix: true } }), deps);
    respond(status(session, { pr: { url: VEDA, state: 'open' } }), deps);
    respond(
      JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, tool_name: GET_STATUS, tool_response: 'not json' }),
      deps,
    );
    respond(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, tool_name: GET_STATUS, tool_response: '[1]' }), deps);
    respond(status(session, primary(VEDA, 'open', true), { session_id: 'self' }), deps);
    assert.deepEqual(states(file), [['veda-hq/veda#90', 'on']]);
  });
});

describe('warning the model', () => {
  it('names each waiting PR at wrap_up with the exact call, in additionalContext, and logs that it warned', () => {
    const { deps, session, file, transcript } = setup();
    respond(bash(session, 'gh pr create', `${VEDA}\n${RULES}\n`), deps);
    respond(monitor(session, VEDA, onReply('veda-hq/veda#90')), deps);
    const text = context(respond(wrapUp(session, transcript), deps));
    assert.match(text, /^sarathi: Auto-fix is not on for a pull request this session opened, so nothing wakes this session/);
    assert.match(text, /before you end the turn/);
    assert.ok(text.includes(`- acme/rules#50: ${SET_MONITOR} {"url":"${RULES}","auto_fix":true,"address_comments":true}`));
    assert.doesNotMatch(text, /veda#90/);
    assert.match(text, /Warn-only: nothing is blocked/);
    assert.deepEqual(warned(file), [['acme/rules#50', WRAP_UP]]);
    // Every wrap_up warns again while the PR waits; set_monitor's on reply stops it.
    context(respond(wrapUp(session, transcript), deps));
    assert.equal(warned(file).length, 2);
    respond(monitor(session, RULES, onReply('acme/rules#50')), deps);
    assert.equal(respond(wrapUp(session, transcript), deps), '');
    assert.equal(warned(file).length, 2);
  });

  it('warns at once about the PR a gh pr create recorded, and only that one', () => {
    const { deps, session, file, transcript } = setup();
    assert.equal(addOpened(RULES, session, 'pr-autocreate', deps), true);
    const text = context(respond(bash(session, 'gh pr create --fill', `${VEDA}\n`, {}, transcript), deps));
    assert.match(text, /^sarathi: you just opened a pull request, and Auto-fix is not on for it, so nothing will wake this session/);
    assert.match(text, /Make this call now for each:/);
    assert.ok(text.includes(`- veda-hq/veda#90: ${SET_MONITOR} {"url":"${VEDA}","auto_fix":true,"address_comments":true}`));
    assert.doesNotMatch(text, /acme\/rules/);
    assert.deepEqual(warned(file), [['veda-hq/veda#90', 'gh pr create']]);
    // A PR already on comes back from a second create with no warning; one still waiting is warned again.
    respond(monitor(session, VEDA, onReply('veda-hq/veda#90')), deps);
    assert.equal(respond(bash(session, 'gh pr create --fill', `${VEDA}\n`, {}, transcript), deps), '');
    const two = context(respond(bash(session, 'gh pr create', `${RULES}\nhttps://github.com/a/b/pull/3\n`, {}, transcript), deps));
    assert.match(two, /you just opened 2 pull requests, and Auto-fix is not on for them/);
  });

  it('warns about a PR another hook added at the next wrap_up', () => {
    const { deps, session, file, transcript } = setup();
    assert.equal(
      autofixCommand(['add', RULES, '--session', session, '--source', 'pr-autocreate'], {
        ...deps,
        out: () => undefined,
        err: () => undefined,
      }),
      0,
    );
    assert.match(context(respond(wrapUp(session, transcript), deps)), /acme\/rules#50/);
    assert.deepEqual(warned(file), [['acme/rules#50', WRAP_UP]]);
  });

  it('gives a background gh pr create the way out in the foreground, and records nothing', () => {
    const { deps, session, file, transcript } = setup();
    const text = context(respond(bash(session, 'gh pr create --fill', '', { run_in_background: true }, transcript), deps));
    assert.equal(text, BACKGROUND_NOTE);
    assert.match(text, /not on this session’s Auto-fix list, and the app will not trust it/);
    assert.match(text, /Next time, run `gh pr create` in the foreground/);
    assert.match(text, /write `<pr-created>URL<\/pr-created>` with it in your reply, and do not run `gh pr create` again/);
    assert.ok(text.includes(`Then call ${SET_MONITOR} {"url":"<the PR URL>","auto_fix":true,"address_comments":true}`));
    assert.deepEqual(readRows(file), []);
    // Background runs of other commands, and a run_in_background that is not true, say nothing.
    assert.equal(respond(bash(session, 'pnpm check', '', { run_in_background: true }, transcript), deps), '');
    assert.equal(respond(bash(session, 'gh pr create --fill', '', { run_in_background: 'yes' }, transcript), deps), '');
  });

  it('counts several, and says which were switched off', () => {
    const waiting = [
      { pr: 'a/b#1', url: 'https://github.com/a/b/pull/1', state: 'opened' as const },
      { pr: 'a/b#2', url: 'https://github.com/a/b/pull/2', state: 'off' as const },
    ];
    const text = warning(waiting);
    assert.match(text, /for 2 pull requests/);
    assert.match(text, /a\/b#2 \(switched off\)/);
    assert.equal(warning([]), '');
    assert.equal(callFor(waiting[0]!), `${SET_MONITOR} {"url":"https://github.com/a/b/pull/1","auto_fix":true,"address_comments":true}`);
  });

  it('is silent once every PR is on, refused or closed', () => {
    const { deps, session, transcript } = setup();
    respond(bash(session, 'gh pr create', `${VEDA}\n${RULES}\nhttps://github.com/a/b/pull/3\n`), deps);
    respond(monitor(session, VEDA, onReply('veda-hq/veda#90')), deps);
    respond(refusal(session, RULES, "Auto-fix can't be enabled for acme/rules#50: not this session's"), deps);
    respond(bash(session, 'true', ''), deps);
    respond(status(session, { ...primary(VEDA, 'open', true), otherBoundPrs: [{ number: 3, repo: 'a/b', state: 'closed' }] }), deps);
    assert.equal(respond(wrapUp(session, transcript), deps), '');
  });

  it('is silent with nothing listed, with no session, and at Stop, which no longer warns', () => {
    const { deps, session, file, transcript } = setup();
    assert.equal(respond(wrapUp(session, transcript), deps), '');
    respond(bash(session, 'gh pr create', `${VEDA}\n`), deps);
    assert.equal(respond(stop(session, transcript), deps), '');
    assert.equal(respond(wrapUp('../x', transcript), deps), '');
    assert.deepEqual(warned(file), []);
  });

  it('is silent where the app’s set_monitor tool is not there: a cloud session, a terminal', () => {
    const { deps, session, file, transcript } = setup();
    const cloud = { ...deps, env: { ...deps.env, CLAUDE_CODE_REMOTE: 'true' } };
    assert.equal(respond(bash(session, 'gh pr create', `${VEDA}\n`, {}, transcript), cloud), '');
    assert.deepEqual(states(file), [['veda-hq/veda#90', 'opened']]);
    assert.equal(respond(wrapUp(session, transcript), cloud), '');
    assert.equal(respond(bash(session, 'gh pr create', '', { run_in_background: true }, transcript), cloud), '');
    const bare = join(TMP, `bare-${session}.jsonl`);
    writeFileSync(bare, `${JSON.stringify({ message: { content: [{ type: 'text', text: `call ${SET_MONITOR}` }] } })}\n`);
    assert.equal(respond(wrapUp(session, bare), deps), '');
    assert.equal(respond(bash(session, 'gh pr create', '', { run_in_background: true }, bare), deps), '');
    assert.equal(respond(wrapUp(session, join(TMP, 'none.jsonl')), deps), '');
    assert.equal(respond(wrapUp(session, ''), deps), '');
    assert.deepEqual(warned(file), []);
    assert.notEqual(respond(wrapUp(session, transcript), deps), '');
  });

  it('still warns when its log row cannot be written', () => {
    const { deps, session, file, transcript } = setup();
    respond(bash(session, 'gh pr create', `${VEDA}\n`), deps);
    chmodSync(file, 0o444);
    assert.match(context(respond(wrapUp(session, transcript), deps)), /veda-hq\/veda#90/);
    assert.equal(readFileSync(file, 'utf8').includes('"warned"'), false);
  });

  it('records nothing, and says nothing, when the list cannot be written', () => {
    const { session } = setup();
    const blocked = join(TMP, `blocked-${session}`);
    writeFileSync(blocked, 'a file, not a folder');
    const deps: Deps = { env: { SARATHI_AUTOFIX_DIR: blocked }, now: () => new Date(0) };
    assert.equal(respond(bash(session, 'gh pr create', `${VEDA}\n`), deps), '');
    assert.equal(respond(monitor(session, VEDA, onReply('veda-hq/veda#90')), deps), '');
  });
});

describe('keeping the app’s events as received', () => {
  it('copies each ccd_pr event beside the list, cut short when long, and no Bash event', () => {
    const { deps, session, file } = setup();
    const raw = file.replace(/\.jsonl$/, '.raw.jsonl');
    respond(bash(session, 'gh pr create', `${VEDA}\n`), deps);
    assert.deepEqual(readRows(raw), []);
    respond(monitor(session, VEDA, onReply('veda-hq/veda#90')), deps);
    respond(status(session, { ...primary(VEDA, 'open', true), padding: 'x'.repeat(20_000) }), deps);
    const kept = readFileSync(raw, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => (JSON.parse(line) as { event: unknown }).event);
    assert.equal((kept[0] as { tool_name: string }).tool_name, SET_MONITOR);
    assert.deepEqual((kept[0] as { tool_response: unknown }).tool_response, onReply('veda-hq/veda#90'));
    assert.equal(typeof kept[1], 'string');
    assert.ok(String(kept[1]).endsWith('…'));
    assert.deepEqual(states(file), [['veda-hq/veda#90', 'on']]);
  });
});

describe('seeing the set_monitor tool in a transcript', () => {
  it('counts a deferred-tools record, a delta that adds it, or a call to it', () => {
    const path = join(TMP, 'seen.jsonl');
    const lines = [
      { attachment: { type: 'deferred_tools_record', entries: [{ name: SET_MONITOR }] } },
      { attachment: { type: 'deferred_tools_delta', addedNames: [SET_MONITOR] } },
      { message: { content: [{ type: 'tool_use', name: SET_MONITOR, input: {} }] } },
    ];
    for (const line of lines) {
      writeFileSync(path, `not json ${SET_MONITOR}\n"${SET_MONITOR}"\n${JSON.stringify(line)}\n`);
      assert.equal(hasSetMonitor(path), true, JSON.stringify(line));
    }
    writeFileSync(path, `${JSON.stringify({ attachment: { type: 'deferred_tools_delta', removedNames: [SET_MONITOR] } })}\n`);
    assert.equal(hasSetMonitor(path), false);
    assert.equal(hasSetMonitor(undefined), false);
  });
});

describe('respond', () => {
  it('answers nothing to input it cannot use', () => {
    const { deps } = setup();
    assert.equal(respond('not json', deps), '');
    assert.equal(respond('[1]', deps), '');
    assert.equal(respond(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash' }), deps), '');
    assert.equal(respond(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_response: VEDA }), deps), '');
    assert.deepEqual(readRows(join(listDir(deps.env), 's.jsonl')), []);
  });
});

describe('sarathi autofix', () => {
  function cli(args: string[], env: Record<string, string | undefined>): { code: number; out: string; err: string } {
    let out = '';
    let err = '';
    const code = autofixCommand(args, { env, now: () => new Date('2026-11-15T10:00:00Z'), out: text => (out += text), err: text => (err += text) });
    return { code, out, err };
  }

  it('adds a PR for another hook and lists the session’s PRs', () => {
    const { deps, file } = setup();
    const env = { ...deps.env, CLAUDE_CODE_SESSION_ID: 'from-env' };
    assert.equal(cli(['add', RULES, '--source', 'pr-autocreate'], env).code, 0);
    assert.equal(readRows(file.replace(/[^/]+$/, 'from-env.jsonl'))[0]?.source, 'pr-autocreate');
    const added = cli(['add', VEDA, '--session', 'other'], env);
    assert.equal(added.code, 0);
    assert.match(added.out, /veda-hq\/veda#90 is on session other's list/);
    assert.equal(readRows(file.replace(/[^/]+$/, 'other.jsonl'))[0]?.source, 'sarathi autofix add');
    respond(refusal('other', VEDA, "Auto-fix can't be enabled for veda-hq/veda#90: no"), deps);
    assert.deepEqual(cli(['list', '--session', 'other'], env), { code: 0, out: `veda-hq/veda#90\trefused\t${VEDA}\tno\n`, err: '' });
    assert.deepEqual(cli(['list'], env), { code: 0, out: `acme/rules#50\topened\t${RULES}\n`, err: '' });
  });

  it('refuses what it cannot use', () => {
    const { deps } = setup();
    const env = { ...deps.env, CLAUDE_CODE_SESSION_ID: 's' };
    assert.match(cli(['add', 'nope'], env).err, /is not a pull request URL/);
    assert.match(cli(['add', VEDA, '--session'], env).err, /--session needs a value/);
    assert.match(cli(['add', VEDA, '--force'], env).err, /unknown option --force/);
    assert.match(cli(['add', VEDA], deps.env).err, /no usable session id/);
    assert.equal(cli(['remove', VEDA], env).code, 1);
    assert.equal(cli([], env).code, 1);
  });
});

describe('the script', () => {
  it('runs as Claude Code runs a hook: the event on stdin, the answer on stdout', () => {
    const { deps, session, file, transcript } = setup();
    const env = { ...process.env, SARATHI_AUTOFIX_DIR: deps.env.SARATHI_AUTOFIX_DIR };
    const record = spawnSync(process.execPath, [HOOK], { input: bash(session, 'gh pr create', `${VEDA}\n`), encoding: 'utf8', env });
    assert.equal(record.status, 0);
    assert.equal(record.stdout, '');
    assert.deepEqual(states(file), [['veda-hq/veda#90', 'opened']]);
    const warn = spawnSync(process.execPath, [HOOK], { input: wrapUp(session, transcript), encoding: 'utf8', env });
    assert.equal(warn.status, 0);
    assert.match(context(warn.stdout), /veda-hq\/veda#90/);
    assert.equal(readFileSync(file, 'utf8').includes('"warned"'), true);
  });
});
