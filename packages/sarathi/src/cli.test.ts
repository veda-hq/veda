import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { forbidOutcome, main, matchTarget, runsSarathiFor, settingsHooks, type Io } from './cli.ts';
import type { Outcome } from './run.ts';
import { USAGE as SERVICES_USAGE } from './services/main.ts';
import { VERSION } from './version.ts';
import { USAGE as CLEANUP_USAGE } from './worktree/cleanup.ts';
import { USAGE as LIFECYCLE_USAGE } from './worktree/lifecycle.ts';
import { PICK_USAGE, SHELL_HELP } from './worktree/pick.ts';
import { HELP as WHERE_HELP } from './where/where.ts';

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Every scratch folder the suite makes, removed when it ends. */
const scratchDirs: string[] = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function project(hooks: unknown, extra: Record<string, unknown> = {}): string {
  const dir = scratch('sarathi-cli-');
  execFileSync('mkdir', ['-p', join(dir, '.claude')]);
  writeFileSync(join(dir, '.claude', 'sarathi.json'), JSON.stringify({ ...extra, hooks }));
  return dir;
}

interface RunOptions {
  readonly dir?: string;
  /** The working folder, when it is not `dir`. */
  readonly cwd?: string;
  readonly stdin?: string;
  readonly ran?: Outcome[];
  readonly env?: Record<string, string>;
  readonly ask?: (prompt: string) => Promise<string>;
}

async function run(argv: string[], options: RunOptions = {}): Promise<Result> {
  let out = '';
  let err = '';
  const dir = options.dir ?? tmpdir();
  const io: Io = {
    argv,
    env: options.env ?? { CLAUDE_PROJECT_DIR: dir },
    cwd: options.cwd ?? dir,
    ...(options.ask === undefined ? {} : { ask: options.ask }),
    readStdin: () => Promise.resolve(options.stdin ?? '{}'),
    out: text => {
      out += text;
    },
    err: text => {
      err += text;
    },
    ...(options.ran === undefined ? {} : { run: () => Promise.resolve(options.ran ?? []) }),
  };
  const code = await main(io);
  return { code, out, err };
}

const bash = (command: string): string => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

