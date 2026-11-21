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
- **A watchdog, if you want one.** `"watchdog": "dvara"` attaches the built-in
  watchdog to each run (below); any other value names a module of your own.
  It may stop a hung hook and decide the verdict. Without one, or when it
  fails to load, the hook runs exactly as it would anyway.
- **One slot per machine.** `dvara slot` runs a command with extra
  environment only while it holds a machine-wide slot, and without it
  otherwise, never waiting (below).

- **A stage list, if you keep one.** `stages`, or the JSON file `stageList`
  names (inside an installed package, say), gives each hook's stage names in
  order. A passing run that marks a stage its hook's list does not have, or
  marks one out of the list's order, is refused (exit 1) with the reason. So is
  a run of a hook in `stageListRequired` (default `pre-push`) that marks a
  stage and whose list file cannot be read, so a missing package never lets a
  push that ran its stages through silently; any other hook passes then, with a
  warning that its stages were not checked. A
  stage may be marked again where it stands, a name may
  appear more than once in a list, and dvara's own `startup` and
  `runtime-selection` need no entry. A run that marks no stage reads no list.
- **A push judges what git pushes.** Git picks the commits a push sends
  before `pre-push` starts; the hook's checks read the worktree. A run of
  `pre-push` (not a preflight) records HEAD when it starts and again when the
  hook ends, and a passing run whose HEAD moved in between (something
  committed, merged or checked out in the worktree mid-push) is refused
  (exit 1), naming both commits: push again. A HEAD that cannot be read at
  either end changes nothing. The refusal is the row's `error`.

Telemetry, quiet output and a watchdog that fails to load never change a
hook's verdict. Only a signal, an enforcing watchdog's stop, the stage list
and a HEAD that moved during a push do.

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

| Field               | Default                                          | Meaning                                                                                                            |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `historyDir`        | `.dvara`                                         | where the history, the quiet log and scratch files go                                                              |
| `quietHooks`        | `["pre-commit"]`                                 | hooks whose passing output is one line                                                                             |
| `watchdog`          | `null`                                           | `"dvara"` for the built-in watchdog, or a watchdog module of your own, relative to the root                        |
| `baseRefs`          | `origin/main`, `origin/develop`, `origin/master` | the refs tried for the base a run is judged against; to `dvara records`, every one that resolves is pushed history |
| `stages`            | `{}`                                             | each hook's stages in order, which a passing run must keep to; `dvara stages <hook>` prints them                   |
| `stageList`         | `null`                                           | a JSON file holding the same map instead, relative to the root and read when a run ends; not both                  |
| `stageListRequired` | `["pre-push"]`                                   | hooks a list file that cannot be read refuses; any other hook passes with a warning                                |
| `trailerKeys`       | `[]`                                             | the repository's own trailer keys, which `dvara trailers` checks beside git's                                      |

`records`, an object, holds the settings of `dvara records` and `dvara frozen`
(below). Each field is optional; an unknown one is an error.

| Field            | Default                        | Meaning                                                                                                                  |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `baseline`       | `.dvara/records-baseline.json` | the per-file baseline, relative to the root; read from git, so it must be tracked (un-ignore it if `.dvara/` is ignored) |
| `skip`           | `[]`                           | path prefixes no rule reads, such as a checker's own fixtures                                                            |
| `frozen`         | `{"paths": [], "except": []}`  | `paths`: prefixes `dvara frozen` refuses changing and no rule reads; `except`: exact paths under them that stay editable |
| `identityPaths`  | `[]`                           | regular expressions for the paths where a commit must be cited by its full id (`EVIDENCE-01`); none by default           |
| `repository`     | `null`                         | `owner/name` on GitHub: its commit URLs are this repository's, every other repository's are not checked                  |
| `allowPaths`     | `[]`                           | regular expressions for machine paths that are durable by agreement, matched from where the path starts: anchor with `^` |
| `packageManager` | `null`                         | `pnpm`, `npm` or `yarn`: the other managers' install commands are refused; `null` checks none                            |

The environment it reads: `DVARA_MODE=preflight` (a preflight's rows get kind
`preflight`), `DVARA_BACKGROUND=1` (started detached), `DVARA_MEASUREMENT_CONTEXT=manual-benchmark`,
`DVARA_BOOTSTRAP_SECONDS` (seconds the hook spent selecting its runtime before
starting dvara, counted as a stage), `DVARA_VERBOSE=1`. It sets
`DVARA_MEASURED_HOOK`, `DVARA_STAGE_FILE` and `DVARA_RECORD_FILE` for the hook.

