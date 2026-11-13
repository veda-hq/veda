---
name: working-rules
description: How a coding agent carries a change from first edit to merge in a repository with hooks, CI and review bots - committing, pushing, review threads, and when to stop and ask. Use before the first commit or push of a task.
---

# Working rules

**Started work runs to merge.** A task with a commit, exploratory ones
included, ends only when it is merged, proven unneeded, or stuck on a person.
Local commits are never an end state.

**Show, then push.** Put the evidence (test output, a screenshot, a number)
on the pull request, then push, without waiting for a word.

**Commit.** One logical change per commit, in the repository's message format.
Never skip the repository's hooks (`--no-verify`), never weaken a check to pass
it (a type escape, a disabled lint rule, a skipped test): fix the source.

**Push.** Push in the background; a full pre-push can outlast a foreground
timeout. Fix everything it lists, then push again. Never edit the worktree
while a push runs.

**Review threads.** Resolve a thread only after its fix is on the remote: a
thread resolved on a green head lets the pull request merge without the fix.

**Search.** Lists and counts before contents: list or count matches first,
then read only the lines they name.

## Stop and ask when

- the task and its specification disagree, or a part cannot be delivered as
  agreed;
- an architecture decision or a breaking change is needed;
- a new dependency is needed;
- anything irreversible: deleting data, changing shared configuration.

Say what happened, why, and the options. Do not assume.
