# Testing

Lessons from test suites that agents write and run under load: Vitest behaviour, clocks and
wall-clock budgets, how to reproduce a flake that only happens on a busy machine, processes and
signals, git fixtures, Postgres and Docker in tests, and assertions that cannot fail.

## Clocks and wall-clock budgets

- **Freeze the clock; do not widen the assertion.** A test asserting an exact value computed
  from `deadline - Date.now()` flakes on loaded runners, and widening it to a range is vacuous
  when production clamps the value. Freeze the clock with
  `vi.useFakeTimers({ shouldAdvanceTime: false })` so the assertion stays exact. For a shared
  budget, burn a known slice with `vi.setSystemTime(Date.now() + N)` in a mocked collaborator and
  assert `CONSTANT - N`, and prove sensitivity with a temporary production mutation.
- **`expect.poll` advances fake timers.** Under fake timers, Vitest's `expect.poll` and
  `vi.waitFor` call `vi.advanceTimersByTime(interval)` on every retry, so polling fires the fake
  deadline you meant to hold back. Wait with a recursive helper on `node:timers/promises`
  `setTimeout` instead, and anchor the fake deadline on an observed event before advancing
  timers yourself.
- **Pin Fastify's `elapsedTime`.** A timer can read a hair under its delay against Fastify's
  clock, and fake timers do not reach `reply.elapsedTime`, so a sleep-based latency assertion
  flakes under load. Pin it in a test-only `onRequest` hook with
  `Object.defineProperty(reply, 'elapsedTime', { get: () => 1234 })` and assert the exact value.
  Add the hook before `ready()`, since Fastify refuses `addHook` after it.
- **Budget flakes come from stalls, not load.** A test with a wall-clock budget fails on rare
  multi-second stalls, not on steady load, so a 0/N loop at high load proves nothing. Log the
  deadline-to-event window per run, then reproduce deterministically with a shim first on the
  fixture's `PATH` that sleeps about 1.5 s before exec-ing the real binary (`git`, or `node` via
  `process.execPath`); it slows every process start with no CPU burners on a shared machine.
  Fix by making no assertion wait on the budget, or by re-arming the budget on an observed
  event, never by widening it; prove the fix with the same shim on the old and new test.
- **Anchor a lock-wait budget on the opponent.** A lock-wait budget that starts before a child
  process spawns measures load, not the property under test. Start it on an observed event of
  the opponent (its connection or its ungranted lock) and keep it inside the barrier's own
  lifetime. Reproduce with an env-gated start-up delay rather than CPU load, and race the budget
  against `promisify(execFile)`, because killing the child does not settle it while a grandchild
  still holds the stderr pipe.

## Reproducing load flakes

- **Check swap before measuring latency.** Load average counts runnable threads, not page-ins,
  so latency numbers taken on a swapping Mac run 3 to 5 times slower and are not comparable.
  Snapshot `sysctl vm.swapusage`, free memory and per-process RSS before any timing
  measurement, measure only when swap is not near full, and record swap alongside load in the
  evidence.
- **CPU burners do not reproduce starvation.** Busy-loop burners slow node plus tsx cold starts
  only about 3x, while several concurrent real test runs slow them 6 to 20x through module I/O,
  memory pressure and process churn. Reproduce load bugs with real concurrent runs plus a
  child-side mark hook that separates slow start from slow exit. Validate CLI arguments before
  importing heavy modules. `vi.doMock('vitest/node')` does not intercept a child's import; assert
  ordering with a `module.registerHooks` resolve hook instead.
- **Emulate a CPU share for jsdom timeouts.** To reproduce an in-process jsdom test timeout
  without loading the machine, add a setup file whose 2 ms unref'd `setInterval` reads
  `process.cpuUsage()` and blocks with `Atomics.wait` for (F-1) times the CPU used, giving wall
  time of about F times CPU. jsdom's `getComputedStyle` under every role query is the usual cost:
  cut CPU (narrow queries, direct DOM reads) rather than raising the timeout. Treat failures
  right after a timed-out test as collateral, since it keeps running into the next test.
