param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$ModelFixtures = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'inputs.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ModelInputs = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($ModelInputs) | Out-Null
$ModelSpeech = New-Object System.Speech.Synthesis.SpeechSynthesizer
$ModelSpeech.SelectVoice('Microsoft Huihui Desktop')
$ModelFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
try {
    foreach ($ModelClip in $ModelFixtures.clips) {
        $ModelTarget = Join-Path $ModelInputs ($ModelClip.id + '.wav')
        if (Test-Path -LiteralPath $ModelTarget) { throw 'Input exists; no overwrite of evidence.' }
        $ModelSpeech.SetOutputToWaveFile($ModelTarget,$ModelFormat)
        $ModelSpeech.Speak($ModelClip.text)
        $ModelSpeech.SetOutputToNull()
        $ModelClip | Add-Member -NotePropertyName sampleRate -NotePropertyValue 16000
        $ModelClip | Add-Member -NotePropertyName url -NotePropertyValue ('/parallel-duplex-inputs/' + $ModelClip.id + '.wav')
        $ModelClip | Add-Member -NotePropertyName sha256 -NotePropertyValue (Get-FileHash -LiteralPath $ModelTarget -Algorithm SHA256).Hash.ToLowerInvariant()
    }
} finally { $ModelSpeech.Dispose() }
$ModelFixtures | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $ModelInputs 'input-fixtures.json') -Encoding UTF8
Write-Output 'Prepared three user questions locally; no cloud requests.'
