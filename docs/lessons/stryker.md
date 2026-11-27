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
- **An import-time entry guard starts a real gate.** With `if (isEntry(process.argv[1]))` at the
  bottom of a CLI module, the mutant that forces the condition true runs the real CLI whenever a
  test imports the module. For agnipariksha that is a real gate: it takes the machine lock and
  rewrites `reports/agnipariksha/`, and the mutant reads as a Timeout that costs a 180 s retry.
  Keep the entry in an exported function that a test calls with a fake process, and start it
  from a bin shim beside it that holds no logic, has no suite, and that the package's `exports`
  maps to `null`, so nothing can import it. agnipariksha's `src/bin.ts` and `entry()` in
  `src/cli.ts` do this (veda#420).
  <!-- held by: agnipariksha's smoke script (importing @veda-hq/agnipariksha/dist/bin.js must fail with ERR_PACKAGE_PATH_NOT_EXPORTED); other CLIs stay doc -->
- **A hook-exported `GIT_DIR` and mutable guards.** Under a git hook `GIT_DIR` is exported and
  overrides cwd discovery, so a test that spawns `git init` with the default env re-initialises
  the real repository (symptoms: `core.bare=true`, a fixture `user.name` showing in the
  session). Mutation testing also blanks guard literals such as `"GIT_DIR"`, so a guard made of
  mutable data is defeatable: enforce at a spawn boundary mutants cannot reach, or unset
  `GIT_*` in the hook script itself.
- **An outer dvara run's `DVARA_` variables.** veda's pre-push runs the gate under dvara, so
  every suite the gate runs inherits the outer run's `DVARA_STAGE_FILE` and `DVARA_RECORD_FILE`.
  A mutant of the env a test hands its own hook (in dvara's `supervisor.ts`, the spawn env)
  then lets that hook's `dvara_stage lint` write into the outer run's stage file. The gate
  passed, but the push was refused with "pre-push marked stage "lint"". A suite that runs dvara
  hooks drops every inherited `DVARA_` variable when it loads, as it does `GIT_`, and puts them
  back in `after` (`packages/dvara/src/supervisor.test.ts`, veda#459).
- **The step summary overflows in CI.** Under GitHub Actions, Vitest adds its github-actions
  reporter and appends to the step summary on every run, which under Stryker means once per
  mutant and overflows `$GITHUB_STEP_SUMMARY`. Unset `GITHUB_ACTIONS` and `GITHUB_STEP_SUMMARY`
  in the env Stryker passes to its test runner.

- **One lane of veda's own gate by hand.** veda's lanes are in `agnipariksha.json` at the root,
  each on the `tap` runner through `stryker/lane.mjs`. There is one per package, and a `scripts`
  lane for the root's `scripts/*.mjs` (all but `released-pins.mjs`, a hook file). That lane runs
  from the root, and `stryker/scripts.config.mjs` keeps its sandbox to `scripts/`,
  `package.json` and `agnipariksha.json`. Judge files by hand with
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
- **A `--mutate` range is not one mutant.** Stryker mutates every node inside the range, so
  the range of an outer mutant (a BlockStatement, a function) takes in every mutant nested in
  it. A retry of one such `cli.ts` Timeout ran 54 mutants in 156 s at `--concurrency 1`. To run
  one mutant, add an ignorer that drops each node strictly inside its span (Stryker drops the
  node's subtree with it) and exclude the file's other mutators. The node's other replacements
  from its own mutator still run: no Stryker option selects finer. agnipariksha's timeout retry
  does this (`src/retry-ignorer.ts`).
  <!-- held by: agnipariksha's timeout retry (retry-ignorer.ts, its retry config) -->
- **Ignorers and Babel locations.** An ignorer's `shouldIgnore(path)` sees Babel locations:
  lines 1-based, columns 0-based. Stryker's JSON report counts both from 1, and `--mutate`
  takes report lines with 0-based columns. An ignorer that ignores an ancestor of the mutant
  you want ignores that mutant too.
- **Static mutant cost depends on test order.** Under the Vitest runner a static mutant runs all
  related files with bail, and Vitest's default sequencer orders files last-failed first, then
  longest, from each runner's own cache, so the cost depends on where the killing file sits. A
  custom Vitest sequencer that puts the mutated file's owning suite first keeps verdicts
  identical and cut one mutant phase from 143 s to 14 s. For a slow or Timeout static mutant,
  first find which file kills it and its position (`testsCompleted` in `mutation.json`).
- **Stryker's default margin floods spawn-heavy suites at full concurrency.** A mutant's limit
  is `timeoutFactor` × the dry run's net time + `timeoutMS` (1.5 and 5 s by default) + the dry
  run's measured overhead, which Stryker prints with the net time. The dry
  run times the suite alone; the mutants then run at 17 runners at once. A suite that spawns
  processes slows 2 to 6.5× under that, so its killed mutants overrun a limit set from the
  quiet run and come back as Timeouts. pariksha's `doc-references-gate.ts` gave 526 Timeouts
  where 6 were hangs, each costing a serial retry. A fixed floor fixes it, and a larger factor
  does not: the dry run's net time swung from 8 to 48 s on one file, and a factor also stretches
  every retry. Fewer runners make each mutant faster but the run slower overall. veda's lanes
  set `timeoutMS: 90_000` in `stryker/lane.mjs` (veda#461). A hang that hits Stryker's loop
  counter ("Hit limit reached") ends before any limit, so the floor costs only wall-clock
  hangs. To tell a flood from hangs, rerun with `--timeoutMS 120000 --timeoutFactor 0`: real
  hangs stay Timeouts, and the slowest Killed mutant shows how much room the limit needs.
- **Incremental mode and test edits.** Incremental mode reuses results for unchanged or
  source-edited files, but when a file's covering test file changes it re-runs every mutant
  those tests cover, so near-zero reuse on test-editing pushes is expected, not a bug. The dry
  run always runs, so even full reuse costs a fraction of a full run.
- **A test that swallows stdout hides failures from the tap runner's bail.** Under Stryker's
  `tap` runner the test reporter's TAP lines go to stdout, so a test that replaces
  `process.stdout.write` with a function that discards its input discards them too. If such a
  test then hangs, the `not ok` of an earlier failed test never reaches the runner, `forceBail`
  never fires, and the mutant costs its full 180 s retry. A capture must write through to the
  real `write`. Even with every test passing, a discarding capture can fail the dry run: it
  loses the queued `ok` line of the test before it, the subtest ends short of its plan, and
  tap-parser marks the file failed with no test named ("There were failed tests in the initial
  test run: src/supervisor.test.ts", veda#437). Plain `node --test` passes, since its results
  do not travel over the file's stdout. A mutant that hangs an async test also needs a
  per-test `timeout` (15 s in agnipariksha's `src/cli.test.ts`), and every polling loop in a
  test needs a deadline, or the failed suite never exits.
- **A promise a mutant leaves unsettled hangs its test to the gate's limit.** A test that awaits
  such a promise (a `resolve` the mutant drops, a loop that never ends) and has no `timeout`
  runs to the gate's limit: 90 s in the lane run, then 3 minutes in the retry. Give every test
  a `timeout`; a wrapper that sets a default does it once (`packages/dvara/src/cli.test.ts`
  gives each case 30 s). Give the suite an exit guard for handles a mutant leaks: in `after`, an
  `unref`'d timer that exits 1 if the process is still alive 5 s after the last test, so the
  mutant reads Killed, not Timeout. veda#654 did both, and bounded the loops in `replay`, after
  two such hangs cost its dvara lane two full retries. The bullet above has the per-test
  `timeout` agnipariksha's own `src/cli.test.ts` sets.
- **List a lane's timeouts with a direct Stryker run.** agnipariksha 0.8.13 and earlier (veda's
  root pins 0.8.11) runs each timeout retry with the lane's own JSON report path (`judgeLane`
  in `packages/agnipariksha/src/lanes.ts` passes `report` to every retry's config), so every
  retry overwrites `reports/agnipariksha/<lane>.json`. CI's `mutation-*` artifact, uploaded on a
  failed lane, then holds only the last retried mutant: on veda#654 it named one timeout of 33.
  To list every timeout, run Stryker directly from the package, in a heavy-work turn:
  `pnpm exec node scripts/turn.mjs --label 'stryker <pkg>' -- env AGNIPARIKSHA_SUITES=<suites> pnpm --dir packages/<pkg> exec stryker run stryker.config.mjs --mutate <files>`,
  from the root (kavach refuses a bare `node scripts/turn.mjs` in an agent session, and passes
  it through `pnpm exec`). Where a session coordinates mutation runs on the Mac, ask it first. Its
  `reports/mutation/mutation.json` keeps every status; that file is shared, so a concurrent hand
  run overwrites it. veda#706 changes the retry to write its own report, and rewrites this
  bullet when it lands.

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
- **Under a gate, every test runner shares TMPDIR.** Stryker's test runners all inherit the
  run's one TMPDIR, so a test that lists `tmpdir()` before and after an action flakes under a
  gate: other runners create and remove `agnipariksha-tmp-*` folders in it meanwhile. The flake
  then kills mutants that change nothing, so the score overstates the suite. Give such a test a
  TMPDIR of its own. To reproduce the flake, run N copies of the suite at once under one shared
  TMPDIR, outside the repository: run inside it, the tests that check a run outside a
  repository find one and start a real gate.

## Killing survivors without suppressing them

- **`// Stryker disable` is refused.** agnipariksha doesn't count Ignored mutants, so one
  `// Stryker disable …` or `/* Stryker disable … */` comment would take its file's mutants out
  of the gate, and the sources the gate mutates aren't guard files, so only review would
  catch it. Kill the mutant, or make the code observable (below). An unkillable pattern goes in
  agnipariksha's `arid-nodes.mjs`, which explains each one. `// Stryker restore` and a comment
  that only mentions the directive are fine. Inline ESLint config is off in linted code, so
  neither `eslint-disable…` nor `/* eslint no-warning-comments: "off" */` turns the ban off. An
  exception to any lint rule goes in `eslint.config.js` or `eslint-suppressions.json`, guard
  files that change only under a slice Alok approved naming them.
  <!-- held by: eslint.config.js, no-warning-comments (terms "stryker disable", location start) with linterOptions.noInlineConfig on MUTABLE (the linted trees, every JS and TS extension); scripts/stryker-disable-lint.test.mjs -->

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
