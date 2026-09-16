# Memory House

**One repository. One plugin. Shared memory across Claude Code, Codex, Cursor,
and GitHub Copilot.**

Add this repository as a marketplace, install **Memory House**, and sign in with
Microsoft. The application selects its native adapter from the same installed
plugin. Search and remembering tools, native hook definitions, and
their dependencies are included. No clone, build, ZIP selection, global CLI,
or per-project hook installation is required for users.

**Repository:** <https://github.com/aayush3011/amt-copilot-plugin>

**Automatic capture is not currently plugin-deliverable on every CLI.**
The live verification below is more authoritative than the presence of hook
files in the package. A successful `memory_status` proves sign-in, not that
the host executes capture hooks.

## Verified CLI support

Observed on 2026-09-16:

| Host version | Plugin MCP tools | Automatic per-turn capture from the plugin |
| --- | --- | --- |
| **Copilot CLI 1.0.81-4** | Real login, search, explicit add, status, logout and sign-in restoration passed | **Passed:** ordinary user and final agent turns accepted by the gateway; recall injected on a later turn without explicit memory calls |
| **Codex CLI 0.154.0** | Real login, search, explicit add, status, logout and restoration passed | **Passed with native hook trust:** two tool-free turns each produced one HTTP 201 user capture and one agent capture; recall injected on the later turn |
| **Cursor CLI 2026.09.15-d2fe57e** | Real login, search, explicit add, status, logout and restoration passed | **Blocked by CLI dispatch:** prompt/final-response events check user/project hooks, not plugin hooks. Startup recall works; post-tool hooks run, but without prompt capture they have no latest-prompt query |
| **Claude Code 2.1.273** | Real Microsoft login, search, explicit add, status, logout and restoration passed after correcting the Claude provider login configuration | **Passed:** two tool-free turns each produced one HTTP 201 user capture and one final-agent capture, with matching thread/content hashes and recall on the later turn |

The model is never the routine capture gatekeeper. Where host hooks run, they
send every conversational user turn and final agent turn; the AMT backend
decides what to extract, consolidate, or discard. **Do not replace missing hook
support with model-selected `add_memory` calls.**

For Cursor, the appropriate follow-up is an **explicit,
user-consented user/project-hook opt-in**, with a matching disable operation.
A possible `mh-enable-capture` workflow is a recommendation, **not a shipped
command**. Plugin installation does not silently write those hook files.
See [the evidence and scope details](docs/maintaining.md#live-cli-limitations).

> Repository installation uses the published GitHub ref. The `plugin/` payload and
> its bundled runtime must be published before the link delivers this version;
> changing an uncommitted local checkout does not update an installed plugin.
> Current development is published on `feature/unifiedMemoryHousePlugin`, not
> merged into `main`. Select that ref explicitly to get this version.

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

The tested branch selectors are:

```text
claude plugin marketplace add aayush3011/amt-copilot-plugin@feature/unifiedMemoryHousePlugin
codex plugin marketplace add aayush3011/amt-copilot-plugin --ref feature/unifiedMemoryHousePlugin
copilot plugin marketplace add aayush3011/amt-copilot-plugin#feature/unifiedMemoryHousePlugin
cursor-agent plugin marketplace add https://github.com/aayush3011/amt-copilot-plugin --git-ref feature/unifiedMemoryHousePlugin
```

Then install `memory-house@memory-house-marketplace` with `claude plugin install`,
`codex plugin add`, or `copilot plugin install`. Cursor's CLI (`cursor-agent`,
also installed as `agent`) installs through the interactive `/plugin` picker:
**Marketplace -> memory-house -> Install for you**.

Cursor does **not** offer an unrestricted personal GitHub-marketplace import on
every plan. Team marketplace access and local-code policies apply; a public
Cursor Marketplace listing requires separate review. This repository does not
claim that approval or bypass the plan restriction.

Approve the bundled MCP connection and hooks when the host asks, then start a
new session or reload plugins. Install one copy; do not also configure a second
Memory House MCP server or duplicate hooks manually. Remote/cloud sessions run
elsewhere and do not inherit your local sign-in.

## Sign in, list, search, remember

Use **`mh-login`** through your app's skill command, approve the tool when
prompted, and complete Microsoft sign-in in your browser. `memory_login` opens
Microsoft directly and reports the outcome after you finish. There is no
intermediate landing page or deployment display. The publisher supplies the
registration settings; no password, token, or enrollment code goes through chat.

**Sign in once, use every host.** Claude Code, Codex, Cursor and Copilot running
on the same machine as the same OS user share `~/.memory-house/token.json`.
Signing in through any one of them connects the others; signing out affects
them all. Each host's own provider login is separate. Remote/cloud sessions,
different OS users, or an explicitly different `MEMORY_HOUSE_HOME` use separate
Memory House state and need their own sign-in.

| Host | Sign in | Sign out | Status | Search / remember |
| --- | --- | --- | --- | --- |
| **Claude Code** | `/memory-house:mh-login` | `/memory-house:mh-logout` | `/memory-house:mh-status` | `/memory-house:mh-memory` |
| **Copilot app / CLI** | `/memory-house:mh-login` | `/memory-house:mh-logout` | `/memory-house:mh-status` | `/memory-house:mh-memory` |
| **Codex CLI 0.154.0 plugin** | `$memory-house:mh-login` | `$memory-house:mh-logout` | `$memory-house:mh-status` | `$memory-house:mh-memory` |
| **Cursor Agent chat** | `/mh-login` | `/mh-logout` | `/mh-status` | `/mh-memory` |

