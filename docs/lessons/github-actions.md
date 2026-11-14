# GitHub Actions

Traps in GitHub Actions that cost a coding agent a red PR, a wasted push or a wrong number: how
jobs are billed, which ref and which run a check reflects, path filters, expressions and code
scanning. Each lesson names the symptom and the fix.

## Billing and usage

- **Billing lock: every job fails in seconds.** When every Actions job fails in 2 to 4 s with no
  steps, or with empty or `BlobNotFound` step logs, it is a billing or spending-limit block, not
  code. Read the annotation (`gh run view <id>`, or
  `gh api repos/<owner>/<repo>/check-runs/<id>/annotations`): "recent account payments have failed
  or your spending limit needs to be increased" blocks every PR. Do not re-run or push fixes.
  Only the account owner can clear it in the billing settings; afterwards run
  `gh run rerun <run-id> --failed` once.
  <!-- when: error "your spending limit needs to be increased" -->
- **The billing usage endpoint spans repositories.** The organisation's Actions billing usage
  endpoint returns one row per SKU per repository per day, so filter on `repositoryName` before
  summing one repository's minutes. The runs API caps at 1,000 results, so fetch day by day.
  Dependabot runs with event `dynamic` report jobs of about 1,440 minutes that are not billed,
  and job wall-clock overstates billed minutes by about 3%. Pick one population, state its
  exclusions and derive every figure from it.
- **Every job is rounded up to a minute.** GitHub bills each job rounded up to a whole minute,
  plus about 90 s of fixed setup per job, so many sub-minute jobs cost far more than their run
  time. Cost a CI change by counting jobs, not seconds. A step-level `if:` still starts and bills
  the job, so build the matrix upstream or drop the job. Measure `sum(ceil(secs/60))` against
  `sum(secs)/60` from the jobs API, and treat per-second billing as a criterion when choosing a
  runner provider.

## Runner images and Node

- **Pin Node from the version file, never a bare major.** `actions/setup-node` given a bare major
  such as `node-version: '24'` resolves against the runner image's tool cache, so CI's Node patch
  depends on the runner fleet, and providers' images differ. Node 24.11 to 24.13 `fs.rmSync`
  throws `ERR_FS_EISDIR` on a symlink to a directory even with `force`, and silently leaves a
  dangling symlink (fixed in 24.14); one image shipped such a Node and broke symlink fixtures.
  Set `node-version-file: .nvmrc` and fail CI on a bare major. Keep a single tracked version file
  (a nested `.nvmrc` switches shells under fnm). When CI breaks with no repository change, read
  the "Found in cache" Node version in the job log first, and after any runner change watch the
  first merge-queue run, not only PR checks.

## Jobs, matrices and aggregate gates

- **A matrix leg cannot skip itself.** The `matrix` context is not available in a job-level
  `if:`. Build `include:` upstream and condition the whole job on the list being non-empty (an
  empty matrix errors). Every job bills at least one minute, so prefer fewer jobs to step-level
  guards.
  <!-- held by: pariksha aggregate-gate-needs (refuses an aggregate gate whose needs omit a job) -->
- **`startup_failure` with no jobs or logs.** actionlint misses both common causes. A job that
  calls a reusable workflow sets a permissions ceiling, so the caller must grant everything the
  called jobs request (for example `pull-requests: read` for `dorny/paths-filter`). A dynamic
  matrix's `fromJSON` must sit at `strategy.matrix` with a complete `{"include":[...]}` value,
  never at `matrix.include`. Guard both with tests that compare callers with callees and
  producer with consumer shapes.
- **`a && b || c` with a falsy `b`.** The expression yields `b` only when `b` is itself truthy,
  so `cond && 0 || 1` always gives `1` and the fix silently does nothing; actionlint and
  text-reading tests pass both spellings. Quote falsy values (`cond && '0' || '1'`) with a
  comment saying why.
- **ESLint from the root walks nested worktrees.** ESLint run from a repository root can run out
  of memory by traversing nested worktrees under `.claude/worktrees/`; ignore that directory.

## Path filters

- **`paths` filters are not gitignore.** `paths` and `paths-ignore` match each pattern against
  the full path from the repository root, and `*` does not cross `/`. A bare name is already
  root-only, and a leading `/` matches nothing and silently stops the workflow. Refuse reviewer
  suggestions to add a leading `/`, citing the filter cheat sheet in GitHub's workflow-syntax
  docs.
