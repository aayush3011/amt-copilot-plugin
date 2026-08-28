---
name: amt-login
description: Sign in to AMT memory so capture and recall work automatically on this device.
---

Enroll this device for AMT memory. The plugin is not an OAuth client, so sign-in is a
one-time, two-step enrollment. Do exactly this and nothing else:

1. Call the `enroll_hook_capture` MCP tool (no arguments). It returns a short-lived,
   single-use `enrollment_code` bound to your identity.

2. Redeem that code with the bundled login helper. First locate the plugin's scripts dir,
   then run the helper for your OS:

   - macOS / Linux:
     ```
     SCRIPTS="$(find "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins" -type d -path '*amt-memory/com.github.copilot/scripts' 2>/dev/null | head -1)"
     bash "$SCRIPTS/amt-login.sh" "<enrollment_code>"
     ```
   - Windows (PowerShell):
     ```
     $Scripts = Get-ChildItem -Recurse -Directory "$env:COPILOT_HOME","$HOME/.copilot" -Filter scripts -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'amt-memory' } | Select-Object -First 1
     pwsh "$($Scripts.FullName)/amt-login.ps1" "<enrollment_code>"
     ```

3. Report the helper's result. The code expires in a few minutes and can be used once; if it
   failed, call `enroll_hook_capture` again for a fresh code and retry step 2.

Never print, log, or store the enrollment code or the returned tokens anywhere else. The
helper caches the token securely; the hooks read it and refresh silently from then on.
