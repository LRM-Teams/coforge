#!/bin/sh
set -eu

cleanup() {
  docker compose --profile test down --volumes
}
trap cleanup EXIT

docker compose config --quiet
docker compose up -d --build --wait

expected_services='backend-a
backend-b
centrifugo-a
centrifugo-b
edge
redis'
running_services="$(docker compose ps --status running --services | sort)"

if [ "$running_services" != "$expected_services" ]; then
  printf 'unexpected running services:\n%s\n' "$running_services" >&2
  exit 1
fi

docker compose --profile test run --rm --build client
