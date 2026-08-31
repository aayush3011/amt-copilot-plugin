#!/usr/bin/env bash
# inject.sh - userPromptSubmitted hook. Does TWO things every turn, unconditionally:
#
#   1. CAPTURE: record the user's message to AMT as a `user` turn. AMT records EVERY turn and
#      its extraction LLM decides what becomes a durable memory - the coding agent must NOT
#      be the gatekeeper, so capture happens here in the hook, not via the agent choosing to
#      call add_memory.
#   2. RECALL: search AMT for this developer's relevant memories and return them as
#      `additionalContext`, so Copilot has them before it answers.
#
# Auth is a gateway-issued hook token (Authorization: HookToken <access>); amt-token.sh
# provides it and refreshes silently. If not signed in, the hook is a clean no-op.
#
# Contract (GitHub Copilot hooks reference):
#   stdin  = one JSON object; `userPromptSubmitted` carries `prompt` and `sessionId`.
#   stdout = one JSON object; `additionalContext` is injected into the turn.
set -euo pipefail

# GUI apps (the Copilot desktop app) may spawn hooks with a minimal PATH. Prepend the common
# tool locations so jq/curl resolve on macOS (Homebrew) and Linux. Windows uses inject.ps1.
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:/usr/bin:/bin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=amt-config.sh
. "$SCRIPT_DIR/amt-config.sh"
TOP_K="${AMT_INJECT_TOP_K:-8}"

command -v jq   >/dev/null 2>&1 || { echo '{}'; exit 0; }
command -v curl >/dev/null 2>&1 || { echo '{}'; exit 0; }

payload="$(cat)"
prompt="$(printf '%s' "$payload" | jq -r '.prompt // .userPrompt // .user_prompt // .message // empty')"
thread="$(printf '%s' "$payload" | jq -r '.sessionId // .session_id // "copilot-app"')"
[ -z "$prompt" ] && { echo '{}'; exit 0; }

# Copilot can append runtime-only notifications to the submitted prompt. They are useful to
# the agent but are not part of the user's message and must not be persisted as a user turn.
capture_prompt="$(printf '%s' "$prompt" | jq -Rsr '
  gsub("(?is)<system_notification>.*?</system_notification>"; "")
  | gsub("^[[:space:]]+|[[:space:]]+$"; "")
')"

token="$("$SCRIPT_DIR/amt-token.sh" 2>/dev/null || true)"
[ -z "$token" ] && { echo '{}'; exit 0; }

# 1) CAPTURE the user turn (fire-and-forget; never block or fail the prompt). Skip a
# notification-only payload instead of writing an empty turn.
if [ -n "$capture_prompt" ]; then
  curl -sS --max-time 12 -X POST "${AMT_HOOK_BASE}/capture" \
    -H "Authorization: HookToken ${token}" -H "Content-Type: application/json" \
    -d "$(jq -n --arg t "$thread" --arg c "$capture_prompt" '{thread_id:$t, role:"user", content:$c}')" \
    >/dev/null 2>&1 || true
fi

# 2) RECALL relevant memories and inject them.
echo '{"type":"progress","message":"Recalling memory...","temporary":true}'

results="$(curl -sS --max-time 12 -X POST "${AMT_HOOK_BASE}/search" \
  -H "Authorization: HookToken ${token}" -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$prompt" --argjson k "$TOP_K" '{query:$q, top_k:$k}')" 2>/dev/null || true)"
[ -z "$results" ] && { echo '{}'; exit 0; }

lines="$(printf '%s' "$results" | jq -r '[.items[]? | {s:(.similarity_score // 0), c:(.content // .text // "")}] | sort_by(-.s) | [.[] | "- " + .c] | map(select(. != "- ")) | join("\n")' 2>/dev/null || true)"
[ -z "$lines" ] && { echo '{}'; exit 0; }

jq -n --arg ctx "Relevant memory for this developer (from AMT):
$lines" '{additionalContext: $ctx}'