- **Freeze your own processes with SIGSTOP.** CPU hogs rarely starve a Vitest worker's event
  loop, but freezing the test's own processes with SIGSTOP and SIGCONT (stops of roughly 0.3 to
  1.5 s with short thaws) reproduces timer-versus-exit races. Scope the freezer to descendants
  of a run it spawns itself so other sessions are never frozen, and afterwards check for
  orphaned freezers and still-stopped processes. The usual root cause is a timer racing an
  already-pending libuv event; fix by deferring the decision one check phase (`setImmediate`).
- **A suite's cost is its spawn count.** A suite that drives a CLI spawning many git processes
  starves by process-start count under load (each git start can take 0.2 to 0.6 s), not by any
  slow scenario. Split it into one Vitest case per scenario (`it.each`) with a SIGKILL spawn
  limit below the test timeout rather than raising budgets, and find the cost with a `PATH` git
  shim that logs each call's start and end.
- **Count budgets are speed numbers.** A budget for a shell-suite chunk computed as per-case
  time multiplied by the number of cases trips under load, because per-case cost varies
  tenfold; use one generous, env-scalable hang guard instead. Killing a bash suite with SIGTERM
  runs its EXIT trap, so end-of-run count checks fire on a partial count and read as real
  failures: have the TERM/INT trap set a flag and exit, and the EXIT trap report "Interrupted
  after case N".

## Vitest behaviour

- **Coverage that differs between identical runs.** Diff `coverage-final.json` statement by
  statement first, then suspect `Math.random` defaults in sampled code (such as session replay),
  fake timers that do not fake `Date` (`vi.advanceTimersByTime` does not move `Date.now()` unless
  `Date` is in `toFake`), and fetches still in flight when React Testing Library unmounts. It
  happens at one worker too, so it is not contention; hunt with `--coverage` on.
- **Worker counts and Turborepo env.** Vitest 4 honours `VITEST_MAX_WORKERS` over a config
  `maxWorkers`, but Turborepo strict env mode strips it unless it is listed in
  `globalPassThroughEnv`. Vitest 4 removed `poolOptions`, so `poolOptions.forks.maxForks` is
  inert, and with no `maxWorkers` the pool picks `availableParallelism - 1` at run time. Measure
  each package's worker-scaling knee before raising caps, and check with `turbo --dry=json` that
  every named task really runs (root-only scripts show as nonexistent workspace tasks).
- **File order is per checkout.** Vitest's default sequencer orders test files from each
  checkout's own results cache (last failed first, then longest), so the same sequential
  integration suite runs in a different order per worktree, and order-dependent pollution
  masquerades as an environment difference. Tell order from flake with
  `--sequence.shuffle.files --sequence.seed=N`: identical failures on two same-seed runs rule
  out flakiness. Give suites that read global state their own database.
