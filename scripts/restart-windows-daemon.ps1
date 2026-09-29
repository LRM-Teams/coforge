#Requires -Version 5.1
<#
.\scripts\restart-windows-daemon.ps1 -Setup my

.SYNOPSIS
  Rebuild the local Windows Computer/Daemon fixture, install it, and restart
  the Coordinator Scheduled Task.

.DESCRIPTION
  Windows counterpart of scripts/reload-local-computer.sh:

    1. Generate protobuf
    2. Build the E2E Computer fixture (Computer + Daemon in one exe)
    3. __install-local into ~/.coforge
    4. Restart the "CoForge Daemon" user Scheduled Task via schtasks XML
       (LogonTrigger + LeastPrivilege; works without elevation)

  Environment:
    COFORGE_E2E_WEB_URL              Baked into the fixture. Must match the
                                     running Daemon's server origin
                                     (localhost vs 127.0.0.1 differ).
                                     Default: serverHttpUrl from
                                     ~/.coforge/daemon/bindings.json, else
                                     http://localhost:8788
    COFORGE_E2E_CENTRIFUGO_ENDPOINT  Default ws://127.0.0.1:8000/connection/websocket

.PARAMETER SkipBuild
  Skip compile/install; only restart (or start) the Scheduled Task.

.PARAMETER NoRestart
  Build and install only; do not restart the Daemon.

.PARAMETER Start
  After install (or with -SkipBuild), run the task without /End first.

.PARAMETER Setup
  After install, run `coforge-computer setup --workspace <slug>`.

.PARAMETER Workspace
  Restart only one Workspace runtime (implies -SkipBuild; uses the CLI).

.PARAMETER ComputerExe
  Override the installed exe path (only with -SkipBuild / -Workspace).

.PARAMETER TaskName
  Scheduled Task name (default: CoForge Daemon).

.EXAMPLE
  .\scripts\restart-windows-daemon.ps1

.EXAMPLE
  .\scripts\restart-windows-daemon.ps1 -SkipBuild

.EXAMPLE
  $env:COFORGE_E2E_WEB_URL = 'http://localhost:8788'
  .\scripts\restart-windows-daemon.ps1 -Setup my-slug
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$NoRestart,
  [switch]$Start,
  [string]$Setup,
  [string]$Workspace,
  [string]$ComputerExe,
  [string]$TaskName = "CoForge Daemon"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
  throw "This script is for Windows only. On Linux use scripts/reload-local-computer.sh"
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Name = "restart-windows-daemon.ps1"

function Invoke-Bun {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$AllowFailure
  )
  $mise = Get-Command mise -ErrorAction SilentlyContinue
  if ($mise) {
    & mise exec -- bun @Arguments
  } else {
    & bun @Arguments
  }
  if (-not $AllowFailure -and $LASTEXITCODE -ne 0) {
    throw "bun $($Arguments -join ' ') failed (exit $LASTEXITCODE)"
  }
  return $LASTEXITCODE
}

function Resolve-CoforgeComputerExe {
  param([string]$Override)
  if ($Override) {
    if (-not (Test-Path -LiteralPath $Override)) {
      throw "coforge-computer.exe not found: $Override"
    }
    return (Resolve-Path -LiteralPath $Override).Path
  }
  $active = Join-Path $env:USERPROFILE ".coforge\computer\install\active\coforge-computer.exe"
  if (Test-Path -LiteralPath $active) {
    return (Resolve-Path -LiteralPath $active).Path
  }
  $cmd = Get-Command coforge-computer.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "Installed Computer not found at: $active"
}

function Get-DefaultWebUrl {
  $bindings = Join-Path $env:USERPROFILE ".coforge\daemon\bindings.json"
  if (Test-Path -LiteralPath $bindings) {
    try {
      $data = Get-Content -LiteralPath $bindings -Raw | ConvertFrom-Json
      if ($data -is [System.Array]) {
        foreach ($binding in $data) {
          if ($binding.serverHttpUrl) { return [string]$binding.serverHttpUrl }
        }
      }
    } catch {
      # fall through to default
    }
  }
  return "http://localhost:8788"
}

