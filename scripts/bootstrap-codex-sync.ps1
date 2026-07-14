param(
  [Parameter(Mandatory = $true)][string]$Vault,
  [string]$Device = $env:COMPUTERNAME,
  [ValidateSet('folder', 'git')][string]$Transport = 'folder',
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }),
  [string]$Config = $(Join-Path $HOME '.codex-sync\config.json'),
  [switch]$InstallDaemon,
  [int]$Minutes = 5
)

$ErrorActionPreference = 'Stop'
$Vault = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Vault))
$source = Join-Path $Vault 'skills\codex\codex-sync'
$destination = Join-Path $CodexHome 'skills\codex-sync'

if (-not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md'))) {
  throw "Codex Sync skill was not found in vault: $source"
}

$node = Get-Command node -ErrorAction Stop
$major = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw 'Codex Sync requires Node.js 22 or newer.' }

New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $destination -Recurse -Force

$cli = Join-Path $destination 'scripts\codexsync.mjs'
if (-not (Test-Path -LiteralPath $Config)) {
  & $node.Source --no-warnings $cli init --vault $Vault --transport $Transport --device $Device --codex-home $CodexHome --config $Config
} else {
  & $node.Source --no-warnings $cli vault use --vault $Vault --transport $Transport --config $Config --no-sync
}
$maintenance = Test-Path -LiteralPath (Join-Path $Vault '.codex-sync\maintenance.json')
if ($maintenance) {
  Write-Output 'Codex Sync maintenance mode detected; performing controlled pull and head refresh without enabling the scheduler.'
  & $node.Source --no-warnings $cli pull --force --config $Config
  & $node.Source --no-warnings $cli sync --force --config $Config
} else {
  & $node.Source --no-warnings $cli sync --config $Config
}
if ($InstallDaemon -and -not $maintenance) {
  & $node.Source --no-warnings $cli daemon install --minutes $Minutes --config $Config
} elseif ($InstallDaemon) {
  Write-Warning 'Scheduler installation was deferred until fleet maintenance is disabled.'
}
& $node.Source --no-warnings $cli device report --config $Config
& $node.Source --no-warnings $cli doctor --config $Config
