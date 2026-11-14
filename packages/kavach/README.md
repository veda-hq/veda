# @veda-hq/kavach

कवच, armour. Guards for coding agents: each tool call an agent makes is
judged before it runs. Part of [Veda](https://github.com/veda-hq/veda).

## v0.5: three guards and a rule-check engine

| Guard | Refuses | Entry point |
| --- | --- | --- |
| Worktree boundary | Any write outside the agent's own git worktree: a Bash command, an Edit or a Write; and, while a push runs, any write into it (below). Read-only commands pass from any checkout. | `python3 python/kavach/worktree_guard.py` |
| Command guard | Git-hook bypasses (`--no-verify`, `core.hooksPath`…), history-destroying pushes, and the project's own command rules (settings below). On trial, it warns of a message the shell would change (below). | `python3 python/kavach/command_guard.py` |
| Rule checks | The project's own checks, written in TypeScript, refusing or warning with the rule's reason. | `kavach-rule-checks` (`dist/rule-checks/cli.js`) |

The two Python guards read one Claude Code `PreToolUse` event on stdin. Exit
0 allows; exit 2 refuses, with `BLOCKED: <reason>` on stderr. Every other end
(a crash, a missing module, unreadable settings) refuses: Claude Code lets a
hook's exit 1 through, so a guard that fails must not allow. The rule-check
engine is the opposite by design: a check that crashes lets the call go
ahead with a warning, so a broken rule never stops every session.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "python3 node_modules/@veda-hq/kavach/python/kavach/worktree_guard.py" }] },
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "python3 node_modules/@veda-hq/kavach/python/kavach/command_guard.py" }] }
    ]
  }
}
```

Python 3.12 or later, standard library only. Node 24 or later. MIT.

## What "read-only" means

A Bash command passes from any checkout when the worktree boundary can prove
every part of it writes nothing: pipes, `sort`, `uniq`, `awk` and `sed`
without writing options or programs, input redirection, `2>/dev/null`,
`tee /dev/null`, `$(...)` and `<(...)` whose bodies are themselves read-only,
`for` loops over literal words, `xargs` running a read-only command, `[`,
`test`, read subcommands of `git` and `gh` (`gh api` with GET only). When it
cannot prove a command, it treats it as writing, and from outside an owned
worktree that refuses. An expansion that could become an option (`git log
$X`, where `X=--output=/elsewhere`) leaves the command unproven.

`corpus/corpus.json` is the adversarial test set: commands that write outside
the worktree, bypass hooks or force-push, each executed in real bash to prove
it does what its row says, and near-miss commands that must pass. Each guard
must refuse every attack row and pass every near-miss.

## What a refusal says

Each refusal names the way out. "mutation targets could not be resolved"
goes on to name what in the command the guard could not read (a redirection
into a file, a heredoc, a pipeline, a `;`/`&&` chain, `$(...)` or backticks,
an interpreter running a file such as `node <file>`, a program it does not
know), then the alternative: one plain command per call, files written with
the Edit or Write tools, and anything more as a script under the worktree's
`.tmp/` run through the repository's package runner (`pnpm exec tsx
.tmp/x.ts`). A write outside the worktree says where it aimed (the main
checkout, another worktree or its git folder, the repository's git folder, a
system temp folder) and where it belongs instead. The leading words of each
refusal are unchanged, so searches of older logs still match.

## Settings

`KAVACH_CONFIG` names a JSON file; unset, every project rule is off. A file
that cannot be read, is not JSON, or has an unknown key refuses every call.

```json
{
  "worktree": {
    "trustedCommands": [
      { "script": "scripts/worktree.py", "pattern": "python3 scripts/worktree\\.py (?:status|retire --pr [1-9][0-9]*)" }
    ],
    "readOnlyCommands": [
      { "pattern": "pnpm (?:health:check|(?:ls|list|why)(?: [A-Za-z0-9@][A-Za-z0-9@/._-]*)*(?: --depth [0-9]+)?)",
        "env": { "AGENT_REMOTE": ["true"] }, "reason": "the script and pnpm's listing commands only read" }
    ]
  },
  "command": {
    "protectedVariables": ["AGENT_REMOTE"],
    "protectedVariablesReason": "it marks a hosted session; leave it as the session set it",
    "pairedChanges": [
      { "changes": "schema.sql", "requires": "changesets/", "reason": "a schema change needs its changeset" }
    ],
    "shellExpansion": "warn",
    "shellExpansionRefusesFrom": "2026-11-21"
  }
}
```

- `trustedCommands`: a script in the repository that may run from the agent's
  own worktree although its writes cannot be read off its command line. The
  pattern must match the whole command; trust only command lines of plain
  words (a whole line with any shell metacharacter is never trusted by its
  pattern alone).
- `readOnlyCommands`: a command line you reviewed as only reading, though
  the guard cannot prove it (a package runner's script, say). It runs with no
  owned worktree, from a checkout's root only, and only while the hook's own
  environment holds one of the listed values for every variable in `env`,
  which is required. The pattern is matched as a trusted command's is. Keep
  the list to commands that write nothing however they are called, and
  name each option a pattern allows: a runner's own options after the
  subcommand (`pnpm ls -C elsewhere`, `--pnpmfile`) move or widen what runs.
- `protectedVariables`: environment variables a command may not assign, declare or
  export.
- `pairedChanges`: a commit that may record a path ending in `changes` must
  also certainly record a path containing `requires`. With no entries the
  rule is off, and a commit whose repository the guard cannot resolve is no
  longer refused for that reason alone (`--no-verify` and the rest still are).
  Keep a CI check behind it: the guard reads one command line, not the files
  other programs change.
- `shellExpansion`: `"warn"` (the default) or `"refuse"`, the mode of the
  rule on trial below. `shellExpansionRefusesFrom` (a day, `YYYY-MM-DD`) is
  only shown in its warning; nothing switches on that day. A kavach older
  than this rule refuses every call on these unknown keys, so add them only
  once the pinned kavach knows them.

## A rule on trial: messages the shell changes

In bash and zsh a double-quoted (or unquoted) message is expanded before git
reads it: ``git commit -m "fix `parse`"`` runs `parse` and commits "fix ",
`$(...)` does the same, and an interactive shell replaces `!word` from its
history. commitlint reads only the header, so the loss ships. The command
guard finds backticks, `$(...)` and `!word` (a `!` before a blank, `=`, `(`,
a closing quote or the end is left alone) in the value of `git commit` and
`git tag`'s `-m`/`--message`, and of `--body`/`-b` on `gh pr create`,
`comment`, `edit` and `review` and `gh issue create`, `comment` and `edit`.
Single quotes, an escaped `` \` ``, `-F <file>` and `--body-file` are fine,
and so is a value that is wholly one command substitution
(`-m "$(cat file)"`, `--body "$(git log -1 --format=%s)"`): its author meant
the expansion, so nothing is lost. A substitution or backticks inside other
text (`-m "fix $(foo) bar"`) still fire, except `$(cat <<'EOF' ... EOF)`,
the heredoc whose text arrives whole (with an unquoted delimiter only while
its body runs nothing). This rule lets that heredoc pass; the worktree
boundary still refuses any heredoc, so from a worktree use `-F <file>`.

A new refusal starts by warning, since a wrong one would stop every session
at once. In `"warn"` the command runs, and the guard answers on stdout:

```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse",
  "additionalContext": "kavach warning (refuses from 2026-11-21): the shell expands the backticks `parse` inside this double-quoted -m before git sees it, ..."}}
