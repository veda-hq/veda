# Git and GitHub

Lessons about git and GitHub as agents use them: worktrees and shared checkouts, pushes that
report success without landing, commit messages and trailers, hooks and shell scripts, merges
and PR state, and the GitHub API.

## Worktrees and shared checkouts

- **The index is shared within a worktree.** Everything working in one worktree shares one git
  index, so another session's or the user's next commit can sweep your staged files;
  explicit-path `git add` stops you sweeping theirs, not this. When someone else may commit in
  the same worktree, stage and commit in one command, never leave files staged across a long
  verification, and judge idleness by file mtimes rather than a session-list status.
- **A fresh worktree has no `node_modules`.** If you symlink them in, `.gitignore`'s
  `node_modules/` matches directories only, so `git add -A` stages the symlinks: add them to
  `.git/info/exclude` or run a real `pnpm install` instead.
  <!-- held by: kavach worktree guard (refuses switching HEAD or stashing outside the session's own worktree) -->
- **Handing a branch to another worktree.** Run `git -C <other worktree> switch --detach` there:
  it frees the branch name without touching refs (always pass `-C`, or the wrong checkout gets
  detached). Linked worktrees share one object store, so you can also branch at the peer's head
  and push to the PR's remote ref. Check `gh pr view <n> --json baseRefName` before believing a
  handoff's stated base.
  <!-- when: error "is already used by worktree at" -->
  <!-- when: error "already checked out at" -->
- **`core.hooksPath` must be relative.** Set `core.hooksPath` to a relative path to the tracked
  hooks directory (for example `.husky`) so every worktree runs its own hooks; an absolute path
  into the main checkout runs main's hook scripts against the worktree. With
  `extensions.worktreeConfig`, a per-worktree override in `config.worktree` wins over the shared
  value, and some tools (the Claude desktop app at worktree creation among them) write an
  absolute one. Diagnose with `git config --show-origin --get-all core.hooksPath` and clear it
  with `git config --worktree --unset core.hooksPath`.
- **Every worktree fails with "must be run in a work tree".** If git fails in the primary
  checkout and every worktree at once with "this operation must be run in a work tree", check
  the shared `.git/config` for `core.bare = true`;
  `git config --file <repo>/.git/config core.bare false` restores them all. One known cause is a
  test that runs `git init` under a git hook, where an exported `GIT_DIR` overrides the cwd.
  <!-- when: error "this operation must be run in a work tree" -->
- **Squash merges defeat merged-branch checks.** Squash merges leave a merged branch's commits
  off main, so `git branch -d`, "commits ahead" and `git cherry` cannot tell merged from
  unmerged; use the merged-PR head-branch list from `gh` as the safety signal before deleting.
  Set `git config --global fetch.prune true`, because GitHub's delete-branch-on-merge never
  reaches local clones, and let `git worktree prune` remove only already-deleted worktree
  directories.
  <!-- when: command "\bgit (branch -[dD]|cherry(?![-\w]))" -->

## Pushing

- **Verify a push on the remote.** A background `git push` can report success without the
  commits landing; verify against the remote (`git status -sb` shows no "ahead", or
  `git ls-remote`), never the job's exit code.
- **SSH drops during a long pre-push hook.** git opens the SSH connection to the remote before
  running the pre-push hook and holds it idle, so a long hook can pass and then fail with
  "Connection reset by peer" or exit 141, publishing nothing. Push over HTTPS
  (`gh auth setup-git` plus an HTTPS push URL), which makes a fresh request after the hook, or
  set `ServerAliveInterval` for SSH, and confirm with `git ls-remote`, never the exit code.
- **HTTPS pushes need the `workflow` scope.** Pushing over HTTPS with a gh OAuth token that lacks
  the `workflow` scope is rejected ("refusing to allow an OAuth App to create or update
  workflow") for any commit changing `.github/workflows/`, and only after local pre-push hooks
  finish. Check `gh auth status` for the scope before a long push; fix with
  `gh auth refresh -s workflow`, or push that branch to the SSH URL with a `ServerAliveInterval`
  keepalive.
- **A refspec push leaves no upstream.** A push by refspec
  (`git push origin <sha>:refs/heads/<branch>`) records no upstream and does not update
  `origin/<branch>`, so anything reading `@{u}` thinks the branch is not on the remote. After
  the first such push run `git fetch origin <branch>` and
  `git branch --set-upstream-to=origin/<branch>`.
  <!-- when: command "git push \S+ \S+:refs/heads/" -->
- **`* [new branch]` on a PR branch.** If pushing to a PR's branch prints `* [new branch]`, the
  PR already merged and its branch was deleted; your commits now sit on an orphan branch, so
  re-apply them on top of main in a new PR.
- **Tracked-files checks pass on new files.** A check that scans only git-tracked files passes
  vacuously on a new untracked file, so stage it before running the check.
- **Read-then-write on a counter races.** Code that looks up the latest round (or version) of a
  record and then writes against it races a concurrent writer that advances it in between.
  Make the write carry the check: `... AND round = (SELECT MAX(round) ...) RETURNING`, and treat
  no returned row as a lost race.

## Commit messages and trailers

- **Trailers must be in the final block.** Git reads trailers only from the last paragraph of a
  commit message, so a blank line between a custom trailer and `Co-Authored-By` hides the custom
  one from `%(trailers)` parsers, and each `git commit -m` is its own paragraph. Put every
  trailer in one block with no blank lines (one `-m` with embedded newlines, or `-F <file>`) and
  verify with `git log -1 --format=%(trailers)`; fix after the fact with an `--allow-empty`
  commit carrying the block.
- **commitlint reads `#<number>` lines as footers.** commitlint parses a body line containing a
  `#<number>` reference as a footer, so a long line such as "... describes only PR #N. Keep ..."
  fails `footer-max-line-length` (100) after every other hook has run. Wrap body lines well under
  100 and keep issue references off long lines.
- **The shell eats commit messages.** In zsh, backticks, `$()` or `!` inside a double-quoted
  `git commit -m` are expanded and the word silently vanishes; commitlint checks only the
  header, so the damage ships. Write the message to a file and use `git commit -F <file>`, and
  `gh pr create --body-file` for PR bodies.

## Hooks and shell scripts

- **`pipefail` with `grep -q` fails open.** Under `set -euo pipefail`, `printf "$LIST" | grep -q`
  can misreport: grep exits at its first match, the next write gets EPIPE, and pipefail returns
  the writer's failure. Write `grep -q ... <<<"$LIST"`; the check covers only its
  `pipefailScope` (default `.husky/`), so scripts elsewhere are yours to watch.
  <!-- held by: pariksha masked-exit-codes (rule 3) -->
- **`pre-merge-commit` has no MERGE_HEAD.** During a clean `git merge`, the `pre-merge-commit`
  hook runs before MERGE_HEAD exists (only a stopped merge writes it); the merged heads are in
  `GITHEAD_<sha>` env vars and `GIT_REFLOG_ACTION`. Do not trust those by name: accept a
  candidate only when `git merge-tree --write-tree HEAD <sha>` equals `git write-tree`, and test
  such checks through a real `.git/hooks/pre-merge-commit` in a fixture.

## Merges and PR state

- **A PR's head branch is not what merged.** Confirm each PR a task names with
  `gh pr view <n> --json state,mergedAt,mergeCommit` and read `git show --stat <mergeCommit>`
  before follow-up work. Branch from `origin/main` and re-run your probes there; a pass against
  the pre-merge branch or a local merge of it is not evidence.
- **Resolve conflicts hunk by hunk.** When resolving conflicts on a long-running branch,
  `git checkout --ours <file>` or `--theirs` is file-wide and drops the other side's changes to
  that file. Never use `git checkout -- <file>` to restore while uncommitted work is present;
  commit or copy it first.
- **Review bots that need a seat; verified commits without a key.** Some review bots review only
  PRs whose author holds a seat, so a PR opened by an unseated bot sits skipped and never
  merges. To get a GitHub-verified commit without a local signing key, create it with GraphQL
  `createCommitOnBranch`, which GitHub signs server-side.

## The GitHub API

- **Mutations during an outage may have landed.** During a GitHub API outage a GraphQL mutation
  that returns 502 or 504 (thread reply, resolve) may still have landed. Verify via REST
  (`pulls/<n>/comments`, `in_reply_to_id`) before retrying, and make retries idempotent. A
  review bot's check run can hang `in_progress` and block a merge queue; it is a check run, not
  a status, so list check-runs with `?per_page=100`, and check GitHub's own health before fixing
  scripts.
  <!-- when: error "HTTP 502" -->
  <!-- when: error "HTTP 504" -->
- **Thread ids collide on a case-insensitive filesystem.** Review-thread node ids are
  case-sensitive base64 and can differ only by case, so naming one reply file per thread id on
  macOS APFS merges two files and posts the wrong reply. Key reply files by index or comment
  `databaseId`, check the posted count, and fix a misposted reply with
  `gh api -X PATCH repos/<owner>/<repo>/pulls/comments/<databaseId> -f body=...`.

## Git internals

- **Holding a real ref lock in a test.** Use `git update-ref --stdin` (`start`,
  `create <ref> <sha>`, `prepare`; wait for "prepare: ok") rather than a hand-made `.lock`. Four
  of five update-ref failure shapes say "cannot lock ref" and the discriminator is localized, so
  never classify by message text: probe `show-ref --verify` (present means you lost the race)
  and treat the rest as indeterminate. SIGKILL to a node parent never orphans a `.lock`; only
  SIGKILL to git itself does.
- **EAGAIN is a container limit.** `spawn git EAGAIN`, "cannot fork() ... Resource temporarily
  unavailable" or "unable to create thread" in a container means its PID or thread limit is
  hit, not a corrupt repository, network or token problem. Reduce concurrent sessions and set
  `pack.threads=1` (via `GIT_CONFIG_*`), and classify such pre-session infrastructure failures
  so the work is requeued instead of counted as failed.
  <!-- when: error "spawn git EAGAIN" -->
  <!-- when: error "Resource temporarily unavailable" -->
- **Raw NUL bytes hide diffs.** A raw NUL byte in a source file makes git treat it as binary,
  so its diff shows "Bin N -> M bytes" and the change is invisible to review and blame while
  tsc, lint and tests pass. Write NUL separators as the `\0` or `\x00` escape, detect with
  `file <path>` reporting "data", and guard with a test that fails on any raw NUL in tracked
  source.
