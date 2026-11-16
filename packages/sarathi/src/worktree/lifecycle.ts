/**
 * `sarathi worktree`: the current worktree's lifecycle. It never allocates a
 * session or removes files.
 *
 * `status` and `archive-check` only read. `begin` and `retire` need an idle,
 * provider-owned linked worktree (Codex's or Claude Code's). GitHub is the
 * merge authority: a missing branch or upstream is never merge evidence.
 *
 * - `begin --branch <provider>/<name>`: a new branch from fresh origin/main,
 *   in this worktree, refused over uncommitted work or unmerged commits.
 * - `retire --pr <n>`: after the pull request merged, the branch goes and the
 *   worktree stays, detached at the merged tip (or on a successor branch when
 *   commits came after the merge). A recovery ref keeps the tip.
 * - `archive-check`: may this worktree be removed? Every blocker is listed.
 *
 * The receipt (`<name>-lifecycle.json` in the worktree's git dir) records the
 * phase; `name` comes from the project's settings so that a project's other
 * tools can read it.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { readSettings, type WorktreeSettings } from './settings.ts';

/** A safety precondition could not be established. */
export class Blocked extends Error {
  override readonly name = 'Blocked';
}

/** What the lifecycle touches outside itself, so a test can stand in GitHub. */
export interface Host {
  /** Runs a program; its trimmed-right stdout, or Blocked on any failure. */
  readonly run: (cwd: string, file: string, args: readonly string[]) => string;
  /** Is this a cloud session (the project's cloud check passes)? */
  readonly cloudSession: (root: string) => boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type Provider = 'codex' | 'claude';

export interface Context {
  readonly root: string;
  readonly gitdir: string;
  readonly provider: Provider;
  readonly settings: WorktreeSettings;
  readonly host: Host;
}

export type Receipt = Record<string, unknown>;

const SHA = /^[0-9a-f]{40,64}$/;
const PROTECTED = new Set(['main', 'master', 'prod', 'staging']);

/** Runs `file` with git's optional locks off; never echoes its output, which may hold secrets. */
export function runProgram(cwd: string, file: string, args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): string {
  try {
    return execFileSync(file, [...args], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    throw new Blocked(`${file} ${args[0] ?? ''} failed (exit ${status ?? 'none'}); nothing may be discarded`);
  }
}

/** `git` through the host, without its trailing newline. */
export function git(context: Pick<Context, 'host'>, cwd: string, ...args: string[]): string {
  return context.host.run(cwd, 'git', args).replace(/\n+$/, '');
}

/** Is `older` an ancestor of `newer`? Blocked when git cannot say. */
export function ancestor(root: string, older: string, newer: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: root, stdio: 'ignore', timeout: 30_000, env: { ...env } });
    return true;
  } catch (error) {
    if ((error as { status?: number | null }).status === 1) return false;
    throw new Blocked('merge evidence is unavailable locally');
  }
}

/** The project's cloud check, run as `bash <check> <root>`, decides; without one, the flag alone. */
export function cloudSessionWith(settings: WorktreeSettings, env: Readonly<Record<string, string | undefined>>): (root: string) => boolean {
  return root => {
    if (env.CLAUDE_CODE_REMOTE !== 'true') return false;
    if (settings.cloudCheck === undefined) return true;
    try {
      execFileSync('bash', [settings.cloudCheck, root], { cwd: root, stdio: 'ignore', timeout: 30_000, env: { ...env } });
      return true;
    } catch {
      // fail-open: a check that fails or cannot run says "not a cloud session", the laptop route.
      return false;
    }
  };
}

export function nodeHost(settings: WorktreeSettings, env: Readonly<Record<string, string | undefined>> = process.env): Host {
  return { run: (cwd, file, args) => runProgram(cwd, file, args, env), cloudSession: cloudSessionWith(settings, env), env };
}

/** Is `path` `folder` or inside it? */
export function within(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The path with every link resolved, as far as it exists (Python's `Path.resolve()`). */
export function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // fail-open: a path that does not exist yet resolves as written.
    return resolve(path);
  }
}

