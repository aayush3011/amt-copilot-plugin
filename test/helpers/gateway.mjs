import { createServer } from "node:http";

const MEMORY_TYPES = ["fact", "episodic", "procedural"];
const LISTING_PARAMETERS = new Set(["page_size", "cursor", "memory_types", "include_superseded"]);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validThread = value => typeof value === "string" && value.trim() !== ""
  && Buffer.byteLength(value) <= 256 && !/[/\\?#\u0000-\u001f]/.test(value);

// Mirrors the AMT request models behind the gateway: unknown fields are rejected, as with extra="forbid".
function validCapture(body) {
  return isObject(body) && Object.keys(body).every(key => ["extract", "thread_id", "items"].includes(key))
    && (body.extract === undefined || body.extract === true) && validThread(body.thread_id)
    && Array.isArray(body.items) && body.items.length >= 1 && body.items.length <= 50
    && body.items.every(item => isObject(item) && Object.keys(item).every(key => ["role", "content", "source"].includes(key))
      && ["user", "agent", "assistant"].includes(item.role) && typeof item.content === "string" && item.content.trim() !== "")
    && Buffer.byteLength(JSON.stringify(body)) <= 256 * 1024;
}

function validSearch(body) {
  return isObject(body) && Object.keys(body).every(key => ["query", "top_k"].includes(key))
    && typeof body.query === "string" && body.query.trim() !== "" && [...body.query].length <= 16384
    && (body.top_k === undefined || (Number.isInteger(body.top_k) && body.top_k >= 1 && body.top_k <= 50));
}

// AMT POST /memory: extraction turns, or direct facts (no thread or role) that are embedded synchronously.
function validInsertion(body) {
  if (body?.extract === false) {
    return Object.keys(body).every(key => ["extract", "items"].includes(key))
      && Array.isArray(body.items) && body.items.length >= 1 && body.items.length <= 50
      && body.items.every(item => isObject(item) && Object.keys(item).every(key => ["content", "source"].includes(key))
        && typeof item.content === "string" && item.content.trim() !== "")
      && Buffer.byteLength(JSON.stringify(body)) <= 256 * 1024;
  }
  return validCapture(body) && body.extract === true;
}

export async function mockGateway(t, options = {}) {
  const state = {
    requests: [],
    turns: [],
    memories: [{ id: "fixture-memory", scope_key: "user:fixture", type: "fact", memory_type: "fact", content: "The developer prefers concise TypeScript examples.", score: 0.95 }],
    accessTokens: new Set(),
    refreshTokens: new Set(),
    counter: 0,
    captureStatus: 201,
    revokeStatus: 204,
    listingStatus: 200,
    listingResponse: null,
    cursors: new Map(),
    whoami: { principal: "user:fixture", tenant_id: "tenant-fixture", agent_id: null, groups: [], roles: [], read_scopes: ["user:fixture"] },
    whoamiStatus: 200,
    nodes: [],
    reachStatus: 200,
    insertions: [],
    insertStatus: null,
    idempotent: new Map(),
    reconciles: 0,
  };
  function grant(expiresIn = 3600) {
    const n = ++state.counter;
    const access = `fixture-access-${n}`;
    const refresh = `fixture-refresh-${n}`;
    state.accessTokens.add(access);
    state.refreshTokens.add(refresh);
    return {
      access_token: access, refresh_token: refresh, token_type: "HookToken",
      expires_in: expiresIn, refresh_expires_in: 86400,
    };
  }
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk.toString("utf8");
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; }
    catch {
      res.writeHead(400).end();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    state.requests.push({ path, method: req.method, query: [...url.searchParams], body, authorization: req.headers.authorization, headers: req.headers });
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    if (path === "/inference/memory/hook/redeem") {
      return body?.enrollment_code === "fixture-enrollment"
        ? send(200, grant(options.initialExpiresIn || 3600))
        : send(401, { error: "invalid_enrollment" });
    }
    if (path === "/inference/memory/hook/refresh") {
      if (!state.refreshTokens.delete(body?.refresh_token)) return send(401, { error: "invalid_grant" });
      return send(200, grant());
    }
    if (path === "/inference/memory/hook/revoke") {
      if (state.revokeStatus !== 204) return send(state.revokeStatus, { error: "fixture-provider-secret" });
      state.refreshTokens.delete(body?.refresh_token);
      return send(204);
    }
    if (path === "/inference/memory/mcp/") {
      // Like the gateway: an Entra token, or the plugin's hook token sent by Claude and Codex header helpers.
      const hookToken = req.headers.authorization?.replace(/^HookToken /, "");
      if (req.headers.authorization !== "Bearer fixture-entra" && !state.accessTokens.has(hookToken)) {
        return send(401, { error: "unauthorized" });
      }
      if (body?.method === "notifications/initialized") return send(202);
      let result;
      if (body?.method === "initialize") {
        result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
        res.setHeader("Mcp-Session-Id", "fixture-session");
      } else if (body?.method === "tools/list") {
        result = { tools: ["search_memories", "enroll_hook_capture"].map(name => ({ name, inputSchema: { type: "object" } })) };
      } else if (body?.method === "tools/call" && body?.params?.name === "enroll_hook_capture") {
        result = { content: [{ type: "text", text: JSON.stringify({ enrollment_code: "fixture-enrollment" }) }] };
      } else return send(400, { error: "unsupported_rpc" });
      const rpc = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`);
      } else send(200, rpc);
      return;
    }
    const token = req.headers.authorization?.replace(/^HookToken /, "");
    if (!state.accessTokens.has(token)) return send(401, { error: "unauthorized" });
    if (path === "/inference/memory/memories" && req.method === "GET") {
      if (state.listingStatus !== 200) return send(state.listingStatus, { error: "fixture-provider-secret" });
      const pageSize = url.searchParams.has("page_size") ? Number(url.searchParams.get("page_size")) : 10;
      const types = url.searchParams.getAll("memory_types");
      if ([...url.searchParams.keys()].some(key => !LISTING_PARAMETERS.has(key))
        || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50 || types.some(type => !MEMORY_TYPES.includes(type))) {
        return send(422, { code: "invalid_request" });
      }
      if (state.listingResponse !== null) return send(200, state.listingResponse);
      const superseded = url.searchParams.get("include_superseded") === "true";
      // Like AMT, a cursor is valid only with the page size and filters that produced it.
      const binding = JSON.stringify([pageSize, [...new Set(types)].sort(), superseded]);
      let offset = 0;
      if (url.searchParams.has("cursor")) {
        const position = state.cursors.get(url.searchParams.get("cursor"));
        if (!position || position.binding !== binding) return send(422, { code: "invalid_cursor" });
        offset = position.offset;
      }
      const matching = state.memories.filter(item =>
        (!types.length || types.includes(item.memory_type ?? item.type)) && (superseded || !item.superseded_by));
      const items = matching.slice(offset, offset + pageSize);
      let cursor = null;
      if (offset + pageSize < matching.length) {
        cursor = `fixture-cursor-${state.cursors.size + 1}`;
        state.cursors.set(cursor, { binding, offset: offset + pageSize });
      }
      return send(200, { items, count: items.length, next_cursor: cursor, has_more: cursor !== null });
    }
    if (path === "/inference/memory/hook/capture") {
      if (state.captureStatus >= 300) return send(state.captureStatus, { error: "unavailable" });
      if (!validCapture(body)) return send(422, { code: "invalid_request" });
      const created = new Date().toISOString();
      const results = body.items.map((item, index) => {
        state.turns.push({ thread_id: body.thread_id, role: item.role, content: item.content });
        return { index, id: `fixture-turn-${state.turns.length}`, status: "stored" };
      });
      return send(state.captureStatus, {
        request_id: `fixture-request-${state.requests.length}`, kind: "insert", status: "succeeded",
        created_at: created, completed_at: created, deadline_at: Date.now() / 1000 + 30, attempts: 1,
        result: { items: results, count: results.length, succeeded: results.length, failed: 0, unknown: 0 },
      });
    }
    if (path === "/inference/memory/hook/search") {
      if (!validSearch(body)) return send(422, { code: "invalid_request" });
      const items = state.memories.slice(0, body.top_k ?? 10);
      return send(200, { items, count: items.length });
    }
    if (path === "/inference/memory/whoami" && req.method === "GET") {
      return state.whoamiStatus === 200 ? send(200, state.whoami) : send(state.whoamiStatus, { error: "fixture-provider-secret" });
    }
    if (path === "/inference/memory/v1/me/reach" && req.method === "GET") {
      if (state.reachStatus !== 200) return send(state.reachStatus, { error: "fixture-provider-secret" });
      return send(200, { nodes: state.nodes, principals_resolved_at: new Date().toISOString(), version: 1 });
    }
    if (path === "/inference/memory/memory" && req.method === "POST") {
      const key = req.headers["idempotency-key"];
      if (key !== undefined && (typeof key !== "string" || !key || key.length > 256)) return send(422, { code: "invalid_request" });
      if (key && state.idempotent.has(key)) {
        const prior = state.idempotent.get(key);
        if (prior.raw !== raw) return send(409, { code: "idempotency_conflict" });
        return send(prior.status, prior.value);
      }
      if (state.insertStatus) return send(state.insertStatus, { error: "fixture-provider-secret" });
      if (!validInsertion(body)) return send(422, { code: "invalid_request" });
      state.insertions.push({ body, key });
      const created = new Date().toISOString();
      const envelope = { request_id: `fixture-request-${state.requests.length}`, kind: "insert", created_at: created, attempts: 1 };
      const value = body.extract === false
        ? { ...envelope, status: "succeeded", completed_at: created,
          result: { items: body.items.map((_, index) => ({ index, id: `fixture-fact-${state.insertions.length}-${index}`, status: "stored" })),
            count: body.items.length, succeeded: body.items.length, failed: 0, unknown: 0 } }
        : { ...envelope, status: "queued" };
      const status = body.extract === false ? 201 : 202;
      if (key) state.idempotent.set(key, { raw, status, value });
      return send(status, value);
    }
    if (path === "/inference/memory/reconcile" && req.method === "POST") {
      if (!isObject(body) || Object.keys(body).some(key => key !== "recent_k")) return send(422, { code: "invalid_request" });
      state.reconciles += 1;
      return send(202, { request_id: `fixture-reconcile-${state.reconciles}`, kind: "reconcile", status: "queued" });
    }
    return send(404, { error: "not_found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    state,
    base: `http://127.0.0.1:${server.address().port}/inference/memory`,
  };
}
