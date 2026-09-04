// Extension: amt-memory-canvas
// A "Memory" panel for the GitHub Copilot app. Shows what AMT remembers about the
// signed-in developer, grouped by Personal / Team / Org scope, and lets them act on it.
//
// Architecture (mirrors github/awesome-copilot canvas extensions):
//   - joinSession() + createCanvas() register the canvas with the host.
//   - The extension runs a local node:http server that serves the panel HTML and a small
//     read-only JSON API the page polls. A per-server capability token guards every
//     request so a cross-site/rebinding caller cannot reach the socket.
//   - Reads and imports go straight to the AMT REST API over the IP gateway using the
//     plugin's gateway-issued hook token (amt-token.sh) - the same keyless identity path as
//     the hooks. No `az` and no Entra client id live in the canvas.
//   - "Import memory" reads local GitHub Copilot CLI state (read-only) via the shared engine
//     scripts/amt-import.mjs and publishes it: session turns to POST /memory, Copilot's own
//     memories to POST /facts (+ /reconcile).
//   - Write actions (forget / promote) do NOT call AMT directly. They use
//     session.send(...) to ask the host agent to run the amt-memory MCP tools, so they
//     reuse the plugin's existing OAuth sign-in and the server-side authz. (forget /
//     promote REST endpoints do not exist yet; see Docs/amt-plugin-design-sketch.md.)

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { listSessions, importSessions, importMemories, resolveGatewayBase } from "../../scripts/amt-import.mjs";

// The gateway data-plane base is customer-configured in exactly one place (the plugin's
// mcp.json) and resolved by the shared engine; nothing is hardcoded here. Memoized after the
// first read. AMT_GATEWAY_BASE overrides for tests / local dev.
let _gatewayBase;
function gatewayBase() {
  return (_gatewayBase ||= resolveGatewayBase());
}
// The plugin's token authority is amt-token.sh: it prints a valid gateway-issued hook access
// token (see amt-config.sh) and refreshes silently. The canvas reuses it, so it needs no
// Entra client id and no `az` - the same keyless path as the hooks and the import engine.
const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");

// One local server per open canvas instance.
const servers = new Map();

// --- AMT access -----------------------------------------------------------------------

// A valid AMT hook access token from the plugin's token authority (amt-token.sh, which
// refreshes silently at the gateway). Non-blocking. This is the same token the hooks and the
// import engine send; the gateway accepts it on every /inference/memory route.
function getToken() {
  if (process.env.AMT_ACCESS_TOKEN) return Promise.resolve(process.env.AMT_ACCESS_TOKEN.trim());
  const isWindows = process.platform === "win32";
  const cmd = isWindows ? "powershell" : "bash";
  const args = isWindows
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(SCRIPTS_DIR, "amt-token.ps1")]
    : [join(SCRIPTS_DIR, "amt-token.sh")];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(new Error("not signed in to AMT; run /amt-login"));
      const t = String(stdout).trim();
      t ? resolve(t) : reject(new Error("not signed in to AMT; run /amt-login"));
    });
  });
}

