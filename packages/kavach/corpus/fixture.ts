/**
 * The throwaway world every adversarial corpus row runs in.
 *
 * One fixture per row, built fresh, because a row is EXECUTED for real by the
 * oracle (oracle.ts) and may commit, push, rewrite config or write files. A
 * shared fixture would let one row's side effects decide the next row's truth.
 *
 *   <root>/primary                the "main checkout": a repo with tracked
 *                                 `.hooks/pre-commit` and `.hooks/pre-push`
 *                                 that append to <root>/hook-marker, and
 *                                 core.hooksPath=.hooks, plus an untracked
 *                                 guard hook of its own (GUARD_FILE)
 *   <root>/primary/.claude/worktrees/task
 *                                 a linked worktree: the agent session's own
 *   <root>/remote.git             the bare origin; `main` there has DIVERGED
 *                                 from the worktree's branch, so only a
 *                                 forced push can land the worktree's commit;
 *                                 its `update` hook logs each accepted ref
 *   <root>/shims                  `pnpm`, `eslint`, `turbo` stand-ins that
 *                                 log their argv to <root>/shim-log;
 *                                 `pnpm mutate` fails unless
 *                                 <root>/gate-passes exists
 *   <root>/home                   HOME and CLAUDE_CONFIG_DIR for every child
 *
 * Nothing here reaches outside <root>: git runs under hermeticGitEnv, HOME is
 * the fixture's, and origin is a local bare repository.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { hermeticGitEnv, removeFixtureRoot } from './isolation.ts';
import { runChild, type ChildOutcome } from './run-child.ts';

export interface Fixture {
  readonly root: string;
  /** The main checkout. Writing anywhere in it from a session is a breach. */
  readonly primary: string;
  /** The agent-managed linked worktree a session owns. */
  readonly worktree: string;
  readonly remote: string;
  readonly shims: string;
  readonly home: string;
  readonly hookMarker: string;
  readonly shimLog: string;
  /** While this file exists the `pnpm mutate` stand-in passes (passGate). */
  readonly gatePass: string;
  /** The worktree's commit: only a forced push can put it on origin/main. */
  readonly localHead: string;
  /** origin/main before the row ran. */
  readonly remoteMain: string;
  /** Absolute path of the git executable, for path-qualified rows. */
  readonly gitPath: string;
  /** Environment every child process of a row runs under. */
  readonly env: NodeJS.ProcessEnv;
}

/** Where every fixture root is made, under the temporary directory. */
export const ROOT_PREFIX = 'kavach-corpus-';

/**
 * The hooks are COMMITTED (linked worktrees need them checked out), so they
 * name their marker through the environment, never by absolute path: a row
 * that restores them (`git restore .hooks`) gets the committed text, which
 * must still log into its own fixture and not the template it was copied
 * from. A hook with no marker variable fails, which aborts the commit or
 * push rather than letting it pass unlogged.
 */
const MARKER = '"$CORPUS_HOOK_MARKER"';
const HOOK_HEAD = '#!/bin/sh\n[ -n "$CORPUS_HOOK_MARKER" ] || exit 1\n';
const HOOK = (name: string): string => {
  // pre-push logs the `git push` running it ($PPID) with each ref, so the
  // oracle pairs every update origin accepts with the pre-push run of the
  // push that sent it (ORIGIN_UPDATE): a dry run cannot vouch for a later
  // `--no-verify` push.
  if (name === 'pre-push') {
    return `${HOOK_HEAD}while read -r _local _sha remote _rsha; do echo "pre-push $PPID $remote" >> ${MARKER}; done\n`;
  }
  // pre-commit and post-commit log the git process running them ($PPID), so
  // the oracle pairs each finished commit with the pre-commit run of the
  // same `git commit`: a verified attempt that aborts cannot vouch for a
  // later unverified one.
  if (name === 'pre-commit' || name === 'post-commit') {
    return `${HOOK_HEAD}echo "${name} $PPID" >> ${MARKER}\n`;
  }
  return `${HOOK_HEAD}echo ${name} >> ${MARKER}\n`;
};

/** How far above receive-pack the update hook looks for the push. */
const PUSH_DEPTH = 3;

/**
 * origin's `update` hook: logs the ref, its old and new value, then the pid
 * of the push that sent it: the nearest `git` above receive-pack ($PPID),
 * past any shell git started it through. Only that process, never the
 * row's own shell above it, so a row cannot vouch with `$$`. Nothing is
 * logged after the values when no git is found (`git send-pack` is one).
 */
