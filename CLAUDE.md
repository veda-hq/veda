# Agents in veda

Lessons learned with these tools (Claude Code, git and GitHub, Actions,
review bots, Node and pnpm, testing, Stryker) are in `docs/lessons/`; read
the matching file before working in that area.

## The advisor

Sessions here run with the advisor on, set to fable (`advisorModel` in
`.claude/settings.json`; `pariksha required-settings` refuses its removal).
Call it before an approach is fixed, before every push, and when stuck: two
failed attempts at the same thing, or a result that does not fit. Make the
work durable (written, committed) before the call.

## Guards

Every Bash, Edit, Write and NotebookEdit call goes through one PreToolUse
hook, `.claude/hooks/sarathi.sh`. It runs the handlers `.claude/sarathi.json`
lists, kavach's guards among them.

- **Worktree boundary.** kavach refuses a write outside this session's own
  worktree. That includes the main checkout, other worktrees, other
  repositories and the system temp folders (`/tmp`, `$TMPDIR`, the
  scratchpad). Keep scratch files in `.tmp/`, which git ignores. A command
  whose writes kavach cannot read off its command line is refused as
  "mutation targets could not be resolved": a script run as `node <file>`,
  a CLI it does not know, a heredoc. Package runners such as `pnpm` are
  reviewed, so they run from your own worktree: use the repository's
  scripts (`pnpm check`). Give `git commit` its message with
  `-F .tmp/<file>`. The niyam lines `.claude/kavach.json` lists run from the
  worktree root (`niyam --version`, `niyam propose <n> --page <url>`,
  `niyam review-thread <id> --resolve`, `niyam onboard --dry-run`); a
  `--reply "<text>"` with quotes does not.
- **Command guard.** kavach refuses any bypass of git's hooks
  (`--no-verify`, `-c core.hooksPath=…`), and any push that rewrites or
  deletes history.
- **The advisor stays on.** sarathi refuses a command that sets
  `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`.

The hooks load sarathi, and kavach through it, only from the **main
checkout's** `node_modules`, at the version the root `package.json` pins,
installed from the registry. A worktree's own install does not count, and
neither do `packages/sarathi` or `packages/kavach`, so a session cannot
swap the guards it runs under. A change to kavach or sarathi guards
sessions only after its release, a pin bump, and an install in the main
checkout.

**On a refusal**, read the reason and change the call to fit it. Do not
retry the same call, look for a spelling the guard misses, or turn a guard
off. If the refusal is wrong, it is a kavach bug: tell Alok the command
and the reason. If the reason says sarathi is not installed, the main
checkout needs `pnpm install` after a pin bump: ask Alok.

## Merging

Right after `gh pr create`, turn on auto-merge: `gh pr merge --auto --squash`
(in the Claude app, the pull request tools' auto-merge does the same). The
`main` ruleset holds the merge until every required check passes and every
review thread is resolved. Nobody clicks merge. No AI review runs: veda-hq's
Cubic trial is used up, and Alok said on 2026-11-14 he is OK with
unreviewed pull requests. Cubic's check still reports, as skipped.

One exception waits for a person: once the ruleset requires code-owner
review, a pull request touching a path `.github/CODEOWNERS` gives Alok
(workflows, the version rule, the README) also waits for his approving
review, then merges by itself. Until he approves, it is open, not done.

Leave auto-merge off only to hold a pull request on purpose (say why in it),
or for a change that needs Alok's yes first, such as a major release
(README, "Releasing"). A merge publishes nothing: only a `v*` tag releases.
