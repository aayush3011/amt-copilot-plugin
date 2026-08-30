// Extension: amt-memory-canvas
// A "Memory" panel for the GitHub Copilot app. Shows what AMT remembers about the
// signed-in developer, grouped by Personal / Team / Org scope, and lets them act on it.
//
// Architecture (mirrors github/awesome-copilot canvas extensions):
//   - joinSession() + createCanvas() register the canvas with the host.
//   - The extension runs a local node:http server that serves the panel HTML and a small
//     read-only JSON API the page polls. A per-server capability token guards every
//     request so a cross-site/rebinding caller cannot reach the socket.
//   - Reads come straight from the AMT REST API over the IP gateway, using a delegated
//     token from `az` (same identity path as the plugin hooks). This is demo-grade; the
//     productized token path is shared with amt-token.sh (see plugin/README.md).
//   - Write actions (forget / promote) do NOT call AMT directly. They use
//     session.send(...) to ask the host agent to run the amt-memory MCP tools, so they
//     reuse the plugin's existing OAuth sign-in and the server-side authz. (forget /
//     promote REST endpoints do not exist yet; see Docs/amt-plugin-design-sketch.md.)

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const GATEWAY_BASE =
  process.env.AMT_GATEWAY_BASE ||
  "https://reranker-api-h2b5czhkfkcphnf4.westus3-01.azurewebsites.net/inference/memory";
const TOKEN_RESOURCE =
  process.env.AMT_TOKEN_RESOURCE || "api://45cdeed7-4e4e-481d-9f00-6708c0631565";

// One local server per open canvas instance.
const servers = new Map();

// --- AMT access -----------------------------------------------------------------------

// Delegated gateway token via the Azure CLI (demo-grade; expires ~1h). Shared identity
// path with the plugin's amt-token.sh.
function getToken() {
  return new Promise((resolve, reject) => {
    execFile(
      "az",
      ["account", "get-access-token", "--resource", TOKEN_RESOURCE, "--query", "accessToken", "--output", "tsv"],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return reject(new Error("az token failed; run 'az login'"));
        const t = String(stdout).trim();
        t ? resolve(t) : reject(new Error("empty token"));
      },
    );
  });
}

