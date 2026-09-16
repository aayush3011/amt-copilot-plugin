---
name: mh-login
description: Open Microsoft sign-in directly in the browser to connect Memory House.
disable-model-invocation: true
---

Call the plugin's `memory_login` MCP tool with no arguments. It opens the
Microsoft sign-in page directly in the user's browser and waits for account
sign-in and consent. Report the tool's outcome, not a sign-in URL. Never put
credentials, tokens, enrollment codes, or registration details in chat.

If the plugin reports missing publisher configuration, tell the user that its
publisher must complete the packaged deployment settings. Do not invent a
client ID or callback, edit app configuration, or send credentials elsewhere.
Use `memory_status` to confirm sign-in after the user finishes.
