# Claude Code

Lessons about Claude Code itself, in the terminal, the desktop app and cloud sessions: what the
auto-mode classifier refuses, how hooks, settings and mods behave, where context and cost go,
how cloud sessions and routines start, and how to coordinate several sessions without one
undoing another.

## The auto-mode classifier and permissions

- **A session cannot grant itself permissions.** The auto-mode classifier blocks a session from
  editing permission blocks in `~/.claude/settings.json` or `.claude/settings.local.json`,
  however narrow the rule, and the `update-config` skill hits the same block. Say so at once and
  hand over the remedy: the prompt's Always allow button, the Bypass permissions mode, or a
  script the user runs themselves when several rules are needed.
  <!-- when: content "\x22(permissions|allow|deny|ask|defaultMode)\x22" path ".claude/settings*.json" -->
- **Hook wiring edits read as self-modification.** The classifier refuses edits to
  `.claude/settings.json` hook wiring, even when an approved task removes those hooks. Ask the
  user up front to remove the entries or allow the edit, and keep the hook files until then:
  deleting a still-registered hook breaks every session.
  <!-- when: content "\x22(hooks|matcher|PreToolUse|PostToolUse|PostToolUseFailure|Stop|SessionStart|UserPromptSubmit)\x22" path ".claude/settings.json" -->
- **Hook-instructed PR tool calls can be denied.** The classifier can deny calls a hook asks for
  to the desktop app's PR tools (`bind_pr`, `set_monitor`) as dangerous, because their
  descriptions say to call them only when the user asks. Have the user add
  `mcp__ccd_pr__get_status`, `mcp__ccd_pr__bind_pr` and `mcp__ccd_pr__set_monitor` to
  `permissions.allow` in user settings, and check that list first when denials recur.
- **Negative controls can be denied.** The classifier may deny running tests against code with
  a safety check deliberately switched off (a negative control), and sometimes broad typecheck
  runs. Restore the mutation at once, do not retry or route around it, and let the user choose
  between pushing without an observed control (argue falsifiability in the PR) or running it
  themselves.
- **No `do-not-merge` label holds.** The classifier blocks an agent from adding or removing a
  `do-not-merge` label on a PR, so a label hold can only be lifted by the owner. Do not hold a
  bad PR with a label: rely on a check that already fails, rewrite the PR or close it. If a hold
  is truly needed, tell the owner up front that they must lift it.
  <!-- when: command "gh pr edit .*--(add|remove)-label[ =]do-not-merge" -->

## Hooks, settings and mods

- **SessionStart hooks.** Command hooks default to a 600 s timeout, all groups run in parallel,
  stdout on exit 0 goes into Claude's context and stderr only to the user, stdin `source` is
  `startup`, `resume`, `clear`, `compact` or `fork`, and lines appended to `CLAUDE_ENV_FILE` are
  sourced before every Bash call. A hook that starts a daemon must detach it (`setsid`, no
  inherited fds), or the hook never ends.
- **Deny MCP write tools by suffix.** To deny an MCP server's write tools with a PreToolUse hook,
  match a suffix regex such as `^mcp__.*__(save_issue|save_comment)$` rather than exact
  `mcp__<server-id>__<tool>` names, which go stale when the connector is reconnected under a new
  id. Route machine-authored writes through an app identity, not a connector that authenticates
  as a person, or every machine comment notifies that person.
- **`skillOverrides` cannot touch plugin skills.** `skillOverrides` in project settings cannot
  hide or shorten plugin skills (the plugin locks them), while bundled and synced skills obey
  it; re-check after a Claude Code upgrade. When measuring the skill listing headlessly, pass
  `--strict-mcp-config` so MCP connection timing does not skew it.
  <!-- when: content "skillOverrides" path ".claude/settings*.json" -->
