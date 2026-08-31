#!/usr/bin/env pwsh
# inject.ps1 - userPromptSubmitted hook (Windows twin of inject.sh). Captures the user turn
# and recalls relevant memory as additionalContext. Auth: Authorization: HookToken <access>.
$ErrorActionPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'amt-config.ps1')
$topK = if ($env:AMT_INJECT_TOP_K) { [int]$env:AMT_INJECT_TOP_K } else { 8 }

$raw = [Console]::In.ReadToEnd()
if (-not $raw) { Write-Output '{}'; exit 0 }
try { $payload = $raw | ConvertFrom-Json } catch { Write-Output '{}'; exit 0 }

$prompt = $payload.prompt; if (-not $prompt) { $prompt = $payload.userPrompt }; if (-not $prompt) { $prompt = $payload.message }
$thread = $payload.sessionId; if (-not $thread) { $thread = 'copilot-app' }
if (-not $prompt) { Write-Output '{}'; exit 0 }

# Copilot may append agent-facing runtime notifications to the prompt. Exclude them from
# the user turn persisted by AMT, while retaining the original prompt for memory recall.
$capturePrompt = ([regex]::Replace([string]$prompt, '(?is)<system_notification>.*?</system_notification>', '')).Trim()

$token = & (Join-Path $PSScriptRoot 'amt-token.ps1')
if (-not $token) { Write-Output '{}'; exit 0 }
$headers = @{ Authorization = "HookToken $token" }

# 1) capture the user turn (fire-and-forget; never block the prompt). Do not create an empty
# turn when the payload contains only a system notification.
if ($capturePrompt) {
  try {
    Invoke-RestMethod -Method Post -Uri "$script:AmtHookBase/capture" -Headers $headers `
      -ContentType 'application/json' -Body (@{ thread_id = $thread; role = 'user'; content = $capturePrompt } | ConvertTo-Json) -TimeoutSec 12 | Out-Null
  } catch { }
}

# 2) recall relevant memories and inject them.
Write-Output '{"type":"progress","message":"Recalling memory...","temporary":true}'
try {
  $results = Invoke-RestMethod -Method Post -Uri "$script:AmtHookBase/search" -Headers $headers `
    -ContentType 'application/json' -Body (@{ query = $prompt; top_k = $topK } | ConvertTo-Json) -TimeoutSec 12
} catch { Write-Output '{}'; exit 0 }

$items = @($results.items) | Where-Object { $_ }
if (-not $items -or $items.Count -eq 0) { Write-Output '{}'; exit 0 }
$sorted = $items | Sort-Object -Property @{ Expression = { if ($_.similarity_score) { $_.similarity_score } else { 0 } } } -Descending
$lines = ($sorted | ForEach-Object { $c = $_.content; if (-not $c) { $c = $_.text }; if ($c) { "- $c" } }) -join "`n"
if (-not $lines) { Write-Output '{}'; exit 0 }
@{ additionalContext = "Relevant memory for this developer (from AMT):`n$lines" } | ConvertTo-Json -Compress
