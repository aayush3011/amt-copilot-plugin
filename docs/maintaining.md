# Maintaining the Memory House plugin

This repository publishes one marketplace and one curated installable payload.
All three catalogs stay at the repository root and select `./plugin`; no
per-host package or ZIP selection is part of the product. The supported hosts
are Claude Code, Codex and GitHub Copilot.

```text
.claude-plugin/marketplace.json
.agents/plugins/marketplace.json
.github/plugin/marketplace.json
plugin/
  plugin.json, mcp.json, deployment.json, LICENSE
  .claude-plugin/, .codex-plugin/
  .claude/, .codex/, .github/
  skills/
  runtime/
src/, test/, scripts/, .maintainer/, docs/  (publisher-only)
```

Manifest/component paths below are relative to the installed payload root
(`plugin/` in the repository). Catalog paths are relative to the repository.

## Native resolution

| Host | Catalog | Manifest and component selection |
| --- | --- | --- |
| Claude Code | `.claude-plugin/marketplace.json` | `.claude-plugin/plugin.json` explicitly selects `.claude/plugin-hooks.json` and the shared `mcp.json`. There is no default `.mcp.json` or `hooks/hooks.json` to merge. |
| Codex | `.agents/plugins/marketplace.json` | Native legacy `.codex-plugin/plugin.json` directly selects `skills/`, the shared `mcp.json` and `.codex/plugin-hooks.json`. No root manifest opts into Agent Plugins 1.0. |
| Copilot | `.github/plugin/marketplace.json` | Legacy `plugin.json` explicitly selects `skills/`, `mcp.json` and `.github/plugin-hooks.json`, invoking `.github/entry.mjs`. Its `extensions` field selects `com.github.copilot/extensions/`, which holds the app canvas (see [Copilot app canvas](#copilot-app-canvas)). |

Each installed host has one named MCP connection, `memory-house`, and one hook
set. All three manifests select the same `mcp.json`, which names only the
remote server's URL (see
[Remote MCP server and sign-in](#remote-mcp-server-and-sign-in)); no host starts
a local MCP process. The catalogs share a name and payload source, so a host's compatibility
catalog fallback does not point to a different product. The root manifest is
deliberately legacy, with direct `hooks`, `skills`, and `mcpServers` fields.
Do not add the canonical Agent Plugins 1.0 `$schema`: that opts into a different
Codex loading path, shadows the native manifest, and loses hook discovery in
the tested CLI. Adding a compatibility overlay while retaining that portable
root does not fix it.

Where a host admits and dispatches them, hooks capture every conversational user
turn and final agent turn in the main conversation. Their capture calls do not ask the model to choose
important material; the AMT backend handles extraction, consolidation and
discarding. `add_memory` is only an explicit user-requested one-off write, never
a substitute for the hook stream or an importance-based extra write. Existing
credential/runtime filtering and best-effort delivery still apply.

Claude uses its native manifest rather than `plugin.json` for components.
Codex selects `.codex-plugin/plugin.json` beside the nonportable Copilot root.

The `.claude/`, `.codex/` and `.github/` config files are named
`plugin-hooks.json` deliberately: they are selected by the plugin manifest,
not automatically enabled as workspace hooks just by checking out this repo.
The three `entry.mjs` files import the same `runtime/hook.mjs`; there is no
separate auth/capture implementation per host. Native root variables are
checked against the installed package before running. Claude and Copilot use
direct executable/argv hooks. Codex uses a fixed Node launcher that
reads the host-exported root variable without interpolating paths into shell
code, including on Windows.

Official contracts:
[Claude native manifests](https://code.claude.com/docs/en/plugins-reference),
[Claude root-relative marketplaces](https://code.claude.com/docs/en/plugin-marketplaces),
[Codex native manifests](https://developers.openai.com/plugins/build/plugins),
[Codex manifest selector](https://github.com/openai/codex/blob/main/codex-rs/utils/plugins/src/plugin_namespace.rs),
[Copilot legacy manifests and catalogs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference#legacy-manifest-fields).

## Remote MCP server and sign-in

`mcp.json` points every app at the deployed gateway's MCP endpoint,
`{"type": "http", "url": "<gatewayBase>/mcp/"}`, plus two launcher commands:
`headersHelper` (Claude Code) and `http_headers_helper` (Codex). Each app ignores
the other's field, and Copilot ignores both (`copilot mcp get memory-house`
shows the server). Claude requires `type` (`http`). The file deliberately does
not follow the Agent Plugins schema, which spells the type `streamable-http`.
`npm run check:publisher` confirms that the URL matches `deployment.json`.

**Copilot signs in to the MCP server itself.** The InferencePlatform gateway
answers an unauthenticated MCP request with `401` and
`WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/inference/memory/mcp"`.
That public document names Microsoft Entra
(`https://login.microsoftonline.com/<tenant>/v2.0`) and the scope
`api://45cdeed7-4e4e-481d-9f00-6708c0631565/Inference.Execute`. Copilot on macOS
signs in with the Visual Studio Code client (`aebc6443…`); on Windows it uses
the Work IQ clients (`fdcc1f02…`, `ba081686…`). All three are pre-authorized on
the API. The plugin never sees that token.

**Claude Code and Codex use the plugin's token instead.** Entra has no dynamic
client registration. The gateway can advertise itself as the authorization
server with a stand-in `/oauth/register`
(`McpDiscoveryConfigs.ActAsAuthorizationServer`), but that only gets Claude
past registration: on 2026-08-29, with the setting on, Entra rejected Claude's
sign-in with `AADSTS9010010: The resource parameter provided in the request
doesn't match with the requested scopes`, because Claude sends the gateway URL
as the RFC 8707 `resource`. The setting is global, so leave it off; the
deployed `McpDiscoveryConfigs__ActAsAuthorizationServer=false` overrides the
Development configuration. (Codex has an `oauth_resource` override that has not
been tried.)

Instead, both apps run a plugin command before connecting and send its
`Authorization` header; the gateway accepts the plugin's hook token on the MCP
route (`HookTokenConfigs__Enabled=true`). The command is
`runtime/auth.mjs headers`, which prints `{"Authorization": "HookToken …"}`,
refreshing the token within 7 seconds (Claude allows 10), or `{}` when signed
out.

- **Claude** runs `headersHelper` from the plugin root with `CLAUDE_PLUGIN_ROOT`
  set, and stops using OAuth for the server once the helper supplies
  `Authorization`. When it prints `{}`, Claude offers its own sign-in, which
  fails as above; users run `mh-login` instead.
- **Codex** runs `http_headers_helper` from the user's home directory with only
  `HOME` and `PATH`. The launcher therefore reads Codex's documented install
  location, `~/.codex/plugins/cache/memory-house-marketplace/memory-house/<version>/`
  (falling back to `local`); tests keep the version in step with the manifest.
  A custom `CODEX_HOME` or `MEMORY_HOUSE_HOME` doesn't reach this connection.

Both launchers are `node -e` commands that read no shell variables, so they
behave the same in POSIX shells, `cmd` and PowerShell.

**The plugin's sign-in.** In Copilot, `mh-login` makes the agent call the remote
`enroll_hook_capture` tool, which returns a single-use
`{enrollment_code, expires_in}`. The post-tool hook recognizes only this
plugin's tool by its exact name in each app, redeems the code at
`<gatewayBase>/hook/redeem`, stores the hook token in
`~/.memory-house/token.json`, and replaces the tool result before the model
sees it:

| App | Tool name | Replacement |
| --- | --- | --- |
| Copilot | `memory-house-enroll_hook_capture` | `{"modifiedResult": {"resultType": "success", "textResultForLlm": ...}}` |
| Claude Code | `mcp__plugin_memory-house_memory-house__enroll_hook_capture` | `hookSpecificOutput.updatedMCPToolOutput`, in the result's own shape |
| Codex | `mcp__memory-house__enroll_hook_capture` | `{"decision": "block", "reason": ...}`; Codex parses `updatedMCPToolOutput` but does not apply it yet, and a blocking post-tool hook replaces the result with its reason |

A same-named tool from another server is never redeemed, because redeeming an
attacker's code would send this user's conversations to the attacker's
account. Claude Code and Codex can only use that path once they are signed in,
so their `mh-login` runs `runtime/auth.mjs login`: a Microsoft PKCE sign-in in
the browser with the plugin's registered public client and fixed callback
`http://127.0.0.1:33418`, then `enroll_hook_capture` with that Entra token and
redemption, all outside the model. `runtime/auth.mjs status|logout` backs
`mh-status` and `mh-logout`; the skills locate the helper two folders above
their own `SKILL.md`.

References:
[Claude headersHelper](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication),
[Claude PostToolUse output](https://code.claude.com/docs/en/hooks#posttooluse-decision-control),
[Codex MCP servers](https://developers.openai.com/codex/mcp),
[Codex hooks](https://developers.openai.com/codex/hooks),
[Codex plugin install location](https://developers.openai.com/plugins/build/plugins).

## Live CLI limitations

These checks predate the switch to the remote MCP server: the MCP operations
below ran against the plugin's earlier local server and its own Microsoft
sign-in. Hook capture and recall are unchanged.

The 2026-09-16 live checks initially used plugin 0.12.1 and the vendor builds
below. Version 0.12.3 corrected the Codex manifest format and the earlier
0.12.2 conclusion that all third-party plugin hooks were vendor-blocked.
Version 0.12.4 moves the same native components into one curated payload.
Version 0.12.5 fixes the separate legacy Codex MCP working-directory/argument
contract; 0.12.4's native MCP startup failed even though its hooks worked.
Version 0.12.6 records successful Claude verification and corrects the stale
skill/documentation wording; no authentication or capture implementation changed.
Version 0.13.0 adds the supported listing tool and corrects auth-skill
discoverability and Codex plugin invocation names.
Version 0.13.1 treats the backend's recent sample as the normal conversational
result and omits unspecified `recent_k`, leaving the default to the gateway.
Limit flags remain truthful information, not a prompt for automatic over-fetching.
Version 0.14.0 follows the updated AMT request contract behind the unchanged
gateway routes. Capture sends `{extract: true, thread_id, items: [{role,
content}]}` (256 KiB per request; thread IDs of at most 256 bytes without `/`,
`\`, `?`, `#` or control characters) and accepts the tracked insert response.
Search allows `top_k` up to 50 and queries up to 16 KiB. The agent gets only
each memory's content, in AMT's order, without scores.
Listing pages with `page_size` and `cursor` instead of `recent_k`, `scopes`
and `truncated`; the plugin now applies the default of 50 itself.
Hook discovery, native trust and real capture are distinct checks.

**Copilot CLI 1.0.81-4:** real Microsoft sign-in, search, explicit insertion,
status, sign-out and restoration passed. A tool-free conversation produced one
HTTP 201 user capture and one HTTP 201 agent capture with the same thread hash.
A later turn in that session received injected recall. Passive observation
recorded only operation/status, role, content byte count and hashed thread ID,
not request text, returned memories, tokens or authorization headers.
The complete login/search/add/status/logout/restore flow and two-turn capture
were rerun successfully against the pushed 0.12.3 legacy-manifest release.
They passed again after the 0.12.4 payload relocation. Codex's trusted two-turn
capture and later recall also passed against that pushed subdirectory payload.

**Codex CLI rust-v0.154.0:** the MCP operations passed, including narrow native
tool approvals for writes/sign-in. The original Agent Plugins 1.0 manifest
exposed no hooks. The earlier compatibility-overlay permutations retained that
portable root, so they did not exercise the pure-legacy loading path.

A same-profile comparison with
[`neo4j-labs/meta-knowledge-graph`](https://github.com/neo4j-labs/meta-knowledge-graph/tree/03e0b6f6dfd47ef40b480f4ea95066a35c97d0c4/plugin)
0.1.43 found 17 enabled/untrusted native hooks for that legacy plugin and zero
for portable Memory House 0.12.2. Changing only Memory House's manifest format,
with byte-identical hook definitions, exposed all three hooks. A legacy Copilot
root and native `.codex-plugin/plugin.json` also coexist successfully. The
blanket vendor-admission conclusion was incorrect; it must not be repeated.
The native regression test checks real `hooks/list` discovery without granting
trust or executing any hook, and native `mcpServerStatus/list` must return all
all exposed tools with no startup error. A direct SDK client with manually expanded
arguments is not sufficient to test the native loader. A separate real Codex session, using the existing
ChatGPT-authenticated profile, then trusted exactly the three Memory House
plugin definitions through the native API used by `/hooks`. No trust-bypass
flag or user/project hook commands were added. Two tool-free turns each sent
one HTTP 201 user capture and one HTTP 201 final-agent capture with the same
thread hash. Captured text hashes matched the actual prompts/final answers;
the native hook notifications and transcript confirmed recall injection on the
later turn. These verification turns entered the user's real Memory House.

The 0.12.4 MCP registration gap was reproduced without model execution:
native startup returned `No such file or directory (os error 2)`. A diagnostic
launcher received the literal `${PLUGIN_ROOT}/runtime/server.mjs` argument
and neither root environment variable. Keeping the same explicit MCP filename
and switching to plugin-relative cwd/argv produced all five native tools.
The filename was honored; placeholder expansion was the issue.

One initial run, immediately after marketplace-source and native-trust changes,
captured only the first user prompt and injected startup/first-prompt recall;
the two Stop callbacks and the following prompt ran without observed capture
requests. Two subsequent complete sessions passed without any adapter change.
That anomaly is recorded, not dismissed or assigned an unproven cause. A
fresh-session reload after trust/configuration changes is prudent, but stale
host state was not established as the cause. The adapter emits safe stderr
diagnostics for skips and transport/authentication failures, then fails open.
Whether those diagnostics are visible in ordinary chat depends on the host;
there is no persistent capture-health indicator. Better user-visible
observability is a follow-up, not an excuse to add replay or deduplication.
An initial post-relocation Copilot run similarly logged transient transport
failures before a subsequent complete two-turn run passed. The early observer
did not record an HTTP receipt for those failures; neither a gateway failure
nor an observation contribution was established. No speculative adapter fix,
deduplication or replay was added.

**Claude Code 2.1.273:** the complete native plugin flow passed against the
pushed 0.12.5 payload after a provider-auth configuration correction. Real
Microsoft login, search (two results), one explicit accepted write, status,
logout and re-login all passed. In a separate tool-free conversation, each of
two user turns and two final answers produced exactly one HTTP 201 capture,
with the same thread hash and content hashes matching the actual text. Native
`UserPromptSubmit` hook responses confirmed recall on the later resumed turn.
The observed `Stop` payload includes `last_assistant_message`, `prompt_id`,
`stop_hook_active` and `transcript_path`; the existing adapter used the inline
final answer without a transcript-flush workaround or any code change.

The earlier **HTTP 400, `Credit balance is too low`** was an auth-mode mismatch,
not a Memory House defect or a demonstrated lack of funds. The user's Claude
settings contained `"forceLoginMethod": "console"`, pinning Console/developer
auth instead of the personal Claude Pro identity. Before correction, status
could say `authMethod: "claude.ai"` while also reporting
`apiKeySource: "/login managed key"` and `subscriptionType: null`. With explicit
user approval, the settings were backed up, only that pin was removed, and
`claude auth logout` / `claude auth login` selected the Pro identity.
Subsequent status showed `loggedIn: true`, `authMethod: "claude.ai"`,
`subscriptionType: "pro"` and no managed API key source. No funds or subscription
plan were changed. This provider login is separate from Memory House's Entra
sign-in; the plugin did not edit Claude's authentication settings.

The real Claude user-scope Memory House installation was intentionally upgraded
from 0.11.0 for this verification and left enabled. To remove it, use
`claude plugin uninstall memory-house@memory-house-marketplace --scope user`;
optionally remove its marketplace afterward. Removing the plugin does not erase
the real verification turns already submitted to Memory House.

The product conclusion is explicit: plugin MCP tools are deliverable where the
host can run them; automatic plugin-delivered capture is verified on Claude
Code, Copilot, and Codex with its corrected legacy manifest and normal hook trust.
Do not substitute model-selected `add_memory` calls for a missing automatic
stream.

## Publisher configuration

`plugin/deployment.json` contains only public settings: the gateway, and the
Entra registration that the local sign-in helper (`runtime/auth.mjs login`, used
by Claude Code and Codex) signs in with. The hooks, canvas and helper read it;
`mcp.json` repeats the gateway with `/mcp/`. The shipped values were verified on
2026-09-16:

| Setting | Verified value |
| --- | --- |
| Gateway | `https://reranker-api-h2b5czhkfkcphnf4.westus3-01.azurewebsites.net/inference/memory` |
| Entra tenant | `72f988bf-86f1-41af-91ab-2d7cd011db47` |
| Public-client ID | `45cdeed7-4e4e-481d-9f00-6708c0631565` |
| Delegated API scope | `api://45cdeed7-4e4e-481d-9f00-6708c0631565/Inference.Execute` |
| Registered public-client callback | `http://127.0.0.1:33418` |

The tenant and scope match the gateway's public
`/.well-known/oauth-protected-resource/inference/memory/mcp` document. Gateway
and token environment variables, legacy token files and per-user configuration
cannot override these settings. Changing deployments is a publisher operation:
update `deployment.json` and `mcp.json` together and publish an updated package.
Preserve the exact registered callback; an occupied port fails explicitly
instead of falling back to another one. PKCE, callback-state validation and
fixed-port binding live in `src/entra.mjs`.

Shared plugin credentials (the hook token) live in `~/.memory-house/token.json`
(or an explicitly operator-selected `MEMORY_HOUSE_HOME`). Writes use private
files and cross-process locks. Tokens are gateway-bound and never copied into
the repo. One plugin sign-in through any host is sufficient for all hosts
using that state directory as the same OS user on the same machine. Sign-out
clears it for all of them. Different users, remote machines and explicit
state-directory overrides are separate; each app's MCP sign-in is independent.

## Supported listing

Agents list memories with the remote `get_memories` tool (`page_size` up to
50, `cursor`, `memory_types`); the skills say when to follow `next_cursor`.
The plugin lists memories itself only for the Copilot app canvas, through its
hook-token client: `GET {gatewayBase}/memories` with optional `memory_types`
and `include_superseded`, a fixed `page_size` of `min(count, 50)`, following
`next_cursor` for at most `ceil(count / page_size)` requests (count 1 to 200,
default 50) and stopping when `has_more` is false. Each cursor is bound to the
page size, filters, caller authorization and reset generation. Any failed page
fails the whole listing, and malformed continuation metadata produces an
error rather than an empty result.

## Skill commands

The payload skills are `mh-login`, `mh-logout`, `mh-status`, `mh-memory`,
`mh-show` and `use-memory`; each directory and frontmatter name matches.
`use-memory` asks the agent to call `search_memories` before starting a task, as
`main` did, so recall is visible as a tool call besides the hooks' injected context. All are available for discovery.
Login/logout descriptions and instructions require an explicit user request;
the skill itself does not pre-approve its MCP tools. `mh-login` calls the remote
`enroll_hook_capture` tool in Copilot and runs `runtime/auth.mjs login` in Claude
Code and Codex; `mh-logout` and `mh-status` run `runtime/auth.mjs`, so the host's
shell approval applies to them. Neither the Claude-style
`disable-model-invocation` flag nor Codex-only implicit-invocation metadata is
shipped. Host MCP approval remains the executable-action gate.

Claude Code invokes plugin skills as `/memory-house:mh-login` (and the same
prefix for the other names). The verified Copilot CLI registers the same
`/memory-house:mh-login` command name; the app's picker is authoritative for its
version. The tested Codex 0.154.0 plugin loader
registers `memory-house:mh-login`; mention `$memory-house:mh-login`
or select it through `$`/`/skills`. The same substitutions apply to logout,
status, memory and show. ChatGPT desktop's skill picker uses `@`; exact Codex desktop
controls depend on the surface/version, so the user docs do not invent a
universal bare slash alias there.

Controlled native discovery compared the published metadata, removal of only
the Claude flag, removal of only `agents/openai.yaml`, and removal of both.
Codex and Copilot discovered all four enabled skills in every case; the flags
did not delete the native inventory entries. Codex's names were namespaced in
every case, so the old bare `$mh-login` documentation was incorrect for the
tested plugin path. Explicit mention matching uses the discovered skill name.
Invocation policy can separately hide skills from model discovery; removing
these metadata restrictions keeps all four visible for user-requested use.
Native regression checks include the actual Codex names, not just filesystem
presence. Host inventories can still be cached until reload/restart.

Plugin upgrades require a session restart because MCP server instances and
their tool definitions bind at session start. Updating the cache or refreshing
only the skills is insufficient if the old process is still running. A
user-reported Codex session retained an orphaned 0.12.2 Memory House server
after 0.13.0 was installed and the old cache directory removed. It naturally
reported `get_memories` unavailable. The coordinating session terminated that
identified old process with user context; a restarted session uses the current
payload. This is not a reason to patch credentials, inspect bundles or fall
back to REST/OpenAPI. Do not terminate unrelated MCP or host processes.

A controlled Copilot model lookup confirmed the distinction: both variants
listed four installed skills, but with `disable-model-invocation: true` the
model reported `mh-login` unavailable; without it the native `skill` tool
successfully loaded `mh-login`. The probe allowed only skill loading, not
Memory House tools, sign-in or sign-out.

Invocation references:
[Claude plugin namespace](https://code.claude.com/docs/en/plugin-marketplaces),
[Copilot skill invocation](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills#using-agent-skills),
[Codex and ChatGPT skill invocation](https://learn.chatgpt.com/docs/build-skills).

## Copilot app canvas

The 0.14.0 payload adds the Memory House canvas for the GitHub Copilot app only.
Other hosts ignore it; their `mh-show` skill falls back to one `get_memories`
call grouped by scope.

**Packaging.** `plugin/com.github.copilot/extensions/memory-canvas/extension.mjs`
contains only the Copilot SDK wiring (`joinSession` and `createCanvas`, canvas
`memory-house`, action `refresh`). The host resolves `@github/copilot-sdk`
itself, so the payload has no `package.json` for it, and the file never writes
to stdout, which carries the extension protocol. Everything else is in
`src/canvas/` and is bundled as the `canvas` entry, `runtime/canvas.mjs`:

- `data.mjs` loads `GET /memories` (paged by the shared client),
  `GET /whoami` and `GET /v1/me/reach` through the gateway with the HookToken.
- `importers.mjs` reads local history and sends it to AMT.
- `panel.mjs` is the page.
- `index.mjs` is the loopback server.

The legacy root manifest selects the canvas with
`"extensions": "./com.github.copilot/extensions/"`. In a legacy manifest that
path is a parent directory whose immediate subdirectories are extensions. On the
GitHub Copilot app's runtime 1.0.93-1, an isolated profile discovered
`"./dir/"` and `{"paths": ["./dir/"]}`, but not a path to the extension directory
itself. The extension ID is `plugin:memory-house:memory-canvas`. In the same
isolated runtime, the real payload's extension ran, registered the
`memory-house` canvas with its `refresh` action, served the panel, and returned
`not_signed_in` without a sign-in. The root stays legacy (no `$schema`), for the
Codex reasons above.

**Data.** A failed listing, including a missing sign-in, is an error. Failed
`whoami` or `reach` reads only add a warning, so memories still render; node
memories then appear by node ID. The tree lists the personal scope, then the
reach nodes depth-first by name (including nodes with no memories), then node
scopes missing from reach. AMT hides promoted copies the caller cannot see, so
listing pages may be sparse. The limit (default 200) bounds the newest memories
loaded, not each node. A promoted copy's card shows where it came from, the user
whose memory started the promotion, and why it was promoted, read from the
memory's `metadata` (or from the separate `promotion` summary that AMT sent before
REST returned whole records).

**Import.**

| Kind | Source | Request |
| --- | --- | --- |
| Sessions | The 100 newest Copilot `session-state/*/events.jsonl` files or Claude Code `projects/*/*.jsonl` transcripts, streamed. Copilot pairs each `user.message` with the interaction's last assistant text, preferring `final_answer`. Claude skips sidechain, meta and tool-result events. | `POST /memory` with `{extract: true, thread_id: "mh:import:<source>:<session>", items: [{role, content, source}]}` |
| Memories | Successful Copilot `storeMemory` facts, or Claude `projects/*/memory/**/*.md` (front matter stripped, `MEMORY.md` skipped), de-duplicated. | `POST /memory` with `{extract: false, items: [{content, source}]}`, then one `POST /reconcile {}` |

Import details:

- Batches stay within AMT's limits: at most 50 items and 240 KiB, and 10 facts
  per batch because facts are embedded while the request waits.
- Each batch carries `Idempotency-Key: mh-import-<sha256 of the body>`, so an
  unchanged re-import replays. The gateway forwards that header.
- Text passes the same `sanitizeMessage` filtering as live capture: 32 KiB per
  turn and 16 KiB per fact. Text that becomes empty is skipped.
- AMT accepts no client timestamps or metadata, so the original times are lost.
- An import stops at the first failed request and reports what it sent.
- The source identifiers are `github-copilot`, `claude-code`,
  `copilot-cli-memory` and `claude-code-memory`.
- `COPILOT_HOME` and `CLAUDE_CONFIG_DIR` select the history roots.
- Parsed sessions are cached by size and modification time. Listing 100 of 328
  real Copilot sessions (5.9 GB) took about 3.5 s cold and 31 ms cached.

**Server.** One loopback server runs per open panel, on `127.0.0.1:0`. The page
embeds a per-server capability token and a per-response script nonce
(`script-src 'nonce-...'`). Styles are left unrestricted so the app's theme
injection works, and the page itself is embeddable. API routes check four things:

- the `x-mh-canvas-token` header, compared in constant time;
- a loopback `Host` header (against DNS rebinding);
- `Sec-Fetch-Site` of `same-origin` or `none`;
- a JSON body of at most 64 KiB.

They also send no-store, nosniff and same-origin `Cross-Origin-Resource-Policy`
headers. Only one import runs at a time. Sign-in failures return 401
`not_signed_in`. Other plugin errors return their safe code and message, never
gateway text.

The 0.8.1 canvas's `complete_signin` action (replaced by `mh-login`) and its
`forget_memory` action (0.14.0 has no forget tool) are not carried over.

## Developer-only build and checks

Consumers never run these commands. The publisher runs them before committing
and publishing source changes:

```bash
npm ci --prefix .maintainer --ignore-scripts --no-audit --no-fund
npm run build
npm run check
npm test
npm run check:publisher
```

`plugin/runtime/` is intentionally **not gitignored**. Publish its generated
JavaScript, `THIRD_PARTY_NOTICES.txt`, and `manifest.json` together with the
native payload and the three root catalogs.
The runtime holds the hooks, the canvas and the sign-in helper. It bundles
MSAL for the helper's Microsoft sign-in, but no MCP SDK, because the MCP server
is remote. A fresh cached installation needs no `node_modules`, unpublished npm
package, lifecycle script, network dependency installer, or files outside the
installed root. A local Node.js 20+ executable is still required for the hooks
and helper.

Dependencies and the npm lockfile live only in the repository's `.maintainer/`,
outside the payload. The installed plugin contains no `package.json`,
dependency tree or lockfile. This also avoids Claude's automatic `npm ci`
for plugins with a package manifest and root lockfile. The maintainer-only module loader
lets tests/builds resolve that separate dependency directory; no native entry
uses it. Maintainer tooling needs Node.js 20.6+, while the bundled plugin needs
Node.js 20+. The build
allowlists bundled runtime entry points, refuses unresolved non-builtin runtime imports,
preserves dependency license texts, records source/package/lock hashes, and
refuses to overwrite unknown or modified runtime files. There are no binary
Node runtimes or platform-specific native npm modules in the package.

Tests reconstruct fresh repository-shaped snapshots with three root catalogs
and the exact payload inventory under `plugin/`. They exercise the native
hook commands for each app, including sign-in through the enrollment hook
(the code never appears in hook output), the bundled Microsoft sign-in helper
against synthetic Entra endpoints, both header launchers (Codex's with only
`HOME` and `PATH`), shared credentials, recall and capture, and command
execution without source `node_modules`, all against a loopback gateway
fixture. The available Claude CLI strictly validates and installs the payload
and root catalog in an isolated fake profile, then connects the remote server
with the hook token through its header helper. The available Copilot CLI
registers the native catalog, installs its payload and loads the remote server.
The available Codex CLI installs the same snapshot and asserts that all four
hooks are discovered as plugin-scoped and untrusted beside the legacy Copilot
root, and that it registers the remote server; its helper can't authenticate
against the plain-HTTP fixture because Codex withholds the fixture's loopback
allowance. These tests do not complete Copilot's MCP sign-in, grant hook trust
or start a model session. Native discovery and protocol fixtures are not
substitutes for live capture testing.

`scripts/package-files.mjs` defines the **enforced payload inventory**.
Build and bundle checks reject extra files, empty directories, and links inside
`plugin/`. With marketplace `source: "./plugin"`, native installers select only
that subdirectory. The installed plugin root contains no `.git`, `src/`,
`test/`, `docs/`, `scripts/`, `.maintainer/`, developer getting-started file, or
marketplace catalogs. A host may separately retain its Git marketplace clone;
that is not the installed payload. The publisher must still review the whole
tracked repository before pushing and must never publish credentials.

The 0.13.0 payload contains 32 publisher files after removing the two
host-specific auth-skill metadata files. The pre-fix 0.12.4 native Git
installations verified 33 publisher files and
their hashes on each host. Claude adds an `.in_use/` bookkeeping
directory, which is not shipped by this
repository. Claude, Codex and Copilot were checked in throwaway profiles.

Copilot's event log can still be flushing when its stop hook fires. The adapter
waits up to one second for the final transcript text, then makes at most one
capture request. This is bounded local transcript reading, not a capture queue,
idempotency mechanism, or network replay.

The default automated suite must not read a real app profile, sign in to a production tenant, send
real conversations, or install a plugin into an active user profile. Loopback
HTTP fixtures explicitly use `MH_ALLOW_INSECURE_LOCALHOST=1`. Capture is
best-effort and is never automatically replayed. The live checks above were
separate, explicitly authorized operations; they are not run by `npm test`.

## Publication

GitHub marketplace installation fetches the published repository/default ref,
not local changes. Publish this branch only when separately authorized; do not
claim that adding the live URL installs uncommitted code. Branch-pinned testing
can use the host's supported ref selector after the branch is pushed (for
example Copilot's `owner/repo#ref` or Codex's `--ref`).
