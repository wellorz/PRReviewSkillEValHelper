$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

$defaultUrl = 'http://localhost:3000'
try {
    $response = Invoke-WebRequest -Uri $defaultUrl -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200 -and $response.Content -match '<title>Review Skill Lab</title>') {
        Write-Host "Review Skill Lab is already running. Opening $defaultUrl"
        Start-Process -FilePath $defaultUrl
        return
    }
}
catch [System.Net.WebException] {
    Write-Host "No ready app at ${defaultUrl}: $($_.Exception.Message)"
}

$npm = (Get-Command npm.cmd).Source
$localUrl = $null
$browserOpened = $false
Write-Host 'Starting the web app and evaluation worker. Keep this window open.'

& $npm run dev:all | ForEach-Object {
    $line = $_.ToString()
    Write-Host $line
    $plainLine = $line -replace '\x1b\[[0-9;]*m', ''

    if ($plainLine -match '\[web\].*-\s+Local:\s+(https?://\S+)') {
        $localUrl = $Matches[1]
    }

    if (-not $browserOpened -and $localUrl -and $plainLine -match '\[web\].*\bReady\b') {
        Start-Process -FilePath $localUrl
        $browserOpened = $true
    }
}

if ($LASTEXITCODE -ne 0) {
    throw "Review Skill Lab exited with code $LASTEXITCODE."
}
if (-not $browserOpened) {
    throw 'The web server exited before announcing readiness.'
}
