/**
 * The Auto-fix list: record from `gh pr create`, confirm from the desktop
 * app's replies, warn at turn end. Tool answers below are the app's, copied
 * from session transcripts (`toolUseResult`). That a hook receives the same
 * value as `tool_response`, and an error as PostToolUseFailure's `error`, is
 * the working assumption, so the handler reads both fields on both events.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  addOpened,
  appendRows,
  autofixCommand,
  callFor,
  factsOf,
  fold,
  fromUrl,
  GET_STATUS,
  hasSetMonitor,
  keepRaw,
  listDir,
  listFile,
  news,
  prUrls,
  readRows,
  respond,
  runsInBackground,
  runsPrCreate,
  SET_MONITOR,
  start,
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

  it('takes "not bound to this session" as a refusal, so the wrap_up warning stops (#153)', () => {
    const { deps, session, file, transcript } = setup();
    const merged = 'https://github.com/veda-hq/veda/pull/140';
    assert.equal(addOpened(merged, session, 'live-evidence-146', deps), true);
    assert.match(context(respond(wrapUp(session, transcript), deps)), /veda-hq\/veda#140/);
    // The PostToolUseFailure event as the hook received it in a live session, error field verbatim.
    respond(refusal(session, merged, 'veda-hq/veda#140 is not bound to this session.'), deps);
    assert.deepEqual(fold(readRows(file)), [
      { pr: 'veda-hq/veda#140', url: merged, state: 'refused', reason: 'is not bound to this session.' },
    ]);
    assert.equal(respond(wrapUp(session, transcript), deps), '');
    // The same words in a PostToolUse answer count too.
    respond(monitor(session, VEDA, 'Error: veda-hq/veda#90 is not bound to this session.'), deps);
    assert.deepEqual(states(file).at(-1), ['veda-hq/veda#90', 'refused']);
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
    const { deps, dir, session, transcript } = setup();
    respond(bash(session, 'gh pr create', `${VEDA}\n`), deps);
    // Between reading the list and writing its row, the list's folder becomes
    // a regular file: a write under it fails for any user, root included,
    // where a read-only list file would not stop root.
    const kept = `${dir}-kept`;
    const now = (): Date => {
      renameSync(dir, kept);
      writeFileSync(dir, 'a file, not a folder');
      return deps.now();
    };
    assert.match(context(respond(wrapUp(session, transcript), { ...deps, now })), /veda-hq\/veda#90/);
    assert.equal(readFileSync(join(kept, `${session}.jsonl`), 'utf8').includes('"warned"'), false);
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
    const env: NodeJS.ProcessEnv = { ...process.env, SARATHI_AUTOFIX_DIR: deps.env.SARATHI_AUTOFIX_DIR };
    // A cloud session sets this, and the hook stays silent there.
    delete env.CLAUDE_CODE_REMOTE;
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

describe('the list file, closer', () => {
  it('passes over an empty SARATHI_AUTOFIX_DIR or XDG_STATE_HOME', () => {
    assert.equal(listDir({ SARATHI_AUTOFIX_DIR: '', XDG_STATE_HOME: '/state' }), '/state/sarathi/autofix');
    assert.equal(listDir({ XDG_STATE_HOME: '' }), join(homedir(), '.local', 'state', 'sarathi', 'autofix'));
  });

  it('skips a row whose event is not a string', () => {
    const { dir } = setup();
    const path = `${dir}-rows.jsonl`;
    writeFileSync(path, '{"pr":"a/b#2","event":3}\n{"pr":"a/b#3"}\n   \n{"pr":"a/b#4","url":"u","event":"on"}\n');
    assert.deepEqual(readRows(path), [{ pr: 'a/b#4', url: 'u', event: 'on' }]);
  });

  it('keeps the URL a PR first had, and gives a row with none an empty one', () => {
    const rows = [
      { at: 't', pr: 'a/b#1', url: 'https://ghe.example.com/a/b/pull/1', event: 'opened', source: 'x' },
      { at: 't', pr: 'a/b#1', url: 'https://github.com/a/b/pull/1', event: 'on', source: 'x' },
      { at: 't', pr: 'c/d#2', event: 'opened', source: 'x' },
    ] as unknown as Row[];
    assert.deepEqual(fold(rows), [
      { pr: 'a/b#1', url: 'https://ghe.example.com/a/b/pull/1', state: 'on' },
      { pr: 'c/d#2', url: '', state: 'opened' },
    ]);
  });

  it('keeps a reason only on a refused row that gives one as a string', () => {
    const rows = [
      { at: 't', pr: 'a/b#1', url: 'u1', event: 'refused', source: 'x' },
      { at: 't', pr: 'a/b#2', url: 'u2', event: 'on', source: 'x', reason: 'not for on' },
      { at: 't', pr: 'a/b#3', url: 'u3', event: 'refused', source: 'x', reason: 7 },
      { at: 't', pr: 'a/b#4', url: 'u4', event: 'refused', source: 'x', reason: 'no' },
    ] as unknown as Row[];
    assert.deepEqual(fold(rows), [
      { pr: 'a/b#1', url: 'u1', state: 'refused' },
      { pr: 'a/b#2', url: 'u2', state: 'on' },
      { pr: 'a/b#3', url: 'u3', state: 'refused' },
      { pr: 'a/b#4', url: 'u4', state: 'refused', reason: 'no' },
    ]);
  });

  it('folds spellings by lower case only: ß and SS stay two PRs', () => {
    const rows: Row[] = [
      { at: 't', pr: 'o/ß#1', url: 'u1', event: 'opened', source: 'x' },
      { at: 't', pr: 'o/SS#1', url: 'u2', event: 'opened', source: 'x' },
    ];
    assert.deepEqual(fold(rows), [
      { pr: 'o/ß#1', url: 'u1', state: 'opened' },
      { pr: 'o/SS#1', url: 'u2', state: 'opened' },
    ]);
  });

  it('writes nothing, not even the folder, for no rows', () => {
    const { dir, file } = setup();
    appendRows(file, []);
    assert.equal(existsSync(dir), false);
  });
});

describe('reading tool answers, closer', () => {
  it('keeps the first spelling of a PR a text names twice', () => {
    assert.deepEqual(prUrls('https://github.com/Veda-HQ/veda/pull/90 then https://github.com/veda-hq/veda/pull/90'), [
      { pr: 'Veda-HQ/veda#90', url: 'https://github.com/Veda-HQ/veda/pull/90' },
    ]);
  });

  it('takes only string output fields, the output field included', () => {
    assert.equal(textOf({ stderr: 7, output: 'o' }), '\n\no');
  });

  it('takes only a string command as gh pr create', () => {
    assert.equal(runsPrCreate(['gh pr create']), false);
    assert.equal(runsPrCreate(undefined), false);
    assert.equal(runsInBackground({}), false);
    assert.equal(runsInBackground({ tool_input: { run_in_background: true, command: ['gh pr create'] } }), false);
    assert.equal(runsInBackground({ tool_input: { run_in_background: true, command: 'gh pr create' } }), true);
  });
});

describe('what one tool event says', () => {
  it('reads a refusal with no space after the colon, its reason trimmed', () => {
    assert.deepEqual(
      factsOf({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'mcp__ccd_pr__set_monitor',
        error: "Auto-fix can't be enabled for a/b#1:no space here  ",
      }),
      [{ pr: 'a/b#1', url: 'https://github.com/a/b/pull/1', event: 'refused', source: 'mcp__ccd_pr__set_monitor', reason: 'no space here' }],
    );
  });

  it('reads "not bound to this session" with nothing after it, and with words after it', () => {
    const failure = (error: string) => factsOf({ hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__ccd_pr__set_monitor', error });
    assert.deepEqual(failure('a/b#2 is not bound to this session'), [
      { pr: 'a/b#2', url: 'https://github.com/a/b/pull/2', event: 'refused', source: 'mcp__ccd_pr__set_monitor', reason: 'is not bound to this session' },
    ]);
    assert.deepEqual(failure('a/b#3 is not bound to this session; ask the user.\nmore'), [
      {
        pr: 'a/b#3',
        url: 'https://github.com/a/b/pull/3',
        event: 'refused',
        source: 'mcp__ccd_pr__set_monitor',
        reason: 'is not bound to this session; ask the user.',
      },
    ]);
  });

  it('gives an on reply no reason, at the URL the call named on another host, in any case', () => {
    const on = (input: unknown) =>
      factsOf({ hook_event_name: 'PostToolUse', tool_name: 'mcp__ccd_pr__set_monitor', tool_input: input, tool_response: 'Auto-fix is on for veda-hq/veda#90.' });
    assert.deepEqual(on({ url: 'https://ghe.example.com/Veda-HQ/veda/pull/90' }), [
      { pr: 'veda-hq/veda#90', url: 'https://ghe.example.com/Veda-HQ/veda/pull/90', event: 'on', source: 'mcp__ccd_pr__set_monitor' },
    ]);
    assert.deepEqual(on(undefined), [{ pr: 'veda-hq/veda#90', url: 'https://github.com/veda-hq/veda/pull/90', event: 'on', source: 'mcp__ccd_pr__set_monitor' }]);
    assert.deepEqual(on({ url: 'https://ghe.example.com/veda-hq/veda/pull/91' }), [
      { pr: 'veda-hq/veda#90', url: 'https://github.com/veda-hq/veda/pull/90', event: 'on', source: 'mcp__ccd_pr__set_monitor' },
    ]);
    assert.deepEqual(on({ url: 'https://ghe.example.com/veda-hq/veda/pull/90' })[0]?.url, 'https://ghe.example.com/veda-hq/veda/pull/90');
  });

  it('says nothing for a set_monitor answer that names no PR, nor outside PostToolUse and PostToolUseFailure', () => {
    assert.deepEqual(factsOf({ hook_event_name: 'PostToolUse', tool_name: 'mcp__ccd_pr__set_monitor', tool_response: 'Something else.' }), []);
    for (const name of ['PreToolUse', 'Stop']) {
      assert.deepEqual(factsOf({ hook_event_name: name, tool_name: 'mcp__ccd_pr__set_monitor', tool_response: 'Auto-fix is on for a/b#1' }), [], name);
    }
  });

  it('records a foreground gh pr create from PostToolUse only, and nothing for other commands or none', () => {
    const run = (name: string, command?: string) =>
      factsOf({
        hook_event_name: name,
        tool_name: 'Bash',
        ...(command === undefined ? {} : { tool_input: { command } }),
        tool_response: { stdout: 'https://github.com/a/b/pull/1\n' },
      });
    assert.deepEqual(run('PostToolUse', 'gh pr create --fill'), [
      { pr: 'a/b#1', url: 'https://github.com/a/b/pull/1', event: 'opened', source: 'gh pr create' },
    ]);
    assert.deepEqual(run('PostToolUse', 'gh pr view 1'), []);
    assert.deepEqual(run('PostToolUse'), []);
    assert.deepEqual(run('PostToolUseFailure', 'gh pr create --fill'), []);
  });

  it('reads a status only from get_status, for this session or one unnamed', () => {
    const body = JSON.stringify({ pr: { url: 'https://github.com/a/b/pull/1', state: 'OPEN' }, monitor: { auto_fix: true } });
    const read = (tool: string, input: unknown) => factsOf({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: body });
    const on = [{ pr: 'a/b#1', url: 'https://github.com/a/b/pull/1', event: 'on', source: 'mcp__ccd_pr__get_status' }];
    assert.deepEqual(read('mcp__ccd_pr__get_status', {}), on);
    assert.deepEqual(read('mcp__ccd_pr__get_status', { session_id: 'self' }), on);
    assert.deepEqual(read('mcp__ccd_pr__get_status', { session_id: 'local_other' }), []);
    assert.deepEqual(read('Read', {}), []);
  });

  it('reads a status’s primary PR only when it is an object with a PR URL, a state and a boolean auto_fix', () => {
    const read = (body: unknown) =>
      factsOf({ hook_event_name: 'PostToolUse', tool_name: 'mcp__ccd_pr__get_status', tool_response: typeof body === 'string' ? body : JSON.stringify(body) });
    const url = 'https://github.com/a/b/pull/1';
    for (const body of [
      'null',
      '[1]',
      {},
      { pr: { url: [url] }, monitor: { auto_fix: true } },
      { pr: { url: 'https://example.com/nope', state: 'merged' } },
      { pr: { url, state: 'open' } },
      { pr: { url, state: 'open' }, monitor: { auto_fix: 'yes' } },
    ]) {
      assert.deepEqual(read(body), [], JSON.stringify(body));
    }
    assert.deepEqual(read({ pr: { url }, monitor: { auto_fix: true } }), [{ pr: 'a/b#1', url, event: 'on', source: 'mcp__ccd_pr__get_status' }]);
    assert.deepEqual(read({ pr: { url, state: 'open' }, monitor: { auto_fix: false } }), [
      { pr: 'a/b#1', url, event: 'off', source: 'mcp__ccd_pr__get_status' },
    ]);
    assert.deepEqual(read({ pr: { url, state: 'Merged' }, monitor: { auto_fix: true } }), [
      { pr: 'a/b#1', url, event: 'closed', source: 'mcp__ccd_pr__get_status' },
    ]);
  });

  it('closes only other bound PRs with a string repo, a number and an ended state', () => {
    const facts = factsOf({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__ccd_pr__get_status',
      tool_response: JSON.stringify({
        otherBoundPrs: [
          null,
          { number: 5, state: 'merged' },
          { repo: 'a/b', number: '5', state: 'merged' },
          { repo: 'a/b', number: 7 },
          { repo: 'a/b', number: 8, state: 'open' },
          { repo: 'a/b', number: 6, state: 'Closed' },
        ],
      }),
    });
    assert.deepEqual(facts, [{ pr: 'a/b#6', url: 'https://github.com/a/b/pull/6', event: 'closed', source: 'mcp__ccd_pr__get_status' }]);
  });
});

describe('what changes the list, closer', () => {
  it('takes no opened for a PR on the list, and a refusal again only with a new reason', () => {
    const fact = (event: 'opened' | 'on' | 'refused', reason?: string) => ({
      pr: 'a/b#1',
      url: 'u',
      event,
      source: 's',
      ...(reason === undefined ? {} : { reason }),
    });
    assert.deepEqual(news([fact('opened')], [{ pr: 'A/B#1', url: 'u', state: 'on' }]), []);
    assert.deepEqual(news([fact('on')], []), [fact('on')]);
    assert.deepEqual(news([fact('refused', 'one')], [{ pr: 'a/b#1', url: 'u', state: 'refused', reason: 'one' }]), []);
    assert.deepEqual(news([fact('refused', 'two')], [{ pr: 'a/b#1', url: 'u', state: 'refused', reason: 'one' }]), [fact('refused', 'two')]);
    assert.deepEqual(news([fact('refused', 'r1'), fact('refused', 'r1'), fact('refused')], []), [fact('refused', 'r1'), fact('refused')]);
  });
});

describe('seeing the set_monitor tool, closer', () => {
  it('sees nothing through a file descriptor, a missing file, or an escaped name', () => {
    const { transcript } = setup();
    const fd = openSync(transcript, 'r');
    try {
      assert.equal(hasSetMonitor(fd), false);
    } finally {
      closeSync(fd);
    }
    assert.equal(hasSetMonitor(`${transcript}.missing`), false);
    const escaped = `${transcript}.escaped`;
    writeFileSync(escaped, '{"attachment":{"addedNames":["mcp\\u005f\\u005fccd_pr__set_monitor"]}}\n');
    assert.equal(hasSetMonitor(escaped), false);
  });

  it('counts only an entry, an added name or a tool_use call that is the tool', () => {
    const { transcript } = setup();
    const seen = (line: unknown): boolean => {
      writeFileSync(transcript, `${JSON.stringify(line)}\n`);
      return hasSetMonitor(transcript);
    };
    const name = 'mcp__ccd_pr__set_monitor';
    assert.equal(seen({ attachment: { entries: [{ name: 'other' }], note: name } }), false);
    assert.equal(seen({ attachment: { entries: name } }), false);
    assert.equal(seen({ attachment: { addedNames: name } }), false);
    assert.equal(seen({ attachment: { entries: [null, { name }] } }), true);
    assert.equal(seen({ message: { content: [{ type: 'text', name }] } }), false);
    assert.equal(seen({ message: { content: [{ type: 'tool_use', name: 'other', input: { tool: name } }] } }), false);
    assert.equal(seen({ message: { content: [null, { type: 'text', text: name }] } }), false);
    assert.equal(seen({ message: { content: [{ type: 'text', text: name }, { type: 'tool_use', name }] } }), true);
  });
});

describe('the warning’s words', () => {
  it('words one PR at wrap_up, the default', () => {
    assert.equal(
      warning([{ pr: 'a/b#1', url: 'https://github.com/a/b/pull/1', state: 'opened' }]),
      [
        'sarathi: Auto-fix is not on for a pull request this session opened, so nothing wakes this session for its CI failures, merge conflicts or review comments. Make this call for each before you end the turn:',
        '- a/b#1: mcp__ccd_pr__set_monitor {"url":"https://github.com/a/b/pull/1","auto_fix":true,"address_comments":true}',
        'If the app refuses one, tell the user its reason; they can switch it on themselves from the PR bar. One that has merged or closed leaves this list at the next mcp__ccd_pr__get_status that shows it so. (Warn-only: nothing is blocked.)',
      ].join('\n'),
    );
  });

  it('words two PRs just opened, one of them switched off', () => {
    assert.equal(
      warning(
        [
          { pr: 'a/b#1', url: 'https://github.com/a/b/pull/1', state: 'opened' },
          { pr: 'a/b#2', url: 'https://github.com/a/b/pull/2', state: 'off' },
        ],
        'opened',
      ),
      [
        'sarathi: you just opened 2 pull requests, and Auto-fix is not on for them, so nothing will wake this session for its CI failures, merge conflicts or review comments. Make this call now for each:',
        '- a/b#1: mcp__ccd_pr__set_monitor {"url":"https://github.com/a/b/pull/1","auto_fix":true,"address_comments":true}',
        '- a/b#2 (switched off): mcp__ccd_pr__set_monitor {"url":"https://github.com/a/b/pull/2","auto_fix":true,"address_comments":true}',
        'If the app refuses one, tell the user its reason; they can switch it on themselves from the PR bar. One that has merged or closed leaves this list at the next mcp__ccd_pr__get_status that shows it so. (Warn-only: nothing is blocked.)',
      ].join('\n'),
    );
  });

  it('words the background note, line by line', () => {
    assert.equal(
      BACKGROUND_NOTE,
      [
        'sarathi: this `gh pr create` runs in the background, so its output, the pull request URL, never reaches this hook: the PR is not on this session’s Auto-fix list, and the app will not trust it as this session’s PR, so Auto-fix cannot be switched on for it as it stands.',
        'For this PR: once the background run ends, take the PR URL from its output (or from `gh pr view --json url`), write `<pr-created>URL</pr-created>` with it in your reply, and do not run `gh pr create` again: the PR exists.',
        'Then call mcp__ccd_pr__set_monitor {"url":"<the PR URL>","auto_fix":true,"address_comments":true}.',
        'Next time, run `gh pr create` in the foreground, so its URL reaches the list and the app. (Warn-only: nothing is blocked.)',
      ].join('\n'),
    );
  });

  it('warns at wrap_up about a PR switched off again, and logs the wrap_up as the source', () => {
    const { deps, session, file, transcript } = setup();
    const url = 'https://github.com/veda-hq/veda/pull/90';
    const reply = (text: string) =>
      JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'mcp__ccd_pr__set_monitor', tool_input: { url }, tool_response: text });
    respond(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash', tool_input: { command: 'gh pr create' }, tool_response: { stdout: url } }), deps);
    respond(reply('Auto-fix is on for veda-hq/veda#90.'), deps);
    respond(reply('Auto-fix is off for veda-hq/veda#90.'), deps);
    const answer = respond(
      JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, transcript_path: transcript, tool_name: 'mcp__ccd_turn__wrap_up' }),
      deps,
    );
    assert.equal(
      context(answer),
      [
        'sarathi: Auto-fix is not on for a pull request this session opened, so nothing wakes this session for its CI failures, merge conflicts or review comments. Make this call for each before you end the turn:',
        '- veda-hq/veda#90 (switched off): mcp__ccd_pr__set_monitor {"url":"https://github.com/veda-hq/veda/pull/90","auto_fix":true,"address_comments":true}',
        'If the app refuses one, tell the user its reason; they can switch it on themselves from the PR bar. One that has merged or closed leaves this list at the next mcp__ccd_pr__get_status that shows it so. (Warn-only: nothing is blocked.)',
      ].join('\n'),
    );
    assert.deepEqual(
      readRows(file).map(row => [row.pr, row.event, row.source]),
      [
        ['veda-hq/veda#90', 'opened', 'gh pr create'],
        ['veda-hq/veda#90', 'on', 'mcp__ccd_pr__set_monitor'],
        ['veda-hq/veda#90', 'off', 'mcp__ccd_pr__set_monitor'],
        ['veda-hq/veda#90', 'warned', 'mcp__ccd_turn__wrap_up'],
      ],
    );
  });
});

describe('respond, closer', () => {
  it('warns only on PostToolUse: a failed wrap_up, a failed background create, an off reply and a non-Bash tool say nothing', () => {
    const { deps, session, file, transcript } = setup();
    const url = 'https://github.com/veda-hq/veda/pull/90';
    const event = (fields: Record<string, unknown>) => JSON.stringify({ session_id: session, transcript_path: transcript, ...fields });
    const background = { command: 'gh pr create --fill', run_in_background: true };
    respond(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash', tool_input: { command: 'gh pr create' }, tool_response: { stdout: url } }), deps);
    assert.equal(respond(event({ hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__ccd_turn__wrap_up' }), deps), '');
    assert.equal(respond(event({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: background, error: 'Exit code 1' }), deps), '');
    assert.equal(respond(event({ hook_event_name: 'PostToolUse', tool_name: 'Task', tool_input: background }), deps), '');
    respond(event({ hook_event_name: 'PostToolUse', tool_name: 'mcp__ccd_pr__set_monitor', tool_input: { url }, tool_response: 'Auto-fix is on for veda-hq/veda#90.' }), deps);
    assert.equal(
      respond(event({ hook_event_name: 'PostToolUse', tool_name: 'mcp__ccd_pr__set_monitor', tool_input: { url }, tool_response: 'Auto-fix is off for veda-hq/veda#90.' }), deps),
      '',
    );
    assert.deepEqual(warned(file), []);
  });

  it('gives no background note for a session id that names no list', () => {
    const { deps, transcript } = setup();
    const event = { hook_event_name: 'PostToolUse', session_id: '../x', transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'gh pr create', run_in_background: true } };
    assert.equal(respond(JSON.stringify(event), deps), '');
    assert.notEqual(respond(JSON.stringify({ ...event, session_id: 'ok' }), deps), '');
  });

  it('keeps no copy of an app event outside PostToolUse and PostToolUseFailure', () => {
    const { deps, session, dir } = setup();
    respond(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'mcp__ccd_pr__set_monitor', tool_input: {} }), deps);
    assert.equal(existsSync(dir), false);
  });

  it('takes no time for an event that says nothing about the list', () => {
    const { deps, session } = setup();
    let calls = 0;
    const counted: Deps = { ...deps, now: () => ((calls += 1), deps.now()) };
    respond(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Read', tool_response: 'x' }), counted);
    respond(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash', tool_input: { command: 'ls' } }), counted);
    assert.equal(calls, 0);
  });
});

describe('keeping the app’s events, closer', () => {
  it('copies only an event with a ccd_pr tool name, whole up to 16,384 characters, cut after', () => {
    const { deps, dir, session } = setup();
    const file = join(`${dir}.jsonl`, `${session}.jsonl`);
    keepRaw({}, file, deps);
    keepRaw({ tool_name: 5 }, file, deps);
    keepRaw({ tool_name: 'Bash' }, file, deps);
    assert.equal(existsSync(`${dir}.jsonl`), false);
    const base = { tool_name: 'mcp__ccd_pr__get_status', tool_response: '' };
    const exact = { ...base, tool_response: 'x'.repeat(16_384 - JSON.stringify(base).length) };
    assert.equal(JSON.stringify(exact).length, 16_384);
    const long = { ...exact, tool_response: `${exact.tool_response}y` };
    keepRaw(exact, file, deps);
    keepRaw(long, file, deps);
    const kept = readFileSync(join(`${dir}.jsonl`, `${session}.raw.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as unknown);
    assert.deepEqual(kept, [
      { at: '2026-11-15T10:00:00.000Z', event: exact },
      { at: '2026-11-15T10:00:00.000Z', event: `${JSON.stringify(long).slice(0, 16_384)}…` },
    ]);
  });
});

describe('sarathi autofix, closer', () => {
  function cli(args: string[], env: Record<string, string | undefined>): { code: number; out: string; err: string } {
    let out = '';
    let err = '';
    const code = autofixCommand(args, { env, now: () => new Date('2026-11-15T10:00:00Z'), out: text => (out += text), err: text => (err += text) });
    return { code, out, err };
  }
  it('refuses with the usage: an unknown option, an empty flag value, a wrong count of arguments, an unknown verb', () => {
    const usage = 'usage: sarathi autofix add <pr-url> [--session <id>] [--source <name>]\n       sarathi autofix list [--session <id>]\n';
    const { deps, file } = setup();
    const env = { ...deps.env, CLAUDE_CODE_SESSION_ID: 's' };
    const url = 'https://github.com/veda-hq/veda/pull/90';
    assert.deepEqual(cli(['add', url, '--force'], env), { code: 1, out: '', err: `sarathi autofix: unknown option --force\n${usage}` });
    assert.deepEqual(cli(['add', url, '--session', ''], env), { code: 1, out: '', err: `sarathi autofix: --session needs a value\n${usage}` });
    assert.deepEqual(cli(['add', url, '--source', ''], env), { code: 1, out: '', err: `sarathi autofix: --source needs a value\n${usage}` });
    for (const args of [['add'], ['add', url, 'https://github.com/a/b/pull/1'], ['list', 'extra'], ['remove', url]]) {
      assert.deepEqual(cli(args, env), { code: 1, out: '', err: usage }, args.join(' '));
    }
    assert.deepEqual(readRows(file.replace(/[^/]+$/, 's.jsonl')), []);
  });

  it('says where it put the PR, and what it could not use', () => {
    const { deps, dir } = setup();
    const url = 'https://github.com/veda-hq/veda/pull/90';
    assert.deepEqual(cli(['add', '--session', 'other', url], deps.env), {
      code: 0,
      out: `sarathi autofix: veda-hq/veda#90 is on session other's list (${join(dir, 'other.jsonl')})\n`,
      err: '',
    });
    assert.deepEqual(cli(['add', 'nope', '--session', 'other'], deps.env), {
      code: 1,
      out: '',
      err: 'sarathi autofix: nope is not a pull request URL (https://<host>/<owner>/<repo>/pull/<N>)\n',
    });
    assert.deepEqual(cli(['add', url], deps.env), {
      code: 1,
      out: '',
      err: 'sarathi autofix: no usable session id (pass --session, or run inside a Claude Code session)\n',
    });
  });
});

describe('the script, in process', () => {
  it('answers only as the script node was given, reading the stream it is handed', { timeout: 15_000 }, async () => {
    const { deps, session, file, transcript } = setup();
    const hook = fileURLToPath(new URL('./autofix.ts', import.meta.url));
    const hookUrl = new URL('./autofix.ts', import.meta.url).href;
    const seen: string[] = [];
    await start(undefined, hookUrl, ['{}'], text => seen.push(`undefined: ${text}`), deps);
    await start('', hookUrl, ['{}'], text => seen.push(`empty: ${text}`), deps);
    await start(fileURLToPath(import.meta.url), hookUrl, ['{}'], text => seen.push(`other: ${text}`), deps);
    assert.deepEqual(seen, []);
    const event = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: session,
      transcript_path: transcript,
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create' },
      tool_response: { stdout: 'https://github.com/veda-hq/veda/pull/90\n' },
    });
    const answered: string[] = [];
    await start(hook, hookUrl, [event.slice(0, 20), Buffer.from(event.slice(20))], text => answered.push(text), deps);
    assert.equal(answered.length, 1);
    assert.match(context(answered[0] ?? ''), /^sarathi: you just opened a pull request, and Auto-fix is not on for it/);
    assert.deepEqual(states(file), [['veda-hq/veda#90', 'opened']]);
  });
});
