param(
    [switch]$UseLocalProxy,
    [switch]$CheckOnly,
    [switch]$StartOnly,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$EarlyFaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$EarlyWaiRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $EarlyFaceRoot)) 'WAI'
$EarlyOutput = Join-Path $EarlyFaceRoot 'outputs\early-action-20261024'
$EarlyEntry = Join-Path $EarlyFaceRoot 'realtime\early-action\lab.py'
$EarlyPort = 18799
$EarlyUrl = "http://127.0.0.1:$EarlyPort"
if (-not (Test-Path -LiteralPath $EarlyEntry)) { throw 'Keep this BAT in the face project root.' }
if (-not (Test-Path -LiteralPath (Join-Path $EarlyWaiRoot 'scripts\Resolve-Workspace.ps1'))) { throw 'WAI workspace resolver was not found beside model_test.' }
. (Join-Path $EarlyWaiRoot 'scripts\Resolve-Workspace.ps1')
$EarlyRuntime = Resolve-WaiWorkspaceRoot -Side host
$EarlyConfiguration = Join-Path $EarlyRuntime 'runtime.env'
if (-not (Test-Path -LiteralPath $EarlyConfiguration)) { throw 'Existing machine-local voice configuration is missing. No credentials were changed.' }
if (-not (Test-Path -LiteralPath (Join-Path $EarlyFaceRoot 'preview\node_modules\three\build\three.module.js'))) { throw 'Preview dependencies are missing. Run npm ci in the preview folder first.' }
if (-not (Test-Path -LiteralPath (Join-Path $EarlyFaceRoot 'assets\Aemeath'))) { throw 'Local PMX assets are missing.' }
$EarlyCandidates = @($env:WAI_EARLY_ACTION_PYTHON, 'F:\pyton3.12.13\python.exe', (Join-Path $EarlyRuntime 'venv\Scripts\python.exe'))
$EarlyPythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
if ($EarlyPythonCommand) { $EarlyCandidates += $EarlyPythonCommand.Source }
$EarlyPython = $null
foreach ($EarlyCandidate in $EarlyCandidates) {
    if (-not $EarlyCandidate -or -not (Test-Path -LiteralPath $EarlyCandidate)) { continue }
    & $EarlyCandidate -c 'import sys, aiohttp; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>$null
    if ($LASTEXITCODE -eq 0) { $EarlyPython = $EarlyCandidate; break }
}
if (-not $EarlyPython) { throw 'Python 3.11+ with aiohttp is required. Set WAI_EARLY_ACTION_PYTHON to an existing interpreter.' }
New-Item -ItemType Directory -Path $EarlyOutput -Force | Out-Null
$EarlyLedgerPath = Join-Path $EarlyOutput 'ledger.json'
if (Test-Path -LiteralPath $EarlyLedgerPath) {
    $EarlyLedger = Get-Content -LiteralPath $EarlyLedgerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($EarlyLedger.limit -ne 14) { throw 'This launcher must retain the existing 14-response batch limit.' }
    Write-Host ('Responses already reserved: {0}/14; usage blocked: {1}' -f @($EarlyLedger.responses).Count, $EarlyLedger.blocked)
}
Write-Host 'Local prerequisites passed. No cloud generation has been requested by this launcher.'
if ($CheckOnly) { exit 0 }
$EarlyNetwork = if ($UseLocalProxy) { 'local7890' } else { 'direct' }
if ($UseLocalProxy -and -not (Get-NetTCPConnection -State Listen -LocalPort 7890 -ErrorAction SilentlyContinue)) {
    throw 'No HTTP proxy is listening on 127.0.0.1:7890. Use direct mode or start your existing proxy.'
}
function Get-EarlyStatus {
    try { return Invoke-RestMethod -Uri "$EarlyUrl/api/early-action" -TimeoutSec 2 } catch { return $null }
}
function Stop-OwnedEarlyServer {
    param($ProcessId)
    $EarlyProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $EarlyProcess) { return }
    if (-not $EarlyProcess.CommandLine.Contains($EarlyEntry) -or -not $EarlyProcess.CommandLine.Contains($EarlyOutput)) {
        throw 'Refusing to stop a process not owned by this experiment.'
    }
    Stop-Process -Id $ProcessId -ErrorAction Stop
}
$EarlyStatePath = Join-Path $EarlyOutput 'launcher-state.json'
$EarlyStatus = Get-EarlyStatus
if ($EarlyStatus -and ($EarlyStatus.experimentId -ne 'early-action-20261024' -or $EarlyStatus.version -ne 2)) {
    throw 'Port 18799 has a different or older server. Close that specific server first.'
}
if ($EarlyStatus -and $EarlyStatus.network -ne $EarlyNetwork) {
    if ($EarlyStatus.busy) { throw 'A response is running. Finish or cancel it in the page before changing network mode.' }
    if (-not (Test-Path -LiteralPath $EarlyStatePath)) { throw 'Cannot replace a server launched by another tool. Close its window first.' }
    $EarlyOldState = Get-Content -LiteralPath $EarlyStatePath -Raw | ConvertFrom-Json
    Stop-OwnedEarlyServer $EarlyOldState.pid
    Start-Sleep -Milliseconds 400
    $EarlyStatus = $null
}
if (-not $EarlyStatus) {
    if (Get-NetTCPConnection -State Listen -LocalPort $EarlyPort -ErrorAction SilentlyContinue) { throw 'Port 18799 is occupied by another process.' }
    $EarlyArguments = @('-u', $EarlyEntry, '--env-file', $EarlyConfiguration, '--output', $EarlyOutput, '--port', "$EarlyPort", '--enable-cloud')
    if ($UseLocalProxy) { $EarlyArguments += '--local-proxy' }
    $EarlyQuotedArguments = ($EarlyArguments | ForEach-Object {
        if ($_ -match '["\r\n]') { throw 'Invalid launcher argument.' }
        '"' + $_ + '"'
    }) -join ' '
    $env:PYTHONIOENCODING = 'utf-8'
    $EarlyProcess = Start-Process -FilePath $EarlyPython -ArgumentList $EarlyQuotedArguments -WorkingDirectory $EarlyFaceRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $EarlyOutput 'launcher-stdout.log') -RedirectStandardError (Join-Path $EarlyOutput 'launcher-stderr.log')
    @{pid=$EarlyProcess.Id;experimentId='early-action-20261024';port=$EarlyPort;network=$EarlyNetwork} | ConvertTo-Json | Set-Content -LiteralPath $EarlyStatePath -Encoding UTF8
    for ($EarlyAttempt=0; $EarlyAttempt -lt 40; $EarlyAttempt++) {
        Start-Sleep -Milliseconds 300
        $EarlyStatus = Get-EarlyStatus
        if ($EarlyStatus) { break }
        if ($EarlyProcess.HasExited) { throw 'Server exited. See outputs\early-action-20261024\launcher-stderr.log.' }
    }
    if (-not $EarlyStatus) { throw 'Server did not become ready. No model response was requested.' }
}
Write-Host "Ready: $EarlyUrl/early-action/"
Write-Host 'Click the audio-check button, then the full-batch button. The page saves every case.'
Write-Host 'The maximum is 14 responses in total, including restarts. Unknown usage stops new calls.'
Write-Host 'Use the Download ZIP button even if a connection fails. Send that ZIP to Codex.'
Write-Host 'If direct connection fails and you already use a local HTTP proxy: rerun this BAT with -UseLocalProxy.'
if (-not $NoBrowser) { Start-Process "$EarlyUrl/early-action/" }
if ($StartOnly) { exit 0 }
do {
    Read-Host 'After testing, press ENTER here to package results and stop this experiment server' | Out-Null
    $EarlyStatus = Get-EarlyStatus
    if ($EarlyStatus -and $EarlyStatus.busy) { Write-Host 'A response is still active. Please finish/cancel in the page first.' }
} while ($EarlyStatus -and $EarlyStatus.busy)
& $EarlyPython (Join-Path $EarlyFaceRoot 'realtime\early-action\bundle.py') $EarlyOutput
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed; the original per-case files are preserved.' }
if (Test-Path -LiteralPath $EarlyStatePath) {
    $EarlyState = Get-Content -LiteralPath $EarlyStatePath -Raw | ConvertFrom-Json
    Stop-OwnedEarlyServer $EarlyState.pid
}
Write-Host ('Result bundle: ' + (Join-Path $EarlyOutput 'Aemeath-early-action-results.zip'))
Read-Host 'Press ENTER to close' | Out-Null
