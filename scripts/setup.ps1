$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required. Install the version declared in .nvmrc."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required."
}

$requiredNodeMajor = [int](
  (Get-Content (Join-Path $PSScriptRoot "..\.nvmrc")).Trim()
)
$actualNodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
if ($actualNodeMajor -ne $requiredNodeMajor) {
  throw "Node.js $requiredNodeMajor is required; found $(node --version)."
}

Push-Location (Join-Path $PSScriptRoot "..")
try {
  npm ci
  if ($LASTEXITCODE -ne 0) {
    throw "npm ci failed with exit code $LASTEXITCODE."
  }
  Write-Host "Repository dependencies are ready. Start the UI and worker with: npm run dev:all"
} finally {
  Pop-Location
}
