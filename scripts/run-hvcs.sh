#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DISPLAY_MANAGER="${ROOT_DIR}/scripts/manage-remote-display.sh"
LOG_DIR="${ROOT_DIR}/logs/headless"
PROGRESS_DIR="${ROOT_DIR}/logs/headless"
DISPLAY_NUM="${HVCS_HEADLESS_DISPLAY_NUM:-99}"
DISPLAY_VALUE=":${DISPLAY_NUM}"
RUN_TS="$(date -u +'%Y%m%dT%H%M%SZ')"
RUN_MODE="${HVCS_RUN_MODE:-headless}"

mkdir -p "${LOG_DIR}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode=headless|--mode=headed)
      RUN_MODE="${1#--mode=}"
      shift
      ;;
    --mode)
      RUN_MODE="${2:-}"
      shift 2
      ;;
    *)
      break
      ;;
  esac
done

case "${RUN_MODE}" in
  headless|headed)
    ;;
  *)
    printf 'Invalid mode: %s\n' "${RUN_MODE}" >&2
    exit 1
    ;;
esac

case "${1:-}" in
  basic:all|open:all-month|open:power-analyze|open:power-analyze-month|login|extract:dashboard|open:cycle|open:basic|open:energy_usage|open:price)
    NPM_SCRIPT="$1"
    shift
    ;;
  *)
    cat <<'EOF'
Usage: scripts/run-hvcs.sh [--mode headless|headed] <npm-script>

Supported npm scripts:
  login
  extract:dashboard
  basic:all
  open:all-month
  open:cycle
  open:basic
  open:energy_usage
  open:price
  open:power-analyze
  open:power-analyze-month
EOF
    exit 1
    ;;
esac

LOG_FILE="${LOG_DIR}/${RUN_TS}-${NPM_SCRIPT//:/_}.log"
PROGRESS_FILE="${PROGRESS_DIR}/${RUN_TS}-${NPM_SCRIPT//:/_}.progress.json"
touch "${LOG_FILE}"

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "${LOG_FILE}"
}

write_progress() {
  local stage="$1"
  local message="$2"
  cat >"${PROGRESS_FILE}" <<EOF
{
  "updated_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "script": "${NPM_SCRIPT}",
  "mode": "${RUN_MODE}",
  "stage": "${stage}",
  "message": "${message//\"/\\\"}",
  "log_path": "${LOG_FILE}",
  "progress_path": "${PROGRESS_FILE}"
}
EOF
}

cleanup() {
  local exit_code=$?
  if [[ ${exit_code} -eq 0 ]]; then
    log "run completed: ${NPM_SCRIPT}"
    write_progress "completed" "Run completed successfully."
  else
    log "unexpected outcome: ${NPM_SCRIPT} exited with code ${exit_code}"
    write_progress "failed" "Run failed with exit code ${exit_code}."
  fi

  if ! "${DISPLAY_MANAGER}" stop-all >>"${LOG_FILE}" 2>&1; then
    log "unexpected behavior: failed to tear down headless display stack"
  fi

  log "headless logs: ${LOG_FILE}"
  exit "${exit_code}"
}

trap cleanup EXIT

log "starting run for ${NPM_SCRIPT}"
write_progress "starting" "Initializing run wrapper."
log "run mode: ${RUN_MODE}"
log "npm script: ${NPM_SCRIPT}"

if [[ "${RUN_MODE}" == "headless" ]]; then
  "${DISPLAY_MANAGER}" cleanup-stale >>"${LOG_FILE}" 2>&1
  "${DISPLAY_MANAGER}" start-xvfb >>"${LOG_FILE}" 2>&1
  export DISPLAY="${DISPLAY_VALUE}"
  export HVCS_AUTH_REQUIRED_HOOK="${DISPLAY_MANAGER} auth-required >>'${LOG_FILE}' 2>&1"
  export HVCS_AUTH_RESOLVED_HOOK="${DISPLAY_MANAGER} auth-resolved >>'${LOG_FILE}' 2>&1"
  export HVCS_PROGRESS_PATH="${PROGRESS_FILE}"
  log "xvfb display ready on ${DISPLAY}"
  log "remote view will start only if auth is invalid"
  write_progress "xvfb_ready" "Virtual display is ready."
else
  unset HVCS_AUTH_REQUIRED_HOOK || true
  unset HVCS_AUTH_RESOLVED_HOOK || true
  export HVCS_PROGRESS_PATH="${PROGRESS_FILE}"
  log "headed mode uses the current desktop session"
  write_progress "headed_ready" "Running on an existing desktop session."
fi

(
  cd "${ROOT_DIR}"
  npm run "${NPM_SCRIPT}" -- "$@"
) 2>&1 | tee -a "${LOG_FILE}"
