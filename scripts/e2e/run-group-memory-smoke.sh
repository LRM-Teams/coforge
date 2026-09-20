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
export MEMORY_SMOKE_BASE_URL="${MEMORY_SMOKE_BASE_URL:-https://modelfactory.lenovo.com/service-large-600-1777255649450/llm/v1}"
export MEMORY_SMOKE_MODEL="${MEMORY_SMOKE_MODEL:-DeepSeek-V4-Flash-0731}"
export MEMORY_SMOKE_PROVIDER_ID="${MEMORY_SMOKE_PROVIDER_ID:-lenovo}"
# The lenovo endpoint serves a private CA; Bun's fetch honors NODE_EXTRA_CA_CERTS.
if [[ "$MEMORY_SMOKE_BASE_URL" == *modelfactory.lenovo.com* ]]; then
  export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/home/zhoujie22/.pi/lenovo-ca-bundle.pem}"
fi
export COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY="${COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY:-5b2f1c9d4e7a8630b1d5f8c2e9a47063d8b6f1c3a5e72904b6d8f1a3c5e79062}"

cd "$root"
mise exec -- bun test "$root/apps/web/test/e2e-group-memory-llm-smoke.e2e.ts"
