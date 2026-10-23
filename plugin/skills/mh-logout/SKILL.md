---
name: mh-logout
description: Sign this device's Memory House hooks and canvas out only when the user explicitly requests it; affects all apps sharing this OS user.
---

Use this skill only for an explicit user request to sign out of Memory House. Being
discoverable does not authorize logout; host tool approval still applies.

Run the plugin's sign-in helper yourself in this turn; never print the command for the user
to run. The helper is `runtime/auth.mjs` in the installed plugin, two folders above the
folder that contains this SKILL.md:

```bash
node "<folder containing this SKILL.md>/../../runtime/auth.mjs" logout
```

It writes a credential-free disabled preference shared by Memory House apps using this
state directory, after which new plugin capture, recall, canvas and header requests stop.
It removes obsolete plugin token files but does not revoke Entra tokens or run `az logout`;
other Azure CLI consumers remain signed in. In-flight requests or host-cached headers can
remain authorized until their access tokens expire. Reconnect MCP to drop cached headers.
It prints one JSON line. Report the outcome in one sentence, including that Azure CLI remains
signed in. Never display credentials or sign the user back in.

In Claude Code and Codex this also disconnects the Memory House MCP tools. In Copilot it does
not sign the app out of the Memory House MCP server; the app manages that sign-in.