/** This worktree, its git dir and its provider; Blocked in a primary checkout or a foreign worktree. */
export function context(cwd: string, host: Host, settings?: WorktreeSettings): Context {
  const probe = { host };
  const root = real(git(probe, cwd, 'rev-parse', '--show-toplevel'));
  const gitdir = real(git(probe, root, 'rev-parse', '--absolute-git-dir'));
  const common = real(git(probe, root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  if (gitdir === common) throw new Blocked('primary checkout: continue read-only; allocate through the provider in the SAME chat');
  const codexHome = host.env.CODEX_HOME ?? join(host.env.HOME ?? '', '.codex');
  const managed = real(host.env.CODEX_MANAGED_WORKTREE_ROOT ?? join(codexHome, 'worktrees'));
  const listing = git(probe, root, 'worktree', 'list', '--porcelain', '-z').split('\0');
  const first = listing.find(item => item.startsWith('worktree '));
  if (first === undefined) throw new Blocked('git lists no worktrees');
  const primary = real(first.slice('worktree '.length));
  let provider: Provider;
  if (within(root, managed)) provider = 'codex';
  else if (within(root, join(primary, '.claude', 'worktrees'))) provider = 'claude';
  else throw new Blocked('worktree is outside the Codex/Claude managed roots');
  return { root, gitdir, provider, settings: settings ?? readSettings(root), host };
}

export function currentBranch(context: Context): string {
  return git(context, context.root, 'rev-parse', '--abbrev-ref', 'HEAD');
}

const OPERATIONS = ['index.lock', 'HEAD.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];

/** Git operations under way in the git dir. */
export function operations(gitdir: string): string[] {
  return OPERATIONS.filter(name => existsSync(join(gitdir, name)));
}

const receiptPath = (context: Pick<Context, 'gitdir' | 'settings'>): string => join(context.gitdir, `${context.settings.name}-lifecycle.json`);

export function readReceipt(context: Pick<Context, 'gitdir' | 'settings'>): Receipt {
  const path = receiptPath(context);
  if (!existsSync(path)) return {};
  try {
    const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof state !== 'object' || state === null || Array.isArray(state) || (state as Receipt).version !== 1) throw new Error('shape');
    return state as Receipt;
  } catch {
    throw new Blocked('lifecycle receipt is unreadable; retain the worktree');
  }
}

export function writeReceipt(context: Pick<Context, 'gitdir' | 'settings'>, state: Receipt): void {
  const target = receiptPath(context);
  const temporary = join(context.gitdir, `${context.settings.name}-lifecycle-${randomUUID().replaceAll('-', '')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ ...state, version: 1 }, null, 2)}\n`);
  renameSync(temporary, target);
}

/**
 * False when the receipt was written for another checkout: begin leaves the
 * worktree on its branch, retire detached or on its successor. A new
 * conversation reusing a retired worktree starts on a branch the app made, so
 * the previous conversation's receipt no longer describes it.
 */
export function receiptIsCurrent(state: Receipt, current: string): boolean {
  const phase = state.phase;
  if (phase === 'retired') return current === 'HEAD';
  if (phase === 'active' || phase === 'continued') return state.branch === current;
  return true;
}

/**
 * The branch this conversation's worktree started on, kept across begin and
 * retire: a desktop-app cloud start clones it, not the current branch. A
 * receipt written for another checkout is ignored. `null` when unknowable: an
 * older receipt that never recorded it, or a detached HEAD with no receipt.
 */
export function launchBranch(state: Receipt, current: string): string | null {
  const own = Object.keys(state).length > 0 && !receiptIsCurrent(state, current) ? {} : state;
  if (Object.hasOwn(own, 'launchBranch')) return (own.launchBranch as string | null | undefined) ?? null;
  if (Object.keys(own).length > 0 || current === 'HEAD') return null;
  return current;
}

/** Exactly what husky 9 writes into `.husky/_` on every install. */
const HUSKY_SHIMS = new Set([
  '.gitignore', 'h', 'husky.sh', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-rebase', 'post-rewrite', 'post-checkout', 'post-merge',
  'pre-push', 'pre-auto-gc',
]);

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    // fail-open: what cannot be read is not a husky shim, so it blocks archive.
    return false;
  }
};

