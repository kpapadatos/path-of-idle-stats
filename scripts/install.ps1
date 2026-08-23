[CmdletBinding()]
param(
    [string]$GameDirectory = 'C:\Program Files (x86)\Steam\steamapps\common\PathOfIdle'
)

$ErrorActionPreference = 'Stop'
$ProjectDirectory = Split-Path -Parent $PSScriptRoot
$StagingDirectory = Join-Path $ProjectDirectory 'work\bepinex'
$PluginPath = Join-Path $ProjectDirectory 'plugin\bin\Release\net6.0\PathOfIdleStats.dll'
$ManifestPath = Join-Path $ProjectDirectory 'install-manifest.json'

if (Get-Process -Name PathOfIdle -ErrorAction SilentlyContinue) {
    throw 'Path of Idle is running. Close it normally before installing.'
}
if (-not (Test-Path -LiteralPath (Join-Path $GameDirectory 'PathOfIdle.exe'))) {
    throw "Game executable not found in $GameDirectory"
}
if (-not (Test-Path -LiteralPath $StagingDirectory)) {
    throw 'Verified BepInEx staging directory is missing.'
}
if (-not (Test-Path -LiteralPath $PluginPath)) {
    throw 'The telemetry plugin has not been built.'
}
if (Test-Path -LiteralPath $ManifestPath) {
    throw 'An install manifest already exists. Uninstall the existing deployment first.'
}

$introduced = [System.Collections.Generic.List[string]]::new()
$replaced = [System.Collections.Generic.List[object]]::new()
$backupDirectory = Join-Path $ProjectDirectory ('work\backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Install-File([string]$Source, [string]$RelativePath) {
    $destination = Join-Path $GameDirectory $RelativePath
    if (Test-Path -LiteralPath $destination) {
        $backup = Join-Path $backupDirectory $RelativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
        Copy-Item -LiteralPath $destination -Destination $backup
        $replaced.Add([ordered]@{ path = $RelativePath; backup = $backup })
    } else {
        $introduced.Add($RelativePath)
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $destination -Force
}

Get-ChildItem -LiteralPath $StagingDirectory -Recurse -File | ForEach-Object {
    $relative = [IO.Path]::GetRelativePath($StagingDirectory, $_.FullName)
    Install-File $_.FullName $relative
}
Install-File $PluginPath 'BepInEx\plugins\PathOfIdleStats.dll'

[ordered]@{
    createdAt = (Get-Date).ToString('o')
    gameDirectory = $GameDirectory
    introduced = @($introduced)
    replaced = @($replaced)
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ManifestPath -Encoding utf8

Write-Host 'BepInEx and PathOfIdleStats installed. Start the game normally through Steam.'

