#!/usr/bin/env bash
# amt-login.sh <enrollment_code> - complete AMT hook sign-in by redeeming an enrollment code.
#
# The plugin is not an OAuth client. Sign-in is two steps and this script is the second:
#   1. (agent) call the enroll_hook_capture MCP tool -> a short-lived, single-use code.
#   2. (this)  redeem that code at the gateway for a hook token (access + refresh), cached
#              at $COPILOT_HOME/amt/token.json (0600). The hooks then capture/recall and
#              silently refresh, so this is a one-time action per device.
#
# See Docs/amt-hook-token-contract.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=amt-config.sh
. "$SCRIPT_DIR/amt-config.sh"

command -v jq   >/dev/null 2>&1 || { echo "amt-login: 'jq' is required." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "amt-login: 'curl' is required." >&2; exit 1; }

code="${1:-${AMT_ENROLLMENT_CODE:-}}"
if [ -z "$code" ]; then
  echo "usage: amt-login.sh <enrollment_code>" >&2
  echo "  (get a code by calling the enroll_hook_capture MCP tool first)" >&2
  exit 2
fi

resp="$(curl -sS --max-time 20 -X POST "${AMT_HOOK_BASE}/redeem" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg c "$code" '{enrollment_code:$c}')" 2>/dev/null || true)"

access="$(printf '%s' "$resp" | jq -r '.access_token // empty' 2>/dev/null || true)"
refresh="$(printf '%s' "$resp" | jq -r '.refresh_token // empty' 2>/dev/null || true)"
if [ -z "$access" ] || [ -z "$refresh" ]; then
  echo "amt-login: enrollment failed (invalid or expired code). Ask again for a fresh code and retry." >&2
  exit 1
fi
expires_in="$(printf '%s' "$resp" | jq -r '.expires_in // 1800' 2>/dev/null || echo 1800)"
expires_at="$(( $(date +%s) + expires_in ))"

mkdir -p "$AMT_HOME"; chmod 700 "$AMT_HOME" 2>/dev/null || true
tmp="$(mktemp "${AMT_TOKEN_CACHE}.XXXXXX")"
jq -n --arg at "$access" --arg rt "$refresh" --argjson ea "$expires_at" \
  '{access_token:$at, refresh_token:$rt, expires_at:$ea, token_type:"HookToken"}' > "$tmp"
chmod 600 "$tmp" 2>/dev/null || true
mv -f "$tmp" "$AMT_TOKEN_CACHE"

echo "  Signed in to AMT memory. Capture and recall are now active for this device."
