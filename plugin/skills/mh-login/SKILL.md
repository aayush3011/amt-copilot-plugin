---
name: mh-login
description: Sign in this device to Memory House so automatic memory capture, recall, and the Memory House canvas work.
---

# Sign in to Memory House

When the user invokes this skill, call the `memory-house` MCP tool `enroll_hook_capture` exactly
once with no arguments.

The plugin's `postToolUse` hook automatically redeems the returned enrollment credential on
this device and replaces the tool result with a safe status message. Follow that replacement
message.

Never quote, repeat, summarize, or display an enrollment credential. Never ask the user to
copy a credential or run a helper. On success, reply only:

`Signed in to Memory House. Capture and recall are now active on this device.`

If the safe tool result says the credential expired, call `enroll_hook_capture` one more time.
After a second failure, report the safe error without including credential material.
