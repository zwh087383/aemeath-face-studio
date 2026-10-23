param(
    [Parameter(Mandatory=$true)][string]$PaksDirectory,
    [Parameter(Mandatory=$true)][string]$PatchDirectory,
    [Parameter(Mandatory=$true)][string]$KeysJson,
    [Parameter(Mandatory=$true)][string]$ProbeDirectory,
    [string]$DotNetExe = 'dotnet',
    [string]$Allowlist = (Join-Path $PSScriptRoot 'complete-candidates.json'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../../outputs/native-complete-20261022'),
    [switch]$Resume
)
$ErrorActionPreference = 'Stop'
$paks=(Resolve-Path -LiteralPath $PaksDirectory).Path
$patch=(Resolve-Path -LiteralPath $PatchDirectory).Path
$keys=(Resolve-Path -LiteralPath $KeysJson).Path
$probe=(Resolve-Path -LiteralPath $ProbeDirectory).Path
$list=(Resolve-Path -LiteralPath $Allowlist).Path
$output=[IO.Path]::GetFullPath($OutputDirectory)
if((-not $Resume) -and ((Test-Path -LiteralPath (Join-Path $output 'manifest.json')) -or (Test-Path -LiteralPath (Join-Path $output 'manifest.partial.json')))) {
    throw 'Use a new output directory, or explicitly select -Resume for this allowlist.'
}
Push-Location -LiteralPath $probe
try {
    & $DotNetExe (Join-Path $probe 'NativeMotionProbe.dll') export-complete --paks $paks --patch $patch --keys $keys --out $output --manifest $list
    if($LASTEXITCODE -ne 0) { throw "Complete-resource export failed: $LASTEXITCODE" }
} finally { Pop-Location }
