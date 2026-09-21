$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$botNode = (Get-Command node -ErrorAction Stop).Source
$botLogDir = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $botLogDir -Force | Out-Null
$botLogFile = Join-Path $botLogDir ('worker-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
& $botNode (Join-Path $PSScriptRoot 'run.js') *>> $botLogFile
exit $LASTEXITCODE
