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

// POST /memory: captured or imported turns for extraction, or direct facts (no thread or role).
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
    // Like the gateway, data routes and the MCP endpoint each accept only their own audience.
    accessTokens: new Set(['fixture-access-1']),
    mcpAccessTokens: new Set(['fixture-mcp-access-1']),
    // The unauthenticated 401 challenge that names the gateway tenant; null omits the header.
    challenge: 'Bearer authorization_uri="https://login.microsoftonline.com/33333333-3333-3333-3333-333333333333"',
    captureStatus: 201,
    captureDelayMs: 0,
    // A problem+json error for every capture, such as { status: 409, code: "reset_in_progress", retry_after: 5 }.
    captureProblem: null,
    // Captures whose turns contain this text get a conflict raised before the request finishes (409 problem+json).
    conflictContent: null,
    // Turns that contain this text fail to store, like the engine's failed writes. A request that stored none
    // finishes as failed with no error of its own: the gateway answers with the request's record (503). One
    // that stored some is partial (207). Either result is replayed for the same Idempotency-Key.
    failContent: null,
    listingStatus: 200,
    listingResponse: null,
    cursors: new Map(),
    whoami: { principal: "user:fixture", tenant_id: "tenant-fixture", agent_id: null, groups: [], roles: [], read_spaces: ["user:fixture"] },
    whoamiStatus: 200,
    // Learning Spaces served by GET /v1/spaces/{id}.
    spaces: [],
    spaceStatus: 200,
    insertions: [],
    insertStatus: null,
    idempotent: new Map(),
    reconciles: 0,
    telemetry: { available: true, enrolled: true, state: "default_on", epoch: 0, notice_version: null,
      current_notice_version: "2026-11-06.3", policy_version: "2026-11-06.3", enrolled_at: null,
      invitation_policy: { version: "inv-2026-11-06.1", enabled: true, sample_rate: 0.1, sample_threshold: "19999999" },
      opted_out_at: null, retention_days: 60, feedback_retention_days: 60, deletion: null },
    telemetryEvents: [],
    telemetryDelayMs: 0,
    retrievals: new Map(),
    reviewDetails: new Map(),
    feedbackEvents: new Map(),
  };
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
    const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
    const accepted = path === "/inference/memory/mcp/" ? state.mcpAccessTokens : state.accessTokens;
    if (!accepted.has(token)) {
      if (state.challenge !== null) res.setHeader("WWW-Authenticate", state.challenge);
      return send(401, { error: "unauthorized" });
    }
    if (path === "/inference/memory/mcp/") {
      if (body?.method === "notifications/initialized") return send(202);
      let result;
      if (body?.method === "initialize") {
        result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
        res.setHeader("Mcp-Session-Id", "fixture-session");
      } else if (body?.method === "tools/list") {
        result = { tools: ["search_memories"].map(name => ({ name, inputSchema: { type: "object" } })) };
      } else return send(400, { error: "unsupported_rpc" });
      const rpc = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`);
      } else send(200, rpc);
      return;
    }
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
    if (path === "/inference/memory/search" && req.method === "POST") {
      if (!validSearch(body)) return send(422, { code: "invalid_request" });
      const items = state.memories.slice(0, body.top_k ?? 10);
      if (!options.telemetry) return send(200, { items, count: items.length });
      if (state.telemetry.enrolled && state.telemetry.available && state.telemetry.epoch === 0) {
        state.telemetry.epoch = 1;
        state.telemetry.enrolled_at = new Date().toISOString();
      }
      const id = `ret_01JC3K${String(state.retrievals.size + 1).padStart(20, "0")}`;
      const requestId = req.headers["x-memory-house-request"]?.split(";")[0];
      state.retrievals.set(id, { requestId, count: items.length, epoch: state.telemetry.epoch });
      if (state.telemetry.enrolled && state.telemetry.available) state.reviewDetails.set(id, {
        retrieval_id: id, recorded_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60 * 86400000).toISOString(),
        epoch: state.telemetry.epoch, status: items.length ? "ok" : "empty", client: null,
        count: items.length, supplied_ranks: null, final_outcome: null, feedback_allowed: true, feedback: null,
        items: items.map((memory, index) => ({ rank: index + 1, position: "ranked", supplied: null, omit_reason: null,
          memory_state: "unchanged", memory_id: memory.id, memory_type: memory.memory_type ?? "fact", memory })),
      });
      return send(200, { items: items.map((item, index) => ({ ...item, rank: index + 1,
        position: "ranked", rev_fp: `v1.${"a".repeat(22)}` })), count: items.length,
      retrieval: { id, recording: state.telemetry.enrolled && state.telemetry.available ? "recorded" : "off",
        ...(state.telemetry.enrolled && state.telemetry.available ? { epoch: state.telemetry.epoch }
          : { reason: state.telemetry.available ? "not_enrolled" : "unavailable" }) } });
    }
    if (options.telemetry && path === "/inference/memory/telemetry/enrollment") {
      if (req.method === "POST") {
        if (!state.telemetry.available) return send(409, { code: "telemetry_unavailable" });
        if (body.expected_epoch !== undefined && body.expected_epoch !== state.telemetry.epoch
          && !(state.telemetry.enrolled && body.expected_epoch === state.telemetry.epoch - 1)) return send(409, { code: "enrollment_changed" });
        if (!state.telemetry.enrolled) Object.assign(state.telemetry, { enrolled: true, state: "enabled", epoch: state.telemetry.epoch + 1,
          notice_version: body.notice_version ?? null, enrolled_at: new Date().toISOString(), opted_out_at: null });
      } else if (req.method === "DELETE") {
        if (state.telemetry.enrolled && url.searchParams.has("epoch")
          && Number(url.searchParams.get("epoch")) !== state.telemetry.epoch) return send(409, { code: "enrollment_changed" });
        Object.assign(state.telemetry, { enrolled: false, state: "opted_out", opted_out_at: new Date().toISOString() });
      } else if (req.method !== "GET") return send(405, {});
      return send(200, state.telemetry);
    }
    const reviewRoute = /^\/inference\/memory\/telemetry\/retrievals(?:\/(ret_[0-9A-Z]{26})(\/feedback)?)?$/.exec(path);
    if (options.telemetry && reviewRoute) {
      const allowed = detail => state.telemetry.available && state.telemetry.enrolled
        && detail.epoch === state.telemetry.epoch && detail.feedback?.revision !== 20;
      if (req.method === "GET" && !reviewRoute[1]) {
        const all = [...state.reviewDetails.values()].reverse();
        const start = Number(url.searchParams.get("cursor") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const items = all.slice(start, start + limit).map(({ items: unused, ...detail }) => ({
          ...detail, feedback_allowed: allowed(detail), feedback: detail.feedback ? {
            revision: detail.feedback.revision, labels: detail.feedback.labels.length, updated_at: detail.feedback.updated_at,
          } : null,
        }));
        return send(200, { items, cursor: start + limit < all.length ? String(start + limit) : null });
      }
      const detail = state.reviewDetails.get(reviewRoute[1]);
      if (!detail) return send(404, { code: "retrieval_not_found" });
      if (req.method === "GET" && !reviewRoute[2]) {
        const result = structuredClone(detail);
        result.feedback_allowed = allowed(detail);
        for (const item of result.items) {
          if (item.memory_state !== "unchanged" && url.searchParams.get("include_current") !== "true") delete item.memory;
        }
        return send(200, result);
      }
      if (req.method === "POST" && reviewRoute[2]) {
        if (!state.telemetry.available) return send(409, { code: "telemetry_unavailable" });
        if (!state.telemetry.enrolled) return send(409, { code: "not_enrolled" });
        if (body.epoch !== detail.epoch || body.epoch !== state.telemetry.epoch) return send(409, { code: "enrollment_changed" });
        if (state.feedbackEvents.has(body.event_id)) return send(200, { status: "duplicate", event_id: body.event_id, revision: detail.feedback.revision });
        if (detail.feedback?.revision === 20) return send(409, { code: "feedback_limit" });
        if (Object.keys(body).some(key => !["event_id", "epoch", "surface", "attestation", "occurred_at", "labels"].includes(key))
          || body.surface !== "review_canvas" || body.attestation !== "client_ui") return send(422, { code: "invalid_request" });
        const now = new Date().toISOString();
        const feedback = detail.feedback ?? { revision: 0, labels: [], first_submitted_at: now,
          expires_at: new Date(Date.now() + 60 * 86400000).toISOString() };
        for (const label of body.labels) {
          feedback.labels = feedback.labels.filter(old => old.target !== label.target || old.dimension !== label.dimension);
          if (label.action === "set") feedback.labels.push({
            target: label.target, dimension: label.dimension, value: label.value, reasons: label.reasons ?? [], updated_at: now,
          });
        }
        feedback.revision++;
        Object.assign(feedback, { updated_at: now, revisions_left: 20 - feedback.revision });
        detail.feedback = feedback;
        state.feedbackEvents.set(body.event_id, body);
        return send(200, { status: "recorded", event_id: body.event_id, revision: feedback.revision });
      }
      return send(405, {});
    }
    if (options.telemetry && path.startsWith("/inference/memory/telemetry/") && req.method === "POST") {
      if (!state.telemetry.available) return send(409, { code: "telemetry_unavailable" });
      if (!state.telemetry.enrolled) return send(409, { code: "not_enrolled" });
      if (body?.epoch !== state.telemetry.epoch) return send(409, { code: "enrollment_changed" });
      const invitation = /\/retrievals\/(ret_[0-9A-Z]{26})\/invitation$/.exec(path);
      if (invitation) {
        const detail = state.reviewDetails.get(invitation[1]);
        if (!detail || detail.status === "error") return send(404, { code: "retrieval_not_found" });
        if (detail.epoch !== body.epoch) return send(409, { code: "enrollment_changed" });
        if (Object.keys(body).some(key => !["event_id", "epoch", "policy", "action", "dismissal", "surface", "occurred_at"].includes(key))
          || body.policy !== "inv-2026-11-06.1" || body.surface !== "review_canvas_banner"
          || !["shown", "opened", "dismissed"].includes(body.action)
          || (body.action === "dismissed" ? !["dismiss", "stop_asking"].includes(body.dismissal) : Object.hasOwn(body, "dismissal"))) {
          return send(422, { code: "invalid_request" });
        }
        const prior = state.telemetryEvents.find(event => event.path === path && event.body.action === body.action);
        if (prior) return send(200, { status: "duplicate", event_id: prior.body.event_id });
        state.telemetryEvents.push({ path, body });
        return send(200, { status: "recorded", event_id: body.event_id });
      }
      const delivery = /\/retrievals\/(ret_[0-9A-Z]{26})\/delivery$/.exec(path);
      const outcome = path.endsWith("/request-outcomes");
      if (!delivery && !outcome) return send(404, { code: "not_found" });
      const common = ["event_id", "epoch", "client_request_id", "surface", "occurred_at"];
      const allowed = delivery ? [...common, "budget_bytes", "supplied_bytes", "items"]
        : [...common, "trigger", "attempts", "elapsed_ms", "final_outcome", "http_status", "used_retrieval_id"];
      if (Object.keys(body).some(key => !allowed.includes(key)) || body.surface !== "auto_recall_injection") {
        return send(422, { code: "invalid_request" });
      }
      if (delivery) {
        const retrieved = state.retrievals.get(delivery[1]);
        if (!retrieved || retrieved.requestId !== body.client_request_id) return send(404, { code: "retrieval_not_found" });
        if (!Array.isArray(body.items) || body.items.length !== retrieved.count
          || body.items.some((item, index) => item.rank !== index + 1 || !["full", "partial", "none"].includes(item.supplied))
          || body.supplied_bytes > body.budget_bytes) return send(422, { code: "invalid_request" });
      }
      if (state.telemetryDelayMs) await new Promise(resolve => setTimeout(resolve, state.telemetryDelayMs));
      const prior = state.telemetryEvents.find(event => event.path === path && event.body.client_request_id === body.client_request_id);
      if (prior) return send(200, { status: "duplicate", event_id: prior.body.event_id });
      state.telemetryEvents.push({ path, body });
      return send(200, { status: "recorded", event_id: body.event_id });
    }
    if (path === "/inference/memory/whoami" && req.method === "GET") {
      return state.whoamiStatus === 200 ? send(200, state.whoami) : send(state.whoamiStatus, { error: "fixture-provider-secret" });
    }
    const space = /^\/inference\/memory\/v1\/spaces\/([^/]+)$/.exec(path);
    if (space && req.method === "GET") {
      if (state.spaceStatus !== 200) return send(state.spaceStatus, { error: "fixture-provider-secret" });
      const found = state.spaces.find(item => item.id === decodeURIComponent(space[1]));
      return found ? send(200, found) : send(404, { code: "not_found" });
    }
    if (path === "/inference/memory/memory" && req.method === "POST") {
      // A slow gateway, for checking that hooks never wait on the capture request.
      if (state.captureDelayMs) await new Promise(resolve => setTimeout(resolve, state.captureDelayMs));
      if (state.captureProblem) {
        const { status, ...problem } = state.captureProblem;
        res.writeHead(status, { "Content-Type": "application/problem+json",
          ...(problem.retry_after === undefined ? {} : { "Retry-After": String(problem.retry_after) }) });
        res.end(JSON.stringify({ type: "about:blank", title: "Conflict", status, ...problem }));
        return;
      }
      const key = req.headers["idempotency-key"];
      if (key !== undefined && (typeof key !== "string" || !key || key.length > 256)) return send(422, { code: "invalid_request" });
      if (key && state.idempotent.has(key)) {
        const prior = state.idempotent.get(key);
        if (prior.raw !== raw) return send(409, { code: "idempotency_conflict" });
        return send(prior.status, prior.value);
      }
      if (state.insertStatus) return send(state.insertStatus, { error: "fixture-provider-secret" });
      const contains = text => typeof text === "string" && Array.isArray(body?.items)
        && body.items.some(item => typeof item?.content === "string" && item.content.includes(text));
      if (contains(state.conflictContent)) {
        res.writeHead(409, { "Content-Type": "application/problem+json", "Retry-After": "5" });
        res.end(JSON.stringify({ type: "about:blank", title: "Conflict", status: 409, code: "reset_in_progress", retry_after: 5 }));
        return;
      }
      if (contains(state.failContent)) {
        const items = body.items.map((item, index) => {
          if (typeof item?.content === "string" && item.content.includes(state.failContent)) {
            return { index, id: `fixture-unstored-${index}`, status: "failed", error: { code: "internal_error", message: "fixture-provider-secret" } };
          }
          state.turns.push({ thread_id: body.thread_id, role: item.role, content: item.content });
          return { index, id: `fixture-turn-${state.turns.length}`, status: "stored" };
        });
        const succeeded = items.filter(item => item.status === "stored").length;
        const record = { request_id: `fixture-request-${state.requests.length}`, kind: "insert", status: succeeded ? "partial" : "failed",
          result: { items, count: items.length, succeeded, failed: items.length - succeeded, unknown: 0 }, replayed: false };
        const status = succeeded ? 207 : 503;
        if (key) state.idempotent.set(key, { raw, status, value: { ...record, replayed: true } });
        return send(status, record);
      }
      if (body?.extract !== false && state.captureStatus >= 300) return send(state.captureStatus, { error: "unavailable" });
      if (!validInsertion(body)) return send(422, { code: "invalid_request" });
      state.insertions.push({ body, key });
      const created = new Date().toISOString();
      const envelope = { request_id: `fixture-request-${state.requests.length}`, kind: "insert", created_at: created, attempts: 1 };
      // Captured and imported turns get the gateway's tracked envelope, as /hook/capture returned.
      const results = body.extract === false
        ? body.items.map((_, index) => ({ index, id: `fixture-fact-${state.insertions.length}-${index}`, status: "stored" }))
        : body.items.map((item, index) => {
          state.turns.push({ thread_id: body.thread_id, role: item.role, content: item.content });
          return { index, id: `fixture-turn-${state.turns.length}`, status: "stored" };
        });
      const value = { ...envelope, status: "succeeded", completed_at: created,
        ...(body.extract === false ? {} : { deadline_at: Date.now() / 1000 + 30 }),
        result: { items: results, count: results.length, succeeded: results.length, failed: 0, unknown: 0 } };
      const status = body.extract === false ? 201 : state.captureStatus;
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
