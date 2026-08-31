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

command -v jq   >/dev/null 2>&1 || { echo '{}'; exit 0; }
command -v curl >/dev/null 2>&1 || { echo '{}'; exit 0; }

payload="$(cat)"
thread="$(printf '%s' "$payload" | jq -r '.sessionId // .session_id // "copilot-app"')"
transcript="$(printf '%s' "$payload" | jq -r '.transcriptPath // .transcript_path // empty')"
{ [ -z "$transcript" ] || [ ! -f "$transcript" ]; } && { echo '{}'; exit 0; }

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

[ -z "$agent_msg" ] && { echo '{}'; exit 0; }

token="$("$SCRIPT_DIR/amt-token.sh" 2>/dev/null || true)"
[ -z "$token" ] && { echo '{}'; exit 0; }

curl -sS --max-time 12 -X POST "${AMT_HOOK_BASE}/capture" \
  -H "Authorization: HookToken ${token}" -H "Content-Type: application/json" \
  -d "$(jq -n --arg t "$thread" --arg c "$agent_msg" '{thread_id:$t, role:"agent", content:$c}')" \
  >/dev/null 2>&1 || true

echo '{}'
