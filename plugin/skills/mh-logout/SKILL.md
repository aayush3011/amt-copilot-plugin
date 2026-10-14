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

It revokes this device's hook token at the gateway and clears the local sign-in shared by the
user's Memory House apps on this device, after which capture and recall stop. It prints one
JSON line. Report the outcome in one sentence. If remote revocation failed, say that local
credentials were cleared but revocation could not be confirmed; previously issued access
tokens may remain valid until expiry. Never display credentials, and do not sign the user back in.

In Claude Code and Codex this also disconnects the Memory House MCP tools. In Copilot it does
not sign the app out of the Memory House MCP server; the app manages that sign-in.
