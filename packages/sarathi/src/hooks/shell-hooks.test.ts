/**
 * sarathi's shell handlers (hooks/*.sh), run as Claude Code runs them: the
 * event on stdin, from the project checkout, about the session's checkout.
 *
 * The desktop app runs a worktree session's hooks with their cwd and
 * $CLAUDE_PROJECT_DIR set to the main checkout, while the input's `cwd`
 * names the worktree. The fixture rebuilds that: a main checkout and a linked
 * worktree under main/.claude/worktrees/.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOKS = fileURLToPath(new URL('../../hooks/', import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'sarathi-shell-hooks-')));
const MAIN = join(TMP, 'main');
const WT = join(MAIN, '.claude', 'worktrees', 'wt');
const BIN = join(TMP, 'bin');
const STUB_LOG = join(TMP, 'stub.log');
after(() => rmSync(TMP, { recursive: true, force: true }));

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'] ?? '',
  HOME: TMP,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(TMP, 'gitconfig'),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

function put(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, mode === undefined ? undefined : { mode });
}

// --- fixture -----------------------------------------------------------------
mkdirSync(MAIN, { recursive: true });
git(MAIN, 'init', '-q', '-b', 'main');
put(join(MAIN, '.gitignore'), 'node_modules\n.claude/worktrees\n');
put(join(MAIN, 'src/main-only.ts'), 'export const m = 1;\n');
git(MAIN, 'add', '-A');
git(MAIN, 'commit', '-qm', 'init');
git(MAIN, 'worktree', 'add', '-q', '-b', 'wt', WT);
put(join(WT, 'src/x.ts'), 'export const x = 1;\n');

/** An executable that records where it ran and with what, then exits <code>. */
function stub(path: string, name: string, code = 0): void {
  put(path, `#!/bin/bash\nprintf '%s|%s|%s\\n' ${name} "$PWD" "$*" >>"$STUB_LOG"\nexit ${code}\n`, 0o755);
}
stub(join(BIN, 'npx'), 'npx');
// The project checkout's prettier, used where the session checkout has none.
stub(join(MAIN, 'node_modules/.bin/prettier'), 'main-prettier');

