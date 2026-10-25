param(
    [string]$WaiRoot = 'F:\AI-Shared\WAI',
    [string]$OutputDirectory = '',
    [string]$DataDirectory = '',
    [ValidateRange(1024,65535)][int]$Port = 18805,
    [ValidateRange(1,6)][int]$TurnLimit = 3,
    [ValidateRange(1,24)][int]$ResponseLimit = 12,
    [switch]$EnableCloud,
    [switch]$UseLocalProxy,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$ModelFaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $WaiRoot 'scripts\Resolve-Workspace.ps1')
$ModelRuntime = Resolve-WaiWorkspaceRoot -Side host
$ModelPython = Join-Path $ModelRuntime 'venv\Scripts\python.exe'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $ModelFaceRoot 'outputs\model-director-20261025' }
$ModelOutput = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($ModelOutput) | Out-Null
$ModelUrl = 'http://127.0.0.1:' + $Port
try { $ModelExisting = Invoke-RestMethod -Uri "$ModelUrl/api/duplex/status" -TimeoutSec 2 } catch { $ModelExisting = $null }
if ($ModelExisting) {
    if ($ModelExisting.experimentId -ne 'model-action-director-20261025' -or $ModelExisting.cloudEnabled -ne [bool]$EnableCloud) { throw 'Port is serving another experiment/mode. Keep it and choose another port.' }
    if (-not $NoBrowser) { Start-Process "$ModelUrl/model-director/" }
    Write-Output "$ModelUrl/model-director/"
    return
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw 'Requested port is occupied.' }
$ModelCache = Join-Path $ModelFaceRoot 'outputs\parallel-duplex-retest-20261024'
foreach ($ModelName in @('preview-greet.wav','preview-context.json')) {
    $ModelTarget = Join-Path $ModelOutput $ModelName
    if (-not (Test-Path -LiteralPath $ModelTarget)) {
        Copy-Item -LiteralPath (Join-Path $ModelCache $ModelName) -Destination $ModelTarget
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $ModelOutput 'inputs\input-fixtures.json'))) {
    & (Join-Path $PSScriptRoot 'make-inputs.ps1') -OutputDirectory (Join-Path $ModelOutput 'inputs')
}
$ModelEntry = Join-Path $PSScriptRoot 'demo_server.py'
$ModelArgs = @('-u',$ModelEntry,'--wai-root',$WaiRoot,'--output',$ModelOutput,'--port',[string]$Port)
if ($EnableCloud) {
    if (-not $DataDirectory) { $DataDirectory = Join-Path $ModelRuntime 'voice-experiments\model-director-20261025' }
    if ((Test-Path -LiteralPath $DataDirectory) -and @(Get-ChildItem -LiteralPath $DataDirectory -Force).Count) { throw 'Runtime already contains data. No automatic reset or budget bypass.' }
    if ($UseLocalProxy -and -not (Get-NetTCPConnection -State Listen -LocalPort 7890 -ErrorAction SilentlyContinue)) { throw 'Existing local proxy unavailable.' }
    & (Join-Path $WaiRoot 'scripts\Start-Embedding.ps1')
    $ModelArgs = @('-u',(Join-Path (Split-Path -Parent $PSScriptRoot) 'parallel-duplex\app.py'),
        '--wai-root',$WaiRoot,'--env-file',(Join-Path $ModelRuntime 'runtime.env'),
        '--data-dir',[IO.Path]::GetFullPath($DataDirectory),'--output',$ModelOutput,'--port',[string]$Port,
        '--model-director','--enable-cloud','--max-turns',[string]$TurnLimit,'--max-responses',[string]$ResponseLimit)
    if ($UseLocalProxy) { $ModelArgs += '--local-proxy' }
    Write-Output ("Bounded cloud mode: maximum $TurnLimit turns / $ResponseLimit Qwen responses. Unknown usage stops calls. Does not reset an old ledger.")
}
$ModelQuoted = ($ModelArgs | ForEach-Object { if ($_ -match '["\r\n]') { throw 'Invalid argument.' }; '"' + $_ + '"' }) -join ' '
$env:PYTHONIOENCODING = 'utf-8'
$ModelProcess = Start-Process -FilePath $ModelPython -ArgumentList $ModelQuoted -WorkingDirectory $ModelFaceRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $ModelOutput 'server-stdout.log') -RedirectStandardError (Join-Path $ModelOutput 'server-stderr.log')
@{pid=$ModelProcess.Id;port=$Port;cloud=[bool]$EnableCloud} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ModelOutput 'server-state.json') -Encoding UTF8
Write-Output ('Started PID ' + $ModelProcess.Id + '. ' + $ModelUrl + '/model-director/')
if (-not $NoBrowser) { Start-Process "$ModelUrl/model-director/" }
