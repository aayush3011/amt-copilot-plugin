import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-node';
import { MemoryHouseError } from './errors.mjs';
import { atomicJson, ensureDirectory, readState, removeFile, withLock } from './state.mjs';
import { createCacheProtection } from './cache-protection.mjs';
import { openBrowserUrl } from './browser.mjs';
import { sendRequest } from './client.mjs';
import { validateEntraConfig } from './config.mjs';

const fail = (code, message) => new MemoryHouseError(code, message);
const required = () => fail('ENTRA_AUTH_REQUIRED', 'Sign in to Memory House with mh-login. Background requests never open a browser.');
const context = config => JSON.stringify([config.tenantId, config.clientId, config.scope]);

function authorityUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'login.microsoftonline.com' || url.username || url.password || url.hash) {
    throw fail('ENTRA_ENDPOINT_ERROR', 'Entra sign-in must use the Microsoft HTTPS authority.');
  }
  return url;
}

function networkClient(config, fetchImpl) {
  const send = async (url, options, method) => {
    authorityUrl(url);
    const response = await sendRequest({
      url, fetch: fetchImpl, method, headers: options?.headers ?? {}, bodyText: options?.body,
      timeoutMs: config.authTimeoutMs, maxResponseBytes: 1024 * 1024, acceptHttpErrors: true,
      operation: 'Entra authentication',
    });
    return { headers: Object.fromEntries(response.headers), body: response.data, status: response.status };
  };
  return {
    sendGetRequestAsync: (url, options) => send(url, options, 'GET'),
    sendPostRequestAsync: (url, options) => send(url, options, 'POST'),
  };
}

