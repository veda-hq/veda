# @veda-hq/agnipariksha

अग्निपरीक्षा, trial by fire. A mutation gate over stock
[StrykerJS](https://stryker-mutator.io): it mutates the files a push changed,
lane by lane, and blocks the push on a mutant no test kills. Part of
[Veda](https://github.com/veda-hq/veda).

```sh
npx @veda-hq/agnipariksha@0.8.7 [--base <ref>] [--files a,b] [--lane <name>]... [--tracked-only] [--pushed-refs] [--no-reuse]
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
- **Only what the push carries, under `--pushed-refs`.** Stryker mutates
  the files on disk, so the gate judges the checked-out `HEAD` and its
  working tree. To judge only what a push carries, a pre-push hook has to
  pass `--pushed-refs` and git's ref lines
  (`<local ref> <local sha> <remote ref> <remote sha>`) on stdin itself, as
  in `agnipariksha --tracked-only --pushed-refs --base "$base" <<< "$refs"`,
  where `$refs` holds the hook's own stdin. With it, the gate refuses with exit 2, before the machine lock and judging
  nothing, when a pushed sha is not `HEAD` (an annotated tag at `HEAD`
  passes), naming the ref: check it out and push again. It refuses too when
  a tracked file differs from `HEAD`, staged or not, naming the files:
  commit or stash the change and push again. A line whose local sha is all
  zeros is a deletion and is skipped. A push that carries no commit, with
  deletions only or no lines at all (git runs the hook with none for an
  up-to-date push), judges nothing and exits 0. A line not in git's shape
  refuses. With every pushed ref at `HEAD` and a clean tracked tree, the run
  is the same as without the flag.
- **The files.** Those changed since the merge-base of `HEAD` with `--base`
  (default: the config's `upstream`), deletions left out, plus untracked
  files unless `--tracked-only` is given. A pre-push hook passes it, because
  a push carries no untracked file; a run by hand judges them.
  `--files` names the files instead. A file whose change touches only
  comments and blank lines is not judged (untracked and `--files` ones always
  are), nor one with no colocated suite beside it. The suite that owns a
  source shares its name less the extension, and the first that exists
  wins: `a.test.tsx`, then `a.test.ts`, then `a.test.mjs` for `a.tsx`;
  `a.test.ts`, then `a.test.tsx`, then `a.test.mjs` for any other source
  (`a.ts`, `a.js`, `a.mjs`). So `a.mjs` with only `a.test.mjs` beside it is
  judged, and a source with a TypeScript suite keeps it.
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
  `--lane`, every lane runs, less any over the cut-off. One CI job per lane is
  the use.
- **The cut-off.** A lane with a `maxLines` (its own, else the config's) is
  left out of a run that names no lane when the files it would mutate hold
  more lines than that: a lane at the limit is judged. The gate prints the
  lane, its count and its limit, says CI judges it, and counts it in the total
  line (`1 over the cut-off for CI`). A left-out lane does not fail the run:
  a run with every lane left out exits 0, having judged nothing, so CI must
  run each lane by name. A run that names a lane with `--lane` judges it
  whatever its size. `--files` without `--lane` still applies the cut-off.
  The count is checked before Stryker starts. It is over the targets whole,
  since Stryker mutates them whole, not over the changed lines. Lines are
  counted as `wc -l` counts them, plus a last line with no newline; blank and
  comment lines count. A file that cannot be read counts 0, so a failed read
  never leaves a lane out. Lines are a coarse measure of time: on one CI
  runner, Stryker took 0.14 to 0.89 s a line across six samples. Give a lane
  with slow tests its own, lower `maxLines`. A `reuse: true` lane can cost far
  less than its count says.
- **Blocking**: `Survived` and `NoCoverage`. Caught: `Killed`, `Timeout` (after
  a retry), `RuntimeError`, `CompileError`. `Ignored` is not counted, and any
  other status refuses.
- **A sibling suite that did not run is named.** In a run narrowed to the
  owning suites (a lane whose `env` names `{suites}`, or a fallback rerun
  whose `fallbackEnv` does),
  only those suites run. When a file judged there has blocking mutants and a
  suite beside it does not own it (`a-cases.test.ts`, or a qualified
  `a.integration.test.ts`, or their `.test.tsx` and `.test.mjs` forms, with
  no source of its own), the gate says so once
  for the file: `a-cases.test.ts is not the owner, so it did not run; only
  a.test.ts kills mutants of a.ts here`. Under a related filter any suite
  that imports the file runs, a sibling included, so there it says nothing.
- **A timed-out mutant** is rerun once alone, with concurrency 1 and a
  three-minute timeout; one that times out again counts as caught. Stryker's
  `--mutate` range takes in every mutant nested inside the one retried (a
  BlockStatement holds all its block's), so the retry loads an ignorer of its
  own, `agnipariksha-retry`, that drops them, and leaves out the file's other
  mutators. What runs is the retried mutant and the other replacements its own
  mutator makes at that node (`>` to `>=` and to `<=`). The lane's own
  plugins, ignorers and exclusions stay. A retry that reports its mutant
  Ignored refuses: the verdict would not count it. The retry
  pass refuses once it has run 15 minutes, or when a retry's dry run times
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
  "maxLines": 1200,
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
- `maxLines`: the cut-off, a whole number of 1 or more. Absent means no
  cut-off. A lane's own `maxLines` takes its place for that lane.
- `lanes`, in the order they run. Each has a unique `name`, with no comma and
  not starting with `--`, so `--lane` can name it; `cwd`, the
  directory Stryker runs in (`""` is the root); `config`, its Stryker config
  relative to `cwd`; `reuse`; and `include`, the patterns of the files it
  mutates (one must match). Optional: `exclude` (none may match),
  `extensions` (the file ends with one; absent means any), `maxLines` (its
  own cut-off), `env` and `fallbackEnv`, the variables its Stryker config
  reads. In those two,
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
