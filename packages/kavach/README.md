# @veda-hq/kavach

कवच, armour. Guards for coding agents: each tool call an agent makes is
judged before it runs. Part of [Veda](https://github.com/veda-hq/veda).

## v0.3: three guards and a rule-check engine

| Guard | Refuses | Entry point |
| --- | --- | --- |
| Worktree boundary | Any write outside the agent's own git worktree: a Bash command, an Edit or a Write. Read-only commands pass from any checkout. | `python3 python/kavach/worktree_guard.py` |
| Command guard | Git-hook bypasses (`--no-verify`, `core.hooksPath`…), history-destroying pushes, and the project's own command rules (settings below). | `python3 python/kavach/command_guard.py` |
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

## Settings

`KAVACH_CONFIG` names a JSON file; unset, every project rule is off. A file
that cannot be read, is not JSON, or has an unknown key refuses every call.

```json
{
  "worktree": {
    "trustedCommands": [
      { "script": "scripts/worktree.py", "pattern": "python3 scripts/worktree\\.py (?:status|retire --pr [1-9][0-9]*)" }
    ]
  },
  "command": {
    "protectedVariables": ["AGENT_REMOTE"],
    "protectedVariablesReason": "it marks a hosted session; leave it as the session set it",
    "pairedChanges": [
      { "changes": "schema.sql", "requires": "changesets/", "reason": "a schema change needs its changeset" }
    ]
  }
}
```

- `trustedCommands`: a script in the repository that may run from the agent's
  own worktree although its writes cannot be read off its command line. The
  pattern must match the whole command; trust only command lines of plain
  words (a whole line with any shell metacharacter is never trusted by its
  pattern alone).
- `protectedVariables`: environment variables a command may not assign, declare or
  export.
- `pairedChanges`: a commit that may record a path ending in `changes` must
  also certainly record a path containing `requires`. With no entries the
  rule is off, and a commit whose repository the guard cannot resolve is no
  longer refused for that reason alone (`--no-verify` and the rest still are).
  Keep a CI check behind it: the guard reads one command line, not the files
  other programs change.

## Refusal log

Each refusal of the two Python guards appends a row (time, guard, tool, first
line of the reason, start of the command) to
`<git common dir>/kavach/refusals.jsonl`. It is best effort and never changes
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
