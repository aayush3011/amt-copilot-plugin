# Memory House

**One repository. One plugin. Shared memory across Claude Code, Codex, Cursor,
and GitHub Copilot.**

Add this repository as a marketplace, install **Memory House**, and sign in with
Microsoft. The application selects its native adapter from the same installed
repository. Search and remembering tools, automatic conversation hooks, and
their dependencies are included. No clone, build, ZIP selection, global CLI,
or per-project hook installation is required for users.

**Repository:** <https://github.com/aayush3011/amt-copilot-plugin>

> Repository installation uses the published GitHub ref. This root package and
> its bundled runtime must be published before the link delivers this version;
> changing an uncommitted local checkout does not update an installed plugin.

## Install in your application

Requires a current supported desktop/local plugin host and Node.js 20+ available
to its processes. Your organization must permit the plugin, local MCP servers,
and conversation capture.

| Application | Add this repository, then install Memory House |
| --- | --- |
| **Claude Desktop, Code tab** | Add `aayush3011/amt-copilot-plugin` as a marketplace with `/plugin marketplace add`, then choose **+ -> Plugins -> Add plugin** and install `memory-house@memory-house-marketplace` in user scope. This targets Claude Code, not ordinary Claude Chat. |
| **Codex desktop** | Add `aayush3011/amt-copilot-plugin` as a marketplace through the host's repository-marketplace flow (`codex plugin marketplace add aayush3011/amt-copilot-plugin` where exposed). Select **Memory House** in Plugins Directory and install it. Review and trust the bundled hooks with `/hooks`. |
| **GitHub Copilot app / CLI** | Add `aayush3011/amt-copilot-plugin` in **Customize -> Plugins -> Add custom marketplace**, then install **Memory House**. The native command equivalent is `/plugin marketplace add aayush3011/amt-copilot-plugin`, then `/plugin install memory-house@memory-house-marketplace`. |
| **Cursor desktop** | On supported **Teams/Enterprise** plans, an administrator imports this repository through **Dashboard -> Plugins -> Team Marketplaces -> Add Marketplace -> Import from Repo**. Developers install **Memory House** in **Customize**. |

Cursor does **not** offer an unrestricted personal GitHub-marketplace import on
every plan. Team marketplace access and local-code policies apply; a public
Cursor Marketplace listing requires separate review. This repository does not
claim that approval or bypass the plan restriction.

Approve the bundled MCP connection and hooks when the host asks, then start a
new session or reload plugins. Install one copy; do not also configure a second
Memory House MCP server or duplicate hooks manually. Remote/cloud sessions run
elsewhere and do not inherit your local sign-in.

## Sign in, search, remember

Use **`mh-login`** through your app's skill command, approve the tool when
prompted, and complete Microsoft sign-in in your browser. `memory_login` opens
Microsoft directly and reports the outcome after you finish. There is no
intermediate landing page or deployment display. The publisher supplies the
registration settings; no password, token, or enrollment code goes through chat.

| Host | Sign in | Sign out | Status | Search / remember |
| --- | --- | --- | --- | --- |
| **Claude Code** | `/memory-house:mh-login` | `/memory-house:mh-logout` | `/memory-house:mh-status` | `/memory-house:mh-memory` |
| **Copilot app / CLI** | `/mh-login` | `/mh-logout` | `/mh-status` | `/mh-memory` |
| **Codex CLI / IDE** | `$mh-login` | `$mh-logout` | `$mh-status` | `$mh-memory` |
| **Cursor Agent chat** | `/mh-login` | `/mh-logout` | `/mh-status` | `/mh-memory` |

Codex also provides `/skills` to select a skill. Desktop surfaces can differ:
ChatGPT's desktop skill picker uses `@`; select the installed `mh-login`,
`mh-logout`, `mh-status`, or `mh-memory` skill by name. A bare `/mh-login` is not
promised for every Codex desktop version. In Cursor, type `/` and select the
named skill. Claude Code intentionally namespaces plugin skills.

Then ask:

- **"Search Memory House for my TypeScript preferences."**
- **"Remember in Memory House that I prefer concise examples."**

The app exposes `search_memories`, `add_memory`, `memory_login`, `memory_logout`,
and `memory_status`. Tool names may carry the app's
plugin namespace. Identity comes from your authenticated gateway session, never
from a model-supplied user, tenant, or endpoint.

`add_memory` is only a one-off write for an explicit "remember this." It is not
routine capture. Hooks send the conversation automatically; the model must not
call `add_memory` just because something seems important.

**Remembering submits conversational text for asynchronous extraction.**
Acceptance is not immediate publication of a durable fact or a promise that the
note is already searchable. Capture is best-effort: no queue, automatic replay,
or new deduplication contract is added.

## Automatic memory

**Hooks are the capture path.** They automatically attempt to send every user
turn and every final agent turn in the main conversation to Memory House/AMT,
without waiting for the model to call a tool or decide that a turn is important.
The **AMT backend core** decides what to extract, consolidate, or discard.
Capture is best-effort when sign-in, networking, or host payloads are unavailable.

Claude Code and Codex recall at startup and on each prompt. Copilot recalls at
startup and during prompt transformation, with post-tool fallback. Cursor
recalls at startup and after a tool using the latest prompt; it cannot inject
arbitrary context through `beforeSubmitPrompt`, so tool-free first answers do
not get that post-tool recall.

The automatic stream contains original user text and final assistant answers,
not tool outputs or private reasoning. Common credentials and runtime envelopes are filtered.
This is not comprehensive DLP: enable capture only where your data policy
allows sending conversation text to your Memory House deployment.

## Troubleshooting

- **Connection missing:** confirm the plugin and its one MCP server are enabled,
  Node.js 20+ is reachable by the app, and enterprise policy permits local tools.
- **Sign-in required/expired:** use `memory_login`; `memory_status` is local-only
  and never returns credentials.
- **Sign-in port occupied:** this deployment registers
  `http://127.0.0.1:33418`. Finish or close another active Memory House sign-in
  and retry. The plugin does not silently choose an unregistered port.
- **Publisher configuration error:** contact the publisher rather than entering
  registration settings or credentials in chat.
- **Sign out:** use `mh-logout` (the `memory_logout` tool). This clears the shared
  local credentials and attempts refresh-token revocation without opening a
  browser. Existing access tokens remain subject to their issued expiry.
- **Interrupted sign-in:** finish or cancel the current attempt before starting
  another. Cancelling the MCP request or closing its connection aborts sign-in
  and closes the callback listener; retry if the host's tool timeout expires.

The single source package is at this repository root: `.claude/`, `.codex/`,
`.cursor/`, and `.github/` select host behavior, while `src/` and the included
`runtime/` provide shared MCP, authentication and memory logic. See
[maintainer documentation](docs/maintaining.md) for loader contracts, dependency
licenses, publisher defaults, rebuilding, verification and publication.
