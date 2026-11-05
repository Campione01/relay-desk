[CmdletBinding()]
param([switch]$IncludeFixture, [switch]$FixtureOnly)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The .NET Framework compiler is unavailable.' }
$output = Join-Path $PSScriptRoot 'bin'
[IO.Directory]::CreateDirectory($output) | Out-Null
function Invoke-Compiler([string]$Name, [string]$Target) {
    $source = Join-Path $PSScriptRoot ($Name + '.cs')
    $destination = Join-Path $output ($Name + '.exe')
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $compiler
    $info.Arguments = '/nologo /target:' + $Target + ' /platform:x64 /optimize+ /reference:System.Web.Extensions.dll /out:"' + $destination + '" "' + $source + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw ($Name + ' compile failed: ' + $stdout + $stderr) }
    Write-Output ('Built ' + $destination)
}
if (-not $FixtureOnly) { Invoke-Compiler 'RelayNativeHost' 'winexe' }
if ($IncludeFixture -or $FixtureOnly) { Invoke-Compiler 'NativeConsoleFixture' 'exe' }
