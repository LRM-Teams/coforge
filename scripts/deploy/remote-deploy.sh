#!/usr/bin/env bash
# Deploy one immutable image digest to the coforge-staging Compose project.
#
# This script runs on the target host only. It consumes the release contract
# in docs/release.md: one immutable digest per deployment, the previous
# healthy digest recorded before mutation, automatic rollback on health
# failure, and a key=value report on stdout that never contains secret
# values. The rollback unit is the last healthy release, not only the image:
# the exact image digest plus the shipped Compose file, Caddyfile, and
# Centrifugo configuration, snapshotted together once a deployment is verified
# healthy and restored together when a later candidate fails. Runtime Authing and session values stay
# out of the deploy .env file and container environment.
#
# Usage:
#   remote-deploy.sh --image REGISTRY/REPOSITORY@sha256:... \
#     --causal-memory-image REGISTRY/REPOSITORY@sha256:... \
#     --compose-file ~/coforge-staging/infra/staging/docker-compose.yml \
#     --secrets-dir ~/coforge-staging/infra/staging/secrets \
#     --state-file ~/coforge-staging/state.env \
#     --web-health-url http://127.0.0.1:18080/health \
#     --public-health-url https://staging.coforge.cn/health \
#     [--project coforge-staging] [--timeout 120]
set -euo pipefail

usage() {
	printf 'usage: %s --image IMAGE --causal-memory-image IMAGE --compose-file FILE --secrets-dir DIR --state-file FILE --web-health-url URL --public-health-url URL [--project NAME] [--timeout SECONDS]\n' "$0" >&2
	exit 2
}

project=coforge-staging
timeout=120
image=
causal_memory_image=
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
	--causal-memory-image)
		causal_memory_image="${2:?}"
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
[ -n "$causal_memory_image" ] || usage
[ -n "$compose_file" ] || usage
[ -n "$secrets_dir" ] || usage
[ -n "$state_file" ] || usage
[ -n "$web_health_url" ] || usage
[ -n "$public_health_url" ] || usage

readonly COMPOSE_ARGS=(-p "$project" -f "$compose_file")

# The last healthy release: the shipped Compose file, Caddyfile, and Centrifugo
# configuration that were live the last time this script recorded a healthy
# deployment. The deploy workflow overwrites these paths on the host before
# this script ever runs (see "Copy deployment assets" in deploy-staging.yml),
# so by the time a bad configuration is detected the previous good copy is
# already gone from its live path; this snapshot is the only place it survives.
release_snapshot_dir="$(dirname "$state_file")/last-healthy"
release_snapshot_files=(docker-compose.yml caddy/Caddyfile centrifugo/config.yaml)

load_compose_secrets() {
	AUTHING_APP_ID="$(cat "$secrets_dir/authing_app_id")"
	AUTHING_APP_SECRET="$(cat "$secrets_dir/authing_app_secret")"
	COFORGE_SESSION_SECRET="$(cat "$secrets_dir/coforge_session_secret")"
	COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY="$(cat "$secrets_dir/coforge_agent_credential_encryption_key")"
	COFORGE_WEB_PUSH_PUBLIC_KEY="$(cat "$secrets_dir/coforge_web_push_public_key")"
	COFORGE_WEB_PUSH_PRIVATE_KEY="$(cat "$secrets_dir/coforge_web_push_private_key")"
	COFORGE_FILE_DELIVERY_KEY="$(cat "$secrets_dir/coforge_file_delivery_key")"
	# Optional until the staging GitHub App has been configured.
	COFORGE_GITHUB_CLIENT_SECRET=""
	COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY=""
	COFORGE_GITHUB_APP_SLUG=""
	COFORGE_GITHUB_APP_BOT_USER_ID=""
	COFORGE_GITHUB_WEBHOOK_SECRET=""
	for name in COFORGE_GITHUB_CLIENT_SECRET COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY COFORGE_GITHUB_APP_SLUG COFORGE_GITHUB_APP_BOT_USER_ID COFORGE_GITHUB_WEBHOOK_SECRET; do
		if [ -f "$secrets_dir/${name,,}" ]; then
			printf -v "$name" '%s' "$(cat "$secrets_dir/${name,,}")"
		fi
	done
	for name in AUTHING_APP_ID AUTHING_APP_SECRET COFORGE_SESSION_SECRET COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY COFORGE_WEB_PUSH_PUBLIC_KEY COFORGE_WEB_PUSH_PRIVATE_KEY; do
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
		COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY="$COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY" \
		COFORGE_WEB_PUSH_PUBLIC_KEY="$COFORGE_WEB_PUSH_PUBLIC_KEY" \
		COFORGE_WEB_PUSH_PRIVATE_KEY="$COFORGE_WEB_PUSH_PRIVATE_KEY" \
		COFORGE_FILE_DELIVERY_KEY="$COFORGE_FILE_DELIVERY_KEY" \
		COFORGE_GITHUB_CLIENT_SECRET="$COFORGE_GITHUB_CLIENT_SECRET" \
		COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY="$COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY" \
		COFORGE_GITHUB_APP_SLUG="$COFORGE_GITHUB_APP_SLUG" \
		COFORGE_GITHUB_APP_BOT_USER_ID="$COFORGE_GITHUB_APP_BOT_USER_ID" \
		COFORGE_GITHUB_WEBHOOK_SECRET="$COFORGE_GITHUB_WEBHOOK_SECRET" \
		docker compose "${COMPOSE_ARGS[@]}" "$@"
}

