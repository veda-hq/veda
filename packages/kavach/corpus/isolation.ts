/**
 * What keeps a fixture apart from the machine it runs on: the environment
 * its git runs under, and the one way its root is removed.
 */

import { existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The only inherited `GIT_*` variables a fixture keeps: who its commits are
 * by, and how git reaches a remote without prompting. Every other `GIT_*` is
 * dropped: a hook exports `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_PREFIX`,
 * `GIT_EXEC_PATH` and more, and any of them in a fixture is the caller's
 * repository leaking in; `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG` and the
 * `GIT_CONFIG_COUNT` family put configuration back over the masks below.
 */
const KEPT_VARIABLES: ReadonlySet<string> = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_SSH_COMMAND',
  'GIT_TERMINAL_PROMPT',
]);

/**
 * The identity a fixture commits as when its caller names none: the masks
 * hide the machine's `user.name`/`user.email`, and a CI runner has none to
 * fall back on.
 */
export const FIXTURE_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
} as const;

/**
 * Values every fixture git command runs with, whatever the machine has.
 * Pointing both config files at /dev/null removes everything the machine
 * adds (signing that prompts for a key, hook paths, aliases, a trace2 target
 * whose daemon writes into the fixture after the command returned, racing
 * its removal); "0" disables a trace target exported by the shell.
 */
export const HERMETIC_GIT_VARIABLES = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TRACE2: '0',
  GIT_TRACE2_EVENT: '0',
  GIT_TRACE2_PERF: '0',
} as const;

/** The environment for a fixture's git commands, built from a copy of `base`. */
export function hermeticGitEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!name.startsWith('GIT_') || KEPT_VARIABLES.has(name)) env[name] = value;
  }
  return { ...FIXTURE_GIT_IDENTITY, ...env, ...HERMETIC_GIT_VARIABLES };
}

/** `path` resolved through every symlink that exists, its missing tail kept. */
function realLocation(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return resolve(realLocation(parent), absolute.slice(parent.length + 1));
}

/** Is `path` strictly below the temporary directory (never the directory itself)? */
export function isFixturePath(path: string): boolean {
  const rel = relative(realLocation(tmpdir()), realLocation(path));
  return (
    rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  );
}

/**
 * Remove a fixture root, which must lie below the temporary directory: a
 * wrong path handed here must never delete a real checkout. A removal that
 * fails after its retries is reported and left, not thrown: the run's
 * verdicts are already in.
 */
export function removeFixtureRoot(root: string): void {
  if (!isFixturePath(root)) {
    throw new Error(
      `fixture cleanup: refusing to remove ${root}, which is not inside the temporary directory`,
    );
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    /* node:coverage ignore next 3 */
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`fixture cleanup: could not remove ${root}: ${reason}`);
  }
}
