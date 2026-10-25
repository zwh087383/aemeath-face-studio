param(
    [string]$WaiRoot = (Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))) 'WAI'),
    [string]$DataDirectory = '',
    [string]$OutputDirectory = '',
    [ValidateRange(1024,65535)][int]$Port = 18803,
    [switch]$UseLocalProxy,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$ParallelFaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $ParallelFaceRoot 'outputs\parallel-duplex-20261024' }
$ParallelOutput = [IO.Path]::GetFullPath($OutputDirectory)
$ParallelUrl = 'http://127.0.0.1:' + $Port
$ParallelEntry = Join-Path $PSScriptRoot 'app.py'
$WaiRoot = (Resolve-Path -LiteralPath $WaiRoot).Path
. (Join-Path $WaiRoot 'scripts\Resolve-Workspace.ps1')
$ParallelRuntime = Resolve-WaiWorkspaceRoot -Side host
$ParallelPython = Join-Path $ParallelRuntime 'venv\Scripts\python.exe'
$ParallelConfiguration = Join-Path $ParallelRuntime 'runtime.env'
if (-not $DataDirectory) { $DataDirectory = Join-Path $ParallelRuntime 'voice-experiments\parallel-duplex-20261024' }
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
try { $ParallelExisting = Invoke-RestMethod -Uri "$ParallelUrl/api/duplex/status" -TimeoutSec 2 } catch { $ParallelExisting = $null }
if ($ParallelExisting) {
    if ($ParallelExisting.experimentId -ne 'parallel-duplex-director-20261024') { throw 'Another experiment is on the requested port.' }
    Write-Output 'Reusing the existing experiment and its unchanged budget.'
    if (-not $NoBrowser) { Start-Process "$ParallelUrl/parallel-duplex/" }
    return
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw 'Requested port is occupied.' }
if ((Test-Path -LiteralPath $DataDirectory) -and @(Get-ChildItem -LiteralPath $DataDirectory -Force).Count) {
    throw 'The isolated runtime directory is already in use. Do not reset data or bypass the old budget.'
}
if ($UseLocalProxy -and -not (Get-NetTCPConnection -State Listen -LocalPort 7890 -ErrorAction SilentlyContinue)) { throw 'Existing proxy 127.0.0.1:7890 is unavailable.' }
& (Join-Path $WaiRoot 'scripts\Start-Embedding.ps1')
if (-not (Test-Path -LiteralPath (Join-Path $ParallelOutput 'inputs\input-fixtures.json'))) {
    & (Join-Path $PSScriptRoot 'make-inputs.ps1') -OutputDirectory (Join-Path $ParallelOutput 'inputs')
}
$ParallelArgs = @('-u', $ParallelEntry, '--wai-root', $WaiRoot, '--env-file', $ParallelConfiguration,
    '--data-dir', $DataDirectory, '--output', $ParallelOutput, '--port', [string]$Port, '--enable-cloud')
if ($UseLocalProxy) { $ParallelArgs += '--local-proxy' }
$ParallelQuoted = ($ParallelArgs | ForEach-Object {
    if ($_ -match '["\r\n]') { throw 'Invalid launcher argument.' }
    '"' + $_ + '"'
}) -join ' '
$env:PYTHONIOENCODING = 'utf-8'
$ParallelProcess = Start-Process -FilePath $ParallelPython -ArgumentList $ParallelQuoted -WorkingDirectory $ParallelFaceRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $ParallelOutput 'server-stdout.log') -RedirectStandardError (Join-Path $ParallelOutput 'server-stderr.log')
@{pid=$ParallelProcess.Id;port=$Port;batch='parallel-duplex-director-20261024'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ParallelOutput 'server-state.json') -Encoding UTF8
Write-Output ('Starting isolated real WAI + parallel duplex, PID ' + $ParallelProcess.Id)
Write-Output 'Maximum six turns / 24 Qwen responses, including listener, voice, planner and handoff. Unknown usage stops new calls.'
Write-Output 'Opening the page does not generate a response. Connecting or running the live test does.'
Write-Output "$ParallelUrl/parallel-duplex/"
if (-not $NoBrowser) { Start-Process "$ParallelUrl/parallel-duplex/" }
