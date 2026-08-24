[CmdletBinding()]
param(
    [string]$GameDirectory = 'C:\Program Files (x86)\Steam\steamapps\common\PathOfIdle'
)

$ErrorActionPreference = 'Stop'
$GameExecutable = Join-Path $GameDirectory 'PathOfIdle.exe'
$ConfigPath = Join-Path $GameDirectory 'BepInEx\config\BepInEx.cfg'

# BepInEx owns this configuration file. Change only its documented console-output
# switch and leave disk logging enabled, so diagnostics remain available without a
# terminal window. This script never accesses game saves or gameplay data.
$running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $GameExecutable, [StringComparison]::OrdinalIgnoreCase)
})
if ($running.Count -gt 0) {
    throw 'Path of Idle is running. Close it normally before changing BepInEx configuration.'
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "BepInEx configuration is missing. Start the game once to generate it, close normally, then retry: $ConfigPath"
}

$text = [IO.File]::ReadAllText($ConfigPath)
$consolePattern = '(?ms)^\[Logging\.Console\]\s*\r?\n(?<body>.*?)(?=^\[|\z)'
$consoleSection = [regex]::Match($text, $consolePattern)
if (-not $consoleSection.Success) { throw 'BepInEx [Logging.Console] section was not found.' }
$enabledPattern = '(?m)^(?<prefix>Enabled\s*=\s*)(?<value>true|false)(?<suffix>\s*)$'
$enabledMatches = [regex]::Matches($consoleSection.Groups['body'].Value, $enabledPattern)
if ($enabledMatches.Count -ne 1) {
    throw "Expected one Enabled setting in [Logging.Console], found $($enabledMatches.Count)."
}

$diskPattern = '(?ms)^\[Logging\.Disk\]\s*\r?\n(?<body>.*?)(?=^\[|\z)'
$diskSection = [regex]::Match($text, $diskPattern)
if (-not $diskSection.Success -or $diskSection.Groups['body'].Value -notmatch '(?m)^Enabled\s*=\s*true\s*$') {
    throw 'BepInEx disk logging is not enabled; refusing to hide the console without a diagnostic log.'
}

if (-not [string]::Equals($enabledMatches[0].Groups['value'].Value, 'false', [StringComparison]::OrdinalIgnoreCase)) {
    $newBody = [regex]::Replace(
        $consoleSection.Groups['body'].Value,
        $enabledPattern,
        '${prefix}false${suffix}',
        1
    )
    $updated = $text.Substring(0, $consoleSection.Groups['body'].Index) +
        $newBody +
        $text.Substring($consoleSection.Groups['body'].Index + $consoleSection.Groups['body'].Length)
    [IO.File]::WriteAllText($ConfigPath, $updated, [Text.UTF8Encoding]::new($false))
}

$verified = [IO.File]::ReadAllText($ConfigPath)
$verifiedConsole = [regex]::Match($verified, $consolePattern)
if (-not $verifiedConsole.Success -or $verifiedConsole.Groups['body'].Value -notmatch '(?m)^Enabled\s*=\s*false\s*$') {
    throw 'BepInEx console configuration did not verify after writing.'
}
Write-Host 'BepInEx console window disabled; disk logging remains enabled.'