function stubCalls(): string[] {
  if (!existsSync(STUB_LOG)) return [];
  const lines = readFileSync(STUB_LOG, 'utf8').split('\n').filter(Boolean);
  rmSync(STUB_LOG);
  return lines;
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a handler as the desktop app does: from main, about the worktree. */
function runHook(script: string, input: string | Record<string, unknown>, env: NodeJS.ProcessEnv = {}): Run {
  const result = spawnSync('bash', [script], {
    cwd: MAIN,
    input: typeof input === 'string' ? input : JSON.stringify({ cwd: WT, ...input }),
    encoding: 'utf8',
    env: { ...GIT_ENV, CLAUDE_PROJECT_DIR: MAIN, PATH: `${BIN}:${GIT_ENV['PATH'] ?? ''}`, STUB_LOG, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const hook = (name: string): string => join(HOOKS, name);

// --- lib/session-root.sh -----------------------------------------------------
function sessionRoot(input: string, fallback: string): string {
  const result = spawnSync('bash', ['-c', '. "$1" && session_root "$2" "$3"', 'test', hook('lib/session-root.sh'), input, fallback], {
    cwd: MAIN,
    env: GIT_ENV,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function relToRoot(path: string, root: string): string {
  const result = spawnSync('bash', ['-c', '. "$1" && rel_to_root "$2" "$3"', 'test', hook('lib/session-root.sh'), path, root], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('session_root names the toplevel of the input cwd', () => {
  assert.equal(sessionRoot(JSON.stringify({ cwd: join(WT, 'src') }), MAIN), WT);
});

test('session_root falls back without a usable cwd', () => {
  for (const input of [
    '{}',
    'not json',
    '"a string"',
    JSON.stringify({ cwd: 42 }),
    JSON.stringify({ cwd: join(TMP, 'missing') }),
    JSON.stringify({ cwd: BIN }), // a directory outside any work tree
  ]) {
    assert.equal(sessionRoot(input, '/fallback'), '/fallback', input);
  }
});

test('rel_to_root: inside, at the root, and outside', () => {
  assert.equal(relToRoot(join(WT, 'src/x.ts'), WT), 'src/x.ts');
  assert.equal(relToRoot(join(WT, 'x.ts'), WT), 'x.ts');
  assert.equal(relToRoot(join(MAIN, 'src/main-only.ts'), WT), join(MAIN, 'src/main-only.ts'));
  assert.equal(relToRoot(join(TMP, 'missing/x.ts'), WT), join(TMP, 'missing/x.ts'));
  assert.equal(relToRoot(join(WT, 'src/x.ts'), join(TMP, 'missing')), join(WT, 'src/x.ts'));
});

// --- code-quality-guard.sh ---------------------------------------------------
const quality = hook('code-quality-guard.sh');
// The planted escape hatches are assembled, so this file does not hold them.
const ANY = 'an' + 'y';
const AS_ANY = `const y = x as ${ANY};`;
const TYPED_ANY = `let a: ${ANY};`;

test('code-quality-guard refuses each escape hatch in a TypeScript edit', () => {
  for (const [planted, reason] of [
    [AS_ANY, /'any' type forbidden/],
    [`function f(a: ${ANY}) {}`, /'any' type forbidden/],
    ['// @' + 'ts-ignore', /ts-ignore\/.ts-nocheck forbidden/],
    ['// @' + 'ts-nocheck', /ts-ignore\/.ts-nocheck forbidden/],
    ['// eslint-' + 'disable-next-line', /eslint-.isable forbidden/],
    ['it.' + "skip('a', () => {});", /skipped tests forbidden/],
    ['x' + "it('a', () => {});", /skipped tests forbidden/],
  ] as const) {
    const run = runHook(quality, { tool_name: 'Edit', tool_input: { file_path: join(WT, 'src/x.ts'), new_string: planted } });
    assert.equal(run.status, 2, planted);
    assert.match(run.stderr, /CODE QUALITY VIOLATION/);
    assert.match(run.stderr, reason, planted);
  }
});

test('code-quality-guard judges a Write too, and passes clean code', () => {
  const file_path = join(WT, 'src/w.tsx');
  assert.equal(runHook(quality, { tool_name: 'Write', tool_input: { file_path, content: TYPED_ANY } }).status, 2);
  assert.equal(runHook(quality, { tool_name: 'Write', tool_input: { file_path, content: 'let a: unknown;' } }).status, 0);
  assert.equal(runHook(quality, { tool_name: 'Write', tool_input: { file_path, content: '' } }).status, 0);
});

test('code-quality-guard judges worktree files despite .claude/ in the path', () => {
  // The worktree's absolute path holds main/.claude/worktrees/: still judged.
  const run = runHook(quality, { tool_name: 'Edit', tool_input: { file_path: join(WT, 'src/x.ts'), new_string: AS_ANY } });
  assert.equal(run.status, 2);
});

test("code-quality-guard exempts the checkout's .claude/, .agent/, docs/ and non-TypeScript files", () => {
  for (const rel of ['.claude/scripts/tool.ts', '.agent/tool.ts', 'docs/example.ts', 'src/notes.md']) {
    const file_path = join(WT, rel);
    put(file_path, 'export {};\n');
    const run = runHook(quality, { tool_name: 'Edit', tool_input: { file_path, new_string: AS_ANY } });
    assert.equal(run.status, 0, `${rel}: ${run.stderr}`);
  }
});

test('code-quality-guard judges the project directory without a cwd', () => {
  const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(MAIN, 'src/main-only.ts'), new_string: TYPED_ANY } });
  assert.equal(runHook(quality, input).status, 2);
  assert.equal(runHook(quality, input, { CLAUDE_PROJECT_DIR: '' }).status, 2, 'nor a project directory: the current one');
});

// --- arch-guard.sh -----------------------------------------------------------
const arch = hook('arch-guard.sh');
const IMPORT = "import { a } from './a';";

test('arch-guard runs depcruise in the worktree', () => {
  stubCalls();
  const file = join(WT, 'src/x.ts');
  const run = runHook(arch, { tool_name: 'Edit', tool_input: { file_path: file, new_string: IMPORT } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(stubCalls(), [`npx|${WT}|depcruise --config .dependency-cruiser.js ${file}`]);
});

test('arch-guard refuses what depcruise refuses, with its output', () => {
  stubCalls();
  const failing = join(TMP, 'failing-bin');
  put(join(failing, 'npx'), '#!/bin/bash\necho "error no-domain-to-data: src/x.ts → src/data.ts"\nexit 1\n', 0o755);
  const run = runHook(arch, { tool_name: 'Edit', tool_input: { file_path: join(WT, 'src/x.ts'), new_string: IMPORT } }, {
    PATH: `${failing}:${GIT_ENV['PATH'] ?? ''}`,
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /ARCHITECTURE VIOLATION in .*x\.ts/);
  assert.match(run.stderr, /no-domain-to-data/);
});

test("arch-guard skips the worktree's scripts/, edits without imports, and other files", () => {
  stubCalls();
  const script = join(WT, 'scripts/tool.ts');
  put(script, 'export {};\n');
  for (const tool_input of [
    { file_path: script, new_string: IMPORT },
    { file_path: join(WT, 'src/x.ts'), new_string: 'const z = 1;' },
    { file_path: join(WT, 'src/notes.md'), new_string: IMPORT },
    { file_path: join(WT, 'src/missing.ts'), new_string: IMPORT },
  ]) {
    assert.equal(runHook(arch, { tool_name: 'Edit', tool_input }).status, 0, tool_input.file_path);
  }
  assert.deepEqual(stubCalls(), []);
});

test('arch-guard fails closed when it cannot reach the checkout root', () => {
  // No cwd in the input and a project directory that does not exist.
  const file_path = join(TMP, 'loose', 'x.ts');
  put(file_path, IMPORT + '\n');
  const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path, new_string: IMPORT } });
  const run = runHook(arch, input, { CLAUDE_PROJECT_DIR: join(TMP, 'nonexistent') });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /arch-guard: cannot cd to repo root/);
});

// bash exits on a missing `.` file before any `||` runs, so each handler
// checks its library first: the guards fail closed, the formatter does nothing.
for (const [name, status] of [
  ['code-quality-guard.sh', 2],
  ['arch-guard.sh', 2],
  ['format-on-edit.sh', 0],
] as const) {
  test(`${name} exits ${status} when it cannot load its library`, () => {
    const lone = join(TMP, 'lone', name);
    mkdirSync(dirname(lone), { recursive: true });
    copyFileSync(hook(name), lone);
    const run = runHook(lone, { tool_name: 'Edit', tool_input: { file_path: join(WT, 'src/x.ts'), new_string: IMPORT } });
    assert.equal(run.status, status, run.stderr);
    if (status === 2) assert.match(run.stderr, /cannot load lib\/session-root/);
  });
}

// --- format-on-edit.sh -------------------------------------------------------
const formatOnEdit = hook('format-on-edit.sh');

test("format-on-edit runs the worktree's own prettier, in the worktree", () => {
  stubCalls();
  stub(join(WT, 'node_modules/.bin/prettier'), 'prettier');
  const file = join(WT, 'src/x.ts');
  try {
    const run = runHook(formatOnEdit, { tool_name: 'Edit', tool_input: { file_path: file } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(stubCalls(), [`prettier|${WT}|--write --ignore-unknown ${file}`]);
  } finally {
    rmSync(join(WT, 'node_modules'), { recursive: true, force: true });
  }
});

test("format-on-edit falls back to the project checkout's prettier in a fresh worktree", () => {
  stubCalls();
  const file = join(WT, 'src/x.ts');
  const run = runHook(formatOnEdit, { tool_name: 'Write', tool_input: { file_path: file } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(stubCalls(), [`main-prettier|${WT}|--write --ignore-unknown ${file}`]);
});

test('format-on-edit never blocks, even when prettier fails', () => {
  stubCalls();
  stub(join(WT, 'node_modules/.bin/prettier'), 'prettier', 2);
  try {
    const run = runHook(formatOnEdit, { tool_name: 'Edit', tool_input: { file_path: join(WT, 'src/x.ts') } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(stubCalls().length, 1);
  } finally {
    rmSync(join(WT, 'node_modules'), { recursive: true, force: true });
  }
});

test('format-on-edit leaves alone files outside the session worktree, scratch, links and other types', () => {
  stubCalls();
  const link = join(WT, 'src/link.ts');
  symlinkSync(join(WT, 'src/x.ts'), link);
  put(join(WT, '.tmp/s.ts'), 'a\n');
  put(join(WT, 'src/x.py'), 'a\n');
  for (const file_path of [join(MAIN, 'src/main-only.ts'), link, join(WT, '.tmp/s.ts'), join(WT, 'src/x.py'), join(WT, 'src/none.ts'), '']) {
    assert.equal(runHook(formatOnEdit, { tool_name: 'Edit', tool_input: { file_path } }).status, 0, file_path);
  }
  assert.deepEqual(stubCalls(), []);
});

// --- session-dedupe-guard.sh -------------------------------------------------
const dedupe = hook('session-dedupe-guard.sh');
const CREATE = 'mcp__claude-code-remote__create_session';
const START = 'mcp__ccd_session__start_session';
const LIST = 'mcp__claude-code-remote__list_sessions';

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const call = (minutes: number, name: string, id: string): string =>
  JSON.stringify({ type: 'assistant', timestamp: ago(minutes), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } });
const result = (id: string, isError: boolean): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: '[]' }] } });
const known = JSON.stringify({ type: 'attachment', attachment: { type: 'deferred_tools_record', entries: [{ name: LIST }] } });

let transcripts = 0;
function transcript(...lines: string[]): string {
  const path = join(TMP, 'transcripts', `${transcripts++}.jsonl`);
  put(path, lines.map((l) => `${l}\n`).join(''));
  return path;
}

function dedupeExit(tool: string, path: string): number | null {
  return runHook(dedupe, JSON.stringify({ tool_name: tool, tool_input: { title: 't', prompt: 'p' }, transcript_path: path, cwd: TMP })).status;
}

test('session-dedupe-guard: create_session needs a recent, successful list_sessions', () => {
  assert.equal(dedupeExit(CREATE, transcript()), 2, 'no list_sessions');
  assert.equal(dedupeExit(CREATE, transcript(call(3, LIST, 'a'), result('a', false))), 0, '3 minutes ago');
  assert.equal(dedupeExit(CREATE, transcript(call(40, LIST, 'a'), result('a', false))), 2, '40 minutes ago is too old');
  assert.equal(dedupeExit(CREATE, transcript(call(2, LIST, 'a'), result('a', true))), 2, 'an errored look');
  assert.equal(dedupeExit(CREATE, transcript(call(2, LIST, 'a'))), 2, 'no result yet');
  assert.equal(dedupeExit(CREATE, transcript(call(2, 'mcp__claude-code-remote__list_environments', 'a'), result('a', false))), 2, 'another tool');
});

test('session-dedupe-guard: start_session is judged only where list_sessions is available', () => {
  assert.equal(dedupeExit(START, transcript()), 0, 'no list_sessions known');
  const mention = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `the hook wants ${LIST} first` }] } });
  assert.equal(dedupeExit(START, transcript(mention)), 0, 'only mentioned');
  assert.equal(dedupeExit(START, transcript(call(40, LIST, 'a'), result('a', false))), 2, 'only a stale call');
  assert.equal(dedupeExit(START, transcript(known)), 2, 'available, not called');
  assert.equal(dedupeExit(START, transcript(known, call(1, LIST, 'a'), result('a', false))), 0, 'a fresh look');
});

test('session-dedupe-guard: the refusal names the look to make', () => {
  const run = runHook(dedupe, JSON.stringify({ tool_name: CREATE, transcript_path: transcript() }));
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^BLOCKED: before starting a session, look for one already doing this work: call mcp__claude-code-remote__list_sessions/);
});

