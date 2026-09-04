[CmdletBinding()]
param(
  [Parameter()]
  [string]$Version = "latest"
)

$ErrorActionPreference = "Stop"

# A version is a bare label used both as a URL segment and as a local directory name, so it is
# restricted to a safe charset with no traversal segment - the same rule the updater itself
# applies to a "latest" pointer or an explicit -Version.
function Test-CoforgeVersion([string]$Value) {
  if ([string]::IsNullOrEmpty($Value)) { return $false }
  if ($Value.Contains("..")) { return $false }
  if ($Value.Length -gt 100) { return $false }
  return $Value -cmatch '^[A-Za-z0-9.+-]+$'
}

if ($Version -ne "latest" -and -not (Test-CoforgeVersion $Version)) {
  throw "install.ps1: version must be latest or a valid version string"
}

$defaultFeedUrl = "https://releases.coforge.cn"
$feedUrl = $env:COFORGE_RELEASE_FEED_URL
if ([string]::IsNullOrEmpty($feedUrl)) { $feedUrl = $defaultFeedUrl }
$feedUrl = $feedUrl.TrimEnd("/")

# COFORGE_INSTALLER_TEST_MODE relaxes the HTTPS-only transport so tests can point the installer
# at a local fixture server over plain HTTP. A real install always requires HTTPS: integrity no
# longer comes from payload signing, only from TLS plus the manifest's SHA-256 checksums below.
$testMode = $env:COFORGE_INSTALLER_TEST_MODE -eq "1"
if (-not ($feedUrl.StartsWith("https://") -or ($testMode -and $feedUrl.StartsWith("http://")))) {
  throw "install.ps1: COFORGE_RELEASE_FEED_URL must use HTTPS"
}

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$target = switch ($architecture) {
  "x64" { "windows-x64" }
  "arm64" { "windows-arm64" }
  default { throw "install.ps1: unsupported Windows architecture: $architecture" }
}

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("coforge-installer-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
try {
  if ($Version -eq "latest") {
    $latestPointer = (Invoke-WebRequest -Uri "$feedUrl/latest" -UseBasicParsing).Content.Trim()
    if (-not (Test-CoforgeVersion $latestPointer)) {
      throw "install.ps1: the latest pointer did not return a valid version"
    }
    $Version = $latestPointer
  }

  $manifestPath = Join-Path $temporaryDirectory "manifest.json"
  Invoke-WebRequest -Uri "$feedUrl/$Version/manifest.json" -OutFile $manifestPath -UseBasicParsing
  # The manifest is not signed; only the CDN's TLS and this checksum protect the download.
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $platform = $manifest.platforms.$target
  if (-not $platform -or -not $platform.computer) {
    throw "install.ps1: manifest has no computer entry for $target"
  }
  $expectedSha256 = [string]$platform.computer.checksum
  if ($expectedSha256 -notmatch '^[a-f0-9]{64}$') {
    throw "install.ps1: manifest checksum for $target is missing or malformed"
  }
  $expectedSize = $platform.computer.size
  if ($null -eq $expectedSize -or $expectedSize -lt 0) {
    throw "install.ps1: manifest size for $target is missing or malformed"
  }

  $computerPath = Join-Path $temporaryDirectory "coforge-computer.exe"
  Invoke-WebRequest -Uri "$feedUrl/$Version/$target/coforge-computer" -OutFile $computerPath -UseBasicParsing
  $actualSize = (Get-Item -LiteralPath $computerPath).Length
  if ($actualSize -ne $expectedSize) {
    throw "install.ps1: downloaded binary size does not match the manifest"
  }
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
