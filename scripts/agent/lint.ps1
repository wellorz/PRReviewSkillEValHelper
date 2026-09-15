$ErrorActionPreference = "Stop"
$output = Join-Path $env:TEMP "pr-review-agent-lint-$PID.log"

try {
  & npm run lint *> $output
  if ($LASTEXITCODE -ne 0) {
    Get-Content $output
    exit $LASTEXITCODE
  }
  Write-Host "Lint passed."
} finally {
  Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
}

