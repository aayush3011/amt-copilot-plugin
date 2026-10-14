# Memory House

**One repository. One plugin. Shared memory across Claude Code, Codex and
GitHub Copilot.**

Add this repository as a marketplace, install **Memory House**, and sign in with
Microsoft. The application selects its native adapter from the same installed
plugin. The memory tools come from the deployed Memory House MCP server, which
every app reaches by URL; the plugin adds native capture hooks, skills, the
Copilot app canvas and a small sign-in helper. No clone, build, ZIP selection,
global CLI, or per-project hook installation is required for users.

**Repository:** <https://github.com/aayush3011/amt-copilot-plugin>

**Automatic capture depends on the host running the plugin's hooks.**
The live verification below is more authoritative than the presence of hook
files in the package. A successful `mh-status` proves sign-in, not that
the host executes capture hooks.

## Verified CLI support

Observed on 2026-09-16, when the plugin still ran its own local MCP server. The
remote MCP server and the hook-based sign-in described below have not yet been
re-verified live in Claude Code and Codex.

| Host version | Plugin MCP tools | Automatic per-turn capture from the plugin |
| --- | --- | --- |
| **Copilot CLI 1.0.81-4** | Real login, search, explicit add, status, logout and sign-in restoration passed | **Passed:** ordinary user and final agent turns accepted by the gateway; recall injected on a later turn without explicit memory calls |
| **Codex CLI 0.154.0** | Real login, search, explicit add, status, logout and restoration passed | **Passed with native hook trust:** two tool-free turns each produced one HTTP 201 user capture and one agent capture; recall injected on the later turn |
| **Claude Code 2.1.273** | Real Microsoft login, search, explicit add, status, logout and restoration passed after correcting the Claude provider login configuration | **Passed:** two tool-free turns each produced one HTTP 201 user capture and one final-agent capture, with matching thread/content hashes and recall on the later turn |

