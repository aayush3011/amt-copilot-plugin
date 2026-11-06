import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertSafeUrl, isTenantGuid, loadConfig, requirePublisherConfig, MemoryHouseError } from './config.mjs';
import { atomicJson, ensureDirectory, inspect, owned, readState as readFile, removeFile, withLock } from './state.mjs';
import { acquireEntraToken, clearEntraCache } from './entra.mjs';
import { resolveLoginTenant } from './tenant.mjs';
import { clearCaptureQueue } from './capture-queue.mjs';

export { MemoryHouseError } from './config.mjs';

const credentialLimit = 32 * 1024;
export const MEMORY_TYPES = Object.freeze(['fact', 'episodic', 'procedural']);
export const MEMORY_LIST_LIMITS = Object.freeze({ maxCount: 200, defaultCount: 50, pageSize: 50 });
const SEARCH_LIMITS = Object.freeze({ queryBytes: 16 * 1024, maxTopK: 50 });
const CAPTURE_LIMITS = Object.freeze({ threadBytes: 256, requestBytes: 256 * 1024, items: 50 });
const CURSOR_CHARS = 8192;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

function fail(code, message, details) {
  return new MemoryHouseError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateCredential(value, label = 'Credential') {
  if (typeof value !== 'string' || !value.length || value.length > credentialLimit || /[^\x21-\x7e]/.test(value)) {
    throw fail('INVALID_CREDENTIAL', `${label} must be a non-empty credential without whitespace or control characters.`);
  }
  return value;
}

function text(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit || value.includes('\0')) {
    throw fail('INVALID_PAYLOAD', `${label} must be non-empty text within the supported size limit.`);
  }
  return value;
}

function threadId(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > CAPTURE_LIMITS.threadBytes
    || /[/\\?#\u0000-\u001f]/.test(value)) {
    throw fail('INVALID_PAYLOAD', 'thread_id must be non-empty text of at most 256 bytes without /, \\, ?, # or control characters.');
  }
  return value;
}

function listingPage(data) {
  if (!isObject(data) || !Array.isArray(data.items) || data.count !== data.items.length || typeof data.has_more !== 'boolean'
    || (data.has_more
      ? typeof data.next_cursor !== 'string' || !data.next_cursor || data.next_cursor.length > CURSOR_CHARS
      : data.next_cursor != null)) {
    throw fail('INVALID_RESPONSE', 'Memory House listing did not return valid items, count and continuation status.');
  }
  return data;
}

function checkedJson(value) {
  if (value === undefined) return undefined;
  if (!isObject(value) && !Array.isArray(value)) {
    throw fail('INVALID_PAYLOAD', 'Request bodies must be JSON objects or arrays.');
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw fail('INVALID_PAYLOAD', 'Request body is not serializable JSON.');
  }
  if (Buffer.byteLength(encoded) > 1024 * 1024) {
    throw fail('INVALID_PAYLOAD', 'Request body exceeds the Memory House size limit.');
  }
  return encoded;
}

function jsonObject(raw, operation) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw fail('INVALID_RESPONSE', `Memory House ${operation} returned invalid JSON.`);
  }
  if (!isObject(value) && !Array.isArray(value)) {
    throw fail('INVALID_RESPONSE', `Memory House ${operation} returned an invalid response object.`);
  }
  return value;
}

const PROBLEM_CODE = /^[a-z][a-z\d_]{0,63}$/i;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * What an error body says, without its text: a problem+json `code` and retry delay, or, for a request
 * the engine finished as failed (`{request_id, status: "failed"}`), that request's ID and its error
 * code, if it has one: a request whose every write failed has none, only failed items. Only these short
 * identifiers and a number are kept.
 */
