// .claude/hooks/sarathi.sh, run as Claude Code runs it: the event on stdin,
// CLAUDE_PROJECT_DIR set. The repository's own install must be there
// (`pnpm install`), as it is in CI.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHER = join(ROOT, '.claude', 'hooks', 'sarathi.sh');
const scratch = mkdtempSync(join(tmpdir(), 'sarathi-hook-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A stand-in niyam CLI. .claude/sarathi.json runs niyam's identity guard on
// every gh or git command and niyam session-start at session start, both
// failing closed without the CLI, which CI does not install. HOME is a scratch
// folder, so the hook finds this one first on PATH, never a real one in
// ~/.config/niyam/bin.
const niyamHome = join(scratch, 'home');
const niyamBin = join(scratch, 'niyam-bin');
mkdirSync(niyamHome, { recursive: true });
mkdirSync(niyamBin, { recursive: true });
writeFileSync(
  join(niyamBin, 'niyam'),
  ['#!/bin/sh', 'case "$1" in', '  guard) cat > /dev/null ;;', '  session-start) echo "niyam: the stand-in session-start ran" ;;', '  *) exit 9 ;;', 'esac', ''].join('\n'),
  { mode: 0o755 },
);

/** The environment a hook runs in: `env` over this process's, with the stand-in niyam. @param {string} project @param {Record<string, string>} [env] */
function hookEnv(project, env = {}) {
  const merged = { ...process.env, CLAUDE_PROJECT_DIR: project, KAVACH_REFUSAL_LOG_OFF: '1', ...env, HOME: niyamHome };
  merged.PATH = `${niyamBin}:${merged.PATH}`;
  if (env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL === undefined) delete merged.CLAUDE_CODE_DISABLE_ADVISOR_TOOL;
  return merged;
}

/** @param {string} event @param {object} input @param {{ project?: string, env?: Record<string, string>, unset?: string[] }} [options] */
function hook(event, input, options = {}) {
  const env = hookEnv(options.project ?? ROOT, options.env);
  for (const name of options.unset ?? []) delete env[name];
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

// A stand-in pnpm: counts its installs where it runs, and lays out a working
// sarathi and dvara there; with a `fail` file it fails as pnpm does.
const pnpmBin = join(scratch, 'bin');
mkdirSync(pnpmBin, { recursive: true });
writeFileSync(
  join(pnpmBin, 'pnpm'),
  [
    '#!/bin/sh',
    '[ "$*" = "install --frozen-lockfile" ] || exit 9',
    'echo x >> installs',
    '[ -n "$SLOW_INSTALL" ] && sleep 2',
    '[ -e fail ] && { echo "ERR_TEST no such version"; exit 1; }',
    'mkdir -p node_modules/@veda-hq/sarathi/dist node_modules/@veda-hq/dvara',
    'printf \'{\\n  "version": "0.5.15"\\n}\\n\' > node_modules/@veda-hq/sarathi/package.json',
    'printf \'{\\n  "version": "0.5.16"\\n}\\n\' > node_modules/@veda-hq/dvara/package.json',
    'echo "process.stdout.write(\'{}\')" > node_modules/@veda-hq/sarathi/dist/bin.js',
    '',
  ].join('\n'),
  { mode: 0o755 },
);
const start = { hook_event_name: 'SessionStart', source: 'startup' };
/** How many installs the stand-in pnpm ran in `dir`. @param {string} dir */
const installs = dir => (existsSync(join(dir, 'installs')) ? readFileSync(join(dir, 'installs'), 'utf8').split('\n').filter(Boolean).length : 0);

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

  test('the settings command runs the launcher itself, so it must stay executable', () => {
    const env = hookEnv(ROOT);
    const input = JSON.stringify(bash('git commit --no-verify -m wip'));
    const result = spawnSync('/bin/sh', ['-c', '"$CLAUDE_PROJECT_DIR"/.claude/hooks/sarathi.sh PreToolUse'], { input, encoding: 'utf8', env, cwd: ROOT });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--no-verify is forbidden on all git commands/);
  });

  test('a read-only command passes', () => {
    const { code, stderr } = hook('PreToolUse', bash('git status'));
    assert.equal(code, 0, stderr);
  });

  // The stand-in niyam must not hide a guard that stopped failing closed.
  test('with no niyam CLI anywhere, a git command is refused, failing closed', () => {
    const env = hookEnv(ROOT);
    env.PATH = env.PATH.split(':').filter(dir => !existsSync(join(dir, 'niyam'))).join(':');
    const result = spawnSync('bash', [LAUNCHER, 'PreToolUse'], { input: JSON.stringify(bash('git status')), encoding: 'utf8', env, cwd: ROOT });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /niyam: refused, because the niyam CLI did not run here/);
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

// .claude/kavach.json lists the niyam command lines a session may run although
// kavach cannot prove them read-only: they write nothing locally (niyam 0.6.14
// audited) and run only in a Claude Code session (CLAUDECODE=1). The refused
// rows fail for one reason or another (no owned worktree in CI, unresolved
// targets in a session's worktree), so they assert only the refusal.
describe('the niyam CLI, through .claude/kavach.json', () => {
  const session = { env: { CLAUDECODE: '1' } };
  const allowed = [
    'niyam --version',
    'niyam -v',
    'niyam version',
    'niyam propose 54',
    'niyam propose 54 55 --page https://claude.ai/artifact/7UMPUd2KFsEzuZqwofNH6G',
    'niyam propose 54 --page=https://claude.ai/code/artifact/ab_cd-12',
    'niyam review-thread PRRT_kwDOabc_12-x --resolve',
    'niyam onboard --dry-run',
    'niyam onboard AlokBansal8 --dry-run',
    'niyam onboard AlokBansal8 AthyaBot --dry-run',
    'niyam --version | head -n 1',
  ];
  const refused = [
    'niyam onboard',
    'niyam onboard AlokBansal8 AthyaBot',
    'niyam onboard AlokBansal8 AthyaBot --yes',
    'niyam onboard a b c --dry-run',
    'niyam onboard -owner --dry-run',
    'niyam onboard owner- --dry-run',
    'niyam onboard AlokBansal8 AthyaBot --features board --dry-run',
    'niyam onboard --dry-run --yes',
    'niyam propose #54',
    'niyam propose 54 --page https://example.com/artifact/x',
    'niyam propose 54 --page "https://claude.ai/artifact/x"',
    'niyam propose 54 --page https://claude.ai/artifact/$(touch x)',
    'niyam propose 54 > out.txt',
    'niyam propose 54; touch x',
    'niyam review-thread PRRT_x --reply "done"',
    'niyam review-thread PRRT_x --resolve --reply x',
    'FOO=1 niyam --version',
    './niyam --version',
    'env niyam --version',
    'niyam pre-push',
  ];
  for (const command of allowed) {
    test(`passes: ${command}`, () => {
      const { code, stderr } = hook('PreToolUse', bash(command), session);
      assert.equal(code, 0, stderr);
    });
  }
  for (const command of refused) {
    test(`refused: ${command}`, () => {
      assert.equal(hook('PreToolUse', bash(command), session).code, 2);
    });
  }
  test('refused outside a Claude Code session', () => {
    assert.equal(hook('PreToolUse', bash('niyam --version'), { unset: ['CLAUDECODE'] }).code, 2);
    assert.equal(hook('PreToolUse', bash('niyam --version'), { env: { CLAUDECODE: 'true' } }).code, 2);
  });
  test('refused from a subfolder', () => {
    const { code } = hook('PreToolUse', { ...bash('niyam --version'), cwd: join(ROOT, 'packages') }, session);
    assert.equal(code, 2);
  });
});

describe('when the pinned sarathi cannot run', () => {
  test('nothing installed: PreToolUse refuses, other events warn', () => {
    const dir = project('missing', d => writeFileSync(join(d, 'fail'), ''));
    const refused = hook('PreToolUse', bash('git status'), { project: dir });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /BLOCKED: sarathi 0\.5\.15 is not installed .*found nothing.*run pnpm install/);
    assert.equal(installs(dir), 0, 'PreToolUse never installs');
    const warned = hook('SessionStart', { hook_event_name: 'SessionStart' }, { project: dir, env: { PATH: `${pnpmBin}:${process.env.PATH}` } });
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

  test('session start installs what package.json pins, on the desktop and in the cloud', () => {
    const PATH = `${pnpmBin}:${process.env.PATH}`;

    const desktop = project('desktop');
    const installed = hook('SessionStart', start, { project: desktop, env: { PATH } });
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(installs(desktop), 1);
    assert.equal(hook('PreToolUse', bash('git status'), { project: desktop, env: { PATH } }).code, 0);
    // Once it is in place, a session start installs nothing.
    assert.equal(hook('SessionStart', start, { project: desktop, env: { PATH } }).code, 0);
    assert.equal(installs(desktop), 1);

    const cloud = project('cloud');
    assert.equal(hook('SessionStart', start, { project: cloud, env: { PATH, CLAUDE_CODE_REMOTE: 'true' } }).code, 0);
    assert.equal(installs(cloud), 1);
  });

  test('another @veda-hq pin behind its install is installed too, sarathi being current', () => {
    const PATH = `${pnpmBin}:${process.env.PATH}`;
    const dir = project('bumped', d => fakeSarathi(join(d, 'node_modules', '@veda-hq', 'sarathi'), '0.5.15', "process.stdout.write('{}')"));
    writeFileSync(join(dir, 'package.json'), '{\n  "devDependencies": {\n    "@veda-hq/dvara": "0.5.16",\n    "@veda-hq/sarathi": "0.5.15"\n  }\n}\n');
    assert.equal(hook('SessionStart', start, { project: dir, env: { PATH } }).code, 0);
    assert.equal(installs(dir), 1);
  });

  test('a failed install is said, with its log, and PreToolUse still refuses', () => {
    const PATH = `${pnpmBin}:${process.env.PATH}`;
    const broken = project('fails', d => writeFileSync(join(d, 'fail'), ''));
    const warned = hook('SessionStart', start, { project: broken, env: { PATH } });
    assert.equal(warned.code, 1);
    assert.match(warned.stderr, /pnpm install --frozen-lockfile failed in .*sarathi-install\.log: ERR_TEST no such version/);
    assert.match(warned.stderr, /run pnpm install there/);
    assert.equal(hook('PreToolUse', bash('git status'), { project: broken, env: { PATH } }).code, 2);
  });

  /**
   * A session start in `dir`, with `bins` ahead on PATH and a slow install.
   * @param {string} dir @param {string[]} bins @param {Record<string, string>} [extra]
   * @returns {Promise<{ code: number | null, stderr: string }>}
   */
  const startSession = (dir, bins, extra = {}) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, KAVACH_REFUSAL_LOG_OFF: '1', PATH: [...bins, process.env.PATH].join(':'), SLOW_INSTALL: '1', ...extra };
    delete env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL;
    return new Promise(resolve => {
      const child = spawn('bash', [LAUNCHER, 'SessionStart'], { env, cwd: ROOT, stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', d => (stderr += d));
      child.on('close', code => resolve({ code, stderr }));
      child.stdin.end(JSON.stringify(start));
    });
  };

  /** Two session starts in `dir` at once, with `bins` ahead on PATH. @param {string} dir @param {string[]} bins */
  const startTogether = async (dir, bins) => {
    const results = await Promise.all([startSession(dir, bins), startSession(dir, bins)]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
  };

  test('two sessions starting at once install once', async () => {
    const dir = project('together');
    await startTogether(dir, [pnpmBin]);
    assert.equal(installs(dir), 1);
  });

  // uutils coreutils 0.10.0, /usr/bin/mkdir on ubuntu-26.04, lets two racing
  // `mkdir`s of one path both succeed (#108). A mkdir that says yes to a
  // directory already there is that race every time.
  test('two sessions install once where mkdir says yes to a directory already there', async () => {
    const lenient = join(scratch, 'lenient-mkdir');
    mkdirSync(lenient, { recursive: true });
    writeFileSync(join(lenient, 'mkdir'), '#!/bin/sh\nexec /bin/mkdir -p "$@"\n', { mode: 0o755 });
    const dir = project('together-lenient');
    await startTogether(dir, [pnpmBin, lenient]);
    assert.equal(installs(dir), 1);
  });

  // The lock is a file; a sarathi.sh before #108 left a directory.
  for (const [name, kind, make] of /** @type {const} */ ([
    ['died-file', 'a file', (/** @type {string} */ p) => writeFileSync(p, '')],
    ['died-dir', "an older hook's directory", (/** @type {string} */ p) => mkdirSync(p)],
  ])) {
    test(`a lock left as ${kind} for over 10 minutes is an install that died, and is taken over`, () => {
      const PATH = `${pnpmBin}:${process.env.PATH}`;
      const dir = project(name);
      const lock = join(dir, 'sarathi-install.lock');
      make(lock);
      const eleven = Date.now() / 1000 - 11 * 60;
      utimesSync(lock, eleven, eleven);
      const started = hook('SessionStart', start, { project: dir, env: { PATH } });
      assert.equal(started.code, 0, started.stderr);
      assert.equal(installs(dir), 1);
      assert.equal(existsSync(lock), false);
      assert.equal(existsSync(`${lock}.takeover`), false);
    });
  }

  test('a takeover file over a minute old is a session killed inside it, and the aged lock is still taken over', () => {
    const PATH = `${pnpmBin}:${process.env.PATH}`;
    const dir = project('died-in-takeover');
    const lock = join(dir, 'sarathi-install.lock');
    writeFileSync(lock, '');
    writeFileSync(`${lock}.takeover`, '');
    const eleven = Date.now() / 1000 - 11 * 60;
    utimesSync(lock, eleven, eleven);
    utimesSync(`${lock}.takeover`, eleven, eleven);
    const started = hook('SessionStart', start, { project: dir, env: { PATH } });
    assert.equal(started.code, 0, started.stderr);
    assert.equal(installs(dir), 1);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(`${lock}.takeover`), false);
  });

  // Two sessions can both judge one aged lock stale. The first to remove it
  // then takes a fresh lock, which the other must not remove. Session B is
  // parked at one step of its takeover until session A is installing (or for
  // 5 s), which is that race every time: in its `rm` of the lock, or right
  // after a `find` (with no -exec) has judged the lock stale.
  const park = [
    'park() {',
    '  : > "$GATED_LOCK.parked"',
    '  n=0; while [ ! -e "$GATED_INSTALLS" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done',
    '}',
  ];
  const gates = join(scratch, 'gates');
  for (const [name, body] of /** @type {const} */ ([
    ['rm', ['for last; do :; done', '[ "$last" = "$GATED_LOCK" ] && park', 'exec /bin/rm "$@"']],
    [
      'find',
      [
        'case " $* " in *" -exec "*) exec /usr/bin/find "$@" ;; esac',
        '[ "$1" = "$GATED_LOCK" ] || exec /usr/bin/find "$@"',
        'out="$(/usr/bin/find "$@")"; status=$?',
        '[ -n "$out" ] && { park; printf "%s\\n" "$out"; }',
        'exit "$status"',
      ],
    ],
  ])) {
    mkdirSync(join(gates, name), { recursive: true });
    writeFileSync(join(gates, name, name), ['#!/bin/sh', ...park, ...body, ''].join('\n'), { mode: 0o755 });
  }
  for (const [gate, when] of [
    ['rm', 'the second removing it once the first holds a fresh lock'],
    ['find', 'the second having judged it before the first took it over'],
  ]) {
    test(`two sessions finding one aged lock install once: ${when}`, async () => {
      const dir = project(`died-together-${gate}`);
      const lock = join(dir, 'sarathi-install.lock');
      writeFileSync(lock, '');
      const eleven = Date.now() / 1000 - 11 * 60;
      utimesSync(lock, eleven, eleven);
      const b = startSession(dir, [join(gates, gate), pnpmBin], { GATED_LOCK: lock, GATED_INSTALLS: join(dir, 'installs') });
      for (let n = 0; !existsSync(`${lock}.parked`); n++) {
        assert.ok(n < 200, `session B never reached its ${gate} of the aged lock`);
        await delay(100);
      }
      const a = startSession(dir, [pnpmBin]);
      for (const result of await Promise.all([a, b])) assert.equal(result.code, 0, result.stderr);
      assert.equal(installs(dir), 1);
      assert.equal(existsSync(lock), false);
      assert.equal(existsSync(`${lock}.takeover`), false);
    });
  }

  test('a sarathi that crashes refuses PreToolUse and passes its exit on elsewhere', () => {
    const dir = project('crashing', d => fakeSarathi(join(d, 'node_modules', '@veda-hq', 'sarathi'), '0.5.15', 'process.exit(1)'));
    const refused = hook('PreToolUse', bash('git status'), { project: dir });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /sarathi ended with exit 1/);
    assert.equal(hook('SessionStart', { hook_event_name: 'SessionStart' }, { project: dir }).code, 1);
  });
});
