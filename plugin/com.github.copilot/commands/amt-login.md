---
name: amt-login
description: Sign in to AMT memory so capture and recall work automatically on this device.
---

Enroll this device for AMT memory.

This is a single task with two tool calls. You are not finished until the shell command in
step 2 has run. Do both in this turn.

Hard rules:

- The enrollment code is a short-lived credential. Never repeat it in your reply, a summary,
  a file, or any tool call other than the login helper in step 2.
- Never stop after step 1. A code that is not redeemed leaves the user signed out, which is
  the same as doing nothing.
- Never ask the user to run the helper themselves, and never print the command for them to
  copy. Run it yourself.

**Step 1.** Call the `enroll_hook_capture` MCP tool with no arguments. It returns a
single-use `enrollment_code` that expires in a few minutes.

**Step 2.** Immediately run the login helper, replacing `CODE` with the code from step 1.

macOS and Linux:

```bash
bash "$(ls -d "${COPILOT_HOME:-$HOME/.copilot}"/installed-plugins/*/amt-memory/com.github.copilot/scripts | head -1)/amt-login.sh" CODE
```

Windows (PowerShell):

```powershell
$s = Get-ChildItem -Path (Join-Path $HOME '.copilot/installed-plugins') -Recurse -Directory -Filter scripts | Where-Object { $_.FullName -match 'amt-memory' } | Select-Object -First 1
& (Join-Path $s.FullName 'amt-login.ps1') CODE
```

**Step 3.** Report the outcome in one sentence and nothing else.

- On success, say exactly: `Signed in to AMT memory. Capture and recall are now active on
  this device.`
- If the helper says the code was invalid or expired, repeat steps 1 and 2 once with a fresh
  code before reporting failure.
- If it still fails, report the helper's error message. Never include the code.
