// .claude/hooks/sarathi.sh, run as Claude Code runs it: the event on stdin,
// CLAUDE_PROJECT_DIR set. The repository's own install must be there
// (`pnpm install`), as it is in CI.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHER = join(ROOT, '.claude', 'hooks', 'sarathi.sh');
const scratch = mkdtempSync(join(tmpdir(), 'sarathi-hook-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** @param {string} event @param {object} input @param {{ project?: string, env?: Record<string, string> }} [options] */
function hook(event, input, options = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: options.project ?? ROOT, KAVACH_REFUSAL_LOG_OFF: '1', ...options.env };
  if (options.env?.CLAUDE_CODE_DISABLE_ADVISOR_TOOL === undefined) delete env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL;
  const result = spawnSync('bash', [LAUNCHER, event], { input: JSON.stringify(input), encoding: 'utf8', env, cwd: ROOT });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** @param {string} command */
const bash = command => ({ hook_event_name: 'PreToolUse', cwd: ROOT, tool_name: 'Bash', tool_input: { command } });

/** A project folder pinning sarathi 0.5.15, with `install` laying out its node_modules. @param {string} name @param {(dir: string) => void} [install] */
function project(name, install) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{\n  "devDependencies": {\n    "@veda-hq/sarathi": "0.5.15"\n  }\n}\n');
  install?.(dir);
  return dir;
}

/** A sarathi at `version` in `dir`, whose bin.js runs `body`. @param {string} dir @param {string} version @param {string} body */
function fakeSarathi(dir, version, body) {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), `{\n  "name": "@veda-hq/sarathi",\n  "version": "${version}"\n}\n`);
  writeFileSync(join(dir, 'dist', 'bin.js'), body);
}

describe('kavach through sarathi, from the pinned install', () => {
  test('a --no-verify commit is refused by the command guard', () => {
    const { code, stderr } = hook('PreToolUse', bash('git commit --no-verify -m wip'));
    assert.equal(code, 2);
    assert.match(stderr, /--no-verify is forbidden on all git commands/);
  });

  test('a hooks-path bypass the permission rules miss is refused too', () => {
    const { code, stderr } = hook('PreToolUse', bash('git -c core.hooksPath=/dev/null commit -m wip'));
    assert.equal(code, 2);
    assert.match(stderr, /BLOCKED: '-c core\.hooksPath=\.\.\.' repoints the repository hooks/);
  });

  test('a read-only command passes', () => {
    const { code, stderr } = hook('PreToolUse', bash('git status'));
    assert.equal(code, 0, stderr);
  });

  test('the advisor switched off refuses every call and is told at session start', () => {
    const env = { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' };
    const refused = hook('PreToolUse', bash('git status'), { env });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /CLAUDE_CODE_DISABLE_ADVISOR_TOOL is set/);
    const told = hook('SessionStart', { hook_event_name: 'SessionStart', cwd: ROOT, source: 'startup' }, { env });
    assert.equal(told.code, 0);
    assert.match(JSON.parse(told.stdout).systemMessage, /advisor/);
  });
});

describe('when the pinned sarathi cannot run', () => {
  test('nothing installed: PreToolUse refuses, other events warn', () => {
    const dir = project('missing');
    const refused = hook('PreToolUse', bash('git status'), { project: dir });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /BLOCKED: sarathi 0\.5\.15 is not installed .*found nothing.*run pnpm install/);
    const warned = hook('SessionStart', { hook_event_name: 'SessionStart' }, { project: dir });
    assert.equal(warned.code, 1);
    assert.match(warned.stderr, /No SessionStart handler ran/);
  });

  test('no pin in package.json refuses', () => {
    const dir = join(scratch, 'unpinned');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}\n');
    const { code, stderr } = hook('PreToolUse', bash('git status'), { project: dir });
    assert.equal(code, 2);
    assert.match(stderr, /no pin in package\.json/);
  });

  test('another version refuses', () => {
    const dir = project('stale', d => fakeSarathi(join(d, 'node_modules', '@veda-hq', 'sarathi'), '0.5.7', 'process.exit(0)'));
    const { code, stderr } = hook('PreToolUse', bash('git status'), { project: dir });
    assert.equal(code, 2);
    assert.match(stderr, /found 0\.5\.7/);
  });

  test('packages/sarathi linked in place of the pin refuses', () => {
    const dir = project('linked', d => {
      fakeSarathi(join(d, 'packages', 'sarathi'), '0.5.15', 'process.exit(0)');
      mkdirSync(join(d, 'node_modules', '@veda-hq'), { recursive: true });
      symlinkSync(join(d, 'packages', 'sarathi'), join(d, 'node_modules', '@veda-hq', 'sarathi'));
    });
    const { code, stderr } = hook('PreToolUse', bash('git status'), { project: dir });
    assert.equal(code, 2);
    assert.match(stderr, /the workspace's own packages\/sarathi/);
  });

  test('a sarathi that crashes refuses PreToolUse and passes its exit on elsewhere', () => {
    const dir = project('crashing', d => fakeSarathi(join(d, 'node_modules', '@veda-hq', 'sarathi'), '0.5.15', 'process.exit(1)'));
    const refused = hook('PreToolUse', bash('git status'), { project: dir });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /sarathi ended with exit 1/);
    assert.equal(hook('SessionStart', { hook_event_name: 'SessionStart' }, { project: dir }).code, 1);
  });
});
