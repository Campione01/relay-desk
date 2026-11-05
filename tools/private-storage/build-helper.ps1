[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The installed .NET Framework x64 compiler is required.' }
$output = Join-Path $PSScriptRoot 'bin'
[IO.Directory]::CreateDirectory($output) | Out-Null
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = $compiler
$info.Arguments = '/nologo /target:winexe /platform:x64 /optimize+ /reference:System.Web.Extensions.dll /out:"' + (Join-Path $output 'RelayPrivateStorage.exe') + '" "' + (Join-Path $PSScriptRoot 'RelayPrivateStorage.cs') + '"'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = [Diagnostics.Process]::Start($info)
$stdout = $process.StandardOutput.ReadToEnd()
$stderr = $process.StandardError.ReadToEnd()
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw ('Private storage compile failed: ' + $stdout + $stderr) }
Write-Output ('Built ' + (Join-Path $output 'RelayPrivateStorage.exe'))
