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
# AMT_GATEWAY_BASE ends at /inference/memory; the self-authenticating hook surface lives
# under /inference/memory/hook (redeem, refresh, revoke, capture, search).
AMT_GATEWAY_BASE="${AMT_GATEWAY_BASE:-https://reranker-api-h2b5czhkfkcphnf4.westus3-01.azurewebsites.net/inference/memory}"
AMT_HOOK_BASE="${AMT_HOOK_BASE:-${AMT_GATEWAY_BASE}/hook}"

# --- Token cache ---
# One well-known location all helpers agree on: the plugin's subdir under COPILOT_HOME,
# falling back to ~/.copilot when the env var is unset.
AMT_HOME="${COPILOT_HOME:-${HOME}/.copilot}/amt"
AMT_TOKEN_CACHE="${AMT_HOME}/token.json"

# Refresh when fewer than this many seconds of access-token life remain.
AMT_TOKEN_SKEW_SECONDS="${AMT_TOKEN_SKEW_SECONDS:-120}"
