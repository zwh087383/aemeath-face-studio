param(
    [string]$BaseUrl = 'http://127.0.0.1:18797',
    [ValidatePattern('^[a-z0-9-]+$')][string]$Session = 'activity-execution-check',
    [string]$OutputDirectory = 'outputs/action-execution-preparation-20261023/browser-activity-parts',
    [switch]$Resume,
    [ValidateRange(0, 100)][int]$MaximumBatches = 0
)
$ErrorActionPreference = 'Stop'
if ((Get-Location).Path -ne (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path) { throw 'Run from the face repository root' }
if (-not $Resume) {
    if (Test-Path -LiteralPath (Join-Path $OutputDirectory 'plan.json')) { throw 'Output already has a plan. Use a new directory, or Resume after verifying the same source.' }
    & node scripts/action-preparation/activity-browser-plan.mjs plan $OutputDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare frozen-source acceptance plan' }
}
$plan = Get-Content -LiteralPath (Join-Path $OutputDirectory 'plan.json') -Raw | ConvertFrom-Json
& node scripts/action-preparation/activity-browser-plan.mjs check $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Frozen-source verification failed. Keep old evidence and inspect the diagnostic.' }
$previousErrorPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { $sessionProbe = & playwright-cli "-s=$Session" snapshot 2>&1 }
finally { $ErrorActionPreference = $previousErrorPreference }
if ($LASTEXITCODE -eq 0 -and ($sessionProbe -join "`n") -notmatch '### Error') {
    $opened = & playwright-cli "-s=$Session" goto "$BaseUrl/activities/"
} else {
    $opened = & playwright-cli "-s=$Session" open "$BaseUrl/activities/"
}
if ($LASTEXITCODE -ne 0 -or ($opened -join "`n") -match '### Error') { throw 'Unable to open isolated activity browser' }
$completedNow = 0
foreach ($batch in $plan.batches) {
    $receiptPath = Join-Path $OutputDirectory ($batch.id + '.json')
    if ($Resume -and (Test-Path -LiteralPath $receiptPath)) {
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        if ($receipt.planHash -ne $plan.planHash -or -not $receipt.report.passed) { throw "Existing batch is stale or failed: $($batch.id)" }
        continue
    }
    if (@($batch.activities) + @($batch.sequences) | Where-Object { $_ -notmatch '^[a-z0-9_]+$' }) { throw 'Unexpected identifier in the frozen source plan' }
    $activityNames = (@($batch.activities) | ForEach-Object { "'$_'" }) -join ','
    $sequenceNames = (@($batch.sequences) | ForEach-Object { "'$_'" }) -join ','
    $scope = "{activities:[$activityNames],sequences:[$sequenceNames]}"
    $scopeResult = & playwright-cli "-s=$Session" eval "window.activityPreparationScope=$scope"
    if ($LASTEXITCODE -ne 0 -or ($scopeResult -join "`n") -match '### Error') { throw "Could not set batch scope: $($batch.id)" }
    $lines = & playwright-cli "-s=$Session" run-code --filename=scripts/action-preparation/browser-activity-execution.cjs
    $lines | Set-Content -LiteralPath (Join-Path $OutputDirectory ($batch.id + '.cli.txt')) -Encoding utf8
    $match = [regex]::Match(($lines -join "`n"), '(?s)### Result\s*(.*?)\s*### Ran Playwright code')
    if ($LASTEXITCODE -ne 0 -or -not $match.Success) { throw "No completed browser result: $($batch.id)" }
    $report = $match.Groups[1].Value | ConvertFrom-Json
    @{ batchId = $batch.id; planHash = $plan.planHash; report = $report } | ConvertTo-Json -Depth 70 | Set-Content -LiteralPath $receiptPath -Encoding utf8
    Write-Output "$($batch.id): passed=$($report.passed), activities=$($report.activities.Count), sequences=$($report.sequences.Count)"
    if (-not $report.passed) { throw "Actual browser verification failed: $($batch.id). The failed result was preserved." }
    $completedNow++
    if ($MaximumBatches -gt 0 -and $completedNow -ge $MaximumBatches) {
        Write-Output 'Explicit partial run finished; no full-library acceptance was produced.'
        return
    }
}
& node scripts/action-preparation/activity-browser-plan.mjs verify $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Final source and coverage verification failed' }