describe('sarathi hook', () => {
  it('runs the matching handlers and answers with their merged result', async () => {
    const dir = project({
      PreToolUse: [
        { matcher: 'Bash', command: 'cat >/dev/null; echo "BLOCKED: no pushes" >&2; exit 2' },
        { matcher: 'Edit', command: 'exit 2' },
      ],
    });
    const result = await run(['hook', 'PreToolUse'], { dir, stdin: bash('git push') });
    assert.deepEqual(result, { code: 2, out: '', err: 'BLOCKED: no pushes\n' });
  });

  it('passes with no output when no handler matches', async () => {
    const dir = project({ PreToolUse: [{ matcher: 'Edit', command: 'exit 2' }] });
    assert.deepEqual(await run(['hook', 'PreToolUse'], { dir, stdin: bash('ls') }), { code: 0, out: '', err: '' });
    assert.deepEqual(await run(['hook', 'Stop'], { dir }), { code: 0, out: '', err: '' });
  });

  it('prints a JSON answer on stdout', async () => {
    const dir = project({ Stop: [{ command: 'x' }] });
    const ran: Outcome[] = [{ label: 'x', code: 0, stdout: '{"decision":"block","reason":"r"}', stderr: '', timedOut: false, failClosed: false }];
    assert.deepEqual(await run(['hook', 'Stop'], { dir, ran }), { code: 0, out: '{"decision":"block","reason":"r"}\n', err: '' });
  });

  it('reads the hook list from --config, relative to the working folder', async () => {
    const dir = project({ Stop: [{ command: 'echo listed' }] });
    const result = await run(['hook', 'Stop', '--config', '.claude/sarathi.json'], { dir, env: {} });
    assert.deepEqual(result, { code: 0, out: 'listed\n', err: '' });
    // A --config other than the project's own list wins over it.
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ hooks: { Stop: [{ command: 'echo other' }] } }));
    assert.deepEqual(await run(['hook', 'Stop', '--config', 'other.json'], { dir }), { code: 0, out: 'other\n', err: '' });
    const elsewhere = project({ Stop: [{ command: 'echo elsewhere' }] });
    writeFileSync(join(elsewhere, 'other.json'), JSON.stringify({ hooks: { Stop: [{ command: 'echo other elsewhere' }] } }));
    assert.deepEqual(await run(['hook', 'Stop', '--config', 'other.json'], { dir, cwd: elsewhere }), { code: 0, out: 'other elsewhere\n', err: '' });
  });

  it('reads the project’s list from $CLAUDE_PROJECT_DIR, or the working folder when it is unset or empty', async () => {
    const root = project({ Stop: [{ command: 'echo root' }] });
    const cwd = project({ Stop: [{ command: 'echo cwd' }] });
    assert.deepEqual(await run(['hook', 'Stop'], { cwd, env: { CLAUDE_PROJECT_DIR: root } }), { code: 0, out: 'root\n', err: '' });
    assert.deepEqual(await run(['hook', 'Stop'], { cwd, env: { CLAUDE_PROJECT_DIR: '' } }), { code: 0, out: 'cwd\n', err: '' });
    assert.deepEqual(await run(['hook', 'Stop'], { cwd, env: {} }), { code: 0, out: 'cwd\n', err: '' });
  });

  it('refuses a guarded event it cannot judge, and only warns on others', async () => {
    const dir = scratch('sarathi-none-');
    const missing = await run(['hook', 'PreToolUse'], { dir, stdin: bash('ls') });
    assert.equal(missing.code, 2);
    assert.match(missing.err, /^BLOCKED: sarathi cannot use its hook list: cannot read .*sarathi\.json \(ENOENT\)\. No PreToolUse handler ran\./);
    const stop = await run(['hook', 'Stop'], { dir });
    assert.equal(stop.code, 1);
    assert.match(stop.err, /^sarathi cannot use its hook list/);
    const garbled = await run(['hook', 'PreToolUse'], { dir, stdin: 'not json' });
    assert.equal(garbled.code, 2);
    assert.match(garbled.err, /^BLOCKED: sarathi: the PreToolUse event on stdin is not a JSON object/);
    const notJson = { code: 1, out: '', err: 'sarathi: the Stop event on stdin is not a JSON object, so no handler ran.\n' };
    assert.deepEqual(await run(['hook', 'Stop'], { dir, stdin: 'not json' }), notJson);
    assert.deepEqual(await run(['hook', 'Stop'], { dir, stdin: '[]' }), notJson);
    assert.deepEqual(await run(['hook', 'Stop'], { dir, stdin: 'null' }), notJson);
  });

  it('needs exactly one event', async () => {
    const usage = (await run([])).err;
    assert.match(usage, /^usage: sarathi hook <Event>/);
    assert.deepEqual(await run(['hook']), { code: 1, out: '', err: usage });
    assert.deepEqual(await run(['hook', 'A', 'B']), { code: 1, out: '', err: usage });
  });
});

