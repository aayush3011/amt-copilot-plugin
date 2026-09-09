# mh-config.ps1 - shared config for the Memory House plugin hook helpers (dot-sourced).
#
# Windows twin of mh-config.sh. The plugin authenticates to Memory House through the gateway's
# hook-token flow: no Entra client id, no OAuth here. Sign-in is a one-time enrollment (the
# agent calls the enroll_hook_capture MCP tool for a code; mh-login.ps1 redeems it). One
# source of truth for amt-token/mh-login/mh-logout/inject/capture.
# See Docs/amt-hook-token-contract.md.

# Single source of truth for the gateway is the plugin's mcp.json - the one URL the customer
# configures. Derive the data-plane base from it (strip the trailing /mcp[/]); AMT_GATEWAY_BASE
# overrides for tests / local dev. Windows twin of mh-config.sh.
function Get-AmtGatewayBaseFromMcp {
  $mcp = Join-Path $PSScriptRoot '..\..\mcp.json'
  if (-not (Test-Path $mcp)) { return $null }
  try {
    $url = (Get-Content -Raw -Path $mcp | ConvertFrom-Json).mcpServers.'memory-house'.url
    if ($url) { return ($url -replace '/mcp/?$', '' -replace '/$', '') }
  } catch { }
  return $null
}

$script:AmtGatewayBase = if ($env:AMT_GATEWAY_BASE) { $env:AMT_GATEWAY_BASE.TrimEnd('/') } else { Get-AmtGatewayBaseFromMcp }
if (-not $script:AmtGatewayBase) { [Console]::Error.WriteLine('mh-config: gateway not configured (no memory-house url in mcp.json); set AMT_GATEWAY_BASE') }
$script:AmtHookBase    = if ($env:AMT_HOOK_BASE)    { $env:AMT_HOOK_BASE }    else { "$script:AmtGatewayBase/hook" }

$script:AmtCopilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' }
$script:AmtHome        = Join-Path $script:AmtCopilotHome 'amt'
$script:AmtTokenCache  = Join-Path $script:AmtHome 'token.json'

$script:AmtTokenSkewSeconds = if ($env:AMT_TOKEN_SKEW_SECONDS) { [int]$env:AMT_TOKEN_SKEW_SECONDS } else { 120 }

$script:AmtLockDir          = "$script:AmtTokenCache.lock"
$script:AmtLockTimeoutMs    = if ($env:AMT_LOCK_TIMEOUT_DS) { [int]$env:AMT_LOCK_TIMEOUT_DS * 100 } else { 10000 }
$script:AmtLockStaleSeconds = if ($env:AMT_LOCK_STALE_SECONDS) { [int]$env:AMT_LOCK_STALE_SECONDS } else { 60 }

function Enter-AmtLock {
  $deadline = (Get-Date).AddMilliseconds($script:AmtLockTimeoutMs)
  while ((Get-Date) -lt $deadline) {
    try {
      New-Item -ItemType Directory -Path $script:AmtLockDir -ErrorAction Stop | Out-Null
      return $true
    } catch { }
    try {
      $age = ((Get-Date).ToUniversalTime() - (Get-Item $script:AmtLockDir -ErrorAction Stop).LastWriteTimeUtc).TotalSeconds
      if ($age -ge $script:AmtLockStaleSeconds) {
        Remove-Item -Recurse -Force $script:AmtLockDir -ErrorAction SilentlyContinue
        continue
      }
    } catch { }
    Start-Sleep -Milliseconds 100
  }
  return $false
}

function Exit-AmtLock {
  Remove-Item -Recurse -Force $script:AmtLockDir -ErrorAction SilentlyContinue
}

# mh-token.ps1 reports why it failed on stderr via [Console]::Error, which bypasses the
# PowerShell error stream for an in-process call. Capture it so hooks can log the reason
# instead of a bare "no-hook-token".
function Get-AmtTokenWithReason {
  $writer = New-Object System.IO.StringWriter
  $previous = [Console]::Error
  [Console]::SetError($writer)
  try { $tok = & (Join-Path $PSScriptRoot 'mh-token.ps1') }
  catch { $tok = $null }
  finally { [Console]::SetError($previous) }
  $tok = @($tok) | Where-Object { $_ } | Select-Object -Last 1
  $reason = (($writer.ToString() -replace '^mh-token:\s*', '') -replace '\s+', ' ').Trim()
  return [pscustomobject]@{ Token = $tok; Reason = $reason }
}
