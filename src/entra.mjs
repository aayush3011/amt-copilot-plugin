import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { assertSafeUrl, MemoryHouseError } from './config.mjs';
import { sendRequest, validateCredential } from './client.mjs';
import { openBrowserUrl } from './browser.mjs';

const supportedProtocols = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

function error(code, message) {
  return new MemoryHouseError(code, message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configured(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw error('PUBLISHER_CONFIG_MISSING', `The publisher must set ${name} for its registered Entra public client. End users should only sign in.`);
  }
  return value.trim();
}

function validateClient(client) {
  if (!client?.config || typeof client.redeem !== 'function') {
    throw error('INVALID_CLIENT', 'Entra enrollment requires a Memory House client.');
  }
  assertSafeUrl(client.config.mcpUrl, client.config);
  if (client.config.mcpUrl !== `${client.config.gatewayBase}/mcp/`) {
    throw error('INVALID_CLIENT', 'MCP enrollment must use the configured Memory House gateway.');
  }
}

function rpcResult(data, id, operation) {
  if (!object(data) || data.jsonrpc !== '2.0' || data.id !== id || data.error || !object(data.result)) {
    throw error('MCP_ERROR', `Memory House MCP ${operation} failed or returned an invalid result.`);
  }
  return data.result;
}

function enrollmentCode(result) {
  if (result.isError) throw error('ENROLLMENT_FAILED', 'Memory House MCP enrollment was rejected. Check gateway access and sign in again.');
  let value;
  if (result.structuredContent !== undefined) {
    value = result.structuredContent;
  } else {
    const parts = Array.isArray(result.content) ? result.content.filter(part => part?.type === 'text') : undefined;
    if (!Array.isArray(parts) || parts.length !== 1 || typeof parts[0].text !== 'string') {
      throw error('INVALID_ENROLLMENT_RESPONSE', 'Memory House enrollment did not return a usable code.');
    }
    try {
      value = JSON.parse(parts[0].text);
    } catch {
      throw error('INVALID_ENROLLMENT_RESPONSE', 'Memory House enrollment did not return a usable code.');
    }
  }
  if (!object(value) || typeof value.enrollment_code !== 'string' || value.enrollment_code.length > 4096) {
    throw error('INVALID_ENROLLMENT_RESPONSE', 'Memory House enrollment did not return a usable code.');
  }
  try {
    return validateCredential(value.enrollment_code);
  } catch {
    throw error('INVALID_ENROLLMENT_RESPONSE', 'Memory House enrollment did not return a usable code.');
  }
}

/** Enrolls and redeems in-process; neither the Entra token nor the enrollment code is returned. */
export async function enrollWithEntraToken({
  client, accessToken, fetch: fetchImpl = globalThis.fetch,
  timeoutMs = client?.config?.timeoutMs ?? 20_000,
  maxResponseBytes = client?.config?.maxResponseBytes ?? 1024 * 1024,
  protocolVersion = '2025-03-26',
} = {}) {
  validateClient(client);
  validateCredential(accessToken, 'Entra access token');
  if (!supportedProtocols.has(protocolVersion)) throw error('MCP_PROTOCOL_ERROR', 'Unsupported MCP enrollment protocol version.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > 8 * 1024 * 1024) {
    throw error('INVALID_CONFIG', 'Enrollment requires bounded positive timeout and response-size settings.');
  }
  const headers = { Authorization: `Bearer ${accessToken}` };
  const call = (body, { allowEmpty = false, operation, rpcId } = {}) => sendRequest({
    url: client.config.mcpUrl, fetch: fetchImpl, headers, body, timeoutMs, maxResponseBytes,
    format: 'mcp', allowEmpty, rpcId, operation,
  });
  const initialized = await call({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'memory-house-client', version: '1.0.0' } },
  }, { operation: 'initialization', rpcId: 1 });
  const handshake = rpcResult(initialized.data, 1, 'initialization');
  if (!supportedProtocols.has(handshake.protocolVersion)) {
    throw error('MCP_PROTOCOL_ERROR', 'The gateway selected an unsupported MCP protocol version.');
  }
  headers['MCP-Protocol-Version'] = handshake.protocolVersion;
  const session = initialized.headers.get('mcp-session-id');
  if (session !== null) {
    if (!session.length || session.length > 4096 || /[^\x21-\x7e]/.test(session)) {
      throw error('MCP_SESSION_ERROR', 'The gateway returned an invalid MCP session identifier.');
    }
    headers['Mcp-Session-Id'] = session;
  }
  const checkSession = response => {
    const next = response.headers.get('mcp-session-id');
    if (next !== null && next !== session) throw error('MCP_SESSION_ERROR', 'The gateway unexpectedly changed the MCP enrollment session.');
  };
  const notified = await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, {
    allowEmpty: true, operation: 'initialized notification',
  });
  checkSession(notified);
  if (notified.data?.error) throw error('MCP_ERROR', 'Memory House rejected the MCP initialized notification.');
  const enrolled = await call({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'enroll_hook_capture', arguments: {} },
  }, { operation: 'enrollment', rpcId: 2 });
  checkSession(enrolled);
  const code = enrollmentCode(rpcResult(enrolled.data, 2, 'enrollment'));
  return client.redeem(code);
}

function httpsEntraUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw error('ENTRA_ENDPOINT_ERROR', 'Entra returned an invalid sign-in endpoint.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.hostname !== 'login.microsoftonline.com') {
    throw error('ENTRA_ENDPOINT_ERROR', 'Entra authentication must use the configured Microsoft HTTPS authority.');
  }
  return url;
}

function networkClient(fetchImpl, timeoutMs, maxResponseBytes) {
  const send = async (url, options, method) => {
    httpsEntraUrl(url);
    const response = await sendRequest({
      url, fetch: fetchImpl, method, headers: options?.headers ?? {},
      bodyText: options?.body, timeoutMs, maxResponseBytes, acceptHttpErrors: true,
      operation: 'Entra authentication',
    });
    return { headers: Object.fromEntries(response.headers), body: response.data, status: response.status };
  };
  return {
    sendGetRequestAsync: (url, options) => send(url, options, 'GET'),
    sendPostRequestAsync: (url, options) => send(url, options, 'POST'),
  };
}

function loopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw error('INVALID_REDIRECT_URI', 'Use a registered HTTP loopback redirect URI for browser sign-in.');
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) {
    throw error('INVALID_REDIRECT_URI', 'Browser sign-in requires an HTTP localhost, 127.0.0.1, or [::1] redirect without a query or fragment.');
  }
  return url;
}

function sameState(received, expected) {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  const actual = Buffer.from(received);
  const wanted = Buffer.from(expected);
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted);
}

function deviceMessage(response) {
  let url;
  try {
    url = new URL(response.verificationUri);
  } catch {
    throw error('INVALID_DEVICE_CODE', 'Entra returned an invalid device sign-in response.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com'].includes(url.hostname)
      || typeof response.userCode !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(response.userCode)) {
    throw error('INVALID_DEVICE_CODE', 'Entra returned an invalid device sign-in response.');
  }
  return `Open ${url.href} and enter code ${response.userCode}.`;
}

/**
 * Uses an application's own in-memory MSAL cache. pca/msal/fetch/openBrowser
 * injection is for tests; no harness OAuth cache or dynamic client registration is used.
 */
