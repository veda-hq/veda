# Review bots and merge queues

Lessons about an AI code reviewer (Cubic) and a merge queue (Mergify) on GitHub pull requests:
running the reviewer's CLI, its limits and what it costs, findings that come back reworded
every round, why a green PR sits unqueued, and when it is safe to resolve review threads.

## The Cubic CLI

- **Exit codes and the diff base.** `cubic review --json` exits 1 when it has findings and 0
  when clean, so let the JSON envelope decide, never the exit code. `--base` is a two-dot diff,
  so pass `git merge-base <ref> HEAD`. An invalid base ref returns exit 0 with no issues, so
  `git rev-parse` the ref first. The CLI rewrites its own login state on disk to rotate a
  short-lived token, so that state must stay writable, and login has no non-interactive mode.
- **macOS can kill the CLI at exec.** The installer leaves `~/.cubic/bin/cubic` ad-hoc signed,
  and macOS AMFI can SIGKILL it at exec (exit 137, no output, no log), which a hook may read as
  a clean review. Reinstall with `rm -rf ~/.cubic` and the install script, then always run
  `codesign -f -s - ~/.cubic/bin/cubic`; login survives a reinstall. `~/.cubic/bin` must be on
  `PATH` for git hooks.
- **"413 Request Entity Too Large" is tool output.** It is not a diff-size budget: the review
  agent's grep returns whole lines, and a huge single-line tracked file (multi-MB HTML or JSON)
  blows up the request nondeterministically. Read the newest `~/.local/share/cubic/log/*.log`
  for a large `outputLength=`, find the long-line file, and add it to a root `.rgignore` instead
  of splitting commits.

## Limits and cost on pull requests

- **The 50,000-line cap.** Cubic skips PRs over 50,000 reviewable lines with a "skipped" check
  titled "AI review skipped — PR too large", and `trigger_pr_review` still skips, so a merge rule
  that needs Cubic's pass can never be met. Check the check-run title as soon as a big PR opens,
  and split by workspace: rebuild each branch from the final tree by path and prove
  `git diff --stat <local source> HEAD -- <workspace>` is empty.
- **The review allowance.** The PR-review allowance is per purchased seat, pooled across the
  team. Read the live limit from the subscription API, never from a pinned constant or memory.
  When the allowance runs out, the check goes neutral "AI review line limit reached", and a
  Mergify rule requiring `check-success` never queues the PR even though `gh pr checks` shows
  nothing failing. Buying seats or flex capacity is an owner spend decision, so never narrow
  review scope to fit a budget.
  <!-- when: error "line limit reached" -->
- **Re-triggering a review.** Comment `@cubic incremental review` only if Cubic already
  reviewed that PR (cheaper on the line allowance); otherwise comment `@cubic review`, since
  incremental needs a prior full review. Check `gh pr view <n> --json reviews,comments` for a
  Cubic author first. Both `@cubic` and the bot's full handle `@cubic-dev-ai` have been used to
  trigger reviews.
  <!-- when: command "gh pr comment .*@cubic" -->
- **NEUTRAL after a rebase; rollup state.** Cubic reports NEUTRAL when it skips a push with no
  new content (a pure rebase), and Mergify's `check-success` matches success only, so such a PR
  parks blocked; post `@cubic-dev-ai review` to force a fresh review. A non-required check still
  drives `statusCheckRollup.state`, so one failing helper check makes every consumer that
  requires rollup SUCCESS skip the PR; filter the rollup contexts by name instead.

## Findings that come back every round

- **A dismissed design finding returns reworded.** An exact-title dismissal of an AI reviewer's
  design finding buys one round: the next review re-raises it reworded. When the finding has a
  cheap code answer, fix it instead of dismissing. When the reviewer reads a spec sentence
  literally, reword the rule and re-judge every line, not only the flagged one.
- **Touching a function re-raises its old findings.** An AI reviewer rewords a pre-existing
  finding on each review when your diff touches its function, and title-matched dismissals never
  generalise. Keep your diff out of a function that holds another branch's bug, and merge main
  only on a real conflict (a moved merge base buys a fresh review). On fail-open against
  fail-closed flips, pick one side, document it in the code comment, fix once, then dismiss the
  reverse naming the backstop.
- **Stream race findings.** AI reviewers re-raise reworded race findings on pause/drain stream
  code, and dismissing one wording yields the next. Write stream code so the claim cannot be
  stated: attach `drain`, `close` and `error` listeners once before any output (never inside a
  data handler) and check `destroyed` before and after `write`. Prove each real finding with a
  test before dismissing the rest.
- **Static "does this code read X" checks are never complete.** An AI reviewer finds a new edge
  each round. Design the edge cases (merged head, dirty tree, symlinks, path traversal, missing
  fields) before the first commit, fix the cheap real ones, fail closed only after probing the
  real repository, and close the undecidable residual with an accepted-limit dismissal that
  names the backstop.
