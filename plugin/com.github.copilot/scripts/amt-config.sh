#!/usr/bin/env bash
# amt-config.sh - shared config for the AMT plugin hook helpers (sourced, not run).
#
# The plugin authenticates to AMT through the gateway's hook-token flow. It holds NO Entra
# client id and runs NO OAuth itself: sign-in is a one-time enrollment where the agent calls
# the enroll_hook_capture MCP tool for a short-lived code and amt-login redeems it at the
# gateway for a hook token (access + refresh). The hooks then send
# `Authorization: HookToken <access>` and silently refresh. One source of truth for every
# helper. See Docs/amt-hook-token-contract.md.

# These values are consumed by the scripts that source this file, not used here.
# shellcheck disable=SC2034

# --- Gateway: data plane + hook-token endpoints ---
# Single source of truth for the gateway is the plugin's .mcp.json - the one URL the customer
# configures (their MCP server endpoint). Every helper derives the data-plane base from it, so
# the gateway is never hardcoded and "just works" per customer. AMT_GATEWAY_BASE overrides it
# (tests / local dev). AMT_GATEWAY_BASE ends at /inference/memory; the hook surface lives under
# /inference/memory/hook (redeem, refresh, revoke, capture, search).
#
# Derivation: take .mcpServers["amt-memory"].url (…/inference/memory/mcp/) and strip the
# trailing /mcp[/]. Requires jq (already required by every helper that uses the gateway).
_amt_gateway_base_from_mcp() {
  _amt_mcp="${SCRIPT_DIR:-.}/../../.mcp.json"
  [ -f "$_amt_mcp" ] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  _amt_url="$(jq -r '.mcpServers["amt-memory"].url // empty' "$_amt_mcp" 2>/dev/null || true)"
  [ -n "$_amt_url" ] || return 1
  printf '%s' "$_amt_url" | sed -E 's#/mcp/?$##; s#/$##'
}

if [ -n "${AMT_GATEWAY_BASE:-}" ]; then
  AMT_GATEWAY_BASE="${AMT_GATEWAY_BASE%/}"
else
  AMT_GATEWAY_BASE="$(_amt_gateway_base_from_mcp || true)"
fi
[ -n "$AMT_GATEWAY_BASE" ] || echo "amt-config: gateway not configured (no amt-memory url in .mcp.json); set AMT_GATEWAY_BASE" >&2
AMT_HOOK_BASE="${AMT_HOOK_BASE:-${AMT_GATEWAY_BASE}/hook}"

# --- Token cache ---
# One well-known location all helpers agree on: the plugin's subdir under COPILOT_HOME,
# falling back to ~/.copilot when the env var is unset.
AMT_HOME="${COPILOT_HOME:-${HOME}/.copilot}/amt"
AMT_TOKEN_CACHE="${AMT_HOME}/token.json"

# Refresh when fewer than this many seconds of access-token life remain.
AMT_TOKEN_SKEW_SECONDS="${AMT_TOKEN_SKEW_SECONDS:-120}"