export async function loginWithEntra({
  client, tenantId, clientId, scope, mode = 'browser', redirectUri,
  onMessage = () => {}, openBrowser = openBrowserUrl,
  pca, msal, fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 180_000, signal,
} = {}) {
  validateClient(client);
  tenantId = configured(tenantId ?? client.config.tenantId, 'deployment.json entra.tenantId');
  clientId = configured(clientId ?? client.config.clientId, 'deployment.json entra.clientId');
  scope = configured(scope ?? client.config.scope, 'deployment.json entra.scope');
  if (mode === 'browser') redirectUri = configured(redirectUri ?? client.config.redirectUri, 'deployment.json entra.redirectUri');
  if (!/^[a-z\d][a-z\d.-]{0,254}$/i.test(tenantId) || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(clientId)) {
    throw error('INVALID_ENTRA_CONFIG', 'Use a tenant ID/domain and the application ID of a pre-registered Entra public client.');
  }
  const scopes = scope.split(/\s+/);
  if (scopes.some(value => !/^(?:api:\/\/|https:\/\/)[^\s?#]+\/[^/\s?#]+$/.test(value))) {
    throw error('INVALID_ENTRA_CONFIG', 'deployment.json entra.scope must name the registered gateway API scope, not a host token or identity scope.');
  }
  if (!['browser', 'device-code'].includes(mode)) throw error('INVALID_LOGIN_MODE', 'Entra login mode must be browser or device-code.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) {
    throw error('INVALID_CONFIG', 'The Entra sign-in timeout must be between 1 and 900000 milliseconds.');
  }
  if (typeof onMessage !== 'function' || typeof openBrowser !== 'function') throw error('INVALID_CONFIG', 'Sign-in callbacks must be functions.');

  const cancelToken = { cancel: false };
  const browserAbort = new AbortController();
  let cancelled = false;
  let server;
  let timeout;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
    timeout = setTimeout(() => {
      cancelled = true;
      cancelToken.cancel = true;
      browserAbort.abort();
      reject(error('ENTRA_LOGIN_TIMEOUT', 'Entra sign-in timed out. Start a new login when ready.'));
    }, timeoutMs);
  });
  const abort = () => {
    cancelled = true;
    cancelToken.cancel = true;
    browserAbort.abort();
    rejectDeadline(error('ENTRA_LOGIN_CANCELLED', 'Entra sign-in was cancelled.'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const active = () => {
    if (cancelled) throw error('ENTRA_LOGIN_CANCELLED', 'Entra sign-in was cancelled.');
  };
  const closeServer = async () => {
    if (!server) return;
    const closing = server;
    server = undefined;
    if (!closing.listening) return;
    await new Promise((resolve, reject) => {
      closing.close(closeError => closeError ? reject(error('LOOPBACK_CLOSE_FAILED', 'Unable to close the Entra loopback listener.')) : resolve());
      closing.closeAllConnections();
    });
  };

  const authenticate = async () => {
    active();
    if (!pca) {
      let module = msal;
      if (!module) {
        try {
          module = await import('@azure/msal-node');
        } catch {
          throw error('INCOMPLETE_PLUGIN', 'The bundled Microsoft sign-in runtime is missing. Reinstall the complete Memory House plugin from its publisher.');
        }
      }
      active();
      pca = new module.PublicClientApplication({
        auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` },
        system: {
          networkClient: networkClient(fetchImpl, client.config.timeoutMs, client.config.maxResponseBytes),
          loggerOptions: { piiLoggingEnabled: false, logLevel: module.LogLevel?.Error ?? 0, loggerCallback: () => {} },
        },
      });
    }
    active();
    if (mode === 'device-code') {
      const result = await pca.acquireTokenByDeviceCode({
        scopes, cancelToken,
        deviceCodeCallback: response => {
          active();
          onMessage(deviceMessage(response));
        },
      });
      active();
      return result;
    }

    const callbackUrl = loopbackUrl(redirectUri);
    const fixedRedirect = callbackUrl.port && callbackUrl.port !== '0' ? redirectUri : null;
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let resolveCode;
    let rejectCode;
    let consumed = false;
    const callback = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    // A callback may arrive while MSAL/browser startup is still in flight.
    void callback.catch(() => {});
    server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', "default-src 'none'");
      const rejectRequest = (status, message) => { response.writeHead(status); response.end(message); };
      let incoming;
      try {
        incoming = new URL(request.url, callbackUrl);
      } catch {
        rejectRequest(400, 'Invalid callback.');
        return;
      }
      if (request.method !== 'GET' || request.headers.host !== callbackUrl.host || incoming.pathname !== callbackUrl.pathname) {
        rejectRequest(404, 'Not found.');
        return;
      }
      if (consumed || !sameState(incoming.searchParams.get('state'), state) || incoming.searchParams.getAll('state').length !== 1) {
        rejectRequest(400, 'Invalid sign-in state.');
        return;
      }
      if (incoming.searchParams.has('error')) {
        consumed = true;
        rejectRequest(400, 'Sign-in was not completed. Return to your terminal.');
        rejectCode(error('ENTRA_LOGIN_FAILED', 'Entra sign-in was denied or cancelled. Check tenant policy and try again.'));
        return;
      }
      const code = incoming.searchParams.get('code');
      if (typeof code !== 'string' || !code || code.length > 16 * 1024 || /[\x00-\x20\x7f]/.test(code)
          || incoming.searchParams.getAll('code').length !== 1) {
        rejectRequest(400, 'Invalid authorization response.');
        return;
      }
      consumed = true;
      response.end('Sign-in received. You can close this window and return to your terminal.');
      resolveCode(code);
    });
    const listener = server;
    await new Promise((resolve, reject) => {
      listener.once('error', () => reject(error('LOOPBACK_BIND_FAILED', 'Unable to bind the registered loopback redirect. Check whether its port is already in use.')));
      listener.listen({
        host: callbackUrl.hostname === '[::1]' ? '::1' : '127.0.0.1',
        port: callbackUrl.port ? Number(callbackUrl.port) : 0,
      }, resolve);
    });
    active();
    callbackUrl.port = String(listener.address().port);
    const selectedRedirect = fixedRedirect ?? callbackUrl.href;
    const authRequest = {
      scopes, redirectUri: selectedRedirect, state, responseMode: 'query',
      codeChallenge: challenge, codeChallengeMethod: 'S256',
    };
    const authUrl = httpsEntraUrl(await pca.getAuthCodeUrl(authRequest));
    active();
    if (['access_token', 'refresh_token', 'client_secret', 'code_verifier', 'code'].some(key => authUrl.searchParams.has(key))) {
      throw error('ENTRA_ENDPOINT_ERROR', 'Entra returned an unsafe sign-in URL.');
    }
    onMessage(`Sign in at ${authUrl.href}`);
    try {
      await openBrowser(authUrl.href, { signal: browserAbort.signal });
    } catch {
      throw error('BROWSER_LAUNCH_FAILED', 'Unable to open the sign-in browser. Start login again with a working browser.');
    }
    active();
    const code = await callback;
    active();
    await closeServer();
    const result = await pca.acquireTokenByCode({ scopes, redirectUri: selectedRedirect, code, codeVerifier: verifier });
    active();
    return result;
  };
  let token;
  try {
    const result = await Promise.race([authenticate(), deadline]);
    token = validateCredential(result?.accessToken, 'Entra access token');
  } catch (cause) {
    if (cause instanceof MemoryHouseError) throw cause;
    throw error('ENTRA_LOGIN_FAILED', 'Entra sign-in failed. Check the public-client registration, gateway scope, and tenant policy; device code may be disabled.');
  } finally {
    cancelled = true;
    cancelToken.cancel = true;
    browserAbort.abort();
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    await closeServer();
  }
  if (signal?.aborted) throw error('ENTRA_LOGIN_CANCELLED', 'Entra sign-in was cancelled.');
  return enrollWithEntraToken({ client, accessToken: token, fetch: fetchImpl });
}