- **Function-hook mods.** A plugin tool result must be a string, op hooks answer `{ value }`,
  matchers must be literals, and a timer's promise chain needs its own `.catch`. Plugin tools
  are deferred (load them with ToolSearch first). Dev mods hot reload only at a turn end, so a
  Stop-blocking hook delays the reload. Headless probes must use `--setting-sources user` with
  Bash, Edit and Write disallowed, or project hooks can drive the probe to push.
- **Dev-mod hot reload needs the skill.** A symlink under `~/.claude/dev-mods/<session-id>/`
  never loads a desktop mod by itself: the plugin-authoring skill must load in that session
  (Skill tool) to start the watch, and at turn end the app asks "Enable hot reloading for this
  session?". Invoke the skill, end the turn and have the user pick Enable; a compacted or resumed
  session needs the skill again.
  <!-- when: command "\bln -s.*\.claude/dev-mods/" -->
- **Capturing a mod for evidence.** Use `screencapture -x -o -l <windowId>` on the largest
  layer-0 "Claude" window (Screen Recording permission needed), keep the Mac awake with
  `caffeinate -d -t <s>` only for the run, and keep the window uncovered: a covered window
  repaints nothing, and identical byte sizes are the tell. Toasts draw at the window's bottom
  right, so crop band and toast together. Capture the window only, never the full screen, and
  delete scratch crops.
  <!-- when: command "\bscreencapture\b" -->

## Context and cost

- **Cost is context times turns.** Session cost is dominated by cache reads and writes (about
  86% in one measured session), roughly average context times turns, not by code written. Keep
  context small, delegate file-heavy reading to a subagent that returns a short answer, and
  start a new session per task rather than compacting late: compaction breaks even only after
  about 8 to 10 more turns. The usage panel's parallel-sessions and subagent-heavy lines are not
  causal.
- **Use Explore for narrow read-only subagents.** Delegate search, measurement and web research
  to the Explore subagent type: it starts with roughly half the context of general-purpose,
  because it loads neither CLAUDE.md nor memory. Put any repository rule it needs in the prompt,
  and keep general-purpose for subagents that must edit, write or publish.
  <!-- when: tool "Agent|Task" input "^(?!.*\x22subagent_type\x22)|\x22subagent_type\x22:\x22general-purpose\x22" -->
- **Standing context.** A bare tool name in `permissions.deny` (or `--disallowedTools`) removes
  that tool's definition from every request's standing context, the cheapest prefix cut;
  desktop-app MCP tools have no per-project switch. Auto-memory `MEMORY.md` loads only its first
  200 lines or 25 KB and silently drops the rest, so fold one-line entries into topic notes.
  Measure standing cost from the first request's `message.usage` in the transcript.
- **Deferred tools cost nothing.** In `/context`, the "MCP tools (deferred)" and "System tools
  (deferred)" rows are not part of the reported total, so disabling a deferred MCP server saves
  nothing; only eager schemas in the system prompt cost tokens. To count real tool use across
  `~/.claude/projects/**/*.jsonl`, grep for `"name":"<tool>","input"` (the `,"input"` suffix
  marks a tool use, not a definition). Desktop-app MCP servers are injected by the app runtime
  and cannot be toggled from `claude mcp` or any settings file.
- **The desktop app runs its own CLI.** The desktop app runs a bundled CLI under
  `~/Library/Application Support/Claude/claude-code/<ver>/`, not the terminal one. Probe it with
  `claude -p --output-format stream-json --verbose --strict-mcp-config` (init lists tools, the
  result has usage) and isolate A/B runs with `--setting-sources user,local`. A bare name in
  `permissions.deny` blocks calls in an open session at once, but definitions drop only in a new
  session, and desktop-provided MCP tools keep their definitions even then; disable connectors
  with the session connector toggle instead.
- **Transcript usage repeats per block.** JSONL transcripts write one line per assistant content
  block and repeat that API response's usage on each line under the same `requestId`, so
  per-line summation over-counts cost about 1.7x. In subagent transcripts `output_tokens` is a
  placeholder on early blocks and the full figure is only on the last, so first-line-wins drops
  most output. Price per `requestId` (fallback `message.id`), taking the maximum of each field.

