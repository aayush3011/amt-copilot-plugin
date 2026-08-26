#!/usr/bin/env bash
# capture.sh - agentStop hook.
#
# Runs when the agent finishes a turn. Appends the user's message to AMT as a conversation
# turn, so facts/episodes/summaries are derived from it on cadence. This is the
# deterministic-capture half of the plugin: memory is written without the model choosing to
# call a tool.
#
# Contract (GitHub Copilot hooks reference):
#   stdin  = one JSON object describing the finished turn
#   stdout = one JSON object (we return {} - we do not block or alter the turn)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AMT_GATEWAY_BASE="${AMT_GATEWAY_BASE:-https://reranker-api-h2b5czhkfkcphnf4.westus3-01.azurewebsites.net/inference/memory}"

command -v jq   >/dev/null 2>&1 || { echo '{}'; exit 0; }
command -v curl >/dev/null 2>&1 || { echo '{}'; exit 0; }

payload="$(cat)"
user_msg="$(printf '%s' "$payload" | jq -r '.prompt // .userPrompt // .message // empty')"
thread="$(printf '%s' "$payload" | jq -r '.threadId // .sessionId // "copilot-app"')"
[ -z "$user_msg" ] && { echo '{}'; exit 0; }

token="$("$SCRIPT_DIR/amt-token.sh" 2>/dev/null || true)"
[ -z "$token" ] && { echo '{}'; exit 0; }

curl -sS --max-time 12 -X POST "$AMT_GATEWAY_BASE/memory" \
  -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "$(jq -n --arg t "$thread" --arg c "$user_msg" '{thread_id:$t, role:"user", content:$c}')" \
  >/dev/null 2>&1 || true

# Never block the turn; capture is best-effort.
echo '{}'
