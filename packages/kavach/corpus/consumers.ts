/**
 * Everything that is run against the adversarial corpus: kavach's two
 * guards, through the entry points a consumer wires into its agent.
 *
 * A consumer is adapted to one question: "does this row's intent happen?" A
 * guard answers by refusing the command; a validator would answer by counting
 * it. `safe` is the answer that fails CLOSED for that consumer — a guard may
 * refuse more than it must — and is the only direction a consumer may
 * disagree with bash on a non-strict row.
 *
 * The guards run with the sample consumer config beside this file
 * (SAMPLE_CONFIG), the way a project that turned its own rules on runs them.
 */

import { join, resolve } from 'node:path';

import type { CorpusRow, Intent } from './corpus.ts';
import type { Fixture } from './fixture.ts';
import { runChild } from './run-child.ts';

/** The package root: `python/kavach/` holds the guards' entry points. */
export const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
/** A consumer config with every rule kind turned on (KAVACH_CONFIG). */
export const SAMPLE_CONFIG = join(import.meta.dirname, 'kavach.config.json');

export interface Consumer {
  readonly id: string;
  readonly kind: 'guard' | 'validator';
  /** Source files whose behaviour this consumer is, relative to the package. */
  readonly files: readonly string[];
  readonly intents: readonly Intent[];
  /** The fail-closed answer. */
  readonly safe: boolean;
  /** Needs a fixture (a guard reads the repository it stands in). */
  readonly needsFixture: boolean;
  /** Rows this consumer does not face, each with the reason. */
  readonly outOfModel?: Readonly<Record<string, string>>;
  /**
   * Harmless strict rows this consumer refuses because of a deliberate,
   * coarser check it keeps (its floor), each with the reason. Still faced:
   * the refusal must happen (corpus.test.ts), and only a refusal is excused.
   */
  readonly floorRefuses?: Readonly<Record<string, string>>;
  judge(
    row: CorpusRow,
    text: string,
    fixture: Fixture | null,
  ): Promise<boolean>;
}

export interface Spawned {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const GUARD_TIMEOUT_MS = 30_000;
/** All of a guard's stderr that matters: a whole Python traceback fits. */
const STDERR_LIMIT = 1024 * 1024;

export async function spawnWithInput(
  command: string,
  args: readonly string[],
  input: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<Spawned> {
  // The guard leads its own process group, killed whole at the timeout and
  // the moment it exits: a guard that starts further processes cannot leave
  // one holding the pipes open past the bound.
  const outcome = await runChild(command, args, {
    ...options,
    input,
    timeoutMs: GUARD_TIMEOUT_MS,
    stderrTailChars: STDERR_LIMIT,
  });
  // A signal, a timeout or a failed spawn is no status at all (verdict()).
  const status =
    outcome.kind === 'ok' || outcome.kind === 'exit' ? outcome.code : null;
  return { status, stdout: outcome.stdout, stderr: outcome.stderrTail };
}

/** The PreToolUse payload Claude Code sends for a Bash call. */
export function bashEvent(command: string, cwd: string): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
  });
}

/**
 * Where a guard stands for a row: the session worktree or the main checkout.
 * The row's text is rendered for this checkout (corpus.ts `{UP}`), so a
 * relative path names the same place for every consumer and for the oracle.
 */
export function standIn(row: CorpusRow, fixture: Fixture): string {
  return row.inPrimary ? fixture.primary : fixture.worktree;
}

function need(fixture: Fixture | null): Fixture {
  if (fixture === null) throw new Error('guard consumers need a fixture');
  return fixture;
}

/** Deny in either hook protocol: exit 2, or a JSON `deny` decision. */
export function denied(result: Spawned): boolean {
  return (
    result.status === 2 ||
    /"permissionDecision"\s*:\s*"deny"/.test(result.stdout) ||
    /"decision"\s*:\s*"deny"/.test(result.stdout)
  );
}

/**
 * A guard's verdict: deny, or allow ONLY on a clean exit 0. A spawn failure,
 * a timeout, a signal or any other status is no verdict at all, and reading
 * it as "allowed" would let a corrected or near-miss row pass on a guard
 * that crashed or never ran.
 */
export function verdict(result: Spawned): boolean {
  if (denied(result)) return true;
  if (result.status === 0) return false;
  throw new Error(
    `guard gave no verdict (status ${String(result.status)}): ${result.stderr.slice(-500)}`,
  );
}

/**
 * The environment a guard runs under: the fixture's, the consumer config
 * named, and no bytecode written into the package beside the entry point.
 */
export function guardEnv(
  world: Fixture,
  config: string = SAMPLE_CONFIG,
): NodeJS.ProcessEnv {
  return {
    ...world.env,
    KAVACH_CONFIG: config,
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

/** Run the guard entry point `script` (under python/kavach/) on one row. */
export async function runGuard(
  script: string,
  row: CorpusRow,
  text: string,
  world: Fixture,
  config: string = SAMPLE_CONFIG,
): Promise<boolean> {
  const cwd = standIn(row, world);
  const result = await spawnWithInput(
    'python3',
    [join(PACKAGE_ROOT, 'python', 'kavach', script)],
    bashEvent(text, cwd),
    { cwd, env: guardEnv(world, config) },
  );
  return verdict(result);
}

const commandGuard: Consumer = {
  id: 'command-guard',
  kind: 'guard',
  // The entry point runs both checks, and the command runs only when both
  // allow it.
  files: [
    'python/kavach/command_guard.py',
    'python/kavach/bash_guard.py',
    'python/kavach/git_safety.py',
  ],
  intents: ['hook-bypass', 'force-push'],
  safe: true,
  needsFixture: true,
  // bash_guard.py, the first check, refuses any command whose text holds
  // `--no-verify`, and `git commit` with an `n` in a short-option cluster,
  // before git_safety.py reads the command: a deliberate floor, coarser than
  // the parse that follows it.
  floorRefuses: {
    'hb-message-is-flag':
      'bash_guard.py refuses --no-verify anywhere in the text',
    'hb-message-bundled-n': 'bash_guard.py reads -mn as the -n alias',
    'hb-message-variable':
      'bash_guard.py refuses --no-verify anywhere in the text',
    'hb-echo': 'bash_guard.py refuses --no-verify anywhere in the text',
    'hb-comment': 'bash_guard.py refuses --no-verify anywhere in the text',
    'hb-log-grep': 'bash_guard.py refuses --no-verify anywhere in the text',
  },
  judge(row, text, fixture) {
    return runGuard('command_guard.py', row, text, need(fixture));
  },
};

const worktreeGuard: Consumer = {
  id: 'worktree-guard',
  kind: 'guard',
  files: ['python/kavach/worktree_guard.py', 'python/kavach/boundary.py'],
  intents: ['outside-write'],
  safe: true,
  needsFixture: true,
  judge(row, text, fixture) {
    return runGuard('worktree_guard.py', row, text, need(fixture));
  },
};

export const CONSUMERS: readonly Consumer[] = [commandGuard, worktreeGuard];
