[CmdletBinding()]
param(
  [switch]$Repair,
  [switch]$TestHttps,
  [string]$TestUrl = 'https://github.com/git/git.git'
)

$ErrorActionPreference = 'Stop'
$result = [ordered]@{
  timestamp = (Get-Date).ToUniversalTime().ToString('o')
  computer = $env:COMPUTERNAME
  repairRequested = [bool]$Repair
  httpsTestRequested = [bool]$TestHttps
  codexSync = $null
  gitBefore = @()
  gitAfter = @()
  backup = $null
  wingetExitCode = $null
  httpsTest = $null
  recentApplicationErrors = @()
  warnings = @()
}

$codexSyncConfig = Join-Path $HOME '.codex-sync\config.json'
if (Test-Path -LiteralPath $codexSyncConfig) {
  try {
    $config = Get-Content -Raw -LiteralPath $codexSyncConfig | ConvertFrom-Json
    $result.codexSync = [ordered]@{ deviceId = $config.deviceId; transport = $config.transport; vault = $config.vault }
    if ($config.transport -ne 'git') {
      $result.warnings += 'Codex Sync does not use Git in the current transport mode; this repair targets another Git workflow.'
    }
  } catch {
    $result.warnings += "Could not parse Codex Sync config: $($_.Exception.Message)"
  }
}

function Get-GitInventory {
  $commands = @(Get-Command git -All -ErrorAction SilentlyContinue)
  return @($commands | ForEach-Object {
    [ordered]@{
      source = $_.Source
      version = $_.Version.ToString()
    }
  })
}

$result.gitBefore = @(Get-GitInventory)

if ($Repair) {
  Get-Process git, git-remote-https, git-remote-http -ErrorAction SilentlyContinue |
    Stop-Process -Force

  Start-Sleep -Seconds 2
  $respawned = @(Get-Process git, git-remote-https, git-remote-http -ErrorAction SilentlyContinue)
  if ($respawned.Count -gt 0) {
    $details = ($respawned | ForEach-Object { "$($_.ProcessName) PID $($_.Id)" }) -join ', '
    throw "Git processes were restarted by an open host ($details). Close Codex, GitHub Desktop, VS Code, and other Git clients, then rerun this command from standalone PowerShell."
  }

  $gitConfig = Join-Path $HOME '.gitconfig'
  if (Test-Path -LiteralPath $gitConfig) {
    $backup = "$gitConfig.codex-sync-backup-$(Get-Date -Format yyyyMMddHHmmss)"
    Copy-Item -LiteralPath $gitConfig -Destination $backup
    $result.backup = $backup
  }

  $winget = Get-Command winget -ErrorAction Stop
  & $winget.Source source update
  & $winget.Source install --id Git.Git --exact --source winget --force `
    --accept-package-agreements --accept-source-agreements
  $result.wingetExitCode = $LASTEXITCODE
  if ($LASTEXITCODE -ne 0) {
    throw "winget Git repair failed with exit code $LASTEXITCODE. Close every Git client and inspect the winget installer log."
  }

  Remove-Item Alias:git -ErrorAction SilentlyContinue
  $result.gitAfter = @(Get-GitInventory)
}

if (-not $Repair) {
  $result.gitAfter = $result.gitBefore
}

if ($TestHttps) {
  $git = Get-Command git -ErrorAction Stop
  $output = @(& $git.Source -c http.proxy= -c http.sslBackend=schannel `
    ls-remote $TestUrl HEAD 2>&1)
  $exitCode = $LASTEXITCODE
  $result.httpsTest = [ordered]@{
    url = $TestUrl
    exitCode = $exitCode
    output = @($output | ForEach-Object { $_.ToString() })
    ok = ($exitCode -eq 0 -and ($output -join "`n") -match '\sHEAD$')
  }
}

try {
  $events = Get-WinEvent -FilterHashtable @{
    LogName = 'Application'
    StartTime = (Get-Date).AddHours(-2)
    Level = 2
  } -ErrorAction SilentlyContinue | Where-Object {
    $_.Message -match 'git-remote-https|git\.exe|libcurl|msys-2\.0'
  } | Select-Object -First 5
  $result.recentApplicationErrors = @($events | ForEach-Object {
    [ordered]@{
      timeCreated = $_.TimeCreated.ToUniversalTime().ToString('o')
      id = $_.Id
      provider = $_.ProviderName
      message = $_.Message
    }
  })
} catch {
  $result.warnings += "Could not read Application events: $($_.Exception.Message)"
}

$result | ConvertTo-Json -Depth 8

if ($result.httpsTest -and -not $result.httpsTest.ok) {
  exit 2
}
