[CmdletBinding()]
param([string]$OutputFile = 'PathOfIdleStats.dll')

$ErrorActionPreference = 'Stop'
$ProjectDirectory = Split-Path -Parent $PSScriptRoot
$RuntimeDirectory = Join-Path $ProjectDirectory 'work\bepinex\dotnet'
$CoreDirectory = Join-Path $ProjectDirectory 'work\bepinex\BepInEx\core'
$GameInteropDirectory = 'C:\Program Files (x86)\Steam\steamapps\common\PathOfIdle\BepInEx\interop'
$SourcePath = Join-Path $ProjectDirectory 'plugin\Plugin.cs'
$OutputDirectory = Join-Path $ProjectDirectory 'plugin\bin\Release\net6.0'
$OutputPath = Join-Path $OutputDirectory $OutputFile
$dotnetRoot = Join-Path $env:ProgramFiles 'dotnet'
$Compiler = Get-ChildItem -LiteralPath (Join-Path $dotnetRoot 'sdk') -Directory -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'Roslyn\bincore\csc.dll' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1

if (-not $Compiler) { throw 'C# compiler not found. Install a current .NET SDK, then try again.' }
if (-not (Test-Path -LiteralPath $RuntimeDirectory)) { throw 'Staged BepInEx .NET runtime is missing.' }

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$managedRuntimeAssemblies = Get-ChildItem -LiteralPath $RuntimeDirectory -Filter '*.dll' -File | Where-Object {
    try {
        [Reflection.AssemblyName]::GetAssemblyName($_.FullName) | Out-Null
        $true
    } catch [BadImageFormatException] {
        $false
    }
}
$references = @(
    $managedRuntimeAssemblies | ForEach-Object { '/reference:' + $_.FullName }
    '/reference:' + (Join-Path $CoreDirectory 'BepInEx.Core.dll')
    '/reference:' + (Join-Path $CoreDirectory 'BepInEx.Unity.IL2CPP.dll')
    '/reference:' + (Join-Path $CoreDirectory '0Harmony.dll')
    '/reference:' + (Join-Path $CoreDirectory 'Il2CppInterop.Runtime.dll')
    '/reference:' + (Join-Path $GameInteropDirectory 'Il2Cppmscorlib.dll')
    '/reference:' + (Join-Path $GameInteropDirectory 'UnityEngine.CoreModule.dll')
    '/reference:' + (Join-Path $GameInteropDirectory 'UnityEngine.ImageConversionModule.dll')
)
$arguments = @(
    $Compiler
    '/noconfig'
    '/nostdlib+'
    '/target:library'
    '/optimize+'
    '/deterministic+'
    '/langversion:latest'
    '/nullable:enable'
    ('/out:' + $OutputPath)
) + $references + @($SourcePath)

& dotnet @arguments
if ($LASTEXITCODE -ne 0) { throw "Plugin compilation failed with exit code $LASTEXITCODE" }
Write-Host "Built $OutputPath"
