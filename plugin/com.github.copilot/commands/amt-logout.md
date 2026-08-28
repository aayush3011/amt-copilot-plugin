---
name: amt-logout
description: Sign out of AMT memory - revoke this device's hook token and clear the local cache.
---

Sign this device out of AMT memory. Run the bundled logout helper for your OS; it revokes the
hook token at the gateway (so it can never be refreshed again) and deletes the local token
cache, after which the capture/recall hooks go quiet.

- macOS / Linux:
  ```
  SCRIPTS="$(find "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins" -type d -path '*amt-memory/com.github.copilot/scripts' 2>/dev/null | head -1)"
  bash "$SCRIPTS/amt-logout.sh"
  ```
- Windows (PowerShell):
  ```
  $Scripts = Get-ChildItem -Recurse -Directory "$env:COPILOT_HOME","$HOME/.copilot" -Filter scripts -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'amt-memory' } | Select-Object -First 1
  pwsh "$($Scripts.FullName)/amt-logout.ps1"
  ```

Report the helper's result.
