# @veda-hq/dvara

द्वार, gate. Git hooks for repositories coding agents work in: cheap checks at
commit, expensive ones once at push.

This release holds the runner every hook goes through. Your hook stays a bash
file in your repository; dvara runs it.

## What it does

- **One history row per run.** `dvara run <hook-file> [args…]` runs the hook
  under bash in its own process group and appends a row to
  `<historyDir>/history.jsonl`: kind, who started it (git, a person, a
  background preflight, a benchmark), exit code and status, each stage's start,
  duration and input, the base and tree it was judged against, the commits a
  push updated, and the hook's peak memory.
- **Signals reach the hook.** Ctrl-C, SIGTERM, SIGHUP and SIGQUIT are forwarded
  to the whole group. A run that was signalled is reported as cancelled, with
  the signal's exit code, even when the hook trapped it and exited 0, so an
  interrupted gate never lets a push through.
- **Quiet on success.** A hook listed in `quietHooks` (default `pre-commit`)
  prints its warnings and one line when it passes, and everything when it
  fails. The full output is kept in `<historyDir>/<hook>.log`.
  `DVARA_VERBOSE=1` streams it.
- **Keep-going mode.** For a preflight, a run of the push hook ahead of the
  push: each stage's `exit 1` is recorded and the hook carries on, so one run
  lists every failure.
- **A watchdog, if you have one.** `watchdog` names a module the supervisor
  attaches to each run; it may stop a hung hook and decide the verdict. Without
  one, or when it fails to load, the hook runs exactly as it would anyway.

Every one of these is fail-open: telemetry, quiet output and the watchdog never
change a hook's verdict.

## A hook under dvara

```bash
#!/usr/bin/env bash
# .husky/pre-push, or wherever core.hooksPath points
if [ "${DVARA_MEASURED_HOOK:-}" != "pre-push" ]; then
  exec node node_modules/@veda-hq/dvara/dist/cli.js run "$0" "$@"
fi
source node_modules/@veda-hq/dvara/shell/stages.sh
if [ "${DVARA_MODE:-}" = preflight ] && [ $# -eq 0 ]; then
  source node_modules/@veda-hq/dvara/shell/keep-going.sh
fi

dvara_stage lint
pnpm lint || exit 1
dvara_passed && echo "✅ lint"

dvara_stage test
pnpm test || exit 1

if [ "${DVARA_MODE:-}" = preflight ] && [ $# -eq 0 ]; then dvara_keep_going_report; fi
```

`stages.sh` gives the hook:

| Helper                          | Does                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `dvara_stage <name>`            | marks the start of a stage                                                                                  |
| `dvara_record <type> <fields…>` | a fact for the row: `stage-input <stage> <kind> <digest>`, `proof <check> <outcome> <ms>`, `proof-reason …` |
| `dvara_record_refs "$stdin"`    | the commits a push updates, from git's ref lines; never the ref names                                       |
| `dvara_passed`                  | false once after keep-going mode carried on past a refusal, to guard a "✅" line                            |

`keep-going.sh` adds `dvara_keep_going_held`, `dvara_keep_going_skipped` and
`dvara_keep_going_report`. `DVARA_KEEP_GOING_NAME` and `DVARA_KEEP_GOING_TITLE`
rename it in its messages (default "preflight" and "Preflight").

## Configuration

`.dvara.json` at the repository's root, or the file `DVARA_CONFIG` names. Every
field is optional; an unknown field is an error.

| Field        | Default                                          | Meaning                                                        |
| ------------ | ------------------------------------------------ | -------------------------------------------------------------- |
| `historyDir` | `.dvara`                                         | where the history, the quiet log and scratch files go          |
| `quietHooks` | `["pre-commit"]`                                 | hooks whose passing output is one line                         |
| `watchdog`   | `null`                                           | a watchdog module, relative to the root                        |
| `baseRefs`   | `origin/main`, `origin/develop`, `origin/master` | the refs tried for the base a run is judged against            |
| `stages`     | `{}`                                             | each hook's stages in order; `dvara stages <hook>` prints them |

The environment it reads: `DVARA_MODE=preflight` (a preflight's rows get kind
`preflight`), `DVARA_BACKGROUND=1` (started detached), `DVARA_MEASUREMENT_CONTEXT=manual-benchmark`,
`DVARA_BOOTSTRAP_SECONDS` (seconds the hook spent selecting its runtime before
starting dvara, counted as a stage), `DVARA_VERBOSE=1`. It sets
`DVARA_MEASURED_HOOK`, `DVARA_STAGE_FILE` and `DVARA_RECORD_FILE` for the hook.

## A watchdog module

```ts
export function createWatchdog(options: {
  rootPid;
  stageFile;
  hangsDir;
  runId;
  config;
}): {
  disarm(): void;
  stop(): void;
  summary(): { mode: string };
  enforced(): boolean;
};
export function resolveWatchdogConfig(
  env,
  platform,
  perfLevels: string[],
): unknown;
export function exitDisposition(
  summary,
): { code: number; status: string } | null;
```

## Commands

```sh
dvara run <hook-file> [hook args…]   # run a git hook under the supervisor
dvara stages <hook>                  # the stages .dvara.json lists for it
dvara shell <stages|keep-going>      # the path of a shell helper
dvara --version
```
