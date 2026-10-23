---
name: mh-login
description: Enable Memory House using the existing Azure CLI session, only when the user explicitly requests it.
---

Use this skill only for an explicit user request to sign in to Memory House.
Host tool approval still applies; an expired session does not authorize interactive sign-in.

Run `runtime/auth.mjs` in the installed plugin, two folders above this SKILL.md:

```bash
node "<folder containing this SKILL.md>/../../runtime/auth.mjs" login
```

The helper verifies the existing Azure CLI session, enables this plugin on this device,
and prints one safe JSON line. Allow up to 15 seconds. It does not open a browser.
If it reports `AZURE_CLI_AUTH_REQUIRED`, show the safe `az login` command in its error and
ask the user to run it in their own terminal, then retry this skill. For the published
deployment the command is:

```text
az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47 --scope https://dbinference.azure.com/.default --allow-no-subscriptions --output none
```

The user may add `--use-device-code` if their tenant permits it. Never run interactive
`az login` through an agent tool or display device codes in chat.
For `AZURE_CLI_NOT_FOUND`, ask the user to install Azure CLI 2.54+ on the plugin host PATH.
For other errors, report the safe message without claiming sign-in succeeded.

Never display, read or copy access tokens, refresh tokens, Azure CLI cache files or
enrollment credentials. Do not call `enroll_hook_capture`: that flow is no longer supported.
On `signedIn: true`, reply:

`Signed in to Memory House using Azure CLI.`

Hooks and canvas now use this CLI session. Claude Code and Codex use the same session
for MCP headers; reconnect the server or start a new session. Copilot manages its MCP
OAuth sign-in independently. All hosts must see the same CLI profile and plugin state
to share this sign-in.
