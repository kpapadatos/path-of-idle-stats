[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GameDirectory,
    [string]$ManifestPath,
    [string]$BackupDirectory
)

$ErrorActionPreference = 'Stop'
$ProjectDirectory = Split-Path -Parent $PSScriptRoot
$BepInExPayload = Join-Path $ProjectDirectory 'vendor\bepinex'
$PluginSource = Join-Path $ProjectDirectory 'release\PathOfIdleStats.dll'
$PluginRelativePath = 'BepInEx\plugins\PathOfIdleStats.dll'
$PluginDestination = Join-Path $GameDirectory $PluginRelativePath
if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $ManifestPath = Join-Path $ProjectDirectory 'install-manifest.json' }
if ([string]::IsNullOrWhiteSpace($BackupDirectory)) { $BackupDirectory = Join-Path $ProjectDirectory 'data\plugin-backups' }
$GameExecutable = Join-Path $GameDirectory 'PathOfIdle.exe'

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

if (-not (Test-Path -LiteralPath $GameExecutable -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $GameDirectory 'GameAssembly.dll') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $GameDirectory 'PathOfIdle_Data') -PathType Container)) {
    throw "The detected directory is not a verified Path of Idle installation: $GameDirectory"
}
if (-not (Test-Path -LiteralPath (Join-Path $BepInExPayload 'BepInEx\core\BepInEx.Unity.IL2CPP.dll') -PathType Leaf)) {
    throw 'The bundled BepInEx payload is incomplete.'
}
if (-not (Test-Path -LiteralPath $PluginSource -PathType Leaf)) {
    throw 'The bundled PathOfIdleStats plugin is missing.'
}

$bepInExCore = Join-Path $GameDirectory 'BepInEx\core\BepInEx.Unity.IL2CPP.dll'
$doorstopLoader = Join-Path $GameDirectory 'winhttp.dll'
$hasBepInExCore = Test-Path -LiteralPath $bepInExCore -PathType Leaf
$hasDoorstopLoader = Test-Path -LiteralPath $doorstopLoader -PathType Leaf
$freshBepInExInstall = -not $hasBepInExCore -and -not $hasDoorstopLoader
if ($hasBepInExCore -xor $hasDoorstopLoader) {
    throw 'A partial BepInEx installation already exists. Nothing was changed; repair or remove that installation before retrying.'
}
if ($hasBepInExCore -and (
    (Get-FileSha256 $bepInExCore) -ne (Get-FileSha256 (Join-Path $BepInExPayload 'BepInEx\core\BepInEx.Unity.IL2CPP.dll')) -or
    (Get-FileSha256 $doorstopLoader) -ne (Get-FileSha256 (Join-Path $BepInExPayload 'winhttp.dll')))) {
    throw 'A different BepInEx build is already installed. It was left unchanged; use the pinned IL2CPP x64 build documented by this project.'
}

$pluginNeedsInstall = -not (Test-Path -LiteralPath $PluginDestination -PathType Leaf) -or
    (Get-FileSha256 $PluginDestination) -ne (Get-FileSha256 $PluginSource)
$gameIsRunning = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $GameExecutable, [StringComparison]::OrdinalIgnoreCase)
}).Count -gt 0

if (($freshBepInExInstall -or $pluginNeedsInstall) -and $gameIsRunning) {
    throw 'Path of Idle must be closed for first installation or a plugin update. Close the game normally, then run start.bat again.'
}

$introduced = [System.Collections.Generic.List[string]]::new()
$replaced = [System.Collections.Generic.List[object]]::new()
$existingManifest = $null
if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
    try { $existingManifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json }
    catch { throw 'The existing install manifest is invalid; refusing to make installation changes.' }
    if ($existingManifest.gameDirectory -and
        -not [string]::Equals([IO.Path]::GetFullPath([string]$existingManifest.gameDirectory), [IO.Path]::GetFullPath($GameDirectory), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The install manifest belongs to a different game directory; refusing to make installation changes.'
    }
    foreach ($path in @($existingManifest.introduced)) { if ($path) { $introduced.Add([string]$path) } }
    foreach ($entry in @($existingManifest.replaced)) { if ($entry) { $replaced.Add($entry) } }
}

if ($freshBepInExInstall) {
    # Preflight every destination before copying. An unexpected collision aborts
    # the entire installation, preventing a mixed or partially overwritten loader.
    $payloadFiles = @(Get-ChildItem -LiteralPath $BepInExPayload -Recurse -File)
    $payloadRoot = [IO.Path]::GetFullPath($BepInExPayload).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    foreach ($source in $payloadFiles) {
        if (-not $source.FullName.StartsWith($payloadRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe bundled BepInEx path.' }
        $relative = $source.FullName.Substring($payloadRoot.Length)
        $destination = Join-Path $GameDirectory $relative
        if ((Test-Path -LiteralPath $destination -PathType Leaf) -and
            (Get-FileSha256 $destination) -ne (Get-FileSha256 $source.FullName)) {
            throw "Installation stopped because an unrelated file already exists: $relative"
        }
    }
    foreach ($source in $payloadFiles) {
        $relative = $source.FullName.Substring($payloadRoot.Length)
        $destination = Join-Path $GameDirectory $relative
        if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $source.FullName -Destination $destination
            if ($relative -notin $introduced) { $introduced.Add($relative) }
        }
    }
    Write-Host 'Installed the bundled BepInEx runtime.'
} else {
    Write-Host 'Compatible BepInEx installation detected; existing BepInEx files were left unchanged.'
}

if ($pluginNeedsInstall) {
    if (Test-Path -LiteralPath $PluginDestination -PathType Leaf) {
        New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
        $oldHash = Get-FileSha256 $PluginDestination
        $backup = Join-Path $BackupDirectory "PathOfIdleStats-$oldHash.dll"
        if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
            Copy-Item -LiteralPath $PluginDestination -Destination $backup
        }
        if ($PluginRelativePath -notin $introduced -and
            -not @($replaced | Where-Object { [string]$_.path -eq $PluginRelativePath }).Count) {
            $replaced.Add([ordered]@{ path = $PluginRelativePath; backup = $backup })
        }
    } else {
        if ($PluginRelativePath -notin $introduced) { $introduced.Add($PluginRelativePath) }
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $PluginDestination) -Force | Out-Null
    Copy-Item -LiteralPath $PluginSource -Destination $PluginDestination -Force
    if ((Get-FileSha256 $PluginDestination) -ne (Get-FileSha256 $PluginSource)) {
        throw 'The installed plugin failed hash verification.'
    }
    Write-Host 'Installed the bundled Path of Idle Stats plugin.'
} else {
    Write-Host 'Path of Idle Stats plugin is already current.'
}

[ordered]@{
    schemaVersion = 2
    updatedAt = (Get-Date).ToString('o')
    gameDirectory = [IO.Path]::GetFullPath($GameDirectory)
    steamAppId = 4243990
    pluginHash = Get-FileSha256 $PluginSource
    introduced = @($introduced | Select-Object -Unique)
    replaced = @($replaced)
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ManifestPath -Encoding utf8

Write-Host 'Installation is ready. No save files were read or changed.'
