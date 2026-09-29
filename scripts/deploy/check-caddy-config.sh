#!/usr/bin/env bash
# Validates the staging Caddyfile with the exact image that serves it, so an
# invalid file fails CI instead of reaching the deploy host. remote-deploy.sh
# runs the same `caddy validate` again on the host before recreating Caddy.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
compose_file="$repo_root/infra/staging/docker-compose.yml"
caddyfile="$repo_root/infra/staging/caddy/Caddyfile"

for file in "$compose_file" "$caddyfile"; do
	if [ ! -f "$file" ]; then
		printf 'check-caddy-config: %s not found\n' "$file" >&2
		exit 1
	fi
done

image="$(awk '
	/^  caddy:/ { in_service = 1; next }
	in_service && /^  [^ ]/ { in_service = 0 }
	in_service && /^    image:/ { print $2; exit }
' "$compose_file")"

if [ -z "$image" ]; then
	printf 'check-caddy-config: no caddy image found under the caddy: service in %s\n' \
		"$compose_file" >&2
	exit 1
fi

if ! printf '%s' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
	printf 'check-caddy-config: caddy image %s in %s is not pinned to a digest\n' \
		"$image" "$compose_file" >&2
	exit 1
fi

if ! docker image inspect "$image" >/dev/null 2>&1 && ! docker pull --quiet "$image" >/dev/null; then
	printf 'check-caddy-config: the pinned Caddy image %s could not be pulled; refresh the digest in %s\n' \
		"$image" "$compose_file" >&2
	exit 1
fi

# `caddy validate` loads and provisions every module without starting servers
# or obtaining certificates.
if ! docker run --rm \
	-v "$caddyfile:/etc/caddy/Caddyfile:ro" \
	"$image" \
	caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
	printf 'check-caddy-config: %s failed Caddy configuration validation\n' "$caddyfile" >&2
	exit 1
fi

printf 'check-caddy-config: validated against %s\n' "$image"
