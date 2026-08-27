# shellcheck shell=sh
# Shared helpers for scripts/dev-frontend.sh and scripts/dev-backend.sh.
# Sourced, not executed.

validate_local_web_port() {
  name=$1
  port=$2
  case "$port" in
    3000)
      echo "$name: local Web scripts must not use port 3000" >&2
      exit 2
      ;;
    '' | *[!0-9]*)
      echo "$name: invalid PORT: $port" >&2
      exit 2
      ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "$name: invalid PORT: $port" >&2
    exit 2
  fi
}

prepare_local_web_runtime() {
  name=$1
  bun_path=
  if command -v bun >/dev/null 2>&1; then
    bun_path=$(command -v bun)
  elif command -v mise >/dev/null 2>&1; then
    bun_path=$(mise which bun 2>/dev/null || true)
  fi
  if [ -z "$bun_path" ] || [ ! -x "$bun_path" ]; then
    for candidate in "$HOME/.local/share/mise/installs/bun/"*/bin/bun; do
      if [ -x "$candidate" ]; then
        bun_path=$candidate
        break
      fi
    done
  fi
  if [ -z "$bun_path" ] || [ ! -x "$bun_path" ]; then
    echo "$name: bun is not on PATH; run mise install first" >&2
    exit 1
  fi
  bun_dir=$(CDPATH='' cd -- "$(dirname -- "$bun_path")" && pwd)
  PATH="$bun_dir:$PATH"
  export PATH
}

listener_pids() {
  port=$1
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser "${port}/tcp" 2>/dev/null || true
  else
    ss -ltnp "sport = :$port" 2>/dev/null | tr ',' '\n' | sed -n 's/^.*pid=\([0-9][0-9]*\).*$/\1/p'
  fi
}

normalize_pids() {
  tr -cs '0-9' '\n' | grep -E '^[0-9]+$' | grep -v '^1$' | sort -u || true
}

replace_listener_on_port() {
  name=$1
  port=$2
  pids=$(listener_pids "$port" | normalize_pids)
  if [ -z "$pids" ]; then
    return 0
  fi
  echo "$name: stopping existing process on port $port" >&2
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  n=0
  while [ "$n" -lt 25 ]; do
    remaining=$(listener_pids "$port" | normalize_pids)
    if [ -z "$remaining" ]; then
      return 0
    fi
    n=$((n + 1))
    sleep 0.1
  done
  remaining=$(listener_pids "$port" | normalize_pids)
  if [ -n "$remaining" ]; then
    # shellcheck disable=SC2086
    kill -9 $remaining 2>/dev/null || true
  fi
}
