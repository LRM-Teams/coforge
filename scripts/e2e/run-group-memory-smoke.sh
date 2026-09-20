#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)

# Real-LLM LearnedSkill loop smoke (ADR 0052 slice 6): ingest → distill →
# propose → recall → offer against a live OpenAI-compatible endpoint. Skips cleanly (exit 0) when
# MEMORY_SMOKE_API_KEY is absent; point the other MEMORY_SMOKE_* env at the
# model to dial and a scratch database.
if [ -z "${MEMORY_SMOKE_API_KEY:-}" ]; then
  printf 'MEMORY_SMOKE_API_KEY not set; skipping the LearnedSkill real-LLM smoke\n' >&2
  exit 0
fi
: "${MEMORY_SMOKE_DATABASE_URL:?MEMORY_SMOKE_DATABASE_URL is required with MEMORY_SMOKE_API_KEY}"
export MEMORY_SMOKE_DATABASE_URL
export MEMORY_SMOKE_BASE_URL="${MEMORY_SMOKE_BASE_URL:-https://open.bigmodel.cn/api/paas/v4}"
export MEMORY_SMOKE_MODEL="${MEMORY_SMOKE_MODEL:-glm-4.7}"
export MEMORY_SMOKE_PROVIDER_ID="${MEMORY_SMOKE_PROVIDER_ID:-zhipu}"
export COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY="${COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY:-5b2f1c9d4e7a8630b1d5f8c2e9a47063d8b6f1c3a5e72904b6d8f1a3c5e79062}"

cd "$root"
mise exec -- bun test "$root/apps/web/test/e2e-group-memory-llm-smoke.e2e.ts"
