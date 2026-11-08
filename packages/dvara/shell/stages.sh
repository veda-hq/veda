# shellcheck shell=bash
# dvara's hook helpers, sourced by a hook that runs under `dvara run`.
# Builtins only: one-second resolution, no subprocesses, and a failed write
# never fails the hook. Outside the supervisor the files are unset and every
# helper is a no-op, so the hook runs the same either way.

# Mark the start of a stage. DVARA_CURRENT_STAGE is the stage a refusal is
# recorded against in keep-going mode (keep-going.sh).
# shellcheck disable=SC2034 # read by keep-going.sh
dvara_stage() {
  DVARA_CURRENT_STAGE="$1"
  if [ -n "${DVARA_STAGE_FILE:-}" ]; then
    printf '%s\t%s\n' "$SECONDS" "$1" >> "$DVARA_STAGE_FILE" || true
  fi
}

# A fact for the run's history row that only the hook knows: its fields,
# tab-separated, one record per call (records.ts lists the kinds).
dvara_record() {
  if [ -n "${DVARA_RECORD_FILE:-}" ]; then
    local IFS=$'\t'
    printf '%s\n' "$*" >> "$DVARA_RECORD_FILE" || true
  fi
}

# Record the commits a push updates, from the ref lines git passes pre-push
# on stdin ("<local_ref> <local_sha> <remote_ref> <remote_sha>"): each line's
# two commit ids, never its ref names. An empty argument means a manual run.
dvara_record_refs() {
  local _local_ref local_sha _remote_ref remote_sha
  if [ -z "${1:-}" ]; then
    dvara_record refs-source none
    return 0
  fi
  dvara_record refs-source stdin
  while read -r _local_ref local_sha _remote_ref remote_sha; do
    dvara_record ref "$local_sha" "$remote_sha"
  done <<< "$1"
}

# Guards a "✅" line: false once after keep-going mode carried on past a
# refusal, so a failed check is never reported as passed. A run that stops at
# its first failure never carries on, so there it is always true.
dvara_passed() {
  if [ "${DVARA_UNREPORTED_REFUSAL:-0}" = 1 ]; then
    DVARA_UNREPORTED_REFUSAL=0
    return 1
  fi
  return 0
}

dvara_stage startup
