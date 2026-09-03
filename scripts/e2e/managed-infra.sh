#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
secrets="$root/infra/secrets"
mkdir -p "$secrets"
for name in redis_password centrifugo_http_api_key centrifugo_proxy_secret postgres_password; do
  if [[ ! -s "$secrets/$name" ]]; then
    openssl rand -hex 32 >"$secrets/$name"
    chmod 600 "$secrets/$name"
  fi
done

exec sudo -n docker compose -p coforge-e2e \
  -f "$root/infra/docker-compose.yml" up --remove-orphans
