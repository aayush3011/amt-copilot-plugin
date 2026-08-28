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

# Extract the last assistant/agent message text from the transcript. Transcripts are
# commonly JSONL (one JSON object per line); we scan for the last line whose role/type is
# assistant/agent and pull a text field. Multiple shapes are tried defensively.
agent_msg="$(jq -rs '
  [ .[]
    | select((.role // .type // .sender // "") | test("assistant|agent"; "i"))
    | (.content // .text // .message // .response
       // (if (.content|type)=="array" then (.content|map(.text // empty)|join("\n")) else empty end))
    | select(type=="string" and length>0)
  ] | last // empty
' "$transcript" 2>/dev/null || true)"

# Fallback: some transcripts are a single JSON doc with a messages[] array.
if [ -z "$agent_msg" ]; then
  agent_msg="$(jq -r '
    (.messages // .turns // [])
    | map(select((.role // .type // "") | test("assistant|agent"; "i")) | (.content // .text // .message // empty))
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