# Fail closed on a mutable reference instead of guessing the intended digest.
if ! printf '%s' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$' ||
	! printf '%s' "$causal_memory_image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
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
current_causal_memory_image=""
previous_causal_memory_image=""
if [ -f "$state_file" ]; then
	current_image="$(read_state_value CURRENT_WEB_IMAGE)"
	previous_image="$(read_state_value PREVIOUS_WEB_IMAGE)"
	# These keys were added with Causal Memory. Their absence is accepted only
	# for the first deployment that introduces the runtime; its prior release
	# snapshot has no Causal Memory service to restore.
	current_causal_memory_image="$(read_state_value CURRENT_CAUSAL_MEMORY_IMAGE)"
	previous_causal_memory_image="$(read_state_value PREVIOUS_CAUSAL_MEMORY_IMAGE)"
	for value in "$current_image" "$previous_image" "$current_causal_memory_image" "$previous_causal_memory_image"; do
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
last_healthy_causal_memory="$current_causal_memory_image"

if [ -n "$current_image" ] && [ "$current_image" = "$image" ] &&
	[ -n "$current_causal_memory_image" ] && [ "$current_causal_memory_image" = "$causal_memory_image" ]; then
	printf 'previous_web_image=%s\nhealth_result=healthy\noutcome=healthy\nrollback_target=\n' "$current_image"
	exit 0
fi

write_deploy_env() {
	# Writes .env next to the compose file with chmod 600; never printed.
	local web_image="$1" causal_image="$2" env_file env_file_tmp centrifugo_config_sha256
	env_file="$(cd "$(dirname "$compose_file")" && pwd)/.env"
	centrifugo_config_sha256="$(sha256sum "$(dirname "$compose_file")/centrifugo/config.yaml" | awk '{print $1}')"
	umask 077
	env_file_tmp="$(mktemp "${env_file}.XXXXXX")"
	{
			printf 'COFORGE_WEB_IMAGE=%s\n' "$web_image"
			printf 'COFORGE_CAUSAL_MEMORY_IMAGE=%s\n' "$causal_image"
			printf 'COFORGE_CAUSAL_MEMORY_URL=http://causal-memory:9938\n'
		printf 'DATABASE_URL=postgresql://coforge:%s@postgres:5432/coforge\n' "$(cat "$secrets_dir/postgres_password")"
		printf 'REDIS_URL=redis://:%s@redis:6379\n' "$(cat "$secrets_dir/redis_password")"
		printf 'COFORGE_CENTRIFUGO_API_URL=http://centrifugo:8000/api\n'
		printf 'COFORGE_CENTRIFUGO_API_KEY=%s\n' "$(cat "$secrets_dir/centrifugo_http_api_key")"
		printf 'COFORGE_CENTRIFUGO_PROXY_SECRET=%s\n' "$(cat "$secrets_dir/centrifugo_proxy_secret")"
		printf 'COFORGE_CENTRIFUGO_CONFIG_SHA256=%s\n' "$centrifugo_config_sha256"
		printf 'COFORGE_WORKER_JWT_KEY_ID=%s\n' "$(cat "$secrets_dir/worker_jwt_key_id")"
		printf 'COFORGE_WORKER_JWT_PRIVATE_JWK=%s\n' "$(cat "$secrets_dir/worker_jwt_private_jwk")"
	} >"$env_file_tmp"
	chmod 600 "$env_file_tmp"
	mv "$env_file_tmp" "$env_file"
}

