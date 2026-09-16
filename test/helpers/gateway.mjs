import { createServer } from "node:http";

export async function mockGateway(t, options = {}) {
  const state = {
    requests: [],
    turns: [],
    memories: [{ id: "fixture-memory", scope_key: "user:fixture", type: "fact", content: "The developer prefers concise TypeScript examples.", similarity_score: 0.95 }],
    accessTokens: new Set(),
    refreshTokens: new Set(),
    counter: 0,
    captureStatus: 200,
    revokeStatus: 204,
    listingStatus: 200,
    listingResponse: null,
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
      if (req.headers.authorization !== "Bearer fixture-entra") return send(401, { error: "unauthorized" });
      if (body?.method === "notifications/initialized") return send(202);
      let result;
      if (body?.method === "initialize") {
        result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
        res.setHeader("Mcp-Session-Id", "fixture-session");
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
      if (state.listingResponse !== null) return send(200, state.listingResponse);
      const count = Number(url.searchParams.get("recent_k"));
      const types = url.searchParams.getAll("memory_types");
      const scopes = url.searchParams.getAll("scopes");
      const matching = state.memories.filter(item =>
        (!types.length || types.includes(item.memory_type ?? item.type))
        && (!scopes.length || scopes.includes(item.scope_key))
        && (url.searchParams.get("include_superseded") === "true" || !item.superseded_by));
      const items = matching.slice(0, count);
      return send(200, { items, count: items.length, truncated: matching.length > count });
    }
    if (path === "/inference/memory/hook/capture") {
      if (state.captureStatus !== 200) return send(state.captureStatus, { error: "unavailable" });
      state.turns.push(body);
      return send(200, { accepted: true });
    }
    if (path === "/inference/memory/hook/search") return send(200, { items: state.memories });
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
