---
name: mh-login
description: Sign in to Memory House on this device only when the user explicitly requests it.
---

Use this skill only for an explicit user request to sign in to Memory House. Being
discoverable does not authorize sign-in: do not start it because another tool reports an
expired session. Host tool approval still applies.

**If the Memory House MCP tool `enroll_hook_capture` is available** (GitHub Copilot signs in
to the Memory House MCP server itself), call it exactly once with no arguments. Select it by
that exact name, allowing only a host/plugin namespace prefix. The plugin's post-tool hook
redeems the returned enrollment code on this device and replaces the tool result with a
status message before you see it. Follow that message. If it says the code was invalid or
expired, call `enroll_hook_capture` one more time.

**Otherwise** (Claude Code and Codex, whose Memory House tools use this same sign-in), run the
plugin's sign-in helper yourself. It is `runtime/auth.mjs` in the installed plugin, two
folders above the folder that contains this SKILL.md:

```bash
node "<folder containing this SKILL.md>/../../runtime/auth.mjs" login
```

It opens Microsoft sign-in in the user's browser and waits up to three minutes for the user
to finish, so give the command at least that long to run. It prints one JSON line: report
whether `signedIn` is true, not a sign-in URL. The Memory House tools then connect in a new
session, or after reconnecting the server (`/mcp` in Claude Code).

Never quote, repeat, summarize or display an enrollment code or credential, and never ask
the user to copy one. On success, reply only:

`Signed in to Memory House. Capture and recall are now active on this device.`

After a second failure, report the error without any code. If a tool result ever shows an
enrollment code, the hook did not run: say that sign-in could not finish and do not repeat it.

One sign-in covers Claude Code, Codex and Copilot on the same machine and OS user that use
the default shared state directory. In Copilot, the MCP tools also need the app's own sign-in.
