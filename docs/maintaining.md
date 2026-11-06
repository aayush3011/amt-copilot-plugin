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
credential/runtime filtering applies, and delivery goes through the durable queue
described in [Capture queue and recall](#capture-queue-and-recall).

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

Claude and Codex register session start, prompt, stop and session end hooks;
Copilot also registers prompt transform and post-tool. Session end has a short
host budget (Claude 1.5 seconds unless a hook asks for more, this one 5; Codex
at most 3), so it only clears session state and starts the background capture
sender.

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

**Copilot manages MCP OAuth independently.** The plugin neither reads its
token nor enrolls hooks through MCP. Configure gateway OAuth discovery for
the required API and permitted clients; do not assume a previous registration
or preauthorization covers this public client or the new resource.

**Hooks, canvas, Claude Code and Codex use MSAL Node.** Only an explicit
`runtime/auth.mjs login` (`mh-login`) opens Microsoft browser sign-in. The public
client uses authorization code + PKCE (S256), a random validated state and the
fixed registered loopback redirect `http://127.0.0.1:33418`. Credentials and MFA
stay in Microsoft's browser page, never chat or plugin input. The listener binds
only `127.0.0.1`, validates callback host/path and rejects duplicate codes/state.
Browser sign-in has a three-minute deadline and closes its listener on exit.
No device-code or Azure CLI dependency is required.

**Two audiences.** Hooks and canvas use `entra.scope` (the gateway resource).
Claude/Codex MCP headers use `entra.mcpScope`, because the hosted MCP server
accepts only its own audience and uses the token for on-behalf-of calls. After
the gateway sign-in, login acquires the MCP token silently for the same account;
only when Entra requires interaction (typically missing consent) does it open one
more browser step with that account's login hint. Entra rejects a single request
that combines a `/.default` scope with a specific permission (`AADSTS70011`), so
`extraScopesToConsent` cannot be used here. A declined or different-account MCP
step leaves the gateway sign-in in place and reports `mcpReady: false` with a
safe `mcpReason` code; a different account is removed from the cache.

**Tenant.** `entra.tenantId` is optional and, when set, must be a tenant GUID or
verified domain; `common`, `organizations` and `consumers` are rejected because
guest accounts need a tenant-specific authority. A domain resolves to its GUID
from Microsoft's OpenID metadata. Login also sends an unauthenticated
`GET <gateway>/whoami` and reads the `401` challenge
`WWW-Authenticate: Bearer authorization_uri="https://login.microsoftonline.com/<tenant>"`
(other parameters such as `error="invalid_token"` are allowed, in any order).
Only an HTTPS `login.microsoftonline.com` URI whose path is exactly one tenant
GUID is accepted; other hosts are never followed. Without a configured tenant the
challenge is required; with one, a valid challenge for another tenant fails with
`TENANT_MISMATCH` before any browser opens, and a missing challenge is ignored.
The effective tenant GUID selects the MSAL authority, must equal the token's
tenant, is part of the cache context, and is recorded in `auth.json` for
background requests, which never run discovery. If a pinned tenant later differs
from the recorded one, requests fail with `TENANT_CHANGED` until `mh-login`.
`mh-status` reports the tenant.

`src/entra.mjs` loads the selected account from the protected MSAL cache and uses
`acquireTokenSilent` for every non-login request, with the scope for its audience. A valid cached token is reused;
near expiry, MSAL renews on demand using its cached renewal state. The serialized
cache (including refresh-token rotation) is persisted under a cross-process lock.
Within one client, acquisition is deduplicated and tokens are kept until expiry
skew. Logout/account-switch generations invalidate other long-lived clients.
Interaction-required results tell the user to run `mh-login`; background hooks,
headers and canvas never open a browser. Gateway requests are not retried, except
captured turns, which the capture queue resends.

**Persistent cache.** `~/.memory-house/msal-cache.json.enc` contains an encrypted
MSAL cache plus the selected account and effective-tenant/client/scope context.
An explicit sign-in replaces a cache whose context no longer matches; background
requests reject it. Existing
owned-directory, no-follow, bounded-read and atomic-write helpers protect state.
Unix directories/files use 0700/0600. A separate `msal-cache.lock` serializes
read/refresh/write and deletion; login/logout also hold the auth-preference lock.
No plaintext fallback is supported.

- Windows protects the serialized cache with DPAPI CurrentUser through Windows
  PowerShell. No key file is created.
- macOS/Linux use AES-256-GCM with authenticated deployment context and a random
  key in macOS Keychain / Linux Secret Service. `security` or `secret-tool` must
  be on PATH; secrets travel over stdin, never process arguments. Linux requires
  `secret-tool` (for example `libsecret-tools`) and an unlocked Secret Service.
  Locked/unavailable stores fail closed. Logout deletes the encrypted token
  file; a credential-store encryption key may remain, but contains no tokens.

Cache files are sensitive even when encrypted. Do not copy caches between OS
users/machines, inspect them in chat or commit them. OS protection does not defend
against malicious code already running as the same user. Pure bundled Node remains
the packaging contract: no native keytar/MSAL Extensions install on user machines.

`runtime/auth.mjs headers` emits one JSON object with the MCP-audience
authorization header, or `{}` on failure; sanitized diagnostics go to stderr. Network/cache operation
timeouts default to 10 seconds (maximum 30), capped at 7 seconds for headers and
5 seconds for hooks. Interactive login separately allows three minutes per
browser step (two steps when MCP consent is missing).

- **Claude** runs `headersHelper` from the plugin root with `CLAUDE_PLUGIN_ROOT`.
  Run `mh-login` and reconnect MCP instead of relying on host OAuth.
- **Codex** runs `http_headers_helper` from HOME with HOME and PATH. The launcher
  reads `~/.codex/plugins/cache/memory-house-marketplace/memory-house/<version>/`
  (falling back to `local`). Custom `CODEX_HOME`/`MEMORY_HOUSE_HOME` may not reach
  it; use default directories or supported forwarding, never copied credentials.
- **Copilot** continues to manage its MCP OAuth independently.

**Status/logout.** Status checks silent acquisition without exposing credentials;
it can renew over the network. Login also records the account's object ID and a
capture epoch in `auth.json` (see [Capture queue and recall](#capture-queue-and-recall)).
Logout writes the disabled preference and new generation to `auth.json`, deletes
the encrypted MSAL cache under its lock, removes obsolete token files and deletes
queued captures. It does not revoke issued tokens or affect other
apps' sign-ins. In-flight requests/host-cached headers may work until expiry;
reconnect MCP to drop cached headers. Explicit `mh-login` is required initially
and after logout; an existing Azure CLI session is not imported.

**Migration.** Old `token.json` credentials are ignored, never used for auth, and
removed on login/logout. There is no HookToken fallback, enrollment redemption or
plugin refresh/revoke endpoint. Claude/Codex enrollment-only post-tool hooks stay
removed; Copilot keeps post-tool recall and safely discards old enrollment results.

**Gateway prerequisite (not changed here).** MISE must validate Entra tokens on
capture (`POST /memory`), search (`POST /search`), `/memories` and canvas routes,
and the MCP server must validate tokens for `entra.mcpScope`, including
issuer/tenant, API audience (appropriate to its token version), lifetime and
delegated `scp`/authorization checks. The reused public client
`45cdeed7-4e4e-481d-9f00-6708c0631565` must allow the exact loopback redirect,
authorization code + PKCE without a secret, and consent to the gateway's exposed
delegated permissions for `https://dbinference.azure.com/.default` and the
MCP permission `api://inference-service-mcp/Logs.Read`. The gateway's `/hook/*`
routes accept HookTokens only and are no longer called. Unauthenticated requests
should return the tenant challenge described above.
`.default` selects configured permissions; it is not an authorization claim.
Gateway consent and live sign-in have not been verified by fixture tests.

References:
[MSAL Node acquisition](https://learn.microsoft.com/entra/msal/javascript/node/acquire-token-requests),
[MSAL Node caching](https://learn.microsoft.com/entra/msal/javascript/node/caching),
[authorization code + PKCE](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow),
[.default scopes](https://learn.microsoft.com/entra/identity-platform/scopes-oidc#the-default-scope),
[Claude headersHelper](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication),
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
Version 0.15.0 queues captured turns durably and sends them from a background
process, captures a long prompt whole as ordered parts, and searches automatically
only on the first prompt for 10 results with type, date and conflict notes; see
[Capture queue and recall](#capture-queue-and-recall). It has not been verified live.
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
observability is a follow-up. (The durable capture queue added later was a
separate design decision, not a fix for this anomaly.)
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

`plugin/deployment.json` contains only the public gateway, optional tenant, client, gateway and MCP scopes, and redirect.
Hooks, canvas and auth helpers read it; `mcp.json` repeats the gateway with
`/mcp/`. The Entra scope is configured below; live gateway compatibility
for this authentication path must still be verified:

| Setting | Configured value (live consent unverified) |
| --- | --- |
| Gateway | `https://reranker-api-h2b5czhkfkcphnf4.westus3-01.azurewebsites.net/inference/memory` |
| Entra tenant (optional; omit to discover) | `72f988bf-86f1-41af-91ab-2d7cd011db47` |
| API scope | `https://dbinference.azure.com/.default` |
| MCP scope | `api://inference-service-mcp/Logs.Read` |
| Public client | `45cdeed7-4e4e-481d-9f00-6708c0631565` |
| Loopback redirect | `http://127.0.0.1:33418` |

Gateway and token environment variables, legacy token files and per-user configuration
cannot override these settings. Changing deployments is a publisher operation:
update `deployment.json` and `mcp.json` together and publish an updated package.
The registered public client and callback must match the browser flow above.
Plugin state includes the encrypted MSAL cache, credential-free disabled
preference, hook context and the encrypted capture queue, using safe atomic
writes and locks.
Hosts need the same OS user and plugin state to share access;
different users, remote machines and explicit state overrides are separate.
`MEMORY_HOUSE_AUTH_TIMEOUT_MS` bounds network/cache operations (default 10000, max 30000);
hook/header entry points impose their own shorter caps.

## Capture queue and recall

**Queue.** Hooks never send a captured turn themselves. `src/capture-queue.mjs`
seals each turn and writes it as one file in `<state>/capture-queue/`, named by a
16-digit sequence number that only grows (plus a random suffix, so two writers
never share a name), then starts the background sender
(`runtime/flush.mjs`) as a detached process with no stdio and returns. The
sender can outlive the hook, so host timeouts (Copilot asks for under 5 seconds)
never cut a send short.

- **Protection.** Turn text, thread ID and account binding are sealed with the
  sign-in cache's device key (`createCacheProtection` with purpose `capture-queue`):
  DPAPI with its own entropy on Windows, AES-256-GCM with the Keychain/Secret
  Service key and separate associated data elsewhere, so neither ciphertext opens as
  the other. Signing in again leaves that key alone, so turns sealed before stay
  readable. The plaintext header holds only hashes of the gateway, thread and
  account binding. The directory and files use the state helpers: owned 0700/0600,
  no links followed, atomic writes. On Windows each seal and open is one short
  PowerShell call, so a long prompt starts one per part and a large backlog drains
  at about one turn per call.
- **Order.** The sender groups turns by conversation (thread) and sends each
  conversation's turns in sequence order, up to 50 turns and 240 KiB per request.
  A conversation stops at its first failure, so a later turn is never sent while an
  earlier one is queued.
- **Records and keys.** Before sending, the sender records the batch (its files and
  its `Idempotency-Key`) in `sending-<thread hash>.json`, one record per
  conversation. A later run resends exactly that batch with that key first, so a
  gateway that accepted the earlier attempt replays it instead of storing the turns
  twice. A key is `mh-capture-<sha256>` of the batch's turn IDs and how many of
  their requests already finished as failed, so the same attempt always has the
  same key and each retry after a finished failure a new one. After a success the
  turns, then the record, are removed; a record whose turns are partly gone means
  the batch was accepted and the sender stopped while removing it, so the rest is
  removed without sending. After a partial result the record is first replaced by
  one that also names the stored turns, so a sender stopped while settling it
  removes those turns rather than sending them again.
- **Failures.** The client reads what an error body says (at most 64 KiB, never its
  text): a problem+json `code` and retry delay, or, for a request the engine
  finished as failed, the gateway's copy of the request's record (`request_id` and
  `status: "failed"`, returned as 409, 404, 504 or 503) and its `error.code` if it
  has one. When every write failed, the usual case, it has none, only failed items.
  - A finished failure is replayed for its key for 24 hours, so retrying it under
    that key cannot succeed. With `reset_superseded` a memory reset (delete all)
    superseded the turns, and they are dropped. Otherwise each turn of the batch
    counts the failed request in its header (`failedRequests`, and `firstFailedAt`
    for the first) and, after the conversation's wait, is retried alone under a new
    key (recorded first). A turn is dropped once its requests have finished as
    failed under at least two keys and at least an hour after the first, so a
    storage incident does not drop turns, while one bad turn holds up its
    conversation for only about an hour. A clock set back restarts that hour, and a
    sender stopped between a failed request and updating its turns may leave that
    failure uncounted, which delays the drop by one retry.
  - A success can be partial. With 207 (`status: "partial"`) the engine stored some
    turns of the batch, and the others failed or their outcome is unknown
    (`result.items[]`, by `index` and `status`). The stored turns are removed; each
    other turn, including any the result does not report as stored, counts a
    finished failure as above. A 202 (`queued` or `running`) means another attempt
    with the same key is still running, so nothing is taken for stored and the same
    batch and key are sent again after the conversation's wait, when the engine
    returns the result.
  - A 409 without a finished record is not a refusal. `idempotency_conflict` means
    this key was used for these turns before, so the batch is treated as delivered;
    any other (`reset_in_progress`, `stale_generation`, `stale_reset`, or none) is
    raised before the request finishes, so the same batch and key are retried later,
    because the engine resumes a partly stored batch only under its original key.
    Other server errors without a record are retried the same way.
  - HTTP 400, 413 and 422 refuse a batch: its turns are resent one at a time, each
    recorded the same way, and only a refused turn is dropped.
  - A server error, a conflict, a finished or partial failure, or a request still
    running stops only its conversation: the others are still sent in the same
    run, and that conversation alone waits 30 seconds, doubling with its own
    consecutive failures up to 10 minutes, or longer when `Retry-After` asks for it.
    Sign-in, network, timeout, rate limiting (429) and credential-store failures
    would meet every conversation, so they stop the run and every conversation
    waits the same way. `status.json` holds these waits (failure count, retry time
    and kind, by conversation hash; no content).
  - A hook that queued a turn starts a sender unless its own conversation waits;
    other hooks start one only once some wait is over; session start and end always
    do, and their sender retries every conversation. A session start or end that
    finds a sender running leaves it that request in `force.json`, which that
    sender takes at its next pass (or the next sender, if this one stops first).
    Otherwise a sender skips the conversations still waiting. A new sign-in ignores
    earlier waits.
- **At least once.** A turn is never dropped for a transient failure, so it can
  rarely reach the gateway twice: when a recorded batch that the gateway did accept
  loses a turn (damaged or expired) before its retry, the rest are sent again under
  a new key; if two processes take over the same stale lock at once; when a batch
  whose response was lost is resent more than 24 hours later, because the engine
  remembers an `Idempotency-Key` for 24 hours; and when a failed or partial result
  reports a turn's outcome unknown (its write may still have landed), since that
  turn is resent under a new key.
- **Transient failures keep turns.** A credential store that is locked or
  unavailable, a file read error, or sign-in state that cannot be read stops the
  run with the turns kept. A turn that fails to open is tried again once the store
  opens a fresh test value, and is dropped only if it still fails.
- **One sender.** `flush.lock` is a lease touched before each request; a sender
  that crashed loses it after 2 minutes. After releasing it the sender checks for
  turns queued since it listed the queue, so a hook that saw the lease held never
  strands its turn. A sender also exits after 5 minutes.
- **Bounds.** At most 200 turns and 4 MiB; the oldest make room, except the batches
  being sent. Turns older than 7 days, damaged turns and stray temporary files are
  removed.
- **Account.** Turns belong to the signed-in account. `mh-login` records the
  account's object ID (from the MSAL account: its ID token's `oid`, else its local
  account ID) and a random capture epoch in `auth.json`. A sign-in with the same
  tenant and object ID while still signed in, for example after the sign-in
  expired, keeps the epoch; another account or tenant, or any sign-in after a
  sign-out, starts a new one. Each turn is bound to a hash of tenant, object ID and
  epoch (`client.captureIdentity()`, local only), so turns survive a new sign-in
  with the same account, and a sign-out ends them even if its queue deletion
  failed or was done by an older plugin version. A sign-in recorded by an earlier
  version has no object ID, so nothing proves whose turns were queued under it:
  they are never sent. The sender discards them and records the cached Microsoft
  account once (`client.recordAccount()`), holding the sign-in lock so that no
  `mh-login` is changing the cache meanwhile, with a new generation so that every
  client drops tokens it cached before; turns queued after that are bound to that
  account. In practice the first turn or two after updating from an earlier
  version, or after an earlier version's `mh-login`, are not captured. Nothing is
  queued on a device that never signed in. The hook checks the binding again under the
  queue lock just before writing, so a logout that already deleted the queue is
  not undone. When sending, the client refuses a batch if the
  binding changed, or if its token is not for the recorded account (a token whose
  account is unknown included): `mh-login` replaces the MSAL cache before it records
  the new sign-in, so for a moment a token can belong to the next account.
  `mh-logout` deletes the queue, waiting for the queue lock (at most its 10-second
  TTL); the sender discards turns bound to another account or queued before a
  sign-out.
- **Long prompts.** A cleaned prompt over 32 KiB is queued, in one locked write, as
  consecutive user turns of at most 32 KiB, each starting with
  `[Part 2 of 4 of one long message]`. Cuts fall after a line break (else a space)
  within the last 1 KiB of a part, never inside a character. A prompt over about
  248 KiB, the most that always fits in 8 parts, keeps its start and end around
  `[N characters cut from the middle of this message]`. Agent replies still keep
  their first 32 KiB, and the search query is unchanged. Memory House extracts
  turns in batches of up to 7,000 tokens and extracts a larger turn on its own.
- **Diagnostics.** Hooks log `capture:<role>:queued` (`:queued:<n>-parts` for a
  long prompt), `:skipped:not-signed-in` or `:failed:queue-<reason>` and
  `capture:sender-started`; the sender has no output.

**Recall.**

- Automatic recall asks for 10 results (`MEMORY_HOUSE_TOP_K` overrides, up to 20)
  on the first nonempty, cleaned user prompt. Session start only retries capture;
  it does not search with a generic startup query.
- The query is the whole cleaned prompt up to 16 KiB; a longer prompt keeps its
  first and last 8 KiB around `[...]`.
- Every host records the first prompt in permission-restricted per-session state.
  The one search attempt is recorded before the request, so empty results or errors
  do not cause repeated automatic searches. Later recall uses the hosted MCP
  `search_memories` tool at the agent's discretion.
- Claude and Codex search in the first prompt hook. Copilot defers to the first
  prompt's transform, or post-tool if no transform ran; VS Code uses post-tool.
  Copilot caches the sanitized reference block so repeated transforms do not search
  again. Cached results are bound to the sign-in generation and are not reused
  after logout, another sign-in, or an unreadable sign-in state. The query and
  block are cleared on stop or a subsequent prompt and become
  unusable after an hour. The consumed-session marker survives that expiry and
  resume/compaction; session end removes it. State is bounded to 128 sessions,
  evicting the oldest when full. Lost or evicted state can permit a new initial
  search. Legacy per-prompt state is treated as an already-started session.
- Each memory renders as `- [type, YYYY-MM-DD] text`, with each
  `conflicts_with` entry (at most 5, then a count) as `  - Conflicts with
  [YYYY-MM-DD]: text`. Text is filtered and escaped like before. A memory is
  included whole or skipped if it does not fit in the 8 KiB block; nothing is cut.

## Supported listing

Agents list memories with the remote `get_memories` tool (`page_size` up to
50, `cursor`, `memory_types`); the skills say when to follow `next_cursor`.
The plugin lists memories itself only for the Copilot app canvas, through its
Entra Bearer client: `GET {gatewayBase}/memories` with optional `memory_types`
and `include_superseded`, a fixed `page_size` of `min(count, 50)`, following
`next_cursor` for at most `ceil(count / page_size)` requests (count 1 to 200,
default 50) and stopping when `has_more` is false. Each cursor is bound to the
page size, filters, caller authorization and reset generation. Any failed page
fails the whole listing, and malformed continuation metadata produces an
error rather than an empty result.

## Skill commands

The payload skills are `mh-login`, `mh-logout`, `mh-status`, `mh-memory`,
`mh-show` and `use-memory`; each directory and frontmatter name matches.
`use-memory` asks the agent to call `search_memories` when past preferences,
decisions, fixes or commands could help, before repeating investigation, or when
a topic change needs context not already available. It does not mandate a
duplicate lookup after the initial hook search. All are available for discovery.
Login/logout descriptions and instructions require an explicit user request;
the skill itself does not pre-approve its tools. `mh-login`, `mh-logout`
and `mh-status` all run `runtime/auth.mjs`, so the host's
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
  `GET /whoami` and `GET /v1/me/reach` through the gateway with an Entra Bearer token.
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
The runtime holds the hooks, the background capture sender, the canvas and the sign-in helper. It bundles
MSAL for the helper's Microsoft sign-in, but no MCP SDK, because the MCP server
is remote. A fresh cached installation needs no `node_modules`, unpublished npm
package, lifecycle script, network dependency installer, or files outside the
installed root. Local Node.js 20+ and the platform credential-protection tools
documented above are required for hooks and helpers.

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
hook commands for each app, the bundled auth helper with a synthetic protected
MSAL cache (real DPAPI on Windows, isolated fake OS stores on macOS/Linux),
both header launchers (including Codex's minimal environment),
shared cached authentication, plugin-cache logout, recall and capture through the
detached background sender (including a gateway outage and a slow gateway), and command
execution without source `node_modules`, all against a loopback gateway
fixture. The available Claude CLI strictly validates and installs the payload
and root catalog in an isolated fake profile, then connects the remote server
with a fixture Bearer token through its header helper. The available Copilot CLI
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
waits up to one second for the final transcript text, then queues the final
answer once. This is bounded local transcript reading; delivery and retries belong
to the capture queue.

The default automated suite must not read a real app profile, sign in to a production tenant, send
real conversations, or install a plugin into an active user profile. Loopback
HTTP fixtures explicitly use `MH_ALLOW_INSECURE_LOCALHOST=1`. Only the capture
queue resends anything, and tests drive it against loopback fixtures. The live checks above were
separate, explicitly authorized operations; they are not run by `npm test`.

## Publication

GitHub marketplace installation fetches the published repository/default ref,
not local changes. Publish this branch only when separately authorized; do not
claim that adding the live URL installs uncommitted code. Branch-pinned testing
can use the host's supported ref selector after the branch is pushed (for
example Copilot's `owner/repo#ref` or Codex's `--ref`).
