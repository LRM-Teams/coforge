#!/usr/bin/env bash
# Deploy one immutable image digest to the coforge-test Compose project.
#
# This script runs on the target host only. It consumes the release contract
# in docs/release.md: one immutable digest per deployment, the previous healthy
# digest recorded before mutation, automatic rollback on health failure, and a
# key=value report on stdout that never contains secret values. Secrets stay in
# the secrets directory and the deploy .env file, both chmod 600.
#
# Usage:
#   remote-deploy.sh --image REGISTRY/REPOSITORY@sha256:... \
#     --compose-file /opt/coforge/test/docker-compose.yml \
#     --secrets-dir /opt/coforge/test/secrets \
#     --state-file /opt/coforge/test/state.env \
#     --web-health-url http://127.0.0.1:18080/health \
#     --public-health-url https://test.coforge.cn/health \
#     [--project coforge-test] [--timeout 120]
set -euo pipefail

usage() {
	printf 'usage: %s --image IMAGE --compose-file FILE --secrets-dir DIR --state-file FILE --web-health-url URL --public-health-url URL [--project NAME] [--timeout SECONDS]\n' "$0" >&2
	exit 2
}

project=coforge-test
timeout=120
image=
compose_file=
secrets_dir=
state_file=
web_health_url=
public_health_url=

while [ "$#" -gt 0 ]; do
	case "$1" in
	--project)
		project="${2:?}"
		shift 2
		;;
	--timeout)
		timeout="${2:?}"
		shift 2
		;;
	--image)
		image="${2:?}"
		shift 2
		;;
	--compose-file)
		compose_file="${2:?}"
		shift 2
		;;
	--secrets-dir)
		secrets_dir="${2:?}"
		shift 2
		;;
	--state-file)
		state_file="${2:?}"
		shift 2
		;;
	--web-health-url)
		web_health_url="${2:?}"
		shift 2
		;;
	--public-health-url)
		public_health_url="${2:?}"
		shift 2
		;;
	*)
		printf 'unknown flag: %s\n' "$1" >&2
		usage
		;;
	esac
done

[ -n "$image" ] || usage
[ -n "$compose_file" ] || usage
[ -n "$secrets_dir" ] || usage
[ -n "$state_file" ] || usage
[ -n "$web_health_url" ] || usage
[ -n "$public_health_url" ] || usage

readonly COMPOSE_ARGS=(-p "$project" -f "$compose_file")

# Fail closed on a mutable reference instead of guessing the intended digest.
if ! printf '%s' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
	printf 'outcome=failed\nhealth_result=mutable image reference rejected\nrollback_target=\nprevious_web_image=\n'
	exit 0
fi

read_state_value() {
	grep -E "^$1=" "$state_file" 2>/dev/null | head -n 1 | cut -d= -f2- || true
}

current_image="$(read_state_value CURRENT_WEB_IMAGE)"
previous_image="$(read_state_value PREVIOUS_WEB_IMAGE)"

if [ -n "$current_image" ] && [ "$current_image" = "$image" ]; then
	printf 'previous_web_image=%s\nhealth_result=healthy\noutcome=healthy\nrollback_target=\n' "$current_image"
	exit 0
fi

write_deploy_env() {
	# Writes .env next to the compose file with chmod 600; never printed.
	local web_image="$1" env_file
	env_file="$(cd "$(dirname "$compose_file")" && pwd)/.env"
	umask 077
	{
		printf 'COFORGE_WEB_IMAGE=%s\n' "$web_image"
		printf 'DATABASE_URL=postgresql://coforge:%s@postgres:5432/coforge\n' "$(cat "$secrets_dir/postgres_password")"
		printf 'REDIS_URL=redis://:%s@redis:6379\n' "$(cat "$secrets_dir/redis_password")"
		printf 'COFORGE_CENTRIFUGO_API_URL=http://centrifugo:8000/api\n'
		printf 'COFORGE_CENTRIFUGO_API_KEY=%s\n' "$(cat "$secrets_dir/centrifugo_http_api_key")"
		printf 'COFORGE_CENTRIFUGO_PROXY_SECRET=%s\n' "$(cat "$secrets_dir/centrifugo_proxy_secret")"
	} >"$env_file"
}

compose_all_healthy() {
	local service container
	for service in web centrifugo redis postgres; do
		container="$(docker compose "${COMPOSE_ARGS[@]}" ps -q "$service")"
		[ -n "$container" ] || return 1
		[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy ] || return 1
	done
	return 0
}

wait_for_health() {
	local deadline=$((SECONDS + timeout))
	until compose_all_healthy && curl --fail --silent --max-time 5 "$web_health_url" >/dev/null; do
		if [ "$SECONDS" -ge "$deadline" ]; then
			return 1
		fi
		sleep 2
	done
	return 0
}

public_health() {
	curl --fail --silent --show-error --max-time 10 "$public_health_url" >/dev/null
}

verify_running_digest() {
	local container
	container="$(docker compose "${COMPOSE_ARGS[@]}" ps -q web)"
	[ -n "$container" ] || return 1
	[ "$(docker inspect --format '{{.Config.Image}}' "$container")" = "$image" ]
}

rollback() {
	local target="$1"
	if [ -n "$target" ]; then
		write_deploy_env "$target"
		docker compose "${COMPOSE_ARGS[@]}" up -d --wait --wait-timeout "$timeout" web
		if wait_for_health; then
			printf 'rolled back to the previous healthy digest\n' >&2
			return 0
		fi
	fi
	return 1
}

report() {
	printf 'previous_web_image=%s\nhealth_result=%s\noutcome=%s\nrollback_target=%s\n' \
		"${1:-}" "$2" "$3" "${4:-}"
}

write_deploy_env "$image"
docker compose "${COMPOSE_ARGS[@]}" pull --quiet web

if ! docker compose run "${COMPOSE_ARGS[@]}" --rm --entrypoint bun web node_modules/prisma/build/index.js \
	migrate deploy --schema=apps/web/prisma/schema.prisma; then
	report "$current_image" "failed: migration deploy failed" "failed" ""
	exit 0
fi

if ! docker compose "${COMPOSE_ARGS[@]}" up -d --wait --wait-timeout "$timeout"; then
	if rollback "$previous_image"; then
		public_health || true
		report "$previous_image" "failed: candidate failed health verification" "rolled_back" "$previous_image"
	else
		report "$current_image" "failed: candidate failed health verification and rollback failed" "failed" ""
	fi
	exit 0
fi

if ! verify_running_digest; then
	if rollback "$previous_image"; then
		report "$previous_image" "failed: running container digest mismatch" "rolled_back" "$previous_image"
	else
		report "$image" "failed: digest mismatch and rollback failed" "failed"
	fi
	exit 0
fi

if ! public_health; then
	if rollback "$previous_image"; then
		report "$previous_image" "failed: public readiness failed" "rolled_back" "$previous_image"
	else
		report "$current_image" "failed: public readiness failed and rollback failed" "failed" ""
	fi
	exit 0
fi

printf '%s\n' \
	"PREVIOUS_WEB_IMAGE=$current_image" \
	"CURRENT_WEB_IMAGE=$image" >"$state_file.tmp"
chmod 600 "$state_file.tmp"
mv "$state_file.tmp" "$state_file"

report "$previous_image" "healthy" "healthy" "$previous_image"