describe('sarathi hook with forbidEnv', () => {
  const WHY = 'the advisor stays on';
  const forbid = { forbidEnv: { NO_ADVISOR: WHY } };
  const ok: Outcome = { label: 'h', code: 0, stdout: '{"hookSpecificOutput":{"additionalContext":"handler"}}', stderr: '', timedOut: false, failClosed: false };

  it('refuses every PreToolUse call while the variable is set, before any handler runs', async () => {
    const dir = project({ PreToolUse: [{ matcher: 'Bash', command: 'exit 0' }] }, forbid);
    let calls = 0;
    let err = '';
    const code = await main({
      argv: ['hook', 'PreToolUse'],
      env: { CLAUDE_PROJECT_DIR: dir, NO_ADVISOR: '1' },
      cwd: dir,
      readStdin: () => Promise.resolve(bash('ls')),
      out: () => assert.fail('no stdout'),
      err: text => {
        err += text;
      },
      run: () => {
        calls += 1;
        return Promise.resolve([ok]);
      },
    });
    assert.equal(code, 2);
    assert.equal(calls, 0);
    assert.equal(err, `BLOCKED: sarathi: NO_ADVISOR is set, and this project forbids it: ${WHY}. Unset NO_ADVISOR and start a new session; until then sarathi refuses every tool call.\n`);
    // The same handler runs once the variable is off.
    const off = await main({ argv: ['hook', 'PreToolUse'], env: { CLAUDE_PROJECT_DIR: dir }, cwd: dir, readStdin: () => Promise.resolve(bash('ls')), out: () => undefined, err: () => undefined, run: () => { calls += 1; return Promise.resolve([ok]); } });
    assert.equal(off, 0);
    assert.equal(calls, 1);
  });

  it('keeps the warning when a handler blocks the prompt', async () => {
    const dir = project({ UserPromptSubmit: [{ command: 'x' }] }, forbid);
    const blocker: Outcome = { label: 'b', code: 2, stdout: '', stderr: 'no prompts today\n', timedOut: false, failClosed: false };
    const result = await run(['hook', 'UserPromptSubmit'], { dir, env: { CLAUDE_PROJECT_DIR: dir, NO_ADVISOR: '1' }, ran: [blocker] });
    assert.equal(result.code, 2);
    assert.match(result.err, /^sarathi: NO_ADVISOR is set, and this project forbids it: the advisor stays on\. .*\nno prompts today\n$/);
  });

  it('warns Claude and the user at SessionStart and UserPromptSubmit, keeping the handlers’ answers', async () => {
    const dir = project({ UserPromptSubmit: [{ command: 'x' }] }, forbid);
    const env = { CLAUDE_PROJECT_DIR: dir, NO_ADVISOR: 'true' };
    const prompt = await run(['hook', 'UserPromptSubmit'], { dir, env, ran: [ok] });
    assert.equal(prompt.code, 0);
    assert.equal(prompt.err, '');
    const answer = JSON.parse(prompt.out) as { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.match(answer.systemMessage, /^sarathi: NO_ADVISOR is set, and this project forbids it: the advisor stays on\./);
    assert.equal(answer.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(answer.hookSpecificOutput.additionalContext, /NO_ADVISOR is set[\s\S]*\n\nhandler$/);
    // No SessionStart handler is listed, so none runs: the stub's answer must not show.
    const start = await run(['hook', 'SessionStart'], { dir, env, ran: [ok] });
    assert.equal(start.code, 0);
    assert.equal(start.err, '');
    const started = JSON.parse(start.out) as typeof answer;
    assert.match(started.systemMessage, /^sarathi: NO_ADVISOR is set, and this project forbids it: the advisor stays on\. Unset NO_ADVISOR/);
    assert.equal(started.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(started.hookSpecificOutput.additionalContext, started.systemMessage);
  });

  it('says nothing on other events, and nothing when the variable is off', async () => {
    const dir = project({ Stop: [] }, forbid);
    assert.deepEqual(await run(['hook', 'Stop'], { dir, env: { CLAUDE_PROJECT_DIR: dir, NO_ADVISOR: '1' } }), { code: 0, out: '', err: '' });
    assert.deepEqual(await run(['hook', 'PreToolUse'], { dir, stdin: bash('ls'), env: { CLAUDE_PROJECT_DIR: dir, NO_ADVISOR: '0' } }), { code: 0, out: '', err: '' });
  });

  it('names every forbidden variable set', () => {
    const outcome = forbidOutcome('PreToolUse', [
      ['A', 'a'],
      ['B', 'b'],
    ]);
    assert.match(outcome?.stderr ?? '', /A is set, and this project forbids it: a; B is set, and this project forbids it: b\. Unset A and B /);
    assert.equal(forbidOutcome('PreToolUse', []), undefined);
  });

  it('answers each event in full: a refusal, a warning, or nothing', () => {
    const set: Array<readonly [string, string]> = [
      ['A', 'a'],
      ['B', 'b'],
    ];
    const said = 'A is set, and this project forbids it: a; B is set, and this project forbids it: b. Unset A and B and start a new session; until then sarathi refuses every tool call.';
    const base = { label: 'sarathi forbidEnv', timedOut: false, failClosed: true };
    assert.deepEqual(forbidOutcome('PreToolUse', set), { ...base, code: 2, stdout: '', stderr: `BLOCKED: sarathi: ${said}\n` });
    const message = `sarathi: ${said}`;
    assert.deepEqual(forbidOutcome('SessionStart', set), {
      ...base,
      code: 0,
      stdout: JSON.stringify({ systemMessage: message, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message } }),
      stderr: '',
    });
    assert.equal(forbidOutcome('Stop', set), undefined);
  });
});

describe('runsSarathiFor', () => {
  it('knows sarathi run directly or through a launcher, for that event only', () => {
    assert.equal(runsSarathiFor('npx --no-install sarathi hook Stop', 'Stop'), true);
    assert.equal(runsSarathiFor('"$CLAUDE_PROJECT_DIR"/.claude/hooks/sarathi.sh Stop', 'Stop'), true);
    assert.equal(runsSarathiFor("sarathi hook 'Stop'", 'Stop'), true);
    assert.equal(runsSarathiFor('sarathi hook SubagentStop', 'Stop'), false);
    assert.equal(runsSarathiFor('sarathi hook Stop2', 'Stop'), false);
    assert.equal(runsSarathiFor('other.sh Stop', 'Stop'), false);
  });
});

describe('matchTarget', () => {
  it('reads the tool, or the event’s own matcher field', () => {
    assert.equal(matchTarget({ tool_name: 'Bash', source: 'x' }), 'Bash');
    assert.equal(matchTarget({ source: 'startup' }), 'startup');
    assert.equal(matchTarget({ trigger: 'auto' }), 'auto');
    assert.equal(matchTarget({ notification_type: 'idle_prompt' }), 'idle_prompt');
    assert.equal(matchTarget({ agent_type: 'Explore' }), 'Explore');
    assert.equal(matchTarget({ tool_name: 3 }), '');
  });
});

describe('sarathi check', () => {
  const hooks = {
    PreToolUse: [
      { matcher: 'Bash|Edit', command: 'a' },
      { matcher: 'Bash', command: 'b', timeout: 120 },
    ],
    Stop: [{ command: 'c' }],
    Empty: [],
  };
  const settingsFile = (dir: string, value: unknown): string => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const entry = (matcher: string | undefined, event: string, timeout?: number): unknown => ({
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: 'command', command: `node sarathi/dist/bin.js hook ${event}`, ...(timeout === undefined ? {} : { timeout }) }],
  });

  it('validates the hook list on its own', async () => {
    const dir = project(hooks);
    const result = await run(['check'], { dir });
    assert.equal(result.code, 0);
    assert.match(result.out, /is valid \(PreToolUse 2, Stop 1, Empty 0\)/);
  });

  it('validates the worktree settings beside the hook list', async () => {
    assert.equal((await run(['check'], { dir: project(hooks, { worktree: { name: 'acme', owner: 'Ana' } }) })).code, 0);
    const result = await run(['check'], { dir: project(hooks, { worktree: { name: 'Acme' } }) });
    assert.equal(result.code, 1);
    assert.match(result.err, /worktree: "name" must be/);
  });

  it('validates the where settings beside the hook list', async () => {
    assert.equal((await run(['check'], { dir: project(hooks, { where: { config: 'scripts/where.cjs' } }) })).code, 0);
    const dir = project(hooks, { where: { config: '' } });
    assert.deepEqual(await run(['check'], { dir }), {
      code: 1,
      out: '',
      err: `sarathi: ${join(dir, '.claude', 'sarathi.json')} where: "config" must be a path from the project root\n`,
    });
  });

  it('accepts settings that let every handler fire in time', async () => {
    const dir = project(hooks);
    const file = settingsFile(dir, { hooks: { PreToolUse: [entry('Bash|Edit|Read', 'PreToolUse', 130)], Stop: [entry(undefined, 'Stop', 60)] } });
    assert.equal((await run(['check', '--settings', file], { dir })).code, 0);
  });

  it('names each settings problem', async () => {
    const dir = project(hooks);
    const file = settingsFile(dir, {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo sarathi hook PreToolUse', timeout: 60 }, { nothing: 1 }] }, null],
        Stop: 'not a list',
      },
    });
    const result = await run(['check', '--settings', file], { dir });
    assert.equal(result.code, 1);
    assert.equal(
      result.err,
      'sarathi: PreToolUse: the settings matcher leaves out Edit\n' +
        "sarathi: PreToolUse: the settings timeout must be at least 120 s, the longest handler's (has 60)\n" +
        'sarathi: Stop: no settings hook runs `sarathi hook Stop`\n',
    );
  });

  it('wants no matcher where a handler matches all, and a timeout', async () => {
    const dir = project({ Stop: [{ command: 'c' }] });
    const file = settingsFile(dir, { hooks: { Stop: [entry('Bash', 'Stop')] } });
    const result = await run(['check', '--settings', file], { dir });
    assert.match(result.err, /Stop: a handler matches every tool, so the settings entry needs no matcher \(has "Bash"\)/);
    assert.match(result.err, /Stop: the settings timeout must be at least 60 s, the longest handler's \(has none\)/);
  });

  it('takes an empty or "*" matcher as matching every tool', async () => {
    const dir = project({ Stop: [{ command: 'c' }] });
    for (const matcher of ['', '*']) {
      const file = settingsFile(dir, { hooks: { Stop: [entry(matcher, 'Stop', 60)] } });
      assert.deepEqual(await run(['check', '--settings', file], { dir }), { code: 0, out: `sarathi: ${join(dir, '.claude', 'sarathi.json')} is valid (Stop 1)\n`, err: '' }, matcher);
    }
  });

  it('names every tool the settings matcher leaves out, and never an empty name', async () => {
    const dir = project({ PreToolUse: [{ matcher: 'Bash|Edit|Read', command: 'a' }] });
    const file = settingsFile(dir, { hooks: { PreToolUse: [entry('Bash', 'PreToolUse', 60)] } });
    assert.deepEqual(await run(['check', '--settings', file], { dir }), { code: 1, out: '', err: 'sarathi: PreToolUse: the settings matcher leaves out Edit, Read\n' });
    // A trailing | adds no tool to cover.
    const trailing = project({ PreToolUse: [{ matcher: 'Bash|', command: 'a' }] });
    const covers = settingsFile(trailing, { hooks: { PreToolUse: [entry('Bash', 'PreToolUse', 60)] } });
    assert.equal((await run(['check', '--settings', covers], { dir: trailing })).err, '');
  });

  it('treats settings without hooks as running nothing', async () => {
    const dir = project({ Stop: [{ command: 'c' }] });
    const result = await run(['check', '--settings', settingsFile(dir, {})], { dir });
    assert.match(result.err, /no settings hook runs/);
  });

  it('refuses unreadable inputs', async () => {
    const dir = project(hooks);
    assert.match((await run(['check', '--settings', join(dir, 'none.json')], { dir })).err, /cannot read/);
    assert.match((await run(['check', '--settings', settingsFile(dir, '{')], { dir })).err, /is not JSON/);
    const empty = scratch('sarathi-empty-');
    assert.deepEqual(await run(['check'], { dir: empty }), { code: 1, out: '', err: `sarathi: cannot read ${join(empty, '.claude', 'sarathi.json')} (ENOENT)\n` });
    assert.deepEqual(await run(['check', 'extra'], { dir }), { code: 1, out: '', err: (await run([])).err });
  });
});

