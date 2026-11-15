# @veda-hq/sarathi

सारथि, charioteer. Runs a project's Claude Code hooks from one settings entry
per event, with [kavach](../kavach)'s guards built in, publishes claude.ai
pages for sessions without the Artifact tools, and carries the sarathi
plugin's agents. Part of [Veda](https://github.com/veda-hq/veda).

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
| `lessons.sh` | PreToolUse `Bash\|Edit\|Write\|Agent\|Task\|mcp__ccd_session__start_session`; PostToolUseFailure | Shows a lesson whose `when` line matches the call ("Lessons at their moment"). Never blocks. |
| `autofix-watch.sh` | PostToolUse `Bash\|mcp__ccd_pr__set_monitor\|mcp__ccd_pr__get_status`; PostToolUseFailure `mcp__ccd_pr__set_monitor`; Stop | Lists every pull request the session opens and warns at turn end about each open one that Auto-fix is not on for ("Auto-fix for every pull request"). Never blocks. |

They act on the session's checkout, the git toplevel of the event's `cwd`:
the desktop app runs a worktree session's hooks with `$CLAUDE_PROJECT_DIR`
set to the main checkout. They use that checkout's prettier and
dependency-cruiser, and the project checkout's prettier when a fresh worktree
has none installed. They need `bash`, `jq` and `git`;
`session-dedupe-guard.sh` runs `HOOK_PYTHON`, or `python3`.

### Auto-fix for every pull request

The desktop app's Auto-fix wakes a session when its pull request fails CI,
gets a conflict or a review comment, but only once the session switches it on
with `mcp__ccd_pr__set_monitor`. A hook cannot make that call, and the app
tells hooks nothing about Auto-fix, so `autofix-watch.sh` keeps the session's
own list and reads the app's answers:

| Step | Event | What it reads |
| --- | --- | --- |
| Record | PostToolUse, `Bash` | Every pull request URL a `gh … pr create` printed, in any repository or folder. A background run prints nothing to read. |
| Confirm | PostToolUse, `mcp__ccd_pr__set_monitor` | The app's "Auto-fix is on for owner/repo#N" (and "is off"). |
| Confirm | PostToolUse, `mcp__ccd_pr__get_status` | This session's primary `pr` and its `monitor.auto_fix`; a primary or `otherBoundPrs` entry merged or closed leaves the list. |
| Refused | PostToolUse or PostToolUseFailure, `mcp__ccd_pr__set_monitor` | The app's "Auto-fix can't be enabled for owner/repo#N: <reason>" (or its pre-call "owner/repo#N is on the session's PR bar, but …"), kept with the reason. Transcripts show it as a tool error; both events' `tool_response` and `error` are read. |
| Warn | Stop | Every PR still waiting, with the exact call, in one `systemMessage`. Silent when `stop_hook_active` is set, and where the transcript does not show `mcp__ccd_pr__set_monitor` (a cloud session, a terminal). |

The list is keyed by the Claude session id, so nested clones and other
repositories count: `<dir>/<session id>.jsonl`, where `<dir>` is
`SARATHI_AUTOFIX_DIR`, else `$XDG_STATE_HOME/sarathi/autofix`, else
`~/.local/state/sarathi/autofix`. Each line is one JSON row:

```json
{ "at": "2026-11-15T10:00:00.000Z", "pr": "owner/repo#12", "url": "https://github.com/owner/repo/pull/12", "event": "opened", "source": "pr-autocreate" }
```

`event` is `opened`, `on`, `off`, `refused` (with `reason`), `closed` or
`warned`. A PR's state is its latest row other than `opened` and `warned`.
Another hook that opens a pull request puts it on the list with

```sh
sarathi autofix add <pr-url> [--session <id>] [--source <name>]
```

