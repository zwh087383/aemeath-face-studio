param([string]$WaiRoot='F:\AI-Shared\WAI',[string]$OutputDirectory='',
 [string]$DataDirectory='', [int]$Port=18808,[int]$AssetPort=18809,
 [string]$ResumeSource='', [string]$ResumeEvidence='', [string]$ResumeStatus='', [string]$ResumeState='',
 [int]$TurnLimit=12,[int]$ListenerLimit=18,[int]$VoiceLimit=30,[int]$ActionLimit=60,[int]$BackgroundLimit=120,[int]$PcmSeconds=480,
 [ValidateSet('qwen','deepseek')][string]$ActionProvider='qwen',
 [switch]$EnableCloud,[switch]$UseLocalProxy,[switch]$NoBrowser)
$ErrorActionPreference='Stop'
$CenterRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $WaiRoot 'scripts\Resolve-Workspace.ps1')
$CenterRuntime=Resolve-WaiWorkspaceRoot -Side host
$CenterPython=Join-Path $CenterRuntime 'venv\Scripts\python.exe'
if (-not $OutputDirectory) { $OutputDirectory=Join-Path $CenterRoot 'outputs\character-center-20261025' }
$CenterOutput=[IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($CenterOutput) | Out-Null
$CenterUrl='http://127.0.0.1:'+$Port
try { $CenterExisting=Invoke-RestMethod -Uri ($CenterUrl+'/api/duplex/status') -TimeoutSec 2 } catch { $CenterExisting=$null }
if ($CenterExisting) {
 if ($CenterExisting.experimentId -ne 'continuous-character-center-20261025' -or $CenterExisting.cloudEnabled -ne [bool]$EnableCloud -or ($CenterExisting.actionProvider -and $CenterExisting.actionProvider -ne $ActionProvider)) { throw 'Port already serves another mode. Choose another port; do not stop unrelated work.' }
 if (-not $NoBrowser) { Start-Process ($CenterUrl+'/character-center/') }
 Write-Output ($CenterUrl+'/character-center/');return
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw 'HTTP port is occupied.' }
& (Join-Path $PSScriptRoot 'make-inputs.ps1') -OutputDirectory (Join-Path $CenterOutput 'inputs')
$CenterAssetProcess=$null
if (-not (Get-NetTCPConnection -State Listen -LocalPort $AssetPort -ErrorAction SilentlyContinue)) {
 $CenterAssetProcess=Start-Process -FilePath 'node' -ArgumentList @((Join-Path $PSScriptRoot 'assets.mjs'),'--port',[string]$AssetPort) -WorkingDirectory $CenterRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $CenterOutput 'assets-stdout.log') -RedirectStandardError (Join-Path $CenterOutput 'assets-stderr.log')
}
$CenterArgs=@('-u',(Join-Path $PSScriptRoot 'app.py'),'--wai-root',$WaiRoot,'--output',$CenterOutput,'--port',[string]$Port,'--asset-port',[string]$AssetPort,'--action-provider',$ActionProvider)
if ($EnableCloud) {
 if (-not $DataDirectory) { $DataDirectory=Join-Path $CenterRuntime 'voice-experiments\character-center-20261025' }
 if ((Test-Path -LiteralPath $DataDirectory) -and @(Get-ChildItem -LiteralPath $DataDirectory -Force).Count) { throw 'Runtime data exists. No automatic reset or repeated cloud batch.' }
 & (Join-Path $WaiRoot 'scripts\Start-Embedding.ps1')
 $CenterArgs+=@('--enable-cloud','--env-file',(Join-Path $CenterRuntime 'runtime.env'),'--data-dir',[IO.Path]::GetFullPath($DataDirectory))
 $CenterArgs+=@('--turn-limit',[string]$TurnLimit,'--listener-limit',[string]$ListenerLimit,
 '--voice-limit',[string]$VoiceLimit,'--action-limit',[string]$ActionLimit,'--background-limit',[string]$BackgroundLimit,'--pcm-seconds',[string]$PcmSeconds)
 if ($UseLocalProxy) { $CenterArgs+='--local-proxy' }
 if ($ResumeSource) {
  if (-not $ResumeEvidence -or -not $ResumeStatus) { throw 'Resume requires evidence and status receipts.' }
  $CenterPreviousState=Join-Path $CenterOutput ('resume-previous-state-'+[guid]::NewGuid().ToString('N')+'.json')
  if ($ResumeState) { Copy-Item -LiteralPath $ResumeState -Destination $CenterPreviousState }
  else { Copy-Item -LiteralPath (Join-Path $CenterOutput ('server-'+$Port+'-state.json')) -Destination $CenterPreviousState }
  $CenterArgs+=@('--resume-source',[IO.Path]::GetFullPath($ResumeSource),'--resume-state',$CenterPreviousState,
    '--resume-evidence',[IO.Path]::GetFullPath($ResumeEvidence),'--resume-status',[IO.Path]::GetFullPath($ResumeStatus))
 }
}
$CenterQuoted=($CenterArgs | ForEach-Object { if ($_ -match '["\r\n]') { throw 'Invalid argument' };'"'+$_+'"' }) -join ' '
$env:PYTHONIOENCODING='utf-8'
$CenterProcess=Start-Process -FilePath $CenterPython -ArgumentList $CenterQuoted -WorkingDirectory $CenterRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $CenterOutput ('server-'+$Port+'-stdout.log')) -RedirectStandardError (Join-Path $CenterOutput ('server-'+$Port+'-stderr.log'))
@{pid=$CenterProcess.Id;assetPid=$CenterAssetProcess.Id;port=$Port;assetPort=$AssetPort;cloud=[bool]$EnableCloud} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $CenterOutput ('server-'+$Port+'-state.json')) -Encoding UTF8
$CenterDeadline=[DateTime]::UtcNow.AddSeconds(45)
$CenterHealthy=$false
while ([DateTime]::UtcNow -lt $CenterDeadline) {
 $CenterProcess.Refresh()
 if ($CenterProcess.HasExited) { throw ('Server exited during startup. Evidence preserved in '+(Join-Path $CenterOutput ('server-'+$Port+'-stderr.log'))) }
 try {
  $CenterHealth=Invoke-RestMethod -Uri ($CenterUrl+'/api/duplex/status') -TimeoutSec 1
  $CenterHealthy=$CenterHealth.experimentId -eq 'continuous-character-center-20261025' -and $CenterHealth.cloudEnabled -eq [bool]$EnableCloud
 } catch { $CenterHealthy=$false }
 if ($CenterHealthy) { break }
 Start-Sleep -Milliseconds 200
}
if (-not $CenterHealthy) { throw ('Startup health deadline exceeded; PID '+$CenterProcess.Id+' retained for inspection.') }
Write-Output ('Ready PID '+$CenterProcess.Id+'. '+$CenterUrl+'/character-center/')
if (-not $NoBrowser) { Start-Process ($CenterUrl+'/character-center/') }