## The built-in watchdog

`"watchdog": "dvara"` stops a hook that is provably deadlocked, and never one
that is slow. After a quiet window (no stage marker, no process starting or
exiting, no CPU time), it samples the hook's process tree with `ps` and its
open descriptors with `lsof`. It acts only on positive evidence: a leaf
process whose every open IPC channel leads to another idle process in the
same tree. Waiting on the outside world (a network peer, a daemon, a
terminal) or on a timed wait (`sleep`) is spared, and a measurement it cannot
read is never evidence.

In `enforce` mode, it stops the tree (SIGTERM, then SIGKILL after the grace
period). The run exits 124, its last stage gets the status `timed_out`, and
the diagnostics go under `<historyDir>/hangs/<run>/`, kept 14 days. In `report`
mode, it writes the diagnostics and leaves the hook alone.

| Variable                         | Default                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `DVARA_WATCHDOG`                 | `enforce`, or `report` on a CPU with efficiency cores, where enforcing is not yet verified; set `enforce`, `report` or `off` |
| `DVARA_WATCHDOG_IDLE_MS`         | `600000`: quiet this long before the deadlock check runs |
| `DVARA_WATCHDOG_EXTERNAL_IDLE_MS`| `3600000`: quiet on an outside wait before it warns      |
| `DVARA_WATCHDOG_SAMPLE_MS`       | `5000`                                                   |
| `DVARA_WATCHDOG_GRACE_MS`        | `10000`: from SIGTERM to SIGKILL                         |

It runs on macOS only. Elsewhere its row's mode is `unsupported`, and the hook
runs as it would without it.

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
binary, a lockfile (`*.lock`, `pnpm-lock.yaml`, `package-lock.json`), a
symlink or a submodule, a skipped or frozen path, the baseline or the config,
and refuses (rule `EVIDENCE-02`, one finding per line):

- a `file://` URL, a `/Users/<name>` or `/home/<name>` home path, a sandbox temp
  root (`/private/tmp/`, `/private/var/`, `/var/folders/`), a literal `.git/`
  path, or an agent-process marker ("I am Agent 3");
- another package manager's install command, when `packageManager` names one.
  A clause that says not to ("never run `npm install`") is no finding.

Where `identityPaths` match, it also refuses (rule `EVIDENCE-01`) a commit cited
by less than its full 40-hex id, since git lengthens abbreviations as history
grows and clones disagree on their length:

- `abbreviated-id`: a 7–39 hex token the line makes a commit (after a commit
  word, backticked on its own, in an `a..b` range, cut off with an ellipsis, or
  in a short commit URL of `repository`), unless the line names it another kind
  of hash (digest, sha256, checksum, …);
- `abbreviating-command`: a git command that prints abbreviations
  (`--oneline`, `%h`, `--abbrev-commit`, `rev-parse --short`);
- `unresolved-id`: a full id the change adds that is not a commit in this
  repository, compared with the ids the file cited at the merge base. No
  baseline holds these: they are new by construction.