export async function browserSignIn(pca, config, { openBrowser = openBrowserUrl, timeoutMs = 180_000 } = {}) {
  const redirect = new URL(config.redirectUri);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const controller = new AbortController();
  let resolveCode, rejectCode, consumed = false, cancelled = false, timer;
  const callback = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  void callback.catch(() => {});
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    const deny = (status, message) => { response.writeHead(status); response.end(message); };
    let incoming;
    try { incoming = new URL(request.url, redirect); } catch { deny(400, 'Invalid callback.'); return; }
    if (request.method !== 'GET' || request.headers.host !== redirect.host || incoming.origin !== redirect.origin
      || incoming.pathname !== redirect.pathname) {
      deny(404, 'Not found.'); return;
    }
    const received = incoming.searchParams.get('state');
    if (consumed || incoming.searchParams.getAll('state').length !== 1 || typeof received !== 'string'
      || Buffer.byteLength(received) !== Buffer.byteLength(state)
      || !timingSafeEqual(Buffer.from(received), Buffer.from(state))) {
      deny(400, 'Invalid sign-in state.'); return;
    }
    if (incoming.searchParams.has('error')) {
      consumed = true;
      deny(400, 'Sign-in was not completed. Return to your terminal.');
      rejectCode(fail('ENTRA_LOGIN_FAILED', 'Microsoft sign-in was denied or cancelled. Retry mh-login when ready.'));
      return;
    }
    const code = incoming.searchParams.get('code');
    if (incoming.searchParams.getAll('code').length !== 1 || !code || code.length > 16 * 1024 || /[\x00-\x20\x7f]/.test(code)) {
      deny(400, 'Invalid authorization response.'); return;
    }
    consumed = true;
    response.end('Sign-in received. Return to your terminal to confirm completion.');
    resolveCode(code);
  });
  const active = () => {
    if (cancelled) throw fail('ENTRA_LOGIN_TIMEOUT', 'Microsoft sign-in timed out. Retry mh-login when ready.');
  };
  const work = async () => {
    await new Promise((resolve, reject) => {
      server.once('error', () => reject(fail('LOOPBACK_BIND_FAILED', 'Unable to bind the sign-in callback port. Close other sign-in attempts and retry.')));
      server.listen({ host: '127.0.0.1', port: Number(redirect.port), signal: controller.signal }, resolve);
    });
    active();
    const request = { scopes: [config.scope], redirectUri: config.redirectUri, state,
      responseMode: 'query', codeChallenge: challenge, codeChallengeMethod: 'S256', prompt: 'select_account' };
    const url = authorityUrl(await pca.getAuthCodeUrl(request));
    active();
    if (['access_token', 'refresh_token', 'client_secret', 'code_verifier', 'code'].some(key => url.searchParams.has(key))) {
      throw fail('ENTRA_ENDPOINT_ERROR', 'Entra returned an unsafe sign-in URL.');
    }
    await openBrowser(url.href, { signal: controller.signal });
    const code = await callback;
    active();
    return pca.acquireTokenByCode({ scopes: [config.scope], redirectUri: config.redirectUri, code, codeVerifier: verifier });
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cancelled = true;
      controller.abort();
      reject(fail('ENTRA_LOGIN_TIMEOUT', 'Microsoft sign-in timed out. Retry mh-login when ready.'));
    }, timeoutMs);
  });
  try { return await Promise.race([work(), deadline]); }
  finally {
    cancelled = true;
    controller.abort();
    clearTimeout(timer);
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

export async function acquireEntraToken(config, {
  interactive = false, env = process.env, protection = createCacheProtection(config, { env }), createApplication,
  openBrowser, fetch: fetchImpl = globalThis.fetch, clock = Date.now,
} = {}) {
  validateEntraConfig(config);
  await ensureDirectory(config.stateDir);
  return withLock(config.cacheLockPath, config.authTimeoutMs, async () => {
    try {
      const pca = createApplication ? await createApplication() : new PublicClientApplication({
        auth: { clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenantId}` },
        system: {
          tokenRenewalOffsetSeconds: config.tokenSkewSeconds,
          networkClient: networkClient(config, fetchImpl),
          loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
        },
      });
      const cache = pca.getTokenCache();
      const raw = await readState(config.cachePath, 2 * 1024 * 1024);
      let selected, originalCache;
      if (raw !== null) {
        try {
          const stored = JSON.parse(await protection.unprotect(JSON.parse(raw)));
          if (stored?.context !== context(config) || typeof stored.cache !== 'string' || typeof stored.accountId !== 'string') {
            throw fail('INVALID_CACHE', 'The sign-in cache does not match this deployment. Run mh-logout, then mh-login.');
          }
          cache.deserialize(stored.cache);
          selected = stored.accountId;
          originalCache = stored.cache;
        } catch (error) {
          if (error instanceof MemoryHouseError) throw error;
          throw fail('INVALID_CACHE', 'The sign-in cache is invalid. Run mh-logout, then mh-login.');
        }
      }
      let result;
      if (interactive) {
        result = await browserSignIn(pca, config, { openBrowser });
      } else {
        const account = selected ? await cache.getAccountByHomeId(selected) : null;
        if (!account) throw required();
        result = await pca.acquireTokenSilent({ account, scopes: [config.scope] });
      }
      const expiresAt = Math.floor(result?.expiresOn?.getTime() / 1000);
      if (typeof result?.accessToken !== 'string' || !/^[a-z\d._~+/-]+=*$/i.test(result.accessToken)
        || result.accessToken.length > 32 * 1024 || !result.account?.homeAccountId
        || result.tenantId?.toLowerCase() !== config.tenantId.toLowerCase()
        || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(clock() / 1000) + config.tokenSkewSeconds) {
        throw fail('ENTRA_TOKEN_INVALID', 'Microsoft did not return a usable gateway access token. Retry mh-login.');
      }
      const serialized = cache.serialize();
      // Persist renewals while holding the cross-process lock, including rotated refresh tokens.
      if (interactive || serialized !== originalCache) {
        await atomicJson(config.cachePath, await protection.protect(JSON.stringify({
          context: context(config), accountId: result.account.homeAccountId, cache: serialized,
        })));
      }
      return { accessToken: result.accessToken, expiresAt };
    } catch (error) {
      if (error instanceof MemoryHouseError) throw error;
      if (error instanceof InteractionRequiredAuthError || ['invalid_grant', 'no_tokens_found', 'no_account_in_silent_request'].includes(error.errorCode)) {
        throw required();
      }
      throw fail('ENTRA_AUTH_FAILED', 'Microsoft authentication failed. Check connectivity, app registration, gateway consent and tenant policy, then retry mh-login.');
    }
  });
}

export async function clearEntraCache(config) {
  await ensureDirectory(config.stateDir);
  await withLock(config.cacheLockPath, config.lockTimeoutMs, () => removeFile(config.cachePath));
}
