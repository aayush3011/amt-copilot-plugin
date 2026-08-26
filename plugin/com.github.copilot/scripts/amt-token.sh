#!/usr/bin/env bash
# amt-token.sh - print a gateway access token on stdout.
#
# Demo-grade: reuse the same delegated Azure CLI sign-in the AMT notebooks use.
# The token carries the developer's identity, so captured/recalled memory lands under
# their user scope. It expires in ~1 hour; re-run `az login` (or just re-trigger) if hooks
# start returning 401 mid-session.
#
# Productizing this is the real follow-up: a cached/refreshed token, or a shared credential
# path so the hooks and the MCP server use one sign-in. See Docs/amt-plugin-design-sketch.md.
set -euo pipefail

AMT_TOKEN_RESOURCE="${AMT_TOKEN_RESOURCE:-api://45cdeed7-4e4e-481d-9f00-6708c0631565}"

if ! command -v az >/dev/null 2>&1; then
  echo "amt-token: Azure CLI 'az' not found on PATH; install from https://aka.ms/azcli and run 'az login'." >&2
  exit 1
fi

az account get-access-token \
  --resource "$AMT_TOKEN_RESOURCE" \
  --query accessToken --output tsv
