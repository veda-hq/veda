# shellcheck shell=bash
# Keep-going mode, for a preflight: the push hook itself, run ahead of the
# push, so the preflight and the push cannot drift apart. Only what a refusal
# does differs. In a push, a stage's `exit 1` ends the hook at its first
# failure. Here the same `exit 1` is recorded against the stage that raised it
# (DVARA_CURRENT_STAGE, stages.sh) and the hook carries on, so one run lists
# every failure. dvara_keep_going_report ends the run.
#
# Source it only in keep-going mode, after the runtimes the hook needs are in
# place, so a missing runtime still ends the run at once.
#
# How: a function named `exit` runs in place of the builtin. It takes over one
# case only, status 1 in the hook's own shell. In a subshell or a command
# substitution (BASH_SUBSHELL > 0) `exit` must still end that subshell, and
# every other status (0, a trap's 130 or 143, a probe's 124) is a real end, so
# those go to the builtin. Whatever `set -e` aborts on never calls `exit` and
# still ends the run. A stage written as a function keeps this behaviour: the
# function runs in the hook's shell, and execution continues after the `exit`.
#
# Plain strings, not arrays: macOS runs hooks under /bin/bash 3.2, where an
# empty array is an unbound variable under `set -u`.

DVARA_KEEP_GOING_FAILED=""
DVARA_KEEP_GOING_HELD=""
DVARA_KEEP_GOING_SKIPPED=""

# shellcheck disable=SC2034 # DVARA_UNREPORTED_REFUSAL is read by stages.sh
exit() {
  local status="${1:-$?}"
  if [ "$status" = 1 ] && [ "${BASH_SUBSHELL:-0}" -eq 0 ]; then
    local stage="${DVARA_CURRENT_STAGE:-unknown}"
    DVARA_KEEP_GOING_FAILED="${DVARA_KEEP_GOING_FAILED}${stage}"$'\n'
    DVARA_UNREPORTED_REFUSAL=1
    echo "✗ ${DVARA_KEEP_GOING_NAME:-preflight}: ${stage} failed; carrying on to the next check"
    return 0
  fi
  builtin exit "$status"
}

# A check not run because an earlier result makes its verdict meaningless.
dvara_keep_going_held() {
  DVARA_KEEP_GOING_HELD="${DVARA_KEEP_GOING_HELD}$1: not run: $2"$'\n'
  echo "→ $1: not run: $2"
}

# A check this run was asked not to run: not a failure, and not a pass.
dvara_keep_going_skipped() {
  DVARA_KEEP_GOING_SKIPPED="${DVARA_KEEP_GOING_SKIPPED}$1: skipped: $2"$'\n'
  echo "⏭  $1: skipped: $2"
}

# The end of the run: every check skipped, held and failed, and the verdict.
# Fails when any check failed or was held; passes, saying so, when the only
# gaps are skips.
dvara_keep_going_report() {
  local line failed=0
  echo ""
  echo "━━━ ${DVARA_KEEP_GOING_TITLE:-Preflight} summary ━━━"
  while IFS= read -r line; do
    if [ -n "$line" ]; then echo "  ⏭  ${line}"; fi
  done <<< "$DVARA_KEEP_GOING_SKIPPED"
  while IFS= read -r line; do
    if [ -n "$line" ]; then echo "  ⏸  ${line}"; fi
  done <<< "$DVARA_KEEP_GOING_HELD"
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      echo "  ❌ ${line}"
      failed=$((failed + 1))
    fi
  done <<< "$DVARA_KEEP_GOING_FAILED"
  if [ "$failed" -gt 0 ]; then
    echo "  ${failed} check(s) failed. Fix them all, commit, and run the preflight again."
    echo "  Nothing was pushed."
    builtin exit 1
  fi
  if [ -n "$DVARA_KEEP_GOING_HELD" ]; then
    echo "  No check failed, but the checks above did not run. Nothing was pushed."
    builtin exit 1
  fi
  if [ -n "$DVARA_KEEP_GOING_SKIPPED" ]; then
    echo "  ✅ Every check that ran passed; the push runs the skipped ones. Nothing was pushed."
    builtin exit 0
  fi
  echo "  ✅ Every check passed. Nothing was pushed and no pull request was opened."
  builtin exit 0
}
