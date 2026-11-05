[CmdletBinding()]
param([string]$OutputPath = '')

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'RelayAuthHost.cs'
if (-not $OutputPath) { $OutputPath = Join-Path $PSScriptRoot 'bin\RelayAuthHost.exe' }
$output = [IO.Path]::GetFullPath($OutputPath)
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'The Windows .NET Framework C# compiler is unavailable; the owned login host was not built.'
}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output)) | Out-Null
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $compiler
# A GUI subsystem is essential: even the host's idle/startup/error paths create no console.
$start.Arguments = '/nologo /target:winexe /platform:anycpu /optimize+ /reference:System.Web.Extensions.dll /out:"' + $output + '" "' + $source + '"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [Diagnostics.Process]::Start($start)
$stdout = $process.StandardOutput.ReadToEnd()
$stderr = $process.StandardError.ReadToEnd()
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw ('The owned login host did not compile: ' + $stdout + $stderr) }
Write-Output ('Built owned login host: ' + $output)
