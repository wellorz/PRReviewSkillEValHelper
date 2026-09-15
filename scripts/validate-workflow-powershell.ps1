$ErrorActionPreference = "Stop"

$scripts = @(
  Get-ChildItem -Path (Join-Path $PSScriptRoot "ci") -Filter "*.ps1"
  Get-ChildItem -Path (Join-Path $PSScriptRoot "agent") -Filter "*.ps1"
  Get-Item (Join-Path $PSScriptRoot "setup.ps1")
)

$failed = $false
foreach ($script in $scripts) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile(
    $script.FullName,
    [ref]$tokens,
    [ref]$errors
  ) | Out-Null
  foreach ($error in $errors) {
    Write-Error "$($script.FullName): $($error.Message)"
    $failed = $true
  }
}

if ($failed) {
  exit 1
}

Write-Host "Workflow PowerShell syntax is valid."
