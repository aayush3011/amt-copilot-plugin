---
name: amt-login
description: Sign in to AMT memory so capture and recall work automatically on this device.
---

Enroll this device for AMT memory.

This is one task with two calls. You are not finished after the first. Do both in this turn.

Hard rules:

- The enrollment code is a credential. Never show it to the user, never put it in your reply
  or a summary, and never pass it anywhere except the redemption call in step 2.
- Never stop after step 1. An unredeemed code leaves the user signed out, which is the same
  as doing nothing. Saying "enrolled" without completing step 2 is a false claim.
- Never ask the user to run anything themselves.

**Step 1.** Call the `enroll_hook_capture` MCP tool with no arguments. It returns a
single-use `enrollment_code` that expires in a few minutes.

**Step 2.** Redeem it. Use the first option that is available to you:

- **Preferred, and the only option in the Copilot app:** call the `amt-memory` canvas action
  `complete_signin`, passing the code as `enrollment_code`. If the canvas is not open yet,
  open the `amt-memory` canvas first, then call the action. This is the correct path whenever
  you do not have a shell tool.

- **Only if you have a shell tool** (Copilot CLI), run:

  ```bash
  bash "$(ls -d "${COPILOT_HOME:-$HOME/.copilot}"/installed-plugins/*/amt-memory/com.github.copilot/scripts | head -1)/amt-login.sh" CODE
  ```

  On Windows, run `amt-login.ps1` from that same directory with the code as its argument.

**Step 3.** Report the outcome in one sentence and nothing else.

- On success: `Signed in to AMT memory. Capture and recall are now active on this device.`
- If redemption reports an invalid or expired code, repeat steps 1 and 2 once with a fresh
  code before reporting failure.
- If it still fails, report the error message without the code.
