# @veda-hq/sarathi

सारथि, charioteer. Runs a project's Claude Code hooks from one settings entry
per event, with [kavach](../kavach)'s guards built in, and carries the
sarathi plugin's agents. Part of [Veda](https://github.com/veda-hq/veda).

## Why a package and not only a plugin

A Claude Code plugin cannot carry permissions or environment (a plugin's
settings apply only `agent` and `subagentStatusLine`), and a cloud session
does not install the plugins a repository lists, because that needs the
folder-trust dialog a cloud session never shows. A pinned package installs
wherever the repository's dependencies do: a laptop, a cloud session, a second
repository. So the hooks run from the package, and the plugin carries what
only a plugin can: the agents.

## The hooks

The project's settings keep one entry per event that runs sarathi:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|NotebookEdit",
        "hooks": [{ "type": "command", "command": "npx --no-install sarathi hook PreToolUse", "timeout": 70 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "npx --no-install sarathi hook Stop", "timeout": 130 }] }
    ]
  }
}
```

and the handlers live in `.claude/sarathi.json`, in the shape of the
settings' own `hooks` block, one entry per handler:

```json
{
  "kavach": { "config": ".claude/kavach.json", "python": "python3" },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|NotebookEdit", "guard": "worktree" },
      { "matcher": "Bash", "guard": "command" },
      { "matcher": "Edit|Write", "command": "./scripts/check-edit.sh", "timeout": 10 }
    ],
    "Stop": [{ "command": "./scripts/keep-going.sh", "timeout": 120 }]
  }
}
```

| Key | Meaning |
| --- | --- |
| `matcher` | Claude Code's: absent or `*` for all, `A\|B` for exact names, else a regular expression |
| `command` | Run through `sh -c` with the event on stdin, as Claude Code runs a hook |
| `guard` | `worktree` or `command`: kavach's guard, run by `kavach.python` with `KAVACH_CONFIG` set to `kavach.config` |
| `timeout` | Seconds before the handler and its children are stopped (60) |
| `failClosed` | Any end but exit 0 refuses the call; always true for guards |

`sarathi hook <Event>` runs the matching handlers side by side and answers
Claude Code once, as Claude Code combines several hooks' answers: any exit 2
blocks with every blocker's reason; a fail-closed handler that crashes or
runs out of time blocks too; JSON answers merge with the strictest decision
winning (deny over ask over allow, block over none, `continue: false` over
true) and every handler's context kept; a handler that failed without
blocking is named in `systemMessage`, or on stderr with exit 1. A hook list
that cannot be read refuses `PreToolUse` and only warns on other events.

`sarathi check --settings .claude/settings.json` proves the settings run
sarathi for every event the list names, with a matcher that lets every
handler fire and a timeout at least the longest handler's. Run it in the
project's tests.

### Forbidden variables

Some switches turn a session's tooling off from the environment, where no
committed file can see them: `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` turns the
advisor off whatever the settings say. The hook list's top-level `forbidEnv`
names each such variable with why:

```json
{ "forbidEnv": { "CLAUDE_CODE_DISABLE_ADVISOR_TOOL": "this project works with the advisor on" } }
```

While one is set (anything but empty, `0` or `false`), `sarathi hook` refuses
every `PreToolUse` call before any handler runs, and at `SessionStart` and
`UserPromptSubmit` tells both Claude and the user why and how to fix it. Other
events are left alone. It acts only on events the settings route to sarathi.

## The plugin

`sarathi@veda`, from this repository's marketplace, carries two agents:
`sarathi:worker` (carries out one decided task end to end) and
`sarathi:researcher` (answers an external question with sources, read-only).

```sh
claude plugin marketplace add veda-hq/veda
claude plugin install sarathi@veda
```

Node 24 or later. MIT.
