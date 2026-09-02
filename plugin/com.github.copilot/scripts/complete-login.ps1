#!/usr/bin/env pwsh
# Windows postToolUse twin of complete-login.sh. Redeems the credential and replaces the
# MCP result before it reaches the model.
$ErrorActionPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'amt-config.ps1')

function Write-AmtHookLog([string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path $script:AmtHome | Out-Null
    $timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    Add-Content -Path (Join-Path $script:AmtHome 'hook.log') -Value "$timestamp`t$Message" -Encoding utf8
  } catch { }
}

function Write-SafeResult([string]$Message) {
  @{ modifiedResult = @{ resultType = 'success'; textResultForLlm = $Message } } | ConvertTo-Json -Compress -Depth 4
}

Write-AmtHookLog 'login:auto:invoked'
$raw = [Console]::In.ReadToEnd()
try { $payload = $raw | ConvertFrom-Json -ErrorAction Stop } catch {
  Write-AmtHookLog 'login:auto:failed:invalid-payload'
  Write-SafeResult 'AMT sign-in could not read the enrollment result. Call enroll_hook_capture once more. Never display enrollment credentials.'
  exit 0
}

$resultText = $payload.toolResult.textResultForLlm
if (-not $resultText) { $resultText = $payload.tool_result.text_result_for_llm }
if (-not $resultText) { $resultText = $payload.toolResult.text }
if (-not $resultText) { $resultText = $payload.tool_result.text }

$code = $null
try { $code = ($resultText | ConvertFrom-Json -ErrorAction Stop).enrollment_code } catch { }
if (-not $code) {
  Write-AmtHookLog 'login:auto:failed:credential-missing'
  Write-SafeResult 'AMT sign-in could not extract the enrollment credential. Call enroll_hook_capture once more. Never display enrollment credentials.'
  exit 0
}

$previousCode = $env:AMT_ENROLLMENT_CODE
$env:AMT_ENROLLMENT_CODE = [string]$code
try {
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'amt-login.ps1') *> $null
  $loginExitCode = $LASTEXITCODE
} finally {
  if ($null -eq $previousCode) { Remove-Item Env:AMT_ENROLLMENT_CODE -ErrorAction SilentlyContinue }
  else { $env:AMT_ENROLLMENT_CODE = $previousCode }
}

if ($loginExitCode -eq 0) {
  Write-AmtHookLog 'login:auto:ok'
  Write-SafeResult 'AMT sign-in completed locally. The enrollment credential was redeemed and must not be displayed. Tell the user: Signed in to AMT memory. Capture and recall are now active on this device.'
} else {
  Write-AmtHookLog 'login:auto:failed:redeem'
  Write-SafeResult 'AMT sign-in was not completed because the enrollment credential was invalid or expired. Call enroll_hook_capture one more time; the automatic login hook will redeem the new credential. Never display enrollment credentials.'
}
