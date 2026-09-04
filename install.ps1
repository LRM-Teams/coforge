[CmdletBinding()]
param(
  [Parameter()]
  [string]$Version = "latest"
)

$ErrorActionPreference = "Stop"

# A version is a bare label used both as a URL segment and as a local directory name, so it is
# restricted to a safe charset with no traversal segment - the same rule the updater itself
# applies to a "latest" pointer or an explicit -Version. "." is rejected on its own (in addition
# to the ".." traversal check, which does not catch a lone dot): as a directory name it is "the
# versions directory itself", so accepting it would let a payload land directly in the versions
# root and break the one-version-per-directory invariant. A leading "-" is rejected so the value
# can never be mistaken for a flag by a tool this script or the updater later shells out to. The
# pattern match uses `\z`, not `$`, because .NET regex `$` matches immediately before a trailing
# newline as well as at the true end of string - a version string carrying a trailing "\n" would
# otherwise slip through.
function Test-CoforgeVersion([string]$Value) {
  if ([string]::IsNullOrEmpty($Value)) { return $false }
  if ($Value -eq ".") { return $false }
  if ($Value.Contains("..")) { return $false }
  if ($Value.StartsWith("-")) { return $false }
  if ($Value.Length -gt 100) { return $false }
  return $Value -cmatch '^[A-Za-z0-9.+-]+\z'
}

if ($Version -ne "latest" -and -not (Test-CoforgeVersion $Version)) {
  throw "install.ps1: version must be latest or a valid version string"
}

$defaultFeedUrl = "https://releases.coforge.cn"
# COFORGE_RELEASE_FEED_URL is accepted unconditionally for any https:// host. This script is a
# one-shot the user explicitly runs (`irm ... | iex`), not the long-lived compiled binary that
# packages/computer/src/release-channel.ts hardens by inlining the feed URL at build time - an
# attacker able to set this variable in the invoking shell can equally set PATH or a proxy
# variable to reach the same result, so there is no additional boundary to enforce here. See
# docs/release.md.
$feedUrl = $env:COFORGE_RELEASE_FEED_URL
if ([string]::IsNullOrEmpty($feedUrl)) { $feedUrl = $defaultFeedUrl }
$feedUrl = $feedUrl.TrimEnd("/")

# COFORGE_INSTALLER_TEST_MODE relaxes the HTTPS-only transport so tests can point the installer
# at a local fixture server over plain HTTP. A real install always requires HTTPS: integrity no
# longer comes from payload signing, only from TLS plus the sidecar SHA-256 checksum below.
$testMode = $env:COFORGE_INSTALLER_TEST_MODE -eq "1"
if (-not ($feedUrl.StartsWith("https://") -or ($testMode -and $feedUrl.StartsWith("http://")))) {
  throw "install.ps1: COFORGE_RELEASE_FEED_URL must use HTTPS"
}

# Windows PowerShell 5.1 (.NET Framework) does not negotiate TLS 1.2 by default, unlike
# install.sh's curl invocation, which pins a `--tlsv1.2` floor explicitly. On that runtime this
# OR sets a TLS 1.2 floor by narrowing SecurityProtocol from its default (SystemDefault, value 0)
# to exactly Tls12 - losing any higher version SystemDefault might otherwise have implied is an
# acceptable trade for not silently falling back to 1.0/1.1. Only Tls12 is OR'd in, not a literal
# Tls13 enum member: that member is not guaranteed to exist on every .NET Framework patch level,
# and OR'ing in its well-known numeric value would silently no-op instead of erroring if it were
# ever wrong for a given runtime. On PowerShell 7's .NET Core runtime, ServicePointManager is
# largely vestigial and the OS/runtime negotiates TLS independently, so this line is close to a
# no-op there rather than a floor - untested on either runtime; see the CR description.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$target = switch ($architecture) {
  "x64" { "windows-x64" }
  "arm64" { "windows-arm64" }
  default { throw "install.ps1: unsupported Windows architecture: $architecture" }
}

# `latest` and the checksum sidecar are both tiny, feed-controlled text objects with no
# advertised size of their own, so each download gets a small fixed ceiling rather than none.
$maxPointerBytes = 4096
# The manifest no longer travels through this script (see docs/release.md); there is no
# per-download size to enforce for the binary either. This generous constant only bounds
# memory/disk against an unbounded stream - the checksum comparison below is what actually
# proves the payload correct.
$maxBinaryBytes = 536870912

