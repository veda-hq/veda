# Stryker mutation testing

Lessons from running Stryker (with the Vitest runner) as a mutation gate: running it without
damaging the checkout, where its time goes, mutants it misreports, how to kill survivors
without suppressing them, and the traps of a gate scoped to a diff.

## Running Stryker safely

- **Never run with `--inPlace`.** `disableTypeChecks` inserts `// @ts-nocheck` into your real
  files and in-place mode restores them only after a successful run, so an interrupted run
  leaves mutated sources and `stryker-setup` files behind. Measure one file with
  `npx stryker run stryker.config.mjs --mutate <file>` in the sandbox instead.
  <!-- held by: kavach command guard, rule stryker-inplace (warns, then refuses, stryker run with --inPlace) -->
- **In-place hand runs.** If you do run in place, its restore can drop the executable bit on
  files it never mutated (mode 100755 to 100644, content identical); check `git status` after
  every in-place run and `chmod +x` them back rather than committing the change.
  <!-- held by: dvara exec-bits (a pre-commit check that warns on, and with --refuse refuses, a staged 100755 to 100644 change with unchanged content) -->
- **Mutants can delete real paths.** Stryker runs every mutant against your refusal tests, so a
  test that passes a real dangerous path (such as `tmpdir()`) to a guarded delete is one mutant
  away from deleting it for real. Point `TMPDIR` or the target at a stand-in directory in such
  tests.
- **A hook-exported `GIT_DIR` and mutable guards.** Under a git hook `GIT_DIR` is exported and
  overrides cwd discovery, so a test that spawns `git init` with the default env re-initialises
  the real repository (symptoms: `core.bare=true`, a fixture `user.name` showing in the
  session). Mutation testing also blanks guard literals such as `"GIT_DIR"`, so a guard made of
  mutable data is defeatable: enforce at a spawn boundary mutants cannot reach, or unset
  `GIT_*` in the hook script itself.
- **The step summary overflows in CI.** Under GitHub Actions, Vitest adds its github-actions
  reporter and appends to the step summary on every run, which under Stryker means once per
  mutant and overflows `$GITHUB_STEP_SUMMARY`. Unset `GITHUB_ACTIONS` and `GITHUB_STEP_SUMMARY`
  in the env Stryker passes to its test runner.

- **One lane of veda's own gate by hand.** veda's lanes are in `agnipariksha.json` at the root,
  one per package, each on the `tap` runner through `stryker/lane.mjs`. Judge files by hand with
  `pnpm exec agnipariksha --lane <name> --files <repo-relative paths> --no-reuse`. Naming the lane
  judges it whatever the cut-off. Without `--files`, it judges what the branch changed. The
  reports land in `reports/agnipariksha/`, which git ignores.
- **veda's cut-off, and the times it came from.** A run that names no lane (pre-push) leaves a
  lane to CI when its files hold more lines than `maxLines`: 1,500, sarathi 1,000, pariksha
  400. It was timed on 2026-11-20 on an 18-core M5 Max: load was 1.9 and 2.9 before the two
  batches, and 2.95 of 4 GiB of swap was in use. The aim was about 3 minutes per lane, below
  #238's 5, so a push still finishes when the Mac is busy. Seconds per line: kavach 0.04,
  shuddhi 0.05, agnipariksha 0.01 (with `cli.ts` left out), dvara 0.11, sarathi 0.18,
  pariksha 0.54. Timeout retries are much of the slow lanes' time:
  - kavach, shuddhi and agnipariksha retried none;
  - dvara retried 9, in about 22 s;
  - sarathi retried 3, one of them 41 of its 57 s, so its 1,000 rests on that one mutant;
  - pariksha retried 25, in 2.7 of its 6.6 minutes.

  Under load the same pariksha pair took 24 minutes, so a busy Mac can still hold a push
  past its budget. Re-time with `--lane <name> --files …` when a lane's suites get slower.
