param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'fixtures'))
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Add-Type -AssemblyName System.Speech
$qwenSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $qwenSynth.SelectVoice('Microsoft Huihui Desktop')
    $qwenFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $qwenTexts = @{ greeting = '你好，我今天完成了一个很难的项目，特别开心。你能鼓励我两句吗？'; continuous = '我今天完成了一个很难的项目特别开心请你鼓励我两句'; interrupt = '等一下，请先停一下。' }
    foreach ($qwenName in $qwenTexts.Keys) {
        $qwenSynth.SetOutputToWaveFile((Join-Path $OutputDirectory "$qwenName.wav"), $qwenFormat)
        $qwenPrompt = New-Object System.Speech.Synthesis.PromptBuilder([System.Globalization.CultureInfo]::GetCultureInfo('zh-CN'))
        $qwenPrompt.AppendBreak([TimeSpan]::FromMilliseconds(200))
        $qwenPrompt.AppendText($qwenTexts[$qwenName])
        $qwenTail = if ($qwenName -eq 'continuous') { 1500 } else { 650 }
        $qwenPrompt.AppendBreak([TimeSpan]::FromMilliseconds($qwenTail))
        $qwenSynth.Speak($qwenPrompt)
        $qwenSynth.SetOutputToNull()
    }
} finally { $qwenSynth.Dispose() }
