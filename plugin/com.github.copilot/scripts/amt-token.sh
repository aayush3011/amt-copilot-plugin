#!/usr/bin/env bash
# amt-token.sh - print a valid AMT hook access token on stdout, or exit non-zero.
#
# Non-interactive (safe to call from hooks). Resolution order:
#   1. AMT_ACCESS_TOKEN env override  -> printed verbatim (notebooks / CI escape hatch).
#   2. cached access token, still valid (with skew) -> printed.
#   3. cached refresh token -> silent refresh at the gateway, cache updated, token printed.
#   4. otherwise -> exit 1 (caller no-ops; developer must run /amt-login).
#
# The gateway is the token authority: this script never signs or validates a token, it only
# caches what the gateway returns. See Docs/amt-hook-token-contract.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=amt-config.sh
. "$SCRIPT_DIR/amt-config.sh"

# 1) Explicit override.
if [ -n "${AMT_ACCESS_TOKEN:-}" ]; then
  printf '%s' "$AMT_ACCESS_TOKEN"
  exit 0
fi

command -v jq   >/dev/null 2>&1 || { echo "amt-token: jq not found" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "amt-token: curl not found" >&2; exit 1; }
[ -f "$AMT_TOKEN_CACHE" ] || { echo "amt-token: not signed in (no cache); run /amt-login" >&2; exit 1; }

now="$(date +%s)"
access="$(jq -r '.access_token // empty' "$AMT_TOKEN_CACHE" 2>/dev/null || true)"
expires_at="$(jq -r '.expires_at // 0' "$AMT_TOKEN_CACHE" 2>/dev/null || echo 0)"
refresh="$(jq -r '.refresh_token // empty' "$AMT_TOKEN_CACHE" 2>/dev/null || true)"

# 2) Cached access token still valid?
if [ -n "$access" ] && [ "$expires_at" -gt "$((now + AMT_TOKEN_SKEW_SECONDS))" ] 2>/dev/null; then
  printf '%s' "$access"
  exit 0
fi

# 3) Silent refresh at the gateway.
[ -n "$refresh" ] || { echo "amt-token: access token expired and no refresh token; run /amt-login" >&2; exit 1; }

resp="$(curl -sS --max-time 20 -X POST "${AMT_HOOK_BASE}/refresh" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg rt "$refresh" '{refresh_token:$rt}')" 2>/dev/null || true)"

new_access="$(printf '%s' "$resp" | jq -r '.access_token // empty' 2>/dev/null || true)"
if [ -z "$new_access" ]; then
  echo "amt-token: refresh failed; run /amt-login" >&2
  exit 1
fi
new_refresh="$(printf '%s' "$resp" | jq -r '.refresh_token // empty' 2>/dev/null || true)"
expires_in="$(printf '%s' "$resp" | jq -r '.expires_in // 1800' 2>/dev/null || echo 1800)"
[ -n "$new_refresh" ] || new_refresh="$refresh"   # keep old refresh if not rotated
new_expires_at="$((now + expires_in))"

# Persist atomically (0600).
mkdir -p "$AMT_HOME"; chmod 700 "$AMT_HOME" 2>/dev/null || true
tmp="$(mktemp "${AMT_TOKEN_CACHE}.XXXXXX")"
jq -n \
  --arg at "$new_access" --arg rt "$new_refresh" --argjson ea "$new_expires_at" \
  '{access_token:$at, refresh_token:$rt, expires_at:$ea, token_type:"HookToken"}' \
  > "$tmp" 2>/dev/null || { rm -f "$tmp"; printf '%s' "$new_access"; exit 0; }
chmod 600 "$tmp" 2>/dev/null || true
mv -f "$tmp" "$AMT_TOKEN_CACHE"

printf '%s' "$new_access"
