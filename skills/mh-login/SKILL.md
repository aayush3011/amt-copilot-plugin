---
name: mh-login
description: Open Microsoft sign-in directly in the browser to connect Memory House.
disable-model-invocation: true
---

Call the plugin's `memory_login` MCP tool with no arguments. It opens the
Microsoft sign-in page directly in the user's browser and waits for account
sign-in and consent. Report the tool's outcome, not a sign-in URL. Never put
credentials, tokens, enrollment codes, or registration details in chat.
Select the tool by its exact unqualified name `memory_login`, allowing only a
host/plugin namespace prefix. Do not select tools by searching descriptions;
other tools can mention sign-in without being the login tool.

If the plugin reports missing publisher configuration, tell the user that its
publisher must complete the packaged deployment settings. Do not invent a
client ID or callback, edit app configuration, or send credentials elsewhere.
Use `memory_status` to confirm sign-in after the user finishes.