- **Design shared state before the first commit.** Before the first commit that adds a state
  file, marker, lock or record read or written by several processes, check four classes in that
  commit: ordering gap (write state before the spawn or claim), failure cleanup (no stale state a
  reader trusts), overlap (one file per writer, sweep only expired entries) and input validity
  (validate every field's shape). Then ask whether a design with less shared state does the
  job; otherwise an AI reviewer raises these one per round.

## The Mergify queue

- **A green PR that never queues.** Read the Mergify "Summary" or "Merge Queue" check-run output
  (`gh api repos/<owner>/<repo>/commits/<branch>/check-runs`) and act on the first unchecked
  condition; cached mergeability (`CLEAN`, `MERGEABLE`) can be stale, and Mergify can keep a
  stale verdict such as `-conflict` after a fixing push. For `-conflict`, try a clean local
  merge first: if it merges clean, comment `@mergifyio refresh` instead of pushing, since a push
  resets the queue, and if it is still unqueued, `@mergifyio queue`. After the last check goes
  green, always confirm the PR actually entered the queue.
  <!-- when: command "@[Mm]ergifyio (refresh|queue)\b" -->
- **In-place checks and self-merge.** Mergify uses in-place checks (compatible with GitHub's
  "require branches up to date" rule) only when `merge_queue.max_parallel_checks` is 1, every
  queue's `batch_size` is 1, `merge_conditions` equal `queue_conditions` (single-step CI) and
  `max_checks_retries` is 0; any deviation silently falls back to draft PRs (behaviour seen in
  2026; check Mergify's current docs before relying on it). Because
  `mergify[bot]` performs the merge, an agent's own PR merges without tripping self-approval.
- **BEHIND means unqueued.** `mergeStateStatus` `BEHIND` on every open PR is what an unqueued
  Mergify repository looks like, not evidence of a stalled queue, and `BEHIND` masks `BLOCKED`.
  For a green PR that will not merge, look for an unresolved review thread first (branch
  protection's conversation-resolution rule gates it even when the Mergify config never mentions
  threads), and re-collect threads after every push, because review bots add new ones.
  <!-- when: command "--json[ =]\S*mergeStateStatus" -->
- **"Checks timed out" needs a requeue command.** After Mergify dequeues a PR for "Checks timed
  out", re-adding the queue label does not requeue the same head, and such dequeues are not
  auto-requeued; comment `@mergifyio requeue`. Give every merge-queue job a `timeout-minutes`
  (GitHub's default is 360), and check a "pending 0" job's steps through the jobs API before
  concluding no runner picked it up.
  <!-- when: error "checks timed out" -->
- **Speculative drafts run every workflow.** A Mergify speculative-check draft is an ordinary
  PR against the base branch, so every `pull_request` workflow runs on it: commit-range checks
  see its untyped "Merge of #N" commit, and review bots that skip drafts post no check there.
  Before requiring a check in `merge_conditions`, ask whether it reads commit messages or skips
  drafts. Make commitlint ignore the merge commit and keep draft-skipping bots in
  `queue_conditions` only.
- **"Require branches up to date" re-bills the reviewer.** A strict up-to-date ruleset forces
  every PR to absorb each merge, and each update re-triggers and re-bills the review bot; drop
  it and let Mergify prove freshness on speculative merge-queue drafts. Any required status
  check that never runs on `mergify/merge-queue/*` drafts (such as an AI reviewer) then times out
  every queued PR, so gate it in Mergify's `queue_conditions`, not the ruleset.
- **Stacked PRs and subagent watchers.** A stacked PR goes dirty when its base squash-merges:
  merge main in, then `@mergifyio requeue` (not refresh) if it was dequeued. A subagent's
  "watcher armed" report can die silently with the subagent, so the coordinating session keeps
  its own watch on each PR until it merges.

## Threads and merge timing

- **Push fixes before resolving threads.** When a merge queue auto-queues on green checks plus
  zero unresolved threads, resolving the threads before the fix commits are on the remote merges
  the pre-fix head within minutes. Push the fixes, wait for green, then resolve. If it happens
  anyway, open a forward-fix PR from fresh main and comment on the merged PR so its "fixed"
  threads point at it.
- **Pre-push and queue gates can disagree.** A pre-push review gate that rejects pushes and a
  merge queue that judges the published head can disagree: after many rejected rounds the
  mergeable head lags the real branch, and resolving the last stale thread arms a merge of the
  old head. When pre-push has been rejecting for several rounds, compare `git ls-remote` with the
  local head before touching thread state. Durable fixes are reviewing exactly the pushed range
  and requiring the queued sha to equal the branch head.
- **A green reviewer check is not a green review.** Never report the AI reviewer green from its
  check run alone: the check succeeds when the review is posted while unresolved threads still
  block the queue, so read `reviewThreads.isResolved` too. After a force-push the reviewer may
  not re-post its required check, leaving the PR blocked on an invisible pending check; push a
  normal commit or merge main in, and prefer merging main over rebasing. Diff a bot PR against
  `origin/main` before merging; it may be a subset of already-merged work.

## PR bodies

- **A bot can revert your body edit.** After `gh pr edit --body-file` on a PR that a review bot
  summarizes, re-read the body with `gh pr view <n> --json body`: the bot can write back the
  earlier body with its summary appended, reverting your edit. Rebuild the body as your text
  followed by the bot's own blocks from its footer marker onward, then re-read.
  <!-- when: command "gh pr edit .*--body" -->