// Redeem an enrollment code for a hook token and cache it, entirely in-process.
//
// This exists because the Copilot app's agent has no shell tool: it can call MCP tools and
// canvas actions, but it cannot run amt-login.sh. Without a local execution path the agent
// can reach, sign-in silently never completes and every hook logs `skipped:no-hook-token`.
// The CLI keeps using amt-login.sh; both write the identical cache.
async function redeemEnrollmentCode(code) {
  const res = await fetch(`${gatewayBase()}/hook/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enrollment_code: code }),
  });
  if (!res.ok) throw new Error(`enrollment failed (HTTP ${res.status}); the code may be expired or already used`);
  const data = await res.json();
  if (!data.access_token || !data.refresh_token) throw new Error("enrollment failed (invalid or expired code)");

  const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
  const dir = join(home, "amt");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const payload = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in || 1800),
    token_type: "HookToken",
  };
  const target = join(dir, "token.json");
  const tmp = `${target}.${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
  await rename(tmp, target);
}

async function amt(path, { method = "GET", body } = {}) {
  const token = await getToken();
  const res = await fetch(`${gatewayBase()}${path}`, {
    method,
    headers: {
      Authorization: `HookToken ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`AMT ${method} ${path} -> ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// Classify a record's scope into one of the three rendered tiers.
//
// Topology promotion writes shared copies under ``scope:<node>``. The panel cannot tell a
// team node from an org node by prefix alone, so it treats the scopes matching the caller's
// own group names as their teams and any other topology scope as broader/org-level. The
// legacy ``team:``/``org:`` prefixes are still honored.
function tierOf(scopeKey = "", teamScopes = []) {
  if (scopeKey.startsWith("user:")) return "personal";
  if (teamScopes.includes(scopeKey)) return "team";
  if (scopeKey.startsWith("scope:")) return "org";
  if (scopeKey.startsWith("team:")) return "team";
  if (scopeKey.startsWith("org:")) return "org";
  return "other";
}

// Build the scope-grouped view the panel renders. Both calls deliberately omit an explicit
// scope list: passing one overrides the session's read set, which is what resolves the
// caller's topology memberships and therefore what makes promoted memories visible at all.
// The gateway exposes no topology endpoint, so the scope tree is derived from the scopes
// actually present on the records the caller can read.
async function loadMemory(filters = {}) {
  const who = await amt("/whoami");
  const groups = who.groups || [];
  const teamScopes = groups.flatMap((g) => {
    const bare = g.replace(/^(team|scope):/, "");
    return [`scope:${bare}`, `team:${bare}`];
  });

  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const types = (filters.memoryTypes || []).filter((t) => MEMORY_TYPES.includes(t));
  const query = new URLSearchParams();
  query.set("recent_k", String(limit));
  for (const t of types) query.append("memory_types", t);
  if (filters.includeSuperseded) query.set("include_superseded", "true");

  const personal = await amt(`/memories?${query}`).catch(() => ({ items: [] }));
  const shared = await amt("/search", {
    method: "POST",
    body: {
      query: filters.search || "team and organization knowledge, standards, and decisions",
      top_k: limit,
      ...(types.length ? { memory_types: types } : {}),
    },
  }).catch(() => ({ items: [] }));

  const needle = String(filters.search || "").trim().toLowerCase();
  const byScope = {};
  const seen = new Set();
  let total = 0;
  for (const it of [...(personal.items || []), ...(shared.items || [])]) {
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    const record = shape(it, teamScopes);
    if (record.tier === "other") continue;
    if (needle && !matchesSearch(record, needle)) continue;
    (byScope[record.scope_key] ||= []).push(record);
    total += 1;
  }
  for (const list of Object.values(byScope)) {
    list.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  }
  return {
    who: who.principal,
    tenant: who.tenant_id,
    // Demo default. The tenant's scope key is a GUID and no gateway route returns an
    // organization name, so the display name is supplied here until one exists.
    orgLabel: process.env.AMT_ORG_DISPLAY_NAME || "Cosmos DB",
    teamScopes,
    scopes: Object.keys(byScope).sort(scopeOrder(teamScopes)),
    groupsByScope: byScope,
    total,
    updatedAt: new Date().toISOString(),
  };
}

const MEMORY_TYPES = ["fact", "episodic", "procedural"];

// Organization first, then the caller's teams, then personal: the same order the tree renders
// and the reverse of the promotion path, so a scope always appears below the scope it can be
// promoted into.
function scopeOrder(teamScopes) {
  const rank = (s) => {
    const tier = tierOf(s, teamScopes);
    return tier === "org" ? 0 : tier === "team" ? 1 : 2;
  };
  return (a, b) => rank(a) - rank(b) || a.localeCompare(b);
}

function matchesSearch(record, needle) {
  return (
    String(record.content || "").toLowerCase().includes(needle) ||
    String(record.id || "").toLowerCase().includes(needle) ||
    (record.tags || []).some((t) => String(t).toLowerCase().includes(needle))
  );
}

function shape(it, teamScopes = []) {
  const provenance = it.provenance || {};
  return {
    id: it.id,
    scope_key: it.scope_key,
    tier: tierOf(it.scope_key, teamScopes),
    type: it.memory_type || it.type,
    content: it.content || it.text || "",
    tags: it.tags || [],
    created_at: it.created_at,
    salience: it.salience,
    confidence: it.confidence,
    source: provenance.source,
    superseded: Boolean(it.superseded_by),
  };
}

// --- Local panel server ---------------------------------------------------------------

function isCrossSite(req) {
  const dest = req.headers["sec-fetch-site"];
  return typeof dest === "string" && dest !== "same-origin" && dest !== "none";
}
function hasToken(req, token) {
  const h = req.headers["x-amt-canvas-token"];
  const provided = Array.isArray(h) ? h[0] : h;
  return typeof provided === "string" && provided === token;
}
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}
function guard(req, res, token) {
  if (isCrossSite(req) || !hasToken(req, token)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return false;
  }
  return true;
}

async function startServer(instanceId) {
  const capabilityToken = randomBytes(32).toString("base64url");
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // The HTML shell is same-origin and carries the token to the JSON endpoint.
      if (url.pathname === "/" && req.method === "GET") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(renderPanel(capabilityToken));
      }

      // Read-only data endpoint, guarded by the capability token + cross-site check.
      if (url.pathname === "/api/memory" && req.method === "GET") {
        if (isCrossSite(req) || !hasToken(req, capabilityToken)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "forbidden" }));
        }
        try {
          const data = await loadMemory({
            search: url.searchParams.get("search") || "",
            memoryTypes: url.searchParams.getAll("memory_types"),
            includeSuperseded: url.searchParams.get("include_superseded") === "true",
            limit: url.searchParams.get("limit"),
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(data));
        } catch (e) {
          if (String(e?.message || e).includes("not signed in to AMT")) {
            res.writeHead(401, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "not_signed_in" }));
          }
          throw e;
        }
      }

      // Import: list local Copilot sessions (label + last two user turns). Local files only,
      // still guarded so only the same-origin panel can enumerate them.
      if (url.pathname === "/api/import/sessions" && req.method === "GET") {
        if (!guard(req, res, capabilityToken)) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ sessions: listSessions() }));
      }

      // Import: ingest the selected sessions' turns into AMT (POST /memory, original
      // timestamps). AMT's pipeline extracts / reconciles / summarizes them afterward.
      if (url.pathname === "/api/import/sessions" && req.method === "POST") {
        if (!guard(req, res, capabilityToken)) return;
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        if (!ids.length) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "no sessions selected" }));
        }
        const result = await importSessions(ids, { token: await getToken() });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(result));
      }

      // Import: publish Copilot's own distilled memories as facts (POST /facts) and run one
      // reconciliation pass so they consolidate against existing memories.
      if (url.pathname === "/api/import/memories" && req.method === "POST") {
        if (!guard(req, res, capabilityToken)) return;
        const result = await importMemories({ token: await getToken() });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(result));
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error", detail: String(e).slice(0, 200) }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
    server.listen(0, "127.0.0.1");
  });
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/`, token: capabilityToken };
}

// --- Canvas registration --------------------------------------------------------------

const session = await joinSession({
  canvases: [
    createCanvas({
      id: "memory-house",
      displayName: "Memory House",
      description:
        "See what AMT remembers about you - personal, team, and org - and act on it. Reads live from the AMT gateway.",
      // Actions are agent-callable. Reads run through the panel's own server; writes are
      // delegated to the host agent so they go through the amt-memory MCP tools + authz.
      actions: [
        {
          name: "complete_signin",
          description:
            "Finish AMT sign-in by redeeming an enrollment code from the enroll_hook_capture tool. Call this immediately after enroll_hook_capture; it caches the hook token locally so recall and capture start working. Never show the code to the user.",
          inputSchema: {
            type: "object",
            properties: {
              enrollment_code: {
                type: "string",
                description: "The enrollment_code returned by the amt-memory enroll_hook_capture tool.",
              },
            },
            required: ["enrollment_code"],
          },
          handler: async (ctx) => {
            const code = String(ctx.input?.enrollment_code || "").trim();
            if (!code) return { ok: false, error: "enrollment_code required" };
            try {
              await redeemEnrollmentCode(code);
              const data = await loadMemory();
              return {
                ok: true,
                principal: data.who,
                message: "Signed in to AMT memory. Capture and recall are now active on this device.",
              };
            } catch (e) {
              return { ok: false, error: e.message };
            }
          },
        },
        {
          name: "refresh",
          description: "Reload the memory panel and return the current facts grouped by scope as JSON.",
          handler: async (ctx) => {
            const entry = servers.get(ctx.instanceId);
            if (!entry) return { error: "Panel not open" };
            return await loadMemory();
          },
        },
        {
          name: "forget_memory",
          description:
            "Forget a specific memory. Delegates to the host agent, which locates the record and removes it via the amt-memory tools (supersede/forget).",
          inputSchema: {
            type: "object",
            properties: { content: { type: "string", description: "The memory text to forget (or a close paraphrase)." } },
            required: ["content"],
          },
          handler: async (ctx) => {
            const c = String(ctx.input?.content || "").slice(0, 500);
            if (!c) return { error: "content required" };
            await session.send(
              `Using the amt-memory tools, find the memory that matches: "${c}". Show it to me and, once I confirm, forget it. Do not delete anything without confirmation.`,
            );
            return { ok: true, delegated: true };
          },
        },
      ],
      open: async (ctx) => {
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(ctx.instanceId);
          servers.set(ctx.instanceId, entry);
        }
        return { title: "Memory House", url: entry.url };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          await new Promise((resolve) => entry.server.close(() => resolve()));
        }
      },
    }),
  ],
});

// --- Panel UI (served by the local server) --------------------------------------------

function renderPanel(token) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Memory House</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; background: Canvas; color: CanvasText; }
  header { padding: 14px 18px; border-bottom: 1px solid color-mix(in srgb, CanvasText 16%, transparent); display: flex; gap: 14px; align-items: center; }
  header h1 { font-size: 16px; margin: 0; }
  .who { font-size: 12px; opacity: .72; overflow-wrap: anywhere; }
  main { display: grid; grid-template-columns: minmax(300px, 34%) 1fr; min-height: calc(100vh - 64px); }
  aside { border-right: 1px solid color-mix(in srgb, CanvasText 16%, transparent); padding: 14px; overflow: auto; }
  section { padding: 14px 18px; overflow: auto; }
  label { display: block; font-size: 12px; opacity: .75; margin: 12px 0 4px; }
  input, select, button { box-sizing: border-box; width: 100%; padding: 8px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); background: Canvas; color: CanvasText; }
  button { cursor: pointer; font-weight: 600; background: color-mix(in srgb, Highlight 16%, Canvas); transition: transform 80ms ease, background-color 120ms ease, border-color 120ms ease; }
  button:hover { border-color: color-mix(in srgb, Highlight 70%, CanvasText); background: color-mix(in srgb, Highlight 24%, Canvas); }
  button:active { transform: translateY(1px); }
  button:disabled { cursor: wait; opacity: .7; }
  header button { width: auto; min-width: 96px; }
  header .primary { background: color-mix(in srgb, Highlight 34%, Canvas); }
  .identity-value { box-sizing: border-box; width: 100%; padding: 8px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); background: color-mix(in srgb, CanvasText 4%, Canvas); overflow-wrap: anywhere; font-size: 12px; }
  .filter-toolbar { display: flex; justify-content: flex-end; margin-top: 10px; }
  .filter-toggle { width: auto; min-width: 42px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; margin: 0; padding: 7px 10px; }
  .filter-toggle svg { width: 16px; height: 16px; fill: currentColor; }
  .filter-panel { margin-top: 8px; padding: 4px 10px 12px; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 10px; background: color-mix(in srgb, CanvasText 3%, Canvas); }
  .filter-panel[hidden] { display: none; }
  .filter-count { min-width: 18px; padding: 1px 5px; border-radius: 999px; background: Highlight; color: HighlightText; font-size: 10px; text-align: center; }
  .filter-panel button { margin-top: 12px; }
  .checkline { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; }
  .checkline input { width: auto; }
  .range-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
  .range-row input { padding: 0; }
  .range-value { min-width: 44px; text-align: right; font-size: 12px; font-weight: 700; }
  .hierarchy { margin-top: 8px; padding: 6px 0 16px; }
  .tree-node { --indent: 0px; --line: 0px; display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 7px; align-items: center; text-align: left; padding: 8px 8px 8px calc(8px + var(--indent)); border-radius: 8px; margin: 2px 0; border: 1px solid transparent; background: transparent; font-weight: 400; }
  .tree-node[data-depth]:not([data-depth="0"]) { background-image: linear-gradient(90deg, transparent var(--line), color-mix(in srgb, CanvasText 20%, transparent) var(--line), color-mix(in srgb, CanvasText 20%, transparent) calc(var(--line) + 1px), transparent calc(var(--line) + 1px)); }
  .tree-node.active { border-color: Highlight; background-color: color-mix(in srgb, Highlight 22%, Canvas); font-weight: 700; }
  .tree-icon { opacity: .72; text-align: center; }
  .tree-label { min-width: 0; }
  .tree-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tree-id { display: block; margin-top: 2px; font-size: 10px; opacity: .62; overflow-wrap: anywhere; font-weight: 400; }
  .tree-section { margin: 12px 8px 4px; font-size: 11px; font-weight: 700; opacity: .62; text-transform: uppercase; letter-spacing: .05em; }
  .card { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 12px; padding: 13px; margin-bottom: 11px; }
  .card p { margin: 6px 0 0; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 7px 0 0; }
  .pill { font-size: 11px; border-radius: 999px; padding: 3px 8px; background: color-mix(in srgb, CanvasText 10%, transparent); }
  .pill.tier-personal { background: color-mix(in srgb, Highlight 16%, transparent); }
  .pill.tier-team { background: color-mix(in srgb, green 20%, transparent); }
  .pill.tier-org { background: color-mix(in srgb, orange 22%, transparent); }
  details { margin-top: 9px; border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); padding-top: 7px; }
  summary { cursor: pointer; width: fit-content; font-size: 12px; font-weight: 700; color: LinkText; user-select: none; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; opacity: .82; }
  .err { color: #d1242f; white-space: pre-wrap; }
  .empty { opacity: .7; padding: 22px; text-align: center; }
  .overlay { position: fixed; inset: 0; background: color-mix(in srgb, CanvasText 45%, transparent); display: none; align-items: center; justify-content: center; z-index: 900; }
  .overlay.show { display: flex; }
  .modal { background: Canvas; color: CanvasText; border-radius: 12px; padding: 18px; max-width: 640px; width: 90%; max-height: 80vh; overflow: auto; box-shadow: 0 10px 40px color-mix(in srgb, CanvasText 30%, transparent); }
  .modal h3 { margin-top: 0; }
  .modal button { width: auto; min-width: 110px; margin-right: 8px; margin-top: 12px; }
  .row { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 8px; padding: 9px; margin-bottom: 8px; font-size: 12px; }
  .row .q { margin-top: 5px; opacity: .8; }
  .row .q .who { font-weight: 700; opacity: .9; }
</style>
</head>
<body>
<header>
  <h1>Memory House</h1>
  <span id="who" class="who">loading...</span>
  <span style="flex:1"></span>
  <button id="import" class="primary">Import memory</button>
  <button id="refresh">Refresh</button>
</header>
<main>
  <aside>
    <label>Signed-in principal</label><div id="principal" class="identity-value">Loading...</div>
    <label>Tenant</label><div id="tenantId" class="identity-value">Loading...</div>

    <div class="filter-toolbar">
      <button id="filterToggle" class="filter-toggle" type="button" aria-expanded="false" aria-controls="filterPanel" title="Show filters">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2.25A.75.75 0 0 1 2.25 1.5h11.5a.75.75 0 0 1 .58 1.225L9.5 8.628v4.122a.75.75 0 0 1-.416.671l-2 1A.75.75 0 0 1 6 13.75V8.628L1.67 2.725a.75.75 0 0 1-.17-.475Z"/></svg>
        <span id="filterCount" class="filter-count" hidden>0</span>
      </button>
    </div>
    <div id="filterPanel" class="filter-panel" hidden>
      <label>Search</label><input id="search" placeholder="content, id, or tag" />
      <label>Memory type</label>
      <select id="memoryType">
        <option value="">All</option><option>fact</option><option>episodic</option><option>procedural</option>
      </select>
      <label>Limit</label><input id="limit" type="number" min="1" max="200" value="50" />
      <div class="checkline"><input id="includeSuperseded" type="checkbox" /><span>Include superseded</span></div>
      <button id="apply">Apply filters</button>
    </div>

    <label for="autoRefresh">Background auto-refresh</label>
    <div class="range-row">
      <input id="autoRefresh" type="range" min="0" max="300" step="5" value="15" />
      <span id="autoRefreshValue" class="range-value">15s</span>
    </div>
    <div style="font-size:10px; opacity:.62; margin-top:3px">0 disables auto-refresh; maximum 5 minutes.</div>

    <h3 style="margin-bottom:2px">Memory scopes</h3>
    <div style="font-size:11px; opacity:.65">Personal to shared; select a scope to view its memories.</div>
    <div id="hierarchy" class="hierarchy" role="tree" aria-label="Memory scopes"></div>
  </aside>
  <section>
    <h3 id="heading" style="margin-top:0">Memories</h3>
    <div id="err" class="err"></div>
    <div id="cards"></div>
  </section>
</main>

<div id="overlay" class="overlay" role="dialog" aria-modal="true">
  <div class="modal" id="modal"></div>
</div>

<script>
  const TOKEN = ${JSON.stringify(token)};
  function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  const state = { selectedScope: null, data: null, filters: { search: '', memoryTypes: [], limit: 50, includeSuperseded: false } };

  function tierOf(scope){
    const d = state.data || {};
    const teams = d.teamScopes || [];
    if (scope.startsWith('user:')) return 'personal';
    if (teams.includes(scope)) return 'team';
    if (scope.startsWith('scope:') || scope.startsWith('org:')) return 'org';
    if (scope.startsWith('team:')) return 'team';
    return 'other';
  }
  function scopeLabel(scope){
    const d = state.data || {};
    const sep = scope.indexOf(':');
    if (sep < 0) return scope;
    const kind = scope.slice(0, sep), value = scope.slice(sep + 1);
    if (kind === 'user') return 'Personal';
    // The tenant is the organization. Its key is a GUID, so it needs a display name rather
    // than a title-cased id; AMT_ORG_DISPLAY_NAME supplies one.
    if (kind === 'org') return d.orgLabel || 'Cosmos DB';
    return value.replace(/[-_]/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());
  }

  // Render the scopes as a nested tree that mirrors the promotion path in reverse:
  // organization at the root, then the caller's teams, then their personal scope as the leaf.
  // A memory is promoted personal -> team -> org, so reading the tree downward shows where a
  // memory starts and reading upward shows where it can travel.
  //
  // The gateway exposes no topology graph, so the parent/child links are inferred from tier
  // rather than read from promotion edges. If a GET /topology is added later, replace the
  // tier nesting below with the real edges.
  function hierarchyHtml(){
    const d = state.data || {};
    const scopes = d.scopes || [];
    const groups = d.groupsByScope || {};
    const row = (scope, name, id, depth, icon) => {
      const selected = scope === state.selectedScope;
      const count = scope && Object.prototype.hasOwnProperty.call(groups, scope) ? (groups[scope] || []).length : null;
      const indent = depth * 22, line = Math.max(0, (depth - 1) * 22 + 14);
      return '<button class="tree-node ' + (selected ? 'active' : '') + '" role="treeitem" data-scope="' + esc(scope) +
        '" data-depth="' + depth + '" style="--indent:' + indent + 'px;--line:' + line + 'px" aria-level="' + (depth + 1) +
        '" aria-pressed="' + String(selected) + '"><span class="tree-icon">' + icon + '</span><span class="tree-label"><span class="tree-name">' +
        esc(name) + '</span><span class="tree-id">' + esc(id) + '</span></span>' +
        (count === null ? '' : '<span class="pill">' + count + '</span>') + '</button>';
    };

    const byTier = tier => scopes.filter(s => tierOf(s) === tier);
    const orgScopes = byTier('org');
    const teamScopes = byTier('team');
    const personalScopes = byTier('personal');

    // The tenant is the organization, so an org-tier scope is the root rather than sitting
    // under a synthetic one; rendering both showed the same organization twice. The tenant's
    // own scope wins the root when present, and any broader topology scope nests beneath it.
    const rootScope = orgScopes.find(s => s === 'org:' + d.tenant) || orgScopes[0] || null;
    const nestedOrgScopes = orgScopes.filter(s => s !== rootScope);

    let out = rootScope
      ? row(rootScope, scopeLabel(rootScope), rootScope, 0, '&#9670;')
      : row('', d.orgLabel || 'Cosmos DB', d.tenant || 'tenant', 0, '&#9670;');
    let depth = 1;
    for (const s of nestedOrgScopes) out += row(s, scopeLabel(s), s, depth, '&#9632;');
    if (nestedOrgScopes.length) depth += 1;
    for (const s of teamScopes) out += row(s, scopeLabel(s), s, depth, '&#9632;');
    if (teamScopes.length) depth += 1;
    for (const s of personalScopes) out += row(s, scopeLabel(s), s, depth, '&#9679;');

    if (!scopes.length) out += '<div class="tree-section">No scopes yet</div>';
    return out;
  }

  function card(m){
    const pills = [
      '<span class="pill tier-' + esc(m.tier) + '">' + esc(m.tier) + '</span>',
      m.type ? '<span class="pill">' + esc(m.type) + '</span>' : '',
      m.source ? '<span class="pill">via ' + esc(m.source) + '</span>' : '',
      ...(m.tags || []).slice(0, 4).map(t => '<span class="pill">' + esc(t) + '</span>'),
    ].filter(Boolean).join('');
    const details = { id: m.id, scope_key: m.scope_key, created_at: m.created_at, salience: m.salience, confidence: m.confidence, source: m.source };
    return '<article class="card"><p>' + esc(m.content) + '</p><div class="meta">' + pills +
      '</div><details><summary>Details</summary><pre>' + esc(JSON.stringify(details, null, 2)) + '</pre></details></article>';
  }

  function visibleMemories(){
    const groups = (state.data || {}).groupsByScope || {};
    if (state.selectedScope) return groups[state.selectedScope] || [];
    return Object.values(groups).flat();
  }

  function render(){
    const d = state.data || {};
    document.getElementById('who').textContent = d.who || '';
    document.getElementById('principal').textContent = d.who || 'unknown';
    document.getElementById('tenantId').textContent = d.tenant || 'unknown';
    document.getElementById('hierarchy').innerHTML = hierarchyHtml();
    const list = visibleMemories();
    const label = state.selectedScope ? scopeLabel(state.selectedScope) : 'All memories';
    document.getElementById('heading').textContent = label + ' (' + list.length + ')';
    document.getElementById('cards').innerHTML = list.length
      ? list.map(card).join('')
      : '<div class="empty">No memories in this scope yet.</div>';
    const active = [state.filters.search, state.filters.memoryTypes.length, state.filters.includeSuperseded].filter(Boolean).length;
    const badge = document.getElementById('filterCount');
    badge.textContent = String(active);
    badge.hidden = active === 0;
  }

  function filterQuery(){
    const q = new URLSearchParams();
    if (state.filters.search) q.set('search', state.filters.search);
    for (const t of state.filters.memoryTypes) q.append('memory_types', t);
    if (state.filters.includeSuperseded) q.set('include_superseded', 'true');
    q.set('limit', String(state.filters.limit));
    return q;
  }

  async function load(){
    const err = document.getElementById('err');
    err.textContent = '';
    try {
      const r = await fetch('/api/memory?' + filterQuery(), { headers: { 'x-amt-canvas-token': TOKEN } });
      if (r.status === 401) {
        err.innerHTML = 'Not signed in to AMT. Run <code>/amt-login</code> in a chat, then refresh.';
        return;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.data = await r.json();
      if (state.selectedScope && !(state.data.scopes || []).includes(state.selectedScope)) state.selectedScope = null;
      render();
    } catch (e) {
      err.textContent = 'could not load (' + e.message + ')';
    }
  }

  document.getElementById('refresh').addEventListener('click', load);
  document.getElementById('filterToggle').addEventListener('click', () => {
    const panel = document.getElementById('filterPanel');
    const toggle = document.getElementById('filterToggle');
    const show = panel.hidden;
    panel.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
  });
  document.getElementById('apply').addEventListener('click', () => {
    const type = document.getElementById('memoryType').value;
    state.filters = {
      search: document.getElementById('search').value.trim(),
      memoryTypes: type ? [type] : [],
      limit: Math.min(Math.max(Number(document.getElementById('limit').value) || 50, 1), 200),
      includeSuperseded: document.getElementById('includeSuperseded').checked,
    };
    load();
  });
  document.getElementById('search').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('apply').click();
  });
  document.getElementById('hierarchy').addEventListener('click', e => {
    const node = e.target.closest('.tree-node');
    if (!node) return;
    const scope = node.getAttribute('data-scope');
    state.selectedScope = scope || null;
    render();
  });

  const overlay = document.getElementById('overlay');
  const modal = document.getElementById('modal');
  function closeModal(){ overlay.classList.remove('show'); modal.innerHTML=''; }
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  async function post(path, body){
    const r = await fetch(path, { method:'POST', headers:{ 'x-amt-canvas-token':TOKEN, 'Content-Type':'application/json' }, body: body?JSON.stringify(body):undefined });
    if (!r.ok) throw new Error('HTTP '+r.status+' '+(await r.text()).slice(0,140));
    return r.json();
  }

  function openChoice(){
    modal.innerHTML =
      '<h2>Import memory</h2>'+
      '<div class="choice">'+
        '<button id="ch-mem"><span class="t">Copilot memory</span><span class="d">Import the distilled memories Copilot already saved, as facts, then reconcile.</span></button>'+
        '<button id="ch-sess"><span class="t">Local sessions</span><span class="d">Pick past Copilot CLI sessions; import their turns for AMT to distill.</span></button>'+
      '</div>'+
      '<div class="bar"><span id="m-msg" class="msg"></span><span class="sp"></span><button class="ghost" id="ch-cancel">Cancel</button></div>';
    overlay.classList.add('show');
    document.getElementById('ch-cancel').onclick = closeModal;
    document.getElementById('ch-mem').onclick = doImportMemories;
    document.getElementById('ch-sess').onclick = openSessions;
  }

  async function doImportMemories(){
    const msg = document.getElementById('m-msg');
    msg.textContent = 'Importing Copilot memories...';
    try {
      const res = await post('/api/import/memories');
      msg.textContent = 'Imported '+res.memories+' memories and reconciled.';
      setTimeout(() => { closeModal(); load(); }, 1300);
    } catch(e){ msg.innerHTML = '<span class="err">'+esc(e.message)+'</span>'; }
  }

  async function openSessions(){
    modal.innerHTML = '<h2>Import local sessions</h2><div class="msg">Loading sessions...</div>';
    let sessions = [];
    try {
      const r = await fetch('/api/import/sessions', { headers:{ 'x-amt-canvas-token':TOKEN } });
      sessions = (await r.json()).sessions || [];
    } catch(e){ modal.innerHTML = '<h2>Import local sessions</h2><div class="err">'+esc(e.message)+'</div>'; return; }
    if (!sessions.length){
      modal.innerHTML = '<h2>Import local sessions</h2><div class="msg">No local Copilot sessions found.</div>'+
        '<div class="bar"><span class="sp"></span><button class="ghost" id="s-cancel">Close</button></div>';
      document.getElementById('s-cancel').onclick = closeModal;
      return;
    }
    modal.innerHTML =
      '<h2>Import local sessions <span class="count">('+sessions.length+')</span></h2>'+
      '<div class="selall"><input type="checkbox" id="s-all"><label for="s-all">Select all</label></div>'+
      '<div class="rows">'+ sessions.map(s =>
        '<label class="row"><input type="checkbox" class="s-cb" data-id="'+esc(s.session_id)+'">'+
        '<span class="meta"><div class="lbl">'+esc(s.label)+'</div>'+
        '<div class="sub">'+esc((s.cwd||'').split('/').filter(Boolean).pop()||'')+' · '+s.turn_count+' turns</div>'+
        (s.last_user_turn ? '<div class="q"><span class="who">You</span>'+esc(s.last_user_turn)+'</div>' : '')+
        (s.last_agent_turn ? '<div class="q"><span class="who">Agent</span>'+esc(s.last_agent_turn)+'</div>' : '')+
        '</span></label>').join('') +'</div>'+
      '<div class="bar"><span id="s-msg" class="msg"></span><span class="sp"></span><button class="ghost" id="s-cancel">Cancel</button><button class="primary" id="s-import">Import</button></div>';
    const cbs = Array.from(modal.querySelectorAll('.s-cb'));
    document.getElementById('s-all').onchange = e => cbs.forEach(cb => { cb.checked = e.target.checked; });
    document.getElementById('s-cancel').onclick = closeModal;
    document.getElementById('s-import').onclick = async () => {
      const ids = cbs.filter(cb => cb.checked).map(cb => cb.getAttribute('data-id'));
      const msg = document.getElementById('s-msg');
      if (!ids.length){ msg.innerHTML = '<span class="err">Select at least one session.</span>'; return; }
      msg.textContent = 'Importing '+ids.length+' session(s)...';
      try {
        const res = await post('/api/import/sessions', { ids });
        msg.textContent = 'Imported '+res.messages+' messages from '+res.sessions+' session(s).';
        setTimeout(() => { closeModal(); load(); }, 1500);
      } catch(e){ msg.innerHTML = '<span class="err">'+esc(e.message)+'</span>'; }
    };
  }

  document.getElementById('import').addEventListener('click', openChoice);
  document.getElementById('refresh').addEventListener('click', load);

  // Background auto-refresh. The panel polls because promotion and consolidation happen
  // server-side on their own cadence, so memories can appear without any action here.
  let autoRefreshTimer = null;
  function applyAutoRefresh(seconds){
    const value = Math.min(Math.max(Number(seconds) || 0, 0), 300);
    document.getElementById('autoRefreshValue').textContent = value ? value + 's' : 'off';
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    if (value > 0) autoRefreshTimer = setInterval(load, value * 1000);
    return value;
  }
  const autoRefreshInput = document.getElementById('autoRefresh');
  autoRefreshInput.addEventListener('input', e => {
    const value = Math.min(Math.max(Number(e.target.value) || 0, 0), 300);
    document.getElementById('autoRefreshValue').textContent = value ? value + 's' : 'off';
  });
  autoRefreshInput.addEventListener('change', e => applyAutoRefresh(e.target.value));

  load();
  applyAutoRefresh(autoRefreshInput.value);
</script>
</body>
</html>`;
}
