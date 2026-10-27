param([Parameter(Mandatory=$true)][string]$Manifest,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$CampaignManifest=Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$CampaignOutput=[IO.Path]::GetFullPath($OutputDirectory)
$CampaignSpeech=New-Object System.Speech.Synthesis.SpeechSynthesizer
$CampaignSpeech.SelectVoice('Microsoft Huihui Desktop')
$CampaignFormat=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
try {
 foreach($CampaignCase in $CampaignManifest.scenarios){
  $CampaignInputs=Join-Path $CampaignOutput ('cases\'+$CampaignCase.id+'\inputs')
  [IO.Directory]::CreateDirectory($CampaignInputs)|Out-Null
  $CampaignIndex=Join-Path $CampaignInputs 'input-fixtures.json'
  if(Test-Path -LiteralPath $CampaignIndex){continue}
  $CampaignClips=@()
  foreach($CampaignTurn in $CampaignCase.turns){
   $CampaignFile=Join-Path $CampaignInputs ($CampaignTurn.id+'.wav')
   if(Test-Path -LiteralPath $CampaignFile){throw 'Partial input exists; inspect before retrying.'}
   $CampaignSpeech.SetOutputToWaveFile($CampaignFile,$CampaignFormat)
   $CampaignSpeech.Speak($CampaignTurn.text)
   $CampaignSpeech.SetOutputToNull()
   $CampaignClips+=@{id=$CampaignTurn.id;text=$CampaignTurn.text;group='campaign';url=('/parallel-duplex-inputs/'+$CampaignTurn.id+'.wav');sha256=(Get-FileHash -LiteralPath $CampaignFile -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
  @{clips=$CampaignClips;source='Local Windows Microsoft Huihui Desktop 16k mono PCM';scenario=$CampaignCase.id}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $CampaignIndex -Encoding UTF8
 }
} finally {$CampaignSpeech.Dispose()}
Write-Output 'Prepared 180 local user audio fixtures. No cloud generation.'