# Invoke-WebRequest on Windows PowerShell 5.1 offers neither a working redirect refusal (its
# -MaximumRedirection parameter does not reliably reject a redirect the way curl's --proto does
# for install.sh) nor any response-size limit at all, so both are implemented directly against
# System.Net.Http.HttpClient. `$handler.AllowAutoRedirect = $false` below is what actually
# refuses a redirect - an https-to-http downgrade redirect (or any redirect) then arrives here as
# an ordinary, un-followed 3xx response rather than being silently followed (N5); the explicit
# status-code check right below just turns that already-blocked case into a clearer error message
# than the generic "returned HTTP $status" branch would (it is otherwise redundant with
# IsSuccessStatusCode, which is also false for a 3xx). The response body is copied through a
# size-counted stream that throws once it exceeds MaxBytes rather than buffering an
# attacker-controlled feed's entire response (N4).
#
# This function has not been exercised against a real pwsh/Windows PowerShell runtime - the
# sandbox this change was written and tested in has neither installed - so treat it as reviewed
# but functionally unverified; see the CR description for the line-by-line reasoning in place of
# a test run.
function Get-CoforgeObject([string]$Uri, [string]$OutFile, [long]$MaxBytes) {
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $false
  $client = New-Object System.Net.Http.HttpClient($handler)
  try {
    $response = $client.GetAsync($Uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    try {
      if ([int]$response.StatusCode -ge 300 -and [int]$response.StatusCode -lt 400) {
        throw "install.ps1: $Uri returned a redirect, which is not followed"
      }
      if (-not $response.IsSuccessStatusCode) {
        throw "install.ps1: $Uri returned HTTP $([int]$response.StatusCode)"
      }
      $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      try {
        $outputStream = [System.IO.File]::Open($OutFile, [System.IO.FileMode]::Create)
        try {
          $buffer = New-Object byte[] 65536
          [long]$total = 0
          while ($true) {
            $read = $inputStream.Read($buffer, 0, $buffer.Length)
            if ($read -le 0) { break }
            $total += $read
            if ($total -gt $MaxBytes) {
              throw "install.ps1: $Uri exceeded the maximum allowed size of $MaxBytes bytes"
            }
            $outputStream.Write($buffer, 0, $read)
          }
        } finally {
          $outputStream.Dispose()
        }
      } finally {
        $inputStream.Dispose()
      }
    } finally {
      $response.Dispose()
    }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("coforge-installer-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
try {
  if ($Version -eq "latest") {
    $latestPath = Join-Path $temporaryDirectory "latest"
    Get-CoforgeObject -Uri "$feedUrl/latest" -OutFile $latestPath -MaxBytes $maxPointerBytes
    $latestPointer = (Get-Content -Raw -LiteralPath $latestPath).Trim()
    if (-not (Test-CoforgeVersion $latestPointer)) {
      throw "install.ps1: the latest pointer did not return a valid version"
    }
    $Version = $latestPointer
  }

  # Integrity for the binary comes from a sidecar checksum file, not a parsed manifest.json: the
  # feed publishes one line of bare lowercase hex per platform binary at
  # "<version>/<target>/coforge-computer.sha256". The updater in
  # packages/computer/src/updater.ts is a real JSON.parse consumer and keeps reading
  # manifest.json directly; that file is unaffected by this script.
  $sidecarPath = Join-Path $temporaryDirectory "coforge-computer.sha256"
  Get-CoforgeObject -Uri "$feedUrl/$Version/$target/coforge-computer.sha256" -OutFile $sidecarPath -MaxBytes $maxPointerBytes
  $expectedSha256 = (Get-Content -Raw -LiteralPath $sidecarPath).Trim()
  if ($expectedSha256 -notmatch '^[a-f0-9]{64}\z') {
    throw "install.ps1: sidecar checksum for $target is missing or malformed"
  }

  $computerPath = Join-Path $temporaryDirectory "coforge-computer.exe"
  Get-CoforgeObject -Uri "$feedUrl/$Version/$target/coforge-computer" -OutFile $computerPath -MaxBytes $maxBinaryBytes
  $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $computerPath).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "install.ps1: downloaded binary failed its checksum check"
  }

  & $computerPath install --version $Version
  exit $LASTEXITCODE
}
finally {
  Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
