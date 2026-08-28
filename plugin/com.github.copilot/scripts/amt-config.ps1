# amt-config.ps1 - shared config for the AMT plugin hook helpers (dot-sourced).
#
# Windows twin of amt-config.sh. The plugin authenticates to AMT through the gateway's
# hook-token flow: no Entra client id, no OAuth here. Sign-in is a one-time enrollment (the
# agent calls the enroll_hook_capture MCP tool for a code; amt-login.ps1 redeems it). One
# source of truth for amt-token/amt-login/amt-logout/inject/capture.
# See Docs/amt-hook-token-contract.md.

$script:AmtGatewayBase = if ($env:AMT_GATEWAY_BASE) { $env:AMT_GATEWAY_BASE } else { 'https://reranker-api-h2b5czhkfkcphnf4.westus3-01.azurewebsites.net/inference/memory' }
$script:AmtHookBase    = if ($env:AMT_HOOK_BASE)    { $env:AMT_HOOK_BASE }    else { "$script:AmtGatewayBase/hook" }

$script:AmtCopilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' }
$script:AmtHome        = Join-Path $script:AmtCopilotHome 'amt'
$script:AmtTokenCache  = Join-Path $script:AmtHome 'token.json'

$script:AmtTokenSkewSeconds = if ($env:AMT_TOKEN_SKEW_SECONDS) { [int]$env:AMT_TOKEN_SKEW_SECONDS } else { 120 }