```

In `"refuse"` it exits 2 with the same reason. Either way each fire is a row
of the refusal log naming the rule (`commit-message-shell-expansion`) and the
mode, so the trial's fires can be read for wrong ones before it refuses. Any
other refusal of the same command comes first. While it warns, an error in
the rule's own detection allows the call and logs a warning row naming the
error's type; refusing, it fails closed, as every other check always does.

## While a push runs

A push's checks read the worktree it was started from, and an edit made
while they run either fails the push at its end or leaves it checking what
was not pushed. So while a push runs, the worktree boundary refuses writes
into that worktree: any Bash command it cannot prove read-only, run there
(a trusted command included), and any Edit, Write or NotebookEdit of a path
git does not ignore. Reads still run, and the file tools can still write
files git ignores (drafts, scratch); a Bash command that writes one is still
refused. The refusal names the push's pid and start. Commands that only reach
the network, such as `gh pr comment`, wait too: the guard cannot tell what an
unproven command writes.

It knows a push is running from the marker the project's pre-push hook
writes. Write it when a real push starts and clear it on every exit:

```sh
kavach-rule-checks push-marker write "$(git rev-parse --absolute-git-dir)" "$$"
trap 'kavach-rule-checks push-marker clear "$(git rev-parse --absolute-git-dir)" "$$"' EXIT
```

Each push gets its own marker, `kavach-push-in-progress.<pid>.json` in the
worktree's own git folder, naming its pid and start. A marker whose pid has
ended or now belongs to a later process blocks nothing, so a killed push
leaves no lock behind, and a push in another worktree never blocks this one.
Without the marker, nothing here changes.

## Refusal log

Each refusal of the two Python guards appends a row (time, guard, tool, first
line of the reason, start of the command) to
`<git common dir>/kavach/refusals.jsonl`; a rule on trial adds a row for
each warning too, and names itself in its rows (`rule`, `mode`). It is best effort and never changes
a verdict; `KAVACH_REFUSAL_LOG_OFF=1` turns it off. The rule-check engine
keeps its own fire log (`--fires-dir`).

## Rule checks

```sh
kavach-rule-checks --checks rules/checks.ts --registry rules/registry.json   # the hook
kavach-rule-checks count --registry rules/registry.json --json               # rules with no enforcer
kavach-rule-checks latency --rounds 5                                        # time the Bash hooks
```

A checks module exports `CHECKS`, a list of `Check` (`@veda-hq/kavach/rule-checks`):
an id, the events and tools it applies to, and a function returning a
refusal, a warning or nothing. A Bash command passes one named check when it
ends with `# rule-pass <id>: <reason>`; the pass is logged.
