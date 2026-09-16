# Maintaining the root Memory House plugin

This repository root is both the marketplace and its single installable plugin.
All four catalogs select `./`; no generated sub-marketplace or per-host package
is part of the product.

## Native resolution

| Host | Catalog | Manifest and component selection |
| --- | --- | --- |
| Claude Code | `.claude-plugin/marketplace.json` | `.claude-plugin/plugin.json` explicitly selects `.claude/plugin-hooks.json` and `.claude/mcp.json`. There is no default `.mcp.json` or `hooks/hooks.json` to merge. |
| Codex | `.agents/plugins/marketplace.json` | Root Agent Plugins 1.0 `plugin.json` supplies canonical identity, root `skills/` and `mcp.json`. `extensions.com.openai.hooks` selects `.codex/plugin-hooks.json`; no legacy overlay is used. |
| Cursor | `.cursor-plugin/marketplace.json` | Its native catalog resolves `.cursor-plugin/plugin.json`, whose explicit hooks/MCP paths select `.cursor/plugin-hooks.json` and `.cursor/mcp.json`. Native marketplace resolution, not the root portable-only format, supplies Cursor hooks. |
| Copilot | `.github/plugin/marketplace.json` | Root Agent Plugins 1.0 manifest and `mcp.json`, with the required `com.github.copilot/hooks/hooks.json` loader invoking `.github/entry.mjs`. An `extensions.com.github.copilot.hooks` override would not work. |

Each installed host has one named MCP connection, `memory-house`, and one hook
set. The catalogs share a name and root source, so a host's compatibility
catalog fallback does not point to a different product. Do not add top-level
`hooks`, `skills`, or `mcpServers` to the portable manifest: its schema is closed
and those path fields would be ignored.

Hooks automatically capture every conversational user turn and final agent turn
in the main conversation. Their capture calls do not ask the model to choose
important material; the AMT backend handles extraction, consolidation and
discarding. `add_memory` is only an explicit user-requested one-off write, never
a substitute for the hook stream or an importance-based extra write. Existing
credential/runtime filtering and best-effort delivery still apply.

Claude uses its native manifest rather than `plugin.json` for components.
Codex's supported portable-root selector takes precedence over its compatibility
manifests. Cursor's documented **native marketplace** resolution checks
`.cursor-plugin/plugin.json`, with manifest values overriding catalog values;
the explicit `mcpServers` field replaces root `mcp.json` discovery. Do not use a
portable-only Cursor import path: that format supports only MCP/skills and does
not expand `${PLUGIN_ROOT}`. Its native MCP file uses `${CURSOR_PLUGIN_ROOT}`.

The `.claude/`, `.codex/`, and `.cursor/` config files are named
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
[Codex portable-root overlays](https://developers.openai.com/plugins/build/plugins),
[Codex manifest selector](https://github.com/openai/codex/blob/main/codex-rs/utils/plugins/src/plugin_namespace.rs),
[Cursor native marketplace resolution](https://cursor.com/docs/reference/plugins#how-resolution-works),
[Cursor distribution policies](https://cursor.com/docs/plugins),
[Copilot portable hooks and catalogs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference).

## Publisher configuration

`deployment.json` contains only public deployment settings. The shipped values
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

The root skills are `mh-login`, `mh-logout`, `mh-status`, and `mh-memory`;
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

`runtime/` is intentionally **not gitignored**. Publish its generated JavaScript,
`THIRD_PARTY_NOTICES.txt`, and `manifest.json` together with the root plugin.
The runtime contains bundled MSAL and the official MCP SDK, so a fresh cached
installation needs no `node_modules`, unpublished npm package, lifecycle script,
network dependency installer, or files outside the installed root. A local
Node.js 20+ executable is still required by the host.

Dependencies and the npm lockfile live only in `.maintainer/`, because Claude
automatically runs `npm ci` for a package with a root `package.json` and root
lockfile, even when dependencies are only for development. The installed root
therefore has no dependency list or lockfile. The maintainer-only module loader
lets tests/builds resolve that separate dependency directory; no native entry
uses it. Maintainer tooling needs Node.js 20.6+, while the bundled plugin needs
Node.js 20+. The build
allowlists entry points, refuses unresolved non-builtin runtime imports,
preserves dependency license texts, records source/package/lock hashes, and
refuses to overwrite unknown or modified runtime files. There are no binary
Node runtimes or platform-specific native npm modules in the package.

Tests reconstruct fresh repository-shaped install snapshots from the root
package allowlist and the included runtime. They exercise actual SDK
initialize/list/call flows, search/insertion, synthetic MSAL PKCE + authenticated
enrollment, shared credentials/recall, hook discovery/isolation, and command
execution without source `node_modules`. The available Claude CLI strictly validates and installs the root plugin/catalog
in an isolated fake profile. The available Copilot CLI also registers the native
catalog and installs its root plugin in an isolated profile. Neither test signs
in or starts a model session. Cursor/Codex contract fixtures are not a substitute
for live desktop testing.

Copilot's event log can still be flushing when its stop hook fires. The adapter
waits up to one second for the final transcript text, then makes at most one
capture request. This is bounded local transcript reading, not a capture queue,
idempotency mechanism, or network replay.

No tests should read a real app profile, sign in to a production tenant, send
real conversations, or install a plugin into an active user profile. Loopback
HTTP fixtures explicitly use `MH_ALLOW_INSECURE_LOCALHOST=1`. Capture is
best-effort and is never automatically replayed.

## Publication

GitHub marketplace installation fetches the published repository/default ref,
not local changes. Publish this branch only when separately authorized; do not
claim that adding the live URL installs uncommitted code. Branch-pinned testing
can use the host's supported ref selector after the branch is pushed (for
example Copilot's `owner/repo#ref` or Codex's `--ref`).

The Cursor native catalog is for an approved Git-backed team marketplace.
Teams/Enterprise policies and public marketplace review remain platform
requirements, not code features this repository can grant.
