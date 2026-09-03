#!/bin/sh
set -eu

version=latest
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "install.sh: --version requires a value" >&2; exit 2; }
      version=$2
      shift 2
      ;;
    -h|--help)
      echo "Usage: install.sh [--version latest|test|sha256:<release-set-digest>]"
      exit 0
      ;;
    *)
      echo "install.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$version" in
  latest|test) ;;
  sha256:*)
    digest=${version#sha256:}
    [ "${#digest}" -eq 64 ] || { echo "install.sh: exact release-set digest must contain 64 hexadecimal characters" >&2; exit 2; }
    case "$digest" in *[!0-9a-f]*) echo "install.sh: exact release-set digest must be lowercase hexadecimal" >&2; exit 2 ;; esac
    ;;
  *) echo "install.sh: version must be latest, test, or an exact sha256 release-set id" >&2; exit 2 ;;
esac

# Fixture injection is deliberately unavailable unless the caller opts into test mode.
if [ "${COFORGE_INSTALLER_TEST_MODE:-}" = "1" ] && [ -n "${COFORGE_BOOTSTRAP_PATH:-}" ]; then
  exec "$COFORGE_BOOTSTRAP_PATH" install --version "$version"
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=linux-x64; bootstrap_sha256= ;;
  Linux-aarch64|Linux-arm64) target=linux-arm64; bootstrap_sha256= ;;
  Darwin-x86_64) target=darwin-x64; bootstrap_sha256= ;;
  Darwin-arm64) target=darwin-arm64; bootstrap_sha256= ;;
  *) echo "install.sh: unsupported platform" >&2; exit 1 ;;
esac

if [ -z "$bootstrap_sha256" ]; then
  echo "install.sh: signed bootstrap for $target is not published; OSS/CDN provisioning is pending" >&2
  exit 1
fi

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/coforge-installer.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
bootstrap="$temporary_directory/coforge-installer"
curl --fail --location --proto '=https' --tlsv1.2 \
  "https://releases.coforge.cn/bootstrap/v1/$target/coforge-installer" \
  --output "$bootstrap"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256=$(sha256sum "$bootstrap" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256=$(shasum -a 256 "$bootstrap" | awk '{print $1}')
else
  actual_sha256=$(openssl dgst -sha256 "$bootstrap" | awk '{print $NF}')
fi
[ "$actual_sha256" = "$bootstrap_sha256" ] || { echo "install.sh: bootstrap integrity check failed" >&2; exit 1; }
chmod 700 "$bootstrap"
"$bootstrap" install --version "$version"