/**
 * The shim dir ignores itself with `*`, so anything else placed there is
 * invisible to git. Only husky's own files are reproducible; a bare `_`
 * elsewhere, or a sibling such as `.husky/_notes`, is not matched at all.
 */
export function huskyShim(root: string, parts: readonly string[]): boolean {
  const shims = join(root, '.husky', '_');
  if (parts[0] !== '.husky' || parts[1] !== '_') return false;
  let stat;
  try {
    stat = lstatSync(shims);
  } catch {
    // fail-open: no shim folder, so nothing is a shim, and the file blocks archive.
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  if (parts.length === 2) return readdirSync(shims).every(name => HUSKY_SHIMS.has(name) && isFile(join(shims, name)));
  const name = parts[2];
  return parts.length === 3 && name !== undefined && HUSKY_SHIMS.has(name) && isFile(join(shims, name));
}

const DISPOSABLE = new Set(['node_modules', '.turbo', '.cache', '__pycache__']);

/**
 * Every hook's Node run recreates this cache (sarathi's launcher sets
 * NODE_COMPILE_CACHE there), so it is as reproducible as node_modules. Holding
 * archive on it meant a discard of .tmp had to be the very last call, before
 * the next hook wrote it again. The rest of .tmp is listed child by child and
 * still needs the owner's discard. Only Node's own layout counts (a
 * `v<version>-…` folder of 8-hex-digit files, no symlinks); anything else in
 * the folder holds it like any other .tmp entry.
 */
const COMPILE_CACHE = ['.tmp', 'node-compile-cache'] as const;
const CACHE_FOLDER = /^v\d+\.\d+\.\d+-[\w.-]+$/;
const CACHE_FILE = /^[0-9a-f]{8}$/;

/** True for the hooks' compile cache when it holds only Node's files. */
export function compileCache(root: string, parts: readonly string[]): boolean {
  if (parts.length !== 2 || parts[0] !== COMPILE_CACHE[0] || parts[1] !== COMPILE_CACHE[1]) return false;
  const cache = join(root, ...COMPILE_CACHE);
  try {
    if (!lstatSync(cache).isDirectory()) return false;
    for (const folder of readdirSync(cache)) {
      if (!CACHE_FOLDER.test(folder) || !lstatSync(join(cache, folder)).isDirectory()) return false;
      for (const entry of readdirSync(join(cache, folder))) {
        if (!CACHE_FILE.test(entry) || !lstatSync(join(cache, folder, entry)).isFile()) return false;
      }
    }
  } catch {
    // fail-open: a cache that cannot be read is not disposable, so it is held like any .tmp entry and archive stays blocked.
    return false;
  }
  return true;
}

/**
 * git reports an ignored .tmp whole; list what it holds, one entry per child,
 * so the hooks' cache can be told apart from a session's files.
 */
export function tmpChildren(root: string, item: string): string[] {
  if (item.replace(/\/+$/, '') !== '.tmp') return [item];
  const tmp = join(root, '.tmp');
  try {
    if (!lstatSync(tmp).isDirectory()) return [item];
    return readdirSync(tmp, { withFileTypes: true })
      .map(child => `.tmp/${child.name}${child.isDirectory() ? '/' : ''}`)
      .sort();
  } catch {
    // fail-open: a .tmp that cannot be listed is held whole, so archive stays blocked.
    return [item];
  }
}

/** A link to something outside the worktree: removing the worktree removes the link, not the target. */
function sharedLink(root: string, path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && existsSync(path) && !within(realpathSync(path), root);
  } catch {
    // fail-open: a link that cannot be followed is kept as an artifact, so it blocks archive.
    return false;
  }
}

/**
 * Ignored files that would be lost with the worktree. Only reproducible caches
 * are disposable; unknown ignored files (plans, local credentials, databases,
 * reports) block archive.
 */
