---
name: mh-status
description: Check local Memory House sign-in status without opening a browser or making a network request.
---

Call the plugin's `memory_status` MCP tool with no arguments. Report whether
Memory House is signed in and whether a sign-in attempt is running, completed,
cancelled, or failed. Do not show credentials or deployment URLs.

If sign-in is required, suggest the `mh-login` skill, but do not invoke it unless
the user asks. A publisher-configuration error requires the publisher to fix
the packaged settings, not the user to paste registration details into chat.
