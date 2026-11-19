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
and frozen gates) and `pre-push` (those gates, `scripts/guards.sh`, then
niyam's pre-push for an agent session). The main checkout's shared git config sets
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

**Agents do not change the hooks or what they run** (veda#235). That is
`.githooks/`, `scripts/guards.sh`, `scripts/released-pins.mjs`,
`.dvara.json`, `.veda/records-baseline.json`,
`.veda/required-settings.json`, `.github/niyam.json`, and `node_modules/`
(`pnpm install` still runs). A worktree runs its own
copy of each, so an edit would let that session's own pushes skip the
checks. Once veda's hooks run kavach 0.7.6, `worktree.protectedPaths` in
`.claude/kavach.json` lists them, and kavach refuses a session's writes to
them: Edit, Write, Bash, and the git commands that write the paths they
name (`git restore .` and `git checkout .` included). A command that names
the root as what it writes (`rm -rf .`, `cp file .`) is refused too: name
the paths. Run mutating commands from the root, not from `scripts/`,
`.github/`, `.veda/` or `node_modules/`. A hook change is Alok's. He makes
it himself, or allows one session by taking the path off the list in the
main checkout's `.claude/kavach.json` and putting it back after. That list
is every session's: while the path is off it, any session may write it, so
he does it with no other session working. A session that needs one
says so in its pull request or brief and leaves the file alone, and so
does one with a merge conflict in such a file. Pins in
`package.json` stay agents' work: `released-pins.mjs` holds each one to an
exact release.

## Merging

Right after `gh pr create`, turn on auto-merge: `gh pr merge --auto --squash`
(in the Claude app, the pull request tools' auto-merge does the same). The
`main` ruleset holds the merge until every required check passes and every
review thread is resolved. Nobody clicks merge.

Cubic reviews pull requests again: its monthly review allowance reset, Alok
said on 2026-11-19. `cubic.yaml` at the root lists the files it skips, so
the allowance goes on sources, tests, scripts, guards and hooks; what it
skips is Alok's call. Each Cubic finding is a review thread, and the merge
waits for all of them:

- Fix a real finding, push the fix and wait for green before resolving its
  thread. With auto-merge on, resolving the last thread merges the head as
  it stands.
- Answer every finding in its thread: the commit that fixes it, or why
  there is none. kavach refuses `niyam review-thread … --body-file`, so
  reply with `gh api graphql`'s `addPullRequestReviewThreadReply`, the
  body read from a file under `.tmp/` (`-F body=@.tmp/<file>`). Cubic
  resolves a thread it sees fixed; resolve the rest with
  `niyam review-thread <PRRT_…> --resolve`.
- A green Cubic check is not a finished review: read the pull request's
  `reviewThreads` too.
- When Cubic missed a push it had reviewed before, comment
  `@cubic incremental review`. `@cubic-dev-ai review` reviews the whole
  pull request again and spends the allowance on every line again: use it
  only on a pull request Cubic never reviewed. A push that adds nothing to
  the pull request's diff gets a neutral Cubic check, which `main`'s
  ruleset passes (neutral pull requests have merged), so it needs no new
  review. Merge `main` in only on a real conflict: a moved merge base buys
  a fresh review.

If the allowance runs out, the check reports neutral and the pull request
goes unreviewed: tell Alok rather than assume that is fine.
`docs/lessons/review-bots.md` has the rest.

One exception waits for a person: once the ruleset requires code-owner
review, a pull request touching a path `.github/CODEOWNERS` gives Alok
(workflows, the version rule, the README, the lint rules and their
suppressions) also waits for his approving review, then merges by itself. Until he approves, it is open, not done.

Leave auto-merge off only to hold a pull request on purpose (say why in it),
or for a change that needs Alok's yes first, such as a major release
(README, "Releasing"). A merge publishes nothing: only a `v*` tag releases.
