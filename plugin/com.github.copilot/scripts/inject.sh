#!/usr/bin/env bash
# inject.sh - userPromptSubmitted hook. Does TWO things every turn, unconditionally:
#
#   1. CAPTURE: record the user's message to AMT as a `user` turn. This is the correct
#      capture model - AMT records EVERY turn and its extraction LLM decides what becomes a
#      durable memory. The coding agent must NOT be the gatekeeper for what gets stored, so
#      capture happens here in the hook, not via the agent choosing to call add_memory.
#   2. RECALL: search AMT for this developer's relevant memories and return them as
#      `additionalContext`, so Copilot has them before it answers.
#
# Contract (GitHub Copilot hooks reference):
#   stdin  = one JSON object; `userPromptSubmitted` carries `prompt` and `sessionId`.
#   stdout = one JSON object; `additionalContext` is injected into the turn.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AMT_GATEWAY_BASE="${AMT_GATEWAY_BASE:-https://reranker-api-h2b5czhkfkcphnf4.westus3-01.azurewebsites.net/inference/memory}"
TOP_K="${AMT_INJECT_TOP_K:-8}"

command -v jq   >/dev/null 2>&1 || { echo '{}'; exit 0; }
command -v curl >/dev/null 2>&1 || { echo '{}'; exit 0; }

payload="$(cat)"
prompt="$(printf '%s' "$payload" | jq -r '.prompt // .userPrompt // .user_prompt // .message // empty')"
thread="$(printf '%s' "$payload" | jq -r '.sessionId // .session_id // "copilot-app"')"
[ -z "$prompt" ] && { echo '{}'; exit 0; }

token="$("$SCRIPT_DIR/amt-token.sh" 2>/dev/null || true)"
[ -z "$token" ] && { echo '{}'; exit 0; }

# 1) CAPTURE the user turn (fire-and-forget; never block or fail the prompt).
curl -sS --max-time 12 -X POST "$AMT_GATEWAY_BASE/memory" \
  -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "$(jq -n --arg t "$thread" --arg c "$prompt" '{thread_id:$t, role:"user", content:$c}')" \
  >/dev/null 2>&1 || true

# 2) RECALL relevant memories and inject them.
echo '{"type":"progress","message":"Recalling memory...","temporary":true}'

results="$(curl -sS --max-time 12 -X POST "$AMT_GATEWAY_BASE/search" \
  -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$prompt" --argjson k "$TOP_K" '{query:$q, top_k:$k}')" 2>/dev/null || true)"
[ -z "$results" ] && { echo '{}'; exit 0; }

lines="$(printf '%s' "$results" | jq -r '[.items[]? | {s:(.similarity_score // 0), c:(.content // .text // "")}] | sort_by(-.s) | [.[] | "- " + .c] | map(select(. != "- ")) | join("\n")' 2>/dev/null || true)"
[ -z "$lines" ] && { echo '{}'; exit 0; }

jq -n --arg ctx "Relevant memory for this developer (from AMT):
$lines" '{additionalContext: $ctx}'
