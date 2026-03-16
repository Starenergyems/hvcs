#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs/headless"
POLL_SECONDS="${HVCS_WATCH_INTERVAL_SECONDS:-1}"

usage() {
  cat <<'EOF'
Usage: scripts/watch-hvcs-progress.sh [progress-file]

Without an argument, the watcher follows the newest *.progress.json file in logs/headless.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

find_latest_progress_file() {
  find "${LOG_DIR}" -maxdepth 1 -name '*.progress.json' -type f | sort | tail -n 1
}

PROGRESS_FILE="${1:-}"

if [[ -z "${PROGRESS_FILE}" ]]; then
  PROGRESS_FILE="$(find_latest_progress_file)"
fi

if [[ -z "${PROGRESS_FILE}" || ! -f "${PROGRESS_FILE}" ]]; then
  printf 'No progress file found in %s\n' "${LOG_DIR}" >&2
  exit 1
fi

printf 'Watching progress: %s\n' "${PROGRESS_FILE}"

last_snapshot=""

while true; do
  if [[ ! -f "${PROGRESS_FILE}" ]]; then
    printf 'Progress file disappeared: %s\n' "${PROGRESS_FILE}" >&2
    exit 1
  fi

  snapshot="$(node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const row = [
      data.updated_at || "",
      data.script || "",
      data.stage || "",
      data.message || "",
      data.current_date || "",
      data.artifact_path || "",
      data.basic_all_artifact_path || "",
      data.power_month_artifact_path || "",
      data.page_url || "",
      data.reason || ""
    ].join("\t");
    process.stdout.write(row);
  ' "${PROGRESS_FILE}")"

  if [[ "${snapshot}" != "${last_snapshot}" ]]; then
    IFS=$'\t' read -r updated_at script stage message current_date artifact_path basic_all_artifact_path power_month_artifact_path page_url reason <<<"${snapshot}"
    printf '[%s] %s | %s | %s\n' "${updated_at}" "${script}" "${stage}" "${message}"
    if [[ -n "${current_date}" ]]; then
      printf '  current_date: %s\n' "${current_date}"
    fi
    if [[ -n "${artifact_path}" ]]; then
      printf '  artifact_path: %s\n' "${artifact_path}"
    fi
    if [[ -n "${basic_all_artifact_path}" ]]; then
      printf '  basic_all_artifact_path: %s\n' "${basic_all_artifact_path}"
    fi
    if [[ -n "${power_month_artifact_path}" ]]; then
      printf '  power_month_artifact_path: %s\n' "${power_month_artifact_path}"
    fi
    if [[ -n "${page_url}" ]]; then
      printf '  page_url: %s\n' "${page_url}"
    fi
    if [[ -n "${reason}" ]]; then
      printf '  reason: %s\n' "${reason}"
    fi
    last_snapshot="${snapshot}"
  fi

  if [[ "${stage}" == "completed" || "${stage}" == "failed" ]]; then
    exit 0
  fi

  sleep "${POLL_SECONDS}"
done