export function ignoredArtifacts(context: Context): string[] {
  const listing = git(context, context.root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z');
  const retained: string[] = [];
  for (const item of listing.split('\0').filter(Boolean).flatMap(entry => tmpChildren(context.root, entry))) {
    const path = join(context.root, item.replace(/\/+$/, ''));
    if (sharedLink(context.root, path)) continue;
    const parts = item.replace(/\/+$/, '').split('/');
    if (parts.some(part => DISPOSABLE.has(part)) || huskyShim(context.root, parts) || compileCache(context.root, parts)) continue;
    retained.push(item);
  }
  return retained;
}

export interface Report {
  readonly worktree: string;
  readonly provider: Provider;
  readonly branch: string;
  readonly head: string;
  readonly changes: string;
  readonly ignoredArtifacts: string[];
  readonly blockers: string[];
  readonly archiveReady: boolean;
  readonly appLimitations: string[];
  readonly next?: string;
}

const IGNORED_BLOCKER = 'ignored artifacts need preservation or explicit discard';
export const UNMERGED = 'HEAD contains work not proven merged into origin/main';
/** Commits made before `begin` are the usual cause; the way out is to set them aside, begin, and bring them back. */
export const BEGIN_RECOVERY =
  "if this branch's PR merged, run retire --pr <N> first, then begin; " +
  'to keep commits made before begin, first commit any uncommitted work ' +
  '(git reset --hard discards it), then: git branch <save-branch> HEAD, ' +
  'git reset --hard origin/main, begin again, then ' +
  'git cherry-pick origin/main..<save-branch> and re-point any citation to the new shas';
const CLOUD_ARCHIVE = 'this session in the app; its container takes this worktree.';

/**
 * A cloud session's container goes when the session is archived, worktree
 * included, so archiving the session is the removal. Only merged, committed
 * work qualifies; scratch files need the owner's discard first.
 */
export function cloudArchiveStep(owner: string, blockers: readonly string[], artifacts: readonly string[]): string | undefined {
  if (blockers.length === 0) return `Archive ${CLOUD_ARCHIVE}`;
  if (blockers.length === 1 && blockers[0] === IGNORED_BLOCKER) {
    return `First get ${owner}'s explicit OK to discard: ${artifacts.join(', ')}. Then archive ${CLOUD_ARCHIVE}`;
  }
  return undefined;
}

/** Everything that keeps this worktree from being removed; reads only. */
export function inspect(context: Context): Report {
  const { root, gitdir } = context;
  const head = git(context, root, 'rev-parse', 'HEAD');
  const current = currentBranch(context);
  const blockers: string[] = [];
  const changes = git(context, root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none');
  if (changes !== '') blockers.push('staged, unstaged or untracked files remain');
  const pending = operations(gitdir);
  if (pending.length > 0) blockers.push(`Git operation in progress: ${pending.join(', ')}`);
  const artifacts = ignoredArtifacts(context);
  if (artifacts.length > 0) blockers.push(IGNORED_BLOCKER);
  const state = readReceipt(context);
  let included = ancestor(root, head, 'refs/remotes/origin/main', context.host.env);
  // Squash merges do not make the original tip an ancestor of main. Only an
  // exact receipt for the retained HEAD can supply the missing merge proof.
  if (!included && state.retiredHead === head) {
    const merged = state.mergeCommit;
    if (typeof merged === 'string' && SHA.test(merged)) included = ancestor(root, merged, 'refs/remotes/origin/main', context.host.env);
  }
  if (!included) blockers.push(UNMERGED);
  if (PROTECTED.has(current)) blockers.push('protected branch checked out');
  const step = cloudArchiveStep(context.settings.owner, blockers, artifacts);
  const next = step !== undefined && context.host.cloudSession(root) ? step : undefined;
  return {
    worktree: root,
    provider: context.provider,
    branch: current,
    head,
    changes,
    ignoredArtifacts: artifacts,
    blockers,
    archiveReady: blockers.length === 0,
    appLimitations: ['direct UI archive cannot be vetoed by repository hooks', 'Codex self-handoff and fresh worktree rebinding require host support'],
    ...(next === undefined ? {} : { next }),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // fail-open: only ESRCH proves no such process; EPERM and the rest count as alive.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * One lifecycle operation at a time per worktree: a lock folder holding the
 * holder's pid. A lock whose holder died is taken over; a live one blocks.
 */
export function exclusive<T>(gitdir: string, name: string, body: () => T, alive: (pid: number) => boolean = pidAlive): T {
  const lock = join(gitdir, `${name}-lifecycle.mutex`);
  const owner = join(lock, 'pid');
  const take = (): boolean => {
    try {
      mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    writeFileSync(owner, String(process.pid));
    return true;
  };
  if (!take()) {
    let holder = Number.NaN;
    try {
      holder = Number(readFileSync(owner, 'utf8'));
    } catch {
      // fail-open: between its mkdir and writing its pid, a live holder; the check below blocks.
    }
    if (!(Number.isInteger(holder) && holder > 0 && !alive(holder))) throw new Blocked('another lifecycle operation is running');
    rmSync(lock, { recursive: true, force: true });
    if (!take()) throw new Blocked('another lifecycle operation is running');
  }
  try {
    return body();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** A new branch name: the provider's prefix, a legal ref, not yet a branch. */
export function validBranch(context: Context, name: string): void {
  if (!name.startsWith(`${context.provider}/`)) throw new Blocked(`new branch must use the ${context.provider}/ prefix`);
  git(context, context.root, 'check-ref-format', '--branch', name);
  let code: number | null | undefined = 0;
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: context.root, stdio: 'ignore', env: { ...context.host.env } });
  } catch (error) {
    // fail-open: the exit code is the answer; anything but 1 (no such branch) blocks below.
    code = (error as { status?: number | null }).status;
  }
  if (code !== 1) throw new Blocked('successor branch already exists or cannot be checked');
}

export function begin(context: Context, name: string): Record<string, unknown> {
  validBranch(context, name);
  git(context, context.root, 'fetch', 'origin', 'main');
  const status = inspect(context);
  // Existing ignored files can stay: --no-overwrite-ignore protects collisions.
  const blockers = status.blockers.filter(blocker => !blocker.startsWith('ignored artifacts'));
  if (blockers.includes(UNMERGED)) blockers.push(BEGIN_RECOVERY);
  if (blockers.length > 0) throw new Blocked(blockers.join('; '));
  const launch = launchBranch(readReceipt(context), status.branch);
  git(context, context.root, 'switch', '--no-overwrite-ignore', '--no-track', '-c', name, 'refs/remotes/origin/main');
  writeReceipt(context, { phase: 'active', branch: name, base: git(context, context.root, 'rev-parse', 'HEAD'), launchBranch: launch });
  return { branch: name, worktree: context.root, phase: 'active' };
}

/**
 * GET a GitHub REST route through the cloud's proxy, which authenticates it:
 * `gh` refuses to send any request while it has no token of its own, and a
 * cloud session has none. The proxy supplies the credential to a plain HTTPS
 * request, so curl reads it.
 */
export function restRead(context: Context, host: string, route: string): string {
  if (host !== 'github.com') throw new Blocked('a cloud session reads merge evidence from github.com only; nothing may be discarded');
  // --fail turns an HTTP error into a non-zero exit, which run() blocks on;
  // --proto keeps the request on HTTPS whatever a redirect says.
  return context.host.run(context.root, 'curl', [
    '--silent', '--show-error', '--fail', '--proto', '=https', '--max-time', '60',
    '--header', 'Accept: application/vnd.github+json', '--header', 'X-GitHub-Api-Version: 2022-11-28',
    `https://api.github.com/${route}`,
  ]);
}

export function pullRequest(context: Context, host: string, identity: string, number: number): string {
  const route = `repos/${identity}/pulls/${number}`;
  if (context.host.cloudSession(context.root)) return restRead(context, host, route);
  return context.host.run(context.root, 'gh', ['api', '--hostname', host, route]);
}

const REMOTE = /^(?:https:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/**
 * The PR's head ref names this branch, or its merged head is exactly this
 * clean HEAD: a Claude branch pushed to a Codex-owned PR carries another ref
 * name, and its merge is still this tip's.
 */
export function sameHead(context: Context, head: { ref: unknown; sha: unknown }, current: string): boolean {
  if (head.ref === current) return true;
  return head.sha === git(context, context.root, 'rev-parse', 'HEAD')
    && git(context, context.root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none') === '';
}

/** The merged pull request's head and merge commit, both proven; Blocked otherwise. */
export function mergeProof(context: Context, number: number, current: string): [string, string] {
  const remote = git(context, context.root, 'remote', 'get-url', 'origin');
  const match = REMOTE.exec(remote);
  if (match === null) throw new Blocked('origin is not an identifiable GitHub repository');
  const [, host = '', owner = '', repo = ''] = match;
  const identity = `${owner}/${repo}`;
  const raw = pullRequest(context, host, identity, number);
  let head: string;
  let merged: string;
  try {
    const pr = JSON.parse(raw) as {
      merged: unknown;
      merge_commit_sha: unknown;
      head: { ref: unknown; sha: unknown; repo: { full_name: unknown } };
      base: { ref: unknown; repo: { full_name: unknown } };
    };
    if (pr.merged !== true || !sameHead(context, pr.head, current) || pr.base.ref !== 'main' || pr.head.repo.full_name !== identity || pr.base.repo.full_name !== identity) {
      throw new Error('not merged here');
    }
    if (typeof pr.head.sha !== 'string' || typeof pr.merge_commit_sha !== 'string' || !SHA.test(pr.head.sha) || !SHA.test(pr.merge_commit_sha)) {
      throw new Error('not a sha');
    }
    head = pr.head.sha;
    merged = pr.merge_commit_sha;
  } catch {
    throw new Blocked('PR is not a merged same-repository PR for this branch into main (a PR under another head ref counts only when its head sha is this clean HEAD)');
  }
  if (!ancestor(context.root, merged, 'refs/remotes/origin/main', context.host.env)) throw new Blocked('merged PR is not contained in fetched main');
  return [head, merged];
}

const hex = (length: number): string => randomUUID().replaceAll('-', '').slice(0, length);

export function retire(context: Context, number: number, successorName?: string): Record<string, unknown> {
  const { root, gitdir, provider, settings } = context;
  const current = currentBranch(context);
  const state = readReceipt(context);
  if (current === 'HEAD' && state.pr === number && state.phase === 'retired' && state.retiredHead === git(context, root, 'rev-parse', 'HEAD')) {
    return { phase: 'retired', alreadyRetired: true, worktree: root };
  }
  if (current === 'HEAD' || PROTECTED.has(current)) throw new Blocked('retirement requires a task branch');
  if (operations(gitdir).length > 0) throw new Blocked('finish the active Git operation before retiring the branch');
  git(context, root, 'fetch', 'origin', 'main');
  const [mergedHead, mergeCommit] = mergeProof(context, number, current);
  let known = true;
  try {
    execFileSync('git', ['cat-file', '-e', `${mergedHead}^{commit}`], { cwd: root, stdio: 'ignore', timeout: 30_000, env: { ...context.host.env } });
  } catch {
    // fail-open: a head missing here is fetched from its PR ref next.
    known = false;
  }
  // A squash or merge queue may leave the merged head outside main's
  // ancestry. Fetch its PR ref without recreating the retired branch.
  if (!known) git(context, root, 'fetch', 'origin', `refs/pull/${number}/head`);
  const tip = git(context, root, 'rev-parse', 'HEAD');
  const contained = ancestor(root, tip, mergedHead, context.host.env);
  let successor = successorName;
  if (!contained) {
    successor = successor ?? `${provider}/continue-${hex(12)}`;
    validBranch(context, successor);
  }
  if (operations(gitdir).length > 0 || currentBranch(context) !== current || git(context, root, 'rev-parse', 'HEAD') !== tip) {
    throw new Blocked('worktree changed during inspection; retry when idle');
  }
  // A durable ref before the branch changes, even if the process dies between
  // detach, compare-and-delete and writing its receipt.
  const recovery = `refs/${settings.name}/lifecycle/${hex(32)}`;
  git(context, root, 'update-ref', recovery, tip, '0'.repeat(tip.length));
  if (contained) git(context, root, 'switch', '--no-overwrite-ignore', '--detach', tip);
  else git(context, root, 'switch', '--no-overwrite-ignore', '--no-track', '-c', successor ?? '', tip);
  if (git(context, root, 'worktree', 'list', '--porcelain', '-z').includes(`branch refs/heads/${current}\0`)) {
    throw new Blocked('another worktree owns the old branch; keep its ref');
  }
  // Expected-old-value deletion refuses concurrent commits to the old branch;
  // the recovery ref keeps the tip apart from reflogs and app snapshots.
  git(context, root, 'update-ref', '-d', `refs/heads/${current}`, tip);
  writeReceipt(context, {
    phase: contained ? 'retired' : 'continued',
    pr: number,
    oldBranch: current,
    branch: contained ? null : successor,
    retiredHead: contained ? tip : null,
    mergeCommit,
    recoveryRef: recovery,
    launchBranch: launchBranch(state, current),
  });
  return {
    phase: contained ? 'retired' : 'continued',
    deletedLocalBranch: current,
    worktree: root,
    recoveryRef: recovery,
    successor: contained ? null : successor,
    next: contained ? 'retain worktree until explicit archive' : 'preserved post-merge work; reconcile successor with latest main before further edits',
    remote: 'use GitHub automatic head-branch deletion; no remote mutation performed',
  };
}

/** `archive-check`: inspect, and refuse a stale origin/main; exit 2 unless archive-ready. */
export function archiveCheck(context: Context): { report: Report; code: number } {
  const report = inspect(context);
  const remote = git(context, context.root, 'ls-remote', '--exit-code', 'origin', 'refs/heads/main').split(/\s+/);
  if (remote[0] === undefined || remote[0] === '' || remote[0] !== git(context, context.root, 'rev-parse', 'refs/remotes/origin/main')) {
    throw new Blocked('origin/main is stale; fetch and recheck before archive');
  }
  return { report, code: report.archiveReady ? 0 : 2 };
}

export const USAGE = 'usage: sarathi worktree status|archive-check|begin --branch <name>|retire --pr <n> [--branch <successor>]|hook\n';

interface Parsed {
  readonly action: 'status' | 'archive-check' | 'begin' | 'retire';
  readonly branch?: string;
  readonly pr?: number;
}

export function parseArgs(args: readonly string[]): Parsed | string {
  const [action, ...rest] = args;
  if (action !== 'status' && action !== 'archive-check' && action !== 'begin' && action !== 'retire') return USAGE;
  let branch: string | undefined;
  let pr: number | undefined;
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) return `${flag} needs a value\n${USAGE}`;
    if (flag === '--branch') branch = value;
    else if (flag === '--pr') {
      if (!/^-?\d+$/.test(value)) return `--pr needs a number\n${USAGE}`;
      pr = Number(value);
    } else return `unknown option ${flag}\n${USAGE}`;
  }
  return { action, ...(branch === undefined ? {} : { branch }), ...(pr === undefined ? {} : { pr }) };
}

export interface Io {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Builds the host; replaced in tests. */
  readonly host?: (settings: WorktreeSettings) => Host;
}

/** Runs one action and prints its JSON; resolves the exit code (2: blocked). */
export function lifecycleMain(args: readonly string[], io: Io): number {
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') {
    io.err(parsed);
    return 1;
  }
  let result: unknown;
  let code = 0;
  try {
    const probe = nodeHost({ name: 'sarathi', owner: 'the owner' }, io.env);
    const root = resolve(git({ host: probe }, io.cwd, 'rev-parse', '--show-toplevel'));
    const settings = readSettings(root);
    const host = io.host?.(settings) ?? nodeHost(settings, io.env);
    const ctx = context(io.cwd, host, settings);
    if (parsed.action === 'status') result = inspect(ctx);
    else if (parsed.action === 'archive-check') ({ report: result, code } = archiveCheck(ctx));
    else {
      result = exclusive(ctx.gitdir, settings.name, () => {
        if (parsed.action === 'begin') {
          if (parsed.branch === undefined || parsed.branch === '') throw new Blocked('begin requires --branch');
          return begin(ctx, parsed.branch);
        }
        if (parsed.pr === undefined || parsed.pr < 1) throw new Blocked('retire requires a positive --pr');
        return retire(ctx, parsed.pr, parsed.branch);
      });
    }
  } catch (error) {
    if (!(error instanceof Blocked) && !(error instanceof Error && 'code' in error)) throw error;
    result = { blocked: error.message };
    code = 2;
  }
  io.out(`${JSON.stringify(result, null, 2)}\n`);
  return code;
}
