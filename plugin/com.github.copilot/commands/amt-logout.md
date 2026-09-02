---
name: amt-logout
description: Sign out of AMT memory - revoke this device's hook token and clear the local cache.
---

Sign this device out of AMT memory. Run the bundled logout helper for your OS; it revokes the
hook token at the gateway (so it can never be refreshed again) and deletes the local token
cache, after which the capture/recall hooks go quiet.

Run the helper yourself in this turn. Never print the command for the user to run.

macOS and Linux:

```bash
bash "$(ls -d "${COPILOT_HOME:-$HOME/.copilot}"/installed-plugins/*/amt-memory/com.github.copilot/scripts | head -1)/amt-logout.sh"
```

Windows (PowerShell):

```powershell
$s = Get-ChildItem -Path (Join-Path $HOME '.copilot/installed-plugins') -Recurse -Directory -Filter scripts | Where-Object { $_.FullName -match 'amt-memory' } | Select-Object -First 1
& (Join-Path $s.FullName 'amt-logout.ps1')
```

Report the helper's result in one sentence.
