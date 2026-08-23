[CmdletBinding()]
param([string]$OutputFile = 'PathOfIdleStats.dll')

$ErrorActionPreference = 'Stop'
$ProjectDirectory = Split-Path -Parent $PSScriptRoot
$RuntimeDirectory = Join-Path $ProjectDirectory 'work\bepinex\dotnet'
$CoreDirectory = Join-Path $ProjectDirectory 'work\bepinex\BepInEx\core'
$GameInteropDirectory = 'C:\Program Files (x86)\Steam\steamapps\common\PathOfIdle\BepInEx\interop'
$SourcePath = Join-Path $ProjectDirectory 'plugin\Plugin.cs'
$OutputDirectory = 'C:\Users\ances\Documents\Codex\2026-08-23\pat\work\plugin-build'
$OutputPath = Join-Path $OutputDirectory $OutputFile
$Compiler = Join-Path $env:ProgramFiles 'dotnet\sdk\7.0.401\Roslyn\bincore\csc.dll'

if (-not (Test-Path -LiteralPath $Compiler)) { throw "C# compiler not found: $Compiler" }
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
