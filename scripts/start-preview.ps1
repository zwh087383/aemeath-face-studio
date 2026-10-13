param([int]$Port = 18765)
$ErrorActionPreference = 'Stop'
$taskFaceRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required.' }
$env:FACE_PREVIEW_PORT = [string]$Port
Write-Host "Preview: http://127.0.0.1:$Port"
& node.exe (Join-Path $taskFaceRoot 'preview\server.cjs')