- **CI judges every lane with work.** `.github/workflows/mutation.yml` runs one job per lane
  that has a file to judge, by name, so the cut-off does not apply there. The lanes come from
  `scripts/mutation-lanes.mjs`, which calls the pinned agnipariksha's own planner rather than
  copying its matching, so a lane CI skips is one the gate would judge nothing in. The
  "Mutation" job is the one to require.

## Speed and incremental mode

- **A campaign playbook.** For a large mutant-killing campaign, give each executor 3 to 6 files
  and a per-file `stryker run --mutate <file>` loop to zero survivors, cap concurrent Stryker
  runs at 3, and read survivors from each run's stdout, since `reports/mutation/mutation.json`
  is shared. Tests that read source files off disk break inside the sandbox (use sandbox-aware
  paths), `toHaveBeenCalledWith` passes if any call matches, and a fixture equal to the fallback
  constant cannot kill a `??` mutant.
- **Static mutants are slow because of Stryker.** A static mutant (a module-level constant)
  re-runs every related test file, so a survivor there is the slowest run in the gate, and the
  slowness is Stryker's, not the mutated code's. A constant compared only to itself
  (`toEqual([CONST])`) can never kill its own mutant: test a persisted key or string constant
  through the literal value that stored state holds. Solo-run one mutant with
  `stryker run --mutate <file>:<line>-<line> --concurrency 1 --logLevel debug`.
- **Static mutant cost depends on test order.** Under the Vitest runner a static mutant runs all
  related files with bail, and Vitest's default sequencer orders files last-failed first, then
  longest, from each runner's own cache, so the cost depends on where the killing file sits. A
  custom Vitest sequencer that puts the mutated file's owning suite first keeps verdicts
  identical and cut one mutant phase from 143 s to 14 s. For a slow or Timeout static mutant,
  first find which file kills it and its position (`testsCompleted` in `mutation.json`).
- **Incremental mode and test edits.** Incremental mode reuses results for unchanged or
  source-edited files, but when a file's covering test file changes it re-runs every mutant
  those tests cover, so near-zero reuse on test-editing pushes is expected, not a bug. The dry
  run always runs, so even full reuse costs a fraction of a full run.

## Mutants Stryker misreports

- **Load failures read as Survived.** The stock Vitest runner (9.6.x) builds results only from
  collected tests, so a mutant that makes a test file throw at import, in a `describe` body or
  in `afterAll` has no failing test and is reported Survived. Wrap the runner factory to add one
  failed test per failed file (so the mutant reads Killed, not RuntimeError), or re-check such
  survivors by hand.
- **Collection-time code makes static mutants.** Code called at `describe` or collection time
  makes its mutants static, and they can report Survived even when a test obviously kills them;
  build fixtures inside each `it` before trusting a survivor list.