- **`testTimeout` cannot interrupt a sync spawn.** `execFileSync` or `spawnSync` blocks the
  worker's event loop, so the timer cannot fire: the test fails only after the child exits past
  the limit, and a real hang never reports a timeout at all. A sync spawn given a large `input`
  can hang forever under load; pass the data through a temp file path instead. Give a sync
  spawn `killSignal: 'SIGKILL'` with its `timeout` (shuddhi's `spawn-timeout` already refuses a
  test's sync spawn without a `timeout`), and for long shell-outs
  use async spawn with a per-case budget and a process-group kill. Read such a timeout as a slow
  finish and re-run alone. Telemetry written only when a hook exits hides such hangs, so count
  in-progress runs too.
- **`unstubEnvs` drops `beforeAll` stubs.** With `unstubEnvs: true` in the Vitest config,
  stubbed env is restored before every test, so a `vi.stubEnv` made in `beforeAll` is gone by the
  first test. Stub env in `beforeEach` or in the test; direct `process.env` writes in `beforeAll`
  are unaffected.
- **A mock's call index is not its identity.** Never assert on `mockFn.mock.calls[0]` for a
  module-level mock: runners that execute many files in one process (a Stryker dry run, a
  flaky-test detector) can put a foreign call at that index. Filter calls by what they are and
  match exactly (`call[0] === PATH || call[0].startsWith(PATH + '?')`), since a bare
  `startsWith` readmits sibling endpoints.

## jsdom and render cost

- **`*ByRole` queries cost `getComputedStyle`.** In jsdom, every `*ByRole` query runs
  `getComputedStyle` per candidate for the hidden check and accessible name, which is slow on
  large trees. Query roles once with `getAllByRole` and assert on the result, or pass
  `hidden: true` when visibility is not under test. Profile a slow render test with
  `vitest run <file> -t <name> --pool=forks --maxWorkers=1 --execArgv=--cpu-prof` before raising
  its timeout.
- **Profiling a whole test file.** Node's `--cpu-prof` flushes only for single `-t` Vitest runs.
  To profile a whole file, import it from a scratch wrapper that calls `node:inspector`
  Profiler start and stop in `beforeAll` and `afterAll`, and count React commits with a
  `__REACT_DEVTOOLS_GLOBAL_HOOK__` `onCommitFiberRoot`. On a loaded host whole-file timings
  swing up to 2x, so trust only same-process alternating A/B pairs.

## Processes, signals and pids

- **A test that kills by scan is a kill switch.** A test that signals processes found by a real
  system-wide scan becomes a kill switch under mutation testing: a mutant widening the filter
  sends SIGTERM to every user process, the editor session included. Restrict any test's scan and
  kill set to pids it spawned and use impossible pids for fake records. If a session dies
  repeatedly at the same stage of a gate, suspect the gate.
- **`ps -o lstart=` pads with spaces.** macOS `ps -o lstart= -p <pid>` pads its output with
  trailing spaces, so a stored start time never equals a fresh read. Normalise both
  (`tr -s ' '` and trim, or `.trim().replace(/ +/g, ' ')` in TypeScript) before comparing to
  detect pid reuse.
- **A ready file exists before its pid is written.** `echo $$ > ready` creates the file before
  writing the pid, so a test that waits for the file and reads it can get `''` and pid 0, and
  `process.kill(0, sig)` signals the test's own process group. Read a recorded pid only once the
  line is complete (`/^[1-9]\d*\n$/`) and refuse pid `<= 0` before any kill. On macOS
  `kill(pid, 0)` succeeds against a zombie, so an ESRCH poll needs the process reaped.
- **`sh` can reap the child before it execs.** A test zombie built as
  `sh -c 'short & ...; exec sleep'` occasionally loses its zombie on a loaded Linux (dash),
  because the shell can reap the child before it execs. Start a long-lived child, poll
  `ps -o comm= -p <parent>` until the parent has exec'd, then SIGKILL the child, so its death
  depends on an observed exec rather than a delay.
- **Two-read liveness flips across a reap.** A liveness helper that does `kill(pid, 0)` then
  `ps`, and treats an empty `ps` read as alive, is non-monotonic: a reap between the two reads
  makes a just-killed zombie read alive again, so wait-until-gone-then-assert-gone flakes. On an
  empty `ps` read, re-probe `kill(pid, 0)` (ESRCH means gone). Reproduce in a Linux container
  whose PID 1 reaps on a 0 to 20 ms sweep, not with `--init`, which reaps instantly.

## Fixtures and the real checkout

- **Hermetic git in fixture repositories.** Global git config (for example a
  `trace2.eventtarget` daemon) and git's own detached auto-maintenance can write into a test's
  temporary fixture repository after the commit returns, so teardown fails with ENOTEMPTY. Run
  fixture git with a hermetic env: point `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` at
  `/dev/null`, set `GIT_TRACE2*` to 0, delete the `GIT_DIR` family plus `GIT_CONFIG`,
  `GIT_CONFIG_COUNT` and `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*` (the count family overrides
  the masks), and pass `-c maintenance.auto=false -c gc.auto=0`.
- **Fixture commits need an identity on CI.** With global git config masked, macOS
  auto-detects a committer identity but Linux CI does not, so a fixture commit, merge or rebase
  dies with "Committer identity unknown" only in CI (a merge exits before writing MERGE_HEAD).
  Give every fixture git write `-c user.email=... -c user.name=...`, assert the fixture's shape
  (`git rev-parse --verify -q HEAD^2` after a merge), and reproduce locally with
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.useConfigOnly GIT_CONFIG_VALUE_0=true`.
- **`.DS_Store` sweep.** Code that treats every `readdirSync` entry as a folder fails with
  ENOTDIR on a Mac checkout holding Finder `.DS_Store` files, and grep review misses callers.
  Prove a fix by planting `.DS_Store` in the root and every
  `git ls-tree -d -r --name-only HEAD` directory from a script that records the list, run the
  suites that list directories, then remove exactly the recorded plants before any push.
  `.DS_Store` is usually gitignored, so `git status` stays clean either way.
- **Suites that write into the checkout.** When some suites write throwaway files into the real
  checkout mid-run, a test that checks the live tree's git status against a second read races
  them and flakes both ways. Take the oracle from the same git read the code under test made
  (wrap its git I/O and capture the call), never a fresh read; reproduce with a toggler that
  creates and deletes a file every 20 ms.
- **Tooling tests can pin a file's path.** A test file's path can be pinned by tooling tests
  elsewhere that assert it still exists, so deleting or renaming it passes pre-commit and fails
  only at the later full tooling run. Before deleting any file, `git grep -ln` its
  repository-relative path. Treat hits in validator tests as live and hits in docs or synthetic
  fixtures as inert, and replace a live pin with a sibling the same glob reaches.

## Postgres and connection pools

- **`backend_start` does not count pools.** Distinct `pg_stat_activity` `backend_start` values do
  not count pool instances: pg-pool reaps idle clients after 10 s (`idleTimeoutMillis`) and
  destroys clients whose query errored, so one pool shows many start times. Label each instance
  instead. pg-boss passes unknown options to `pg.Pool` and only defaults `application_name` when
  absent, so ``application_name: `pgboss|${pid}|${seq}` `` gives a direct count.
- **pg-boss brings its own pool.** pg-boss creates its own `pg.Pool` (default max 10) beyond
  Prisma's `connection_limit`, so each booted test app costs both against `max_connections`, and
  overlapping runs on one shared Postgres hit `FATAL 53300` "sorry, too many clients already".
  Cap pg-boss's pool in tests and size per-worker pools against `max_connections`. Grep the log
  for "too many clients" before suspecting the branch, and gate a retry on a quiet machine.
- **A server freeze, not a lock leak.** With Prisma, a train of hook timeouts followed by new
  connections failing at about 5 s with "Can't reach database server" across many test files at
  once is a database server or host freeze (`docker pause` reproduces it), not a lock leak or
  code bug; connection exhaustion instead fails in milliseconds with "Too many database
  connections". Fix it with push or test concurrency, not per-file timeouts, and check any
  failure tally against Vitest's own "Tests N failed" line.
- **`DROP DATABASE` forces a checkpoint.** In PostgreSQL 16, `DROP DATABASE` forces a
  cluster-wide immediate checkpoint, so its time depends on fsync under disk contention from
  other databases, not on the database dropped. A suite dropping its own database in a 30 s
  `afterAll` times out under load, and raising the hook timeout only moves the cliff. Defer
  drops to the end of the run and issue them concurrently (a small pool) so they share
  checkpoints; `CREATE DATABASE ... TEMPLATE` forces none.
- **Loopback inside the container trusts any password.** The official postgres image's
  `pg_hba` trusts the local socket and `127.0.0.1` / `::1`, so a password probe run inside the
  container over loopback accepts any password while real host connections are checked. Probe
  with `psql -h "$(hostname)"`, and confirm the probe rejects a deliberately wrong password before
  trusting it.
- **`pg_isready` over the socket passes mid-init.** A Postgres container healthcheck of
  `pg_isready` over the Unix socket passes against the image entrypoint's first-boot temporary
  server (`listen_addresses` empty), so `compose up --wait` returns mid-init and the next `psql`
  sees "the database system is starting up" or "shutting down". Probe over TCP
  (`pg_isready -h 127.0.0.1`) so healthy means the real server accepts connections.

## Docker

- **Relabelling a Compose volume.** A Compose volume's labels are part of its config hash, so
  changing labels or driver options on an existing volume makes `docker compose up` ask
  "Recreate (data will be lost)?"; with stdin ignored it declines and keeps the data, while a
  relabelled network is silently recreated. Only label a volume that is absent or already
  labelled, and do not rely on `docker events` to attribute past removals (its buffer holds
  seconds).
- **Address pools exhausted by leaked networks.** "all predefined address pools have been fully
  subnetted", or `compose up --wait` failures, means leaked networks from killed test runs
  filled the default pools (about 31 networks). Count networks with no containers via
  `docker network ls` plus `inspect`, remove only empty ones you own (others need their owner's
  yes), and never run a blanket prune.
- **The VM disk is not the host disk.** On macOS the container engine's VM disk is separate from
  host free space: "no space left on device" during an image build, or every Postgres container
  exiting 1 with "could not write block" in its log, means the VM disk is full. Diagnose with
  `docker system df` (and `nsenter -t 1 -m` into the VM for real free space). Reclaim with
  `docker builder prune -f`, then `-af` if reclaimable is 0B, then unused images. Never prune
  volumes, which hold other checkouts' databases.
- **A socket that accepts and never answers.** A Docker daemon or Postgres behind a VM port
  forward (for example OrbStack with its VM asleep through a DarkWake, or a paused container)
  can accept TCP connects and never answer, so a bare TCP-connect readiness check passes while
  `docker info` or `psql` hang silently, and stage timings include system sleep. Probe Postgres
  with an SSLRequest handshake, set `PGCONNECT_TIMEOUT`, bound every Docker call with a deadline
  that kills the process group, and correlate a slow stage with `pmset -g log` before calling it
  a regression.

## Frameworks under test

- **A Nest handler spy after `init()` is vacuous.** In NestJS, `vi.spyOn` on a controller method
  after `app.init()` never sees calls, because Nest bound the original handler when it built the
  route, so a "handler never ran" assertion on that spy passes vacuously. Prove the handler was
  not reached by an effect it has (a logger spy, a row unchanged before and after), or spy
  before `compile()` or `init()`.
- **supertest binds the IPv6 wildcard.** supertest given an unbound server binds it with
  `listen(0)` on the IPv6 wildcard and dials `127.0.0.1`, so any other process holding that IPv4
  port answers instead (a stray 400 from a local proxy, not your app). Bind the server to
  `127.0.0.1` explicitly before handing it to supertest. To diagnose a random-status flake, print
  the response body rather than theorising.
- **`Prisma.JsonNull` in `toMatchObject` matches anything.**
  `expect(row).toMatchObject({ col: Prisma.JsonNull })` passes for any stored value, because
  `JsonNull` is a class instance with no enumerable keys. Assert the sentinel directly with
  `expect(row.col).toBe(Prisma.JsonNull)` (the same for `DbNull`), and check a new
  mutant-killing test by hand-applying the mutant and watching it fail.

## Tests that can fail

- **A fail-closed gate must say why it closed.** Count "never answered" (unreachable model,
  credential error) as its own outcome, never as a miss. When a benchmark or eval shows every
  candidate failing identically, probe one raw call end to end before believing it: uniform
  failure is almost always one shared environment fault, not independent quality results.
- **Assert on the real artifact.** When a fix targets a specific real artifact (a log line,
  payload or diff), the acceptance test asserts on that artifact verbatim; if the fixture has to
  be edited to pass, fix the code instead. When a lint has an escape hatch, test the negative
  direction at once, and treat any test comment explaining why the fixture differs from reality
  as the bug report.
- **Mutation-verify every new assertion.** Assertions that pass for the wrong reason (matching
  a string present everywhere, a bare length check, a fake that derives the value the same wrong
  way) evade inspection. When `undefined` carries two meanings (absent against lookup failed),
  replace it with an exhaustive discriminated union instead of patching one branch per review
  round.
- **Merged and tested is not running.** Merged, self-tested and documented does not mean it
  runs: verify a subsystem is live by tracing who calls it (`git grep -l <module>`) and what
  populates every input it reads. A silent fallback path makes a broken integration look
  identical to a working one, so make degradation log loudly.
- **Let the failure carry the value.** `expect(x).not.toBeNull()` after an `exec()` hides the
  string that failed to match; assert with `toMatch(pattern)` on the string itself, so the
  failure log shows what was there.
