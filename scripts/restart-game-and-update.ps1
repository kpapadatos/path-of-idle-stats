[CmdletBinding()]
param(
    [string]$GameDirectory = 'C:\Program Files (x86)\Steam\steamapps\common\PathOfIdle',
    [string]$SteamDirectory = 'C:\Program Files (x86)\Steam',
    [int]$SteamAppId = 4243990,
    [int]$CloseTimeoutSeconds = 30,
    [int]$LaunchTimeoutSeconds = 60,
    [int]$ContinueTimeoutSeconds = 90,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ProjectDirectory = Split-Path -Parent $PSScriptRoot
$GameExecutable = Join-Path $GameDirectory 'PathOfIdle.exe'
$SteamManifest = Join-Path $SteamDirectory "steamapps\appmanifest_$SteamAppId.acf"
$BuildScript = Join-Path $PSScriptRoot 'build-plugin.ps1'
$UpdateScript = Join-Path $PSScriptRoot 'update-plugin.ps1'
$ConfigureBepInExScript = Join-Path $PSScriptRoot 'configure-bepinex.ps1'
$BuiltPlugin = Join-Path $ProjectDirectory 'plugin\bin\Release\net6.0\PathOfIdleStats.dll'
$InstalledPlugin = Join-Path $GameDirectory 'BepInEx\plugins\PathOfIdleStats.dll'
$TelemetryDirectory = Join-Path $GameDirectory 'BepInEx\PathOfIdleStats'
$ContinueRequest = Join-Path $TelemetryDirectory 'continue.request'
$ContinueReady = Join-Path $TelemetryDirectory 'continue.ready'
$ContinuePositioned = Join-Path $TelemetryDirectory 'continue.positioned'
$AutoRequest = Join-Path $TelemetryDirectory 'auto.request'
$AutoComplete = Join-Path $TelemetryDirectory 'auto.complete'
$CodexRequest = Join-Path $TelemetryDirectory 'codex.request'

# Safety model:
# - This script never reads, writes, copies, or deletes a Path of Idle save file.
# - The game receives a normal window-close request. There is deliberately no
#   force-kill fallback, because terminating Unity during a save is not worth the risk.
# - update-plugin.ps1 is still the authority for installation: it checks the install
#   manifest, keeps a hash-addressed backup, and refuses to run while the game exists.
# - Request files are tiny IPC markers in the mod's own BepInEx data folder.
# - "Continue game" is not clicked by screen coordinates. Plugin.cs waits for the
#   active MainScene and invokes the exact OnContinueBtnClick handler wired by the game.
# - Window placement uses the Win32 window handle only after that button exists. The
#   script restores the window and fits its outer bounds to the right half of the
#   monitor work area (so it respects the taskbar); it never changes display settings.

if (-not (Test-Path -LiteralPath $GameExecutable)) {
    throw "Game executable not found: $GameExecutable"
}
if (-not (Test-Path -LiteralPath $SteamManifest)) {
    throw "Steam manifest for app $SteamAppId was not found: $SteamManifest"
}
$manifestText = Get-Content -Raw -LiteralPath $SteamManifest
if ($manifestText -notmatch '"installdir"\s+"PathOfIdle"') {
    throw "Steam app $SteamAppId does not identify the expected PathOfIdle installation."
}

# Build first so a compile failure leaves the currently running game untouched.
if (-not $SkipBuild) {
    & $BuildScript
    if ($LASTEXITCODE -ne 0) { throw "Plugin build failed with exit code $LASTEXITCODE." }
}
if (-not (Test-Path -LiteralPath $BuiltPlugin)) { throw 'Built plugin DLL is missing.' }

$gameProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $GameExecutable, [StringComparison]::OrdinalIgnoreCase)
})
if ($gameProcesses.Count -gt 1) { throw 'More than one exact Path of Idle process is running; refusing to guess.' }

if ($gameProcesses.Count -eq 1) {
    $gameProcess = [Diagnostics.Process]::GetProcessById([int]$gameProcesses[0].ProcessId)
    Write-Host "Requesting a normal close from Path of Idle (PID $($gameProcess.Id))..."
    if (-not $gameProcess.CloseMainWindow()) {
        throw 'Path of Idle did not accept a normal window-close request. It was not force-killed.'
    }
    if (-not $gameProcess.WaitForExit($CloseTimeoutSeconds * 1000)) {
        throw "Path of Idle did not close within $CloseTimeoutSeconds seconds. It was not force-killed."
    }
}

# Wait for UnityCrashHandler64.exe to follow the game out naturally. The updater only
# needs PathOfIdle.exe gone, but waiting for all processes rooted in the exact game
# directory makes the install boundary explicit and easy to audit.
$helperDeadline = (Get-Date).AddSeconds(10)
do {
    $remaining = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($GameDirectory, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $helperDeadline)
if ($remaining.Count -gt 0) { throw 'A game helper process is still running; the plugin was not updated.' }

& $ConfigureBepInExScript -GameDirectory $GameDirectory
& $UpdateScript
if (-not (Test-Path -LiteralPath $InstalledPlugin)) { throw 'Installed plugin DLL is missing after update.' }
$builtHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $BuiltPlugin).Hash
$installedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $InstalledPlugin).Hash
if ($builtHash -ne $installedHash) { throw 'Installed plugin hash does not match the repository build.' }