describe('settingsHooks', () => {
  it('reads each event’s command hooks, skipping what is not one', () => {
    const text = JSON.stringify({
      hooks: {
        Stop: { matcher: 'not', hooks: [{ command: 'x' }] },
        Notification: 5,
        PreToolUse: [
          null,
          { matcher: 3, hooks: [null, { command: 1 }, { command: 'c', timeout: '9' }, { command: 'd', timeout: 5 }] },
          { matcher: 'Bash', hooks: { command: 'not a list' } },
          { matcher: 'Edit', hooks: [{ command: 'e' }] },
        ],
      },
    });
    assert.deepEqual(
      settingsHooks(text, 'p'),
      new Map([
        ['Stop', []],
        ['Notification', []],
        [
          'PreToolUse',
          [
            { matcher: undefined, command: 'c', timeout: undefined },
            { matcher: undefined, command: 'd', timeout: 5 },
            { matcher: 'Edit', command: 'e', timeout: undefined },
          ],
        ],
      ]),
    );
  });

  it('reads no hooks from settings without a hooks object, and refuses what is not JSON', () => {
    for (const text of ['null', '{}', '{"hooks":null}', '{"hooks":"x"}']) assert.deepEqual(settingsHooks(text, 'p'), new Map(), text);
    assert.equal(settingsHooks('{', 'p'), 'p is not JSON');
  });
});

