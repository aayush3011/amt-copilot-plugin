---
name: amt-login
description: Sign in to AMT memory so capture and recall work automatically on this device.
---

Call the `amt-memory` MCP tool `enroll_hook_capture` exactly once with no arguments.

The plugin's `postToolUse` hook performs local redemption automatically and replaces the
tool result with a safe status message. Follow that replacement message. Do not attempt to
redeem the credential yourself.

Never quote, repeat, summarize, or display an enrollment credential. Never ask the user to
copy a credential or run a helper.

On success, reply only:

`Signed in to AMT memory. Capture and recall are now active on this device.`

If the safe tool result says the credential expired, call `enroll_hook_capture` one more time.
After a second failure, report the safe error without including credential material.
