#!/usr/bin/env pwsh
# amt-login.ps1 <enrollment_code> - complete AMT hook sign-in by redeeming an enrollment code.
# Windows twin of amt-login.sh. Get a code first by calling the enroll_hook_capture MCP tool.
param([string]$EnrollmentCode)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'amt-config.ps1')

if (-not $EnrollmentCode) { $EnrollmentCode = $env:AMT_ENROLLMENT_CODE }
if (-not $EnrollmentCode) {
  [Console]::Error.WriteLine('usage: amt-login.ps1 <enrollment_code>  (get a code from the enroll_hook_capture MCP tool)')
  exit 2
}

try {
  $resp = Invoke-RestMethod -Method Post -Uri "$script:AmtHookBase/redeem" `
    -ContentType 'application/json' -Body (@{ enrollment_code = $EnrollmentCode } | ConvertTo-Json) -TimeoutSec 20
} catch { [Console]::Error.WriteLine('amt-login: enrollment failed (invalid or expired code). Get a fresh code and retry.'); exit 1 }

if (-not $resp.access_token -or -not $resp.refresh_token) {
  [Console]::Error.WriteLine('amt-login: enrollment failed (invalid or expired code). Get a fresh code and retry.'); exit 1
}
$expiresIn = if ($resp.expires_in) { [int]$resp.expires_in } else { 1800 }
$expiresAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + $expiresIn

New-Item -ItemType Directory -Force -Path $script:AmtHome | Out-Null

# Signing in is the recovery path for a wedged cache, so drop whatever was there and take the
# refresh lock: an in-flight hook refresh must not overwrite the token we are about to write.
Remove-Item -Force $script:AmtTokenCache -ErrorAction SilentlyContinue
$locked = Enter-AmtLock
try {
  @{ access_token = $resp.access_token; refresh_token = $resp.refresh_token; expires_at = $expiresAt; token_type = 'HookToken' } |
    ConvertTo-Json | Set-Content -Path $script:AmtTokenCache -Encoding utf8
} finally {
  if ($locked) { Exit-AmtLock }
}
Write-Output '  Signed in to AMT memory. Capture and recall are now active for this device.'
