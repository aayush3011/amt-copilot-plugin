#!/usr/bin/env pwsh
# amt-logout.ps1 - sign out of AMT memory: revoke the hook token and clear the local cache.
# Windows twin of amt-logout.sh.
$ErrorActionPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'amt-config.ps1')

if (-not (Test-Path $script:AmtTokenCache)) { Write-Output '  Not signed in (no local token).'; exit 0 }

try {
  $cache = Get-Content -Raw -Path $script:AmtTokenCache | ConvertFrom-Json
  if ($cache.refresh_token) {
    Invoke-RestMethod -Method Post -Uri "$script:AmtHookBase/revoke" `
      -ContentType 'application/json' -Body (@{ refresh_token = $cache.refresh_token } | ConvertTo-Json) -TimeoutSec 15 | Out-Null
  }
} catch { }

Remove-Item -Force -Path $script:AmtTokenCache -ErrorAction SilentlyContinue
Write-Output '  Signed out of AMT memory (token revoked and local cache cleared).'
