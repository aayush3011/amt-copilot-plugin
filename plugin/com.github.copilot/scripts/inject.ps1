#!/usr/bin/env pwsh
# inject.ps1 - Windows twin of inject.sh. AMT_HOOK_PHASE selects user-turn capture from
# userPromptSubmitted or model-facing recall from userPromptTransformed. Both phases fail open.
$ErrorActionPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'amt-config.ps1')

$phase = if ($env:AMT_HOOK_PHASE) { $env:AMT_HOOK_PHASE } else { 'capture' }
$topK = if ($env:AMT_INJECT_TOP_K) { [int]$env:AMT_INJECT_TOP_K } else { 8 }

function Write-AmtHookLog([string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path $script:AmtHome | Out-Null
    $timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    Add-Content -Path (Join-Path $script:AmtHome 'hook.log') -Value "$timestamp`t$Message" -Encoding utf8
  } catch { }
}

function Write-EmptyAndExit {
  Write-Output '{}'
  exit 0
}

Write-AmtHookLog "${phase}:invoked"
$raw = [Console]::In.ReadToEnd()
if (-not $raw) { Write-AmtHookLog "${phase}:skipped:empty-payload"; Write-EmptyAndExit }
try { $payload = $raw | ConvertFrom-Json -ErrorAction Stop } catch { Write-AmtHookLog "${phase}:skipped:invalid-payload"; Write-EmptyAndExit }

$prompt = $payload.prompt
if (-not $prompt) { $prompt = $payload.userPrompt }
if (-not $prompt) { $prompt = $payload.user_prompt }
if (-not $prompt) { $prompt = $payload.message }
$transformedPrompt = $payload.transformedPrompt
$thread = $payload.sessionId
if (-not $thread) { $thread = $payload.session_id }
if (-not $thread) { $thread = 'copilot-app' }
if (-not $prompt) { Write-AmtHookLog "${phase}:skipped:empty-prompt"; Write-EmptyAndExit }

# Remove agent-facing envelopes before capture and use the sanitized user text as the query.
$userPrompt = [string]$prompt
foreach ($tag in @('system_notification', 'system_reminder', 'skill-context', 'canvas-context')) {
  $userPrompt = [regex]::Replace($userPrompt, "(?is)<$tag\b[^>]*>.*?</$tag>", '')
}
$userPrompt = $userPrompt.Trim()
$skillInvocation = [regex]::Match($userPrompt, '(?is)^The user explicitly invoked the "(?<command>/[^"]+)" skill\.')
if ($skillInvocation.Success) { $userPrompt = $skillInvocation.Groups['command'].Value }
if (-not $userPrompt) { Write-AmtHookLog "${phase}:skipped:notification-only"; Write-EmptyAndExit }

$token = & (Join-Path $PSScriptRoot 'amt-token.ps1')
if (-not $token) { Write-AmtHookLog "${phase}:skipped:no-hook-token"; Write-EmptyAndExit }
$headers = @{ Authorization = "HookToken $token" }

if ($phase -eq 'capture') {
  try {
    Invoke-RestMethod -Method Post -Uri "$script:AmtHookBase/capture" -Headers $headers `
      -ContentType 'application/json' `
      -Body (@{ thread_id = $thread; role = 'user'; content = $userPrompt } | ConvertTo-Json) `
      -TimeoutSec 12 -ErrorAction Stop | Out-Null
    Write-AmtHookLog 'capture:user:ok'
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status) { Write-AmtHookLog "capture:user:http-error:$status" } else { Write-AmtHookLog 'capture:user:transport-error' }
  }
  Write-EmptyAndExit
}

if ($phase -ne 'recall') {
  Write-AmtHookLog "${phase}:skipped:unknown-phase"
  Write-EmptyAndExit
}

try {
  $results = Invoke-RestMethod -Method Post -Uri "$script:AmtHookBase/search" -Headers $headers `
    -ContentType 'application/json' `
    -Body (@{ query = $userPrompt; top_k = $topK } | ConvertTo-Json) `
    -TimeoutSec 12 -ErrorAction Stop
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status) { Write-AmtHookLog "recall:http-error:$status" } else { Write-AmtHookLog 'recall:transport-error' }
  Write-EmptyAndExit
}

$items = @($results.items) | Where-Object { $_ }
if (-not $items -or $items.Count -eq 0) { Write-AmtHookLog 'recall:ok:no-results'; Write-EmptyAndExit }
$sorted = $items | Sort-Object -Property @{ Expression = { if ($_.similarity_score) { $_.similarity_score } else { 0 } } } -Descending
$lines = ($sorted | ForEach-Object {
  $content = $_.content
  if (-not $content) { $content = $_.text }
  if ($content) { "- $content" }
}) -join "`n"
if (-not $lines) { Write-AmtHookLog 'recall:ok:no-results'; Write-EmptyAndExit }

$modelPrompt = [string]$transformedPrompt
if (-not $modelPrompt) { $modelPrompt = [string]$prompt }
$modifiedPrompt = "$modelPrompt`n`n<amt-memory-context>`nRelevant memory for this developer (from AMT):`n$lines`n</amt-memory-context>"
Write-AmtHookLog 'recall:ok:context-injected'
@{ modifiedTransformedPrompt = $modifiedPrompt } | ConvertTo-Json -Compress
