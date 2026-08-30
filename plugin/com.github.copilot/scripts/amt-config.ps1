# amt-config.ps1 - shared config for the AMT plugin hook helpers (dot-sourced).
#
# Windows twin of amt-config.sh. The plugin authenticates to AMT through the gateway's
# hook-token flow: no Entra client id, no OAuth here. Sign-in is a one-time enrollment (the
# agent calls the enroll_hook_capture MCP tool for a code; amt-login.ps1 redeems it). One
# source of truth for amt-token/amt-login/amt-logout/inject/capture.
# See Docs/amt-hook-token-contract.md.

# Single source of truth for the gateway is the plugin's mcp.json - the one URL the customer
# configures. Derive the data-plane base from it (strip the trailing /mcp[/]); AMT_GATEWAY_BASE
# overrides for tests / local dev. Windows twin of amt-config.sh.
function Get-AmtGatewayBaseFromMcp {
  $mcp = Join-Path $PSScriptRoot '..\..\mcp.json'
  if (-not (Test-Path $mcp)) { return $null }
  try {
    $url = (Get-Content -Raw -Path $mcp | ConvertFrom-Json).mcpServers.'amt-memory'.url
    if ($url) { return ($url -replace '/mcp/?$', '' -replace '/$', '') }
  } catch { }
  return $null
}

$script:AmtGatewayBase = if ($env:AMT_GATEWAY_BASE) { $env:AMT_GATEWAY_BASE.TrimEnd('/') } else { Get-AmtGatewayBaseFromMcp }
if (-not $script:AmtGatewayBase) { [Console]::Error.WriteLine('amt-config: gateway not configured (no amt-memory url in mcp.json); set AMT_GATEWAY_BASE') }
$script:AmtHookBase    = if ($env:AMT_HOOK_BASE)    { $env:AMT_HOOK_BASE }    else { "$script:AmtGatewayBase/hook" }

$script:AmtCopilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' }
$script:AmtHome        = Join-Path $script:AmtCopilotHome 'amt'
$script:AmtTokenCache  = Join-Path $script:AmtHome 'token.json'

$script:AmtTokenSkewSeconds = if ($env:AMT_TOKEN_SKEW_SECONDS) { [int]$env:AMT_TOKEN_SKEW_SECONDS } else { 120 }