async function problemDetails(response, reader, limit = 8 * 1024) {
  const details = {};
  const header = response.headers.get('retry-after');
  if (header !== null && /^\s*\d{1,6}\s*$/.test(header)) details.retryAfterSeconds = Number(header);
  if (!reader) return details;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return details;
      chunks.push(value);
    }
  } catch {
    return details;
  }
  try {
    const problem = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof problem?.code === 'string' && PROBLEM_CODE.test(problem.code)) details.problem = problem.code.toLowerCase();
    if (details.retryAfterSeconds === undefined && Number.isFinite(problem?.retry_after)
      && problem.retry_after >= 0 && problem.retry_after <= 86_400) details.retryAfterSeconds = problem.retry_after;
    if (typeof problem?.request_id === 'string' && problem.status === 'failed') {
      const code = isObject(problem.error) && typeof problem.error.code === 'string' && PROBLEM_CODE.test(problem.error.code)
        ? problem.error.code.toLowerCase() : null;
      details.requestFailure = { ...(code ? { code } : {}), ...(REQUEST_ID.test(problem.request_id) ? { requestId: problem.request_id } : {}) };
    }
  } catch {
    // Not a problem document.
  }
  return details;
}

/**
 * Internal shared transport for authenticated memory requests.
 * The deadline includes response-body streaming, and errors never include server text.
 * `readProblem` (true, or the most bytes to read) adds what an error body says to the thrown error.
 */
