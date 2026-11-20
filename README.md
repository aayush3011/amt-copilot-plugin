# Memory House

Memory House gives your coding agent a memory that lasts across sessions. It remembers your preferences, decisions and fixes, and brings them back when they help.

> **Availability:** The **Claude Code** and **Codex** plugins are **not active right now**; we will release them soon. For now, use Memory House in **GitHub Copilot**.

## What it does

- **Remembers automatically.** Your prompts and the agent's final answers go to Memory House, which decides what is worth keeping.
- **Recalls automatically.** On the first prompt of a session (20 characters or more), it adds up to 10 relevant memories to the conversation. After that, the agent searches when it needs more.
- **Remembers on request.** Say "Remember in Memory House that I prefer concise examples."
- **Shows what it knows.** The Copilot app canvas lists your memories and lets you review recalls.

Automatic capture depends on the host running the plugin's hooks. A successful `mh-status` proves you are signed in, not that the host runs them.

## Install (GitHub Copilot)

You need Node.js 20+, a browser and OS credential protection: Windows PowerShell/DPAPI, an unlocked macOS Keychain, or Linux `secret-tool` with an unlocked Secret Service. Your organization must allow the plugin, the remote MCP server and conversation capture.

- **Copilot app:** **Customize → Plugins → Add custom marketplace**, enter `aayush3011/amt-copilot-plugin`, then install **Memory House**.
- **Copilot CLI:** `/plugin marketplace add aayush3011/amt-copilot-plugin`, then `/plugin install memory-house@memory-house-marketplace`.

Approve the Memory House MCP connection and hooks when asked. **Restart the session after installing or upgrading.** Install one copy; don't also configure a second Memory House MCP server or duplicate hooks. Remote and cloud sessions run elsewhere and don't inherit your local sign-in.

## Sign in

1. Run `/memory-house:mh-login`. Microsoft's sign-in page opens in your browser. Finish your account and MFA there, never in chat.
2. Choose **Sign in** on the Memory House MCP connection (`/mcp` in the CLI). Copilot manages that sign-in separately, and both use port 33418, so do them one after the other.
3. Run `/memory-house:mh-status`, then try the tools.

Other OS users, remote machines and headless sessions need their own sign-in. `/memory-house:mh-logout` stops the plugin's requests and deletes its stored sign-in. It doesn't revoke your Microsoft tokens or Copilot's MCP sign-in.

## Commands

| Command | What it does |
| --- | --- |
| `/memory-house:mh-login` | Sign in |
| `/memory-house:mh-logout` | Sign out |
| `/memory-house:mh-status` | Check your sign-in |
| `/memory-house:mh-memory` | Search or remember |
| `/memory-house:mh-show` | Open the canvas (Copilot app) or list recent memories |
| `/memory-house:mh-telemetry` | See or change feedback telemetry (see [Privacy and feedback](#privacy-and-feedback)) |

The `use-memory` skill has no command: the agent loads it during real work and searches when earlier preferences, decisions, fixes or commands could help. Login and logout run only when you ask.

You can also just ask:

- "Show my Memory House memories."
- "Search Memory House for my TypeScript preferences."
- "Remember in Memory House that I prefer concise examples."

The agent deletes memories only when you explicitly ask. A saved note may take a moment to become searchable.

## MCP tools

The plugin connects your agent to the Memory House MCP server. Its tools cover your personal memories (search, save, delete and summaries) and shared memory in hierarchies of Spaces (browsing and searching Spaces, invitations and roles, your Private Space, and promoting memories). See [Memory House MCP tools](docs/mcp-tools.md) for the full list and what each tool does.

## Automatic memory

**Capture.** Hooks send each of your prompts and the agent's final answer in the main conversation, and Memory House decides what to keep. Tool output and private reasoning aren't sent, and common credentials are filtered. This isn't comprehensive data-loss protection, so enable capture only where your data policy allows sending conversation text to your Memory House deployment. If Memory House is unreachable or your sign-in has expired, turns wait in an encrypted local queue (up to 200 turns or 7 days) and are sent later. Signing out discards them.

**Recall.** On the first prompt of at least 20 characters, Memory House adds up to 10 relevant memories, each with its type and date (and `until YYYY-MM-DD` when a fact has an end date). Conflicting versions are shown together. Nothing is added when nothing relevant is found. Shorter prompts are skipped, and the next qualifying prompt gets the search. There is no automatic search after that; the agent calls the Memory House search tool when it needs more. Optional settings: `MEMORY_HOUSE_TOP_K` (1-20, default 10) and `MEMORY_HOUSE_MIN_RECALL_CHARS` (default 20; `0` turns the minimum off).

## Memory House canvas (GitHub Copilot app)

Run `/memory-house:mh-show` or ask to open the Memory House canvas. The side panel shows:

- your memories, personal and from any hierarchy node you can read, with search, type filters and auto-refresh;
- **Import memory**, which adds recent Copilot or Claude Code sessions and saved memories (text is credential-filtered first);
- **Recent recalls & privacy**, for reviewing recalls and managing telemetry.

It runs locally on `127.0.0.1` using the plugin's sign-in. If it says you're not signed in, run `/memory-house:mh-login` and select **Refresh**. Deleting and promoting memories aren't available from the panel.

## Troubleshooting

- **Tools missing:** check that the plugin and its `memory-house` MCP server are enabled and that your organization allows remote MCP servers. Run `/memory-house:mh-login`, then sign in to the MCP connection (`/mcp`) or start a new session.
- **Command or tool missing after an update:** restart the session. Skills and MCP connections load at session start.
- **Sign-in required or expired:** run `/memory-house:mh-login`; hooks never prompt. Conditional Access, revoked sessions or missing consent may need you or an administrator to act. If sign-in times out, check your connection and credential store.
- **Credential store unavailable:** unlock Keychain or Secret Service. Linux needs `secret-tool` (often `libsecret-tools`) and Windows needs PowerShell/DPAPI. There is no plaintext fallback; never paste cache contents into chat.
- **401/403 from the gateway:** your account may lack access or consent. Contact your Memory House administrator.
- **Canvas missing in the Copilot app:** start a new session after installing or updating, and check that the `plugin:memory-house:memory-canvas` extension isn't disabled in the app's extension settings.
