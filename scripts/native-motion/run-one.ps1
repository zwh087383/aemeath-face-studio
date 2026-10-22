param(
    [Parameter(Mandatory=$true)][string]$PaksDirectory,
    [Parameter(Mandatory=$true)][string]$PatchDirectory,
    [Parameter(Mandatory=$true)][string]$KeysJson,
    [Parameter(Mandatory=$true)][string]$ProbeDirectory,
    [string]$DotNetExe = 'dotnet',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../../outputs/native-motion-20261022')
)
$ErrorActionPreference = 'Stop'
$paks = (Resolve-Path -LiteralPath $PaksDirectory).Path
$patch = (Resolve-Path -LiteralPath $PatchDirectory).Path
$keys = (Resolve-Path -LiteralPath $KeysJson).Path
$probe = (Resolve-Path -LiteralPath $ProbeDirectory).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath (Join-Path $output 'native-clip.json')) {
    throw 'The destination already contains a clip. Choose a new output directory to preserve the earlier evidence.'
}
Push-Location -LiteralPath $probe
try {
    & $DotNetExe (Join-Path $probe 'NativeMotionProbe.dll') export-one --paks $paks --patch $patch --keys $keys --out $output --asset 'Client/Content/Aki/Character/Role/FemaleM/Aimisi/CommonAnim/Stand2.uasset' --mesh 'Client/Content/Aki/Character/Role/FemaleM/Aimisi/R2T1AimisiMd10011/Model/R2T1AimisiMd10011.uasset'
    if ($LASTEXITCODE -ne 0) { throw "Single-clip export failed: $LASTEXITCODE" }
} finally { Pop-Location }
