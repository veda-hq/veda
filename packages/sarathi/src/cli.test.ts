import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { forbidOutcome, main, matchTarget, runsSarathiFor, VERSION, type Io } from './cli.ts';
import type { Outcome } from './run.ts';

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function project(hooks: unknown, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'sarathi-cli-'));
  execFileSync('mkdir', ['-p', join(dir, '.claude')]);
  writeFileSync(join(dir, '.claude', 'sarathi.json'), JSON.stringify({ ...extra, hooks }));
  return dir;
}

async function run(argv: string[], options: { dir?: string; stdin?: string; ran?: Outcome[]; env?: Record<string, string> } = {}): Promise<Result> {
  let out = '';
  let err = '';
  const dir = options.dir ?? tmpdir();
  const io: Io = {
    argv,
    env: options.env ?? { CLAUDE_PROJECT_DIR: dir },
    cwd: dir,
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
  });

  it('refuses a guarded event it cannot judge, and only warns on others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sarathi-none-'));
    const missing = await run(['hook', 'PreToolUse'], { dir, stdin: bash('ls') });
    assert.equal(missing.code, 2);
    assert.match(missing.err, /^BLOCKED: sarathi cannot use its hook list: cannot read .*sarathi\.json \(ENOENT\)\. No PreToolUse handler ran\./);
    const stop = await run(['hook', 'Stop'], { dir });
    assert.equal(stop.code, 1);
    assert.match(stop.err, /^sarathi cannot use its hook list/);
    const garbled = await run(['hook', 'PreToolUse'], { dir, stdin: 'not json' });
    assert.equal(garbled.code, 2);
    assert.match(garbled.err, /^BLOCKED: sarathi: the PreToolUse event on stdin is not a JSON object/);
    const list = await run(['hook', 'Stop'], { dir, stdin: '[]' });
    assert.equal(list.code, 1);
  });

  it('needs exactly one event', async () => {
    assert.equal((await run(['hook'])).code, 1);
    assert.equal((await run(['hook', 'A', 'B'])).code, 1);
  });
});

describe('sarathi hook with forbidEnv', () => {
  const WHY = 'the advisor stays on';
  const forbid = { forbidEnv: { NO_ADVISOR: WHY } };
  const ok: Outcome = { label: 'h', code: 0, stdout: '{"hookSpecificOutput":{"additionalContext":"handler"}}', stderr: '', timedOut: false, failClosed: false };

  it('refuses every PreToolUse call while the variable is set, before any handler runs', async () => {
    const dir = project({ PreToolUse: [{ matcher: 'Edit', command: 'exit 0' }] }, forbid);
    const result = await run(['hook', 'PreToolUse'], { dir, stdin: bash('ls'), env: { CLAUDE_PROJECT_DIR: dir, NO_ADVISOR: '1' }, ran: [ok] });
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.equal(result.err, `BLOCKED: sarathi: NO_ADVISOR is set, and this project forbids it: ${WHY}. Unset NO_ADVISOR and start a new session; until then sarathi refuses every tool call.\n`);
  });

  it('warns Claude and the user at SessionStart and UserPromptSubmit, keeping the handlers’ answers', async () => {
    const dir = project({ UserPromptSubmit: [{ command: 'x' }] }, forbid);
    const env = { CLAUDE_PROJECT_DIR: dir, NO_ADVISOR: 'true' };
    const prompt = await run(['hook', 'UserPromptSubmit'], { dir, env, ran: [ok] });
    assert.equal(prompt.code, 0);
    const answer = JSON.parse(prompt.out) as { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.match(answer.systemMessage, /^sarathi: NO_ADVISOR is set, and this project forbids it: the advisor stays on\./);
    assert.equal(answer.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(answer.hookSpecificOutput.additionalContext, /NO_ADVISOR is set[\s\S]*\n\nhandler$/);
    const start = await run(['hook', 'SessionStart'], { dir, env });
    assert.equal(start.code, 0);
    assert.match(start.out, /"hookEventName":"SessionStart"/);
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

  it('treats settings without hooks as running nothing', async () => {
    const dir = project({ Stop: [{ command: 'c' }] });
    const result = await run(['check', '--settings', settingsFile(dir, {})], { dir });
    assert.match(result.err, /no settings hook runs/);
  });

  it('refuses unreadable inputs', async () => {
    const dir = project(hooks);
    assert.match((await run(['check', '--settings', join(dir, 'none.json')], { dir })).err, /cannot read/);
    assert.match((await run(['check', '--settings', settingsFile(dir, '{')], { dir })).err, /is not JSON/);
    const empty = mkdtempSync(join(tmpdir(), 'sarathi-empty-'));
    assert.match((await run(['check'], { dir: empty })).err, /cannot read/);
    assert.equal((await run(['check', 'extra'], { dir })).code, 1);
  });
});

describe('options', () => {
  it('prints the version, which is the package’s', async () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
    assert.deepEqual(await run(['--version']), { code: 0, out: `${VERSION}\n`, err: '' });
  });

  it('refuses unknown commands and options', async () => {
    assert.equal((await run([])).code, 1);
    assert.equal((await run(['other'])).code, 1);
    assert.match((await run(['hook', 'Stop', '--fast'])).err, /unknown option --fast/);
    assert.match((await run(['check', '--config'])).err, /--config needs a file/);
    assert.match((await run(['check', '--settings', ''])).err, /--settings needs a file/);
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