## API errors and schemas

- **A 429 can read as success.** A request-level 429 from the CLI can return result JSON with
  `subtype: success`, `terminal_reason: completed` and zero tokens, and the banner may name the
  wrong limit. Read `api_error_status` in the result or `apiErrorStatus` in the transcript entry
  (`~/.claude/projects/<cwd-slug>/<session>.jsonl`). Only a stream-json `rate_limit_event`
  carries which limit (`rateLimitType`) and its reset (`resetsAt`).
  <!-- when: command "claude -p .*--output-format[ =](stream-)?json" -->
- **No top-level schema combinators.** A structured-output or tool `input_schema` with a
  top-level `allOf`, `anyOf` or `oneOf` is rejected by the API (400 "input_schema does not
  support oneOf, allOf, or anyOf at the top level"), killing the agent before its first tool
  call. Express conditional requirements in code after the call returns.
  <!-- held by: pariksha schema-roots (refuses a tool or output schema in a .json file whose root has allOf, anyOf or oneOf); a schema built in code is not read -->

## The desktop app and worktrees

- **Archiving changes nothing in git.** The archived state lives only in the app's session
  records
  (`~/Library/Application Support/Claude/claude-code-sessions/<acct>/<org>/local_<id>.json`,
  fields `cwd` and `isArchived`). Agent-isolation worktrees and terminal sessions have no record
  of their own, so judge them by their parent session, and get the user's OK before reading that
  directory.
- **Autofix can merge main under a running push.** The app's Autofix may merge `origin/main`
  into the session's worktree host-side when a PR shows conflicts, even while a long pre-push
  hook runs, so HEAD moves under the hook. Regenerate code (for example `prisma generate`) if
  the merge brought application changes.
  <!-- held by: dvara run (refuses a pre-push run whose HEAD moved while it ran) -->
- **The sync tool's default base can be stale.** In a reused worktree, the sync-with-base-branch
  tool defaults to the branch the worktree was first cut from, which may since have been
  deleted, and fails at fetch; always pass base `main`. Conflicts on append-only files are
  append/append: keep both sides.
- **Named workflows resolve from the main checkout.** From a git worktree, `Workflow({name})`
  and `preview_start({name})` resolve from the main checkout's `.claude` directory, not the
  worktree's, so a branch-local script or `launch.json` edit is silently ignored. Launch
  workflows with an absolute `scriptPath` into the worktree. `preview_start` has no equivalent,
  so a worktree dev server cannot be previewed while the main checkout holds the same name and
  port.
- **File links resolve against the launch directory.** The app resolves clicked file links
  against the session's launch directory, not the worktree it entered, so a file that exists
  only on the worktree branch shows "Couldn't read this file". Link worktree-only files as
  `.claude/worktrees/<name>/path/to/file` or point at the PR's Files changed view; no setting or
  hook changes this.

## Cloud sessions and routines

- **Cloud sessions clone the starter's branch.** A cloud session started from another session
  clones the starter's current branch, so push it first; an unpushed or deleted branch fails
  with `ref_not_found`, shown only as "An API error occurred". Start a fresh cloud session
  rather than resuming one (resumes can lose Docker and reset refs), expect a cloud worktree to
  branch from the newest `origin/main`, and type cloud prompts as one paragraph, because a
  newline sends.
- **`start_session` to cloud may not start.** A desktop `start_session` with target cloud can
  return without any cloud session ever being created. Check within a few minutes that the run
  exists in the web app's session list, and if not, fall back to `claude --cloud` in a terminal
  tab at once.
  <!-- when: tool "mcp__ccd_session__start_session" input "\x22target\x22:\x22cloud\x22" -->
- **`claude -p --cloud` only sends.** `claude -p "<msg>" --cloud <session-id>` only queues a
  message to a cloud session and prints "Sent to cloud session."; the reply never comes back to
  the laptop. End such a prompt with one block the user can copy back, tell them what to paste,
  and do not poll.
  <!-- when: command "claude -p .*--cloud\b" -->
- **`send_message` from an untrusted device.** `send_message` to a cloud session can fail
  non-retryably with `elevated_session_untrusted_device`. Typing the message into the web app
  through a browser instead would send it on the user's behalf and route around a trust check,
  so give the user the text to relay or wait for their yes.
  <!-- when: error "elevated_session_untrusted_device" -->
- **Routines are full cloud sessions.** Routines run with a 1-hour minimum interval, drawn from
  subscription usage, but their entrypoint and clone path are undocumented, so probe one run
  before relying on a routine to commit or push. In cloud sessions `gh pr` (GraphQL) is refused
  while REST via `gh api` works, and environment-variable secrets are visible to anyone using
  the environment.
- **Routine create body shape.** When creating a cloud routine with RemoteTrigger, give the
  repository as `job_config.ccr.session_context.sources: [{"git_repository": {"url": "<url>"}}]`.
  The shape `{"type":"git_repository","url":...}` returns 200 but is dropped, so check
  `session_request.sources` in the response. Set `notifications` with a separate update if
  create ignored it, use `run_once_at` for one-offs, and give `events[].data.message` a `role`.
- **Scheduled-task state lives in the app.** The desktop app keeps scheduled-task runtime state
  (`enabled`, `nextRunAt`, `lastRunAt`) inside the app, not in `SKILL.md`, and the only
  supported reader is the `list_scheduled_tasks` MCP tool in a Claude session; a launchd job
  cannot reach it. To expose it to other tools, have a scheduled task write an allowlisted,
  expiring export to a durable path outside any worktree.

## Figma from Claude

- **Which route to use.** Use the official Figma plugin or connector (`use_figma`,
  `create_new_file`) for direct edits, and never pass binary data through agent text: take it
  from a file the user picks and give plugin panels a status line. `generate_figma_design`
  captures need the browser tab in front and land side by side on the first page.
  `AFTER_TIMEOUT` prototype timeouts are in seconds. Publishing silently skips a component with
  an unreferenced property. No MCP tool or REST endpoint resolves comments, and Starter-plan
  call limits are tiny.
- **A connector with one or two tools.** If a connector reaches sessions with only one or two
  tools (for example Figma exposing only `generate_image`), the rest are set to Blocked under
  the connector's Tool permissions in the web app's settings. Allow them and check in a new
  session, since a running session keeps its start-up tool list. Repository plugins never load
  in cloud sessions, so the connector is the only route there.
- **Connector versus plugin.** The Figma connector matches the Figma plugin except
  `generate_figma_design` and the skills' non-markdown script assets, and it is the only route
  on all three surfaces: cloud never loads plugins, while connectors reach terminal and cloud.
  An agent can toggle a connector only in the desktop app; the terminal needs `/mcp` or
  `disableClaudeAiConnectors` / `deniedMcpServers`, and cloud takes organisation settings.
  Prefer connectors over plugins for uniform setups.
- **Inspect a design system with one `use_figma` call.** `search_design_system` clamps a batch
  to one query. Inspect a design-system file with one read-only `use_figma` call instead
  (component sets with keys and props, `getLocalVariableCollectionsAsync`,
  `getLocalTextStylesAsync`) and import with `importComponentSetByKeyAsync`,
  `importVariableByKeyAsync` and `importStyleByKeyAsync`. An empty `createAutoLayout` frame is
  100x100, and scrim opacity belongs on `node.opacity`, not a variable-bound paint.

## Long-running commands and waits

- **Push in the background.** Run a `git push` whose pre-push hook can exceed the Bash tool's
  10-minute foreground timeout as a background task with its output in a log, and act on the
  task notification; a killed foreground push lands nothing and leaves no trace. Do not add
  waiter loops: `pgrep -f "<cmd>"` matches the waiter's own command line and never exits, and
  `grep -q` on a log with invalid UTF-8 treats it as binary and exits 1, so use `grep -qa`.
- **`tail -F | grep -m1` lingers.** A background wait written as
  `tail -F log | grep -m1 pattern` keeps running after grep matches, because `tail` dies of
  SIGPIPE only on its next write and a finished log is never written again. Wait with
  `until grep -qa "pattern" log; do sleep 30; done` instead, and stop any wait whose result you
  have read or whose target was superseded.
  <!-- when: command "tail -[fF] .*\| *grep .*-m ?1" -->
- **Exit codes that lie.** `cmd | tail` returns tail's exit code and masks failures, so never
  chain `... | tail && git push`; check `$?` or use pipefail. `pnpm --filter <pkg> <script>`
  exits 0 when the package has no such script, so confirm the suite's summary line appears, not
  just the exit code. In zsh `for x in $var` does not word-split (use `${=var}`). A monitor that
  exits on a false "all done" looks identical to success, so validate its first event.

## Several sessions at once

- **Parallel agents in one worktree.** Have each agent commit with an explicit pathspec
  (`git commit -- <paths>`) or its own `GIT_INDEX_FILE`, because a bare `git commit` publishes
  whatever any agent staged. Pin baselines to a commit sha rather than the dirty tree; an agent
  that thinks a decision is needed must stop and surface it.
  <!-- held by: pariksha authority-citations (refuses an uncited "owner decision" or "approved by") -->
- **A peer session relays a user decision.** When a peer session relays "the user told me X" and
  it contradicts what the user told this session, ask the user here with both answers quoted,
  and hold pushes and thread resolution on both sides until answered. When you relay, say it is
  a relay and name the question and the option chosen; an irreversible step taken on a relay
  needs the user's word in the session that takes it.
- **A coordinator over task sessions.** Run tasks in parallel only when they touch different
  files, keep version bumps and tags to the coordinator, and have each task session end with a
  status word (`DONE: merged #N`, `DONE: closed #N`, `DONE: nothing to do`, `BLOCKED: <need>`,
  else `WAITING: <on what>`). Auto-fix wakes a session for a CI failure, conflict or review
  comment but never for a clean merge, so on every wake the coordinator also sweeps its linked
  sessions' PR state and `git log <last tag>..origin/main` to catch merges it was not told about.

## Claims and evidence

- **Probe live state before calling something a blocker.** An issue captures one moment, and
  fixes done by hand leave no tracker trace, so probe current state (service logs, check-run
  conclusions, deploy time against merge time) before reporting a filed issue as a live blocker.
  An empty log query on a just-replaced deployment is not proof a process is dead; check the
  serving deployment and its health endpoint first.
- **Baseline before declaring something systemic.** Before filing a finding that X is broken or
  systemic, read the vendor's docs and the repository's own config for X, and baseline it over
  about 30 comparable cases (one `gh api graphql` loop over recent PRs); three of your own PRs is
  not a pattern. For example, a review bot's NEUTRAL check means that review was skipped, not
  that the bot never re-reviews. When wrong, retract in the same place with the evidence that
  overturned the claim.
- **Never match on generated text.** Never dedupe, resume or match on LLM-generated text
  (titles, prose, even stemmed keys); it drifts between runs and duplicates get filed. Persist a
  machine marker written before the fan-out, or key on something code-derived such as the path
  plus a SHA-256 of the whitespace-normalised source window.
- **Lookup keys are identities in a rename.** When inventorying what a rename touches, list
  every string used as a lookup key by equality, not only columns and labels: retry-table keys,
  job names, exact-title upsert keys. Grep for equality predicates (`WHERE col = 'literal'`,
  `findByTitle`, upsert-by-name helpers) and migrate the stored data in the same change, or
  lookups miss and records get duplicated or reprocessed.
- **UTC against local time.** Stored timestamps (databases, GitHub, hosting logs) are UTC while
  the session's idea of today is local time. Before claiming something has been silent for N
  hours, run `date -u` and state now and the newest timestamp in the same clock. If hours of
  silence coexist with green services, suspect the arithmetic first.
