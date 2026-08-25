[CmdletBinding()]
param(
    [switch]$InstallOnly,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProjectDirectory = Split-Path -Parent $PSScriptRoot
$NodeExecutable = Join-Path $ProjectDirectory 'vendor\node\node.exe'
$ServerEntry = Join-Path $ProjectDirectory 'server\server.mjs'
$DashboardUrl = 'http://127.0.0.1:43127/'
$serverProcess = $null

. (Join-Path $PSScriptRoot 'find-game.ps1')

try {
    $gameDirectory = Find-PathOfIdleGameDirectory
    Write-Host "Found Path of Idle: $gameDirectory"

    & (Join-Path $PSScriptRoot 'install.ps1') -GameDirectory $gameDirectory
    if ($InstallOnly) { return }

    if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
        throw 'The bundled Node runtime is missing. Download a complete release/archive of this repository.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDirectory 'dist\dashboard\browser\index.html') -PathType Leaf)) {
        throw 'The bundled dashboard build is missing. Download a complete release/archive of this repository.'
    }

    $alreadyRunning = $false
    $portHasOlderStatsServer = $false
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:43127/api/health' -TimeoutSec 2
        $appProperty = $health.PSObject.Properties['app']
        $appName = if ($null -ne $appProperty) { [string]$appProperty.Value } else { '' }
        $alreadyRunning = $health.ok -eq $true -and $appName -eq 'path-of-idle-stats'
        $portHasOlderStatsServer = $health.ok -eq $true -and -not $appName
    } catch { }

    if ($alreadyRunning) {
        Write-Host "Path of Idle Stats is already running at $DashboardUrl"
        if (-not $NoBrowser) { Start-Process $DashboardUrl }
        return
    }
    if ($portHasOlderStatsServer) {
        throw 'An older Path of Idle Stats server is already running. Close its terminal window, then run start.bat again.'
    }

    $env:PATH_OF_IDLE_GAME_DIR = $gameDirectory
    $serverProcess = Start-Process -FilePath $NodeExecutable -ArgumentList @('--no-warnings', ('"' + $ServerEntry + '"')) -WorkingDirectory $ProjectDirectory -NoNewWindow -PassThru
    try {
        $ready = $false
        for ($attempt = 0; $attempt -lt 40 -and -not $serverProcess.HasExited; $attempt++) {
            Start-Sleep -Milliseconds 250
            try {
                $health = Invoke-RestMethod -Uri 'http://127.0.0.1:43127/api/health' -TimeoutSec 1
                if ($health.ok -eq $true -and $health.app -eq 'path-of-idle-stats') { $ready = $true; break }
            } catch { }
        }
        if (-not $ready) {
            if ($serverProcess.HasExited) { throw "Dashboard server exited with code $($serverProcess.ExitCode)." }
            throw 'Dashboard server did not become ready within 10 seconds.'
        }

        if (-not $NoBrowser) { Start-Process $DashboardUrl }
        Write-Host 'Leave this window open while using the dashboard. Press Ctrl+C to stop it.'
        while (-not $serverProcess.HasExited) { Start-Sleep -Seconds 1 }
        if ($serverProcess.ExitCode -ne 0) { throw "Dashboard server exited with code $($serverProcess.ExitCode)." }
    } finally {
        if ($serverProcess -and -not $serverProcess.HasExited) {
            Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
} catch {
    Write-Host ''
    Write-Host "Path of Idle Stats could not start: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'No save files were read or changed.' -ForegroundColor Yellow
    if ($Host.Name -eq 'ConsoleHost') {
        Write-Host ''
        Read-Host 'Press Enter to close'
    }
    exit 1
}
