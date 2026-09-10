[CmdletBinding()]
param(
  [Parameter()]
  [string]$Version = "latest",
  [Parameter()]
  [string]$PrepareDirectory,
  [Parameter()]
  [string]$Target,
  [Parameter()]
  [switch]$ResolveOnly,
  [Parameter()]
  [switch]$QuietHeader,
  [Parameter()]
  [ValidateSet("all", "manifest", "artifact")]
  [string]$PreparePhase = "all"
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

$curlProto = if ($testMode -and $feedUrl.StartsWith("http://")) { "=http,https" } else { "=https" }
if ([string]::IsNullOrEmpty($Target)) {
  $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  $Target = switch ($architecture) {
    "x64" { "windows-x64" }
    "arm64" { "windows-arm64" }
    default { throw "install.ps1: unsupported Windows architecture: $architecture" }
  }
}
$platform = switch -CaseSensitive ($Target) {
  "linux-x64" { "Linux x64" }
  "linux-arm64" { "Linux ARM64" }
  "darwin-x64" { "macOS (Intel)" }
  "darwin-arm64" { "macOS (Apple Silicon)" }
  "windows-x64" { "Windows x64" }
  "windows-arm64" { "Windows ARM64" }
  default { throw "install.ps1: unsupported release target: $Target" }
}
if ($PreparePhase -ne "all" -and -not $PrepareDirectory) {
  throw "install.ps1: preparation phase requires a directory"
}

# `latest` and the checksum sidecar are both tiny, feed-controlled text objects with no
# advertised size of their own, so each download gets a small fixed ceiling rather than none.
$maxPointerBytes = 4096
$maxManifestBytes = 1048576
# Fixed transport ceiling; the updater checks exact compressed and expanded manifest sizes.
$maxBinaryBytes = 536870912

function Write-CoforgeStep([string]$Message) {
  [Console]::Error.WriteLine("==> $Message")
}

# Use native curl (not PowerShell's curl alias). No redirects are followed, including for
# bodies, preserving the Windows bootstrap and updater transport policy.
function Get-CoforgeObject([string]$Uri, [string]$OutFile, [long]$MaxBytes, [switch]$Binary) {
  $progress = if ($Binary -and -not [Console]::IsErrorRedirected) { "--progress-bar" } else { "--silent" }
  $status = & curl.exe --fail $progress --show-error --proto $curlProto --tlsv1.2 --max-filesize $MaxBytes --output $OutFile --write-out '%{http_code}' $Uri
  if ($LASTEXITCODE -ne 0) {
    throw "install.ps1: download failed with curl exit code $LASTEXITCODE"
  }
  if ($status -cnotmatch '^2[0-9]{2}\z') {
    throw "install.ps1: download returned HTTP $status (redirects are not followed)"
  }
  if ((Get-Item -LiteralPath $OutFile).Length -gt $MaxBytes) {
    throw "install.ps1: download exceeded the maximum allowed size of $MaxBytes bytes"
  }
}

function Expand-CoforgeGzip([string]$InputFile, [string]$OutFile, [long]$MaxBytes) {
  $inputStream = [System.IO.File]::OpenRead($InputFile)
  try {
    $gzipStream = [System.IO.Compression.GZipStream]::new(
      $inputStream,
      [System.IO.Compression.CompressionMode]::Decompress
    )
    try {
      $outputStream = [System.IO.File]::Open($OutFile, [System.IO.FileMode]::Create)
      try {
        $buffer = New-Object byte[] 65536
        [long]$total = 0
        while ($true) {
          $read = $gzipStream.Read($buffer, 0, $buffer.Length)
          if ($read -le 0) { break }
          $total += $read
          if ($total -gt $MaxBytes) {
            throw "install.ps1: decompressed binary exceeded the maximum allowed size of $MaxBytes bytes"
          }
          $outputStream.Write($buffer, 0, $read)
        }
      } finally {
        $outputStream.Dispose()
      }
    } finally {
      $gzipStream.Dispose()
    }
  } finally {
    $inputStream.Dispose()
  }
}

if ($PrepareDirectory) {
  if (-not (Test-Path -LiteralPath $PrepareDirectory -PathType Container)) {
    throw "install.ps1: preparation directory must already exist"
  }
  $temporaryDirectory = $PrepareDirectory
} else {
  $temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("coforge-installer-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
}
try {
  if (-not $QuietHeader) { Write-CoforgeStep "Detected platform: $platform" }
  if ($Version -eq "latest") {
    if (-not $QuietHeader) { Write-CoforgeStep "Finding the latest CoForge Computer version" }
    $latestPath = Join-Path $temporaryDirectory "latest"
    Get-CoforgeObject -Uri "$feedUrl/latest" -OutFile $latestPath -MaxBytes $maxPointerBytes
    # Get-Content -Raw on a zero-byte file returns $null on Windows PowerShell 5.1, and $null has
    # no .Trim() method - the [string] cast turns that into an empty string, matching how
    # is_valid_version("") in install.sh already fails closed on an empty body instead of
    # erroring out with an unrelated method-not-found exception.
    $latestPointer = ([string](Get-Content -Raw -LiteralPath $latestPath)).Trim()
    Remove-Item -LiteralPath $latestPath
    if ($latestPointer -eq "latest" -or -not (Test-CoforgeVersion $latestPointer)) {
      throw "install.ps1: the latest pointer did not return a valid version"
    }
    $Version = $latestPointer
  }

  if (-not $QuietHeader) { Write-CoforgeStep "Resolved version: $Version" }
  if ($ResolveOnly) {
    Write-Output $Version
    return
  }

  $manifestPath = Join-Path $temporaryDirectory "manifest.json"
  if ($PreparePhase -ne "artifact") {
    Get-CoforgeObject -Uri "$feedUrl/$Version/manifest.json" -OutFile $manifestPath -MaxBytes $maxManifestBytes
  }
  if ($PreparePhase -eq "manifest") { return }
  $compressedPath = Join-Path $temporaryDirectory "coforge-computer.gz"
  Write-CoforgeStep "Downloading CoForge Computer"
  Get-CoforgeObject -Uri "$feedUrl/$Version/$Target/coforge-computer.gz" -OutFile $compressedPath -MaxBytes $maxBinaryBytes -Binary
  [System.IO.File]::WriteAllText((Join-Path $temporaryDirectory "version"), "$Version`n", [System.Text.UTF8Encoding]::new($false))
  if ($PrepareDirectory) { return }

  # Bootstrap checks the sidecar before executing code; the local installer parses the manifest.
  $sidecarPath = Join-Path $temporaryDirectory "coforge-computer.sha256"
  Get-CoforgeObject -Uri "$feedUrl/$Version/$target/coforge-computer.sha256" -OutFile $sidecarPath -MaxBytes $maxPointerBytes
  $expectedSha256 = ([string](Get-Content -Raw -LiteralPath $sidecarPath)).Trim()
  # `-cnotmatch`, not the case-insensitive default `-notmatch`: Get-FileHash below always returns
  # lowercase hex (`.ToLowerInvariant()`), so a sidecar carrying uppercase hex would pass this
  # check under case-insensitive matching and then fail the checksum comparison instead - the
  # wrong error, for the wrong reason. install.sh's `case` pattern is inherently
  # case-sensitive, so this keeps both scripts equally strict about the sidecar's format.
  if ($expectedSha256 -cnotmatch '^[a-f0-9]{64}\z') {
    throw "install.ps1: sidecar checksum for $target is missing or malformed"
  }

  $computerPath = Join-Path $temporaryDirectory "coforge-computer.exe"
  Expand-CoforgeGzip -InputFile $compressedPath -OutFile $computerPath -MaxBytes $maxBinaryBytes
  $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $computerPath).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "install.ps1: downloaded binary failed its checksum check"
  }

  & $computerPath __install-local --version $Version --directory $temporaryDirectory
  # Not `exit`: the documented entry point is `irm ... | iex`, which runs this script inside the
  # user's own PowerShell process, where a top-level `exit` terminates their session - closing the
  # window on success just as readily as on failure. Throwing surfaces the failure through the
  # same path as every other error above and leaves the host alone. Running in-process is also
  # what lets the PATH work below take effect in the very session that ran the installer.
  if ($LASTEXITCODE -ne 0) {
    throw "install.ps1: CoForge Computer $Version install exited with code $LASTEXITCODE"
  }

  # Mirrors packages/computer/src/paths.ts:resolveComputerBinaryDirectory for win32, which in turn
  # takes its home directory the way packages/computer/src/cli.ts does - HOME first, USERPROFILE
  # second. `$HOME` is a read-only PowerShell automatic variable and is not the same thing as
  # `$env:HOME`, so the environment variables are read explicitly.
  $homeDirectory = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
  $binDirectory = Join-Path $homeDirectory ".coforge\computer\bin"
  # Windows has no directory convention that is already on PATH the way ~/.local/bin is on
  # Linux and macOS, so the shim keeps the private directory and this script puts that directory
  # on PATH instead. The shim is a .cmd launcher, not an .exe (packages/computer/src/updater.ts);
  # PATHEXT is what makes it invocable as a bare `coforge-computer` from both cmd and PowerShell.
  $shimPath = Join-Path $binDirectory "coforge-computer.cmd"
  if (-not (Test-Path -LiteralPath $shimPath)) {
    throw "install.ps1: CoForge Computer $Version was installed, but no shim appeared at $shimPath - that version predates this installer. Re-run this installer once a newer version is published."
  }

  # Persist to the current user's environment only - never HKLM or the "Machine" scope, which
  # would need elevation and would change PATH for every account on the box.
  #
  # The registry is written through the raw API rather than
  # [Environment]::SetEnvironmentVariable(..., "User"), which reads the value back expanded and
  # rewrites it as a plain REG_SZ. On any user whose Path legitimately contains a reference like
  # %USERPROFILE%, that silently bakes in today's expansion and destroys the reference. Reading
  # with DoNotExpandEnvironmentNames and writing back as ExpandString preserves it.
  $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
  try {
    $storedPath = [string]$environmentKey.GetValue(
      "Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    # Compare entry by entry, not by substring: a substring test both misses "already present but
    # written with a trailing separator" and falsely matches a directory this one is a prefix of.
    $storedEntries = $storedPath.Split(";") | Where-Object { $_ -ne "" }
    $alreadyStored = $false
    foreach ($entry in $storedEntries) {
      if ($entry.TrimEnd("\") -ieq $binDirectory.TrimEnd("\")) { $alreadyStored = $true }
    }
    if (-not $alreadyStored) {
      $updatedPath = if ($storedPath -eq "") { $binDirectory } else { "$binDirectory;$storedPath" }
      $environmentKey.SetValue("Path", $updatedPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    }
  }
  finally {
    if ($environmentKey) { $environmentKey.Close() }
  }
  # No WM_SETTINGCHANGE broadcast: every console opened from here on reads the registry at launch,
  # so the only processes a broadcast would reach are Explorer-spawned applications already
  # running, which is not worth a user32 P/Invoke in a bootstrap script.

  # The registry write only reaches future processes. This assignment is what makes the command
  # usable in the session that ran the installer - it works precisely because `irm ... | iex`
  # executes here rather than in a child process. Checked independently of the registry: either
  # can already be true without the other.
  $sessionEntries = ($env:Path -split ";") | Where-Object { $_ -ne "" }
  $alreadyInSession = $false
  foreach ($entry in $sessionEntries) {
    if ($entry.TrimEnd("\") -ieq $binDirectory.TrimEnd("\")) { $alreadyInSession = $true }
  }
  if (-not $alreadyInSession) { $env:Path = "$binDirectory;$env:Path" }

  # Keep completion guidance out of the script's pipeline return value.
  Write-Host "   CoForge Computer $Version installed and ready to use"
  Write-Host "Next: coforge-computer setup --workspace <slug>"
}
finally {
  if (-not $PrepareDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
