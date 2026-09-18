#!/usr/bin/env bash
# Validates every committed Centrifugo configuration with the exact image
# that runs it in production, before a bad file ever reaches a deployment.
#
# On 2026-09-18, PRs #407 and #409 each added a top-level `websocket:` key to
# infra/centrifugo/config.yaml and infra/staging/centrifugo/config.yaml.
# Merged together the YAML held a duplicate key, and Centrifugo v6.9.2 exits
# at start with "yaml: unmarshal errors: ... mapping key \"websocket\" already
# defined ...". Nothing checked the file before the staging deploy shipped it,
# so the bad config reached the live host, killed the running Centrifugo
# container, and failed health; automatic rollback could not recover it
# because it only restores the image, not the configuration (see
# docs/adr/0048-rollback-unit-is-the-release.md).
#
# This script parses each config file with Centrifugo's own `checkconfig`
# subcommand, run inside the exact digest-pinned image that infra/staging
# ships, so CI catches a duplicate key (or any other invalid configuration)
# before it can reach a host.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
compose_file="$repo_root/infra/staging/docker-compose.yml"

configs=(
	"$repo_root/infra/centrifugo/config.yaml"
	"$repo_root/infra/staging/centrifugo/config.yaml"
)

if [ ! -f "$compose_file" ]; then
	printf 'check-centrifugo-config: %s not found\n' "$compose_file" >&2
	exit 1
fi

# Pull the centrifugo service's `image:` line out of the staging Compose
# file. Reading it from the file this deploy actually ships, rather than
# hardcoding a version here, keeps this check honest when the pinned digest
# changes.
image="$(awk '
	/^  centrifugo:/ { in_service = 1; next }
	in_service && /^  [^ ]/ { in_service = 0 }
	in_service && /^    image:/ { print $2; exit }
' "$compose_file")"

if [ -z "$image" ]; then
	printf 'check-centrifugo-config: no centrifugo image found under the centrifugo: service in %s\n' \
		"$compose_file" >&2
	exit 1
fi

# Fail closed on a mutable reference: this check is only meaningful against
# the exact binary that will run in production.
if ! printf '%s' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
	printf 'check-centrifugo-config: centrifugo image %s in %s is not pinned to a digest\n' \
		"$image" "$compose_file" >&2
	exit 1
fi

# An image the registry can no longer resolve is a different failure than an
# invalid configuration file, and must not be reported as one: pull it once,
# up front, so a stale pin says so plainly instead of surfacing as every
# config "failing" checkconfig underneath it.
if ! docker image inspect "$image" >/dev/null 2>&1 && ! docker pull --quiet "$image" >/dev/null; then
	printf 'check-centrifugo-config: the pinned Centrifugo image %s could not be pulled; refresh the digest in %s\n' \
		"$image" "$compose_file" >&2
	exit 1
fi

failed=0
for config in "${configs[@]}"; do
	if [ ! -f "$config" ]; then
		printf 'check-centrifugo-config: %s not found\n' "$config" >&2
		failed=1
		continue
	fi
	# CENTRIFUGO_VAR_RPC_PROXY_SECRET only needs a value here: checkconfig
	# parses the file, it never starts serving traffic with it.
	if ! docker run --rm \
		-v "$config:/config.yaml:ro" \
		-e CENTRIFUGO_VAR_RPC_PROXY_SECRET=ci-placeholder \
		"$image" \
		centrifugo checkconfig -c /config.yaml; then
		printf 'check-centrifugo-config: %s failed Centrifugo configuration validation\n' "$config" >&2
		failed=1
	fi
done

if [ "$failed" -ne 0 ]; then
	printf 'check-centrifugo-config: fix the Centrifugo configuration above before it ships to a deployment\n' >&2
	exit 1
fi

printf 'check-centrifugo-config: validated against %s\n' "$image"
