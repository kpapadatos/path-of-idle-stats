[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectDirectory = Split-Path -Parent $PSScriptRoot
$ManifestPath = Join-Path $ProjectDirectory 'install-manifest.json'
$builtSource = 'C:\Users\ances\Documents\Codex\2026-08-23\pat\work\plugin-build\PathOfIdleStats.dll'
$Source = if (Test-Path -LiteralPath $builtSource) { $builtSource } else { Join-Path $ProjectDirectory 'plugin\bin\Release\net6.0\PathOfIdleStats.dll' }

if (Get-Process -Name PathOfIdle -ErrorAction SilentlyContinue) {
    throw 'Path of Idle is running. Close it normally before updating the plugin.'
}
if (-not (Test-Path -LiteralPath $ManifestPath)) { throw 'Install manifest is missing.' }
if (-not (Test-Path -LiteralPath $Source)) { throw 'Built plugin is missing.' }

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$relative = 'BepInEx\plugins\PathOfIdleStats.dll'
if ($relative -notin @($manifest.introduced)) { throw 'The plugin is not recorded as an introduced file; refusing to overwrite it.' }
$Destination = Join-Path ([string]$manifest.gameDirectory) $relative
if (-not (Test-Path -LiteralPath $Destination)) { throw 'Installed plugin is missing.' }

$backupDirectory = Join-Path $ProjectDirectory 'work\plugin-backups'
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
$oldHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
$backup = Join-Path $backupDirectory ("PathOfIdleStats-$oldHash.dll")
if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $Destination -Destination $backup }
Copy-Item -LiteralPath $Source -Destination $Destination -Force
$newHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
$sourceHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
if ($newHash -ne $sourceHash) { throw 'Installed plugin hash does not match the build.' }

Write-Host "Plugin updated: $oldHash -> $newHash"
