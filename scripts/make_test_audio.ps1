$ErrorActionPreference = 'Stop'
$taskFaceRoot = Split-Path -Parent $PSScriptRoot
Add-Type -AssemblyName System.Speech
$taskSpeech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $taskSpeech.SelectVoice('Microsoft Huihui Desktop')
    $taskSpeech.Rate = 0
    $taskAudioPath = Join-Path $taskFaceRoot 'audio\chinese-probe.wav'
    $taskFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $taskSpeech.SetOutputToWaveFile($taskAudioPath, $taskFormat)
    $taskPrompt = New-Object System.Speech.Synthesis.PromptBuilder
    $taskPrompt.AppendBreak([TimeSpan]::FromMilliseconds(350))
    $taskPrompt.AppendText('爸爸把杯子摆好了。我去取一杯热水。嗯，我想一想。好吧，我们慢慢说。啊，衣，乌，诶，哦。')
    $taskPrompt.AppendBreak([TimeSpan]::FromMilliseconds(500))
    $taskSpeech.Speak($taskPrompt)
    $taskSpeech.SetOutputToNull()
    Write-Output $taskAudioPath
} finally {
    $taskSpeech.Dispose()
}