describe('options', () => {
  it('prints the version, which is the package’s', async () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string };
    assert.deepEqual(await run(['--version']), { code: 0, out: `${pkg.version}\n`, err: '' });
    assert.equal(VERSION, pkg.version);
    // Only alone: with more words it is an option hook and check do not know.
    assert.deepEqual(await run(['--version', 'x']), { code: 1, out: '', err: `sarathi: unknown option --version\n${(await run([])).err}` });
  });

  it('refuses unknown commands and options', async () => {
    assert.equal((await run([])).code, 1);
    assert.equal((await run(['other'])).code, 1);
    assert.match((await run(['hook', 'Stop', '--fast'])).err, /unknown option --fast/);
    assert.match((await run(['check', '--config'])).err, /--config needs a file/);
    assert.match((await run(['check', '--settings', ''])).err, /--settings needs a file/);
  });

  it('hands page its own flags, which hook and check do not know', async () => {
    assert.deepEqual(await run(['page', '--comments']), { code: 1, out: '', err: '--comments needs a value\n' });
    assert.deepEqual(await run(['page', '--read', 'https://example.com/x']), {
      code: 1,
      out: '',
      err: '--read needs a claude.ai artifact URL, got https://example.com/x\n',
    });
    assert.match((await run([])).err, /sarathi page --read <artifact>/);
  });

  it('hands autofix its own flags', async () => {
    assert.match((await run(['autofix', 'add', 'x', '--session'])).err, /--session needs a value/);
    assert.match((await run([])).err, /sarathi autofix add <pr-url>/);
  });

  it('hands autofix its words and the clock, so a pull request lands on the list with its time', async () => {
    const dir = scratch('sarathi-autofix-');
    const env = { SARATHI_AUTOFIX_DIR: dir };
    const session = '00000000-0000-4000-8000-000000000001';
    const added = await run(['autofix', 'add', 'https://github.com/o/r/pull/7', '--session', session], { env });
    assert.equal(added.code, 0, added.err);
    assert.match(added.out, /^sarathi autofix: o\/r#7 is on session 00000000-0000-4000-8000-000000000001's list/);
    const [file] = readdirSync(dir);
    const row = JSON.parse(readFileSync(join(dir, String(file)), 'utf8').trim()) as { at: string; pr: string; event: string };
    assert.equal(row.pr, 'o/r#7');
    assert.equal(row.event, 'opened');
    assert.ok(Math.abs(Date.parse(row.at) - Date.now()) < 60_000, row.at);
    assert.deepEqual(await run(['autofix', 'list', '--session', session], { env }), { code: 0, out: 'o/r#7\topened\thttps://github.com/o/r/pull/7\n', err: '' });
  });
});

