#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
image="coforge-realtime-gateway:test-$$"
project="coforge-gateway-test-$$"
compose_file="$repo_root/deploy/ecs/compose.yaml"

cleanup() {
  COFORGE_GATEWAY_IMAGE="$image" \
    COFORGE_EDGE_BIND_IP=127.0.0.1 \
    COFORGE_GATEWAY_PORT=0 \
    docker compose --project-name "$project" --file "$compose_file" \
      down --volumes >/dev/null 2>&1 || true
  docker image rm --force "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

COFORGE_GATEWAY_IMAGE="ghcr.io/lrm-teams/coforge-realtime-gateway@sha256:$(printf '1%.0s' {1..64})" \
  COFORGE_EDGE_BIND_IP=127.0.0.1 \
  docker compose --project-name "$project" --file "$compose_file" config --quiet

docker build \
  --network host \
  --build-arg HTTP_PROXY \
  --build-arg HTTPS_PROXY \
  --build-arg NO_PROXY \
  --file "$repo_root/apps/realtime-gateway/Dockerfile" \
  --tag "$image" \
  "$repo_root/apps/realtime-gateway"

configured_user=$(docker image inspect --format '{{.Config.User}}' "$image")
case "$configured_user" in
  ''|0|root)
    printf 'gateway image must configure a non-root user\n' >&2
    exit 1
    ;;
esac

COFORGE_GATEWAY_IMAGE="$image" \
  COFORGE_EDGE_BIND_IP=127.0.0.1 \
  COFORGE_GATEWAY_PORT=0 \
  docker compose --project-name "$project" --file "$compose_file" \
    up --detach --wait --wait-timeout 60 gateway >/dev/null

host_port=$(COFORGE_GATEWAY_IMAGE="$image" \
  COFORGE_EDGE_BIND_IP=127.0.0.1 \
  COFORGE_GATEWAY_PORT=0 \
  docker compose --project-name "$project" --file "$compose_file" \
    port gateway 8080 | awk -F: 'NR == 1 {print $NF}')

curl --fail --silent --show-error "http://127.0.0.1:$host_port/healthz" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:$host_port/readyz" >/dev/null

printf 'gateway container tests passed\n'
