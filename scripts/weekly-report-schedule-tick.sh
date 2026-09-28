#!/usr/bin/env bash
# One-shot or looping tick for weekly-report scheduled send (ADR 0011).
# Calls the same HTTP entry as an external production cron.
#
# Usage:
#   scripts/weekly-report-schedule-tick.sh           # one POST
#   scripts/weekly-report-schedule-tick.sh --loop    # every 60s until interrupted
#
# Environment:
#   COFORGE_WEEKLY_REPORT_CRON_SECRET  required (also read from apps/web/.env)
#   COFORGE_WEEKLY_REPORT_SCHEDULE_URL optional (default http://127.0.0.1:8788/api/internal/weekly-report-schedule)
#   COFORGE_WEEKLY_REPORT_SCHEDULE_TICK_MS optional loop interval (default 60000)
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
name=weekly-report-schedule-tick.sh
loop=0

usage() {
  cat <<'EOF'
Usage: scripts/weekly-report-schedule-tick.sh [--loop]

POST /api/internal/weekly-report-schedule with the configured cron secret.

  --loop   repeat every COFORGE_WEEKLY_REPORT_SCHEDULE_TICK_MS (default 60000)
  -h       show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --loop)
      loop=1
      ;;
    *)
      echo "$name: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

load_env_var() {
  local key=$1
  local file=$2
  if [ -n "${!key:-}" ]; then
    return 0
  fi
  if [ -f "$file" ]; then
    local line
    line=$(grep -E "^${key}=" "$file" | tail -n 1 || true)
    if [ -n "$line" ]; then
      export "${key}=${line#*=}"
    fi
  fi
}

load_env_var COFORGE_WEEKLY_REPORT_CRON_SECRET "$root/apps/web/.env"
load_env_var COFORGE_WEEKLY_REPORT_SCHEDULE_URL "$root/apps/web/.env"
load_env_var COFORGE_WEEKLY_REPORT_SCHEDULE_TICK_MS "$root/apps/web/.env"

secret=${COFORGE_WEEKLY_REPORT_CRON_SECRET:-}
url=${COFORGE_WEEKLY_REPORT_SCHEDULE_URL:-http://127.0.0.1:8788/api/internal/weekly-report-schedule}
interval_ms=${COFORGE_WEEKLY_REPORT_SCHEDULE_TICK_MS:-60000}

if [ -z "$secret" ]; then
  echo "$name: set COFORGE_WEEKLY_REPORT_CRON_SECRET (env or apps/web/.env)" >&2
  exit 2
fi

if ! [[ "$interval_ms" =~ ^[1-9][0-9]*$ ]]; then
  echo "$name: COFORGE_WEEKLY_REPORT_SCHEDULE_TICK_MS must be a positive integer" >&2
  exit 2
fi

post_once() {
  curl --silent --show-error --fail \
    -X POST "$url" \
    -H "x-coforge-weekly-report-cron-secret: $secret" \
    -H "content-type: application/json"
  echo
}

if [ "$loop" -eq 0 ]; then
  post_once
  exit 0
fi

echo "$name: looping every ${interval_ms}ms against $url"
while true; do
  post_once || echo "$name: tick failed (will retry)" >&2
  # bash sleep wants seconds; keep integer ms→s with a floor of 1s.
  sleep_seconds=$((interval_ms / 1000))
  if [ "$sleep_seconds" -lt 1 ]; then
    sleep_seconds=1
  fi
  sleep "$sleep_seconds"
done
