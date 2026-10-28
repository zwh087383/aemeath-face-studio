param([int]$Port = 18820, [string]$AssetRoot = '')
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $AssetRoot) {
    $AssetRoot = $taskRoot
    if (-not (Test-Path -LiteralPath (Join-Path $AssetRoot 'assets\Aemeath'))) {
        $AssetRoot = Join-Path (Split-Path $taskRoot -Parent) 'face'
    }
}
$AssetRoot = (Resolve-Path -LiteralPath $AssetRoot).Path
foreach ($relative in @('assets\Aemeath', 'outputs\native-complete-20261022', 'outputs\native-motion-20261022', 'outputs\action-execution-preparation-20261023\face-playback.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $AssetRoot $relative))) { throw "Missing local asset: $relative. Set -AssetRoot to the existing private asset checkout." }
}
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'preview\node_modules\three'))) {
    throw 'Missing preview dependencies. Run npm ci in preview first.'
}
$node = (Get-Command node -ErrorAction Stop).Source
Write-Host "Local experimental preview: http://127.0.0.1:$Port/library-expansion/"
Write-Host 'No cloud model calls. Private assets are read locally. Ctrl+C stops this server.'
Push-Location $taskRoot
try { & $node 'realtime/library-expansion/server.mjs' '--port' $Port '--asset-root' $AssetRoot }
finally { Pop-Location }
