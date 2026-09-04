#!/bin/sh
set -eu

default_feed_url="https://releases.coforge.cn"
feed_url=${COFORGE_RELEASE_FEED_URL:-$default_feed_url}
feed_url=${feed_url%/}

version=latest
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "install.sh: --version requires a value" >&2; exit 2; }
      version=$2
      shift 2
      ;;
    -h|--help)
      echo "Usage: install.sh [--version latest|<version>]"
      exit 0
      ;;
    *)
      echo "install.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# A version is a bare label used both as a URL segment and as a local directory name, so it is
# restricted to a safe charset with no traversal segment - the same rule the updater itself
# applies to a "latest" pointer or an explicit --version.
is_valid_version() {
  case "$1" in
    "") return 1 ;;
    *..*) return 1 ;;
    *[!A-Za-z0-9.+-]*) return 1 ;;
  esac
  [ "${#1}" -le 100 ]
}

if [ "$version" != "latest" ] && ! is_valid_version "$version"; then
  echo "install.sh: version must be latest or a valid version string" >&2
  exit 2
fi

# COFORGE_INSTALLER_TEST_MODE relaxes the HTTPS-only transport so tests can point the installer
# at a local fixture server over plain HTTP. A real install always requires HTTPS: integrity no
# longer comes from payload signing, only from TLS plus the manifest's SHA-256 checksums below.
test_mode=${COFORGE_INSTALLER_TEST_MODE:-}
case "$feed_url" in
  https://*) curl_proto='=https' ;;
  http://*)
    [ "$test_mode" = "1" ] || {
      echo "install.sh: COFORGE_RELEASE_FEED_URL must use HTTPS" >&2
      exit 2
    }
    curl_proto='=http,https'
    ;;
  *)
    echo "install.sh: COFORGE_RELEASE_FEED_URL must use HTTPS" >&2
    exit 2
    ;;
esac

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=linux-x64 ;;
  Linux-aarch64|Linux-arm64) target=linux-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  Darwin-arm64) target=darwin-arm64 ;;
  *) echo "install.sh: unsupported platform" >&2; exit 1 ;;
esac

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/coforge-installer.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

fetch() {
  curl --fail --silent --show-error --location --proto "$curl_proto" --tlsv1.2 "$@"
}

if [ "$version" = "latest" ]; then
  latest_pointer=$(fetch "$feed_url/latest" | tr -d '[:space:]')
  is_valid_version "$latest_pointer" || {
    echo "install.sh: the latest pointer did not return a valid version" >&2
    exit 1
  }
  version=$latest_pointer
fi

manifest_path="$temporary_directory/manifest.json"
fetch --output "$manifest_path" "$feed_url/$version/manifest.json"

# The manifest is not signed; only the CDN's TLS and this checksum protect the download. Prefer
# jq when it is available. Otherwise fall back to a bash-free regex extraction: strip whitespace
# so the target's whole "computer" object appears as one contiguous run, capture it up to its
# first (and only, since it has no nested object) closing brace, then read checksum/size out of
# that captured substring - so, unlike a single combined regex, this does not depend on field
# order inside the object. Either way, the "no such target" check runs on the same extracted
# value in both branches, so the two code paths cannot diverge on what error they report.
if command -v jq >/dev/null 2>&1; then
  expected_sha256=$(jq -r --arg target "$target" '.platforms[$target].computer.checksum // empty' "$manifest_path")
  expected_size=$(jq -r --arg target "$target" '.platforms[$target].computer.size // empty' "$manifest_path")
else
  compact_manifest=$(tr -d '\n\r\t ' < "$manifest_path")
  computer_block=$(printf '%s' "$compact_manifest" | sed -n "s/.*\"$target\":{\"computer\":{\([^}]*\)}.*/\1/p")
  expected_sha256=$(printf '%s' "$computer_block" | sed -n 's/.*"checksum":"\([a-f0-9]\{64\}\)".*/\1/p')
  expected_size=$(printf '%s' "$computer_block" | sed -n 's/.*"size":\([0-9]\{1,\}\).*/\1/p')
fi

if [ -z "$expected_sha256" ] && [ -z "$expected_size" ]; then
  echo "install.sh: manifest has no computer entry for $target" >&2
  exit 1
fi
case "$expected_sha256" in
  *[!a-f0-9]*) expected_sha256= ;;
esac
if [ -z "$expected_sha256" ] || [ "${#expected_sha256}" -ne 64 ]; then
  echo "install.sh: manifest checksum for $target is missing or malformed" >&2
  exit 1
fi
case "$expected_size" in
  ""|*[!0-9]*)
    echo "install.sh: manifest size for $target is missing or malformed" >&2
    exit 1
    ;;
esac

computer_path="$temporary_directory/coforge-computer"
fetch --max-filesize "$expected_size" --output "$computer_path" "$feed_url/$version/$target/coforge-computer"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256=$(sha256sum "$computer_path" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256=$(shasum -a 256 "$computer_path" | awk '{print $1}')
else
  actual_sha256=$(openssl dgst -sha256 "$computer_path" | awk '{print $NF}')
fi
[ "$actual_sha256" = "$expected_sha256" ] || {
  echo "install.sh: downloaded binary failed its checksum check" >&2
  exit 1
}

chmod 700 "$computer_path"
exec "$computer_path" install --version "$version"
