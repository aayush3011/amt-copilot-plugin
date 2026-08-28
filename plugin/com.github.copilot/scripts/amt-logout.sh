#!/usr/bin/env bash
# amt-logout.sh - sign out of AMT memory: revoke the hook token and clear the local cache.
#
# Revocation is server-side at the gateway (the refresh record is deleted), so the token
# cannot be refreshed again even if the local file were recovered. See
# Docs/amt-hook-token-contract.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=amt-config.sh
. "$SCRIPT_DIR/amt-config.sh"

if [ ! -f "$AMT_TOKEN_CACHE" ]; then
  echo "  Not signed in (no local token)."
  exit 0
fi

if command -v jq >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  refresh="$(jq -r '.refresh_token // empty' "$AMT_TOKEN_CACHE" 2>/dev/null || true)"
  if [ -n "$refresh" ]; then
    curl -sS --max-time 15 -X POST "${AMT_HOOK_BASE}/revoke" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg rt "$refresh" '{refresh_token:$rt}')" >/dev/null 2>&1 || true
  fi
fi

rm -f "$AMT_TOKEN_CACHE"
echo "  Signed out of AMT memory (token revoked and local cache cleared)."
