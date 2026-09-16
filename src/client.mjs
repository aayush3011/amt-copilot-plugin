import { join, resolve } from 'node:path';
import { assertSafeUrl, loadConfig, requirePublisherConfig, MemoryHouseError } from './config.mjs';
import { atomicJson, ensureDirectory, inspect, owned, readState as readFile, removeFile, withLock } from './state.mjs';

export { MemoryHouseError } from './config.mjs';

const credentialLimit = 32 * 1024;

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

/**
 * Internal shared transport for hook requests and the Entra MCP handshake.
 * The deadline includes response-body streaming, and errors never include server text.
 */
export async function sendRequest({
  url, fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000, maxResponseBytes = 1024 * 1024,
  method = 'POST', headers = {}, body, bodyText, operation = 'request', format = 'json', allowEmpty = false,
  rpcId, acceptHttpErrors = false,
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
      controller.abort();
      throw fail('HTTP_ERROR', `Memory House ${operation} failed (HTTP ${response.status}).`, { status: response.status });
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

function decodeCache(raw) {
  if (raw === null) return null;
  let value;
  try {
    value = JSON.parse(raw);
    if (!isObject(value) || value.token_type !== 'HookToken') throw new Error('format');
    validateCredential(value.access_token);
    validateCredential(value.refresh_token);
    if (!Number.isSafeInteger(value.expires_at) || value.expires_at <= 0) throw new Error('expiry');
    if (value.version !== 1 || typeof value.gateway_base !== 'string') throw new Error('binding');
    if (!Number.isSafeInteger(value.refresh_expires_at) || value.refresh_expires_at <= 0) throw new Error('refresh expiry');
  } catch {
    throw fail('INVALID_CACHE', 'Memory House credentials are invalid or not gateway-bound. Sign in again.');
  }
  return value;
}

function tokenResponse(value, now, gatewayBase, previousRefresh) {
  if (!isObject(value) || value.token_type !== 'HookToken'
      || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0
      || !Number.isSafeInteger(value.refresh_expires_in) || value.refresh_expires_in <= 0
      || !Number.isSafeInteger(now + value.expires_in) || !Number.isSafeInteger(now + value.refresh_expires_in)) {
    throw fail('INVALID_TOKEN_RESPONSE', 'The gateway returned an invalid hook token pair. Sign in again; no success was recorded.');
  }
  try {
    validateCredential(value.access_token);
    validateCredential(value.refresh_token);
  } catch {
    throw fail('INVALID_TOKEN_RESPONSE', 'The gateway returned an invalid hook token pair. Sign in again; no success was recorded.');
  }
  if (previousRefresh !== undefined && value.refresh_token === previousRefresh) {
    throw fail('INVALID_TOKEN_RESPONSE', 'The gateway did not rotate the refresh token. Sign in again; no success was recorded.');
  }
  return {
    version: 1, gateway_base: gatewayBase, token_type: 'HookToken',
    access_token: value.access_token, refresh_token: value.refresh_token,
    expires_at: now + value.expires_in, refresh_expires_at: now + value.refresh_expires_in,
  };
}

export function createClient(options = {}) {
  const config = Object.freeze({ ...(options.config ?? loadConfig(options)) });
  const safeBase = assertSafeUrl(config.gatewayBase, config).href.replace(/\/$/, '');
  if (safeBase !== config.gatewayBase || config.hookBase !== `${safeBase}/hook`
      || config.mcpUrl !== `${safeBase}/mcp/` || config.tokenPath !== join(config.stateDir, 'token.json')
      || config.lockPath !== `${config.tokenPath}.lock`
      || resolve(config.stateDir) !== config.stateDir
      || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 300_000
      || !Number.isSafeInteger(config.lockTimeoutMs) || config.lockTimeoutMs <= 0 || config.lockTimeoutMs > 300_000
      || !Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes <= 0 || config.maxResponseBytes > 8 * 1024 * 1024
      || !Number.isSafeInteger(config.tokenSkewSeconds) || config.tokenSkewSeconds < 0 || config.tokenSkewSeconds > 3600) {
    throw fail('INVALID_CONFIG', 'Use loadConfig() to construct a complete, safe Memory House client configuration.');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? Date.now;
  const now = () => {
    const value = clock();
    if (!Number.isFinite(value) || value < 0) throw fail('INVALID_CLOCK', 'The Memory House clock must return milliseconds since the Unix epoch.');
    return Math.floor(value / 1000);
  };
  const request = (endpoint, { method = 'POST', body, token, allowEmpty = false, operation = endpoint } = {}) =>
    sendRequest({
      url: `${config.hookBase}/${endpoint}`, fetch: fetchImpl, timeoutMs: config.timeoutMs,
      maxResponseBytes: config.maxResponseBytes, method, body, operation, allowEmpty,
      headers: token ? { Authorization: `HookToken ${token}` } : {},
    });
  const locked = async work => {
    await ensureDirectory(config.stateDir);
    return withLock(config.lockPath, config.lockTimeoutMs, async () => {
      const stat = await inspect(config.tokenPath);
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !owned(stat))) {
        throw fail('UNSAFE_STATE', 'Refusing to modify unsafe Memory House state. No credential was sent.');
      }
      return work();
    });
  };
  const clearCache = () => removeFile(config.tokenPath);
  const readCache = async () => {
    const directory = await inspect(config.stateDir);
    if (directory && (!directory.isDirectory() || directory.isSymbolicLink() || !owned(directory))) {
      throw fail('UNSAFE_STATE', 'Memory House state must be an owned directory, not a symbolic link.');
    }
    return decodeCache(await readFile(config.tokenPath));
  };
  const bound = cache => {
    if (cache && cache.gateway_base !== config.gatewayBase) {
      throw fail('GATEWAY_MISMATCH', 'Stored Memory House credentials belong to a different gateway. Sign in to the selected gateway; no cached credential was sent.');
    }
    return cache;
  };
  const fresh = cache => cache && cache.expires_at > now() + config.tokenSkewSeconds;
  const canRefresh = cache => Boolean(cache && cache.refresh_expires_at > now());
  const statusFor = cache => {
    const matches = !cache || cache.gateway_base === config.gatewayBase;
    const usable = matches && (Boolean(cache && cache.expires_at > now()) || canRefresh(cache));
    return {
      signedIn: usable,
      source: cache ? 'cache' : 'none',
      gatewayBase: config.gatewayBase,
      accessExpiresAt: matches ? cache?.expires_at ?? null : null,
      refreshExpiresAt: matches ? cache?.refresh_expires_at ?? null : null,
      canRefresh: matches && canRefresh(cache),
      needsLogin: !usable,
      publisherConfigReady: config.publisherMissing.length === 0,
      publisherMissing: config.publisherMissing,
      ...(matches ? {} : { reason: 'gateway_mismatch' }),
    };
  };

  async function getAccessToken() {
    const cached = bound(await readCache());
    if (fresh(cached)) return cached.access_token;
    return locked(async () => {
      const current = bound(await readCache());
      if (fresh(current)) return current.access_token;
      if (!current) {
        requirePublisherConfig(config);
        throw fail('NOT_SIGNED_IN', 'Memory House is not signed in. Use memory_login in your app.');
      }
      if (!canRefresh(current)) {
        await clearCache();
        throw fail('REFRESH_EXPIRED', 'Memory House sign-in has expired. Use memory_login in your app.');
      }
      const started = now();
      let data;
      try {
        ({ data } = await request('refresh', { body: { refresh_token: current.refresh_token } }));
      } catch (error) {
        if (error instanceof MemoryHouseError && error.status === 401) {
          await clearCache();
          throw fail('REFRESH_REJECTED', 'Memory House refresh was rejected. Local credentials were cleared; sign in again.', { status: 401 });
        }
        throw error;
      }
      const rotated = tokenResponse(data, started, config.gatewayBase, current.refresh_token);
      await atomicJson(config.tokenPath, rotated);
      return rotated.access_token;
    });
  }

  async function redeem(enrollmentCode) {
    validateCredential(enrollmentCode, 'Enrollment code');
    return locked(async () => {
      const started = now();
      const { data } = await request('redeem', { body: { enrollment_code: enrollmentCode } });
      const cache = tokenResponse(data, started, config.gatewayBase);
      await atomicJson(config.tokenPath, cache);
      return statusFor(cache);
    });
  }

  async function logout() {
    return locked(async () => {
      let cache;
      let failure;
      let revoked = false;
      try {
        cache = bound(await readCache());
        if (cache) {
          await request('revoke', { body: { refresh_token: cache.refresh_token }, allowEmpty: true });
          revoked = true;
        }
      } catch (error) {
        failure = error;
      }
      await clearCache();
      if (failure) {
        throw fail('REVOCATION_FAILED',
          'Local Memory House credentials were cleared, but gateway revocation could not be confirmed. Previously issued access tokens may remain valid until expiry.',
          { localCleared: true, revoked: false, ...(failure.status ? { status: failure.status } : {}) });
      }
      return {
        signedOut: true, localCleared: true, revoked,
        message: 'Local credentials cleared. Previously issued access tokens may remain valid until expiry.',
      };
    });
  }

  async function capture(turn) {
    if (!isObject(turn)) throw fail('INVALID_PAYLOAD', 'Capture requires a conversational turn.');
    const body = {
      thread_id: text(turn.thread_id, 'thread_id', 2048),
      role: turn.role,
      content: text(turn.content, 'content', 1024 * 1024 - 4096),
    };
    if (!['user', 'agent'].includes(body.role)) throw fail('INVALID_PAYLOAD', 'Capture role must be user or agent.');
    const token = await getAccessToken();
    return (await request('capture', { body, token })).data;
  }

  async function search(query, topK = 8) {
    text(query, 'query', 64 * 1024);
    if (!Number.isSafeInteger(topK) || topK < 1 || topK > 100) throw fail('INVALID_PAYLOAD', 'topK must be an integer from 1 to 100.');
    const token = await getAccessToken();
    const { data } = await request('search', { body: { query, top_k: topK }, token });
    if (!isObject(data) || !Array.isArray(data.items)) {
      throw fail('INVALID_RESPONSE', 'Memory House search did not return an items array.');
    }
    return data;
  }

  async function status() {
    return statusFor(await readCache());
  }

  return Object.freeze({ config, getAccessToken, redeem, logout, capture, search, status });
}
