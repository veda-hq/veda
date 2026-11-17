# @veda-hq/agnipariksha

अग्निपरीक्षा, trial by fire. A mutation gate over stock
[StrykerJS](https://stryker-mutator.io): it mutates the files a push changed,
lane by lane, and blocks the push on a mutant no test kills. Part of
[Veda](https://github.com/veda-hq/veda).

```sh
npx @veda-hq/agnipariksha@0.6.8 [--base <ref>] [--files a,b] [--lane <name>]... [--tracked-only] [--no-reuse]
```

Exit 0 when every judged mutant is caught, 1 on a blocking mutant, and 2 when
it refuses or cannot judge: a bad argument, a missing or bad
`agnipariksha.json`, a merge not yet committed, another run holding the
machine lock, a Stryker run that
fails or writes no report. A refusal never reads as blocking. Node 24.15 or
later, and `@stryker-mutator/core` 10.1.1 or a later 10.x as a peer: the gate
runs the repository's own `node_modules/.bin/stryker`.

## What it judges

- **Never a half-merged tree.** While a merge stopped before its commit
  (`MERGE_HEAD` exists, in a linked worktree too), the gate refuses with
  exit 2, before the machine lock: the working tree would be judged against
  the merge-base, so its verdict would say nothing about the branch. The
  refusal names the merge; commit it or abort it, then run again.
- **The files.** Those changed since the merge-base of `HEAD` with `--base`
  (default: the config's `upstream`), deletions left out, plus untracked
  files unless `--tracked-only` is given. A pre-push hook passes it, because
  a push carries no untracked file; a run by hand judges them.
  `--files` names the files instead. A file whose change touches only
  comments and blank lines is not judged (untracked and `--files` ones always
  are), nor one with no colocated suite (`a.ts` → `a.test.ts` or
  `a.test.tsx` beside it).
- **Each lane** is one Stryker config. The lane's files are mutated whole, in
  one `stryker run` from the lane's `cwd`, through a wrapper config that moves
  the JSON report into `reports/agnipariksha/`.
- **A temp directory per run.** Every Stryker run, a timeout retry included,
  gets `TMPDIR`, `TEMP` and `TMP` at a fresh, empty directory of its own
  (`agnipariksha-tmp-*` under the gate's temp directory), removed when the run
  ends. A mutant that turns a test's scratch cleanup into removing `tmpdir()`
  itself then removes only that directory, not the machine's shared one. If
  the directory is gone when the run ends, the lane refuses: something in the
  run removed files it should not have.
- **`--lane`** runs only the lanes it names, in the config's order. It can be
  repeated or given a comma-separated list, and a name may hold spaces:
  `--lane apps/web`, `--lane "tooling vitest" --lane "tooling node:test"`. A
  name the config does not have refuses with exit 2 before any work. Without
  `--lane`, every lane runs. One CI job per lane is the use.
- **Blocking**: `Survived` and `NoCoverage`. Caught: `Killed`, `Timeout` (after
  a retry), `RuntimeError`, `CompileError`. `Ignored` is not counted, and any
  other status refuses.
- **Only the owning suite kills.** When a file has blocking mutants and a
  suite beside it does not own it (`a-cases.test.ts`, or a qualified
  `a.integration.test.ts`, with no source of its own), the gate says so once
  for the file: `a-cases.test.ts is not the owner; only a.test.ts kills
  mutants of a.ts`.
- **A timed-out mutant** is rerun once alone, with concurrency 1 and a
  three-minute timeout; one that times out again counts as caught. The retry
  pass refuses once it has run 15 minutes, or when a retry's dry run times
  out: the machine is busy. A retry whose dry run fails on a test refuses as
  flaky, naming the tests Stryker printed: the lane's own run had passed
  them.
- **A failed test in the dry run** is named in the gate's own line. A lane
  with no `fallbackEnv` reruns such a dry run once with the same variables.
  If it passes, the gate says the test is flaky and that run's results
  count. If it fails again, the lane refuses: the initial test run failed on
  both runs.
- **Reuse.** A lane with `reuse: true` runs with `--incremental` and a reuse
  file named by a key over the files that can change its results: the
  lockfile and the rest of `reuseKey.always`, the lane's config, its
  workspace's test helpers and configs, `reuseKey.helperPackages`, the shared
  workspace, and the `.mjs` files under `reuseKey.pluginDir`. Only results
  that cannot go stale are reused. `--no-reuse` runs in full.
- **Fallback.** A lane with `fallbackEnv` reruns once with those variables when
  its dry run fails because no related test was found or one failed, and
  reruns in it any file whose every mutant was `NoCoverage`.
- **One run per machine.** A lock in the git common directory, which every
  worktree shares, holds a second run until the first ends, and refuses after
  30 minutes. A lock whose process is gone is taken over.

## `agnipariksha.json`

At the repository root. The gate reads and checks it at startup, and refuses
(exit 2) a missing file, one that is not JSON, an unknown or missing field, a
value of the wrong type, a pattern that is not a regular expression, or two
lanes with one name.

```json
{
  "upstream": "origin/main",
  "ignore": ["\\.(test|spec)\\.[^/]*$", "\\.d\\.ts$"],
  "lanes": [
    {
      "name": "lib",
      "cwd": "packages/lib",
      "config": "stryker.config.mjs",
      "reuse": true,
      "include": ["^packages/lib/src/"],
      "extensions": [".ts", ".tsx"],
      "exclude": ["(^|/)generated(/|$)"]
    },
    {
      "name": "tooling",
      "cwd": "",
      "config": "tooling.stryker.mjs",
      "reuse": false,
      "include": ["^scripts/"],
      "env": { "TOOLING_SUITES": "{suites}" }
    }
  ],
  "reuseKey": {
    "always": ["pnpm-lock.yaml", "node_modules/@stryker-mutator/core/package.json"],
    "pluginDir": "tools/stryker/",
    "helperPackages": ["packages/test-utils/"],
    "sharedWorkspace": "packages/lib"
  }
}
```

- `upstream` (default `origin/main`): the ref a push is compared with.
- `ignore`: regular expressions over repo-relative paths; a match is in no lane.
- `unsetEnv`: names of variables removed from the environment every Stryker
  run inherits, a timeout retry included, such as `VITEST_MAX_WORKERS` (which
  Vitest applies over its inline options) or `GITHUB_ACTIONS` and
  `GITHUB_STEP_SUMMARY` (with them set, Vitest's GitHub reporter writes a
  summary on every run). They are removed before the lane's `env`, which may
  set one again. Absent means none.
- `lanes`, in the order they run. Each has a unique `name`, with no comma and
  not starting with `--`, so `--lane` can name it; `cwd`, the
  directory Stryker runs in (`""` is the root); `config`, its Stryker config
  relative to `cwd`; `reuse`; and `include`, the patterns of the files it
  mutates (one must match). Optional: `exclude` (none may match),
  `extensions` (the file ends with one; absent means any), `env` and
  `fallbackEnv`, the variables its Stryker config reads. In those two,
  `{suites}` becomes the suites that own the lane's files, comma-joined.
- `reuseKey`: what goes into a reuse key, as above.

## Arid nodes

```js
// stryker.config.mjs
export default {
  plugins: ['@veda-hq/agnipariksha/arid-nodes'],
  ignorers: ['agnipariksha-arid-nodes'],
};
```

A Stryker `Ignore` plugin: mutants on nodes known to be unkillable are never
made, so the gate does not block on them. The module says, predicate by
predicate, what it matches and what it deliberately does not. It is plain
JavaScript, since Stryker loads plugins in its own process, and it needs no
`@stryker-mutator/api`: it exports the plain object that `declareClassPlugin`
returns.

It holds only rules that fit any React or TypeScript code: effect-cleanup
flags, inline style values and colour tables. A repository whose own code has
arid nodes writes its own ignorer and lists it beside this one, as in
`ignorers: ['agnipariksha-arid-nodes', 'my-arid-nodes']`. Stryker skips a node
if any listed ignorer says to.
