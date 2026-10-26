param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$CenterFixtures=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'inputs.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$CenterInputs=[IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($CenterInputs) | Out-Null
if (Test-Path -LiteralPath (Join-Path $CenterInputs 'input-fixtures.json')) { Write-Output 'Inputs already prepared; preserving evidence.'; return }
$CenterSpeech=New-Object System.Speech.Synthesis.SpeechSynthesizer
$CenterSpeech.SelectVoice('Microsoft Huihui Desktop')
$CenterFormat=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
try {
  foreach ($CenterClip in $CenterFixtures.clips) {
    $CenterTarget=Join-Path $CenterInputs ($CenterClip.id+'.wav')
    if (Test-Path -LiteralPath $CenterTarget) { throw 'Unfinished input generation exists; preserve it for inspection.' }
    $CenterSpeech.SetOutputToWaveFile($CenterTarget,$CenterFormat)
    $CenterSpeech.Speak($CenterClip.text)
    $CenterSpeech.SetOutputToNull()
    $CenterClip | Add-Member -NotePropertyName url -NotePropertyValue ('/parallel-duplex-inputs/'+$CenterClip.id+'.wav')
    $CenterClip | Add-Member -NotePropertyName sha256 -NotePropertyValue (Get-FileHash -LiteralPath $CenterTarget -Algorithm SHA256).Hash.ToLowerInvariant()
  }
} finally { $CenterSpeech.Dispose() }
$CenterFixtures | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $CenterInputs 'input-fixtures.json') -Encoding UTF8
Write-Output 'Prepared 12 user audio inputs locally. No cloud model requested.'
