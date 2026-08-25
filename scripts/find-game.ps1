Set-StrictMode -Version 2.0

function Get-RegistryTextValue {
    param(
        [Microsoft.Win32.RegistryHive]$Hive,
        [Microsoft.Win32.RegistryView]$View,
        [string]$SubKey,
        [string]$Name
    )

    try {
        $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive, $View)
        try {
            $key = $baseKey.OpenSubKey($SubKey)
            if ($null -eq $key) { return $null }
            try { return [string]$key.GetValue($Name, $null) }
            finally { $key.Dispose() }
        } finally { $baseKey.Dispose() }
    } catch { return $null }
}

function Test-PathOfIdleDirectory {
    param([string]$Directory)

    if ([string]::IsNullOrWhiteSpace($Directory)) { return $false }
    return (Test-Path -LiteralPath (Join-Path $Directory 'PathOfIdle.exe') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Directory 'GameAssembly.dll') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Directory 'PathOfIdle_Data') -PathType Container)
}

function Find-PathOfIdleGameDirectory {
    [CmdletBinding()]
    param()

    $steamAppId = '4243990'
    $candidateDirectories = [System.Collections.Generic.List[string]]::new()
    $steamRoots = [System.Collections.Generic.List[string]]::new()

    # Steam writes an uninstall entry for installed games. It is the most direct
    # source, but every result is still verified against the game executable/data.
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
            $location = Get-RegistryTextValue $hive $view "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App $steamAppId" 'InstallLocation'
            if ($location) { $candidateDirectories.Add($location) }
        }
    }

    # SteamPath plus libraryfolders.vdf handles custom Steam library drives.
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
            foreach ($subKey in @('Software\Valve\Steam', 'SOFTWARE\WOW6432Node\Valve\Steam')) {
                $steamPath = Get-RegistryTextValue $hive $view $subKey 'SteamPath'
                if (-not $steamPath) { $steamPath = Get-RegistryTextValue $hive $view $subKey 'InstallPath' }
                if ($steamPath) { $steamRoots.Add($steamPath) }
            }
        }
    }

    foreach ($steamRoot in @($steamRoots | Select-Object -Unique)) {
        $libraryRoots = [System.Collections.Generic.List[string]]::new()
        $libraryRoots.Add($steamRoot)
        $libraryFile = Join-Path $steamRoot 'steamapps\libraryfolders.vdf'
        if (Test-Path -LiteralPath $libraryFile -PathType Leaf) {
            $libraryText = [IO.File]::ReadAllText($libraryFile)
            foreach ($match in [regex]::Matches($libraryText, '"path"\s+"(?<path>(?:\\.|[^"])*)"')) {
                $libraryRoots.Add($match.Groups['path'].Value.Replace('\\', '\'))
            }
        }

        foreach ($libraryRoot in @($libraryRoots | Select-Object -Unique)) {
            $manifestPath = Join-Path $libraryRoot "steamapps\appmanifest_$steamAppId.acf"
            if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
            $manifest = [IO.File]::ReadAllText($manifestPath)
            if ($manifest -notmatch '"appid"\s+"4243990"') { continue }
            $installDirMatch = [regex]::Match($manifest, '"installdir"\s+"(?<name>[^"]+)"')
            if ($installDirMatch.Success) {
                $candidateDirectories.Add((Join-Path $libraryRoot ("steamapps\common\" + $installDirMatch.Groups['name'].Value)))
            }
        }
    }

    $valid = @($candidateDirectories |
        ForEach-Object { try { [IO.Path]::GetFullPath($_.Trim()) } catch { $null } } |
        Where-Object { $_ -and (Test-PathOfIdleDirectory $_) } |
        Sort-Object -Unique)

    if ($valid.Count -eq 0) {
        throw "Path of Idle was not found through Steam. Install Steam app $steamAppId, then run start.bat again."
    }
    if ($valid.Count -gt 1) {
        throw "Steam reports more than one valid Path of Idle installation:`n$($valid -join "`n")"
    }
    return $valid[0]
}
