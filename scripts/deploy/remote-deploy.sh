#!/usr/bin/env bash
# Deploy one immutable image digest to the coforge-staging Compose project.
#
# This script runs on the target host only. It consumes the release contract
# in docs/release.md: one immutable digest per deployment, the previous healthy
# digest recorded before mutation, automatic rollback on health failure, and a
# key=value report on stdout that never contains secret values. Runtime Authing
# and session values stay out of the deploy .env file and container environment.
#
# Usage:
#   remote-deploy.sh --image REGISTRY/REPOSITORY@sha256:... \
#     --compose-file ~/coforge-staging/infra/staging/docker-compose.yml \
#     --secrets-dir ~/coforge-staging/infra/staging/secrets \
#     --state-file ~/coforge-staging/state.env \
#     --web-health-url http://127.0.0.1:18080/health \
#     --public-health-url https://staging.coforge.cn/health \
#     [--project coforge-staging] [--timeout 120]
set -euo pipefail

usage() {
	printf 'usage: %s --image IMAGE --compose-file FILE --secrets-dir DIR --state-file FILE --web-health-url URL --public-health-url URL [--project NAME] [--timeout SECONDS]\n' "$0" >&2
	exit 2
}

project=coforge-staging
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

load_compose_secrets() {
	AUTHING_APP_ID="$(cat "$secrets_dir/authing_app_id")"
	AUTHING_APP_SECRET="$(cat "$secrets_dir/authing_app_secret")"
	COFORGE_SESSION_SECRET="$(cat "$secrets_dir/coforge_session_secret")"
	COFORGE_AGENT_RUNTIME_CREDENTIAL_KEY="$(cat "$secrets_dir/coforge_agent_runtime_credential_key")"
	for name in AUTHING_APP_ID AUTHING_APP_SECRET COFORGE_SESSION_SECRET COFORGE_AGENT_RUNTIME_CREDENTIAL_KEY; do
		[ -n "${!name}" ] || {
			printf '%s secret file is empty\n' "$name" >&2
			exit 1
		}
	done
}

compose() {
	AUTHING_APP_ID="$AUTHING_APP_ID" \
		AUTHING_APP_SECRET="$AUTHING_APP_SECRET" \
		COFORGE_SESSION_SECRET="$COFORGE_SESSION_SECRET" \
		COFORGE_AGENT_RUNTIME_CREDENTIAL_KEY="$COFORGE_AGENT_RUNTIME_CREDENTIAL_KEY" \
		docker compose "${COMPOSE_ARGS[@]}" "$@"
}

# Fail closed on a mutable reference instead of guessing the intended digest.
if ! printf '%s' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
	printf 'outcome=failed\nhealth_result=mutable image reference rejected\nrollback_target=\nprevious_web_image=\n'
	exit 0
fi

load_compose_secrets

read_state_value() {
	grep -E "^$1=" "$state_file" 2>/dev/null | head -n 1 | cut -d= -f2- || true
}

# Reads and validates the release state. A missing state file is only a
# bootstrap when the environment is verifiably empty; otherwise fail closed.
current_image=""
previous_image=""
if [ -f "$state_file" ]; then
	current_image="$(read_state_value CURRENT_WEB_IMAGE)"
	previous_image="$(read_state_value PREVIOUS_WEB_IMAGE)"
	for value in "$current_image" "$previous_image"; do
		if [ -n "$value" ] && ! printf '%s' "$value" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
			printf 'outcome=failed\nhealth_result=failed: release state file holds a non-digest image; refusing to mutate\nrollback_target=\nprevious_web_image=\n'
			exit 0
		fi
	done
else
	if [ -n "$(compose ps -q web 2>/dev/null)" ]; then
		printf 'outcome=failed\nhealth_result=failed: state file missing on a non-empty environment; refusing to guess bootstrap\nrollback_target=\nprevious_web_image=\n'
		exit 0
	fi
fi

# Fail closed on a malformed state file (truncated write, manual edit).
if [ -f "$state_file" ]; then
	for key in CURRENT_WEB_IMAGE PREVIOUS_WEB_IMAGE; do
		if ! grep -qE "^$key=" "$state_file"; then
			printf 'outcome=failed\nhealth_result=failed: release state is malformed; refusing to mutate\nrollback_target=\nprevious_web_image=\n'
			exit 0
		fi
	done
fi

# The rollback target is the last known healthy image, not the one before it.
last_healthy="$current_image"

if [ -n "$current_image" ] && [ "$current_image" = "$image" ]; then
	printf 'previous_web_image=%s\nhealth_result=healthy\noutcome=healthy\nrollback_target=\n' "$current_image"
	exit 0
