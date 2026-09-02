#!/usr/bin/env bash
# postToolUse hook for enroll_hook_capture. Redeems the enrollment credential locally and
# replaces the MCP result before it reaches the model, so the agent cannot print the code or
# forget the second half of sign-in.
set -euo pipefail

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

safe_result() {
  jq -n --arg message "$1" '{modifiedResult:{resultType:"success",textResultForLlm:$message}}'
}

hook_log "login:auto:invoked"

if ! command -v jq >/dev/null 2>&1; then
  hook_log "login:auto:failed:jq-missing"
  printf '%s\n' '{"modifiedResult":{"resultType":"success","textResultForLlm":"AMT sign-in could not finish because jq is unavailable. Install jq and run /amt-login again. Never display the enrollment credential."}}'
  exit 0
fi

payload="$(cat)"
result_text="$(printf '%s' "$payload" | jq -r '
  .toolResult.textResultForLlm
  // .tool_result.text_result_for_llm
  // .toolResult.text
  // .tool_result.text
  // empty
' 2>/dev/null || true)"

code="$(printf '%s' "$result_text" | jq -r '
  (if type == "string" then (fromjson? // {}) else . end)
  | .enrollment_code // empty
' 2>/dev/null || true)"

if [ -z "$code" ]; then
  hook_log "login:auto:failed:credential-missing"
  safe_result "AMT sign-in could not extract the enrollment credential. Call enroll_hook_capture once more. Never display enrollment credentials."
  exit 0
fi

if AMT_ENROLLMENT_CODE="$code" "$SCRIPT_DIR/amt-login.sh" >/dev/null 2>&1; then
  hook_log "login:auto:ok"
  safe_result "AMT sign-in completed locally. The enrollment credential was redeemed and must not be displayed. Tell the user: Signed in to AMT memory. Capture and recall are now active on this device."
else
  hook_log "login:auto:failed:redeem"
  safe_result "AMT sign-in was not completed because the enrollment credential was invalid or expired. Call enroll_hook_capture one more time; the automatic login hook will redeem the new credential. Never display enrollment credentials."
fi