test('session-dedupe-guard: anything it cannot read is allowed', () => {
  assert.equal(dedupeExit(LIST, transcript()), 0, 'other tools');
  assert.equal(dedupeExit(CREATE, join(TMP, 'missing.jsonl')), 0, 'an unreadable transcript');
  assert.equal(runHook(dedupe, JSON.stringify({ tool_name: CREATE, tool_input: {} })).status, 0, 'no transcript path');
  assert.equal(runHook(dedupe, 'not json').status, 0, 'malformed input');
  assert.equal(runHook(dedupe, '').status, 0, 'no input');
  const odd = transcript('not json', JSON.stringify({ message: { content: ['text', { type: 'tool_use', name: LIST, id: 'b' }] } }), JSON.stringify({ attachment: { type: 'deferred_tools_record', entries: ['x'] } }));
  assert.equal(dedupeExit(CREATE, odd), 2, 'odd lines are skipped, and a call without a timestamp does not count');
});

test('session-dedupe-guard: a large input is read in full', () => {
  // Above the per-argument limit (128 KiB on Linux) that an environment variable would hit.
  const big = JSON.stringify({ tool_name: CREATE, tool_input: { prompt: 'p'.repeat(300_000) }, transcript_path: transcript(known, call(1, LIST, 'a'), result('a', false)) });
  assert.equal(runHook(dedupe, big).status, 0);
});

test('session-dedupe-guard: runs the launcher interpreter when it names one', () => {
  const python = join(TMP, 'python-stub');
  put(python, '#!/bin/bash\necho "stub python" >&2\nexit 7\n', 0o755);
  assert.equal(runHook(dedupe, '{}', { HOOK_PYTHON: python }).status, 7);
});