# Records the just-verified-healthy Compose file, Caddyfile, and Centrifugo
# configuration so a later failed candidate can restore this exact release,
# not only its image. Writes to a temporary directory first and swaps it into
# place, so a snapshot in progress never leaves a partial one on disk.
snapshot_release() {
	local source_dir tmp_dir file source dest
	source_dir="$(dirname "$compose_file")"
	tmp_dir="$(mktemp -d "${release_snapshot_dir}.XXXXXX")"
	chmod 700 "$tmp_dir"
	for file in "${release_snapshot_files[@]}"; do
		source="$source_dir/$file"
		[ -f "$source" ] || continue
		dest="$tmp_dir/$file"
		mkdir -p "$(dirname "$dest")"
		cp -pf "$source" "$dest"
	done
	rm -rf "${release_snapshot_dir}.previous"
	if [ -d "$release_snapshot_dir" ]; then
		mv "$release_snapshot_dir" "${release_snapshot_dir}.previous"
	fi
	mv "$tmp_dir" "$release_snapshot_dir"
	rm -rf "${release_snapshot_dir}.previous"
	chmod 700 "$release_snapshot_dir"
}

# Restores the last healthy release's Compose file, Caddyfile, and Centrifugo
# configuration into their live paths ahead of a rollback. Only files that
# were actually snapshotted are restored.
restore_release_snapshot() {
	local source_dir file source dest
	source_dir="$(dirname "$compose_file")"
	for file in "${release_snapshot_files[@]}"; do
		source="$release_snapshot_dir/$file"
		[ -f "$source" ] || continue
		dest="$source_dir/$file"
		mkdir -p "$(dirname "$dest")"
		cp -pf "$source" "$dest"
	done
}

compose_all_healthy() {
	local service container
	for service in web centrifugo redis postgres; do
		container="$(compose ps -q "$service")"
		[ -n "$container" ] || return 1
		[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy ] || return 1
	done
	# The first Causal Memory deploy may roll back to a pre-W1-B Compose
	# snapshot. Require its health only when that restored configuration owns the
	# service; otherwise an otherwise healthy rollback would be misreported.
	if compose config --services | grep -Fxq causal-memory; then
		container="$(compose ps -q causal-memory)"
		[ -n "$container" ] || return 1
		[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy ] || return 1
	fi
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
	local web_container causal_memory_container
	web_container="$(compose ps -q web)"
	causal_memory_container="$(compose ps -q causal-memory)"
	[ -n "$web_container" ] && [ -n "$causal_memory_container" ] || return 1
	# Both containers must run their exact requested digest references, and the
	# local store must resolve those immutable identities.
	[ "$(docker inspect --format '{{.Config.Image}}' "$web_container")" = "$image" ] &&
		[ "$(docker inspect --format '{{.Config.Image}}' "$causal_memory_container")" = "$causal_memory_image" ] &&
		docker image inspect "$image" >/dev/null 2>&1 &&
		docker image inspect "$causal_memory_image" >/dev/null 2>&1
}

