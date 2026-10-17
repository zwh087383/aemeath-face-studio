param(
    [Parameter(Mandatory=$true)][string]$WaiRoot,
    [Parameter(Mandatory=$true)][string]$DataDirectory,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [int]$Port = 18772
)
$ErrorActionPreference = 'Stop'
$WaiRoot = (Resolve-Path -LiteralPath $WaiRoot).Path
$FaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $WaiRoot 'scripts\Resolve-Workspace.ps1')
$VoiceRuntimeRoot = Resolve-WaiWorkspaceRoot -Side host
$VoicePython = Join-Path $VoiceRuntimeRoot 'venv\Scripts\python.exe'
$VoiceConfiguration = Join-Path $VoiceRuntimeRoot 'runtime.env'
if (-not (Test-Path -LiteralPath $VoicePython)) { throw 'Prepare the WAI host workspace first.' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port already has a listener; reuse the running page or stop its verified owner.'
}
& (Join-Path $WaiRoot 'scripts\Start-Embedding.ps1')
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Embedding startup failed.' }
if (-not (Test-Path -LiteralPath (Join-Path $OutputDirectory 'input-fixtures.json'))) {
    & (Join-Path $PSScriptRoot 'make-inputs.ps1') -OutputDirectory $OutputDirectory
}
$env:PYTHONIOENCODING = 'utf-8'
& $VoicePython -u (Join-Path $PSScriptRoot 'app.py') --wai-root $WaiRoot --env-file $VoiceConfiguration --data-dir $DataDirectory --output $OutputDirectory --port $Port --max-turns 8 --max-responses 16
exit $LASTEXITCODE
