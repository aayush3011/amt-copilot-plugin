---
name: mh-status
description: Check whether this device's Memory House hooks and canvas are signed in, without opening a browser.
---

Run the plugin's sign-in helper yourself. It is `runtime/auth.mjs` in the installed plugin,
two folders above the folder that contains this SKILL.md:

```bash
node "<folder containing this SKILL.md>/../../runtime/auth.mjs" status
```

It verifies Azure CLI token acquisition without prompting, which may refresh over the network,
and prints one JSON line. Report whether the plugin is signed in
(`signedIn`) and, if so, its current access-token expiry (`accessExpiresAt`, in Unix seconds).
Azure CLI handles renewal; this expiry is not a promise of unattended access. Do not show
credentials or deployment URLs. Being signed in does not prove that this app runs the capture
hooks; refer to the documented support limits rather than claiming automatic capture.

If sign-in is needed, suggest the `mh-login` skill, but do not invoke it unless the user asks.
In Claude Code and Codex this sign-in also connects the Memory House MCP tools; in Copilot the
app signs in to those tools itself, which this helper does not report.
