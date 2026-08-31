#!/usr/bin/env pwsh
# capture.ps1 - agentStop hook (Windows twin of capture.sh). Reads the last assistant message
# from the transcript and records it as an `agent` turn. Auth: Authorization: HookToken <access>.
$ErrorActionPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'amt-config.ps1')

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

Write-AmtHookLog 'capture:agent:invoked'
$raw = [Console]::In.ReadToEnd()
if (-not $raw) { Write-AmtHookLog 'capture:agent:skipped:empty-payload'; Write-EmptyAndExit }
try { $payload = $raw | ConvertFrom-Json -ErrorAction Stop } catch { Write-AmtHookLog 'capture:agent:skipped:invalid-payload'; Write-EmptyAndExit }

$thread = $payload.sessionId; if (-not $thread) { $thread = 'copilot-app' }
$transcript = $payload.transcriptPath
if (-not $transcript -or -not (Test-Path $transcript)) { Write-AmtHookLog 'capture:agent:skipped:transcript-unavailable'; Write-EmptyAndExit }

$agentMsg = $null
try {
  Get-Content -Path $transcript | ForEach-Object {
    $line = $_.Trim(); if (-not $line) { return }
    try { $o = $line | ConvertFrom-Json } catch { return }
    $role = "$($o.role)$($o.type)$($o.sender)$($o.data.role)"
    if ($role -match 'assistant|agent') {
      $c = $o.data.content; if (-not $c) { $c = $o.content }; if (-not $c) { $c = $o.data.text }; if (-not $c) { $c = $o.text }; if (-not $c) { $c = $o.data.message }; if (-not $c) { $c = $o.message }; if (-not $c) { $c = $o.data.response }; if (-not $c) { $c = $o.response }
      if ($c -is [string] -and $c.Length -gt 0) { $agentMsg = $c }
      elseif ($c -is [array]) { $t = ($c | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.text } }) -join "`n"; if ($t) { $agentMsg = $t } }
    }
  }
} catch { }

if (-not $agentMsg) { Write-AmtHookLog 'capture:agent:skipped:no-agent-message'; Write-EmptyAndExit }

$token = & (Join-Path $PSScriptRoot 'amt-token.ps1')
if (-not $token) { Write-AmtHookLog 'capture:agent:skipped:no-hook-token'; Write-EmptyAndExit }

try {
  Invoke-RestMethod -Method Post -Uri "$script:AmtHookBase/capture" -Headers @{ Authorization = "HookToken $token" } `
    -ContentType 'application/json' -Body (@{ thread_id = $thread; role = 'agent'; content = $agentMsg } | ConvertTo-Json) `
    -TimeoutSec 12 -ErrorAction Stop | Out-Null
  Write-AmtHookLog 'capture:agent:ok'
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status) { Write-AmtHookLog "capture:agent:http-error:$status" } else { Write-AmtHookLog 'capture:agent:transport-error' }
}
Write-Output '{}'
