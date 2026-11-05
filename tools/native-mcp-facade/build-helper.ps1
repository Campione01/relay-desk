[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path $PSScriptRoot 'OwnedMcpJob.cs'
$destination = Join-Path $PSScriptRoot 'OwnedMcpJob.exe'
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = $compiler
$info.Arguments = '/nologo /target:winexe /platform:x64 /optimize+ /out:"' + $destination + '" "' + $source + '"'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = [Diagnostics.Process]::Start($info)
$stdout = $process.StandardOutput.ReadToEnd()
$stderr = $process.StandardError.ReadToEnd()
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw ('Owned MCP job compile failed: ' + $stdout + $stderr) }
Get-FileHash -LiteralPath $source,$destination -Algorithm SHA256
