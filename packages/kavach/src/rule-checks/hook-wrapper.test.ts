/**
 * The CLI as Claude Code runs it, a hook process: it reads the event on
 * stdin, stays silent when no check fires, answers a refusal, and fails open.
 * Each case starts `node cli.ts` the way a hook registration would.
 */
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { scratchDirs } from './fixture.test.ts';

const CLI = join(import.meta.dirname, 'cli.ts');

const { scratch, cleanup } = scratchDirs('rule-hook-');
afterEach(cleanup);

const input = (command: string): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: tmpdir(),
    tool_input: { command },
  });

/** A project folder holding `checks.mjs` with `body` as its source. */
function project(body: string): string {
  const root = scratch();
  writeFileSync(join(root, 'checks.mjs'), body);
  return root;
}

const COUNTS_INPUT = `export default [
  {
    rule: 'H-01',
    events: ['PreToolUse'],
    cost: 'c',
    instead: 'i',
    run: (context) =>
      context.command === 'quiet' ? null : { action: 'warn', detail: 'Read ' + context.command.length + ' characters.' },
  },
];
`;

function hook(root: string, stdin: string, args: readonly string[] = ['--checks', 'checks.mjs']): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    encoding: 'utf8',
    cwd: tmpdir(),
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      CLAUDE_PROJECT_DIR: root,
      KAVACH_RULE_FIRES_DIR: join(root, 'fires'),
    },
  });
}

describe('the hook process', () => {
  it('is silent and lets the call through when no check fires', () => {
    const result = hook(project(COUNTS_INPUT), input('quiet'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  it('passes the checks its stdin and prints their answer', () => {
    const result = hook(project(COUNTS_INPUT), input('git status'));
    assert.equal(result.status, 0);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /\nRead 10 characters\.\n/);
  });

  it('stays out of the way when its checks module is missing, saying so', () => {
    const root = scratch();
    const result = hook(root, input('ls'));
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /^The rule checks crashed \(/);
    assert.match(readFileSync(join(root, 'fires', 'fires.jsonl'), 'utf8'), /"rule":"runtime"/);
  });

  it('answers a crash on input it cannot read, rather than throw', () => {
    const result = hook(project(COUNTS_INPUT), '[]');
    assert.equal(result.status, 0);
    assert.equal(
      JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
      'The rule checks crashed (hook input is not a JSON object); the action goes ahead.',
    );
  });

  it('exits non-zero, a non-blocking error, when a checks module ends the process', () => {
    const result = hook(project('process.exit(3);\n'), input('ls'));
    assert.equal(result.status, 3);
    assert.equal(result.stdout, '');
  });

  it('runs the count as a subcommand', () => {
    const root = scratch();
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({ rules: [{ id: 'H-01', title: 'T', notes: ['n'], enforcer: null }] }),
    );
    const result = spawnSync(process.execPath, [CLI, 'count', '--registry', join(root, 'registry.json'), '--json'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${JSON.stringify({ total: 1, unenforced: ['H-01'] })}\n`);
  });
});
