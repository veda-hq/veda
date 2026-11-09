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

`records`, an object, holds the settings of `dvara records` and `dvara frozen`
(below). Each field is optional; an unknown one is an error.

| Field            | Default                        | Meaning                                                                                                                  |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `baseline`       | `.dvara/records-baseline.json` | the per-file baseline, relative to the root; read from git, so it must be tracked (un-ignore it if `.dvara/` is ignored) |
| `skip`           | `[]`                           | path prefixes no rule reads, such as a checker's own fixtures                                                            |
| `frozen`         | `{"paths": [], "except": []}`  | `paths`: prefixes `dvara frozen` refuses changing and no rule reads; `except`: exact paths under them that stay editable |
| `identityPaths`  | `[]`                           | regular expressions for the paths where a commit must be cited by its full id (read by a rule still to come)             |
| `repository`     | `null`                         | `owner/name` on GitHub, for that same rule                                                                               |
| `allowPaths`     | `[]`                           | regular expressions for machine paths that are durable by agreement, matched from where the path starts: anchor with `^` |
| `packageManager` | `null`                         | `pnpm`, `npm` or `yarn`: the other managers' install commands are refused; `null` checks none                            |

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

## The record gate: `dvara records`

Committed text should not cite what stops meaning anything once the session
that wrote it ends. The gate reads every text file that is not source code, a
binary, a skipped or frozen path, the baseline or the config, and refuses
(rule `EVIDENCE-02`, one finding per line):

- a `file://` URL, a `/Users/<name>` or `/home/<name>` home path, a sandbox temp
  root (`/private/tmp/`, `/private/var/`, `/var/folders/`), a literal `.git/`
  path, or an agent-process marker ("I am Agent 3");
- another package manager's install command, when `packageManager` names one.
  A clause that says not to ("never run `npm install`") is no finding.

Files written before the gate existed are held by the baseline: each file's
count per rule, which may only fall. A new finding in a legacy file, a fix that
leaves its allowance in place, an entry for a file that is gone or not read,
and a baseline edit that raises a count or adds a file are all refused; a
rename git detects carries its entry forward.

```sh
dvara records --staged                 # pre-commit: the index, against the first baseRefs that resolves
dvara records --base origin/main       # CI: the files the branch changed, at HEAD
dvara records --all [--base REF]       # every tracked file at HEAD
dvara records --all --write-baseline   # record today's counts
dvara records --all --survey           # counts per rule and check
```

Exit 0: clean or within the baseline; 1: refused; 2: could not run. Inside the
package the gate takes any list of rules, `(path, text, tree) => Finding[]`;
the command runs the list `rulesFor` in `src/records/rules.ts` returns, which a
rule for full commit ids (`EVIDENCE-01`, already a baseline rule id) will join.

## Frozen paths: `dvara frozen`

A path under one of `records.frozen.paths` is history: no commit adds, changes
or deletes a file there, except the exact `records.frozen.except` paths.

```sh
dvara frozen --staged                    # pre-commit, merge commits included
dvara frozen --base origin/main [--head REF]   # CI: what the branch changes since its merge base
```

In a merge, a path staged exactly as a merged-in parent has it is that
parent's change and passes; a hand resolution counts. With no frozen paths
configured it passes without asking git. Exit 0, 1 or 2 as above.

## Commands

```sh
dvara run <hook-file> [hook args…]   # run a git hook under the supervisor
dvara stages <hook>                  # the stages .dvara.json lists for it
dvara shell <stages|keep-going>      # the path of a shell helper
dvara records <--staged | --all [--base REF] | --base REF> [--write-baseline | --survey]
dvara frozen <--staged | --base REF [--head REF]>
dvara --version
```