or by appending an `opened` row itself, starting with a newline. The session
defaults to `CLAUDE_CODE_SESSION_ID`. `sarathi autofix list` prints the list.
Each `mcp__ccd_pr__*` event is also kept as received, in
`<session id>.raw.jsonl` beside the list (an event over 16 KB cut short), so
the shape of the app's answers can be checked against a real session.

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "Bash|mcp__ccd_pr__set_monitor|mcp__ccd_pr__get_status", "command": "bash \"$SARATHI_HOOKS\"/autofix-watch.sh", "timeout": 10 }],
    "PostToolUseFailure": [{ "matcher": "mcp__ccd_pr__set_monitor", "command": "bash \"$SARATHI_HOOKS\"/autofix-watch.sh", "timeout": 10 }],
    "Stop": [{ "command": "bash \"$SARATHI_HOOKS\"/autofix-watch.sh", "timeout": 10 }]
  }
}
```

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
| `tool` | a regular expression on the whole tool name; optional `input "<regex>"` | a call to that tool, before it runs; `input` is tested against the call's input as compact JSON |
| `content` | a regular expression; required `path "<glob>"` | the new text of an Edit or Write (`new_string`, `content`, or every `edits[].new_string`) to a file the glob matches, before it runs |

A pattern cannot hold `"`: write `\x22` in a regular expression, as in
`<!-- when: tool "Agent|Task" input "\x22subagent_type\x22:\x22worker\x22" -->`
or `<!-- when: content "DROP DATABASE" path "**/*.test.*" -->`. A line whose
second clause is missing, or names the wrong qualifier for its kind, never
fires, and `docProblems` reports it.

A lesson is the unit a "lessons nothing holds" counter counts (those with
neither a `when` nor a `held by` line), in every `.md` file but `README.md`: a `### ` section, bullets inside it
included, up to the next heading; outside one, a column-0 `- ` bullet with
its indented lines, up to a column-0 paragraph. Put the `when` line at the
lesson's end, indented two spaces inside a bullet. One lesson may have several.
A `when` line in neither is a stray; `docProblems` reports strays, two lessons
sharing an id, and patterns that cannot fire. Fenced code is never read for
them. The lesson's id is its file and the slug of its heading or bold lead.
`<!-- held by: ... -->` lines, which name the check that holds a lesson, are
left out of the text shown. A lessons folder's `when-samples.tsv` gives each
`when` line one sample event (`lesson`, `kind`, `pattern`, `scope`: the second
clause or empty, `sample`: the error text, command or path; for `tool`, the name
and its input as JSON; for `content`, the path and the text); veda's tests check that every line has one, and that
each sample fires its own line and no other.

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
    "PreToolUse": [{ "matcher": "Bash|Edit|Write|Agent|Task|mcp__ccd_session__start_session", "command": "bash \"$SARATHI_HOOKS\"/lessons.sh ./docs/lessons", "timeout": 10 }],
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

## Pages

`sarathi page` publishes, reads and answers claude.ai pages (Artifacts) for a
session that does not carry the Artifact tools. Their definitions cost about
11,000 tokens per request, so a project can deny them in its settings and
still publish:

```sh
sarathi page <page.html> [--title T] [--description D] [--icon I]
sarathi page --read <artifact> [--out <page.html>]
sarathi page <page.html> --url <artifact>
sarathi page --comments <artifact>
sarathi page --reply <artifact> --thread <id> --text-file <file> [--resolve]
```

Each job runs in a one-off `claude -p` session, in a new scratch directory
outside the project, so it loads no project settings. It gets only the tools
the job needs, and its success is judged by what those tools returned, not by
what the session says. It prints the page URL, the threads, the saved path or
the reply's outcome.

**Updating a page someone may have changed.** Comment threads answered by
Claude rewrite a page after it is published. `--read` saves the live page
(by default `.tmp/pages/<id>.html`) and, beside it, `<page>.live.json`, which
records the URL, the file, the version read and when. `--url` updates only
from the file that record names, and uses the record up, so the next update
starts from a fresh `--read`. In the update session a PreToolUse hook
(`dist/page/guard.js`) refuses the publish unless that session's own read
confirmed the recorded version, refuses a second publish and any other page,
and turns any fault into a refusal. A read session may only read; a comments
session makes no Artifact call. Accepted limit: the tool has no
compare-and-set, so an edit that lands between the session's read and its
publish is not seen.

**The action box.** Every page opens, before its first `<h2>`, with an element
marked `data-action-box`. It holds a link marked `data-action-link` with an
https href to where the reader acts, and an element marked `data-if-silent`
saying what happens if they do nothing. A link that opens a GitHub list (a
search, a label, a project board) stands only beside links marked
`data-action-item`, one per item. A page without a whole box is refused
before any session starts.

**When the account is at its usage limit**, a publish prints `NOT PUBLISHED`
and a local file URL of the page to open in the browser, and exits 0; a read, comments or reply exits 1
and names the last saved copy, if any.

The session runs under `CLAUDE_CODE_ENTRYPOINT=claude-desktop` (or `remote`,
from a cloud session), the entrypoint that offers the Artifact tools, and
stops if it started without them.

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