export async function sendRequest({
  url, fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000, maxResponseBytes = 1024 * 1024,
  method = 'POST', headers = {}, body, bodyText, operation = 'request', format = 'json', allowEmpty = false,
  rpcId, acceptHttpErrors = false, readProblem = false,
}) {
  if (bodyText !== undefined && (body !== undefined || typeof bodyText !== 'string' || Buffer.byteLength(bodyText) > 1024 * 1024)) {
    throw fail('INVALID_PAYLOAD', 'Invalid encoded authentication request body.');
  }
  const encoded = bodyText ?? checkedJson(body);
  const controller = new AbortController();
  let reader;
  let timer;
  let timedOut = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(fail('REQUEST_TIMEOUT', `Memory House ${operation} timed out; no automatic retry was attempted.`));
    }, timeoutMs);
  });
  const work = async () => {
    const response = await fetchImpl(url, {
      method,
      headers: { Accept: format === 'mcp' ? 'application/json, text/event-stream' : 'application/json', ...headers,
        ...(encoded === undefined || bodyText !== undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(encoded === undefined ? {} : { body: encoded }),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok && !acceptHttpErrors) {
      // The reader belongs to this request, so the deadline cleanup cancels a stalled error body too.
      if (readProblem && response.body) reader = response.body.getReader();
      const details = { status: response.status,
        ...(readProblem ? await problemDetails(response, reader, typeof readProblem === 'number' ? readProblem : undefined) : {}) };
      controller.abort();
      throw fail('HTTP_ERROR', `Memory House ${operation} failed (HTTP ${response.status}).`, details);
    }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > maxResponseBytes) {
      throw fail('RESPONSE_TOO_LARGE', `Memory House ${operation} response exceeded the size limit.`);
    }
    if (response.body) reader = response.body.getReader();
    let received = 0;
    let raw = '';
    let eventBuffer = '';
    const decoder = new TextDecoder();
    const isSse = format === 'mcp' && response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/event-stream';
    const findEvent = (final = false) => {
      eventBuffer = eventBuffer.replace(/\r\n/g, '\n').replace(final ? /\r/g : /\r(?!$)/g, '\n');
      let boundary;
      while ((boundary = eventBuffer.indexOf('\n\n')) !== -1 || (final && eventBuffer.length)) {
        const event = boundary === -1 ? eventBuffer : eventBuffer.slice(0, boundary);
        eventBuffer = boundary === -1 ? '' : eventBuffer.slice(boundary + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        const parsed = jsonObject(data, operation);
        if (parsed.id === rpcId) return parsed;
      }
      return undefined;
    };
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maxResponseBytes) {
        throw fail('RESPONSE_TOO_LARGE', `Memory House ${operation} response exceeded the size limit.`);
      }
      const decoded = decoder.decode(chunk.value, { stream: true });
      if (isSse) {
        eventBuffer += decoded;
        const data = findEvent();
        if (data !== undefined) return { data, status: response.status, headers: response.headers };
      } else {
        raw += decoded;
      }
    }
    if (isSse) {
      eventBuffer += decoder.decode();
      const data = findEvent(true);
      if (data === undefined) throw fail('INVALID_RESPONSE', `Memory House ${operation} did not return the expected MCP response.`);
      return { data, status: response.status, headers: response.headers };
    }
    raw += decoder.decode();
    if (!raw.trim() && (allowEmpty || response.status === 204)) return { data: null, status: response.status, headers: response.headers };
    return { data: jsonObject(raw, operation), status: response.status, headers: response.headers };
  };
  try {
    return await Promise.race([work(), deadline]);
  } catch (error) {
    if (error instanceof MemoryHouseError) throw error;
    throw fail(
      timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
      timedOut
        ? `Memory House ${operation} timed out; no automatic retry was attempted.`
        : `Memory House ${operation} could not reach the gateway securely. Check connectivity and the configured endpoint.`,
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Do not let a broken peer's cancellation handler extend the operation deadline.
    if (reader) void reader.cancel().catch(() => {});
  }
}

export function createClient(options = {}) {
  const config = Object.freeze({ ...(options.config ?? loadConfig(options)) });
  const safeBase = assertSafeUrl(config.gatewayBase, config).href.replace(/\/$/, '');
  if (safeBase !== config.gatewayBase
      || config.mcpUrl !== `${safeBase}/mcp/` || config.authStatePath !== join(config.stateDir, 'auth.json')
      || config.lockPath !== `${config.authStatePath}.lock`
      || config.cachePath !== join(config.stateDir, 'msal-cache.json.enc')
      || config.cacheLockPath !== join(config.stateDir, 'msal-cache.lock')
      || resolve(config.stateDir) !== config.stateDir
      || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 300_000
      || !Number.isSafeInteger(config.authTimeoutMs) || config.authTimeoutMs <= 0 || config.authTimeoutMs > 30_000
      || !Number.isSafeInteger(config.lockTimeoutMs) || config.lockTimeoutMs <= 0 || config.lockTimeoutMs > 300_000
      || !Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes <= 0 || config.maxResponseBytes > 8 * 1024 * 1024
      || !Number.isSafeInteger(config.tokenSkewSeconds) || config.tokenSkewSeconds < 0 || config.tokenSkewSeconds > 3600) {
    throw fail('INVALID_CONFIG', 'Use loadConfig() to construct a complete, safe Memory House client configuration.');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const acquireToken = options.acquireToken ?? ((settings, request) => acquireEntraToken(settings, { ...request, env: options.env, clock: options.clock }));
  // One in-memory token per audience: `gateway` for hooks and canvas, `mcp` for Claude/Codex headers.
  let tokens = {};
  const acquiring = {};
  let generation = null;
  let revision = 0;
  // The tenant recorded by the last explicit sign-in, and the deployment setting it was resolved from.
  let signedInTenant = null;
  let signedInSetting = null;
  // The signed-in account's object ID and the capture epoch that a sign-in with the same account keeps.
  let signedInObjectId = null;
  let signedInEpoch = null;
  const clock = options.clock ?? Date.now;
  const now = () => {
    const value = clock();
    if (!Number.isFinite(value) || value < 0) throw fail('INVALID_CLOCK', 'The Memory House clock must return milliseconds since the Unix epoch.');
    return Math.floor(value / 1000);
  };
  const requestUrl = (url, { method = 'POST', body, token, allowEmpty = false, operation = 'request', headers = {}, readProblem = false } = {}) =>
    sendRequest({
      url, fetch: fetchImpl, timeoutMs: config.timeoutMs,
      maxResponseBytes: config.maxResponseBytes, method, body, operation, allowEmpty, readProblem,
      headers: token ? { ...headers, Authorization: `Bearer ${token}` } : headers,
    });
  const locked = async work => {
    await ensureDirectory(config.stateDir);
    return withLock(config.lockPath, config.lockTimeoutMs, async () => {
      const stat = await inspect(config.authStatePath);
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !owned(stat))) {
        throw fail('UNSAFE_STATE', 'Refusing to modify unsafe Memory House state. No credential was sent.');
      }
      return work();
    });
  };
  const disabled = async () => {
    const directory = await inspect(config.stateDir);
    if (directory && (!directory.isDirectory() || directory.isSymbolicLink() || !owned(directory))) {
      throw fail('UNSAFE_STATE', 'Memory House state must be an owned directory, not a symbolic link.');
    }
    const raw = await readFile(config.authStatePath);
    if (raw === null) {
      if (generation !== null) { tokens = {}; revision++; }
      generation = null;
      signedInTenant = null;
      signedInSetting = null;
      signedInObjectId = null;
      signedInEpoch = null;
      return false;
    }
    let state;
    try { state = JSON.parse(raw); } catch {
      throw fail('INVALID_AUTH_STATE', 'Memory House sign-in preference is invalid. Run mh-login to reset it.');
    }
    if (!isObject(state) || state.version !== 1 || typeof state.disabled !== 'boolean'
      || typeof state.generation !== 'string' || !/^[a-f\d-]{36}$/i.test(state.generation)
      || (state.tenantId !== undefined && !isTenantGuid(state.tenantId))
      || (state.tenantSetting !== undefined && state.tenantSetting !== null && typeof state.tenantSetting !== 'string')) {
      throw fail('INVALID_AUTH_STATE', 'Memory House sign-in preference is invalid. Run mh-login to reset it.');
    }
    if (generation !== state.generation) { tokens = {}; revision++; }
    generation = state.generation;
    signedInTenant = state.tenantId?.toLowerCase() ?? null;
    signedInSetting = state.tenantSetting ?? null;
    // Sign-ins recorded before 0.15.0, or by an older plugin, have no account; captures then bind to the sign-in.
    const account = !state.disabled && signedInTenant && typeof state.objectId === 'string' && OBJECT_ID.test(state.objectId)
      && typeof state.captureEpoch === 'string' && UUID.test(state.captureEpoch);
    signedInObjectId = account ? state.objectId : null;
    signedInEpoch = account ? state.captureEpoch.toLowerCase() : null;
    return state.disabled;
  };

  /**
   * What queued captures are bound to: the signed-in account (tenant and object ID) with its capture
   * epoch, which a new sign-in with the same account keeps and a sign-out ends; or, for a sign-in
   * that recorded no account, that sign-in alone.
   */
  const queueBinding = () => createHash('sha256').update(JSON.stringify(signedInObjectId
    ? ['account', signedInTenant, signedInObjectId, signedInEpoch] : ['sign-in', generation])).digest('hex');

  // Background requests never discover a tenant: they use the one mh-login recorded, or a pinned GUID.
  function effectiveTenant() {
    const setting = config.tenantId;
    if (signedInTenant) {
      const pinned = isTenantGuid(setting) ? setting.toLowerCase() !== signedInTenant
        : Boolean(setting) && setting.toLowerCase() !== signedInSetting?.toLowerCase();
      if (pinned) {
        throw fail('TENANT_CHANGED', 'The deployment tenant differs from the tenant this device signed in to. Run mh-login.');
      }
      return signedInTenant;
    }
    if (isTenantGuid(setting)) return setting.toLowerCase();
    throw fail('ENTRA_AUTH_REQUIRED', 'Sign in to Memory House with mh-login. Background requests never open a browser.');
  }

  async function currentToken(resource, tenantId) {
    requirePublisherConfig(config);
    const cached = tokens[resource];
    if (cached && cached.expiresAt > now() + config.tokenSkewSeconds) return cached;
    const startedRevision = revision;
    if (!acquiring[resource]) acquiring[resource] = acquireToken({ ...config, tenantId }, { resource }).then(value => {
      validateCredential(value?.accessToken, 'Entra access token');
      if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now() + config.tokenSkewSeconds) {
        throw fail('ENTRA_TOKEN_INVALID', 'Microsoft did not provide a usable token expiry.');
      }
      if (revision === startedRevision) tokens[resource] = value;
      return value;
    }).finally(() => { acquiring[resource] = undefined; });
    return acquiring[resource];
  }

  /** The current token with its account's object ID, when Microsoft reported one. */
  async function currentAccess(resource = 'gateway') {
    if (!['gateway', 'mcp'].includes(resource)) throw fail('INVALID_CONFIG', 'Unsupported Memory House token request.');
    if (await disabled()) throw fail('NOT_SIGNED_IN', 'Memory House is disabled on this device. Run mh-login to sign in.');
    const started = generation;
    const value = await currentToken(resource, effectiveTenant());
    if (await disabled() || started !== generation) throw fail('NOT_SIGNED_IN', 'Memory House sign-in changed while acquiring a token. Retry the operation.');
    return value;
  }

  async function getAccessToken(resource = 'gateway') {
    return (await currentAccess(resource)).accessToken;
  }


  async function login() {
    return locked(async () => {
      revision++;
      tokens = {};
      requirePublisherConfig(config);
      const tenantId = await resolveLoginTenant(config, { fetch: fetchImpl });
      let previous = null;
      try { previous = JSON.parse(await readFile(config.authStatePath)); } catch { /* No usable earlier sign-in. */ }
      const value = await acquireToken({ ...config, tenantId }, { interactive: true });
      validateCredential(value?.accessToken, 'Entra access token');
      if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now() + config.tokenSkewSeconds) {
        throw fail('ENTRA_TOKEN_INVALID', 'Microsoft did not provide a usable token expiry.');
      }
      const objectId = typeof value.objectId === 'string' && OBJECT_ID.test(value.objectId) ? value.objectId : null;
      tokens.gateway = { accessToken: value.accessToken, expiresAt: value.expiresAt, ...(objectId ? { objectId } : {}) };
      // Signing in again with the same account keeps its capture epoch, so its queued turns are still sent.
      // A different account or tenant, or a sign-in after a sign-out, starts a new epoch.
      const sameAccount = objectId !== null && isObject(previous) && previous.disabled === false
        && typeof previous.tenantId === 'string' && previous.tenantId.toLowerCase() === tenantId.toLowerCase()
        && previous.objectId === objectId && typeof previous.captureEpoch === 'string' && UUID.test(previous.captureEpoch);
      const captureEpoch = objectId === null ? null : sameAccount ? previous.captureEpoch.toLowerCase() : randomUUID();
      // Remove obsolete plugin-issued credentials without reading them.
      await removeFile(join(config.stateDir, 'token.json'));
      generation = randomUUID();
      signedInTenant = tenantId.toLowerCase();
      signedInSetting = config.tenantId ?? null;
      signedInObjectId = objectId;
      signedInEpoch = captureEpoch;
      await atomicJson(config.authStatePath, { version: 1, disabled: false, generation, tenantId, tenantSetting: signedInSetting,
        ...(objectId === null ? {} : { objectId, captureEpoch }) });
      return { signedIn: true, needsLogin: false, source: 'entra', tenantId, accessExpiresAt: value.expiresAt,
        mcpReady: value.mcpReady === true, ...(value.mcpReady === false && value.mcpReason ? { mcpReason: value.mcpReason } : {}) };
    });
  }

  async function logout() {
    return locked(async () => {
      revision++;
      await atomicJson(config.authStatePath, { version: 1, disabled: true, generation: randomUUID() });
      tokens = {};
      await clearEntraCache(config);
      await removeFile(join(config.stateDir, 'token.json'));
      // Turns queued under this sign-in must never be sent after it ends.
      const queueCleared = await clearCaptureQueue(config.stateDir).then(() => true, () => false);
      return { signedOut: true,
        message: `Memory House disabled and its sign-in cache removed${queueCleared ? ', and any unsent captured turns discarded'
          : '. Unsent captured turns could not be removed now; they are never sent and are discarded the next time a Memory House hook runs'}. `
          + 'Copilot MCP sign-in is unchanged; in-flight tokens remain valid until expiry.' };
    });
  }

  async function capture(turn, { idempotencyKey, binding: expected } = {}) {
    if (!isObject(turn)) throw fail('INVALID_PAYLOAD', 'Capture requires a conversational turn.');
    // `items` sends a thread's queued turns, in order, in one request.
    const turns = turn.items === undefined ? [{ role: turn.role, content: turn.content }] : turn.items;
    if (!Array.isArray(turns) || !turns.length || turns.length > CAPTURE_LIMITS.items) {
      throw fail('INVALID_PAYLOAD', `Capture sends 1 to ${CAPTURE_LIMITS.items} turns per request.`);
    }
    const items = turns.map(item => {
      if (!isObject(item) || !['user', 'agent'].includes(item.role)) throw fail('INVALID_PAYLOAD', 'Capture role must be user or agent.');
      return { role: item.role, content: text(item.content, 'content', CAPTURE_LIMITS.requestBytes) };
    });
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey))) {
      throw fail('INVALID_PAYLOAD', 'A capture idempotency key must be a short ASCII identifier.');
    }
    const body = { extract: true, thread_id: threadId(turn.thread_id), items };
    if (Buffer.byteLength(JSON.stringify(body)) > CAPTURE_LIMITS.requestBytes) {
      throw fail('INVALID_PAYLOAD', 'Capture request exceeds the 256 KiB Memory House limit.');
    }
    const access = await currentAccess();
    // Queued turns are sent only for the account that queued them, with a token for that account. A
    // sign-in that recorded no account cannot be matched against a token, so none of its turns are sent.
    if (expected !== undefined && (signedInObjectId === null || expected !== queueBinding() || access.objectId !== signedInObjectId)) {
      throw fail('NOT_SIGNED_IN', 'These turns were queued for another or an unverified Memory House account; they were not sent.');
    }
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    // A failed request's record lists its items, so its error body can be larger than a problem.
    return (await requestUrl(`${config.gatewayBase}/memory`, {
      body, token: access.accessToken, operation: 'capture', headers, readProblem: 64 * 1024,
    })).data;
  }

  /**
   * The current sign-in for queued captures, from local state only: `{ binding, generation, tenantId,
   * accountBound }`, or null when signed out or never signed in. Throws when the sign-in state cannot
   * be read. Only turns queued while `accountBound` is true can be sent.
   */
  async function captureIdentity() {
    if (await disabled() || !generation) return null;
    return { binding: queueBinding(), generation, tenantId: effectiveTenant(), accountBound: signedInObjectId !== null };
  }

  /**
   * For a sign-in that recorded no account (one made by a plugin before 0.15.0), records the account of
   * the cached Microsoft sign-in, so that later captures can be bound to it. It holds the sign-in lock,
   * so no sign-in is replacing the cache meanwhile, and uses a fresh token from the cache. Like a
   * sign-in, it starts a new generation, so every client drops tokens it cached before. Returns whether
   * the sign-in records an account.
   */
  async function recordAccount() {
    return locked(async () => {
      if (await disabled() || !generation) return false;
      if (signedInObjectId !== null) return true;
      revision++;
      tokens = {};
      const access = await currentAccess();
      if (typeof access.objectId !== 'string' || !OBJECT_ID.test(access.objectId)) return false;
      const state = JSON.parse(await readFile(config.authStatePath));
      if (!isObject(state) || state.disabled !== false || state.generation !== generation) return false;
      await atomicJson(config.authStatePath, { ...state, generation: randomUUID(), objectId: access.objectId, captureEpoch: randomUUID() });
      await disabled();
      return signedInObjectId !== null;
    });
  }

  async function search(query, topK = 5) {
    text(query, 'query', SEARCH_LIMITS.queryBytes);
    if (!Number.isSafeInteger(topK) || topK < 1 || topK > SEARCH_LIMITS.maxTopK) {
      throw fail('INVALID_PAYLOAD', 'topK must be an integer from 1 to 50.');
    }
    const token = await getAccessToken();
    const { data } = await requestUrl(`${config.gatewayBase}/search`, { body: { query, top_k: topK }, token, operation: 'search' });
    if (!isObject(data) || !Array.isArray(data.items)) {
      throw fail('INVALID_RESPONSE', 'Memory House search did not return an items array.');
    }
    return data;
  }

  async function getMemories(options = {}) {
    if (!isObject(options) || Object.keys(options).some(key => !['recent_k', 'memory_types', 'include_superseded'].includes(key))) {
      throw fail('INVALID_PAYLOAD', 'Memory listing accepts only a count, memory types and superseded visibility.');
    }
    const { recent_k, memory_types = [], include_superseded = false } = options;
    if ((recent_k !== undefined && (!Number.isSafeInteger(recent_k) || recent_k < 1 || recent_k > MEMORY_LIST_LIMITS.maxCount))
      || !Array.isArray(memory_types) || memory_types.length > MEMORY_TYPES.length || memory_types.some(value => !MEMORY_TYPES.includes(value))
      || typeof include_superseded !== 'boolean') {
      throw fail('INVALID_PAYLOAD', 'Memory listing requires a count from 1 to 200, supported memory types and a boolean superseded filter.');
    }
    const requested = recent_k ?? MEMORY_LIST_LIMITS.defaultCount;
    // The gateway binds each cursor to page_size, so every page of one listing uses the same size.
    const pageSize = Math.min(requested, MEMORY_LIST_LIMITS.pageSize);
    const filters = new URLSearchParams({ page_size: String(pageSize) });
    for (const type of new Set(memory_types)) filters.append('memory_types', type);
    if (include_superseded) filters.set('include_superseded', 'true');
    const token = await getAccessToken();
    const items = [];
    let cursor;
    let hasMore = false;
    for (let page = 0; page < Math.ceil(requested / pageSize); page++) {
      const query = new URLSearchParams(filters);
      if (cursor) query.set('cursor', cursor);
      const { data } = await requestUrl(`${config.gatewayBase}/memories?${query}`, { method: 'GET', token, operation: 'listing' });
      const current = listingPage(data);
      items.push(...current.items);
      hasMore = current.has_more;
      cursor = current.next_cursor;
      if (!hasMore) break;
    }
    const listed = items.slice(0, requested);
    return { items: listed, count: listed.length, has_more: hasMore || items.length > requested };
  }

  async function status() {
    try {
      await getAccessToken();
      return { signedIn: true, needsLogin: false, source: 'entra', tenantId: effectiveTenant(),
        accessExpiresAt: tokens.gateway?.expiresAt ?? null };
    } catch (error) {
      if (!['NOT_SIGNED_IN', 'ENTRA_AUTH_REQUIRED', 'TENANT_CHANGED'].includes(error.code)) throw error;
      return { signedIn: false, needsLogin: true, source: 'entra', tenantId: signedInTenant
        ?? (isTenantGuid(config.tenantId) ? config.tenantId.toLowerCase() : null), accessExpiresAt: null, reason: error.code };
    }
  }

  return Object.freeze({ config, getAccessToken, login, logout, capture, captureIdentity, recordAccount, search, getMemories, status });
}
