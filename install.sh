#!/bin/sh
set -eu

default_feed_url="https://releases.coforge.cn"
# COFORGE_RELEASE_FEED_URL is accepted unconditionally for any https:// host. This script is a
# one-shot the user explicitly runs (`curl ... | sh`), not the long-lived compiled binary that
# ./packages/computer/src/release-channel.ts hardens by inlining the feed URL at build time - an
# attacker able to set this variable in the invoking shell can equally set PATH or https_proxy to
# reach the same result, so there is no additional boundary to enforce here. See docs/release.md.
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
# applies to a "latest" pointer or an explicit --version. "." is rejected on its own (in addition
# to the "*..*" traversal check, which does not catch a lone dot): as a directory name it is
# "the versions directory itself", so accepting it would let a payload land directly in
# "versions/" and break the one-version-per-directory invariant. A leading "-" is rejected so the
# value can never be mistaken for a flag by a tool this script or the updater later shells out to.
is_valid_version() {
  case "$1" in
    "") return 1 ;;
    .) return 1 ;;
    *..*) return 1 ;;
    -*) return 1 ;;
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
# longer comes from payload signing, only from TLS plus the sidecar SHA-256 checksum below.
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

# `latest` and the checksum sidecar (below) are both tiny, feed-controlled text objects with no
# advertised size of their own, so each download gets a small fixed ceiling rather than none.
# curl's max-filesize option treats a literal zero as "unlimited", so neither constant below may
# ever be zero.
max_pointer_bytes=4096
# The manifest never travels through this script at all (see docs/release.md and the sidecar
# comment below), so there is no per-download size to enforce for the binary either. This
# generous constant only bounds memory/disk against an unbounded stream; the checksum comparison
# below is what actually proves the payload correct.
max_binary_bytes=536870912

if [ "$version" = "latest" ]; then
  latest_pointer=$(fetch --max-filesize "$max_pointer_bytes" "$feed_url/latest" | tr -d '[:space:]')
  is_valid_version "$latest_pointer" || {
    echo "install.sh: the latest pointer did not return a valid version" >&2
    exit 1
  }
  version=$latest_pointer
fi

# Integrity for the binary comes from a sidecar checksum file, not a parsed manifest: POSIX sed
# cannot parse JSON correctly - an unanchored regex over the whole document can be made to match
# a different value than a real JSON parser would pick, so a jq-available branch and a sed
# fallback branch built from the same manifest bytes are not guaranteed to agree on what they
# extract. The feed instead publishes one line of bare lowercase hex per platform binary at
# "<version>/<target>/coforge-computer.sha256", which needs no parser at all. The updater in
# packages/computer/src/updater.ts is a real TypeScript/JSON.parse consumer and keeps reading
# manifest.json directly; that file is unaffected by this script.
sidecar_path="$temporary_directory/coforge-computer.sha256"
fetch --max-filesize "$max_pointer_bytes" --output "$sidecar_path" "$feed_url/$version/$target/coforge-computer.sha256"
expected_sha256=$(tr -d '[:space:]' < "$sidecar_path")
case "$expected_sha256" in
  *[!a-f0-9]*) expected_sha256= ;;
esac
if [ -z "$expected_sha256" ] || [ "${#expected_sha256}" -ne 64 ]; then
  echo "install.sh: sidecar checksum for $target is missing or malformed" >&2
  exit 1
fi

computer_path="$temporary_directory/coforge-computer"
fetch --max-filesize "$max_binary_bytes" --output "$computer_path" "$feed_url/$version/$target/coforge-computer"

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
# A plain (non-exec) invocation runs the binary as a child process, so the EXIT trap above still
# fires once it returns and the temporary directory - including the ~138 MB binary - is removed.
# `exec` would replace this shell with the child and skip the trap entirely, leaking that binary
# into $TMPDIR on every single install.
"$computer_path" install --version "$version"
