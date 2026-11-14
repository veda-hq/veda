# Node, pnpm and TypeScript

Lessons about the Node toolchain in a pnpm and Turborepo workspace: pnpm versions and
lockfiles, Turborepo filters and caches, how tsx runs scripts, lint and format traps, and
library behaviour that surprised a working change.

## pnpm

- **Fresh clones have no `node_modules`.** A fresh clone or harness checkout of a pnpm workspace
  has no `node_modules`, so the first `node --import tsx` fails with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`. Run `pnpm install --frozen-lockfile` from
  the clone root before any self-test, typecheck, lint or test command.
- **The global pnpm must match `packageManager`.** A global pnpm that differs from the
  repository's `packageManager` pin hands off to the pinned version on every call, costing
  seconds each time and making hooks look load-bound. `pnpm -v` inside the repository answers
  the pin, so read the real one with `npm_config_manage_package_manager_versions=false pnpm -v`.
  Fix it with `pnpm self-update <pin>` run outside the repository. Corepack cannot run pnpm 12
  (a Rust binary, no `.cjs`), so install pnpm standalone.
- **pnpm 12 lockfiles hold two documents.** pnpm 12 writes `pnpm-lock.yaml` as two YAML
  documents (the package-manager record first, the project lockfile last), so any script that
  parses the lockfile must read the last non-empty document. A `packageManager` pin bump fails
  `--frozen-lockfile` until the regenerated lockfile, with its `packageManagerDependencies`, is
  committed.
- **An install that prints "Done" and never exits.** pnpm 11.22.0 with `nodeLinker: hoisted`
  could print "Done" and never exit on a `node_modules` cache hit (a late optional-dependency
  fetch keeps a worker pool alive). Pin a fixed release and bound CI installs with a per-attempt
  timeout, one retry and `timeout-minutes` on setup steps. GNU and macOS `timeout` send the
  follow-up SIGKILL only to the direct child, so bound by process group (`setpgrp`, then TERM
  and KILL the group).
- **Release age and audit fixes.** When `pnpm audit` blocks on a new advisory under a
  `minimumReleaseAge` policy, pin the newest patched version already older than the release age
  (check `npm view <pkg> time`) and raise the override floor. If `pnpm install` silently adds a
  `minimumReleaseAgeExclude` entry for a too-new version, revert it and pick an older patch.
  The one standing entry is veda's own scope, `@veda-hq/*` (Alok, 2026-11-14): a new release
  installs at once, and `pnpm provenance` (in `pnpm check`) checks instead that veda's release
  workflow built and signed each `@veda-hq` package the lockfile resolves, from its own tag.
  When Sigstore rotates a key, it fails until `scripts/sigstore-trusted-root.json` is refreshed.
  Check whether the default branch already carries the bump before making it.
- **A lost patch looks like a code bug.** When pnpm warns that `node_modules` are out of sync
  with the lockfile because the `patchedDependencies` value changed, a patched dependency has
  lost its patch, and its guard test fails exactly like a code bug in a file the diff never
  touched. Run `pnpm install --frozen-lockfile` (it reapplies the patch without rewriting the
  lockfile) and re-run the single test alone before calling it a flake.

## Turborepo

- **`--filter=...[ref]` diffs against the ref's tip.** Turborepo's `--filter=...[ref]` diffs the
  working tree against the ref's tip, not the merge base, so a branch behind main selects every
  package main changed since the branch point and runs suites it never touched. Pass the
  merge-base sha (`git merge-base origin/main HEAD`) as the filter ref, and check scope with
  `turbo run <tasks> <filter> --dry=json` (`tasks[].taskId`).
- **A shared cache replays another checkout's run.** When git worktrees share one Turborepo
  cache directory, a cache hit replays another checkout's run, so its green says nothing about
  this worktree's database or machine, and the cache metadata does not name the checkout that
  wrote it. Mark environment-dependent tasks `cache: false`. To force a real run use
  `--cache=local:,remote:` (no reads, no writes), since `--force` still writes and can seed other
  checkouts.
- **Narrow task inputs hide docs checks.** If a task's `inputs` are `src/**/*.ts` only, a
  repository-wide docs check run inside it cache-hits on markdown-only diffs and dead links ship
  green; widen the inputs or run such checks outside turbo.

## tsx and module format

- **tsx runs scripts as CommonJS.** With no `type` field in `package.json`, tsx runs a `.ts`
  script as CommonJS, where `import.meta.dirname` is undefined and
  `path.resolve(import.meta.dirname, ...)` throws `ERR_INVALID_ARG_TYPE` at load, while Vitest
  runs the same file as ESM, so its tests pass. A green colocated suite proves nothing about the
  real entry point. Resolve the script's folder with `dirname(fileURLToPath(import.meta.url))`,
  run every new CLI once by hand (a dry run or `--help`) before calling it done, and make any
  test that spawns the script assert the child ran (exit status 0 and expected stdout), not only
  a missing side effect.

## Lint and format

- **One new bulk-suppressed violation reports them all.** With ESLint bulk suppressions
  (`eslint-suppressions.json` counts per file per rule), one new violation over a file's count
  makes ESLint report every old one too, so the CI error count overstates your share. Blame
  flagged lines against `origin/main..HEAD` and fix only yours. When your file has fewer
  violations than counted, run `eslint --prune-suppressions <files>` from the package directory
  and re-run Prettier on the JSON, and keep scratch files out of linted package trees.
- **Prettier reads two `$` as math.** Prettier's markdown parser pairs two `$` signs in one
  paragraph as inline math and reprints the paragraph with code-span spaces stripped and list
  continuations de-indented, while `--check` stays clean. Keep at most one `$` per paragraph or
  escape it as `\$`, and review the diff after `prettier --write` on markdown that mentions
  prices.

## Libraries and runtime

- **Install signal handlers before `spawn()`.** In a Node script that forwards signals to a
  child, install the `process.on('SIGTERM', ...)` handlers before calling `spawn()`: spawn
  returns with the child already running, and the OS can deschedule the parent in that gap so a
  signal hits the default action. When a child reports exit code `null`, capture `signal` before
  theorising.
- **google-auth-library errors embed the token.** Its ID-token verification errors concatenate
  the raw token or its decoded claims (`email`, `sub`) into `error.message`, so logging the
  message leaks a bearer credential. Classify the message by its constant prefixes and log only
  a fixed code, with a test that drives the real client so the prefix table cannot drift.
- **A multiline PEM in a `.env` file.** A line-based `.env` parser keeps only the
  `-----BEGIN ... KEY-----` line of a pasted multiline PEM, so signing fails with
  `error:1E08010C:DECODER routines::unsupported` and code may silently fall back to another
  token. Store the PEM on one line, double-quoted, with literal `\n` escapes, and expand them at
  the read point.
- **zod 4.6 counts code points.** zod 4.6 measures string `min`, `max` and `length` in Unicode
  code points, not UTF-16 units, with no switch back, so a bump silently loosens limits for
  astral characters (2,049 emoji pass `max(4096)`). Where a contract counts UTF-16 units, add
  `.refine(value => value.length <= N)`; code points already match Postgres `varchar(n)`.