Codex also provides `/skills` or `$` to select a skill. Its tested native
plugin loader registers **`memory-house:mh-login`**, including the namespace;
generic standalone-skill examples using `$mh-login` do not describe this plugin.
Claude Code and Copilot likewise namespace plugin commands. Use the names in
the host's picker rather than guessing a bare alias. Desktop/IDE surfaces can
differ: ChatGPT's desktop skill picker uses `@`. In Cursor, type `/` and select
the named skill.

All four skills are discoverable; login/logout no longer carry metadata that
hides them from model discovery. Their instructions still require an explicit
user request, and the host's MCP tool approval remains in effect. After an
update, restart the host or use its native skill reload; an existing session
can retain the old skill inventory.

Then ask:

- **"Show my Memory House memories."**
- **"Search Memory House for my TypeScript preferences."**
- **"Remember in Memory House that I prefer concise examples."**

The app exposes `get_memories`, `search_memories`, `add_memory`, `memory_login`,
`memory_logout`, and `memory_status`. Tool names may carry the app's
plugin namespace. Identity comes from your authenticated gateway session, never
from a model-supplied user, tenant, or endpoint.

`get_memories` lists recent records without a search query: default `recent_k`
50, maximum 200, with optional `memory_types` (`fact`, `episodic`, `procedural`),
repeatable `scopes`, and `include_superseded`. Scope keys are filters within the
gateway's existing access checks, not a way to impersonate another identity.
Use only known returned scope keys. `search_memories` remains query-based
retrieval and is not an exhaustive listing.

**A listing is not necessarily all memories.** `truncated` is true when the
gateway reports truncation, the requested window is full, or local output limits
omit records/content. `gatewayTruncated`, `limitReached`, `omittedItems`, and
`contentTruncated` explain why. The gateway may cap results below the requested
count; a higher `recent_k` is not a pagination cursor. This endpoint exposes no
cursor/offset pagination or guaranteed complete export. The tool also bounds
content to 8 KiB per record and 128 KiB per listing and reports those limits.

If an exposed tool cannot complete a request, the agent must report that
limitation, not inspect plugin bundles or credentials, import internal modules,
reverse-engineer other services, or call the gateway directly as a workaround.
Memory House tools are the supported access path.

`add_memory` is only a one-off write for an explicit "remember this." It is not
routine capture. Hooks send the conversation automatically; the model must not
call `add_memory` just because something seems important.

**Remembering submits conversational text for asynchronous extraction.**
Acceptance is not immediate publication of a durable fact or a promise that the
note is already searchable. Capture is best-effort: no queue, automatic replay,
or new deduplication contract is added.

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
startup and during prompt transformation, with post-tool fallback. Cursor
declares startup and post-tool recall using the latest prompt; the tested CLI
executes startup/post-tool hooks but does not deliver prompts to plugin hooks.
Even on a host that delivers those prompts, Cursor cannot inject
arbitrary context through `beforeSubmitPrompt`, so tool-free first answers do
not get that post-tool recall.

The automatic stream contains original user text and final assistant answers,
not tool outputs or private reasoning. Common credentials and runtime envelopes are filtered.
This is not comprehensive DLP: enable capture only where your data policy
allows sending conversation text to your Memory House deployment.

## Troubleshooting

- **Connection missing:** confirm the plugin and its one MCP server are enabled,
  Node.js 20+ is reachable by the app, and enterprise policy permits local tools.
- **Skill not found:** update the plugin and start a fresh session. For Codex,
  use `$memory-house:mh-login` or select it with `$`/`/skills`; for Copilot use
  `/memory-house:mh-login`. A host inventory listing and the model's currently
  loaded skill list can differ. Do not read credential files to work around it.
- **Codex hooks need review:** run `/hooks`, review Memory House's session-start,
  user-prompt and stop hooks, and trust those definitions. Do not bypass hook
  trust or install duplicate user/project hooks.
- **Disable Codex capture:** use `/hooks` to turn off Memory House's three hooks
  while keeping its MCP tools. To remove the integration instead, run
  `codex plugin remove memory-house@memory-house-marketplace`, then optionally
  `codex plugin marketplace remove memory-house-marketplace`. This does not
  erase previously captured memories or sign the other apps out.
- **Sign-in required/expired:** use `memory_login`; `memory_status` is local-only
  and never returns credentials.
- **Sign-in port occupied:** this deployment registers
  `http://127.0.0.1:33418`. Finish or close another active Memory House sign-in
  and retry. The plugin does not silently choose an unregistered port.
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
- **Cursor branch remains pinned:** the tested CLI retained an old marketplace
  commit across `add --git-ref` and `update`. Removing that specific Memory House
  marketplace registration and re-adding it with the intended ref, then
  reinstalling through `/plugin`, selected the new revision. Do not remove
  unrelated marketplaces.
- **Sign out:** use `mh-logout` (the `memory_logout` tool). This clears the shared
  local credentials and attempts refresh-token revocation without opening a
  browser. Existing access tokens remain subject to their issued expiry.
- **Interrupted sign-in:** finish or cancel the current attempt before starting
  another. Cancelling the MCP request or closing its connection aborts sign-in
  and closes the callback listener; retry if the host's tool timeout expires.

The single installable payload is **`plugin/`**. All four marketplace catalogs
stay at the repository root and select `./plugin`; the GitHub URL and install
commands do not change. Inside the payload, `.claude/`, `.codex/`, `.cursor/`,
and `.github/` select host behavior, while `runtime/` contains the shared bundled
implementation. Installed plugin roots contain no repository `.git`, tests,
maintainer dependencies, source, build scripts, or developer documentation.
See
[maintainer documentation](docs/maintaining.md) for loader contracts, dependency
licenses, publisher defaults, rebuilding, verification and publication.
