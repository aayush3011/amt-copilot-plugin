---
name: mh-login
description: Sign in to Memory House in the Microsoft browser window, only when the user explicitly requests it.
---

Use this skill only for an explicit user request to sign in to Memory House.
Host tool approval still applies; an expired session does not authorize interactive sign-in.

Run `runtime/auth.mjs` in the installed plugin, two folders above this SKILL.md:

```bash
node "<folder containing this SKILL.md>/../../runtime/auth.mjs" login
```

The helper opens Microsoft's sign-in page in the system browser and waits up to three
minutes for the loopback callback. Allow up to four minutes for the command. Tell the
user to select their account and complete any credentials/MFA only in that Microsoft
window. Never ask for a password, MFA response, authorization code or token in chat.
Existing Microsoft browser sessions may avoid another credential prompt.

On success it enables this plugin and saves an OS-protected MSAL cache for reuse and
silent renewal. Azure CLI is not required. Windows uses DPAPI; macOS requires an unlocked
Keychain; Linux requires secret-tool and an unlocked Secret Service. If protection is
unavailable, report the safe error; never bypass it or write plaintext credentials.
For other errors, report the safe message without claiming sign-in succeeded.

Never display, read or copy access tokens, refresh tokens, sign-in cache files or
enrollment credentials. Do not call `enroll_hook_capture`: that flow is no longer supported.
On `signedIn: true`, reply:

`Signed in to Memory House with Microsoft Entra ID.`

Hooks and canvas now use the protected cache without opening a browser. Claude Code and Codex use the same session
for MCP headers; reconnect the server or start a new session. Copilot manages its MCP
OAuth sign-in independently. All hosts must use the same OS user and plugin state directory
to share this sign-in.
