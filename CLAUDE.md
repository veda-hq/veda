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
  `niyam review-thread <id> --resolve`,
  `niyam onboard <owner> <agent> --dry-run`); a
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

## Git hooks

git runs the tracked hooks in `.githooks/`: `pre-commit` (dvara's records
and frozen gates) and `pre-push` (those gates, `pnpm guards`, then niyam's
pre-push for an agent session). The main checkout's shared git config sets
`core.hooksPath` to `.githooks`, set once by Alok. Worktrees share that
config, and the path is relative, so each worktree runs its own branch's
hooks under its own `node_modules`. When a hook says a pinned package is
not installed, run `pnpm install` in your worktree. The hooks folder in the
git directory, where `niyam onboard` once wrote its pre-push, never runs.
onboard now reads `.githooks/pre-push` as its own and leaves it alone. A
Claude cloud session's fresh clone has no such config, so niyam's session
start writes its own pre-push into that clone's git directory. Check the
setting with `git config --show-scope --show-origin --get-all core.hooksPath`,
run inside the checkout or worktree you mean. Outside a repository it reads
only global and system config. It should print one `local` line, from the
main checkout's config file, with the value `.githooks`. git uses the last
line it prints. A `global` or `system` line comes first and loses to the
`local` one. The repository has `extensions.worktreeConfig` on, so a
`worktree` line, from that worktree's own `config.worktree`, comes last and
wins there, and that worktree skips `.githooks`. For either, tell Alok,
and leave the setting alone.

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
