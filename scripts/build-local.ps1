param([switch]$RebuildEngine, [string]$CudaArchitecture = 'native')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'face-env.ps1')
$taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $taskVswhere)) { throw 'Visual Studio 2022 C++ build tools are required.' }
$taskVsRoot = & $taskVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $taskVsRoot) { throw 'No Visual Studio C++ toolchain found.' }
& (Join-Path $taskVsRoot 'Common7\Tools\Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
$taskCmake = if (Get-Command cmake.exe -ErrorAction SilentlyContinue) { (Get-Command cmake.exe).Source } else { Join-Path $taskVsRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' }
$taskNinja = if (Get-Command ninja.exe -ErrorAction SilentlyContinue) { (Get-Command ninja.exe).Source } else { Join-Path $taskVsRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe' }
if (-not (Test-Path -LiteralPath $taskCmake) -or -not (Test-Path -LiteralPath $taskNinja)) { throw 'CMake and Ninja are required.' }
Push-Location $taskFaceRoot
try {
    & $taskCmake -S 'vendor/Audio2Face-3D-SDK' -B 'build/sdk' -G Ninja "-DCMAKE_MAKE_PROGRAM=$taskNinja" -DCMAKE_BUILD_TYPE=Release "-DCMAKE_CUDA_ARCHITECTURES=$CudaArchitecture" "-DCUDAToolkit_ROOT=$env:CUDA_PATH" "-DTensorRT_ROOT=$env:TENSORRT_ROOT_DIR"
    if ($LASTEXITCODE) { throw 'SDK configure failed' }
    & $taskCmake --build 'build/sdk' --target audio2x -j 6
    if ($LASTEXITCODE) { throw 'SDK build failed' }
    & $taskCmake -S 'native' -B 'build/probe' -G Ninja "-DCMAKE_MAKE_PROGRAM=$taskNinja" -DCMAKE_BUILD_TYPE=Release "-DCUDAToolkit_ROOT=$env:CUDA_PATH"
    if ($LASTEXITCODE) { throw 'Probe configure failed' }
    & $taskCmake --build 'build/probe' -j 4
    if ($LASTEXITCODE) { throw 'Probe build failed' }
    if ($RebuildEngine -or -not (Test-Path -LiteralPath 'outputs/engines/claire/network.trt')) {
        New-Item -ItemType Directory -Path 'outputs/engines/claire' -Force | Out-Null
        & "$env:TENSORRT_ROOT_DIR\bin\trtexec.exe" '--onnx=models/Audio2Face-3D-v2.3.1-Claire/network.onnx' '--saveEngine=outputs/engines/claire/network.trt' '--minShapes=input:1x1x8320,emotion:1x1x26' '--optShapes=input:1x1x8320,emotion:1x1x26' '--maxShapes=input:1x1x8320,emotion:1x1x26' '--memPoolSize=tacticSharedMem:0.046875' '--timingCacheFile=cache/claire-timing.cache' --skipInference
        if ($LASTEXITCODE) { throw 'TensorRT engine build failed' }
    }
    & $env:PM_PYTHON_EXT 'scripts/make_model_config.py'
    if ($LASTEXITCODE) { throw 'Model configuration failed' }
} finally { Pop-Location }