- `unpushed-id`: a full id the change adds that is a commit here but on no
  pushed history: neither HEAD (nor, at pre-commit, a merge's other parent)
  nor any of `baseRefs` or `--base` reaches it. A commit made here and never
  pushed, or one on a branch since deleted, resolves in this clone and in no
  CI clone. One `git rev-list` answers for every citation. A shallow clone
  cannot tell where a commit stands, so it judges none. No baseline holds
  these either.

In Markdown, a fence's captured output is not read for tokens; its command
lines are (`$ ` lines of a transcript, every line of an `sh` fence). Fences are
found by CommonMark's rules (mdast-util-from-markdown), so a fence in a quote or
a list item counts.

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
the command runs the list `rulesFor` in `src/records/rules.ts` returns.

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

## Trailers: `dvara trailers`

Git reads a message's trailers only from its last paragraph, so a trailer
line above a blank line is prose to git: the commit lands without it, and
nothing says so. For a commit-msg hook, `dvara trailers <commit-msg-file>`
refuses (exit 1) a line whose key is `Co-Authored-By`, `Signed-off-by` or one
of `trailerKeys` or a `--key KEY` (any case, `Key: value` at the start of the line) in any
paragraph before the last, or in the title's paragraph, which git never reads
trailers from (so a message of one paragraph keeps none). The title line
itself is never judged. Each is named with its line number. The file is
read raw: comment lines (`#`) are dropped, the scissors line ends the
message, whitespace-only lines separate paragraphs and trailing ones start
none. Exit 2: bad arguments, or a config or file it cannot read.

```bash
#!/usr/bin/env bash
# .husky/commit-msg
exec node node_modules/@veda-hq/dvara/dist/cli.js trailers --key Slice "$1"
```

## Executable bits: `dvara exec-bits`

A tool that rewrites files and puts them back (Stryker's in-place restore, a
copy through a filesystem that keeps no modes) can drop the executable bit on
a file whose content it left alone, and `git add -A` then stages a
100755 → 100644 change that breaks the script for everyone. For a
pre-commit hook, `dvara exec-bits --staged` names each staged file that went
from 100755 to 100644 with the same blob, with the fix
(`git update-index --chmod=+x <path>`). It warns (exit 0, a `⚠` line a quiet
hook still shows) until `--refuse` makes it refuse (exit 1): a new hook
refusal warns first. A mode change that came with a content change is an
edit, and is not read. Exit 2: bad arguments, or git failing.

## Review size: `dvara review-size`

An AI reviewer skips a pull request over its line cap with a "skipped" check
(Cubic's cap is 50,000 reviewable lines), and a merge rule that needs its
pass can then never be met. For a pre-push hook,
`dvara review-size --cap N [--ignore GLOB]… [--base REF]` counts the lines
`<base>...HEAD` adds and deletes outside the reviewer's ignore globs
(`path.matchesGlob`; binaries count none, a rename counts under its new
path) and, over the cap, warns with the five largest files and how to split
the branch. The base is `--base`, or the first `baseRefs` entry that
resolves. It never refuses: exit 0 whatever it finds, or when it cannot tell
(no base, git failing), saying so; exit 2 only on bad arguments.

```bash
# .husky/pre-push, inside a stage
node node_modules/@veda-hq/dvara/dist/cli.js review-size --cap 50000 --ignore 'pnpm-lock.yaml' --ignore 'docs/**'
```

## A machine-wide slot: `dvara slot`

Some runs are fast alone and fatal together: four test suites at full width
can exhaust a machine that one at full width beside three at a fallback
width does not. `dvara slot` caps the machine at the case that is safe:

```sh
dvara slot --name <name> [--dir <dir>] [--set NAME=VALUE]… [--unset NAME]… -- <command> [args…]
```

It tries once, never waiting, to take the slot `<name>`:

- If it gets the slot, it runs the command with each `--set` variable and holds the slot until the command exits.
- If the slot is held, or anything fails, it runs the command without the `--set` variables.

Every run drops each `--unset` variable from the command's environment. It
does not try in CI, when a `--set` variable is already set (an explicit value
wins), or with `DVARA_SLOT=off`. It prints one line to stderr saying which.

The slot is the lock file `<dir>/<hostname>/<name>.lock` (`--dir` defaults to
`~/.dvara/slots`; `DVARA_SLOT_DIR` replaces the whole directory). It is
linked into place complete and removed when the command exits. A holder that
died without releasing it, or whose pid was reused (by its start time), is
reclaimed under `<name>.reclaim`. Each start is a JSON line in `slots.jsonl`
beside it. A forwarded SIGINT or SIGTERM decides the exit status, a command
that cannot start is 127, and bad arguments are 2.

## Commands

```sh
dvara run <hook-file> [hook args…]   # run a git hook under the supervisor
dvara stages <hook>                  # the stages .dvara.json lists for it
dvara shell <stages|keep-going>      # the path of a shell helper
dvara records <--staged | --all [--base REF] [--write-baseline | --survey] | --base REF>
dvara frozen <--staged | --base REF [--head REF]>
dvara trailers [--key KEY]… <commit-msg-file>  # refuse trailer lines git would not read
dvara exec-bits --staged [--refuse]  # warn on (or refuse) a dropped executable bit
dvara review-size --cap N [--ignore GLOB]… [--base REF]  # warn over a reviewer's line cap
dvara slot --name <name> [--dir <dir>] [--set NAME=VALUE]… [--unset NAME]… -- <command…>  # run with a machine-wide slot, or without it
dvara --version
```
