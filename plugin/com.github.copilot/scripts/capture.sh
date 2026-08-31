#!/usr/bin/env bash
# capture.sh - agentStop hook. Records the AGENT's response as an `agent` turn.
#
# Why the transcript: the agentStop payload does NOT carry the response text - only
# sessionId, timestamp, cwd, transcriptPath, stopReason. The agent's message lives in the
# transcript file, so we read the last assistant message from it. Best-effort: if the
# transcript format does not match, this is a safe no-op (the user turn is already captured
# by inject.sh on userPromptSubmitted, the primary, reliable capture path).
#
# Auth is a gateway-issued hook token (Authorization: HookToken <access>) via amt-token.sh.
set -euo pipefail

# GUI apps (the Copilot desktop app) may spawn hooks with a minimal PATH. Prepend the common
# tool locations so jq/curl resolve on macOS (Homebrew) and Linux. Windows uses capture.ps1.
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:/usr/bin:/bin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=amt-config.sh
. "$SCRIPT_DIR/amt-config.sh"

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

hook_log "capture:agent:invoked"
command -v jq >/dev/null 2>&1 || { hook_log "capture:agent:skipped:jq-missing"; finish_empty; }
command -v curl >/dev/null 2>&1 || { hook_log "capture:agent:skipped:curl-missing"; finish_empty; }

payload="$(cat)"
printf '%s' "$payload" | jq -e . >/dev/null 2>&1 || { hook_log "capture:agent:skipped:invalid-payload"; finish_empty; }
thread="$(printf '%s' "$payload" | jq -r '.sessionId // .session_id // "copilot-app"')"
transcript="$(printf '%s' "$payload" | jq -r '.transcriptPath // .transcript_path // empty')"
{ [ -z "$transcript" ] || [ ! -f "$transcript" ]; } && { hook_log "capture:agent:skipped:transcript-unavailable"; finish_empty; }

# Extract the last assistant/agent message text from the transcript. Current Copilot event
# logs store it as {"type":"assistant.message","data":{"content":"..."}}; older
# transcript formats used top-level role/content fields. Support both shapes.
agent_msg="$(jq -rs '
  def as_text:
    if type == "string" then .
    elif type == "array" then
      [ .[]
        | if type == "string" then .
          elif type == "object" then (.text // .content // .message // empty)
          else empty
          end
        | select(type == "string" and length > 0)
      ] | join("\n")
    elif type == "object" then (.text // .content // .message // .response // empty) | as_text
    else empty
    end;
  [ .[]
    | select(
        (.type // "") == "assistant.message"
        or ((.role // .sender // .data.role // "") | test("assistant|agent"; "i"))
      )
    | (.data.content // .content // .data.text // .text // .data.message // .message
       // .data.response // .response // empty)
    | as_text
    | select(length > 0)
  ] | last // empty
' "$transcript" 2>/dev/null || true)"

# Fallback: some transcripts are a single JSON doc with a messages[] array.
if [ -z "$agent_msg" ]; then
  agent_msg="$(jq -r '
    (.messages // .turns // [])
    | map(
        select((.role // .type // "") | test("assistant|agent"; "i"))
        | (.data.content // .content // .text // .message // empty)
      )
    | map(select(type=="string" and length>0)) | last // empty
  ' "$transcript" 2>/dev/null || true)"
fi

[ -z "$agent_msg" ] && { hook_log "capture:agent:skipped:no-agent-message"; finish_empty; }

token="$("$SCRIPT_DIR/amt-token.sh" 2>/dev/null || true)"
[ -z "$token" ] && { hook_log "capture:agent:skipped:no-hook-token"; finish_empty; }

capture_body="$(jq -n --arg t "$thread" --arg c "$agent_msg" '{thread_id:$t, role:"agent", content:$c}')"
if capture_status="$(curl -sS --max-time 12 -o /dev/null -w '%{http_code}' \
    -X POST "${AMT_HOOK_BASE}/capture" \
    -H "Authorization: HookToken ${token}" -H "Content-Type: application/json" \
    -d "$capture_body" 2>/dev/null)"; then
  case "$capture_status" in
    2??) hook_log "capture:agent:ok:${capture_status}" ;;
    *) hook_log "capture:agent:http-error:${capture_status}" ;;
  esac
else
  hook_log "capture:agent:transport-error"
fi

echo '{}'
