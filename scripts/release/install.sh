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
prepare_directory=
target=
resolve_only=0
quiet_header=0
prepare_phase=all
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prepare-directory|--target|--prepare-phase)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "install.sh: $1 requires a value" >&2; exit 2; }
      case "$1" in
        --prepare-directory) prepare_directory=$2 ;;
        --target) target=$2 ;;
        --prepare-phase) prepare_phase=$2 ;;
      esac
      shift 2
      ;;
    --resolve-only) resolve_only=1; shift ;;
    --quiet-header) quiet_header=1; shift ;;
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

if [ -z "$prepare_directory" ] && [ "$resolve_only" -eq 0 ]; then
command -v gzip >/dev/null 2>&1 || {
  echo "install.sh: gzip is required to install CoForge Computer" >&2
  exit 1
}
fi

if [ -z "$target" ]; then
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=linux-x64 ;;
  Linux-aarch64|Linux-arm64) target=linux-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  Darwin-arm64) target=darwin-arm64 ;;
  *) echo "install.sh: unsupported platform" >&2; exit 1 ;;
esac
fi
case "$target" in
  linux-x64) platform='Linux x64' ;;
  linux-arm64) platform='Linux ARM64' ;;
  darwin-x64) platform='macOS (Intel)' ;;
  darwin-arm64) platform='macOS (Apple Silicon)' ;;
  windows-x64) platform='Windows x64' ;;
  windows-arm64) platform='Windows ARM64' ;;
  *) echo "install.sh: unsupported release target: $target" >&2; exit 2 ;;
esac
case "$prepare_phase" in
  all) ;;
  manifest|artifact) [ -n "$prepare_directory" ] || { echo "install.sh: preparation phase requires a directory" >&2; exit 2; } ;;
  *) echo "install.sh: invalid preparation phase" >&2; exit 2 ;;
esac

if [ -n "$prepare_directory" ]; then
  [ -d "$prepare_directory" ] || { echo "install.sh: preparation directory must already exist" >&2; exit 2; }
  temporary_directory=$prepare_directory
else
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/coforge-installer.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
fi

is_interactive=0
if [ -t 2 ]; then
  is_interactive=1
else
  is_interactive=0
fi

if [ "$is_interactive" -eq 1 ] && [ "${COFORGE_INSTALLER_NO_COLOR:-}" != "1" ] && [ -z "${NO_COLOR:-}" ]; then
  bold='\033[1m'
  accent='\033[36m'
  success='\033[32m'
  reset='\033[0m'
else
  bold=''; accent=''; success=''; reset=''
fi

step() {
  printf '%b\n' "${accent}==>${reset} ${bold}$1${reset}" >&2
}

done_step() {
  printf '%b\n' "${success}   ✓${reset} $1" >&2
}

fetch() {
  # Metadata must not follow redirects. --fail alone accepts 3xx responses.
  status=$(curl --fail --silent --show-error --proto "$curl_proto" --tlsv1.2 --write-out '%{http_code}' "$@") || return 1
  case "$status" in
    2??) ;;
    *) echo "install.sh: download returned HTTP $status (redirects are not followed)" >&2; return 1 ;;
  esac
}

fetch_binary() {
  progress=--silent
  if [ "$is_interactive" -eq 1 ] && [ "${COFORGE_INSTALLER_PROGRESS:-}" != "0" ]; then
    progress=--progress-bar
  fi
  # Preserve bootstrap's HTTPS-only redirects; updater preparation refuses every redirect.
  redirects=--location
  [ -z "$prepare_directory" ] || redirects=
  status=$(curl --fail "$progress" --show-error $redirects --proto "$curl_proto" --proto-redir "$curl_proto" --tlsv1.2 --write-out '%{http_code}' "$@") || return 1
  case "$status" in
    2??) ;;
    *) echo "install.sh: download returned HTTP $status" >&2; return 1 ;;
  esac
}

# `latest` and the checksum sidecar (below) are both tiny, feed-controlled text objects with no
# advertised size of their own, so each download gets a small fixed ceiling rather than none.
# curl's max-filesize option treats a literal zero as "unlimited", so neither constant below may
# ever be zero.
max_pointer_bytes=4096
max_manifest_bytes=1048576
# Fixed transport ceiling; the updater checks exact compressed and expanded manifest sizes.
max_binary_bytes=536870912

[ "$quiet_header" -eq 1 ] || step "Detected platform: $platform"
if [ "$version" = "latest" ]; then
  [ "$quiet_header" -eq 1 ] || step "Finding the latest CoForge Computer version"
  fetch --max-filesize "$max_pointer_bytes" --output "$temporary_directory/latest" "$feed_url/latest"
  latest_pointer=$(tr -d '[:space:]' < "$temporary_directory/latest")
  rm "$temporary_directory/latest"
  if [ "$latest_pointer" = latest ] || ! is_valid_version "$latest_pointer"; then
    echo "install.sh: the latest pointer did not return a valid version" >&2
    exit 1
  fi
  version=$latest_pointer