function Test-WebHealth([string]$WebUrl) {
  $health = ($WebUrl.TrimEnd("/") + "/health")
  try {
    $response = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Clear-StaleSupervisorLock {
  $owner = Join-Path $env:USERPROFILE ".coforge\daemon\supervisor.lock\owner"
  if (-not (Test-Path -LiteralPath $owner)) { return }
  $pidText = (Get-Content -LiteralPath $owner -Raw -ErrorAction SilentlyContinue).Trim()
  $ownerPid = 0
  if (-not [int]::TryParse($pidText, [ref]$ownerPid) -or $ownerPid -le 0) {
    Remove-Item -Force -LiteralPath $owner -ErrorAction SilentlyContinue
    return
  }
  $alive = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if (-not $alive) {
    Write-Host "==> Clearing stale supervisor.lock owner (dead pid $ownerPid)"
    Remove-Item -Force -LiteralPath $owner -ErrorAction SilentlyContinue
  }
}

function Clear-StrandedLaunchHold {
  $hold = Join-Path $env:USERPROFILE ".coforge\daemon\launch-hold"
  if (-not (Test-Path -LiteralPath $hold)) { return }
  # A prior failed __install-local leaves this UUID without a durable upgrade receipt.
  # The next install's resume then fails on older Coordinators ("no recoverable upgrade owner").
  Write-Host "==> Clearing stranded launch-hold from a previous incomplete upgrade"
  Remove-Item -Force -LiteralPath $hold -ErrorAction SilentlyContinue
  return $true
}

function Clear-StaleUpgradeResults {
  # Completed remote/local upgrade receipts accumulate. Windows Coordinator startup used to
  # schtasks /Delete each one serially (~1s each) before opening local RPC, blowing the ~10s
  # handshake budget. Prune them before __install-local so even an older binary can start.
  $dir = Join-Path $env:USERPROFILE ".coforge\computer\install\upgrade-results"
  if (-not (Test-Path -LiteralPath $dir)) { return $false }
  $files = @(Get-ChildItem -LiteralPath $dir -Filter "*.result.json" -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { return $false }
  Write-Host "==> Removing $($files.Count) stale upgrade-results before Windows reload"
  foreach ($f in $files) {
    Remove-Item -Force -LiteralPath $f.FullName -ErrorAction SilentlyContinue
  }
  return $true
}

function Stop-LocalCoforgeDaemonTree {
  # schtasks /End is not enough on Windows: the Coordinator PID often survives and keeps
  # supervisor.lock, so the next __install-local fails with process-tree shutdown timeout.
  $task = "CoForge Daemon"
  Write-Host "==> Force-stopping local CoForge Daemon tree before install"
  schtasks /End /TN $task 2>$null | Out-Null
  $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'coforge-computer.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '__daemon|__workspace-daemon' })
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
  }
  $owner = Join-Path $env:USERPROFILE ".coforge\daemon\supervisor.lock\owner"
  Remove-Item -Force -LiteralPath $owner -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

function Clear-WorkspaceHealthLatches {
  # Intentional Windows reload/upgrade can stop Workspace children several times inside the
  # 60s crash window. The durable health journal then latches degraded and Coordinator
  # reconcile refuses to start them — which also delays local RPC readiness for this script.
  # Operator reload is allowed to reset that latch; real crash loops still re-trip it.
  $root = Join-Path $env:USERPROFILE ".coforge\daemon\workspaces"
  if (-not (Test-Path -LiteralPath $root)) { return $false }
  $cleared = 0
  foreach ($dir in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
    $health = Join-Path $dir.FullName "health.json"
    if (-not (Test-Path -LiteralPath $health)) { continue }
    try {
      $j = (Get-Content -LiteralPath $health -Raw -ErrorAction Stop) | ConvertFrom-Json
      $crashCount = 0
      if ($j.crashes) { $crashCount = @($j.crashes).Count }
      $needs =
        [bool]$j.live -or
        ($crashCount -gt 0) -or
        ($null -ne $j.PSObject.Properties['degraded'] -and $null -ne $j.degraded) -or
        ($null -ne $j.PSObject.Properties['terminal'] -and $null -ne $j.terminal)
      if (-not $needs) { continue }
      Set-Content -LiteralPath $health -Value '{"schemaVersion":1,"live":false,"crashes":[]}' -NoNewline
      $cleared++
    } catch {
      # Best-effort: a corrupt journal already reads as healthy in Daemon.
    }
  }
  if ($cleared -gt 0) {
    Write-Host "==> Cleared $cleared Workspace health latch(es) before Windows reload"
    return $true
  }
  return $false
}

function Test-SupervisorRpcHealthy {
  param([string]$Exe)
  if (-not (Test-Path -LiteralPath $Exe)) { return $false }
  try {
    # status --json may emit multiple lines; join before parsing under Windows PowerShell 5.1.
    $json = (& $Exe status --json 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $json) { return $false }
    $status = $json | ConvertFrom-Json
    return [bool]$status.supervisor.rpc.reachable
  } catch {
    return $false
  }
}

function Get-DaemonCoordinatorProcess {
  return Get-CimInstance Win32_Process -Filter "Name = 'coforge-computer.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '__daemon' }
}

function Wait-SupervisorRpcHealthy {
  param(
    [string]$Exe,
    [int]$TimeoutSeconds = 45
  )
  $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
  $sawCoordinator = $false
  do {
    if (Test-SupervisorRpcHealthy -Exe $Exe) { return $true }
    $alive = @(Get-DaemonCoordinatorProcess)
    if ($alive.Count -gt 0) {
      $sawCoordinator = $true
    } elseif ($sawCoordinator) {
      # Process appeared then exited before the AF_UNIX RPC handshake was ready.
      return $false
    }
    Start-Sleep -Milliseconds 250
  } while ([datetime]::UtcNow -lt $deadline)
  return $false
}

function Ensure-HealthySupervisorBeforeInstall {
  param([string]$Task)
  $bindingsPath = Join-Path $env:USERPROFILE ".coforge\daemon\bindings.json"
  if (-not (Test-Path -LiteralPath $bindingsPath)) { return }
  $hasEnabled = $false
  try {
    $bindings = Get-Content -LiteralPath $bindingsPath -Raw | ConvertFrom-Json
    if ($bindings -is [System.Array]) {
      foreach ($b in $bindings) {
        if ($b.enabled) { $hasEnabled = $true; break }
      }
    }
  } catch {
    return
  }
  if (-not $hasEnabled) { return }

  Clear-StaleSupervisorLock
  $null = Clear-WorkspaceHealthLatches
  $null = Clear-StaleUpgradeResults
  $clearedHold = [bool](Clear-StrandedLaunchHold)
  $active = Join-Path $env:USERPROFILE ".coforge\computer\install\active\coforge-computer.exe"
  if (-not (Test-Path -LiteralPath $active)) {
    throw @"
$Name`: enabled Workspace bindings exist but no active Computer binary is installed.
  Run setup once, or clear ~/.coforge/daemon/bindings.json before a cold install.
"@
  }

  # Stranded launch-hold means the live Coordinator may still be #paused in memory.
  # -Start alone reuses that process; force End so the next Run loads a clean Coordinator.
  $needRecover = $clearedHold -or -not (Test-SupervisorRpcHealthy -Exe $active)
  if ($needRecover) {
    Write-Host "==> Recovering Computer supervisor before upgrade..."
    Stop-LocalCoforgeDaemonTree
    Install-AndRunDaemonTask -Exe $active -Task $Task -EndFirst
  }

  # schtasks /Run can show __daemon before the AF_UNIX RPC socket accepts handshakes.
  if (-not (Wait-SupervisorRpcHealthy -Exe $active -TimeoutSeconds 45)) {
    $statusHint = (& $active status --json 2>$null | Out-String).Trim()
    throw @"
$Name`: could not recover a healthy supervisor before install.
  Coordinator process started but local RPC (daemon.sock) never became reachable.
  This is not a Web URL failure — check the Coordinator stayed up and the socket binds.
  Check: schtasks /Query /TN '$Task' /V /FO LIST
  Then: & '$active' status --json
  Last status: $statusHint
"@
  }

  # Upgrade snapshot requires every enabled binding to have a live processId.
  $statusJson = (& $active status --json 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -eq 0 -and $statusJson) {
    $status = $statusJson | ConvertFrom-Json
    $needsStart = $false
    foreach ($ws in @($status.workspaces.workspaces)) {
      if ($ws.enabled -and -not $ws.running) { $needsStart = $true; break }
    }
    if ($needsStart) {
      Write-Host "==> Starting enabled Workspace runtimes before upgrade..."
      # Keep CLI stdout off the caller's success pipeline (StrictMode hashtable return).
      & $active start | Out-Host
      if ($LASTEXITCODE -ne 0) {
        throw "$Name`: coforge-computer start failed (exit $LASTEXITCODE) before install"
      }
    }
  }
}

function Get-WindowsTaskUserId {
  $domain = [string]$env:USERDOMAIN
  $user = [string]$env:USERNAME
  if ($domain -and $user) { return "$domain\$user" }
  return [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}

function Escape-Xml([string]$Value) {
  return ($Value -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;')
}

function New-DaemonTaskXml {
  param(
    [string]$UserId,
    [string]$ExecutablePath,
    [string]$SocketPath,
    [string]$StateDirectory
  )
  $uid = Escape-Xml $UserId
  $cmd = Escape-Xml $ExecutablePath
  $argsXml = Escape-Xml "__daemon --socket $SocketPath --state-directory $StateDirectory"
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$uid</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$uid</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$cmd</Command>
      <Arguments>$argsXml</Arguments>
    </Exec>
  </Actions>
</Task>
"@
}

function Invoke-Schtasks {
  param([string[]]$SchtasksArgs)
  $output = & schtasks.exe @SchtasksArgs 2>&1 | Out-String
  return @{ Code = $LASTEXITCODE; Output = $output.Trim() }
}

function Install-AndRunDaemonTask {
  param(
    [string]$Exe,
    [string]$Task,
    [switch]$EndFirst
  )
  $state = Join-Path $env:USERPROFILE ".coforge\daemon"
  $socket = Join-Path $state "daemon.sock"
  $userId = Get-WindowsTaskUserId
  $xml = New-DaemonTaskXml -UserId $userId -ExecutablePath $Exe -SocketPath $socket -StateDirectory $state
  $xmlPath = Join-Path $env:TEMP ("coforge-daemon-task-{0}.xml" -f [guid]::NewGuid().ToString("n"))
  try {
    [System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)

    if ($EndFirst) {
      Write-Host "==> Stopping Scheduled Task '$Task' (if running)..."
      $null = Invoke-Schtasks -SchtasksArgs @("/End", "/TN", $Task)
      $stopDeadline = [datetime]::UtcNow.AddSeconds(15)
      while ([datetime]::UtcNow -lt $stopDeadline) {
        $still = @(Get-DaemonCoordinatorProcess)
        if ($still.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
      }
      # A dead owner / leftover AF_UNIX reparse point blocks the next Coordinator bind on Windows.
      Clear-StaleSupervisorLock
      if (Test-Path -LiteralPath $socket) {
        Write-Host "==> Removing leftover daemon.sock before restart"
        Remove-Item -Force -LiteralPath $socket -ErrorAction SilentlyContinue
      }
    }

    Write-Host "==> Registering Scheduled Task '$Task' (XML LogonTrigger)..."
    $created = Invoke-Schtasks -SchtasksArgs @("/Create", "/TN", $Task, "/XML", $xmlPath, "/F")
    if ($created.Code -ne 0) {
      throw "schtasks /Create failed (exit $($created.Code)): $($created.Output)"
    }

    Write-Host "==> Running Scheduled Task '$Task'..."
    $started = Invoke-Schtasks -SchtasksArgs @("/Run", "/TN", $Task)
    if ($started.Code -ne 0) {
      throw "schtasks /Run failed (exit $($started.Code)): $($started.Output)"
    }
  } finally {
    Remove-Item -LiteralPath $xmlPath -Force -ErrorAction SilentlyContinue
  }

  $deadline = [datetime]::UtcNow.AddSeconds(20)
  do {
    $proc = Get-DaemonCoordinatorProcess | Select-Object -First 1
    if ($proc) {
      Write-Host "Coordinator is up (pid $($proc.ProcessId))."
      return
    }
    Start-Sleep -Milliseconds 250
  } while ([datetime]::UtcNow -lt $deadline)

  throw "Scheduled Task started but __daemon did not appear within 20s. Check '$state' logs."
}

function Build-AndInstallFixture {
  $webUrl = if ($env:COFORGE_E2E_WEB_URL) { $env:COFORGE_E2E_WEB_URL } else { Get-DefaultWebUrl }
  $centrifugo = if ($env:COFORGE_E2E_CENTRIFUGO_ENDPOINT) {
    $env:COFORGE_E2E_CENTRIFUGO_ENDPOINT
  } else {
    "ws://127.0.0.1:8000/connection/websocket"
  }
  $env:COFORGE_E2E_WEB_URL = $webUrl
  $env:COFORGE_E2E_CENTRIFUGO_ENDPOINT = $centrifugo

  if (-not (Test-WebHealth $webUrl)) {
    throw @"
$Name`: Web backend is not reachable at $webUrl
  Start it with scripts/start-server.sh (after scripts/build-prod.sh), or set
  COFORGE_E2E_WEB_URL to the origin your Daemon bindings already use.
"@
  }

  Push-Location $Root
  try {
    $sdk = Join-Path $Root "packages\coforge-sdk"
    $zodCode = Invoke-Bun -AllowFailure -Arguments @(
      "-e", "Bun.resolveSync('zod', Bun.argv[1])", $sdk
    ) 1>$null 2>$null
    if ($zodCode -ne 0) {
      Write-Host "==> Restoring workspace deps (zod link missing under coforge-sdk)"
      Invoke-Bun -Arguments @("install") | Out-Null
    }

    Write-Host "==> Generating protocol"
    Invoke-Bun -Arguments @("run", "--cwd", $sdk, "generate") | Out-Null

    Write-Host "==> Building local Computer/Daemon fixture"
    Write-Host "    web=$webUrl"
    Write-Host "    centrifugo=$centrifugo"
    Invoke-Bun -Arguments @((Join-Path $Root "scripts\e2e\build-computer-fixture.ts")) | Out-Null

    $fixtureBin = Join-Path $Root ".amp\e2e\bin\coforge-computer.exe"
    if (-not (Test-Path -LiteralPath $fixtureBin)) {
      $alt = Join-Path $Root ".amp\e2e\bin\coforge-computer"
      if (Test-Path -LiteralPath $alt) { $fixtureBin = $alt }
    }
    $packageDir = Join-Path $Root ".amp\e2e\native-package"
    $manifest = Join-Path $packageDir "manifest.json"
    if (-not (Test-Path -LiteralPath $fixtureBin) -or -not (Test-Path -LiteralPath $manifest)) {
      throw "$Name`: fixture build did not produce $fixtureBin and $manifest"
    }

    $version = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version
    # Drop leftover upgrade receipts / holds before the Coordinator is asked to upgrade itself.
    $null = Clear-StaleUpgradeResults
    $null = Clear-StrandedLaunchHold
    $null = Clear-WorkspaceHealthLatches
    # __install-local upgrades through the Coordinator when bindings exist; a dead
    # supervisor.lock or stopped task fails with "no healthy supervisor".
    Ensure-HealthySupervisorBeforeInstall -Task $TaskName
    Write-Host "==> Installing local package version $version"
    # __install-local prints progress on stdout; Out-Host keeps it visible without
    # polluting this function's return value under Set-StrictMode.
    & $fixtureBin __install-local --version $version --directory $packageDir | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw @"
$Name`: local install failed (exit $LASTEXITCODE).
  Common Windows causes (not Web URL):
    - old supervisor did not confirm process-tree shutdown (schtasks /End left Coordinator up)
    - local handshake timeout (leftover CoForge Upgrade tasks / upgrade-results)
  Check: schtasks /Query /TN 'CoForge Daemon' /V /FO LIST
  Then: & '$env:USERPROFILE\.coforge\computer\install\active\coforge-computer.exe' status --json
  Current COFORGE_E2E_WEB_URL=$webUrl
  Bound URLs: $env:USERPROFILE\.coforge\daemon\bindings.json
"@
    }

    $active = Join-Path $env:USERPROFILE ".coforge\computer\install\active\coforge-computer.exe"
    if (-not (Test-Path -LiteralPath $active)) {
      throw "$Name`: install did not produce $active"
    }

    if ($Setup) {
      Write-Host "==> Running Computer setup for workspace '$Setup'"
      & $active setup --workspace $Setup --json | Out-Host
      if ($LASTEXITCODE -ne 0) {
        throw "setup failed (exit $LASTEXITCODE)"
      }
    }

    return @{ Exe = $active; Version = $version; WebUrl = $webUrl }
  } finally {
    Pop-Location
  }
}

# --- main ---

if ($Workspace -and ($Start -or $Setup)) {
  throw "-Workspace cannot be combined with -Start or -Setup."
}
if ($Workspace) {
  $exe = Resolve-CoforgeComputerExe -Override $ComputerExe
  Write-Host "Using: $exe"
  Write-Host "Restarting Workspace runtime: $Workspace"
  & $exe restart --workspace $Workspace
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host "Done."
  exit 0
}
if ($SkipBuild -and $Setup) {
  throw "-Setup requires a build/install pass; omit -SkipBuild."
}
if ($NoRestart -and $Start) {
  throw "-NoRestart and -Start cannot be combined."
}

$installed = $null
if (-not $SkipBuild) {
  $installed = Build-AndInstallFixture
  Write-Host "Installed: $($installed.Exe) ($($installed.Version))"
}

if ($NoRestart) {
  Write-Host ""
  Write-Host "Local Computer/Daemon installed (restart skipped)."
  Write-Host "  binary:  $($installed.Exe)"
  Write-Host "  version: $($installed.Version)"
  exit 0
}

$exe = if ($installed) { $installed.Exe } else { Resolve-CoforgeComputerExe -Override $ComputerExe }
Write-Host "Using: $exe"

# Reset crash-loop latches before /End so the replacement Coordinator does not refuse starts.
$null = Clear-WorkspaceHealthLatches

if ($Start) {
  Write-Host "==> Starting Computer supervisor (Coordinator)..."
  Install-AndRunDaemonTask -Exe $exe -Task $TaskName
} else {
  Write-Host "==> Restarting Computer supervisor (Coordinator)..."
  Install-AndRunDaemonTask -Exe $exe -Task $TaskName -EndFirst
}

# schtasks only brings up the Coordinator. Workspace WSS children are separate processes;
# without an explicit start (or waiting for reconcile) the Web UI stays offline after /End.
Clear-StaleSupervisorLock
$null = Clear-WorkspaceHealthLatches
if (-not (Wait-SupervisorRpcHealthy -Exe $exe -TimeoutSeconds 60)) {
  $statusHint = (& $exe status --json 2>$null | Out-String).Trim()
  throw @"
$Name`: Coordinator process started but local RPC never became reachable.
  Check: schtasks /Query /TN '$TaskName' /V /FO LIST
  Then: & '$exe' status --json
  Last status: $statusHint
"@
}

Write-Host "==> Restarting Workspace runtimes (clears any remaining health latch)..."
& $exe restart | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "$Name`: coforge-computer restart failed (exit $LASTEXITCODE) after supervisor restart"
}

Write-Host ""
Write-Host "Local Computer/Daemon reloaded."
Write-Host "  binary:  $exe"
if ($installed) {
  Write-Host "  version: $($installed.Version)"
  Write-Host "  web:     $($installed.WebUrl)"
}
Write-Host "  logs:    ~/.coforge/daemon/workspaces/*/logs/daemon/daemon.jsonl"