- **`vitest related` misses `createRequire` and child processes.** The runner picks tests via
  `vitest related` (Vite's import graph), so a source a suite loads with `createRequire`, or
  reaches only through a spawned child, has no related test and reads NoCoverage, or the run
  dies with "No tests were executed". Set `vitest.related: false` in the Stryker config, narrow
  `include` to the owning suites, and test CLIs in-process through an exported `main`.
- **CLI validators tested by spawning show NoCoverage.** Stryker cannot see coverage from a
  child process. Make the validator in-process: thread a root parameter through file walkers,
  export `validate(mode, root)`, and have `main(args, root)` return `{ code, lines }` and print
  only at the CLI entry. `str.replace(root, '')` yields an equivalent StringLiteral mutant (use
  `filePath.slice(root.length)`), and an `x || default` that any unknown value already means is
  unkillable, so drop it.
- **Source text inside the sandbox is instrumented.** Inside the sandbox your source files carry
  a `stryNS_...()` prelude, so any check that reads source text at test time sees mutated code
  and can misjudge it. In tests of a rejection rule, assert the rejection reason, not only the
  line number; line-only assertions let mutants survive.
  <!-- when: error "stryNS_" -->

## Killing survivors without suppressing them

- **An unobservable mutant means the code is unclear.** A mutant that looks value-equivalent
  usually means the code says one thing twice or says nothing; fix the code instead of
  suppressing the mutant. Move an unobservable literal into a shared constant that an observed
  code path also uses, or give a silent guard branch the log its sibling branches already emit,
  so the mutated form becomes distinguishable.
- **Delete branches no test can tell apart.** When an EqualityOperator mutant survives on a
  condition you just added, first ask whether its two branches are observable at all. If no test
  can tell them apart, delete the branch (for example use one shared module-level empty constant
  so React's equality check bails out) instead of writing a test. Module-level constants land in
  Stryker's ignored static bucket, so the sentinel adds no mutant.
- **Assert the literal, not the imported constant.** In a test meant to kill mutants, assert the
  verbatim literal typed in the test; an assertion against the same imported constant moves
  with the mutant and kills nothing.
  <!-- held by: shuddhi assert-imported-constant (warns on a matcher's expected value imported from the module under test) -->
- **Strict command fakes kill argument mutants.** StringLiteral survivors in a CLI's exec
  argument arrays die only when the test fake matches the exact command plus arguments and
  throws on anything else; a prefix-matching fake lets every mutated argument through. Assert
  whole messages with `toBe` rather than `toContain`, and move entry-point logic into an exported
  `cli(argv, env, cwd)` function.
- **`stdio` mutants and signal tests.** In Node an empty string is a valid `stdio` value meaning
  pipe, so mutating `stdio: ['ignore', 'pipe', 'ignore']` to `''` is an equivalent mutant, and
  `spawnSync` with no `stdio` option captures stderr and needs none; `execFileSync` `stdio`
  `'pipe'` mutated to `''` is observable by spying on `process.stderr.write`. A signal test whose
  hook runs `sleep 60 & wait` turns every forwarding mutant into a timeout plus a slow retry:
  bound hooks to about 5 s, assert the TERM trap fired via a marker file, and race the call
  against a 30 s rejection. `{ recursive: true }` and `{ force: true }` mutants need a missing
  parent directory or missing file plus a `console.error` spy.
- **Cosmetic survivors.** Stryker 9.6 already skips a string literal placed directly in a JSX
  attribute (`className="..."`), so Tailwind class strings create no survivors; cosmetic
  survivors come from inline style objects and colour tables. Count those statically before
  planning a campaign, and keep visibility-changing values (`display: none`,
  `visibility: hidden`, `pointerEvents: none`) mutable.

## Gates scoped to a diff

- **Literals that yield no mutant.** Stryker 9.6 has no numeric-literal mutator, so a bare
  constant on a changed line is never mutated and needs a hand-written test. A literal that
  appears only as an `as const` tuple member yields no mutant either, so a gate requiring every
  changed line to be examined fails it as unexamined; hoist the literal to a plain const.
- **Comment-only lines and wrapper verdicts.** A comment-only change adds lines with no mutants,
  which a blocking "every changed line examined" gate can never clear; exclude comment-only
  lines with a tokeniser predicate. A wrapper that reads the JSON report must act on its verdict,
  not ignore the exit code.
- **Untracked files and fixture keys.** Untracked new files are invisible to a diff-scoped
  mutation gate until committed, and a 32-hex idempotency key in a fixture trips gitleaks, so
  use a readable key.
  <!-- held by: agnipariksha changed-files (a run judges untracked files whole, whatever their diff says); the gitleaks key stays doc -->
- **Mirror clones have a stale or missing `origin/main`.** A clone fetched with a mirror refspec
  (`+refs/*:refs/*` or `+refs/heads/*:refs/heads/*`) has no fresh `refs/remotes/origin/*`, so a
  gate whose diff base defaults to `origin/main` fails or, worse, diffs against a stale base
  that drags unrelated files into scope and trips the changed-file cap. Run
  `git fetch origin main` and point the gate's base setting at local `main`; never repair it
  with `git update-ref`. CI diffs against the real PR base and is unaffected.