fi

[ "$quiet_header" -eq 1 ] || step "Resolved version: $version"
if [ "$resolve_only" -eq 1 ]; then
  printf '%s\n' "$version"
  exit 0
fi

if [ "$prepare_phase" != artifact ]; then
  fetch --max-filesize "$max_manifest_bytes" --output "$temporary_directory/manifest.json" "$feed_url/$version/manifest.json"
fi
[ "$prepare_phase" != manifest ] || exit 0
compressed_path="$temporary_directory/coforge-computer.gz"
step "Downloading CoForge Computer"
fetch_binary --max-filesize "$max_binary_bytes" --output "$compressed_path" "$feed_url/$version/$target/coforge-computer.gz"
printf '%s\n' "$version" > "$temporary_directory/version"
if [ -n "$prepare_directory" ]; then
  exit 0
fi

# Bootstrap checks the sidecar before executing code; the local installer parses the manifest.
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
# Limit the output both while expanding and after completion. POSIX ulimit -f is measured
# in 512-byte blocks, so this matches max_binary_bytes without trusting gzip metadata.
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

chmod 700 "$computer_path"
# A plain (non-exec) invocation runs the binary as a child process, so the EXIT trap above still
# fires once it returns and the temporary directory - including the ~138 MB binary - is removed.
# `exec` would replace this shell with the child and skip the trap entirely, leaking that binary
# into $TMPDIR on every single install.
"$computer_path" __install-local --version "$version" --directory "$temporary_directory"

# This must resolve the shim directory by exactly the rule
# packages/computer/src/paths.ts:resolveComputerBinaryDirectory applies, because the binary
# invoked above is what actually creates the shim - if the two disagree, every hint printed below
# names a path that does not exist. A relative XDG_BIN_HOME is not a usable PATH entry, so, as
# there, only an absolute value is honoured.
bin_directory=${XDG_BIN_HOME:-}
case "$bin_directory" in
  /*) ;;
  *) bin_directory="$HOME/.local/bin" ;;
esac

# This script is served by the web app and the binary comes from the release feed, so the two
# reach a user on independent cadences: a deploy carrying this version of the script can download
# a published version that still installs its shim somewhere else. Every message below - most of
# all the "already on PATH, just run it" path - would then name a command that does not exist, so
# confirm the shim really landed where this script believes it did before claiming anything.
if [ ! -x "$bin_directory/coforge-computer" ]; then
  echo "install.sh: CoForge Computer $version was installed, but no shim appeared at" >&2
  echo "install.sh: $bin_directory/coforge-computer - that version predates this installer." >&2
  echo "install.sh: re-run this installer once a newer CoForge Computer version is published." >&2
  exit 1
fi

# Expand HOME and PATH when the user's shell reads its configuration, not in this installer. The
# literal below is only correct for the default directory; an XDG_BIN_HOME install writes the
# already-resolved path instead, since that variable need not be set in a later shell.
if [ "$bin_directory" = "$HOME/.local/bin" ]; then
  # shellcheck disable=SC2016
  posix_path_line='export PATH="$HOME/.local/bin:$PATH"'
  # shellcheck disable=SC2016
  fish_path_line='fish_add_path "$HOME/.local/bin"'
else
  posix_path_line="export PATH=\"$bin_directory:\$PATH\""
  fish_path_line="fish_add_path \"$bin_directory\""
fi

# Installing into the XDG user binary directory is what makes this "just work": it is already on
# PATH for most users, so the command is usable in this very shell and there is nothing to
# configure and nothing to tell the user to run. Shell configuration is edited only in the
# fallback below, when the directory really is absent from PATH.
case ":${PATH:-}:" in
  *":$bin_directory:"*)
    step "$bin_directory is already on PATH"
    done_step "CoForge Computer $version installed and ready to use"
    printf '%b\n' "Next: ${accent}coforge-computer setup --workspace <slug>${reset}" >&2
    exit 0
    ;;
esac

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
    echo "install.sh: CoForge Computer $version was installed, but PATH could not be saved to $shell_configuration" >&2
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
      echo "install.sh: CoForge Computer $version was installed, but PATH could not be saved to $login_configuration" >&2
      exit 1
    fi
  fi
  done_step "Added $bin_directory to your $shell_name PATH in $shell_configuration"
else
  echo "install.sh: warning: SHELL is not bash, zsh, or fish, so PATH was left unchanged" >&2
  session_command="export PATH=\"$bin_directory:\$PATH\""
fi

done_step "CoForge Computer $version installed"
printf '%b\n' "Current terminal: ${accent}$session_command${reset}" >&2
printf '%s\n' "Next: \"$bin_directory/coforge-computer\" setup --workspace <slug>" >&2
