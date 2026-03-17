#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime/headless"
LOG_DIR="${ROOT_DIR}/logs/headless"
AUTH_PROFILE_DIR="${ROOT_DIR}/.auth/browser-profile"
DISPLAY_NUM="${HVCS_HEADLESS_DISPLAY_NUM:-99}"
DISPLAY_VALUE=":${DISPLAY_NUM}"
VNC_PORT="${HVCS_VNC_PORT:-5900}"
NOVNC_PORT="${HVCS_NOVNC_PORT:-6080}"
NOVNC_WEB_DIR="${HVCS_NOVNC_WEB_DIR:-/usr/share/novnc}"

mkdir -p "${RUNTIME_DIR}" "${LOG_DIR}"

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

pid_file() {
  printf '%s/%s.pid\n' "${RUNTIME_DIR}" "$1"
}

read_pid() {
  local file
  file="$(pid_file "$1")"
  if [[ -f "${file}" ]]; then
    cat "${file}"
  fi
}

is_running() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

kill_matching_processes() {
  local pattern="$1"
  local label="$2"
  local pids=()
  local pid

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] && pids+=("${pid}")
  done < <(pgrep -f "${pattern}" || true)

  if [[ ${#pids[@]} -eq 0 ]]; then
    return 0
  fi

  kill "${pids[@]}" 2>/dev/null || true
  sleep 1

  local survivors=()
  for pid in "${pids[@]}"; do
    if is_running "${pid}"; then
      survivors+=("${pid}")
    fi
  done

  if [[ ${#survivors[@]} -gt 0 ]]; then
    kill -9 "${survivors[@]}" 2>/dev/null || true
  fi

  log "cleared stale ${label} pid(s): ${pids[*]}"
}

find_display_pid() {
  pgrep -f "^Xvfb ${DISPLAY_VALUE} -screen 0 1440x960x24 -ac$" | head -n 1 || true
}

start_bg() {
  local name="$1"
  shift

  local existing_pid
  existing_pid="$(read_pid "${name}")"
  if is_running "${existing_pid}"; then
    log "${name} already running with pid ${existing_pid}"
    return 0
  fi

  local logfile="${LOG_DIR}/${name}.log"
  nohup "$@" >>"${logfile}" 2>&1 &
  local pid=$!
  printf '%s\n' "${pid}" >"$(pid_file "${name}")"
  log "started ${name} pid=${pid}"
}

stop_bg() {
  local name="$1"
  local pid
  pid="$(read_pid "${name}")"
  if ! is_running "${pid}"; then
    rm -f "$(pid_file "${name}")"
    return 0
  fi

  kill "${pid}" 2>/dev/null || true
  sleep 1
  if is_running "${pid}"; then
    kill -9 "${pid}" 2>/dev/null || true
  fi
  rm -f "$(pid_file "${name}")"
  log "stopped ${name} pid=${pid}"
}

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "missing required binary: $1"
    exit 1
  fi
}

start_xvfb() {
  require_bin Xvfb
  local live_pid
  live_pid="$(find_display_pid)"
  if is_running "${live_pid}"; then
    printf '%s\n' "${live_pid}" >"$(pid_file xvfb)"
    log "reusing existing xvfb pid=${live_pid} on ${DISPLAY_VALUE}"
    wait_for_display
    return 0
  fi
  start_bg xvfb Xvfb "${DISPLAY_VALUE}" -screen 0 1440x960x24 -ac
  wait_for_display
}

wait_for_display() {
  local display_socket="/tmp/.X11-unix/X${DISPLAY_NUM}"
  local attempt
  for attempt in $(seq 1 50); do
    if [[ -S "${display_socket}" ]]; then
      log "xvfb display ready at ${DISPLAY_VALUE}"
      return 0
    fi
    sleep 0.2
  done

  log "unexpected behavior: xvfb display ${DISPLAY_VALUE} did not become ready"
  exit 1
}

start_remote_view() {
  require_bin openbox
  require_bin x11vnc
  require_bin websockify

  if [[ ! -d "${NOVNC_WEB_DIR}" ]]; then
    log "noVNC web root not found at ${NOVNC_WEB_DIR}"
    exit 1
  fi

  start_bg openbox env DISPLAY="${DISPLAY_VALUE}" openbox
  start_bg x11vnc x11vnc -display "${DISPLAY_VALUE}" -forever -shared -rfbport "${VNC_PORT}" -localhost
  start_bg novnc websockify --web="${NOVNC_WEB_DIR}" "${NOVNC_PORT}" "localhost:${VNC_PORT}"
  log "remote view ready on localhost:${NOVNC_PORT}"
  log "connect with: ssh -L ${NOVNC_PORT}:localhost:${NOVNC_PORT} ubuntu@<ec2-host>"
  log "then open: http://localhost:${NOVNC_PORT}/vnc.html"
}

stop_remote_view() {
  stop_bg novnc
  stop_bg x11vnc
  stop_bg openbox
}

stop_all() {
  stop_remote_view
  local live_pid
  live_pid="$(find_display_pid)"
  if is_running "${live_pid}"; then
    kill "${live_pid}" 2>/dev/null || true
    sleep 1
    if is_running "${live_pid}"; then
      kill -9 "${live_pid}" 2>/dev/null || true
    fi
    log "stopped xvfb pid=${live_pid}"
  fi
  stop_bg xvfb
}

cleanup_stale() {
  for name in xvfb openbox x11vnc novnc; do
    if ! is_running "$(read_pid "${name}")"; then
      rm -f "$(pid_file "${name}")"
    fi
  done

  kill_matching_processes "(^|/)node .*scripts/extract-dashboard\\.js([[:space:]]|$)" "extract-dashboard"
  kill_matching_processes "(^|/)node .*scripts/hvcs-login\\.js([[:space:]]|$)" "hvcs-login"
  kill_matching_processes "/chrome-linux64/chrome .*--user-data-dir=/tmp/playwright_chromiumdev_profile-" "playwright chromium"

  stop_remote_view

  local live_pid
  live_pid="$(find_display_pid)"
  if is_running "${live_pid}"; then
    kill "${live_pid}" 2>/dev/null || true
    sleep 1
    if is_running "${live_pid}"; then
      kill -9 "${live_pid}" 2>/dev/null || true
    fi
    log "cleared stale xvfb pid=${live_pid}"
  fi

  rm -f /tmp/.X11-unix/X"${DISPLAY_NUM}" 2>/dev/null || true

  if [[ -d "${AUTH_PROFILE_DIR}" ]]; then
    rm -f "${AUTH_PROFILE_DIR}/SingletonCookie" \
      "${AUTH_PROFILE_DIR}/SingletonLock" \
      "${AUTH_PROFILE_DIR}/SingletonSocket"
    log "cleared stale chromium singleton files"
  fi
}

status() {
  for name in xvfb openbox x11vnc novnc; do
    local pid
    pid="$(read_pid "${name}")"
    if is_running "${pid}"; then
      log "${name}: running pid=${pid}"
    else
      log "${name}: stopped"
    fi
  done
}

case "${1:-}" in
  start-xvfb)
    start_xvfb
    ;;
  start-remote-view)
    start_xvfb
    start_remote_view
    ;;
  auth-required)
    log "auth challenge detected; starting remote view"
    start_remote_view
    ;;
  auth-resolved)
    log "auth resolved; stopping remote view"
    stop_remote_view
    ;;
  cleanup-stale)
    cleanup_stale
    ;;
  stop-remote-view)
    stop_remote_view
    ;;
  stop-all)
    stop_all
    ;;
  status)
    status
    ;;
  *)
    cat <<'EOF'
Usage: scripts/manage-remote-display.sh <command>

Commands:
  start-xvfb
  start-remote-view
  auth-required
  auth-resolved
  cleanup-stale
  stop-remote-view
  stop-all
  status
EOF
    exit 1
    ;;
esac
