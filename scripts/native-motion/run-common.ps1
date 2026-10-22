param(
    [Parameter(Mandatory=$true)][string]$PaksDirectory,
    [Parameter(Mandatory=$true)][string]$PatchDirectory,
    [Parameter(Mandatory=$true)][string]$KeysJson,
    [Parameter(Mandatory=$true)][string]$ProbeDirectory,
    [string]$DotNetExe = 'dotnet',
    [string]$Allowlist = (Join-Path $PSScriptRoot 'common-candidates.json'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../../outputs/native-common-motions-20261022')
)
$ErrorActionPreference = 'Stop'
$paks=(Resolve-Path -LiteralPath $PaksDirectory).Path
$patch=(Resolve-Path -LiteralPath $PatchDirectory).Path
$keys=(Resolve-Path -LiteralPath $KeysJson).Path
$probe=(Resolve-Path -LiteralPath $ProbeDirectory).Path
$list=(Resolve-Path -LiteralPath $Allowlist).Path
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath (Join-Path $output 'manifest.json')) { throw 'Use a new output directory to preserve earlier evidence.' }
Push-Location -LiteralPath $probe
try {
    & $DotNetExe (Join-Path $probe 'NativeMotionProbe.dll') export-list --paks $paks --patch $patch --keys $keys --out $output --manifest $list
    if($LASTEXITCODE -ne 0) { throw "Common-motion export failed: $LASTEXITCODE" }
} finally { Pop-Location }
