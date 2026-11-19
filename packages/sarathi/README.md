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
      { "matcher": "Write|Edit|MultiEdit|RemoteTrigger|mcp__ccd_host__sync_with_base_branch|Workflow", "guard": "tool" },
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
| `guard` | `worktree`, `command` or `tool`: kavach's guard, run by `kavach.python` with `KAVACH_CONFIG` set to `kavach.config` (`tool` reads the tools kavach's rules name besides Bash; its README gives the matcher) |
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
| `ask-gate.sh` | PreToolUse `AskUserQuestion\|mcp__ccd_turn__wrap_up`; Stop; PostToolUse `AskUserQuestion` (the log) | Holds, once per turn, a question to the owner when the session has done no research since the owner's last message: refuses the ask, or on Stop keeps the turn going when the closing message asks the owner to choose ("Research before you ask"). Logs each gated ask and each answer ("The ask log"). |
| `researcher-report.sh` | PreToolUse `SubagentHandback`; SubagentStop `^sarathi:researcher$` | Sends the plugin's `sarathi:researcher` report back when it has no Verdict line, a Settled or Conflicting verdict with no claims, or a claim without its source and read date ("The researcher's report"). |
| `lessons.sh` | PreToolUse `Bash\|Edit\|Write\|Agent\|Task\|mcp__ccd_session__start_session`; PostToolUseFailure | Shows a lesson whose `when` line matches the call ("Lessons at their moment"). Never blocks. |
| `autofix-watch.sh` | PostToolUse `Bash\|mcp__ccd_pr__set_monitor\|mcp__ccd_pr__get_status\|mcp__ccd_turn__wrap_up`; PostToolUseFailure `mcp__ccd_pr__set_monitor` | Lists every pull request the session opens and tells the model, in its context, about each open one that Auto-fix is not on for ("Auto-fix for every pull request"). Never blocks. |
| `worktree-archive.sh` | PreToolUse `ExitWorktree` (and Codex's `set_thread_archived`) | Denies removing or archiving the session's worktree while `sarathi worktree archive-check` finds work that would be lost ("Worktrees"). List it with `"failClosed": true`. |
| `services-reap.sh` | SessionStart | Starts `sarathi services reap` detached, output discarded, when `docker` is on PATH: deleted worktrees' services go ("Services"). Never blocks; always exits 0. |

They act on the session's checkout, the git toplevel of the event's `cwd`:
the desktop app runs a worktree session's hooks with `$CLAUDE_PROJECT_DIR`
set to the main checkout. They use that checkout's prettier and
dependency-cruiser, and the project checkout's prettier when a fresh worktree
has none installed. They need `bash`, `jq` and `git`;
`session-dedupe-guard.sh`, `ask-gate.sh` and `researcher-report.sh` run
`HOOK_PYTHON`, or `python3`.

### Research before you ask

`ask-gate.sh` holds the research-first rule (the skill
`sarathi:research-first` under the plugin, `skills/research-first/SKILL.md`
in the package): settle what a source can settle before asking the owner. A hook cannot judge whether research
settled a question, so it checks that a look happened, not what it found.

- **Gated:** every `AskUserQuestion`; a `wrap_up` whose `ask` offers a
  choice: two or more reply buttons that are not a plain yes or no, or an ask
  that names alternatives ("which", "or", "how should", "either"), whatever
  its buttons. A bare "A/B" pair counts too, unless every button is a plain
  yes or no (a shallow path such as `src/file` looks the same); a deeper path
  (`src/old/parser.ts`), a URL (its query included) or `owner/repo#N` never
  does.
- **Passed:** a `wrap_up` whose first action is an app action (`commit`,
  `create_pr` …), or with no `ask`; and a go-ahead (yes/no buttons, or one
  button) whose `ask` names no alternatives: approvals are the owner's.
- **Gated on Stop:** a question written as plain text in the closing
  message. The handler reads `last_assistant_message` from the Stop input,
  not the transcript, which "isn't guaranteed to include the final message
  at Stop time" ([hooks reference, Stop input](https://code.claude.com/docs/en/hooks#stop-input)).
  It takes the question sentences in the last three paragraphs, leaving out
  fenced code, inline code, quoted lines and URLs. A question is held when it
  names alternatives ("which", "or", "how should", "either"). "… or not?" and
  a bare "A/B" do not count, since no buttons tell a pair from a path. A
  yes/no question that names no alternative ("Force-push to main?", "Delete
  the branch?") lets the turn end at once. An irreversible step asked as a choice ("Delete the branch or
  keep it?") is held once, as a `wrap_up` ask is.
- **Research:** since the owner's last message, a `WebSearch`, a `WebFetch`,
  a browser page read (`…Claude_Browser__get_page_text`, `read_page`,
  `navigate`), or an `Agent`/`Task` launch of `researcher`,
  `sarathi:researcher`, `Explore`, `general-purpose` (also the default with
  no type) or `claude-code-guide`. The owner's last message is a user-role
  entry holding the person's text: not a tool result, a system reminder, a
  background task's report, another session's message, an app event, or a
  Stop hook's feedback.
- **Repo research, for repo questions:** an ask can name repository or
  session state in its question, header, options or buttons, or, on Stop,
  in the paragraph that holds the question. That means a path or a file name (`README.md`),
  `#N` or `owner/repo#N`, a pull request URL, "PR", "pull request",
  "branch", "commit", "CI" or "workflow". For such an ask a look at that
  state counts too: `Read`, `Grep`, `Glob`, `mcp__ccd_pr__get_status`, or a
  Bash call running a read-only `git` verb (`status`, `log`, `diff`, `show`,
  `branch`, `blame` …), a read-only `gh` (`pr`/`issue`/`run` `view`,
  `list`, `checks`; `gh search`; `gh api` with no fields, or a literal
  `GET`), or a test run (`pnpm test`, `pnpm check`, `node --test`, `vitest`,
  `pytest`, `go test` …). A `git commit`, a `git branch -D` or a new branch
  name, a `git reflog expire`, an `--output` file, a `gh pr create`, a
  `gh api --method "$METHOD"` or a `pnpm install` is no look. Neither is a
  command that may not run: one after `||`, or after `&&` behind a `false`,
  `exit` or `return`. A look does not count for other asks. In 2,333
  local session transcripts (2026-11-19, the script on veda-hq/veda#218),
  732 asks the gate covers had no web research before them. 629 of them
  (86%) came after a repo read, so counting a read for every ask would have
  passed 86% of them, including the questions
  official docs settle (API behaviour, defaults, version facts), the common
  miss in veda-hq/veda#176's sample. Scoped as 0.7.8 read it, over the
  whole ask, 380 pass, all naming repository
  state, and 352 stay held. On Stop, reading the question's own paragraph
  passes 50 of 166 held closing questions; reading the last three paragraphs
  would pass 102, since a closing summary names files and commits.
- **Question by question, and nothing outside:** the state is read per
  unit: each `AskUserQuestion` question with its header and options, the
  `wrap_up` ask with its buttons, the closing question's paragraph. A look
  counts only when every unit names repository state and none names
  something outside the repository: `API` or `SDK`, a dollar amount,
  price, pricing, billing, credits, a quota, a subscription or a rate
  limit, credentials, Keychain, OAuth or an API key, Claude Code,
  claude.ai, Anthropic, OpenAI, a marketplace or Homebrew, documentation,
  release notes, a changelog or the latest version. No repository read
  settles those; they need research. Case is ignored, and a service the
  list does not name is not seen. A path or file named like one
  (`CHANGELOG.md`, `credentials.json`, `src/api/`) is no such word, and
  words a trade-off uses for the repository's own work ("costs a CI run",
  "docs-only", "login", "endpoint", "registry") are left out: in local
  transcripts they named the repository's work more often than anything
  outside. On 2026-11-19 a four-question batch about API credits, spend and
  scope passed as a look because one option's description named a file; it
  is held now. Over 2,448 local transcripts (2026-11-20, the script on
  veda-hq/veda#293), 0.7.8's reading passed 412 asks on a look, and this one
  passes 364. Of the 48 held, 25 name something outside and 28 have a
  question that names no state.
- **Declaring the kind:** an ask that declares an owner-only kind passes the
  first time: `approval`, `money` or `irreversible` at once, the owner's
  authority; `preference`, `private` and `ambiguity` only after research or
  a look in the turn (any look, for a question that names nothing outside;
  research, for one that does). A choice among options nobody
  checked is not yet a preference, and a fact the session could have read
  is not private: on 2026-11-19 two asks declared `preference` for a
  credential choice the official docs settle, with no research and no look,
  and passed. The field is `Kind: <kind>` at the start of a line, after the
  end of a sentence or after `(`, its value running to the line's end or a
  `.`, `;` or `)`, case ignored. It is read from each `AskUserQuestion`
  question's text or header (12 characters at most, so `Kind: money` fits
  and `Kind: approval` does not: the question is the place), the `wrap_up`
  ask, or on Stop the last three paragraphs, code and quoted lines left
  out; not from options or buttons.
  The owner-only kinds are `preference`, `approval`, `private`, `money`,
  `irreversible` and `ambiguity` (the Declare column of `research-first`;
  the table's row names, such as `Money or credentials`, work too). Every
  question of an `AskUserQuestion` must declare one. A `wrap_up` ask is one
  unit, and so is a closing message on Stop, which has no question fields:
  one declaration in its last three paragraphs covers every choice question
  in them, and the log records that kind beside each one. Every
  declaration in a unit must be owner-only: `Kind: api` beside `Kind: preference` stays
  held. A researchable kind (`api`,
  `default`, `version`, `limit`, `error`, `convention`, `state`) or an
  unknown word stays held, and a value that runs into the question
  (`Kind: api - v1 or v2?`) is no known kind, so the question is still read
  as a choice. A declared pass spends nothing: the turn's one
  hold stays for the next undeclared ask. Holding a real owner-only
  question costs most early: in arXiv 2605.07937 (read 2026-11-19), goal
  clarification asked at 10% of the run raised pass@3 to 0.78 against 0.40
  with none, and lost nearly all its value later, on samples of 5 to 28 per
  dimension, so a direction rather than a size. The log shows each kind it
  reads, so a kind declared to skip research shows.
- **A relabel after a hold:** in the turn of a hold, an ask that puts a
  question held then with only its `Kind:` fields added or changed is held
  once more, and logged `held: relabelled`. The question is compared with
  its `Kind:` fields out, case, spacing and punctuation aside: an
  `AskUserQuestion` question's text, the `wrap_up` ask, a closing message's
  choice questions, across the PreToolUse and Stop paths. A question asked
  again unchanged, its declaration too, is no relabel and passes as the
  turn's second ask; so does one rephrased with what research found. After
  a relabel's hold every ask in the turn passes, so a turn holds at most
  twice. On 2026-11-19 a `wrap_up` ask was held, then passed ten seconds
  later with only `Kind: private` added. On Stop the continuation that
  follows a hold carries `stop_hook_active` and passes unread, so a closing
  message relabelled right after a Stop hold is not seen; one after a
  `wrap_up` hold is.
- **Refused (PreToolUse):** exit 2, with the rule, the owner-only kinds and
  how to declare one on stderr, which reaches the model.
- **Held (Stop):** exit 0 with
  `{"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "<the rule>"}}`,
  so the turn goes on with the rule as `Stop hook feedback`. The hooks
  reference gives `additionalContext` for "when the hook is working as
  designed and giving Claude guidance": it keeps the loop protections of
  `decision: "block"` (`stop_hook_active`, and the cap of eight consecutive
  continuations) but shows no hook error
  ([Stop decision control](https://code.claude.com/docs/en/hooks#stop-decision-control),
  read 2026-11-19). It needs Claude Code 2.1.163 or later; an older one
  ignores the field, and the turn ends as before.
- **Once per turn:** a second held ask in the same turn goes through, keyed
  on the turn (the owner's last message), not the question's text, so an
  owner-only question is asked again unchanged. A relabel (above) is the
  one exception, held once more. The PreToolUse and Stop
  paths share the key: a Stop passes in a turn whose ask was held, and the
  other way round. A Stop with `stop_hook_active` set passes and spends
  nothing. The key is kept in `<dir>/<session id>`, where `<dir>` is
  `SARATHI_ASK_GATE_DIR`, else `$XDG_STATE_HOME/sarathi/ask-gate`, else
  `~/.local/state/sarathi/ask-gate`: the turn on the first line, then a
  JSON line with the questions held (as compared for a relabel, with the
  kinds each declared) and whether a relabel was held. A file of the turn
  alone, as 0.7.8 wrote it, reads as a hold with no questions; a second line
  it cannot read passes the ask as `passed: state unreadable`.
- **Passing** is a silent exit 0, never an allow answer. Anything it cannot
  read passes.
- **Limits on Stop:** the question has already reached the owner when Stop
  runs; the feedback tells the model to research and end again, and not to
  repeat an owner-only question. The transcript can lag, so research in the
  turn's last moments may not be in it yet; the cost is one extra
  continuation. A Stop
  handler that exits 2 beside it wins, and sarathi answers with that
  handler's reason alone: the gate's feedback is not shown, and its once
  for the turn is spent.

**An ask the app does not see (Stop).** The desktop app and the needs-you
plugin show that a session waits on its owner from the `ask` of its
`wrap_up`. A turn that asks only in its closing message shows nothing, so on
Stop, before the research hold, the handler checks the closing message:

- **It asks the owner** when a line of its last three paragraphs (code and
  quoted lines out) opens `Needs you:`, bold or not, or ends on a question,
  with URLs, inline code and "quoted text" taken out. A question answered on
  its own line ("**Can it close?** Yes, once …") does not end that line.
- **No `wrap_up` carried an ask** since the turn's prompt: the last
  user-role entry from the owner, another session (meta or not) or an app
  event, so a side session's turn counts from the message that started it.
  A tool result, meta text other than another session's message, a row of
  system reminders alone and a background task's report start no turn: a
  `wrap_up` ask before them still stands.
- **The session has `wrap_up`:** the desktop app names it in
  `CLAUDE_CODE_TERMINAL_MCP_TOOLS`, or the transcript shows a call to it. A
  terminal session's Stop is as before.

Then the turn goes on once, with `additionalContext` that starts `file the
ask.`, quotes the asking line, and says to call `wrap_up` with the question
as `ask`, reply buttons, and `blocked: true` if the work stops; a turn that
does not wait on the owner just ends again. The `wrap_up` it asks for then
meets the research hold on PreToolUse, as any choice-shaped ask does. The
continuation carries `stop_hook_active`, so it fires at most once a turn.
Each one is a line in the ask log, `outcome: "nudged: no wrap_up ask"`. Like
the hold, it needs Claude Code 2.1.163 or later, which reads
`additionalContext` on Stop; an older one ignores it and the turn ends, so
there a `nudged` line records feedback the model never saw.

Replayed over this Mac's desktop transcripts (read 2026-11-20), the
handler's own functions nudge 810 of 26,627 turn endings, most of them
"Needs you:" endings. Those endings come from a split of the replay's own,
at every user row that is not a tool result or meta text (reminder-only
rows and task reports included), not from the handler's, so the sample
does not lean on the rule it tests. Counting a task report as no prompt drops 11 nudges
there, each a repeat of an ask already standing.

A project lists it in `.claude/sarathi.json`, beside its other `PreToolUse`
and `Stop` handlers:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "AskUserQuestion|mcp__ccd_turn__wrap_up", "command": "bash \"$SARATHI_HOOKS\"/ask-gate.sh", "timeout": 10 }
    ],
    "Stop": [
      { "command": "bash \"$SARATHI_HOOKS\"/ask-gate.sh", "timeout": 10 }
    ]
  }
}
```

It widens its settings' `PreToolUse` matcher to include
`AskUserQuestion|mcp__ccd_turn__wrap_up`, for example
`Bash|Edit|Write|NotebookEdit|AskUserQuestion|mcp__ccd_turn__wrap_up`. It
also gives the settings a `Stop` entry that runs sarathi, with no matcher
(`sarathi check` refuses one there, since the handler runs on every Stop)
and a timeout of at least the longest Stop handler's:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "npx --no-install sarathi hook Stop", "timeout": 20 }] }
    ]
  }
}
```

`sarathi check` says when either entry is missing or too narrow.

#### The ask log

`ask-gate.sh` keeps a log of the asks it gates, so a project can see what
its sessions ask the owner, whether they looked first, and whether a
declared kind is being gamed. Each line is a
JSON object:

- **A gated ask** (an `AskUserQuestion`, a `wrap_up` ask that offers a
  choice, a closing question on Stop): `time` (UTC), `session`, `turn` (the
  owner's message it follows), `via` (`AskUserQuestion`,
  `mcp__ccd_turn__wrap_up` or `Stop`), `tool_use_id`, `questions` (each
  question with its option labels, a `wrap_up`'s reply buttons, not its app
  actions, the `kind` it declares, and its own `names_state` and
  `names_outside`), `researched`, `looked`, `names_state` (every question
  names repository state), `names_outside` (some question names something
  outside), `kind` (the kinds the ask declares, each once, joined with
  `, `; an unknown value lowercased, its spaces and hyphens collapsed to
  single spaces, a leading "a" or "an" dropped, cut to 40 characters;
  `null` for none), and `outcome`: `held`, `held: relabelled` (a `Kind:`
  line added after a hold),
  `passed: research`, `passed: look`, `passed: declared <kind>`,
  `passed: second ask` (with `relabelled`: `true` when it is a relabel
  passing after its own hold), or `passed: state unreadable` /
  `unwritable` (the
  gate passes what it cannot keep its once-per-turn state for). A
  `passed: look` with `names_outside` true cannot happen; a
  `passed: declared preference` or `private` has `looked` true (a
  researched ask logs `passed: research`). An ask the
  gate passes over (a go-ahead, a Stop with no choice, a Stop already
  continuing) is not logged, nor is any kind it declares.
- **An answer** to an `AskUserQuestion`: `time`, `session`, `via: "answer"`,
  `tool_use_id` (the ask's line has the same one), and `answers`, which maps
  each question's text to the answer: the chosen label, a list of labels, or
  text the owner typed. It comes from the `PostToolUse` input's
  `tool_response`, which the hooks reference says is the tool's structured
  output, and else from the input's `answers` (set when a hook answers for
  the owner). In one machine's transcripts, 444 of 455 `AskUserQuestion`
  results were objects with an `answers` map (608 string values, 13 lists);
  the other 11 were a string or nothing, as for a declined question, and log
  nothing. A `wrap_up` or Stop answer comes as the owner's next message, so
  the log has none.

The log is `ask-log.jsonl` in the state folder
(`~/.local/state/sarathi/ask-gate/ask-log.jsonl` by default), or the file
`SARATHI_ASK_LOG` names. `SARATHI_ASK_LOG=0` (or `false`, `off`, `no`) turns
it off. Past 5 MB it moves aside to `ask-log.jsonl.1`, replacing the one
there, and starts again, so it keeps the last 5 to 10 MB and older lines
are gone: copy `ask-log.jsonl.1` away to keep them. Writes take a lock
(`ask-log.jsonl.lock`), so two hooks at once lose no line. It
holds the questions and what the owner typed, which can be a private fact,
so the file is the owner's alone (mode 0600) and stays on the machine:
nothing sends it anywhere. A log it cannot write changes nothing about the
gate.

To log answers, a project lists the handler on `PostToolUse` too:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "AskUserQuestion", "command": "bash \"$SARATHI_HOOKS\"/ask-gate.sh", "timeout": 10 }
    ]
  }
}
```

and widens its settings' `PostToolUse` matcher to include `AskUserQuestion`.

### The researcher's report

`researcher-report.sh` checks the plugin's `researcher` agent's report. The
agent's prompt asks for a shape; this handler holds the agent to it:

- **Whose report:** the plugin's agent, whose `agent_type` is
  `sarathi:researcher` (a plugin agent reports its plugin-scoped name). A
  bare `researcher` is a user's or a project's own agent, with its own
  format: on one machine, 52 of 52 such reports had no Verdict line, so it is
  left alone.
- **Verdict:** a line `Verdict: Settled`, `Conflicting` or `Not settled`,
  with or without bold, code marks, a list marker or a heading mark.
- **Claims:** each claim under `Claims` (a claim on that line itself, each
  top-level list item with the lines wrapped or indented under it, or each
  table row), up to `Next`, names its source and the date it was read: a
  URL, or a repository path (`src/flags.ts:12`, `README.md`), and a
  `YYYY-MM-DD` date outside any URL (a dated page is no read date). A
  product name (`Node.js`), `e.g.` or a version is no source. A `Settled` or
  `Conflicting` verdict needs at least one claim; `Not settled` may have none
  (`Claims: none`).
- **Where it reads the report:** Claude Code 2.1.271 and later deliver a
  subagent's report through the `SubagentHandback` tool, and a `PreToolUse`
  hook on it gets the report as `tool_input.message`. On older versions the
  report is the subagent's last message, which `SubagentStop` gives as
  `last_assistant_message`. A `SubagentStop` whose subagent used
  `SubagentHandback` passes, since its last message is not the report then
  ([hooks reference, SubagentStop](https://code.claude.com/docs/en/hooks#subagentstop),
  read 2026-11-19).
- **Refused:** on `PreToolUse`, exit 2 with what is missing on stderr, which
  the subagent reads. On `SubagentStop`, `{"decision": "block", "reason": …}`,
  which keeps the subagent running with the reason as its next instruction.
- **The escape:** at most two refusals per subagent (`agent_id`), kept in
  `<dir>/<agent id>`, where `<dir>` is `SARATHI_REPORT_CHECK_DIR`, else
  `$XDG_STATE_HOME/sarathi/researcher-report`, else
  `~/.local/state/sarathi/researcher-report`; then the report goes through.
  A `SubagentStop` with `stop_hook_active` set passes too.
- **Passing** is a silent exit 0. Other agents (the `agent_type` in the hook
  input) and anything it cannot read pass.
- **Limits:** the subagent's transcript can lag at `SubagentStop`, so a
  report already delivered through `SubagentHandback` may be missed there,
  and the closing text sent back once. Claude Code also fires `SubagentStop`
  for its internal agents with the session's own agent name, so a session
  run as `sarathi:researcher` (`--agent`) has those checked too.

A project lists it in `.claude/sarathi.json` on both events:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "SubagentHandback", "command": "bash \"$SARATHI_HOOKS\"/researcher-report.sh", "timeout": 10 }
    ],
    "SubagentStop": [
      { "matcher": "^sarathi:researcher$", "command": "bash \"$SARATHI_HOOKS\"/researcher-report.sh", "timeout": 10 }
    ]
  }
}
```