- **A new category narrows the catch-all.** Adding a `dorny/paths-filter` category takes paths
  out of any catch-all ("unmatched") category, silently narrowing every job whose `if:` relied on
  it. A job that does not run reports skipped, and an aggregate gate that reads skipped as pass
  then merges unverified changes. Pin the accounting with a test that every category appears in
  each consuming condition or carries a written exclusion reason.
- **`dorny/paths-filter` negation and brace globs.** `!` excludes work only with
  `predicate-quantifier: 'every'`, and a brace glob like `**/*.{ts,js}` does not match root-level
  files in picomatch, so add a `*.{ts,js}` alternative.
- **Semgrep suppressions.** A `nosemgrep` comment applies only to the next line.

## Which ref and which run a check reflects

- **CI builds the merge ref.** For `pull_request` events GitHub builds `refs/pull/<n>/merge`,
  not the branch head, so a green local suite on a branch behind main is not evidence: semantic
  conflicts that git merged cleanly show up only there. Merge main early and often. When CI fails
  but local passes, check which ref CI built; `gh run view --json headSha` reports the head, and
  stack-trace line numbers beyond your file's length are the tell.
- **A conflicted PR runs no CI.** A PR with merge conflicts (`mergeStateStatus` `DIRTY`) triggers
  no `pull_request` workflows, so only external app checks (merge queue, review bots) report and
  the PR looks green. Before believing a PR is green, compare its check count with the
  repository's normal count and confirm `gh run list --branch <branch>` is non-empty. A CI watcher
  must require a minimum check count and two consecutive settled polls.
- **`workflow_dispatch` can dequeue a PR.** A dispatch run from a branch with an open PR posts
  every job's check on the head sha, including a required aggregate gate as skipped, which
  replaces the PR run's success. A merge queue's `check-success` then fails and dequeues the PR,
  while branch protection accepts skipped. Never add dispatch to a workflow holding a required
  gate; put ad-hoc runs in a separate workflow with no gate-named job. On an unexplained dequeue,
  look for a newer skipped check with the same name.
  <!-- held by: pariksha aggregate-gate-needs (refuses workflow_dispatch on the workflow holding the gate) -->
- **A re-run replays the original event.** Re-running a failed `pull_request` job reuses the
  original event's merge ref and workflow file, so after a workflow fix lands on the default
  branch, merge it into the blocked branch and push instead of re-running. It replays the old
  PR body too: a check that reads the PR body from the event payload
  keeps the original body on `gh run rerun`, so it fails again after the body is fixed. Put
  required body lines in before the first push. Otherwise re-trigger it with a
  `gh pr edit --body-file` change when the workflow listens to the `edited` event, or push a new
  commit; never just rerun.
  <!-- when: command "\bgh run rerun\b" -->
- **Review-thread checks go stale.** GitHub emits no event when a review thread is resolved, and
  it mints a new check suite per trigger event, so same-named check rows never overwrite each
  other and only re-running that run updates its row; `cancel-in-progress` leaves permanent red
  rows. For a thread-count check, trigger on `pull_request` only with a PR-plus-sha concurrency
  key, and turn review events into a rerun of that one row. `workflow_run` and `schedule`
  workflows fire only from default-branch files, so they activate on merge, not on the PR.
  <!-- when: path ".github/workflows/*.yml" -->
- **`continue-on-error` reports success.** A step with `continue-on-error: true` reports
  conclusion `success` in the jobs API even when it failed; the failure lives only in `outcome`
  and the log text. Before removing `continue-on-error` or citing such a step as proof, grep its
  log for `##[error]` (`gh api repos/<owner>/<repo>/actions/jobs/<id>/logs`).
  <!-- when: command "continue-on-error" -->

## Code scanning

- **CodeQL SARIF omits the default level.** SARIF omits `result.level` when it equals the rule
  default, so a gate that filters on `.level == "error"` misses most error-level alerts. Compute
  the effective level from the rule's `defaultConfiguration.level` (else `"warning"`) before
  counting, and prove the gate with a planted known alert.
- **CodeQL suppression comments.** `// codeql[rule-id]` comments do nothing unless
  `AlertSuppression.ql` runs with the suite; `security-and-quality` omits it, so add it via
  `packs:`. A comment covers only the next line, which must be the alert's start line, and
  nothing may precede it on its line (JSX `{/* */}` is ignored). Write `codeql[a] codeql[b]`, not
  a comma list. For `js/request-forgery`, a literal `https://host/` prefix does not clear a
  tainted path.
- **CodeQL upload without Code Security.** On a private repository without Code Security,
  `github/codeql-action/analyze` with upload fails 403 ("Code Security must be enabled"); use
  `upload: never` and gate on the SARIF.