async function amt(path, { method = "GET", body } = {}) {
  const token = await getToken();
  const res = await fetch(`${GATEWAY_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`AMT ${method} ${path} -> ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function tierOf(scopeKey = "") {
  if (scopeKey.startsWith("user:")) return "personal";
  if (scopeKey.startsWith("team:")) return "team";
  if (scopeKey.startsWith("org:")) return "org";
  return "other";
}

// Build the three-tier view the panel renders. Personal comes from the recent-memories
// list; team/org come from scoped searches (the only shared-read surface today).
async function loadMemory() {
  const who = await amt("/whoami");
  const orgScope = `org:${who.tenant_id}`;
  const teamScopes = (who.groups || []).map((g) => (g.startsWith("team:") ? g : `team:${g}`));

  const personal = await amt("/memories?recent_k=30").catch(() => ({ items: [] }));
  const shared = await amt("/search", {
    method: "POST",
    body: { query: "team and organization knowledge, standards, and decisions", top_k: 25, scopes: [...teamScopes, orgScope] },
  }).catch(() => ({ items: [] }));

  const groups = { personal: [], team: [], org: [] };
  for (const it of personal.items || []) {
    if (tierOf(it.scope_key) === "personal") groups.personal.push(shape(it));
  }
  for (const it of shared.items || []) {
    const t = tierOf(it.scope_key);
    if (t === "team" || t === "org") groups[t].push(shape(it));
  }
  const teams = (who.groups || []).map((g) => g.replace(/^team:/, ""));
  return { who: who.principal, tenant: who.tenant_id, teams, groups };
}

function shape(it) {
  return {
    id: it.id,
    scope_key: it.scope_key,
    type: it.memory_type || it.type,
    content: it.content || it.text || "",
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
        const data = await loadMemory();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(data));
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
      id: "amt-memory",
      displayName: "AMT Memory",
      description:
        "See what AMT remembers about you - personal, team, and org - and act on it. Reads live from the AMT gateway.",
      // Actions are agent-callable. Reads run through the panel's own server; writes are
      // delegated to the host agent so they go through the amt-memory MCP tools + authz.
      actions: [
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
        {
          name: "promote_memory",
          description:
            "Promote a personal memory to a shared team or org scope. Delegates to the host agent to run the promotion via the amt-memory tools.",
          inputSchema: {
            type: "object",
            properties: {
              content: { type: "string", description: "The personal memory text to promote." },
              to_scope: { type: "string", description: "Target scope, e.g. team:inference-memory or org:<tenant>." },
            },
            required: ["content", "to_scope"],
          },
          handler: async (ctx) => {
            const c = String(ctx.input?.content || "").slice(0, 500);
            const to = String(ctx.input?.to_scope || "").slice(0, 200);
            if (!c || !to) return { error: "content and to_scope required" };
            await session.send(
              `Using the amt-memory tools, promote this personal memory to ${to}: "${c}". Confirm the target scope with me first if it is not one I belong to.`,
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
        return { title: "AMT Memory", url: entry.url };
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
  // The page fetches /api/memory with the capability token and renders three columns.
  // Kept dependency-free: one file, inline styles and script.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AMT Memory</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 13px/1.45 -apple-system, Segoe UI, sans-serif; margin: 0; padding: 12px; }
  header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
  h1 { font-size: 15px; margin: 0; }
  .who { opacity: 0.6; font-size: 12px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  .col { border: 1px solid rgba(128,128,128,0.25); border-radius: 8px; padding: 8px; min-height: 80px; }
  .col h2 { font-size: 12px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
  .count { opacity: 0.5; font-weight: normal; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 6px 8px; border-radius: 6px; margin-bottom: 5px; background: rgba(128,128,128,0.08); }
  .tag { font-size: 10px; opacity: 0.55; }
  .empty { opacity: 0.5; font-style: italic; }
  .err { color: #c00; }
  button { font: inherit; cursor: pointer; }
</style>
</head>
<body>
  <header>
    <h1>AMT Memory</h1>
    <span id="who" class="who">loading...</span>
    <span style="flex:1"></span>
    <button id="refresh">Refresh</button>
  </header>
  <div class="cols">
    <div class="col"><h2>Personal <span id="c-personal" class="count"></span></h2><ul id="personal"></ul></div>
    <div class="col"><h2>Team <span id="c-team" class="count"></span></h2><ul id="team"></ul></div>
    <div class="col"><h2>Org <span id="c-org" class="count"></span></h2><ul id="org"></ul></div>
  </div>
<script>
  const TOKEN = ${JSON.stringify(token)};
  function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  function fill(id, items){
    const ul = document.getElementById(id);
    document.getElementById('c-'+id).textContent = items.length ? '('+items.length+')' : '';
    if (!items.length){ ul.innerHTML = '<li class="empty">nothing yet</li>'; return; }
    ul.innerHTML = items.map(it =>
      '<li>'+esc(it.content)+' <span class="tag">'+esc(it.type||'')+'</span></li>').join('');
  }
  async function load(){
    try {
      const r = await fetch('/api/memory', { headers: { 'x-amt-canvas-token': TOKEN } });
      if (!r.ok) throw new Error('HTTP '+r.status);
      const d = await r.json();
      const idParts = [d.who];
      if (Array.isArray(d.teams) && d.teams.length) idParts.push('team: ' + d.teams.join(', '));
      idParts.push('org: ' + d.tenant);
      document.getElementById('who').textContent = idParts.join(' · ');
      fill('personal', d.groups.personal || []);
      fill('team', d.groups.team || []);
      fill('org', d.groups.org || []);
    } catch (e) {
      document.getElementById('who').innerHTML = '<span class="err">could not load ('+esc(e.message)+') - is az signed in?</span>';
    }
  }
  document.getElementById('refresh').addEventListener('click', load);
  load();
  setInterval(load, 15000);
</script>
</body>
</html>`;
}
