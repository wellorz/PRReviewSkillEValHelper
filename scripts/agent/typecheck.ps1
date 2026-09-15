$ErrorActionPreference = "Stop"
$output = Join-Path $env:TEMP "pr-review-agent-typecheck-$PID.log"

try {
  & npx tsc --noEmit *> $output
  if ($LASTEXITCODE -ne 0) {
    Get-Content $output
    exit $LASTEXITCODE
  }
  Write-Host "Type-check passed."
} finally {
  Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
}