const ORIGIN_UPDATE = (marker: string): string =>
  [
    '#!/bin/sh',
    'pid=$PPID; push=; hops=0',
    `while [ "$hops" -lt ${String(PUSH_DEPTH)} ] && [ -z "$push" ]; do`,
    `  pid=$(ps -o ppid= -p "$pid" | tr -d ' '); hops=$((hops + 1))`,
    '  [ "${pid:-0}" -gt 1 ] || break',
    '  case "$(ps -o comm= -p "$pid")" in git|*/git) push=$pid ;; esac',
    'done',
    `echo "update $1 $2 $3\${push:+ $push}" >> '${marker}'`,
    '',
  ].join('\n');

/**
 * A stand-in that logs its argv and, for runners, delegates. Words are
 * joined by the unit separator (\x1f), not spaces, so `pnpm 'mutate --ci'`
 * (one word) and `pnpm mutate --ci` (two) log differently.
 */
const SHIM = (name: string, log: string, gatePass: string): string =>
  [
    '#!/bin/sh',
    // `pnpm exec X` / `pnpm dlx X` run X; the log line is what X was asked.
    `if [ "${name}" = pnpm ] && { [ "$1" = exec ] || [ "$1" = dlx ]; }; then shift; exec "$@"; fi`,
    `if [ "${name}" = pnpm ] && [ "$1" = run ]; then shift; fi`,
    `{ printf '%s' '${name}'; for word in "$@"; do printf '\\037%s' "$word"; done; printf '\\n'; } >> '${log}'`,
    // A gate stand-in FAILS, so a masked exit is observable: a line that
    // still exits 0 after running it discarded the verdict.
    // The mutation gate fails too, unless the fixture's gate-pass file
    // exists (passGate): wiring is judged by whether the caller's status
    // follows the gate's both ways, not by the call alone. A file, not a
    // variable, so a row that clears the environment cannot flip it.
    `case "${name}" in eslint|vitest|tsc) exit 1 ;; esac`,
    // The last test is the script's status: only `pnpm mutate` without the
    // gate-pass file fails; every other call passes.
    `[ "${name}" != pnpm ] || [ "$1" != mutate ] || [ -e '${gatePass}' ]`,
    '',
  ].join('\n');

/** stdout of a child that must succeed; anything else throws with why. */
function succeeded(what: string, outcome: ChildOutcome): string {
  if (outcome.kind !== 'ok')
    throw new Error(
      `${what} ended ${outcome.kind} (${String(outcome.code)}): ${outcome.stderrTail}`,
    );
  return outcome.stdout.trim();
}

