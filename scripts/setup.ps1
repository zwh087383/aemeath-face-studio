param([switch]$PreviewOnly, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$taskFaceRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 20+ (including npm), then run setup again.'
}
$env:npm_config_cache = Join-Path $taskFaceRoot 'cache\npm'
New-Item -ItemType Directory -Path $env:npm_config_cache -Force | Out-Null
Push-Location (Join-Path $taskFaceRoot 'preview')
try {
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Preview dependencies failed to install.' }
} finally { Pop-Location }
if ($PreviewOnly) {
    Write-Host 'Preview ready. Run scripts/start-preview.ps1, then open http://127.0.0.1:18765/'
    return
}
. (Join-Path $PSScriptRoot 'face-env.ps1')
Push-Location $taskFaceRoot
try {
    $taskOldLfsSetting = $env:GIT_LFS_SKIP_SMUDGE
    try {
        $env:GIT_LFS_SKIP_SMUDGE = '1'
        & git submodule update --init --depth 1 -- 'vendor/Audio2Face-3D-SDK'
        if ($LASTEXITCODE -ne 0) { throw 'Pinned SDK checkout failed.' }
    } finally { $env:GIT_LFS_SKIP_SMUDGE = $taskOldLfsSetting }
    $taskSdkCommit = & git -C 'vendor/Audio2Face-3D-SDK' rev-parse HEAD
    if ($taskSdkCommit -ne '1ca0f02535ed774f5dbcd724a31cd486368dc783') { throw 'SDK commit does not match this release.' }
    foreach ($taskDownload in @(
        @('scripts/prepare_assets.py', 'model'),
        @('scripts/prepare_assets.py', 'cuda'),
        @('scripts/prepare_build_deps.py'),
        @('scripts/prepare_tensorrt.py')
    )) {
        & $env:PM_PYTHON_EXT @taskDownload
        if ($LASTEXITCODE -ne 0) { throw "Dependency setup failed: $($taskDownload[0])" }
    }
    if ($SkipBuild) {
        Write-Host 'Dependencies ready. Run scripts/build-local.ps1 before native inference.'
    } else {
        & (Join-Path $PSScriptRoot 'build-local.ps1')
        Write-Host 'Native driver ready. Run scripts/run-probe.ps1 to export blendshapes.'
    }
} finally { Pop-Location }
