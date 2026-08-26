#!/usr/bin/env bash
# inject.sh - userPromptSubmitted hook.
#
# Reads the event payload (JSON) on stdin, retrieves this developer's relevant memories
# from AMT, and returns them as `additionalContext` so Copilot prepends them before the
# model sees the prompt. This is the deterministic-recall half of the plugin: memory is
# consulted every turn, without the model having to choose to call a tool.
#
# Contract (GitHub Copilot hooks reference):
#   stdin  = one JSON object describing the event (includes the user's prompt)
#   stdout = one JSON object; `additionalContext` is injected into the turn
#   progress lines: {"type":"progress","message":"...","temporary":true}
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AMT_GATEWAY_BASE="${AMT_GATEWAY_BASE:-https://reranker-api-h2b5czhkfkcphnf4.westus3-01.azurewebsites.net/inference/memory}"
TOP_K="${AMT_INJECT_TOP_K:-8}"

# Nothing we can do without jq/curl; fall through to no injection rather than error.
command -v jq   >/dev/null 2>&1 || { echo '{}'; exit 0; }
command -v curl >/dev/null 2>&1 || { echo '{}'; exit 0; }

payload="$(cat)"
prompt="$(printf '%s' "$payload" | jq -r '.prompt // .userPrompt // .message // empty')"
[ -z "$prompt" ] && { echo '{}'; exit 0; }

echo '{"type":"progress","message":"Recalling memory...","temporary":true}'

token="$("$SCRIPT_DIR/amt-token.sh" 2>/dev/null || true)"
[ -z "$token" ] && { echo '{}'; exit 0; }

results="$(curl -sS --max-time 12 -X POST "$AMT_GATEWAY_BASE/search" \
  -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$prompt" --argjson k "$TOP_K" '{query:$q, top_k:$k}')" 2>/dev/null || true)"
[ -z "$results" ] && { echo '{}'; exit 0; }

lines="$(printf '%s' "$results" | jq -r '[.items[]? | {s:(.similarity_score // 0), c:(.content // .text // "")}] | sort_by(-.s) | [.[] | "- " + .c] | map(select(. != "- ")) | join("\n")' 2>/dev/null || true)"
[ -z "$lines" ] && { echo '{}'; exit 0; }

# `additionalContext` is the documented field for injecting model context from a hook.
jq -n --arg ctx "Relevant memory for this developer (from AMT):
$lines" '{additionalContext: $ctx}'