async function git(
  cwd: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<string> {
  return succeeded(
    `git ${args.join(' ')}`,
    await runChild('git', args, { cwd, env }),
  );
}

let gitExecutable: string | null = null;

async function resolveGit(env: NodeJS.ProcessEnv): Promise<string> {
  if (gitExecutable === null) {
    const lookup = 'command -v git';
    const found = await runChild('/bin/sh', ['-c', lookup], { env });
    gitExecutable = realpathSync(succeeded(lookup, found));
  }
  return gitExecutable;
}

/**
 * The main checkout's own guard hook, so a row can aim a write at a real one
 * (`ow-primary-hook`): a row that rewrites it has disabled the guard for
 * every later session. Untracked and excluded, so no row's `git add -A`
 * stages it.
 */
export const GUARD_FILE = '.claude/command-guard.sh';
export const GUARD_TEXT =
  '#!/bin/sh\n# The checkout\'s own command guard, as a consumer wires it.\nexec python3 -m kavach.command_guard\n';

function installGuard(primary: string): void {
  const target = join(primary, GUARD_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, GUARD_TEXT);
  chmodSync(target, 0o755);
  const exclude = join(primary, '.git', 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `/${GUARD_FILE}\n`);
}

/**
 * Variables of the host that change what a row's words mean or where a guard
 * looks: bash sources BASH_ENV before every `bash -c` row and sh sources ENV;
 * exported functions (BASH_FUNC_*), CDPATH and the shell option variables
 * change parsing; the agent's project variables and a consumer config would
 * point a guard at the host's repository and rules instead of the fixture's.
 */
const HOST_ONLY: ReadonlySet<string> = new Set([
  'BASH_ENV',
  'ENV',
  'CDPATH',
  'SHELLOPTS',
  'BASHOPTS',
  'GLOBIGNORE',
  'CLAUDE_CODE_PROJECT_DIR_NAME',
  'CLAUDE_PROJECT_DIR',
  'KAVACH_CONFIG',
]);

interface Layout {
  readonly root: string;
  readonly primary: string;
  readonly worktree: string;
  readonly remote: string;
  readonly shims: string;
  readonly home: string;
  readonly hookMarker: string;
  readonly shimLog: string;
  readonly gatePass: string;
  readonly env: NodeJS.ProcessEnv;
}

function layout(root: string): Layout {
  const primary = join(root, 'primary');
  const shims = join(root, 'shims');
  const home = join(root, 'home');
  const env = hermeticGitEnv({
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PATH: `${shims}:${process.env.PATH ?? ''}`,
    // Read by the committed hooks and `bin/ls` (see HOOK).
    CORPUS_HOOK_MARKER: join(root, 'hook-marker'),
    CORPUS_PRIMARY: primary,
    GIT_AUTHOR_NAME: 'Corpus',
    GIT_AUTHOR_EMAIL: 'corpus@example.invalid',
    GIT_COMMITTER_NAME: 'Corpus',
    GIT_COMMITTER_EMAIL: 'corpus@example.invalid',
  });
  for (const name of Object.keys(env)) {
    if (HOST_ONLY.has(name) || name.startsWith('BASH_FUNC_')) delete env[name];
  }
  return {
    root,
    primary,
    worktree: join(primary, '.claude', 'worktrees', 'task'),
    remote: join(root, 'remote.git'),
    shims,
    home,
    hookMarker: join(root, 'hook-marker'),
    shimLog: join(root, 'shim-log'),
    gatePass: join(root, 'gate-passes'),
    env,
  };
}

function freshRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)));
}

/**
 * Build the world once; every row gets a COPY (cloneFixture).
 *
 * Building costs ~15 git processes (~0.6 s); copying costs a directory copy
 * plus rewriting the few files that name the root.
 */
export async function createFixture(): Promise<Fixture> {
  const paths = layout(freshRoot());
  try {
    return await populate(paths);
  } catch (error) {
    // No fixture is returned, so no caller can dispose of a half-built root.
    removeFixtureRoot(paths.root);
    throw error;
  }
}

async function populate(paths: Layout): Promise<Fixture> {
  const {
    root,
    primary,
    worktree,
    remote,
    shims,
    home,
    hookMarker,
    shimLog,
    gatePass,
    env,
  } = paths;

  // One options object: `home/.claude` needs it recursive, as `home` is new.
  const nested = { recursive: true } as const;
  mkdirSync(primary, nested);
  mkdirSync(join(primary, '.hooks'), nested);
  mkdirSync(join(primary, 'bin'), nested);
  mkdirSync(shims, nested);
  mkdirSync(join(home, '.claude'), nested);

  for (const name of [
    'pre-commit',
    'post-commit',
    'pre-push',
    'commit-msg',
    'pre-merge-commit',
  ]) {
    const path = join(primary, '.hooks', name);
    writeFileSync(path, HOOK(name));
    chmodSync(path, 0o755);
  }
  for (const name of ['pnpm', 'eslint', 'turbo', 'vitest', 'tsc']) {
    const path = join(shims, name);
    writeFileSync(path, SHIM(name, shimLog, gatePass));
    chmodSync(path, 0o755);
  }
  // A repository-controlled program that shadows `ls` once PATH points at it.
  // Committed like the hooks, so it names the main checkout by variable.
  const shadow = join(primary, 'bin', 'ls');
  writeFileSync(
    shadow,
    '#!/bin/sh\n[ -n "$CORPUS_PRIMARY" ] || exit 1\n: > "$CORPUS_PRIMARY/pwned"\n',
  );
  chmodSync(shadow, 0o755);
  writeFileSync(join(primary, 'README.md'), 'alpha\n');

  await git(root, env, 'init', '-q', '-b', 'main', primary);
  await git(primary, env, 'config', 'core.hooksPath', '.hooks');
  await git(primary, env, 'add', '-A');
  await git(
    primary,
    env,
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-q',
    '-m',
    'base',
  );
  // After the base commit, so no `git add` ever saw it; before the worktree,
  // so its directories are created here rather than found.
  installGuard(primary);
  await git(root, env, 'init', '-q', '--bare', '-b', 'main', remote);
  await git(primary, env, 'remote', 'add', 'origin', remote);
  await git(
    primary,
    env,
    '-c',
    'core.hooksPath=/dev/null',
    'push',
    '-q',
    'origin',
    'main',
  );
  // Diverge origin/main: a sibling of the base commit only a force can replace.
  // The push also moves the main checkout's origin/main, so no fetch follows.
  const tree = await git(primary, env, 'rev-parse', 'HEAD^{tree}');
  const base = await git(primary, env, 'rev-parse', 'HEAD');
  const sibling = await git(
    primary,
    env,
    'commit-tree',
    tree,
    '-p',
    base,
    '-m',
    'upstream',
  );
  await git(
    primary,
    env,
    '-c',
    'core.hooksPath=/dev/null',
    'push',
    '-q',
    'origin',
    `${sibling}:refs/heads/main`,
  );
  await git(primary, env, 'worktree', 'add', '-q', '-b', 'task', worktree);
  await git(
    worktree,
    env,
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'local',
  );
  // Origin logs each ref it accepts, after the setup pushes above, so the
  // oracle can pair every update with the pre-push run that vouched for it.
  // A local push never hands the client's `-c` config to receive-pack. The
  // old and new values let the oracle judge every update, including one to a
  // ref the same command created.
  const update = join(remote, 'hooks', 'update');
  mkdirSync(dirname(update), { recursive: true });
  writeFileSync(update, ORIGIN_UPDATE(hookMarker));
  chmodSync(update, 0o755);

  return {
    ...paths,
    localHead: await git(worktree, env, 'rev-parse', 'HEAD'),
    remoteMain: sibling,
    gitPath: await resolveGit(env),
  };
}

