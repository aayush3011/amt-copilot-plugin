# Maintaining the Memory House plugin

This repository publishes one marketplace and one curated installable payload.
All four catalogs stay at the repository root and select `./plugin`; no
per-host package or ZIP selection is part of the product.

```text
.claude-plugin/marketplace.json
.agents/plugins/marketplace.json
.cursor-plugin/marketplace.json
.github/plugin/marketplace.json
plugin/
  plugin.json, mcp.json, deployment.json, LICENSE
  .claude-plugin/, .codex-plugin/, .cursor-plugin/
  .claude/, .codex/, .cursor/, .github/
  skills/
  runtime/
src/, test/, scripts/, .maintainer/, docs/  (publisher-only)
```

Manifest/component paths below are relative to the installed payload root
(`plugin/` in the repository). Catalog paths are relative to the repository.

## Native resolution

| Host | Catalog | Manifest and component selection |
| --- | --- | --- |
| Claude Code | `.claude-plugin/marketplace.json` | `.claude-plugin/plugin.json` explicitly selects `.claude/plugin-hooks.json` and `.claude/mcp.json`. There is no default `.mcp.json` or `hooks/hooks.json` to merge. |
| Codex | `.agents/plugins/marketplace.json` | Native legacy `.codex-plugin/plugin.json` directly selects `skills/`, `mcp.json` and `.codex/plugin-hooks.json`. No root manifest opts into Agent Plugins 1.0. |
| Cursor | `.cursor-plugin/marketplace.json` | Its native catalog resolves `.cursor-plugin/plugin.json`, whose explicit hooks/MCP paths select `.cursor/plugin-hooks.json` and `.cursor/mcp.json`. Native marketplace resolution, not the root portable-only format, supplies Cursor hooks. |
| Copilot | `.github/plugin/marketplace.json` | Legacy `plugin.json` explicitly selects `skills/`, `mcp.json` and `.github/plugin-hooks.json`, invoking `.github/entry.mjs`. |

Each installed host has one named MCP connection, `memory-house`, and one hook
set. The catalogs share a name and payload source, so a host's compatibility
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
Cursor's documented **native marketplace** resolution checks
`.cursor-plugin/plugin.json`, with manifest values overriding catalog values;
the explicit `mcpServers` field replaces root `mcp.json` discovery. Do not use a
portable-only Cursor import path: that format supports only MCP/skills and does
not expand `${PLUGIN_ROOT}`. Its native MCP file uses `${CURSOR_PLUGIN_ROOT}`.

The `.claude/`, `.codex/`, `.cursor/`, and `.github/` config files are named
`plugin-hooks.json` deliberately: they are selected by the plugin manifest,
not automatically enabled as workspace hooks just by checking out this repo.
The four `entry.mjs` files import the same `runtime/hook.mjs`; there is no
separate auth/capture implementation per host. Native root variables are
checked against the installed package before running. Claude and Copilot use
direct executable/argv hooks. Codex and Cursor use a fixed Node launcher that
reads the host-exported root variable without interpolating paths into shell
code, including on Windows.

