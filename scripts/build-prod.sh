#!/usr/bin/env bash
# Build the Web/backend TanStack Start (Nitro) app for local production serving.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'EOF'
Usage: scripts/build-prod.sh [options]

Build @coforge/web (protocol generate + vite/nitro production build) so
scripts/start-web.sh and scripts/start-server.sh can run without compiling.

Options:
  -h, --help  Show this help

Examples:
  scripts/build-prod.sh
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

# Prefer mise-pinned bun; fall back to PATH.
# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/lib/local-web.sh"
prepare_local_web_runtime "build-prod.sh"

if [ ! -d "$REPO_ROOT/node_modules" ] && [ ! -d "$REPO_ROOT/apps/web/node_modules" ]; then
  echo "==> Installing dependencies..."
  if command -v mise >/dev/null 2>&1; then
    mise run setup
  else
    bun install
  fi
fi

echo "==> Building web app (@coforge/web)"
if command -v mise >/dev/null 2>&1; then
  mise run build:web
else
  bun run --cwd packages/protocol generate
  bun run --cwd apps/web build
fi

echo ""
echo "✓ Production build complete"
echo "  Frontend: ./scripts/start-web.sh   (or ./scripts/dev-frontend.sh)"
echo "  Backend:  ./scripts/start-server.sh (or ./scripts/dev-backend.sh)"
echo "  HMR only: ./scripts/dev-web-hmr.sh"
