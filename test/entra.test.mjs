import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireEntraToken, browserSignIn } from '../src/entra.mjs';
import { createCacheProtection, runSecretTool } from '../src/cache-protection.mjs';
import { createClient } from '../src/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { MemoryHouseError } from '../src/errors.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { fixtureIdToken, seedEntraSession } from './helpers/entra.mjs';
import { isolatedEnvironment } from './helpers/runtime.mjs';

async function setup(t, options = {}) {
  const env = await isolatedEnvironment(t);
  const config = loadConfig({ env, deployment: fixtureDeployment(), ...options });
  return { env, config };
}
const result = config => ({
  accessToken: 'fixture-access-1', expiresOn: new Date(Date.now() + 3600_000),
  tenantId: config.tenantId, account: { homeAccountId: 'fixture-account' },
});
const protection = config => createCacheProtection(config, {
  platform: 'linux', run: async () => ({ code: 0, stdout: 'ab'.repeat(32), hasError: false }),
});
async function callbackConfig(t) {
  const { config } = await setup(t);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return { ...config, redirectUri: `http://127.0.0.1:${port}` };
}
const authUrl = request => `https://login.microsoftonline.com/authorize?${new URLSearchParams({ state: request.state })}`;

test('real MSAL reuses the protected cache across fresh providers without network or browser access', async t => {
  const { env } = await setup(t);
  const config = await seedEntraSession(env);
  for (let i = 0; i < 2; i++) {
    const value = await acquireEntraToken(config, { env,
      fetch: () => assert.fail('cached access token must not need the network'),
      openBrowser: () => assert.fail('background acquisition must never prompt'),
    });
    assert.equal(value.accessToken, 'fixture-access-1');
  }
  assert.doesNotMatch(await readFile(config.cachePath, 'utf8'), /fixture-access|fixture-user/);
});

test('browser login uses PKCE and rejects wrong state, host, path and duplicate codes', async t => {
  const config = await callbackConfig(t);
  let request, redeemed;
  const pca = {
    getAuthCodeUrl: async value => { request = value; return authUrl(value); },
    acquireTokenByCode: async value => { redeemed = value; return result(config); },
  };
  const value = await browserSignIn(pca, config, { openBrowser: async url => {
    assert.equal(new URL(url).hostname, 'login.microsoftonline.com');
    for (const suffix of ['?state=wrong&code=fixture-code', `?state=${request.state}&code=one&code=two`]) {
      assert.equal((await fetch(config.redirectUri + suffix)).status, 400);
    }
    assert.equal((await fetch(`${config.redirectUri}/wrong?state=${request.state}&code=fixture-code`)).status, 404);
    const response = await fetch(`${config.redirectUri}?state=${request.state}&code=fixture-code`);
    assert.equal(response.status, 200);
  } });
  assert.equal(value.accessToken, 'fixture-access-1');
  assert.equal(request.prompt, 'select_account');
  assert.equal(request.codeChallengeMethod, 'S256');
  assert.equal(request.codeChallenge, createHash('sha256').update(redeemed.codeVerifier).digest('base64url'));
  assert.equal(redeemed.code, 'fixture-code');
  await assert.rejects(fetch(config.redirectUri));
});

