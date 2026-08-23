[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectDirectory = Split-Path -Parent $PSScriptRoot
$ManifestPath = Join-Path $ProjectDirectory 'install-manifest.json'

if (Get-Process -Name PathOfIdle -ErrorAction SilentlyContinue) {
    throw 'Path of Idle is running. Close it normally before uninstalling.'
}
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw 'No install manifest exists; nothing will be removed.'
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$gameDirectory = [string]$manifest.gameDirectory

foreach ($relativePath in $manifest.introduced) {
    $target = [IO.Path]::GetFullPath((Join-Path $gameDirectory ([string]$relativePath)))
    if (-not $target.StartsWith(([IO.Path]::GetFullPath($gameDirectory) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe manifest path: $relativePath"
    }
    if (Test-Path -LiteralPath $target -PathType Leaf) {
        Remove-Item -LiteralPath $target -Force
    }
}

foreach ($entry in $manifest.replaced) {
    $target = Join-Path $gameDirectory ([string]$entry.path)
    Copy-Item -LiteralPath ([string]$entry.backup) -Destination $target -Force
}

Remove-Item -LiteralPath $ManifestPath -Force
Write-Host 'Recorded mod files removed and pre-existing files restored. Save data was untouched.'

