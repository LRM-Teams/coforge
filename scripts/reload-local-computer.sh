#!/usr/bin/env bash
# Rebuild the local E2E Computer fixture (Computer + Daemon in one binary),
# install it into ~/.coforge, and restart coforge-daemon.service.
#
# This is the local edit→run loop for Daemon/Computer source changes.
# It does not replace scripts/build-prod.sh (Web only) and does not publish
# release artifacts.
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
name=reload-local-computer.sh
run_setup=0
setup_slug=
restart=1

usage() {
  cat <<'EOF'
Usage: scripts/reload-local-computer.sh [options]

Compile the local Computer/Daemon fixture, install it with __install-local,
and restart the user systemd Daemon service.

Environment:
  COFORGE_E2E_WEB_URL              Local Web/backend URL baked into the fixture.
                                   Must match the running Daemon's server origin
                                   (localhost and 127.0.0.1 are different).
                                   Default: serverHttpUrl from
                                   ~/.coforge/daemon/bindings.json when present,
                                   otherwise http://localhost:8789
  COFORGE_E2E_CENTRIFUGO_ENDPOINT  Daemon WSS endpoint
                                   (default: ws://127.0.0.1:8000/connection/websocket)

Options:
  --setup <workspace-slug>  After install, run Computer setup for the slug
                            (device authorization; only needed once / when
                            rebinding a Workspace)
  --no-restart              Install only; do not restart coforge-daemon
  -h, --help                Show this help

Examples:
  scripts/reload-local-computer.sh
  COFORGE_E2E_WEB_URL=http://127.0.0.1:8789 scripts/reload-local-computer.sh
  scripts/reload-local-computer.sh --setup my
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --no-restart)
      restart=0
      ;;
    --setup)
      if [ $# -lt 2 ]; then
        echo "$name: --setup requires a workspace slug" >&2
        exit 2
      fi
      run_setup=1
      setup_slug=$2
      shift
      ;;
    *)
      echo "$name: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$(uname -s)" != Linux ]; then
  echo "$name: systemd restart is currently supported on Linux only" >&2
  exit 2
fi

run_bun() {
  if command -v mise >/dev/null 2>&1; then
    mise exec -- bun "$@"
  else
    bun "$@"
  fi
}

bindings_file="${HOME}/.coforge/daemon/bindings.json"
default_web_url=http://localhost:8789
if [ -f "$bindings_file" ]; then
  bound_web_url=$(
    run_bun -e '
      const bindings = await Bun.file(Bun.argv[1]).json();
      const url = Array.isArray(bindings)
        ? bindings.find((binding) => binding?.serverHttpUrl)?.serverHttpUrl
        : undefined;
      if (typeof url === "string" && url.length > 0) process.stdout.write(url);
    ' "$bindings_file"
  )
  if [ -n "${bound_web_url:-}" ]; then
    default_web_url=$bound_web_url
  fi
fi

export COFORGE_E2E_WEB_URL="${COFORGE_E2E_WEB_URL:-$default_web_url}"
export COFORGE_E2E_CENTRIFUGO_ENDPOINT="${COFORGE_E2E_CENTRIFUGO_ENDPOINT:-ws://127.0.0.1:8000/connection/websocket}"

if ! curl -fsS --max-time 3 "${COFORGE_E2E_WEB_URL%/}/health" >/dev/null; then
  echo "$name: Web backend is not reachable at $COFORGE_E2E_WEB_URL" >&2
  echo "  Start it with ./scripts/start-server.sh (after ./scripts/build-prod.sh)." >&2
  exit 1
fi

echo "==> Generating protocol"
run_bun run --cwd "$root/packages/protocol" generate

echo "==> Building local Computer/Daemon fixture"
echo "    web=$COFORGE_E2E_WEB_URL"
echo "    centrifugo=$COFORGE_E2E_CENTRIFUGO_ENDPOINT"
run_bun "$root/scripts/e2e/build-computer-fixture.ts"

fixture_bin="$root/.amp/e2e/bin/coforge-computer"
package_dir="$root/.amp/e2e/native-package"
manifest="$package_dir/manifest.json"
if [ ! -x "$fixture_bin" ] || [ ! -f "$manifest" ]; then
  echo "$name: fixture build did not produce $fixture_bin and $manifest" >&2
  exit 1
fi

version=$(run_bun -e 'console.log((await Bun.file(Bun.argv[1]).json()).version)' "$manifest")
echo "==> Installing local package version $version"
if ! "$fixture_bin" __install-local --version "$version" --directory "$package_dir"; then
  echo "$name: local install failed" >&2
  echo "  If you see 'no healthy supervisor', the fixture Web URL likely does not" >&2
  echo "  match the running Daemon origin. Current COFORGE_E2E_WEB_URL=$COFORGE_E2E_WEB_URL" >&2
  if [ -f "$bindings_file" ]; then
    echo "  Bound serverHttpUrl entries are in $bindings_file" >&2
  fi
  exit 1
fi

active_bin="${HOME}/.coforge/computer/install/active/coforge-computer"
if [ ! -x "$active_bin" ]; then
  echo "$name: install did not produce $active_bin" >&2
  exit 1
fi

if [ "$run_setup" -eq 1 ]; then
  echo "==> Running Computer setup for workspace '$setup_slug'"
  "$active_bin" setup --workspace "$setup_slug" --json
fi

if [ "$restart" -eq 1 ]; then
  if ! systemctl --user cat coforge-daemon.service >/dev/null 2>&1; then
    echo "$name: coforge-daemon.service is not installed for this user" >&2
    echo "  Run once with --setup <workspace-slug> after a successful install." >&2
    exit 1
  fi
  echo "==> Restarting coforge-daemon.service"
  systemctl --user restart coforge-daemon.service
  systemctl --user --no-pager --full status coforge-daemon.service
fi

echo ""
echo "✓ Local Computer/Daemon reloaded"
echo "  binary:  $active_bin"
echo "  version: $version"
echo "  logs:    ~/.coforge/daemon/workspaces/*/logs/daemon/daemon.jsonl"