The `:` puts a plugin-scoped name on the regular-expression path, so the
matcher is anchored for an exact match, as the hooks reference advises
([SubagentStart](https://code.claude.com/docs/en/hooks#subagentstart)). It
widens its settings' `PreToolUse` matcher to include `SubagentHandback`. It
also gives the settings a `SubagentStop` entry that runs
`npx --no-install sarathi hook SubagentStop`, with no matcher and a timeout
of at least 10 s: `sarathi check` cannot prove that a narrower settings
matcher covers a regular expression, so it refuses one. `sarathi check` says
when either entry is missing or too narrow.

### Auto-fix for every pull request

The desktop app's Auto-fix wakes a session when its pull request fails CI,
gets a conflict or a review comment, but only once the session switches it on
with `mcp__ccd_pr__set_monitor`. A hook cannot make that call, and the app
tells hooks nothing about Auto-fix, so `autofix-watch.sh` keeps the session's
own list and reads the app's answers. No warning blocks, and each is silent
where the transcript does not show `mcp__ccd_pr__set_monitor` (a cloud
session, a terminal). Stop says nothing: a Stop `systemMessage` reached
neither the model nor the user, and a config that still wires Stop gets no
answer.

| Step | Event | What it reads |
| --- | --- | --- |
| Record | PostToolUse, `Bash` | Every pull request URL a `gh … pr create` printed, in any repository or folder. A background run prints nothing to read. |
| Confirm | PostToolUse, `mcp__ccd_pr__set_monitor` | The app's "Auto-fix is on for owner/repo#N" (and "is off"). |
| Confirm | PostToolUse, `mcp__ccd_pr__get_status` | This session's primary `pr` and its `monitor.auto_fix`; a primary or `otherBoundPrs` entry merged or closed leaves the list. |
| Refused | PostToolUse or PostToolUseFailure, `mcp__ccd_pr__set_monitor` | The app's "Auto-fix can't be enabled for owner/repo#N: <reason>" (or its pre-call "owner/repo#N is on the session's PR bar, but …", or "owner/repo#N is not bound to this session."), kept with the reason. Transcripts show it as a tool error; both events' `tool_response` and `error` are read. |
| Warn | PostToolUse, `mcp__ccd_turn__wrap_up` | Every PR still waiting (`opened` or `off`), with the exact call, as `hookSpecificOutput.additionalContext`, which reaches the model, and a `warned` row each. A PR another hook added is warned here. |
| Warn | PostToolUse, `Bash` | The PR a `gh … pr create` just recorded, at once, the same way. A `gh pr create` run with `run_in_background: true` is told that its PR is not on the list, and the way out in the foreground: a foreground `gh pr create`, or a `<pr-created>URL</pr-created>` tag, then `mcp__ccd_pr__set_monitor`. |

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
    "PostToolUse": [{ "matcher": "Bash|mcp__ccd_pr__set_monitor|mcp__ccd_pr__get_status|mcp__ccd_turn__wrap_up", "command": "bash \"$SARATHI_HOOKS\"/autofix-watch.sh", "timeout": 10 }],
    "PostToolUseFailure": [{ "matcher": "mcp__ccd_pr__set_monitor", "command": "bash \"$SARATHI_HOOKS\"/autofix-watch.sh", "timeout": 10 }]
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

## Worktrees

`sarathi worktree` carries one agent worktree through its life, from the
worktree root. It never creates or removes a worktree, and it reads only
in `status` and `archive-check`. It acts only in a linked worktree under
Claude Code's `.claude/worktrees/` or Codex's worktree root.

```sh
sarathi worktree begin --branch claude/next   # a new branch from fresh origin/main
sarathi worktree retire --pr 123              # after the PR merged: branch gone, worktree kept
sarathi worktree archive-check                # may this worktree be removed? exit 2 if not
sarathi worktree status                       # the same report, exit 0
```

Each prints JSON and exits 2 when blocked, naming why. `begin` refuses
uncommitted work and commits not in origin/main. `retire` needs GitHub's
word that the PR merged from this branch into main of the same repository
(`gh`, or in a cloud session a REST read through the proxy), keeps a
recovery ref first, and moves commits made after the merge to a successor
branch. `archive-check` lists every blocker: changes, a git operation,
ignored files other than rebuildable caches, work not in origin/main.

Settings are the `worktree` object of `.claude/sarathi.json`:

```json
{ "worktree": { "name": "acme", "owner": "Ana", "cloudCheck": "scripts/cloud-check.sh" } }
```

`name` names the receipt (`<name>-lifecycle.json` in the git dir) and the
recovery refs (`refs/<name>/lifecycle/…`); `owner` is who may discard
scratch files; `cloudCheck` confirms a cloud session (exit 0), else
`CLAUDE_CODE_REMOTE=true` alone does; `services` names the services file
("Services"). All four are optional.

## Services

`sarathi services` gives each worktree its own local development services:
one Compose project per worktree, named after the worktree root, so two
worktrees never share a database. Docker picks the published ports; the
server port is drawn once from a band below Docker's and kept, with a random
password, in the worktree's `.tmp/services/config.json`.

```sh
sarathi services up                 # start, read the published ports, write .tmp/services/environment.json
sarathi services server [args]      # up, the server's steps, then the server with its environment
sarathi services web [args]         # the web command on the web port; no containers
sarathi services run -- <command>   # the command with the services' environment
sarathi services <action> [args]    # a configured action, with the services running
sarathi services status|down
sarathi services reap               # remove the services of worktrees that are gone
```

A command it starts gets `SARATHI_SERVICES_CONTEXT`, so a nested
`sarathi services` call reuses the running parent's environment instead of
starting again. A launched command's exit code is sarathi's; any other
failure is one line on stderr and exit 1. Starts are serialised per worktree
by a lock in `.tmp/services/`, which a dead holder's successor takes over.

Everything project-specific is in the services file that
`worktree.services` names: a path from the project root, or a package path
such as `@acme/rules/sarathi/services.json`, found under `$SARATHI_PACKAGES`
when that is set, else under the project's `node_modules/`. Unknown keys are
refused.

```json
{
  "compose": "compose.yaml",
  "project": "acme-wt",
  "rootLabel": "acme.worktree-services.root",
  "apiPorts": [20000, 29999],
  "webPort": 5173,
  "published": { "postgres": ["postgres", 5432] },
  "environment": {
    "DATABASE_URL": "postgresql://acme:{password}@127.0.0.1:{postgres}/acme_dev",
    "PORT": "{serverPort}",
    "API_URL": "http://localhost:{serverPort}"
  },
  "web": { "command": ["pnpm", "--filter", "web", "exec", "vite", "--port", "{webPort}", "--strictPort"], "environment": ["API_URL"] },
  "server": {
    "before": [["pnpm", "--filter", "server", "exec", "prisma", "migrate", "deploy"]],
    "command": ["pnpm", "--filter", "server", "exec", "nest", "start", "--watch"]
  },
  "actions": {
    "database-snapshot": { "mainCheckoutOnly": true, "run": [["node", "scripts/snapshot.ts", "{container:postgres}"]] }
  }
}
```

| Key | Meaning |
| --- | --- |
| `compose` | The Compose file, from the worktree root |
| `project` | The project prefix: each worktree's project is `<project>-` and 16 hex of the SHA-256 of its root |
| `rootLabel` | The label the Compose file puts on the project's volumes (and networks), holding `SARATHI_WORKTREE_ROOT`, so the reaper finds a project whose containers are gone |
| `apiPorts` | `[first, last]`: the band the server port is drawn from |
| `webPort` | The web command's port, outside the band; one web server at a time |
| `published` | `{ name: [service, container port] }`: the ports read back after `up`, as `{name}` |
| `environment` | The variables every command gets, filled from the placeholders |
| `web` | `command`, and the `environment` keys it gets (none may need a published port) |
| `server` | `before`, commands run in order first (the first failure stops the start), and `command` |
| `actions` | `{ name: [commands] }` or `{ name: { "mainCheckoutOnly": true, "run": [commands] } }` |

Placeholders, in `environment` and in commands: `{password}` (URL-encoded in
`environment`), `{serverPort}`, `{webPort}`, `{project}` (the full project
name) and `{container:<service>}` (`<project name>-<service>-1`); and, in
`environment` only, `{<published name>}`: a command reads a published port
from its variable. Arguments after `server`, `web` or an action are appended
to its command, and to an action's last command.

Compose gets `COMPOSE_PROJECT_NAME` and `SARATHI_SERVICES_PROJECT` (the
project name), `SARATHI_SERVICES_PASSWORD` and `SARATHI_WORKTREE_ROOT`. Run
it with stdin closed, so a volume whose labels changed is kept, not
recreated.

**The reaper.** Archiving a conversation deletes its worktree but not the
services started there, and no hook sees a desktop-app archive. So
`sarathi services reap` (run detached at every session start by
`services-reap.sh`, and before every `up`) lists the projects with the
file's prefix whose containers' working directory, or whose volume's or
network's root label, names a root that hashes to the project, and removes
those whose root provably no longer exists: a missing directory, never a
permission or I/O error. Each root is inspected again just before its
removal. A live-service test's temporary root, `<worktree.name>-service-test-XXXXXX`,
counts as gone once the process named in its `fixture-owner.json` has died
or it is an hour old. It skips a stopped OrbStack rather than waking it, and
records each sweep that did something in
`<git common dir>/<worktree.name>-services-reaper.log`.

The live-service tests start real containers, so they run only with
`SARATHI_LIVE_SERVICES=required` and a Docker daemon.

## The working rules

`skills/working-rules/SKILL.md` holds the generic rules an agent follows to
carry a change from first edit to merge: run started work to merge, show then
push, commit and push without skipping or weakening checks, resolve review
threads only once the fix is on the remote, research before asking, and when
to stop and ask. A project adds its own rules on top.

`skills/research-first/SKILL.md` is the full research rule the working rules
point to: what only the owner can answer, where to look and in what order,
when to state an assumption and proceed, and how to ask, with its sources.
`ask-gate.sh` enforces the look ("Research before you ask").

It ships in the package, so a project whose dependencies are installed can
load it every session with one import line in its `CLAUDE.md` (or in a file
its `CLAUDE.md` imports). Claude Code reads the import at session start, so a
checkout with no `node_modules` yet starts without it:

```md
@node_modules/@veda-hq/sarathi/skills/working-rules/SKILL.md
```

The plugin carries the same file as the skill `sarathi:working-rules`, and
the research rule as `sarathi:research-first`.

## The plugin

`sarathi@veda`, from this repository's marketplace, carries two agents,
`sarathi:worker` (carries out one decided task end to end) and
`sarathi:researcher` (answers a question a source can settle, with a verdict
of Settled, Conflicting or Not settled and each claim's URL, version and date
read; read-only), and the `sarathi:working-rules` and
`sarathi:research-first` skills.

```sh
claude plugin marketplace add veda-hq/veda
claude plugin install sarathi@veda
```

Node 24 or later. MIT.
