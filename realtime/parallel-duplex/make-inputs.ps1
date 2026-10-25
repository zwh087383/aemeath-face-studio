param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$ParallelFixture = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'inputs.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ParallelInputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($ParallelInputDirectory) | Out-Null
$ParallelSpeech = New-Object System.Speech.Synthesis.SpeechSynthesizer
$ParallelSpeech.SelectVoice('Microsoft Huihui Desktop')
$ParallelSpeech.Rate = 0
$ParallelSpeech.Volume = 100
$ParallelFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
try {
    foreach ($ParallelClip in $ParallelFixture.clips) {
        $ParallelTarget = Join-Path $ParallelInputDirectory ($ParallelClip.id + '.wav')
        if (Test-Path -LiteralPath $ParallelTarget) { throw 'Input already exists; do not overwrite recorded evidence.' }
        $ParallelSpeech.SetOutputToWaveFile($ParallelTarget, $ParallelFormat)
        $ParallelSpeech.Speak($ParallelClip.text)
        $ParallelSpeech.SetOutputToNull()
        $ParallelClip | Add-Member -NotePropertyName sampleRate -NotePropertyValue 16000
        $ParallelClip | Add-Member -NotePropertyName url -NotePropertyValue ('/parallel-duplex-inputs/' + $ParallelClip.id + '.wav')
        $ParallelClip | Add-Member -NotePropertyName sha256 -NotePropertyValue (Get-FileHash -LiteralPath $ParallelTarget -Algorithm SHA256).Hash.ToLowerInvariant()
    }
} finally { $ParallelSpeech.Dispose() }
$ParallelFixture | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $ParallelInputDirectory 'input-fixtures.json') -Encoding UTF8
Write-Output ('Prepared ' + $ParallelFixture.clips.Count + ' local user-question fixtures; no cloud call.')
