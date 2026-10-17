param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$clips = [ordered]@{
  'memory-drink' = '你还记得我在星桥咖啡店最喜欢喝什么吗？'
  'social' = '早上好呀，今天见到你很开心。'
  'followup' = '那刚才说的这杯饮料适合什么时候喝呢？'
  'memory-appointment' = '星桥读书会预约几点座位是几号？'
  'greet' = '好呀先跟我挥挥手打个招呼吧。'
  'long' = '请详细讲讲星桥练习项目里三张角色表情草图的绘制步骤，大概说二十秒。'
  'barge' = '等一下先别讲步骤了，我的蓝色笔记本一共有几本？'
}
$directory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($directory) | Out-Null
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speech.SelectVoice('Microsoft Huihui Desktop')
$speech.Rate = 0
$speech.Volume = 100
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$rows = @()
try {
  foreach ($entry in $clips.GetEnumerator()) {
    $target = Join-Path $directory ($entry.Key + '.wav')
    if(Test-Path -LiteralPath $target){throw 'Input fixture exists; preserve it instead of overwriting.'}
    $speech.SetOutputToWaveFile($target, $format)
    $speech.Speak($entry.Value)
    $speech.SetOutputToNull()
    $rows += [ordered]@{id=$entry.Key; text=$entry.Value; sampleRate=16000; sha256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()}
  }
} finally { $speech.Dispose() }
[ordered]@{source='Local Windows System.Speech / Microsoft Huihui Desktop';purpose='Only user questions; model answers are freely generated live';clips=$rows} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $directory 'input-fixtures.json') -Encoding UTF8
$rows | Select-Object id,sampleRate | Format-Table
