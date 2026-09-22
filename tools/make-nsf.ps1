# Convert song files to MML and export NSF in one go, then open the output folder.
# (thin wrapper over tools/headless/nsf-batch.js -- see that file for what is written)
#
#   .\tools\make-nsf.ps1 "D:\snd\nsf\foo.nsf"
#   .\tools\make-nsf.ps1 "D:\snd\spc" -Sec 60 -Out C:\temp\listen
#   .\tools\make-nsf.ps1 "pack.zip" -Songs all -Wav
#
# NOTE: keep this file ASCII only. Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
#       which mangles non-ASCII text (see memory: powershell51-ansi-script-encoding).
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$Path,
    [string]$Out,
    [int]$Sec = 30,
    [string]$Songs,
    [string]$Preset,
    [string]$Cmd,
    [switch]$Wav,
    [switch]$SkipExisting,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..").Path

if (-not $Path -or $Path.Count -eq 0) {
    Write-Host "usage: .\tools\make-nsf.ps1 <file|folder ...> [-Out DIR] [-Sec 30] [-Songs all|0,2,5]"
    Write-Host "                            [-Preset plain|faithful] [-Cmd D=0,EP=0,...] [-Wav] [-SkipExisting] [-NoOpen]"
    exit 2
}

# node.exe: PATH first, then $env:NODE_EXE, then the usual per-user install.
# ($nodeCmd, not $cmd -- $Cmd is a [string] parameter of this script and would coerce the
#  Get-Command result into a bare string, losing .Source)
$node = $null
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { $node = $nodeCmd.Source }
elseif ($env:NODE_EXE -and (Test-Path $env:NODE_EXE)) { $node = $env:NODE_EXE }
else {
    $guess = Join-Path $env:USERPROFILE 'nodejs\node.exe'
    if (Test-Path $guess) { $node = $guess }
}
if (-not $node) { Write-Error "node.exe not found. Add it to PATH or set `$env:NODE_EXE"; exit 1 }

if (-not $Out) { $Out = Join-Path $repo '_out' }
if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Path $Out -Force | Out-Null }
$Out = (Resolve-Path $Out).Path

# the node side prints Japanese; without this the console shows mojibake on a CP932 host
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$argsList = New-Object System.Collections.Generic.List[string]
$argsList.Add((Join-Path $repo 'tools\headless\nsf-batch.js'))
foreach ($p in $Path) { $argsList.Add($p) }
$argsList.Add('--out'); $argsList.Add($Out)
$argsList.Add('--sec'); $argsList.Add([string]$Sec)
if ($Songs)  { $argsList.Add('--songs');  $argsList.Add($Songs) }
if ($Preset) { $argsList.Add('--preset'); $argsList.Add($Preset) }
if ($Cmd)    { $argsList.Add('--cmd');    $argsList.Add($Cmd) }
if ($Wav)    { $argsList.Add('--wav') }
if ($SkipExisting) { $argsList.Add('--skip-existing') }

& $node $argsList.ToArray()
$code = $LASTEXITCODE

if (-not $NoOpen) { Start-Process explorer.exe $Out }
exit $code
