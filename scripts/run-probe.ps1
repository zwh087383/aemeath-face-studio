param(
    [string]$AudioPath,
    [string]$OutputPath,
    [int]$ChunkSamples = 0,
    [int]$FrameRate = 30
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'face-env.ps1')
if (-not $AudioPath) { $AudioPath = Join-Path $taskFaceRoot 'audio\chinese-probe.wav' }
if (-not $OutputPath) { $OutputPath = Join-Path $taskFaceRoot 'outputs\chinese-probe.json' }
$env:PATH = "$(Join-Path $taskFaceRoot 'build\sdk\audio2x-sdk\bin');$env:PATH"
& (Join-Path $taskFaceRoot 'build\probe\face_probe.exe') (Join-Path $taskFaceRoot 'outputs\engines\claire\model.json') $AudioPath $OutputPath $ChunkSamples $FrameRate
if ($LASTEXITCODE -ne 0) { throw "Audio2Face probe failed with exit code $LASTEXITCODE" }
