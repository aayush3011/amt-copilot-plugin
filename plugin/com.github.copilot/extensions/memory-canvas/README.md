# AMT Memory canvas extension

A "Memory" panel for the GitHub Copilot app. Bundled inside the `amt-memory` plugin
(Option 1). It shows what AMT remembers about the signed-in developer, grouped into
**Personal / Team / Org**, and exposes agent-callable actions to refresh, forget, and
promote memories.

## How it fits the plugin

Registered in `plugin/plugin.json` through the native top-level `extensions` path, pointing
at this directory. Installing the plugin surfaces the canvas in the Copilot app's
**Customize -> Canvas** view; `/memory-show` opens it in the session's right side panel.

## How it works

- `extension.mjs` calls `joinSession()` + `createCanvas()` from
  `@github/copilot-sdk/extension` (the same pattern as the github/awesome-copilot canvas
  extensions).
- On open, it starts a local `node:http` server that serves the panel HTML and one
  read-only JSON endpoint (`/api/memory`). Every request is guarded by a per-server
  capability token plus a cross-site check.
- **Reads** come straight from the AMT REST API over the IP gateway, using a delegated
  `az` token (same identity path as the plugin hooks, `amt-token.sh`). `whoami` resolves
  the caller; personal memories come from `GET /memories`, and team/org from scoped
  `POST /search`.
- **Writes** (`forget_memory`, `promote_memory`) do not touch AMT directly. They call
  `session.send(...)` to ask the host agent to perform the action via the `amt-memory`
  MCP tools, so they reuse the plugin's OAuth sign-in and the server-side authorization.

## Actions (agent-callable)

| Action | What it does |
| --- | --- |
| `refresh` | Reload and return the three-tier memory view as JSON. |
| `forget_memory` | Delegate to the host agent to find and (on confirmation) forget a memory. |
| `promote_memory` | Delegate to the host agent to promote a personal memory to a team/org scope. |

## Prerequisites

- Node.js (the app runs `extension.mjs`).
- Azure CLI signed in (`az login`) - used for the delegated read token.
- The plugin installed so the app discovers the canvas.

## Demo-grade vs. real (known gaps)

- **Auth**: `az account get-access-token` for reads (expires ~1h). Productizing shares the
  same token path as `amt-token.sh`.
- **SDK version**: `package.json` pins `@github/copilot-sdk` at a placeholder range;
  set the version your app ships. The import path `@github/copilot-sdk/extension` matches
  the public canvas examples - confirm against your installed SDK.
- **Session loading**: after installing or updating the plugin, start a new session so the
  app launches the updated canvas extension and adds `amt-memory` to that session's canvas
  registry.
- **forget / promote**: there is no AMT delete or promotion REST endpoint yet, so these
  actions delegate to the agent + MCP tools rather than calling AMT directly. A first-class
  `service/` forget endpoint and the promotion PR would let the canvas act directly.
- **Team column**: populates from `team:<group>` data. It is empty when the caller's team
  has no memories yet (or when the group is not in the caller's claims).

## Verified

The read path was exercised against the live gateway with a real developer token: `whoami`
resolves the principal and tenant, and the panel groups personal + org memories correctly
(team populates once team data exists). `extension.mjs` passes `node --check`.
