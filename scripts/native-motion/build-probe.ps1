param(
    [Parameter(Mandatory=$true)][string]$Cue4ParseRoot,
    [string]$DotNetExe = 'dotnet',
    [string]$BuildDirectory = (Join-Path $env:LOCALAPPDATA 'AemeathNativeMotionTools\Probe')
)
$ErrorActionPreference = 'Stop'
$cueRoot = (Resolve-Path -LiteralPath $Cue4ParseRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $cueRoot 'CUE4Parse/CUE4Parse.csproj'))) {
    throw 'Cue4ParseRoot must point to the CUE4Parse source checkout.'
}
New-Item -ItemType Directory -Path $BuildDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Program.cs'),(Join-Path $PSScriptRoot 'NativeMotionProbe.csproj') -Destination $BuildDirectory
& $DotNetExe build (Join-Path $BuildDirectory 'NativeMotionProbe.csproj') -c Release "-p:Cue4ParseRoot=$cueRoot" -p:CUE4PARSE_SKIP_NATIVE=true --nologo
if ($LASTEXITCODE -ne 0) { throw "Probe build failed: $LASTEXITCODE" }
$native = Join-Path $cueRoot 'CUE4Parse-Natives/bin/Release/CUE4Parse-Natives.dll'
if (-not (Test-Path -LiteralPath $native)) {
    throw 'Build CUE4Parse-Natives (ACL enabled) first. The animation codec requires its DLL.'
}
Copy-Item -LiteralPath $native -Destination (Join-Path $BuildDirectory 'bin/Release/net10.0')
Write-Output (Join-Path $BuildDirectory 'bin/Release/net10.0/NativeMotionProbe.dll')
