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

## Merging

Right after `gh pr create`, turn on auto-merge: `gh pr merge --auto --squash`
(in the Claude app, the pull request tools' auto-merge does the same). The
`main` ruleset holds the merge until every required check passes, Cubic's
review included, and every review thread is resolved. Nobody clicks merge.

One exception waits for a person: once the ruleset requires code-owner
review, a pull request touching a path `.github/CODEOWNERS` gives Alok
(workflows, the version rule, the README) also waits for his approving
review, then merges by itself. Until he approves, it is open, not done.

Leave auto-merge off only to hold a pull request on purpose (say why in it),
or for a change that needs Alok's yes first, such as a major release
(README, "Releasing"). A merge publishes nothing: only a `v*` tag releases.