test('real MSAL silently refreshes expired tokens and persists rotated renewal state', async t => {
  const { env } = await setup(t);
  const config = await seedEntraSession(env, fixtureDeployment(), 'fixture-expired-access',
    { expired: true, refreshToken: 'fixture-refresh-original' });
  let renewals = 0;
  const value = await acquireEntraToken(config, { env, openBrowser: () => assert.fail('refresh must not prompt'),
    fetch: async (url, options) => {
      assert.equal(new URL(url).hostname, 'login.microsoftonline.com');
      if (options.method === 'POST') {
        renewals++;
        const form = new URLSearchParams(options.body);
        assert.equal(form.get('grant_type'), 'refresh_token');
        assert.equal(form.get('refresh_token'), 'fixture-refresh-original');
        assert.ok(form.get('scope').split(' ').includes(config.scope));
        return Response.json({ token_type: 'Bearer', scope: config.scope, expires_in: 3600,
          id_token: fixtureIdToken(config),
          client_info: Buffer.from(JSON.stringify({ uid: 'fixture-user', utid: config.tenantId })).toString('base64url'),
          access_token: 'fixture-access-renewed', refresh_token: 'fixture-refresh-rotated' });
      }
      if (url.includes('/discovery/instance')) {
        return Response.json({ tenant_discovery_endpoint: `https://login.microsoftonline.com/${config.tenantId}/v2.0/.well-known/openid-configuration`,
          metadata: [{ preferred_network: 'login.microsoftonline.com', preferred_cache: 'login.microsoftonline.com',
            aliases: ['login.microsoftonline.com'] }] });
      }
      return Response.json({ authorization_endpoint: `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize`,
        token_endpoint: `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
        issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
        end_session_endpoint: `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/logout`,
        jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys' });
    } });
  assert.equal(value.accessToken, 'fixture-access-renewed');
  assert.equal(renewals, 1);
  const encrypted = JSON.parse(await readFile(config.cachePath, 'utf8'));
  const stored = JSON.parse(await createCacheProtection(config, { env }).unprotect(encrypted));
  assert.match(stored.cache, /fixture-refresh-rotated/);
  assert.doesNotMatch(JSON.stringify(encrypted), /fixture-refresh|fixture-access/);
});

test('browser cancellation, bind failure and timeout clean up without leaking provider details', async t => {
  const config = await callbackConfig(t);
  const pca = { getAuthCodeUrl: async request => authUrl(request) };
  await assert.rejects(browserSignIn(pca, config, { openBrowser: async url => {
    const state = new URL(url).searchParams.get('state');
    await fetch(`${config.redirectUri}?state=${state}&error=denied&error_description=provider-secret`);
  } }), error => error.code === 'ENTRA_LOGIN_FAILED' && !error.message.includes('provider-secret'));
  await assert.rejects(browserSignIn(pca, config, { timeoutMs: 40, openBrowser: async () => {} }), { code: 'ENTRA_LOGIN_TIMEOUT' });
  await assert.rejects(fetch(config.redirectUri));
  const busy = createServer();
  await new Promise(resolve => busy.listen(Number(new URL(config.redirectUri).port), '127.0.0.1', resolve));
  try { await assert.rejects(browserSignIn(pca, config), { code: 'LOOPBACK_BIND_FAILED' }); }
  finally { await new Promise(resolve => busy.close(resolve)); }
});

test('interactive sign-in persists encrypted state, silent renewal persists refresh rotation, logout deletes it', async t => {
  const config = await callbackConfig(t);
  const protectedCache = protection(config);
  let serialized = 'initial', silent = 0, interactive = 0;
  const cache = { deserialize: value => { serialized = value; }, serialize: () => serialized,
    getAccountByHomeId: async homeAccountId => ({ homeAccountId }) };
  const pca = { getTokenCache: () => cache, getAuthCodeUrl: async request => authUrl(request),
    acquireTokenByCode: async () => { interactive++; serialized = 'fixture-refresh-original'; return result(config); },
    acquireTokenSilent: async () => { silent++; serialized = 'fixture-refresh-rotated'; return result(config); } };
  const options = { protection: protectedCache, createApplication: () => pca };
  await assert.rejects(acquireEntraToken(config, options), { code: 'ENTRA_AUTH_REQUIRED' });
  await acquireEntraToken(config, { ...options, interactive: true, openBrowser: async url => {
    const state = new URL(url).searchParams.get('state');
    await fetch(`${config.redirectUri}?state=${state}&code=fixture-code`);
  } });
  await acquireEntraToken(config, { ...options, openBrowser: () => assert.fail('must stay silent') });
  const encrypted = JSON.parse(await readFile(config.cachePath, 'utf8'));
  assert.doesNotMatch(JSON.stringify(encrypted), /fixture-refresh|fixture-access/);
  assert.equal(JSON.parse(await protectedCache.unprotect(encrypted)).cache, 'fixture-refresh-rotated');
  assert.equal(interactive, 1);
  assert.equal(silent, 1);
  await createClient({ config }).logout();
  await assert.rejects(access(config.cachePath), { code: 'ENOENT' });
});

test('malformed, expired and wrong-tenant results fail safely; interaction-required never opens a browser', async t => {
  const { config } = await setup(t);
  const protectedCache = protection(config);
  await mkdir(config.stateDir);
  await writeFile(config.cachePath, JSON.stringify(await protectedCache.protect(JSON.stringify({
    context: JSON.stringify([config.tenantId, config.clientId, config.scope]), accountId: 'fixture-account', cache: '{}',
  }))));
  for (const extra of [{ accessToken: '' }, { accessToken: 'secret\nheader' }, { accessToken: 'x'.repeat(32 * 1024 + 1) },
    { expiresOn: new Date(1) }, { tenantId: 'other' }, { account: null }]) {
    await assert.rejects(acquireEntraToken(config, { protection: protectedCache, createApplication: () => ({
      getTokenCache: () => ({ deserialize() {}, serialize: () => '{}', getAccountByHomeId: async () => ({}) }),
      acquireTokenSilent: async () => ({ ...result(config), ...extra }),
    }) }), error => error.code === 'ENTRA_TOKEN_INVALID' && !error.message.includes('secret'));
  }
  await assert.rejects(acquireEntraToken(config, { protection: protectedCache, openBrowser: () => assert.fail('must stay silent'),
    createApplication: () => ({
      getTokenCache: () => ({ deserialize() {}, getAccountByHomeId: async () => ({}) }),
      acquireTokenSilent: async () => { throw Object.assign(new Error('provider-secret'), { errorCode: 'invalid_grant' }); },
    }),
  }), error => error.code === 'ENTRA_AUTH_REQUIRED' && !error.message.includes('provider-secret'));
});

test('cache protection authenticates ciphertext and stores Unix keys only through stdin', async t => {
  const { config } = await setup(t);
  for (const platform of ['darwin', 'linux']) {
    let key;
    const calls = [];
    const secure = createCacheProtection(config, { platform, run: async (file, args, input) => {
      calls.push({ args, input });
      if (args[0] === '-i' || args[0] === 'store') {
        key = platform === 'darwin' ? input.match(/-w ([a-f\d]{64})/)[1] : input;
        return { code: 0 };
      }
      return key ? { code: 0, stdout: key } : { code: platform === 'darwin' ? 44 : 1, hasError: false };
    } });
    const encrypted = await secure.protect('fixture-refresh-secret');
    assert.equal(await secure.unprotect(encrypted), 'fixture-refresh-secret');
    assert.ok(calls.every(call => !call.args.join(' ').includes(key)));
    await assert.rejects(secure.unprotect({ ...encrypted, tag: Buffer.alloc(16).toString('base64') }), { code: 'SECURE_CACHE_UNAVAILABLE' });
    const locked = createCacheProtection(config, { platform, run: async () => ({ code: 1, hasError: true }) });
    await assert.rejects(locked.protect('fixture-secret'), { code: 'SECURE_CACHE_UNAVAILABLE' });
  }
});

test('secure-tool failures are bounded and sanitize subprocess diagnostics', async () => {
  await assert.rejects(runSecretTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], '', 30), { code: 'SECURE_CACHE_UNAVAILABLE' });
  await assert.rejects(runSecretTool('memory-house-missing-fixture-tool', [], '', 1000), { code: 'SECURE_CACHE_UNAVAILABLE' });
});

test('client deduplicates acquisition and renews near expiry', async t => {
  const { config } = await setup(t);
  let now = 1_800_000_000_000, acquisitions = 0;
  const client = createClient({ config, clock: () => now, acquireToken: async () => {
    acquisitions++; await delay(20);
    return { accessToken: `fixture-access-${acquisitions}`, expiresAt: now / 1000 + 3600 };
  } });
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => client.getAccessToken())), Array(6).fill('fixture-access-1'));
  now += 3_500_000;
  assert.equal(await client.getAccessToken(), 'fixture-access-2');
  assert.equal(acquisitions, 2);
});

test('logout blocks ongoing acquisition and other clients until explicit login', async t => {
  const { config } = await setup(t);
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const options = { config, acquireToken: async () => {
    entered(); await pending;
    return { accessToken: 'fixture-access-1', expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  } };
  const client = createClient(options);
  const request = client.getAccessToken();
  await enteredPromise;
  await createClient(options).logout();
  release();
  await assert.rejects(request, { code: 'NOT_SIGNED_IN' });
  await assert.rejects(client.getAccessToken(), { code: 'NOT_SIGNED_IN' });
  assert.equal((await client.login()).signedIn, true);
  assert.equal(await client.getAccessToken(), 'fixture-access-1');
  assert.doesNotMatch(await readFile(config.authStatePath, 'utf8'), /fixture-access|refresh/);
});

test('login cannot be overwritten by an older in-flight acquisition', async t => {
  const { config } = await setup(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const client = createClient({ config, acquireToken: async (settings, options) => {
    if (!options?.interactive) { entered(); await new Promise(resolve => { release = resolve; }); }
    return { accessToken: options?.interactive ? 'fixture-new-account' : 'fixture-old-account',
      expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  } });
  const old = client.getAccessToken();
  await started;
  await client.login();
  release();
  await assert.rejects(old, { code: 'NOT_SIGNED_IN' });
  assert.equal(await client.getAccessToken(), 'fixture-new-account');
});

test('explicit login invalidates cached tokens in other long-lived clients', async t => {
  const { config } = await setup(t);
  let account = 'one';
  const options = { config, acquireToken: async () => ({
    accessToken: `fixture-account-${account}`, expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }) };
  const canvas = createClient(options), helper = createClient(options);
  await helper.login();
  assert.equal(await canvas.getAccessToken(), 'fixture-account-one');
  account = 'two';
  await helper.login();
  assert.equal(await canvas.getAccessToken(), 'fixture-account-two');
});

test('legacy credentials are ignored and removed only on explicit login or logout', async t => {
  const { config } = await setup(t);
  await mkdir(config.stateDir);
  const legacy = join(config.stateDir, 'token.json');
  await writeFile(legacy, 'legacy-secret-not-json');
  const denied = createClient({ config, acquireToken: async () => { throw new MemoryHouseError('ENTRA_AUTH_REQUIRED', 'Sign in.'); } });
  assert.equal((await denied.status()).signedIn, false);
  assert.equal(await readFile(legacy, 'utf8'), 'legacy-secret-not-json');
  const client = createClient({ config, acquireToken: async () => ({
    accessToken: 'fixture-access-1', expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }) });
  await client.login();
  await assert.rejects(access(legacy), { code: 'ENOENT' });
  await writeFile(legacy, 'legacy-secret');
  await client.logout();
  await assert.rejects(access(legacy), { code: 'ENOENT' });
});