fi

write_deploy_env() {
	# Writes .env next to the compose file with chmod 600; never printed.
	local web_image="$1" env_file env_file_tmp
	env_file="$(cd "$(dirname "$compose_file")" && pwd)/.env"
	umask 077
	env_file_tmp="$(mktemp "${env_file}.XXXXXX")"
	{
			printf 'COFORGE_WEB_IMAGE=%s\n' "$web_image"
		printf 'DATABASE_URL=postgresql://coforge:%s@postgres:5432/coforge\n' "$(cat "$secrets_dir/postgres_password")"
		printf 'REDIS_URL=redis://:%s@redis:6379\n' "$(cat "$secrets_dir/redis_password")"
		printf 'COFORGE_CENTRIFUGO_API_URL=http://centrifugo:8000/api\n'
		printf 'COFORGE_CENTRIFUGO_API_KEY=%s\n' "$(cat "$secrets_dir/centrifugo_http_api_key")"
		printf 'COFORGE_CENTRIFUGO_PROXY_SECRET=%s\n' "$(cat "$secrets_dir/centrifugo_proxy_secret")"
		printf 'COFORGE_WORKER_JWT_KEY_ID=%s\n' "$(cat "$secrets_dir/worker_jwt_key_id")"
		printf 'COFORGE_WORKER_JWT_PRIVATE_JWK=%s\n' "$(cat "$secrets_dir/worker_jwt_private_jwk")"
	} >"$env_file_tmp"
	chmod 600 "$env_file_tmp"
	mv "$env_file_tmp" "$env_file"
}

compose_all_healthy() {
	local service container
	for service in web centrifugo redis postgres; do
		container="$(compose ps -q "$service")"
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
	container="$(compose ps -q web)"
	[ -n "$container" ] || return 1
	# The container must run the exact requested digest reference, and the
	# local store must resolve that same immutable identity.
	[ "$(docker inspect --format '{{.Config.Image}}' "$container")" = "$image" ] &&
		docker image inspect "$image" >/dev/null 2>&1
}

# Roll back to the last healthy digest; with an empty environment, restore the
# recorded empty bootstrap state by removing the failed candidate.
rollback() {
	local target="$1"
	if [ -n "$target" ]; then
		write_deploy_env "$target"
		compose up -d --wait --wait-timeout "$timeout" web >/dev/null
		if wait_for_health; then
			printf 'rolled back to the previous healthy digest\n' >&2
			return 0
		fi
		return 1
	fi
	# Verified empty environment: remove the failed candidate completely.
	compose down --remove-orphans >/dev/null 2>&1 || true
	printf 'removed the failed bootstrap candidate; empty state restored\n' >&2
	return 1
}

# One failure path for every failed check: roll back to the last healthy
# digest, or restore the verified empty state when there is none.
fail_deployment() {
	local reason="$1"
	if rollback "$last_healthy"; then
		public_health || true
		report "$last_healthy" "$reason" "rolled_back" "$last_healthy"
	elif [ -z "$last_healthy" ]; then
		report "" "$reason; restored the empty bootstrap state" "bootstrap_failed" ""
	else
		report "$last_healthy" "$reason and rollback failed" "failed" ""
	fi
	exit 0
}

report() {
	printf 'previous_web_image=%s\nhealth_result=%s\noutcome=%s\nrollback_target=%s\n' \
		"${1:-}" "$2" "$3" "${4:-}"
}

write_deploy_env "$image"

# Validate the rendered base-plus-environment configuration before mutating.
if ! compose config --quiet; then
	report "$current_image" "failed: compose configuration validation failed" "failed" ""
	exit 0
fi

compose pull --quiet web >/dev/null

if ! compose run --rm --entrypoint sh migrate \
	-c 'cd .migrate && bun node_modules/prisma/build/index.js migrate deploy' </dev/null 1>&2; then
	report "$last_healthy" "failed: migration deploy failed" "failed" ""
	exit 0
fi

if ! compose up -d --wait --wait-timeout "$timeout" >/dev/null; then
	fail_deployment "failed: candidate failed health verification"
fi

if ! verify_running_digest; then
	fail_deployment "failed: running container digest mismatch"
fi

if ! public_health; then
	fail_deployment "failed: public readiness failed"
fi

printf '%s\n' \
	"PREVIOUS_WEB_IMAGE=$current_image" \
	"CURRENT_WEB_IMAGE=$image" >"$state_file.tmp"
chmod 600 "$state_file.tmp"
mv "$state_file.tmp" "$state_file"

report "$current_image" "healthy" "healthy" "$current_image"
