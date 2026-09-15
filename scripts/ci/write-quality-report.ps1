$ErrorActionPreference = "Stop"

if (-not $env:GITHUB_STEP_SUMMARY) {
  throw "GITHUB_STEP_SUMMARY is required."
}

$tick = [char]96
@(
  "## Repository Quality"
  ""
  "- Source run: $env:SOURCE_RUN_URL"
  "- Conclusion: **$env:SOURCE_CONCLUSION**"
  "- Commit: $tick$env:SOURCE_SHA$tick"
) | Add-Content $env:GITHUB_STEP_SUMMARY

if (Test-Path "artifacts\quality-summary.json") {
  @(
    ""
    "### Machine-readable signal"
    "$tick$tick${tick}json"
  ) | Add-Content $env:GITHUB_STEP_SUMMARY
  Get-Content "artifacts\quality-summary.json" |
    Add-Content $env:GITHUB_STEP_SUMMARY
  "$tick$tick$tick" | Add-Content $env:GITHUB_STEP_SUMMARY
}