describe('worktree and services', () => {
  it('runs the archive guard on the event on stdin', async () => {
    const denied = await run(['worktree', 'hook'], { stdin: 'not json' });
    assert.equal(denied.code, 0);
    assert.equal(denied.err, '');
    const answer = JSON.parse(denied.out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(answer.hookSpecificOutput.permissionDecisionReason, /^Archive blocked: unable to verify the owning worktree\./);
    // With more words it is a lifecycle action, which `hook` is not.
    assert.deepEqual(await run(['worktree', 'hook', 'x'], { stdin: 'not json' }), { code: 1, out: '', err: LIFECYCLE_USAGE });
  });

  it('hands the lifecycle its words', async () => {
    assert.deepEqual(await run(['worktree', 'status', '--pr', 'x']), { code: 1, out: '', err: `--pr needs a number\n${LIFECYCLE_USAGE}` });
  });

  it('hands pick its words', async () => {
    assert.deepEqual(await run(['worktree', 'pick', '--shell']), { code: 0, out: SHELL_HELP, err: '' });
    assert.deepEqual(await run(['worktree', 'pick', 'x']), { code: 1, out: '', err: PICK_USAGE });
  });

  it('asks pick’s question on stderr and takes the first line of stdin, unless it is given a way to ask', async () => {
    const repo = scratch('sarathi-pick-');
    const env = { PATH: process.env['PATH'] ?? '', HOME: repo };
    execFileSync('git', ['init', '-q', repo], { env, timeout: 20_000, killSignal: 'SIGKILL' });
    const path = `${realpathSync(repo)}\n`;
    // "01": a whole first line, so a split on anything but the newline picks none.
    const typed = await run(['worktree', 'pick'], { dir: repo, env, stdin: '01\n2\n' });
    assert.equal(typed.out, path, typed.err);
    assert.equal(typed.code, 0);
    assert.match(typed.err, /^Worktrees:\n {2}1\) .*\nPick a number: $/);
    const asked: string[] = [];
    const given = await run(['worktree', 'pick'], {
      dir: repo,
      env,
      stdin: 'nothing to read here\n',
      ask: prompt => {
        asked.push(prompt);
        return Promise.resolve('1');
      },
    });
    assert.deepEqual({ code: given.code, out: given.out }, { code: 0, out: path });
    assert.doesNotMatch(given.err, /Pick a number/);
    assert.deepEqual(asked, ['Pick a number: ']);
  });

  it('hands cleanup its words', async () => {
    assert.deepEqual(await run(['worktree', 'cleanup', '--bogus']), { code: 2, out: `${CLEANUP_USAGE}\n`, err: '' });
  });

  it('hands services its words', async () => {
    assert.deepEqual(await run(['services', '--bogus']), { code: 1, out: '', err: SERVICES_USAGE });
  });

  it('hands where its words, before sarathi reads --config or --max as its own', async () => {
    assert.deepEqual(await run(['where', '--help']), { code: 0, out: WHERE_HELP, err: '' });
    assert.deepEqual(await run(['where', 'x', '--max', '0', '--config', 'c.cjs']), {
      code: 2,
      out: '',
      err: `sarathi where: --max needs a positive whole number, not "0"\n\n${WHERE_HELP}`,
    });
  });
});

describe('bin', () => {
  it('runs as a program with the event on stdin', () => {
    const dir = project({ Stop: [{ command: 'cat' }] });
    const bin = fileURLToPath(new URL('./bin.ts', import.meta.url));
    const result = spawnSync(process.execPath, [bin, 'hook', 'Stop'], {
      input: '{"hook_event_name":"Stop"}',
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '{"hook_event_name":"Stop"}\n');
  });
});
