#!/usr/bin/env pwsh
# capture.ps1 - agentStop hook (Windows twin of capture.sh). Reads the last assistant message
# from the transcript and records it as an `agent` turn. Auth: Authorization: HookToken <access>.
$ErrorActionPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'amt-config.ps1')

$raw = [Console]::In.ReadToEnd()
if (-not $raw) { Write-Output '{}'; exit 0 }
try { $payload = $raw | ConvertFrom-Json } catch { Write-Output '{}'; exit 0 }

$thread = $payload.sessionId; if (-not $thread) { $thread = 'copilot-app' }
$transcript = $payload.transcriptPath
if (-not $transcript -or -not (Test-Path $transcript)) { Write-Output '{}'; exit 0 }

$agentMsg = $null
try {
  Get-Content -Path $transcript | ForEach-Object {
    $line = $_.Trim(); if (-not $line) { return }
    try { $o = $line | ConvertFrom-Json } catch { return }
    $role = "$($o.role)$($o.type)$($o.sender)"
    if ($role -match 'assistant|agent') {
      $c = $o.content; if (-not $c) { $c = $o.text }; if (-not $c) { $c = $o.message }; if (-not $c) { $c = $o.response }
      if ($c -is [string] -and $c.Length -gt 0) { $agentMsg = $c }
      elseif ($c -is [array]) { $t = ($c | ForEach-Object { $_.text }) -join "`n"; if ($t) { $agentMsg = $t } }
    }
  }
} catch { }

if (-not $agentMsg) { Write-Output '{}'; exit 0 }

$token = & (Join-Path $PSScriptRoot 'amt-token.ps1')
if (-not $token) { Write-Output '{}'; exit 0 }

try {
  Invoke-RestMethod -Method Post -Uri "$script:AmtHookBase/capture" -Headers @{ Authorization = "HookToken $token" } `
    -ContentType 'application/json' -Body (@{ thread_id = $thread; role = 'agent'; content = $agentMsg } | ConvertTo-Json) -TimeoutSec 12 | Out-Null
} catch { }
Write-Output '{}'
