---
name: memory-login
description: Sign in to Memory House with Microsoft in a private local browser page.
disable-model-invocation: true
---

Call the plugin's `memory_login` MCP tool with no arguments. Show the returned
local page link. The user selects Sign in with Microsoft and completes their
account sign-in and consent privately; no registration details or credentials
belong in chat.

If the plugin reports missing publisher configuration, tell the user that its
publisher must complete the packaged deployment settings. Do not invent a
client ID or callback, edit app configuration, or send credentials elsewhere.
Use `memory_status` to confirm sign-in after the user finishes.