Official contracts:
[Claude native manifests](https://code.claude.com/docs/en/plugins-reference),
[Claude root-relative marketplaces](https://code.claude.com/docs/en/plugin-marketplaces),
[Codex native manifests](https://developers.openai.com/plugins/build/plugins),
[Codex manifest selector](https://github.com/openai/codex/blob/main/codex-rs/utils/plugins/src/plugin_namespace.rs),
[Cursor native marketplace resolution](https://cursor.com/docs/reference/plugins#how-resolution-works),
[Cursor distribution policies](https://cursor.com/docs/plugins),
[Copilot legacy manifests and catalogs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference#legacy-manifest-fields).

## Live CLI limitations

The 2026-09-16 live checks initially used plugin 0.12.1 and the vendor builds
below. Version 0.12.3 corrected the Codex manifest format and the earlier
0.12.2 conclusion that all third-party plugin hooks were vendor-blocked.
Version 0.12.4 moves the same native components into one curated payload.
Hook discovery, native trust and real capture are distinct checks.

**Copilot CLI 1.0.81-4:** real Microsoft sign-in, search, explicit insertion,
status, sign-out and restoration passed. A tool-free conversation produced one
HTTP 201 user capture and one HTTP 201 agent capture with the same thread hash.
A later turn in that session received injected recall. Passive observation
recorded only operation/status, role, content byte count and hashed thread ID,
not request text, returned memories, tokens or authorization headers.
The complete login/search/add/status/logout/restore flow and two-turn capture
were rerun successfully against the pushed 0.12.3 legacy-manifest release.

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
trust or executing any hook. A separate real Codex session, using the existing
ChatGPT-authenticated profile, then trusted exactly the three Memory House
plugin definitions through the native API used by `/hooks`. No trust-bypass
flag or user/project hook commands were added. Two tool-free turns each sent
one HTTP 201 user capture and one HTTP 201 final-agent capture with the same
thread hash. Captured text hashes matched the actual prompts/final answers;
the native hook notifications and transcript confirmed recall injection on the
later turn. These verification turns entered the user's real Memory House.

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

**Cursor CLI 2026.09.10-fd3934a:** after replacing a stale pinned marketplace
registration and installing Git revision `3712a60`, the MCP operations passed.
Startup, post-tool and session-end plugin hooks ran. Ordinary prompts and final
responses did not, in both print and interactive checks. The installed CLI's
`beforeSubmitPrompt` guard checks only
`hooksConfig.userHooks`/`hooksConfig.projectHooks`; its `afterAgentResponse`
helper has the same user/project-only gate. Plugin hooks are excluded before
dispatch. Startup recall is therefore available, but the per-turn query cache
cannot be populated for post-tool recall. `--approve-mcps` approves connections,
not tool calls; print-mode MCP operations also needed `--force` for this
explicitly authorized verification.

**Claude Code 2.1.273:** installation/current-cache loading and real account
authentication were verified using the user's normal login-shell environment.
Model execution returned **HTTP 400, `Credit balance is too low`**, with zero API
execution duration. Its live tool and capture legs remain unproven. Check the
account's billing or whether the CLI uses API credits rather than the intended
subscription. No billing change was attempted. Temporary local-scope plugin
settings were removed, preserving the preexisting user installation.

The product conclusion is explicit: plugin MCP tools are deliverable where the
host can run them; automatic plugin-delivered capture is verified on Copilot
and on Codex with its corrected legacy manifest and normal hook trust.
Cursor needs a separately user-approved user/project-hook configuration for
automatic capture. A future
`mh-enable-capture`/matching-disable workflow could provide that opt-in after
consent; it is **not implemented**, and no such files were silently installed
in a real profile during this work. Do not substitute model-selected
`add_memory` calls for the missing automatic stream.

## Publisher configuration

`plugin/deployment.json` contains only public deployment settings. The shipped values
were verified on 2026-09-16:

| Setting | Verified value |
| --- | --- |
| Gateway | `https://reranker-api-h2b5czhkfkcphnf4.westus3-01.azurewebsites.net/inference/memory` |
| Entra tenant | `72f988bf-86f1-41af-91ab-2d7cd011db47` |
| Public-client ID | `45cdeed7-4e4e-481d-9f00-6708c0631565` |
| Delegated API scope | `api://45cdeed7-4e4e-481d-9f00-6708c0631565/Inference.Execute` |
| Registered public-client callback | `http://127.0.0.1:33418` |

Tenant/scope were confirmed by public gateway discovery at
`/.well-known/oauth-protected-resource/inference/memory/mcp` and
`/.well-known/oauth-authorization-server`. Existing gateway source confirmed its
fixed registration client ID. Read-only Entra application metadata confirmed
the same application ID, `isFallbackPublicClient=true`, and that exact
public-client loopback callback (as well as `http://localhost`). No registration
was changed and no user access token was issued by that verification.

`memory_login` invokes the Entra helper directly and opens Microsoft's HTTPS
authorization URL in the browser after the host's tool approval. It waits for
sign-in and returns only safe outcome text. `memory_status` checks local state
without a network request or deployment URL, and `memory_logout` revokes/clears
the shared sign-in without a browser. No model tool accepts identity, endpoints
or credentials. The shipped
application registration is read from `deployment.json`, not arbitrary host
OAuth caches, legacy token files, per-user public configuration, or
gateway/token environment overrides.

Changing deployments is a publisher operation: set verified public values in
this file and publish an updated package. Do not infer a public-client ID from
an API audience without verifying the registration. Preserve the exact callback
and registered port/path. An occupied fixed port fails explicitly instead of
falling back to an arbitrary port. Tenant policy, account entitlement, network
reachability and user consent still govern actual live sign-in.

The only local HTTP listener is the registered OAuth callback during sign-in;
there is no landing page, configuration server, or ephemeral-port management UI.
PKCE, callback-state validation and fixed-port binding remain in `src/entra.mjs`.
Auth tool calls are serialized per MCP connection so an overlapping sign-out
cannot race an in-progress sign-in; status remains readable during sign-in.
MCP cancellation/shutdown aborts the active auth helper.

Shared credentials live in `~/.memory-house/token.json` (or an explicitly
operator-selected `MEMORY_HOUSE_HOME`). Auth writes use private files and
cross-process locks. Tokens are gateway-bound and never copied into the repo.
Gateway refresh/capture/search/revoke APIs and AMT remain unchanged.

## Skill commands

The payload skills are `mh-login`, `mh-logout`, `mh-status`, and `mh-memory`;
each directory and frontmatter name matches. Login and logout set
`disable-model-invocation: true` and Codex's `allow_implicit_invocation: false`
metadata. Skills do not pre-approve the MCP tools.

Claude Code invokes plugin skills as `/memory-house:mh-login` (and the same
prefix for the other three names). The verified Copilot CLI registers the same
`/memory-house:mh-login` command name; the app's picker is authoritative for its
version. Cursor
selects `mh-login` from its `/` picker, and Codex CLI/IDE mentions `$mh-login`
or selects it through `/skills`. The same substitutions apply to logout,
status and memory. ChatGPT desktop's skill picker uses `@`; exact Codex desktop
controls depend on the surface/version, so the user docs do not invent a
universal bare slash alias there.

Invocation references:
[Claude plugin namespace](https://code.claude.com/docs/en/plugin-marketplaces),
[Copilot skill invocation](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills#using-agent-skills),
[Codex and ChatGPT skill invocation](https://learn.chatgpt.com/docs/build-skills),
[Cursor skill picker](https://cursor.com/docs/skills).

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
native payload and the four root catalogs.
The runtime contains bundled MSAL and the official MCP SDK, so a fresh cached
installation needs no `node_modules`, unpublished npm package, lifecycle script,
network dependency installer, or files outside the installed root. A local
Node.js 20+ executable is still required by the host.

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

Tests reconstruct fresh repository-shaped snapshots with four root catalogs
and the exact payload inventory under `plugin/`. They exercise actual SDK
initialize/list/call flows, search/insertion, synthetic MSAL PKCE + authenticated
enrollment, shared credentials/recall, hook discovery/isolation, and command
execution without source `node_modules`. The available Claude CLI strictly validates and installs the payload and root catalog
in an isolated fake profile. The available Copilot CLI also registers the native
catalog and installs its payload in an isolated profile. The available
Codex CLI installs the same snapshot and asserts that all three hooks are
discovered as plugin-scoped and untrusted beside the legacy Copilot root.
These tests do not sign in, grant hook trust or start a model session. Native
discovery and protocol fixtures are not substitutes for live capture testing.

`scripts/package-files.mjs` defines the **enforced payload inventory**.
Build and bundle checks reject extra files, empty directories, and links inside
`plugin/`. With marketplace `source: "./plugin"`, native installers select only
that subdirectory. The installed plugin root contains no `.git`, `src/`,
`test/`, `docs/`, `scripts/`, `.maintainer/`, developer getting-started file, or
marketplace catalogs. A host may separately retain its Git marketplace clone;
that is not the installed payload. The publisher must still review the whole
tracked repository before pushing and must never publish credentials.

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

The Cursor native catalog is for an approved Git-backed team marketplace.
Teams/Enterprise policies and public marketplace review remain platform
requirements, not code features this repository can grant.
