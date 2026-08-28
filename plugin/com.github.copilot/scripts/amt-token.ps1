#!/usr/bin/env pwsh
# amt-token.ps1 - emit a valid AMT hook access token on the pipeline, or exit 1.
# Windows twin of amt-token.sh. Non-interactive; safe to call from hooks.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'amt-config.ps1')

function Now-Unix { [int][double]::Parse((Get-Date -UFormat %s)) }

if ($env:AMT_ACCESS_TOKEN) { Write-Output $env:AMT_ACCESS_TOKEN; exit 0 }

if (-not (Test-Path $script:AmtTokenCache)) {
  [Console]::Error.WriteLine('amt-token: not signed in (no cache); run /amt-login'); exit 1
}

try { $cache = Get-Content -Raw -Path $script:AmtTokenCache | ConvertFrom-Json } catch { exit 1 }

$now       = Now-Unix
$access    = $cache.access_token
$expiresAt = if ($cache.expires_at) { [int64]$cache.expires_at } else { 0 }
$refresh   = $cache.refresh_token

if ($access -and ($expiresAt -gt ($now + $script:AmtTokenSkewSeconds))) { Write-Output $access; exit 0 }

if (-not $refresh) { [Console]::Error.WriteLine('amt-token: expired and no refresh token; run /amt-login'); exit 1 }

try {
  $resp = Invoke-RestMethod -Method Post -Uri "$script:AmtHookBase/refresh" `
    -ContentType 'application/json' -Body (@{ refresh_token = $refresh } | ConvertTo-Json) -TimeoutSec 20
} catch { [Console]::Error.WriteLine('amt-token: refresh failed; run /amt-login'); exit 1 }

$newAccess = $resp.access_token
if (-not $newAccess) { [Console]::Error.WriteLine('amt-token: refresh failed; run /amt-login'); exit 1 }
$newRefresh = if ($resp.refresh_token) { $resp.refresh_token } else { $refresh }
$expiresIn  = if ($resp.expires_in) { [int]$resp.expires_in } else { 1800 }

New-Item -ItemType Directory -Force -Path $script:AmtHome | Out-Null
@{ access_token = $newAccess; refresh_token = $newRefresh; expires_at = ($now + $expiresIn); token_type = 'HookToken' } |
  ConvertTo-Json | Set-Content -Path $script:AmtTokenCache -Encoding utf8
Write-Output $newAccess