# Queue both actions before launch. The plugin keeps codex.request in place until a
# real save is loaded, so a main-menu placeholder snapshot cannot consume it.
New-Item -ItemType Directory -Path $TelemetryDirectory -Force | Out-Null
Remove-Item -LiteralPath $ContinueReady -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $ContinuePositioned -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $AutoComplete -Force -ErrorAction SilentlyContinue
[IO.File]::WriteAllText($ContinueRequest, (Get-Date).ToString('O'))
[IO.File]::WriteAllText($AutoRequest, (Get-Date).ToString('O'))
[IO.File]::WriteAllText($CodexRequest, (Get-Date).ToString('O'))

Write-Host "Launching Path of Idle through Steam app $SteamAppId..."
Start-Process "steam://rungameid/$SteamAppId"

$launchDeadline = (Get-Date).AddSeconds($LaunchTimeoutSeconds)
do {
    $launched = Get-CimInstance Win32_Process -Filter "Name = 'PathOfIdle.exe'" -ErrorAction SilentlyContinue |
        Where-Object { [string]::Equals($_.ExecutablePath, $GameExecutable, [StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -First 1
    if ($launched) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $launchDeadline)
if (-not $launched) { throw "Steam did not launch Path of Idle within $LaunchTimeoutSeconds seconds." }

# The plugin creates continue.ready only after it has found the active MainScene and
# its exact OnContinueBtnClick handler.
# This handshake prevents a race: the window is placed first, and only after the
# script creates continue.positioned may the plugin invoke the button.
$continueDeadline = (Get-Date).AddSeconds($ContinueTimeoutSeconds)
do {
    if (Test-Path -LiteralPath $ContinueReady) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $continueDeadline)
if (-not (Test-Path -LiteralPath $ContinueReady)) {
    throw "The exact 'Continue game' button was not found within $ContinueTimeoutSeconds seconds. The game was left open."
}

Add-Type -AssemblyName System.Windows.Forms
if (-not ('PathOfIdleStats.NativeWindow' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace PathOfIdleStats {
    public static class NativeWindow {
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxCount);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
            int X, int Y, int cx, int cy, uint uFlags);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        public static IntPtr FindSingleUnityWindow(uint processId) {
            IntPtr match = IntPtr.Zero;
            int count = 0;
            EnumWindows((window, unused) => {
                uint owner;
                GetWindowThreadProcessId(window, out owner);
                if (owner != processId || !IsWindowVisible(window)) return true;
                var className = new System.Text.StringBuilder(256);
                GetClassName(window, className, className.Capacity);
                if (!String.Equals(className.ToString(), "UnityWndClass", StringComparison.Ordinal)) return true;
                match = window;
                count++;
                return true;
            }, IntPtr.Zero);
            return count == 1 ? match : IntPtr.Zero;
        }
    }
}
'@
}

$windowHandle = [PathOfIdleStats.NativeWindow]::FindSingleUnityWindow([uint32]$launched.ProcessId)
if ($windowHandle -eq [IntPtr]::Zero) {
    throw 'Exactly one visible Unity game window was not found; no window was repositioned.'
}
$screen = [Windows.Forms.Screen]::FromHandle($windowHandle)
$work = $screen.WorkingArea
$rightWidth = [int][Math]::Ceiling($work.Width / 2.0)
$rightX = $work.Right - $rightWidth
[void][PathOfIdleStats.NativeWindow]::ShowWindow($windowHandle, 9) # SW_RESTORE
$flags = 0x0004 -bor 0x0010 -bor 0x0020 # NOZORDER | NOACTIVATE | FRAMECHANGED
if (-not [PathOfIdleStats.NativeWindow]::SetWindowPos($windowHandle, [IntPtr]::Zero,
        $rightX, $work.Top, $rightWidth, $work.Height, $flags)) {
    throw "SetWindowPos failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
}
[IO.File]::WriteAllText($ContinuePositioned, (Get-Date).ToString('O'))

# The request disappears only after the plugin receives the positioning ack and
# invokes the exact button. If this times out, leave the game open; never send
# arbitrary mouse/keyboard input as a fallback.
do {
    if (-not (Test-Path -LiteralPath $ContinueRequest)) { break }
    Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $continueDeadline)
if (Test-Path -LiteralPath $ContinueRequest) {
    throw "The exact 'Continue game' button was found but not clicked within $ContinueTimeoutSeconds seconds."
}

# The plugin waits for the one active AdvMod UI containing exactly three field
# cells, verifies they map to the same three live battle fields, waits for their
# runtime listeners to settle, then calls each unchecked Toggle's OnPointerClick.
# That is the real Unity UI click path; it never edits save data or calls the
# underlying SetAuto method directly. Completion requires all three visible
# toggles to be on AND all three corresponding fields to own live battle instances.
$autoDeadline = (Get-Date).AddSeconds($ContinueTimeoutSeconds)
do {
    if ((Test-Path -LiteralPath $AutoComplete) -and -not (Test-Path -LiteralPath $AutoRequest)) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $autoDeadline)
if ((Test-Path -LiteralPath $AutoRequest) -or -not (Test-Path -LiteralPath $AutoComplete)) {
    Remove-Item -LiteralPath $AutoRequest -Force -ErrorAction SilentlyContinue
    throw "The game loaded, but all three battle slots did not confirm Auto within $ContinueTimeoutSeconds seconds."
}
Remove-Item -LiteralPath $AutoComplete -Force

Write-Host "Restart complete. Plugin hash: $installedHash"
Write-Host "The game window was placed on the monitor's right half, then the exact 'Continue game' button was clicked."
Write-Host 'All three visible Auto checkboxes are on and all three battles are running.'
Write-Host 'The Codex request will run when save data is ready.'