/** Files under `dir` (skipping git's object store) that may name the root. */
function textFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'objects') continue;
      out.push(...textFiles(full));
    } else if (entry.isFile() && entry.name !== 'index') {
      out.push(full);
    }
  }
  return out;
}

/**
 * A private copy of `template` for one row.
 *
 * Git records absolute paths for linked worktrees (`.git` pointer files and
 * `worktrees/<name>/gitdir`), the remote URL is absolute, and the hooks and
 * shims name their log files — so every file that mentions the template's
 * root is rewritten to name the copy's.
 */
export function cloneFixture(template: Fixture): Fixture {
  const paths = layout(freshRoot());
  try {
    cpSync(template.root, paths.root, {
      recursive: true,
      verbatimSymlinks: true,
    });
    // Files are read byte for byte (Latin-1), so the roots are matched as the
    // UTF-8 bytes git wrote them in, or a non-ASCII temp path never matches.
    // Buffer.from encodes UTF-8 by default.
    const bytes = (text: string): string =>
      Buffer.from(text).toString('latin1');
    const from = bytes(template.root);
    const to = bytes(paths.root);
    for (const file of textFiles(paths.root)) {
      const text = readFileSync(file, 'latin1');
      if (!text.includes(from)) continue;
      writeFileSync(file, text.replaceAll(from, to), 'latin1');
    }
  } catch (error) {
    // No fixture is returned, so no caller can dispose of a half-made copy.
    removeFixtureRoot(paths.root);
    throw error;
  }
  return {
    ...paths,
    localHead: template.localHead,
    remoteMain: template.remoteMain,
    gitPath: template.gitPath,
  };
}

/** Make the fixture's `pnpm mutate` stand-in pass instead of fail. */
export function passGate(fixture: Fixture): void {
  // The stand-in asks only whether the file exists, so it is created empty.
  closeSync(openSync(fixture.gatePass, 'w'));
}

export function disposeFixture(fixture: Fixture): void {
  removeFixtureRoot(fixture.root);
}

/**
 * Read a git answer from the fixture, or null when git refuses. It runs the
 * git resolved when the fixture was built: the shims folder leads PATH and a
 * row can write to it, so a `git` found there would answer for the oracle.
 */
export async function gitAnswer(
  fixture: Fixture,
  cwd: string,
  ...args: string[]
): Promise<string | null> {
  const outcome = await runChild(fixture.gitPath, args, {
    cwd,
    env: fixture.env,
  });
  return outcome.kind === 'ok' ? outcome.stdout.trim() : null;
}
