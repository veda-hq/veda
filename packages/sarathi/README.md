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

### Handlers it carries

Every `command` runs with `SARATHI_HOOKS` set to the package's `hooks/`
folder, which holds handlers any TypeScript repository can list:

```json
{ "matcher": "Edit|Write", "command": "bash \"$SARATHI_HOOKS\"/code-quality-guard.sh" }
```

| Handler | Event | What it does |
| --- | --- | --- |
| `format-before-write.sh` | PreToolUse, `Edit\|Write` | Hands the tool prettier-formatted input, so the file is written formatted and Claude Code has no "hook modified your file" notice to keep in context. Never blocks. |
| `format-on-edit.sh` | PostToolUse, `Edit\|Write` | Formats the written file with prettier: the net for what the first one skips. Never blocks. |
| `code-quality-guard.sh` | PostToolUse, `Edit\|Write` | Refuses `@ts-ignore`, `@ts-nocheck`, `eslint-disable`, `any` and skipped tests in a `.ts`/`.tsx` edit. `.claude/`, `.agent/` and `docs/` are exempt. |
| `arch-guard.sh` | PostToolUse, `Edit\|Write` | Runs the repository's `.dependency-cruiser.js` on a `.ts`/`.tsx` edit that touches imports; refuses what it refuses, and refuses when it cannot run. `scripts/` is exempt too. |
| `session-dedupe-guard.sh` | PreToolUse, session starts | Refuses starting a session unless the conversation called `list_sessions` successfully in the last 15 minutes. |
| `lessons.sh` | PreToolUse `Bash\|Edit\|Write`; PostToolUseFailure | Shows a lesson whose `when` line matches the call ("Lessons at their moment"). Never blocks. |

They act on the session's checkout, the git toplevel of the event's `cwd`:
the desktop app runs a worktree session's hooks with `$CLAUDE_PROJECT_DIR`
set to the main checkout. They use that checkout's prettier and
dependency-cruiser, and the project checkout's prettier when a fresh worktree
has none installed. They need `bash`, `jq` and `git`;
`session-dedupe-guard.sh` runs `HOOK_PYTHON`, or `python3`.

### Lessons at their moment

A lesson changes what an agent does only when it is in front of the agent at
the moment it matters. A lesson doc marks such a lesson with a line at the
lesson's end, so the text and its trigger stay in one place:

```md
- **Address pools exhausted by leaked networks.** "all predefined address pools have been fully
  subnetted" means leaked networks from killed test runs filled the default pools ...
  <!-- when: error "all predefined address pools have been fully subnetted" -->
```

| Kind | Pattern | Tested against |
| --- | --- | --- |
| `error` | plain text, case and runs of whitespace ignored | a failed tool call's `error` (PostToolUseFailure: for Bash, `Exit code N` and the output) |
| `command` | a JavaScript regular expression | a Bash call's command, before it runs |
| `path` | a glob: `*` and `?` within a segment, `**` across segments | an Edit or Write call's file, relative to the session's checkout, before it runs |

A lesson is what athya_mono's "lessons nothing holds" counter counts, in
every `.md` file but `README.md`: a `### ` section, bullets inside it
included, up to the next heading; outside one, a column-0 `- ` bullet with
its indented lines, up to a column-0 paragraph. Put the `when` line at the
lesson's end, indented two spaces inside a bullet. One lesson may have several.
A `when` line in neither is a stray; `docProblems` reports strays, two lessons
sharing an id, and patterns that cannot fire. Fenced code is never read for
them. The lesson's id is its file and the slug of its heading or bold lead.
`<!-- held by: ... -->` lines, which name the check that holds a lesson, are
left out of the text shown.

`lessons.sh` reads the package's own `lessons/` (veda's
[`docs/lessons/`](../../docs/lessons), copied in at build) and each folder
given as an argument, and adds each matching lesson to Claude's context, at
most once per session. It never blocks. Every match appends a row to
`<git common dir>/sarathi/lessons/<session>.jsonl` (`SARATHI_LESSONS_DIR`
overrides the folder): `shown`, or `repeat` when the session had it already,
so the log says how often a lesson comes back after it was shown. A call that
matches nothing reads the docs and writes nothing.

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash|Edit|Write", "command": "bash \"$SARATHI_HOOKS\"/lessons.sh ./docs/lessons", "timeout": 10 }],
    "PostToolUseFailure": [{ "command": "bash \"$SARATHI_HOOKS\"/lessons.sh ./docs/lessons", "timeout": 10 }]
  }
}
```

The settings then need a `PostToolUseFailure` entry that runs
`sarathi hook PostToolUseFailure`.

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

## The working rules

`skills/working-rules/SKILL.md` holds the generic rules an agent follows to
carry a change from first edit to merge: run started work to merge, show then
push, commit and push without skipping or weakening checks, resolve review
threads only once the fix is on the remote, and when to stop and ask. A
project adds its own rules on top.

It ships in the package, so a project whose dependencies are installed can
load it every session with one import line in its `CLAUDE.md` (or in a file
its `CLAUDE.md` imports). Claude Code reads the import at session start, so a
checkout with no `node_modules` yet starts without it:

```md
@node_modules/@veda-hq/sarathi/skills/working-rules/SKILL.md
```

The plugin carries the same file as the skill `sarathi:working-rules`.

## The plugin

`sarathi@veda`, from this repository's marketplace, carries two agents,
`sarathi:worker` (carries out one decided task end to end) and
`sarathi:researcher` (answers an external question with sources, read-only),
and the `sarathi:working-rules` skill.

```sh
claude plugin marketplace add veda-hq/veda
claude plugin install sarathi@veda
```

Node 24 or later. MIT.