The model is never the routine capture gatekeeper. Where host hooks run, they
send every conversational user turn and final agent turn; the AMT backend
decides what to extract, consolidate, or discard. **Do not replace missing hook
support with model-selected `add_memory` calls.** See
[the evidence and scope details](docs/maintaining.md#live-cli-limitations).

> Repository installation uses the published GitHub ref. The `plugin/` payload and
> its bundled runtime must be published before the link delivers this version;
> changing an uncommitted local checkout does not update an installed plugin.
> Current development is published on `feature/unifiedMemoryHousePlugin`, not
> merged into `main`. Select that ref explicitly to get this version.

## Install in your application

Requires a current supported desktop/local plugin host and Node.js 20+ available
to its processes. Your organization must permit the plugin, the remote Memory
House MCP server, and conversation capture.

| Application | Add this repository, then install Memory House |
| --- | --- |
| **Claude Desktop, Code tab** | Add `aayush3011/amt-copilot-plugin` as a marketplace with `/plugin marketplace add`, then choose **+ -> Plugins -> Add plugin** and install `memory-house@memory-house-marketplace` in user scope. This targets Claude Code, not ordinary Claude Chat. |
| **Codex desktop** | Add `aayush3011/amt-copilot-plugin` as a marketplace through the host's repository-marketplace flow (`codex plugin marketplace add aayush3011/amt-copilot-plugin` where exposed). Select **Memory House** in Plugins Directory and install it. Review and trust the bundled hooks with `/hooks`. |
| **GitHub Copilot app / CLI** | Add `aayush3011/amt-copilot-plugin` in **Customize -> Plugins -> Add custom marketplace**, then install **Memory House**. The native command equivalent is `/plugin marketplace add aayush3011/amt-copilot-plugin`, then `/plugin install memory-house@memory-house-marketplace`. |

The tested branch selectors are:

```text
claude plugin marketplace add aayush3011/amt-copilot-plugin@feature/unifiedMemoryHousePlugin
codex plugin marketplace add aayush3011/amt-copilot-plugin --ref feature/unifiedMemoryHousePlugin
copilot plugin marketplace add aayush3011/amt-copilot-plugin#feature/unifiedMemoryHousePlugin
```

Then install `memory-house@memory-house-marketplace` with `claude plugin install`,
`codex plugin add`, or `copilot plugin install`.

Approve the Memory House MCP connection and hooks when the host asks. **Restart
the session after a plugin upgrade:** MCP connections and tool definitions bind
at session start, so reloading skills alone may leave the old ones in place.
Install one copy; do not also configure a second Memory House MCP server or
duplicate hooks manually. Remote/cloud sessions run elsewhere and do not inherit
your local sign-in.

## Sign in, list, search, remember

Every app reaches the same deployed MCP server (`.../inference/memory/mcp/`);
how it signs in differs:

- **GitHub Copilot: two sign-ins.** The app signs in to the MCP server with
  Microsoft itself, using the standard MCP sign-in the gateway advertises, and
  keeps that token. Run **`mh-login`** for the plugin's hooks and canvas: the
  agent calls the remote `enroll_hook_capture` tool once, and the plugin's
  post-tool hook redeems the returned one-time code and replaces the tool result
  before the model sees it.
- **Claude Code and Codex: one sign-in.** Run **`mh-login`**; the agent runs the
  plugin's sign-in helper, which opens Microsoft sign-in in your browser. That
  sign-in serves the hooks and the MCP tools: before connecting, each app runs a
  plugin command that adds the plugin's token to its requests. Their own MCP
  sign-in can't be used, because Microsoft rejects the `resource` value they send
  (`AADSTS9010010`). See
  [maintainer documentation](docs/maintaining.md#remote-mcp-server-and-sign-in).

No password, token, or enrollment code goes through chat.

**One plugin sign-in serves every host.** Claude Code, Codex and Copilot running
on the same machine as the same OS user share `~/.memory-house/token.json`.
Signing in through any one of them connects the others, including the MCP tools
in Claude Code and Codex; signing out affects them all. Copilot's MCP sign-in is
its own. Codex's MCP connection always uses `~/.memory-house` and `~/.codex`, so a
custom `MEMORY_HOUSE_HOME` or `CODEX_HOME` doesn't reach it. Remote/cloud
sessions, different OS users, or an explicitly different `MEMORY_HOUSE_HOME` use
separate Memory House state and need their own sign-in.

| Host | Sign in | Sign out | Status | Search / remember |
| --- | --- | --- | --- | --- |
| **Claude Code** | `/memory-house:mh-login` | `/memory-house:mh-logout` | `/memory-house:mh-status` | `/memory-house:mh-memory` |
| **Copilot app / CLI** | `/memory-house:mh-login` | `/memory-house:mh-logout` | `/memory-house:mh-status` | `/memory-house:mh-memory` |
| **Codex CLI 0.154.0 plugin** | `$memory-house:mh-login` | `$memory-house:mh-logout` | `$memory-house:mh-status` | `$memory-house:mh-memory` |

Codex also provides `/skills` or `$` to select a skill. Its tested native
plugin loader registers **`memory-house:mh-login`**, including the namespace;
generic standalone-skill examples using `$mh-login` do not describe this plugin.
Claude Code and Copilot likewise namespace plugin commands. Use the names in
the host's picker rather than guessing a bare alias. Desktop/IDE surfaces can
differ: ChatGPT's desktop skill picker uses `@`.

All six skills are discoverable. Login and logout still require an explicit
user request, and the host's tool approval remains in effect. `mh-logout`,
`mh-status` and, in Claude Code and Codex, `mh-login` run the plugin's
`runtime/auth.mjs` helper; none of them touches Copilot's own MCP sign-in.
After an update, restart the session so both the skills and MCP connection are
refreshed.
**`mh-show`** (`/memory-house:mh-show` in Copilot) opens the Memory House canvas
in the GitHub Copilot app; other hosts get a text listing of recent memories.
**`use-memory`** has no command: the agent loads it during real work and calls
`search_memories` before starting a task, so the query and the returned memories
show up as a tool call.

Then ask:

- **"Show my Memory House memories."**
- **"Search Memory House for my TypeScript preferences."**
- **"Remember in Memory House that I prefer concise examples."**

The tools come from the remote Memory House MCP server: `get_memories`,
`search_memories`, `add_memory`, `get_memory`, `get_memory_history`, summaries,
write-status tools, `whoami`, `enroll_hook_capture`, and `delete_memory` /
`delete_all_memories`. Tool names may carry the app's plugin or server
namespace. Identity comes from your authenticated sign-in, never from a
model-supplied user, tenant, or endpoint. The skills tell the agent to delete
only on an explicit request, after confirming what will be deleted.

`get_memories` lists memories newest first, up to 50 per page. For "get my
memories" or "show some memories", one call and "Here are your N most recent
memories" is a complete answer; the agent follows `next_cursor` only when you
ask for more, "all", a full list or an export, or the task genuinely needs
exhaustive coverage. Optional `memory_types` (`fact`, `episodic`,
`procedural`) filters the listing within the gateway's access checks.
`search_memories` is query-based retrieval (up to 50 results, most relevant
first), not an exhaustive listing.

If an exposed tool cannot complete a request, the agent must report that
limitation, not inspect plugin bundles or credentials, import internal modules,
reverse-engineer other services, or call the gateway directly as a workaround.
Memory House tools are the supported access path.

`add_memory` is only a one-off write for an explicit "remember this." It is not
routine capture. Hooks send the conversation automatically; the model must not
call `add_memory` just because something seems important. The skills have the
agent store the request as a fact (`extract: false`).

**Remembering is asynchronous.** Acceptance is not a promise that the note is
already searchable. Capture is best-effort: no queue, automatic replay, or new
deduplication contract is added.

## Memory House canvas (GitHub Copilot app)

In the GitHub Copilot app, run `/memory-house:mh-show` or ask to open the Memory
House canvas. The side panel shows:

- **Where your memories live:** your personal memories, then every hierarchy
  node you can read as a curator or member, nested by path (for example
  *Cosmos DB SDKs / Python SDK / your branch node*). A node lists both copies
  promoted into it and memories a curator wrote there directly. Nodes with no
  memories still appear. Memories in a node outside your current hierarchy view
  are listed under **Other scopes**.
- Search, memory-type, superseded and count filters (the newest 1 to 200
  memories), plus auto-refresh (15 seconds by default), so promotions and
  extraction results appear without reopening the panel.
- **Import memory**, which reads local history without modifying it and sends it
  to your personal memories:
  - **Recent sessions** from GitHub Copilot or Claude Code (the 100 newest; pick
    any). User turns and final agent turns go through Memory House extraction,
    like live capture.
  - **Saved memories**: Copilot's `storeMemory` facts or Claude Code project
    memory files are published as facts, followed by one reconciliation.
  - Text is filtered for credentials and runtime context first. Original
    timestamps are not kept. Re-importing an unchanged session replays the
    earlier request rather than duplicating it.

The canvas uses the plugin's sign-in, like the hooks. If it reports that you are
not signed in, run `mh-login`, then select **Refresh**. It
runs only in the GitHub Copilot app, as a local panel served on `127.0.0.1`.
Deleting and promoting memories are not available from the panel.

## Automatic memory

**Hooks are the capture path, where admitted by the host.** They attempt to send every user
turn and every final agent turn in the main conversation to Memory House/AMT,
without waiting for the model to call a tool or decide that a turn is important.
The **AMT backend core** decides what to extract, consolidate, or discard.
Capture is best-effort when sign-in, networking, or host payloads are unavailable.

The adapters declare startup and per-prompt recall for Claude Code and Codex.
Codex's native legacy manifest exposes its plugin hooks for review with `/hooks`;
the earlier portable manifest prevented their discovery. Claude's startup,
per-prompt recall and final-answer capture were verified with its native hooks.
Copilot recalls at
startup and during prompt transformation, with post-tool fallback.

The automatic stream contains original user text and final assistant answers,
not tool outputs or private reasoning. Common credentials and runtime envelopes are filtered.
This is not comprehensive DLP: enable capture only where your data policy
allows sending conversation text to your Memory House deployment.

## Troubleshooting

- **Connection missing:** confirm the plugin and its `memory-house` MCP server
  are enabled, the app can reach the gateway, and enterprise policy permits
  remote MCP servers. The hooks and helper also need Node.js 20+.
- **Memory House tools missing in Claude Code or Codex:** run `mh-login`, then
  reconnect the server (`/mcp` in Claude Code) or start a new session. Don't use
  the app's own Authenticate for this server; Microsoft rejects it
  (`AADSTS9010010`). See
  [maintainer documentation](docs/maintaining.md#remote-mcp-server-and-sign-in).
- **Skill not found:** update the plugin and start a fresh session. For Codex,
  use `$memory-house:mh-login` or select it with `$`/`/skills`; for Copilot use
  `/memory-house:mh-login`. A host inventory listing and the model's currently
  loaded skill list can differ. Do not read credential files to work around it.
- **New tool missing after upgrade:** restart the session, not just the
  marketplace or skill list; MCP connections and tool lists bind at session
  start. Do not compensate by reading bundles or credentials, launching extra
  servers manually, or calling the gateway directly.
- **Codex hooks need review:** run `/hooks`, review Memory House's session-start,
  user-prompt, stop and post-tool hooks, and trust those definitions. The
  post-tool hook only completes `mh-login`. Do not bypass hook trust or install
  duplicate user/project hooks.
- **Canvas missing in the Copilot app:** start a new session after installing
  or updating, and check that the `plugin:memory-house:memory-canvas`
  extension is not disabled in the app's extension settings. An earlier
  Memory House canvas used the same extension ID, so disabling that one also
  disables this one.
- **Disable Codex capture:** use `/hooks` to turn off Memory House's capture
  hooks while keeping its MCP tools. To remove the integration instead, run
  `codex plugin remove memory-house@memory-house-marketplace`, then optionally
  `codex plugin marketplace remove memory-house-marketplace`. This does not
  erase previously captured memories or sign the other apps out.
- **Sign-in required/expired:** run `mh-login`; `mh-status` is local-only and
  never returns credentials. In Copilot, sign in to the MCP tools again when the
  app asks.
- **Sign-in port occupied:** the sign-in helper listens on
  `http://127.0.0.1:33418` for Microsoft's reply. Finish or close another active
  Memory House sign-in and retry; the plugin does not choose another port.
- **`mh-login` result shows a code:** the post-tool hook did not run (for
  example, Codex hooks not yet trusted). Do not copy the code; fix the hook and
  run `mh-login` again.
- **Publisher configuration error:** contact the publisher rather than entering
  registration settings or credentials in chat.
- **Claude “Credit balance is too low” with a Pro subscription:** check Claude's
  login configuration before assuming insufficient funds. In this verification,
  `"forceLoginMethod": "console"` in Claude settings forced Console/API-credit
  auth instead of the intended Claude Pro identity. Correcting that pin with
  user approval, then running `claude auth logout` and `claude auth login`,
  restored the subscription. `claude auth status` should show the intended
  `subscriptionType` (here, `"pro"`); `loggedIn: true` alone was misleading.
  Respect managed login policy. This is separate from Memory House's Microsoft
  sign-in and required no plugin, gateway, or billing-plan change.
- **Sign out:** use `mh-logout`. This clears the shared local credentials and
  attempts refresh-token revocation without opening a browser, which also
  disconnects the MCP tools in Claude Code and Codex. Existing access tokens
  remain subject to their issued expiry. Copilot manages its own MCP sign-in.

The single installable payload is **`plugin/`**. All three marketplace catalogs
stay at the repository root and select `./plugin`; the GitHub URL and install
commands do not change. Inside the payload, `.claude/`, `.codex/` and `.github/`
select host behavior, while `runtime/` contains the shared bundled
implementation. Installed plugin roots contain no repository `.git`, tests,
maintainer dependencies, source, build scripts, or developer documentation.
See
[maintainer documentation](docs/maintaining.md) for loader contracts, dependency
licenses, publisher defaults, rebuilding, verification and publication.
