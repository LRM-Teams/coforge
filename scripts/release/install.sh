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

command -v gzip >/dev/null 2>&1 || {
  echo "install.sh: gzip is required to install CoForge" >&2
  exit 1
}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=linux-x64 ;;
  Linux-aarch64|Linux-arm64) target=linux-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  Darwin-arm64) target=darwin-arm64 ;;
  *) echo "install.sh: unsupported platform" >&2; exit 1 ;;
esac

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/coforge-installer.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

is_interactive=0
if [ -t 2 ] && [ "${COFORGE_INSTALLER_NO_COLOR:-}" != "1" ]; then
  is_interactive=1
else
  is_interactive=0
fi

if [ "$is_interactive" -eq 1 ]; then
  bold='\033[1m'
  muted='\033[2m'
  accent='\033[36m'
  success='\033[32m'
  reset='\033[0m'
else
  bold=''; muted=''; accent=''; success=''; reset=''
fi

step() {
  printf '%b\n' "${accent}==>${reset} ${bold}$1${reset}" >&2
}

done_step() {
  printf '%b\n' "${success}   ✓${reset} $1" >&2
}

fetch() {
  # Do not use curl's progress meter here. The installer already reports the bounded,
  # meaningful steps below; curl's meter writes frequent carriage-return updates to stderr,
  # which become a large stream of lines when stderr is captured by a terminal wrapper.
  curl --fail --silent --show-error --location --proto "$curl_proto" --tlsv1.2 "$@"
}

fetch_binary() {
  if [ "$is_interactive" -eq 1 ] && [ "${COFORGE_INSTALLER_PROGRESS:-}" != "0" ]; then
    curl --fail --progress-bar --show-error --location --proto "$curl_proto" --tlsv1.2 "$@"
  else
    fetch "$@"
  fi
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
  step "Finding the latest CoForge version"
  latest_pointer=$(fetch --max-filesize "$max_pointer_bytes" "$feed_url/latest" | tr -d '[:space:]')
  is_valid_version "$latest_pointer" || {
    echo "install.sh: the latest pointer did not return a valid version" >&2
    exit 1
  }
  version=$latest_pointer
fi

if [ "$is_interactive" -eq 1 ]; then
  printf '%b\n' "${muted}   CoForge Computer · $target · $version${reset}" >&2
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
step "Preparing the download"
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
compressed_path="$temporary_directory/coforge-computer.gz"
step "Downloading CoForge Computer"
fetch_binary --max-filesize "$max_binary_bytes" --output "$compressed_path" "$feed_url/$version/$target/coforge-computer.gz"
done_step "Download complete"
# Limit the output both while expanding and after completion. POSIX ulimit -f is measured
# in 512-byte blocks, so this matches max_binary_bytes without trusting gzip metadata.
step "Unpacking and verifying"
(ulimit -f 1048576; gzip -dc "$compressed_path" > "$computer_path") || {
  echo "install.sh: compressed binary could not be decompressed safely" >&2
  exit 1
}
[ "$(wc -c < "$computer_path" | tr -d '[:space:]')" -le "$max_binary_bytes" ] || {
  echo "install.sh: decompressed binary exceeds the size limit" >&2
  exit 1
}

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
done_step "Checksum verified"

chmod 700 "$computer_path"
# A plain (non-exec) invocation runs the binary as a child process, so the EXIT trap above still
# fires once it returns and the temporary directory - including the ~138 MB binary - is removed.
# `exec` would replace this shell with the child and skip the trap entirely, leaking that binary
# into $TMPDIR on every single install.
step "Installing CoForge"
"$computer_path" install --version "$version"

bin_directory="$HOME/.coforge/computer/bin"
# Expand HOME and PATH when the user's shell reads its configuration, not in this installer.
# shellcheck disable=SC2016
posix_path_line='export PATH="$HOME/.coforge/computer/bin:$PATH"'
# shellcheck disable=SC2016
fish_path_line='fish_add_path "$HOME/.coforge/computer/bin"'

append_path_line() {
  configuration_path=$1
  configuration_line=$2
  configuration_directory=${configuration_path%/*}

  mkdir -p "$configuration_directory" || return 1
  if [ -f "$configuration_path" ] && grep -Fqx "$configuration_line" "$configuration_path"; then
    return 0
  fi
  printf '\n%s\n' "$configuration_line" >> "$configuration_path"
}

case "${SHELL:-}" in
  */fish)
    fish_configuration_root=${XDG_CONFIG_HOME:-$HOME/.config}
    shell_configuration="$fish_configuration_root/fish/conf.d/coforge.fish"
    shell_path_line=$fish_path_line
    session_command="fish_add_path \"$bin_directory\""
    shell_name=fish
    ;;
  */zsh)
    shell_configuration="${ZDOTDIR:-$HOME}/.zshrc"
    shell_path_line=$posix_path_line
    session_command="export PATH=\"$bin_directory:\$PATH\""
    shell_name=zsh
    ;;
  */bash)
    shell_configuration="$HOME/.bashrc"
    shell_path_line=$posix_path_line
    session_command="export PATH=\"$bin_directory:\$PATH\""
    shell_name=bash
    ;;
  *) shell_configuration= ;;
esac

if [ -n "$shell_configuration" ]; then
  if ! append_path_line "$shell_configuration" "$shell_path_line"; then
    echo "install.sh: CoForge was installed, but PATH could not be saved to $shell_configuration" >&2
    echo "install.sh: add this line manually: $shell_path_line" >&2
    exit 1
  fi
  if [ "$shell_name" = bash ]; then
    # Login Bash reads the first existing profile, not .bashrc (notably on macOS).
    login_configuration="$HOME/.bash_profile"
    for candidate in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
      if [ -f "$candidate" ]; then
        login_configuration=$candidate
        break
      fi
    done
    if ! append_path_line "$login_configuration" "$shell_path_line"; then
      echo "install.sh: CoForge was installed, but PATH could not be saved to $login_configuration" >&2
      exit 1
    fi
  fi
  done_step "Saved CoForge PATH setup for $shell_name in $shell_configuration"
else
  echo "install.sh: warning: could not identify bash, zsh, or fish from SHELL; PATH was not changed" >&2
  session_command="export PATH=\"$bin_directory:\$PATH\""
fi

done_step "CoForge Computer $version installed"
printf '%b\n' "" >&2
printf '%b\n' "This installer cannot change the current shell. For this session, run:" >&2
printf '%b\n' "  ${accent}$session_command${reset}" >&2
printf '%s\n' "Or run directly without changing PATH:" >&2
# shellcheck disable=SC2016
printf '%s\n' '  "$HOME/.coforge/computer/bin/coforge-computer" setup --workspace <slug>' >&2