# Roll back to the last healthy release; with an empty environment, restore the
# recorded empty bootstrap state by removing the failed candidate. Restoring
# only the image digest cannot recover a configuration regression (the shipped
# Compose file, Caddyfile, or Centrifugo config), so when a snapshot exists
# this restores those files too and recreates every service, not only web:
# Caddy does not depend on web, and a Centrifugo config change only takes
# effect when Centrifugo itself is recreated.
rollback() {
	local target="$1" causal_target="$2"
	if [ -n "$target" ]; then
		if [ -d "$release_snapshot_dir" ]; then
			restore_release_snapshot
			printf 'restored the last healthy release configuration\n' >&2
			write_deploy_env "$target" "$causal_target"
			compose up -d --remove-orphans --wait --wait-timeout "$timeout" >/dev/null
		else
			printf 'no last healthy release snapshot; rolling back the image only\n' >&2
			write_deploy_env "$target" "$causal_target"
			compose up -d --wait --wait-timeout "$timeout" web >/dev/null
		fi
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

# Read only bounded candidate evidence before rollback destroys the container.
# Never print raw logs, inspect JSON, health output, URLs, or error messages:
# any can contain credentials or user data not known to this deployment script.
# Each Docker call has a 5s deadline plus a 1s forced-kill grace period.
# Unavailable diagnostics cannot block rollback.
candidate_diagnostics() {
	local container state logs status
	printf 'candidate diagnostics (allowlisted metadata and startup signatures only)\n' >&2
	container="$(timeout --kill-after=1s 5s docker ps --filter "label=com.docker.compose.project=$project" \
		--filter label=com.docker.compose.service=web --all --format '{{.ID}}' 2>/dev/null | head -n 1)" || true
	if [[ "$container" =~ ^[0-9a-f]{6,64}$ ]]; then
		state="$(timeout --kill-after=1s 5s docker inspect --format '{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null)" || true
		if [[ "$state" =~ ^(created|running|paused|restarting|removing|exited|dead)\ [0-9]+\ [0-9]+\ (none|starting|healthy|unhealthy)$ ]]; then
			printf 'candidate state/exit/restarts/health: %s\n' "$state" >&2
		fi
		logs="$(timeout --kill-after=1s 5s docker logs --tail 80 --since 5m "$container" 2>&1 | head -c 16384)" || true
		if [[ "$logs" == *'createSsrRpc is not a function'* ]]; then
			printf 'startup_signature=createSsrRpc\n' >&2
		elif [[ "$logs" == *'Cannot find module'* || "$logs" == *'ModuleNotFound'* ]]; then
			printf 'startup_signature=missing_module\n' >&2
		elif [[ "$logs" == *'SyntaxError'* || "$logs" == *'ReferenceError'* || "$logs" == *'TypeError'* ]]; then
			printf 'startup_signature=javascript_initialization_error\n' >&2
		else
			printf 'startup_signature=unclassified_or_unavailable\n' >&2
		fi
	fi
	status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$web_health_url" 2>/dev/null)" || true
	if [[ "$status" =~ ^[0-9]{3}$ ]]; then
		printf 'candidate loopback health HTTP status: %s\n' "$status" >&2
	fi
	return 0
}

# One failure path for every failed check: roll back to the last healthy
# digest, or restore the verified empty state when there is none.
fail_deployment() {
	local reason="$1"
	candidate_diagnostics || true
	if rollback "$last_healthy" "$last_healthy_causal_memory"; then
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

write_deploy_env "$image" "$causal_memory_image"

# Validate the rendered base-plus-environment configuration before mutating.
if ! compose config --quiet; then
	report "$current_image" "failed: compose configuration validation failed" "failed" ""
	exit 0
fi

# Validate the shipped Centrifugo configuration with the exact pinned image
# that will run it, before recreating anything. On 2026-09-18 two merged PRs
# each added a top-level `websocket:` key to this file; the duplicate key made
# Centrifugo exit at start, nothing here checked the config first, and
# `compose up -d --wait` recreated the live container straight into that
# failure. Centrifugo's own `checkconfig` subcommand parses the file exactly
# as `centrifugo` itself would at start.
#
# Pull the pinned image first, with its own reason: the one-off container
# below would otherwise pull it implicitly, and a registry failure must not
# be reported as a configuration failure.
if ! compose pull --quiet centrifugo >/dev/null; then
	report "$current_image" "failed: Centrifugo image pull failed" "failed" ""
	exit 0
fi
# shellcheck disable=SC2016 # single-quoted on purpose: the $(...) below must
# expand inside the centrifugo container's shell, not this host shell.
if ! compose run --rm --no-deps --entrypoint sh centrifugo \
	-c 'export CENTRIFUGO_VAR_RPC_PROXY_SECRET="$(cat /run/secrets/centrifugo_proxy_secret)"; exec centrifugo checkconfig -c /centrifugo/config.yaml' \
	</dev/null 1>&2; then
	report "$current_image" "failed: Centrifugo configuration validation failed" "failed" ""
	exit 0
fi

compose pull --quiet web causal-memory >/dev/null

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

snapshot_release

printf '%s\n' \
	"PREVIOUS_WEB_IMAGE=$current_image" \
	"CURRENT_WEB_IMAGE=$image" \
	"PREVIOUS_CAUSAL_MEMORY_IMAGE=$current_causal_memory_image" \
	"CURRENT_CAUSAL_MEMORY_IMAGE=$causal_memory_image" >"$state_file.tmp"
chmod 600 "$state_file.tmp"
mv "$state_file.tmp" "$state_file"

report "$current_image" "healthy" "healthy" "$current_image"
