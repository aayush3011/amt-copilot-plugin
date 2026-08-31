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

function tierOf(scopeKey = "") {
  if (scopeKey.startsWith("user:")) return "personal";
  if (scopeKey.startsWith("team:")) return "team";
  if (scopeKey.startsWith("org:")) return "org";
  return "other";
}

// Build the three-tier view the panel renders. Personal comes from the recent-memories
// list; team/org come from scoped searches (the only shared-read surface today).
async function loadMemory() {
  const who = await amt("/whoami").catch(() => null);
  const orgScope = who && who.tenant_id ? `org:${who.tenant_id}` : null;
  const teamScopes = ((who && who.groups) || []).map((g) => (g.startsWith("team:") ? g : `team:${g}`));
  const sharedScopes = [...teamScopes, ...(orgScope ? [orgScope] : [])];

  const personal = await amt("/memories?recent_k=30").catch(() => ({ items: [] }));
  const shared = sharedScopes.length
    ? await amt("/search", {
        method: "POST",
        body: { query: "team and organization knowledge, standards, and decisions", top_k: 25, scopes: sharedScopes },
      }).catch(() => ({ items: [] }))
    : { items: [] };

  const groups = { personal: [], team: [], org: [] };
  for (const it of personal.items || []) {
    if (tierOf(it.scope_key) === "personal") groups.personal.push(shape(it));
  }
  for (const it of shared.items || []) {
    const t = tierOf(it.scope_key);
    if (t === "team" || t === "org") groups[t].push(shape(it));
  }
  return { who: who.principal, tenant: who.tenant_id, groups };
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
        const data = await loadMemory();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(data));
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
  button.primary { background:#0969da; color:#fff; border:1px solid #0969da; border-radius:6px; padding:5px 12px; }
  button.ghost { background:transparent; border:1px solid rgba(128,128,128,0.4); border-radius:6px; padding:5px 12px; }
  .overlay { position:fixed; inset:0; background:rgba(0,0,0,0.45); display:none; align-items:center; justify-content:center; z-index:10; }
  .overlay.show { display:flex; }
  .modal { background:Canvas; color:CanvasText; border:1px solid rgba(128,128,128,0.35); border-radius:10px; padding:16px; width:min(680px,92vw); max-height:82vh; overflow:auto; box-shadow:0 12px 40px rgba(0,0,0,0.45); }
  .modal h2 { font-size:14px; margin:0 0 12px; }
  .choice { display:flex; gap:10px; }
  .choice button { flex:1; text-align:left; padding:14px; border-radius:8px; border:1px solid rgba(128,128,128,0.35); background:rgba(128,128,128,0.06); }
  .choice .t { font-weight:600; display:block; margin-bottom:4px; }
  .choice .d { opacity:0.65; font-size:12px; }
  .selall { display:flex; gap:8px; align-items:center; padding:6px 8px; border-bottom:1px solid rgba(128,128,128,0.2); margin-bottom:6px; }
  .rows { margin:6px 0; }
  .row { display:flex; gap:8px; padding:8px; border-radius:6px; align-items:flex-start; cursor:pointer; }
  .row:hover { background:rgba(128,128,128,0.08); }
  .row .meta { flex:1; min-width:0; }
  .row .lbl { font-weight:600; }
  .row .sub { opacity:0.6; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .row .q { opacity:0.75; font-size:12px; margin-top:3px; display:flex; gap:6px; align-items:baseline; }
  .row .q .who { flex:0 0 38px; font-size:10px; text-transform:uppercase; letter-spacing:0.04em; opacity:0.55; }
  .bar { display:flex; align-items:center; gap:10px; margin-top:12px; }
  .bar .sp { flex:1; }
  .msg { font-size:12px; opacity:0.85; }
</style>
</head>
<body>
  <header>
    <h1>AMT Memory</h1>
    <span id="who" class="who">loading...</span>
    <span style="flex:1"></span>
    <button id="import" class="primary">Import memory</button>
    <button id="refresh">Refresh</button>
  </header>
  <div class="cols">
    <div class="col"><h2>Personal <span id="c-personal" class="count"></span></h2><ul id="personal"></ul></div>
    <div class="col"><h2>Team <span id="c-team" class="count"></span></h2><ul id="team"></ul></div>
    <div class="col"><h2>Org <span id="c-org" class="count"></span></h2><ul id="org"></ul></div>
  </div>

  <div id="overlay" class="overlay" role="dialog" aria-modal="true">
    <div class="modal" id="modal"></div>
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
      document.getElementById('who').textContent = d.who + ' · ' + d.tenant;
      fill('personal', d.groups.personal || []);
      fill('team', d.groups.team || []);
      fill('org', d.groups.org || []);
    } catch (e) {
      document.getElementById('who').innerHTML = '<span class="err">could not load ('+esc(e.message)+') - run /amt-login?</span>';
    }
  }
  // --- Import memory flow ---------------------------------------------------------------
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
  load();
  setInterval(load, 15000);
</script>
</body>
</html>`;
}
