$taskFaceRoot = Split-Path -Parent $PSScriptRoot
$env:PM_PACKAGES_ROOT = Join-Path $taskFaceRoot 'cache\packman'
if ($env:FACE_PYTHON) {
    $taskFacePython = (Resolve-Path -LiteralPath $env:FACE_PYTHON -ErrorAction Stop).Path
} elseif (Get-Command py.exe -ErrorAction SilentlyContinue) {
    $taskFacePython = & py.exe -3.10 -c 'import sys; print(sys.executable)' 2>$null
    if ($LASTEXITCODE -ne 0) { $taskFacePython = & py.exe -3 -c 'import sys; print(sys.executable)' }
} elseif (Get-Command python.exe -ErrorAction SilentlyContinue) {
    $taskFacePython = (Get-Command python.exe).Source
} else {
    throw 'Install Python 3.10+ or set FACE_PYTHON to its executable path.'
}
if (-not $taskFacePython) { throw 'Unable to locate Python; set FACE_PYTHON.' }
$env:PM_PYTHON_EXT = [string]$taskFacePython
$env:PYTHONUTF8 = '1'
$env:TEMP = Join-Path $taskFaceRoot 'cache\tmp'
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = Join-Path $taskFaceRoot 'cache\pip'
$env:HF_HOME = Join-Path $taskFaceRoot 'cache\huggingface'
$env:CUDA_CACHE_PATH = Join-Path $taskFaceRoot 'cache\cuda'
$env:CUDA_PATH = Join-Path $taskFaceRoot 'runtime\cuda-12.9'
$env:TENSORRT_ROOT_DIR = Join-Path $taskFaceRoot 'runtime\tensorrt-10.13.2.6'
$env:PATH = "$env:CUDA_PATH\bin;$env:TENSORRT_ROOT_DIR\bin;$env:TENSORRT_ROOT_DIR\lib;$env:PATH"
foreach ($taskCachePath in @($env:TEMP,$env:PIP_CACHE_DIR,$env:HF_HOME,$env:CUDA_CACHE_PATH,(Join-Path $taskFaceRoot 'logs'),(Join-Path $taskFaceRoot 'outputs'))) {
    New-Item -ItemType Directory -Path $taskCachePath -Force | Out-Null
}
