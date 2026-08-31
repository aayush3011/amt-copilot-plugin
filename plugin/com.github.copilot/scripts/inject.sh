#!/usr/bin/env bash
# inject.sh - user-turn capture and pre-model recall for the AMT Copilot plugin.
#
# Copilot invokes this script in two phases, selected by AMT_HOOK_PHASE:
#   capture (userPromptSubmitted): record the sanitized user turn, then return {}.
#   recall  (userPromptTransformed): retrieve relevant memories and append them to the
#           model-facing transformed prompt via modifiedTransformedPrompt.
#
# Config-file userPromptSubmitted hook output is discarded by current Copilot runtimes, so
# recall must happen in userPromptTransformed. Both phases fail open. Diagnostics contain no
# prompt, memory, or token content and are written to ~/.copilot/amt/hook.log.
set -euo pipefail

# GUI apps may spawn hooks with a minimal PATH. Prepend common tool locations on macOS/Linux.
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:/usr/bin:/bin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=amt-config.sh
. "$SCRIPT_DIR/amt-config.sh"

phase="${AMT_HOOK_PHASE:-capture}"
TOP_K="${AMT_INJECT_TOP_K:-8}"

hook_log() {
  {
    umask 077
    mkdir -p "$AMT_HOME"
    printf '%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >>"${AMT_HOME}/hook.log"
    chmod 600 "${AMT_HOME}/hook.log"
  } 2>/dev/null || true
}

finish_empty() {
  echo '{}'
  exit 0
}

hook_log "${phase}:invoked"
command -v jq >/dev/null 2>&1 || { hook_log "${phase}:skipped:jq-missing"; finish_empty; }
command -v curl >/dev/null 2>&1 || { hook_log "${phase}:skipped:curl-missing"; finish_empty; }

payload="$(cat)"
printf '%s' "$payload" | jq -e . >/dev/null 2>&1 || { hook_log "${phase}:skipped:invalid-payload"; finish_empty; }

prompt="$(printf '%s' "$payload" | jq -r '.prompt // .userPrompt // .user_prompt // .message // empty')"
transformed_prompt="$(printf '%s' "$payload" | jq -r '.transformedPrompt // empty')"
thread="$(printf '%s' "$payload" | jq -r '.sessionId // .session_id // "copilot-app"')"
[ -n "$prompt" ] || { hook_log "${phase}:skipped:empty-prompt"; finish_empty; }

# Slash-command expansion can surround the user text with agent-facing skill/canvas context and
# runtime notifications. Remove those envelopes before capture and use the clean prompt for recall.
user_prompt="$(printf '%s' "$prompt" | jq -Rsr '
  gsub("(?is)<system_notification\\b[^>]*>.*?</system_notification>"; "")
  | gsub("(?is)<system_reminder\\b[^>]*>.*?</system_reminder>"; "")
  | gsub("(?is)<skill-context\\b[^>]*>.*?</skill-context>"; "")
  | gsub("(?is)<canvas-context\\b[^>]*>.*?</canvas-context>"; "")
  | gsub("^[[:space:]]+|[[:space:]]+$"; "")
  | if test("(?is)^The user explicitly invoked the \\\"/[^\\\"]+\\\" skill\\.") then
      capture("(?is)^The user explicitly invoked the \\\"(?<command>/[^\\\"]+)\\\" skill\\.").command
    else . end
')"
[ -n "$user_prompt" ] || { hook_log "${phase}:skipped:notification-only"; finish_empty; }

token="$("$SCRIPT_DIR/amt-token.sh" 2>/dev/null || true)"
[ -n "$token" ] || { hook_log "${phase}:skipped:no-hook-token"; finish_empty; }

if [ "$phase" = "capture" ]; then
  capture_body="$(jq -n --arg t "$thread" --arg c "$user_prompt" '{thread_id:$t, role:"user", content:$c}')"
  if capture_status="$(curl -sS --max-time 12 -o /dev/null -w '%{http_code}' \
      -X POST "${AMT_HOOK_BASE}/capture" \
      -H "Authorization: HookToken ${token}" -H "Content-Type: application/json" \
      -d "$capture_body" 2>/dev/null)"; then
    case "$capture_status" in
      2??) hook_log "capture:user:ok:${capture_status}" ;;
      *) hook_log "capture:user:http-error:${capture_status}" ;;
    esac
  else
    hook_log "capture:user:transport-error"
  fi
  finish_empty
fi

if [ "$phase" != "recall" ]; then
  hook_log "${phase}:skipped:unknown-phase"
  finish_empty
fi

search_body="$(jq -n --arg q "$user_prompt" --argjson k "$TOP_K" '{query:$q, top_k:$k}')"
if search_response="$(curl -sS --max-time 12 -w $'\n%{http_code}' \
    -X POST "${AMT_HOOK_BASE}/search" \
    -H "Authorization: HookToken ${token}" -H "Content-Type: application/json" \
    -d "$search_body" 2>/dev/null)"; then
  search_status="${search_response##*$'\n'}"
  results="${search_response%$'\n'*}"
else
  hook_log "recall:transport-error"
  finish_empty
fi

case "$search_status" in
  2??) ;;
  *) hook_log "recall:http-error:${search_status}"; finish_empty ;;
esac

lines="$(printf '%s' "$results" | jq -r '
  [.items[]? | {s:(.similarity_score // 0), c:(.content // .text // "")}]
  | sort_by(-.s)
  | [.[] | "- " + .c]
  | map(select(. != "- "))
  | join("\n")
' 2>/dev/null || true)"
[ -n "$lines" ] || { hook_log "recall:ok:no-results"; finish_empty; }

model_prompt="$transformed_prompt"
[ -n "$model_prompt" ] || model_prompt="$prompt"
modified_prompt="${model_prompt}

<amt-memory-context>
Relevant memory for this developer (from AMT):
${lines}
</amt-memory-context>"

hook_log "recall:ok:context-injected"
jq -n --arg prompt "$modified_prompt" '{modifiedTransformedPrompt: $prompt}'
