#!/usr/bin/env bash
# amt-token.sh - print a valid AMT hook access token on stdout, or exit non-zero.
#
# Non-interactive (safe to call from hooks). Resolution order:
#   1. AMT_ACCESS_TOKEN env override  -> printed verbatim (notebooks / CI escape hatch).
#   2. cached access token, still valid (with skew) -> printed.
#   3. cached refresh token -> silent refresh at the gateway, cache updated, token printed.
#   4. otherwise -> exit 1 (caller no-ops; developer must run /amt-login).
#
# Refresh tokens are single-use and rotate: the gateway consumes the presented token and issues
# a new one. Three hooks (inject capture, inject recall, capture) can run concurrently, so the
# refresh is serialised behind a lock and the cache is re-read after acquiring it - a concurrent
# winner's token is reused instead of spending a refresh token the gateway already consumed.
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

_amt_read_cache() {
  access=""; expires_at=0; refresh=""
  [ -f "$AMT_TOKEN_CACHE" ] || return 0
  access="$(jq -r '.access_token // empty' "$AMT_TOKEN_CACHE" 2>/dev/null || true)"
  expires_at="$(jq -r '.expires_at // 0' "$AMT_TOKEN_CACHE" 2>/dev/null || echo 0)"
  refresh="$(jq -r '.refresh_token // empty' "$AMT_TOKEN_CACHE" 2>/dev/null || true)"
  case "$expires_at" in (''|*[!0-9]*) expires_at=0 ;; esac
}

_amt_access_is_fresh() {
  [ -n "$access" ] && [ "$expires_at" -gt "$(( $(date +%s) + AMT_TOKEN_SKEW_SECONDS ))" ]
}

_amt_read_cache

# 2) Cached access token still valid?
if _amt_access_is_fresh; then
  printf '%s' "$access"
  exit 0
fi

# 3) Silent refresh at the gateway, serialised across concurrent hooks.
[ -n "$refresh" ] || { echo "amt-token: access token expired and no refresh token; run /amt-login" >&2; exit 1; }

_amt_locked=0
_amt_unlock() {
  [ "$_amt_locked" = "1" ] || return 0
  rm -rf "$AMT_LOCK_DIR" 2>/dev/null || true
  _amt_locked=0
}

_amt_lock() {
  waited=0
  while [ "$waited" -lt "$AMT_LOCK_TIMEOUT_DS" ]; do
    if mkdir "$AMT_LOCK_DIR" 2>/dev/null; then
      _amt_locked=1
      trap _amt_unlock EXIT INT TERM
      return 0
    fi
    if [ "$(( $(date +%s) - $(_amt_mtime "$AMT_LOCK_DIR") ))" -ge "$AMT_LOCK_STALE_SECONDS" ]; then
      rm -rf "$AMT_LOCK_DIR" 2>/dev/null || true
    else
      sleep 0.1
    fi
    waited=$(( waited + 1 ))
  done
  return 1
}

if ! _amt_lock; then
  _amt_read_cache
  if _amt_access_is_fresh; then
    printf '%s' "$access"
    exit 0
  fi
  echo "amt-token: timed out waiting for a concurrent refresh; will retry" >&2
  exit 1
fi

# Re-read under the lock: a concurrent hook may have rotated the token while we waited, which
# would leave our copy of the refresh token already spent.
_amt_read_cache
if _amt_access_is_fresh; then
  printf '%s' "$access"
  exit 0
fi
[ -n "$refresh" ] || { echo "amt-token: not signed in (cache cleared); run /amt-login" >&2; exit 1; }

now="$(date +%s)"
resp="$(curl -sS --max-time 20 -w $'\n%{http_code}' -X POST "${AMT_HOOK_BASE}/refresh" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg rt "$refresh" '{refresh_token:$rt}')" 2>/dev/null || true)"
status="${resp##*$'\n'}"
body="${resp%$'\n'*}"
[ "$status" != "$resp" ] || { status=""; body=""; }

case "$status" in
  2??) ;;
  # 401 is the gateway's invalid_grant: revoked, expired, or already consumed. Nothing will
  # make this token work again, so drop it rather than wedge every future hook.
  401)
    rm -f "$AMT_TOKEN_CACHE"
    echo "amt-token: refresh rejected (token revoked or expired); signed out, run /amt-login" >&2
    exit 1 ;;
  # 400, 404 (hook surface disabled), 5xx and transport failures are not the token's fault -
  # keep the cache so a later attempt can still succeed. curl reports 000 when it never got
  # a response at all.
  ''|000) echo "amt-token: refresh unreachable (network); keeping cache, will retry" >&2; exit 1 ;;
  *)      echo "amt-token: refresh failed (HTTP ${status}); keeping cache, will retry" >&2; exit 1 ;;
esac

new_access="$(printf '%s' "$body" | jq -r '.access_token // empty' 2>/dev/null || true)"
if [ -z "$new_access" ]; then
  echo "amt-token: refresh returned no access token; run /amt-login" >&2
  exit 1
fi
new_refresh="$(printf '%s' "$body" | jq -r '.refresh_token // empty' 2>/dev/null || true)"
expires_in="$(printf '%s' "$body" | jq -r '.expires_in // 1800' 2>/dev/null || echo 1800)"
[ -n "$new_refresh" ] || new_refresh="$refresh"   # keep old refresh if not rotated
case "$expires_in" in (''|*[!0-9]*) expires_in=1800 ;; esac
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
