/**
 * The environment for git commands run inside a throwaway fixture repository:
 * the helper `git-spawn-env`, `git-fixture-env` and `no-partial-git-mask` ask
 * tests to use, shipped beside them (`@veda-hq/eslint-plugin-shuddhi/hermetic-git`).
 *
 * A fixture that runs plain `git` inherits the machine's whole git setup and
 * every `GIT_*` variable of the shell or hook the test runs in:
 *
 * - Global config such as git-ai's `trace2.eventtarget` reports every
 *   fixture commit to a daemon that writes into the fixture after the
 *   command returned, and git's detached auto-maintenance holds lock files in
 *   `.git/objects` the same way, so a teardown racing them fails with
 *   ENOTEMPTY or ENOENT.
 * - `commit.gpgsign=true` makes every fixture commit ask for a key.
 * - Under a git hook, `GIT_DIR` and `GIT_INDEX_FILE` point the fixture's git
 *   at the hook's repository.
 * - `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG` and the
 *   `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` family are read
 *   over the config files, so they put any of that straight back.
 * - With the machine's config masked, macOS still guesses a committer
 *   identity and Linux CI does not, so a fixture commit, merge or rebase
 *   dies with "Committer identity unknown" in CI alone.
 *
 * So: both config files are /dev/null, trace2 is off, every inherited `GIT_*`
 * but the identity and transport ones is dropped, automatic maintenance and
 * gc are off through git's own `GIT_CONFIG_COUNT` entries, and a fixture
 * identity stands in for the machine's. Environment identity outranks
 * `git -c user.name=...`, so a test that asserts an author sets these.
 */

/**
 * The only inherited `GIT_*` variables a fixture keeps: who its commits are
 * by, and how git reaches a remote without prompting.
 */
const KEPT_VARIABLES = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_SSH_COMMAND',
  'GIT_TERMINAL_PROMPT',
]);

/** The identity a fixture commits as when its caller names none. */
export const FIXTURE_GIT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
});

/** Values every fixture git command runs with, whatever the machine has. */
export const HERMETIC_GIT_VARIABLES = Object.freeze({
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  // "0" turns a target off; it covers one exported by the shell.
  GIT_TRACE2: '0',
  GIT_TRACE2_EVENT: '0',
  GIT_TRACE2_PERF: '0',
  // `-c maintenance.auto=false -c gc.auto=0`, for every git the env reaches.
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto',
  GIT_CONFIG_VALUE_1: '0',
});

/** A variable the masks own: every `GIT_*` name. */
const isGitVariable = name => name.startsWith('GIT_');

/**
 * The environment for a fixture's git commands, built from `base`
 * (`process.env` by default), which is copied, never changed. Hand the
 * result to every child the test spawns, so the code under test runs its own
 * git under the same isolation.
 *
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function hermeticGitEnv(base = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (!isGitVariable(name) || KEPT_VARIABLES.has(name)) env[name] = value;
  }
  return { ...FIXTURE_GIT_IDENTITY, ...env, ...HERMETIC_GIT_VARIABLES };
}

/** Live masks per environment, and what it held before the first of them. */
const activeMasks = new WeakMap();

/**
 * The same isolation applied to `env` in place (`process.env` by default),
 * for code under test that spawns its own git with no `env`. Returns the
 * function that puts it back, so `beforeAll(() => maskProcessGitEnv())` both
 * applies it and, as Vitest runs a returned function as teardown, restores
 * it.
 *
 * Masks on one environment are counted: the first snapshots it, and only the
 * last restore puts it back, in any order, so one suite's teardown never
 * unmasks a suite still running. A restore runs once and puts back only the
 * variables the masks own, every `GIT_*`; anything else set meanwhile stays.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {() => void}
 */
export function maskProcessGitEnv(env = process.env) {
  const active = activeMasks.get(env) ?? { count: 0, before: { ...env } };
  active.count += 1;
  activeMasks.set(env, active);
  const hermetic = hermeticGitEnv(env);
  for (const name of Object.keys(env)) {
    if (!(name in hermetic)) delete env[name];
  }
  for (const [name, value] of Object.entries(hermetic)) {
    if (isGitVariable(name)) env[name] = value;
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    active.count -= 1;
    if (active.count > 0) return;
    activeMasks.delete(env);
    const names = new Set([...Object.keys(env), ...Object.keys(active.before)]);
    for (const name of names) {
      if (!isGitVariable(name)) continue;
      const value = active.before[name];
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  };
}
