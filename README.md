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

Ask **"Sign in to Memory House."** The `memory_login` tool opens a private local
page. Select **Sign in with Microsoft** and complete account sign-in and consent
in the browser. The publisher has configured the gateway, tenant, public-client
ID, API scope and registered callback; users do not enter these settings.
No password, token, or enrollment code goes through chat.

Then ask:

- **"Search Memory House for my TypeScript preferences."**
- **"Remember in Memory House that I prefer concise examples."**

The app exposes `search_memories`, `add_memory`, `memory_login`, `memory_setup`
(the same sign-in page), and `memory_status`. Tool names may carry the app's
plugin namespace. Identity comes from your authenticated gateway session, never
from a model-supplied user, tenant, or endpoint.

**Remembering submits conversational text for asynchronous extraction.**
Acceptance is not immediate publication of a durable fact or a promise that the
note is already searchable. Capture is best-effort: no queue, automatic replay,
or new deduplication contract is added.

## Automatic memory

Claude Code and Codex recall at startup and on each prompt. Copilot recalls at
startup and during prompt transformation, with post-tool fallback. Cursor
recalls at startup and after a tool using the latest prompt; it cannot inject
arbitrary context through `beforeSubmitPrompt`, so tool-free first answers do
not get that post-tool recall.

Hooks capture original user text and final assistant answers, not tool outputs
or private reasoning. Common credentials and runtime envelopes are filtered.
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
- **Sign out:** open `memory_login` and select **Sign out**. This clears the
  shared local credentials and attempts refresh-token revocation. Existing
  access tokens remain subject to their issued expiry.

The single source package is at this repository root: `.claude/`, `.codex/`,
`.cursor/`, and `.github/` select host behavior, while `src/` and the included
`runtime/` provide shared MCP, authentication and memory logic. See
[maintainer documentation](docs/maintaining.md) for loader contracts, dependency
licenses, publisher defaults, rebuilding, verification and publication.
