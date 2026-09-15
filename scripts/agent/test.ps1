$ErrorActionPreference = "Stop"
$output = Join-Path $env:TEMP "pr-review-agent-test-$PID.log"

try {
  & npm test *> $output
  if ($LASTEXITCODE -ne 0) {
    Get-Content $output
    exit $LASTEXITCODE
  }
  Write-Host "Tests passed."
} finally {
  Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
}

