#!/usr/bin/env bash
# Dev wrapper for scripts/local/dev-memory-daemon.ts (see that file's header).
# Sources the same .env the dev web app uses (DATABASE_URL, credential
# encryption key), adds the private CA bundle and the model provider's API
# key, then execs the daemon host.
set -euo pipefail
export PATH="$HOME/.local/share/mise/installs/bun/1.4.2/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root/apps/web"

# shellcheck disable=SC1091
[ -f .env ] && source <(grep -E '^(DATABASE_URL|COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY)=' .env | sed 's/^/export /')
# The dev DB runs on the host via docker port mapping; force the loopback host.
export DATABASE_URL="${DATABASE_URL/localhost/127.0.0.1}"

: "${DATABASE_URL:?DATABASE_URL must be set (apps/web/.env or the environment)}"
: "${COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY:?COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY must be set}"

# Private CA for the model endpoint (lenovo modelfactory), when present.
ca_bundle="$HOME/.pi/lenovo-ca-bundle.pem"
[ -f "$ca_bundle" ] && export NODE_EXTRA_CA_CERTS="$ca_bundle"

provider="${DEV_MEMORY_MODEL_PROVIDER:-lenovo-deepseek-v4-flash}"
if [ -z "${DEV_MEMORY_API_KEY:-}" ] && [ -f "$HOME/.pi/agent/models.json" ]; then
  DEV_MEMORY_API_KEY="$(python3 -c "import json;print(json.load(open('$HOME/.pi/agent/models.json'))['providers']['$provider']['apiKey'])")"
  export DEV_MEMORY_API_KEY
fi
: "${DEV_MEMORY_API_KEY:?DEV_MEMORY_API_KEY must be set (or live in ~/.pi/agent/models.json)}"

exec bun run "$repo_root/apps/web/scripts/dev-memory-daemon.ts"
