#!/usr/bin/env pwsh
# mh-token.ps1 - emit a valid Memory House hook access token on the pipeline, or exit 1.
# Windows twin of mh-token.sh. Non-interactive; safe to call from hooks.
#
# Refresh tokens are single-use and rotate, so the refresh is serialised behind a lock and the
# cache re-read after acquiring it: a concurrent hook may already have rotated the token.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'mh-config.ps1')

function Now-Unix { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

if ($env:AMT_ACCESS_TOKEN) { Write-Output $env:AMT_ACCESS_TOKEN; exit 0 }

if (-not (Test-Path $script:AmtTokenCache)) {
  [Console]::Error.WriteLine('mh-token: not signed in (no cache); run /mh-login'); exit 1
}

function Read-AmtCache {
  if (-not (Test-Path $script:AmtTokenCache)) { return $null }
  try { return Get-Content -Raw -Path $script:AmtTokenCache | ConvertFrom-Json } catch { return $null }
}

function Get-FreshAccess($cache) {
  if (-not $cache -or -not $cache.access_token) { return $null }
  $expiresAt = if ($cache.expires_at) { [int64]$cache.expires_at } else { 0 }
  if ($expiresAt -gt ((Now-Unix) + $script:AmtTokenSkewSeconds)) { return $cache.access_token }
  return $null
}

$cache = Read-AmtCache
$fresh = Get-FreshAccess $cache
if ($fresh) { Write-Output $fresh; exit 0 }
if (-not $cache -or -not $cache.refresh_token) {
  [Console]::Error.WriteLine('mh-token: expired and no refresh token; run /mh-login'); exit 1
}

if (-not (Enter-AmtLock)) {
  $fresh = Get-FreshAccess (Read-AmtCache)
  if ($fresh) { Write-Output $fresh; exit 0 }
  [Console]::Error.WriteLine('mh-token: timed out waiting for a concurrent refresh; will retry'); exit 1
}

try {
  # Re-read under the lock: a concurrent hook may have rotated the token while we waited.
  $cache = Read-AmtCache
  $fresh = Get-FreshAccess $cache
  if ($fresh) { Write-Output $fresh; exit 0 }
  if (-not $cache -or -not $cache.refresh_token) {
    [Console]::Error.WriteLine('mh-token: not signed in (cache cleared); run /mh-login'); exit 1
  }
  $refresh = $cache.refresh_token
  $now = Now-Unix

  $status = 0
  $resp = $null
  try {
    $resp = Invoke-RestMethod -Method Post -Uri "$script:AmtHookBase/refresh" `
      -ContentType 'application/json' -Body (@{ refresh_token = $refresh } | ConvertTo-Json) -TimeoutSec 20
    $status = 200
  } catch {
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  }

  if ($status -eq 401) {
    # invalid_grant: revoked, expired, or already consumed. Nothing will make it work again.
    Remove-Item -Force $script:AmtTokenCache -ErrorAction SilentlyContinue
    [Console]::Error.WriteLine('mh-token: refresh rejected (token revoked or expired); signed out, run /mh-login')
    exit 1
  }
  if ($status -ne 200) {
    # 400, 404 (hook surface disabled), 5xx and transport failures are not the token's fault.
    $why = if ($status) { "HTTP $status" } else { 'network' }
    [Console]::Error.WriteLine("mh-token: refresh failed ($why); keeping cache, will retry")
    exit 1
  }

  $newAccess = $resp.access_token
  if (-not $newAccess) {
    [Console]::Error.WriteLine('mh-token: refresh returned no access token; run /mh-login'); exit 1
  }
  $newRefresh = if ($resp.refresh_token) { $resp.refresh_token } else { $refresh }
  $expiresIn  = if ($resp.expires_in) { [int]$resp.expires_in } else { 1800 }

  New-Item -ItemType Directory -Force -Path $script:AmtHome | Out-Null
  @{ access_token = $newAccess; refresh_token = $newRefresh; expires_at = ($now + $expiresIn); token_type = 'HookToken' } |
    ConvertTo-Json | Set-Content -Path $script:AmtTokenCache -Encoding utf8
  Write-Output $newAccess
} finally {
  Exit-AmtLock
}
