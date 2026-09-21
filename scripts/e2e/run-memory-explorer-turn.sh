#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)

# Memory Agent turn-level smoke (ADR 0053-G): a real model runs the fenced
# memory-explorer profile's own turn (the eight native tools, memory-first
# discipline, stubbed local proxy) against an explicit team-memory question,
# asserting the model reaches memory_start and invents a contract-valid
# operation-key slug. MANUAL GATE by design: run it deliberately, it spends
# real tokens and one reasoning turn can take minutes. Skips cleanly (exit 0)
# without MEMORY_SMOKE_API_KEY.
if [ -z "${MEMORY_SMOKE_API_KEY:-}" ]; then
  printf 'MEMORY_SMOKE_API_KEY not set; skipping the memory explorer turn smoke\n' >&2
  exit 0
fi
export MEMORY_SMOKE_BASE_URL="${MEMORY_SMOKE_BASE_URL:-https://modelfactory.lenovo.com/service-large-600-1777255649450/llm/v1}"
export MEMORY_SMOKE_MODEL="${MEMORY_SMOKE_MODEL:-DeepSeek-V4-Flash-0731}"
export MEMORY_SMOKE_PROVIDER_ID="${MEMORY_SMOKE_PROVIDER_ID:-lenovo-deepseek-v4-flash}"
# The lenovo endpoint serves a private CA; Bun's fetch honors NODE_EXTRA_CA_CERTS.
if [[ "$MEMORY_SMOKE_BASE_URL" == *modelfactory.lenovo.com* ]]; then
  export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/home/zhoujie22/.pi/lenovo-ca-bundle.pem}"
fi
# The reasoning model's tool loop is minutes, not seconds; one verified run
# took 18.5 minutes over five reasoning turns. bun's per-test default (5s)
# would kill a healthy turn; 30 minutes leaves honest headroom.
exec bun test --timeout 1800000 "$root/packages/agent/test/e2e-memory-explorer-turn.e2e.ts"