[CmdletBinding()]
param(
  [Parameter()]
  [string]$Version = "latest"
)

$ErrorActionPreference = "Stop"
if ($Version -ne "latest" -and $Version -ne "test" -and $Version -notmatch '^sha256:[0-9a-f]{64}$') {
  throw "install.ps1: version must be latest, test, or an exact sha256 release-set id"
}

if ($env:COFORGE_INSTALLER_TEST_MODE -eq "1" -and $env:COFORGE_BOOTSTRAP_PATH) {
  & $env:COFORGE_BOOTSTRAP_PATH install --version $Version
  exit $LASTEXITCODE
}

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$target = switch ($architecture) {
  "x64" { "windows-x64" }
  "arm64" { "windows-arm64" }
  default { throw "install.ps1: unsupported Windows architecture: $architecture" }
}

# Provisioning replaces these empty pins with the reviewed immutable bootstrap digests.
$bootstrapPins = @{
  "windows-x64" = ""
  "windows-arm64" = ""
}
$expectedSha256 = $bootstrapPins[$target]
if (-not $expectedSha256) {
  throw "install.ps1: signed bootstrap for $target is not published; OSS/CDN provisioning is pending"
}

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("coforge-installer-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
try {
  $bootstrap = Join-Path $temporaryDirectory "coforge-installer.exe"
  Invoke-WebRequest -Uri "https://cdn.coforge.cn/releases/bootstrap/v1/$target/coforge-installer.exe" -OutFile $bootstrap
  $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $bootstrap).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) { throw "install.ps1: bootstrap integrity check failed" }
  & $bootstrap install --version $Version
  exit $LASTEXITCODE
}
finally {
  Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
