import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { createClient } from '../src/client.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';

const epoch = 1_800_000_000_000;
const pair = (suffix = '1', extra = {}) => ({
  access_token: `fake-access-${suffix}`, refresh_token: `fake-refresh-${suffix}`,
  token_type: 'HookToken', expires_in: 3600, refresh_expires_in: 86400, ...extra,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const absent = path => assert.rejects(access(path), { code: 'ENOENT' });

async function fixture(t, overrides = {}) {
  const root = resolve('test', `.client-fixture-${randomUUID()}`);
  const home = join(root, 'home');
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig({ home, deployment: fixtureDeployment(), env: {}, ...overrides });
  const calls = [];
  let handle = () => json(pair());
  let clock = epoch;
  const fetch = async (url, options) => {
    calls.push({ url, ...options });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return handle(url, options);
  };
  const options = { config, fetch, clock: () => clock };
  const client = createClient(options);
  return {
    root, home, config, calls, options, client,
    handler(value) { handle = value; },
    time(value) { clock = value; },
    async signIn() { await client.redeem('fake-enrollment'); calls.length = 0; },
  };
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return `http://127.0.0.1:${server.address().port}/inference/memory`;
}

test('redemption creates an atomic gateway-bound 0600 cache and returns only safe status', async t => {
  const f = await fixture(t);
  const result = await f.client.redeem('fake-enrollment');
  assert.equal(result.signedIn, true);
  assert.doesNotMatch(JSON.stringify(result), /fake-access|fake-refresh|fake-enrollment/);
  const cache = JSON.parse(await readFile(f.config.tokenPath, 'utf8'));
  assert.equal(cache.gateway_base, f.config.gatewayBase);
  assert.equal(cache.expires_at, epoch / 1000 + 3600);
  assert.equal(cache.refresh_expires_at, epoch / 1000 + 86400);
  assert.equal(cache.token_type, 'HookToken');
  assert.deepEqual(JSON.parse(f.calls[0].body), { enrollment_code: 'fake-enrollment' });
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.config.stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(f.config.tokenPath)).mode & 0o777, 0o600);
  }
  await absent(f.config.lockPath);
  assert.equal(await f.client.getAccessToken(), 'fake-access-1');
  assert.equal(f.calls.length, 1);
});

test('status is local-only and legacy environment credentials cannot create a sign-in', async t => {
  const f = await fixture(t);
  const client = createClient({ ...f.options, env: { AMT_ACCESS_TOKEN: 'fake-injected' } });
  assert.equal((await client.status()).signedIn, false);
  assert.equal((await client.status()).publisherConfigReady, true);
  assert.equal(f.calls.length, 0);
  await absent(f.config.stateDir);
  await assert.rejects(client.getAccessToken(), { code: 'NOT_SIGNED_IN' });
  assert.equal(f.calls.length, 0);
});

test('invalid token responses never replace usable credentials or report default success', async t => {
  const f = await fixture(t);
  await f.signIn();
  const original = await readFile(f.config.tokenPath, 'utf8');
  for (const bad of [{}, pair('2', { access_token: '' }), pair('2', { refresh_token: undefined }),
    pair('2', { token_type: 'Bearer' }), pair('2', { expires_in: undefined }),
    pair('2', { refresh_expires_in: undefined }), pair('2', { expires_in: '3600' }),
    pair('2', { expires_in: -1 }), pair('2', { access_token: 'fake-access\ninjected' })]) {
    f.handler(() => json(bad));
    await assert.rejects(f.client.redeem('fake-enrollment'), { code: 'INVALID_TOKEN_RESPONSE' });
    assert.equal(await readFile(f.config.tokenPath, 'utf8'), original);
    await absent(f.config.lockPath);
  }
});

test('concurrent refreshes reread the winning rotated pair within the lock', async t => {
  const f = await fixture(t);
  await f.signIn();
  f.time(epoch + 3_500_000);
  let refreshes = 0;
  f.handler(async (url, options) => {
    assert.equal(url, `${f.config.hookBase}/refresh`);
    assert.deepEqual(JSON.parse(options.body), { refresh_token: 'fake-refresh-1' });
    refreshes++;
    await delay(35);
    return json(pair('2'));
  });
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => f.client.getAccessToken())), Array(8).fill('fake-access-2'));
  assert.equal(refreshes, 1);
});

test('independent Node processes coordinate rotating credentials through the same private cache', async t => {
  let refreshes = 0;
  const gateway = await listen(t, async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    response.setHeader('Content-Type', 'application/json');
    if (request.url.endsWith('/redeem')) response.end(JSON.stringify(pair('1', { expires_in: 1 })));
    else if (request.url.endsWith('/refresh')) {
      assert.deepEqual(JSON.parse(raw), { refresh_token: 'fake-refresh-1' });
      refreshes++;
      await delay(70);
      response.end(JSON.stringify(pair('2')));
    } else { response.writeHead(404); response.end('{}'); }
  });
  const deployment = fixtureDeployment(gateway);
  const f = await fixture(t, { deployment, env: { MH_ALLOW_INSECURE_LOCALHOST: '1' } });
  await createClient({ config: f.config, clock: () => Date.now() - 10_000 }).redeem('fake-enrollment');
  const module = pathToFileURL(resolve('src/client.mjs')).href;
  const options = { deployment, stateDir: f.config.stateDir, home: f.home, env: { MH_ALLOW_INSECURE_LOCALHOST: '1' }, timeoutMs: 3000, lockTimeoutMs: 5000 };
  const source = `import {createClient} from ${JSON.stringify(module)}; const token=await createClient(${JSON.stringify(options)}).getAccessToken(); if(token!=='fake-access-2')process.exit(2); process.stdout.write('ok');`;
  const run = promisify(execFile);
  const results = await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ['--input-type=module', '-e', source], {
    cwd: f.root, timeout: 10_000, env: { PATH: process.env.PATH, HOME: f.home, USERPROFILE: f.home },
  })));
  assert.ok(results.every(result => result.stdout === 'ok' && !result.stderr));
  assert.equal(refreshes, 1);
});

test('only rejected refresh clears state; transient errors preserve it without revealing response contents', async t => {
  const f = await fixture(t);
  await f.signIn();
  f.time(epoch + 3_600_000);
  const original = await readFile(f.config.tokenPath, 'utf8');
  for (const status of [400, 404, 429, 500, 503]) {
    f.handler(() => json({ error: 'fake-server-secret' }, status));
    await assert.rejects(f.client.getAccessToken(), error => error.status === status && !error.message.includes('fake-server-secret'));
    assert.equal(await readFile(f.config.tokenPath, 'utf8'), original);
  }
  f.handler(() => { throw new Error('fake-refresh-secret'); });
  await assert.rejects(f.client.getAccessToken(), error => error.code === 'NETWORK_ERROR' && !error.message.includes('fake-refresh-secret'));
  f.handler(() => json({ error: 'fake-server-secret' }, 401));
  await assert.rejects(f.client.getAccessToken(), { code: 'REFRESH_REJECTED' });
  await absent(f.config.tokenPath);
});

test('unrotated and locally expired refresh credentials fail honestly', async t => {
  const f = await fixture(t);
  await f.signIn();
  f.time(epoch + 3_600_000);
  await assert.rejects(f.client.getAccessToken(), { code: 'INVALID_TOKEN_RESPONSE' });
  f.time(epoch + 86_401_000);
  const count = f.calls.length;
  await assert.rejects(f.client.getAccessToken(), { code: 'REFRESH_EXPIRED' });
  assert.equal(f.calls.length, count);
  await absent(f.config.tokenPath);
});

test('cached tokens cannot be sent to a different publisher gateway', async t => {
  const f = await fixture(t);
  await f.signIn();
  const config = loadConfig({ home: f.home, env: {}, deployment: fixtureDeployment('https://other.example/memory') });
  const client = createClient({ ...f.options, config });
  assert.equal((await client.status()).reason, 'gateway_mismatch');
  await assert.rejects(client.getAccessToken(), { code: 'GATEWAY_MISMATCH' });
  assert.equal(f.calls.length, 0);
  await assert.rejects(client.logout(), error => error.code === 'REVOCATION_FAILED' && error.localCleared === true);
  await absent(config.tokenPath);
});

test('logout waits for refresh and revokes the newest pair', async t => {
  const f = await fixture(t);
  await f.signIn();
  f.time(epoch + 3_600_000);
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const revoked = [];
  f.handler(async (url, options) => {
    if (url.endsWith('/refresh')) { entered(); await waiting; return json(pair('2')); }
    revoked.push(JSON.parse(options.body).refresh_token);
    return new Response(null, { status: 204 });
  });
  const refresh = f.client.getAccessToken();
  await started;
  const logout = f.client.logout();
  await delay(30);
  release();
  assert.equal(await refresh, 'fake-access-2');
  assert.equal((await logout).revoked, true);
  assert.deepEqual(revoked, ['fake-refresh-2']);
  await absent(f.config.tokenPath);
});

test('failed revoke still clears credentials and cannot claim immediate access-token invalidation', async t => {
  const f = await fixture(t);
  await f.signIn();
  f.handler(() => json({ error: 'fake-refresh-1' }, 503));
  await assert.rejects(f.client.logout(), error =>
    error.code === 'REVOCATION_FAILED' && error.localCleared && /may remain valid/.test(error.message) && !error.message.includes('fake-refresh-1'));
  await absent(f.config.tokenPath);
  assert.equal((await f.client.status()).signedIn, false);
});

test('capture and search expose only narrow request bodies and HookToken authentication', async t => {
  const f = await fixture(t);
  await f.signIn();
  f.handler(url => json(url.endsWith('/capture') ? { accepted: true } : { items: [] }));
  assert.deepEqual(await f.client.capture({ thread_id: 'test', role: 'agent', content: 'A note.', tenant_id: 'ignored' }), { accepted: true });
  assert.deepEqual(await f.client.search('query', 3), { items: [] });
  assert.deepEqual(JSON.parse(f.calls[0].body), { thread_id: 'test', role: 'agent', content: 'A note.' });
  assert.deepEqual(JSON.parse(f.calls[1].body), { query: 'query', top_k: 3 });
  assert.ok(f.calls.every(call => call.headers.Authorization === 'HookToken fake-access-1'));
  assert.deepEqual(Object.keys(f.client).sort(), ['capture', 'config', 'getAccessToken', 'getMemories', 'logout', 'redeem', 'search', 'status']);
});

test('memory listing uses the existing GET route with encoded repeated filters and shared HookToken auth', async t => {
  const f = await fixture(t);
  await f.signIn();
  f.handler(() => json({ items: [], count: 0, truncated: false }));
  assert.deepEqual(await f.client.getMemories(), { items: [], count: 0, truncated: false });
  await f.client.getMemories({
    recent_k: 200, memory_types: ['fact', 'procedural'], scopes: ['scope:team&recent_k=999', 'scope:org'], include_superseded: true,
  });
  assert.equal(f.calls[0].url, `${f.config.gatewayBase}/memories`);
  const filtered = new URL(f.calls[1].url);
  assert.equal(filtered.pathname, '/inference/memory/memories');
  assert.equal(filtered.searchParams.get('recent_k'), '200');
  assert.deepEqual(filtered.searchParams.getAll('memory_types'), ['fact', 'procedural']);
  assert.deepEqual(filtered.searchParams.getAll('scopes'), ['scope:team&recent_k=999', 'scope:org']);
  assert.equal(filtered.searchParams.get('include_superseded'), 'true');
  assert.ok(f.calls.every(call => call.method === 'GET' && call.body === undefined && call.headers.Authorization === 'HookToken fake-access-1'));
  await f.client.getMemories({ recent_k: 50 });
  assert.equal(f.calls[2].url, `${f.config.gatewayBase}/memories?recent_k=50`);
  await f.client.getMemories({ memory_types: ['fact'], scopes: ['scope:one'] });
  const defaultWithFilters = new URL(f.calls[3].url);
  assert.equal(defaultWithFilters.searchParams.has('recent_k'), false);
  assert.deepEqual([...defaultWithFilters.searchParams], [['memory_types', 'fact'], ['scopes', 'scope:one']]);
});

test('memory listing validates filters and rejects identity or endpoint overrides before auth or network', async t => {
  const f = await fixture(t);
  for (const options of [null, [], { recent_k: null }, { recent_k: 0 }, { recent_k: 201 }, { recent_k: '50' }, { recent_k: 1.5 },
    { memory_types: ['unknown'] }, { memory_types: 'fact' }, { memory_types: Array(4).fill('fact') },
    { scopes: 'scope:one' }, { scopes: [''] }, { scopes: ['two scopes'] }, { scopes: ['\u00e9'.repeat(129)] },
    { scopes: Array(21).fill('scope:one') }, { include_superseded: 'true' },
    { token: 'fake-secret' }, { user_id: 'other' }, { gatewayBase: 'https://other.example' }, { offset: 50 }]) {
    await assert.rejects(f.client.getMemories(options), { code: 'INVALID_PAYLOAD' });
  }
  assert.equal(f.calls.length, 0);
  await absent(f.config.stateDir);
});

test('listing validates truncation metadata and preserves safe transport failures without retry', async t => {
  const f = await fixture(t);
  await f.signIn();
  for (const bad of [{}, { items: [] }, { items: [], count: -1, truncated: false },
    { items: [], count: 0, truncated: 'false' }, { items: 'fake-secret', count: 1, truncated: false }]) {
    f.handler(() => json(bad));
    await assert.rejects(f.client.getMemories(), { code: 'INVALID_RESPONSE' });
  }
  f.handler(() => json({ error: 'fake-server-secret' }, 403));
  const before = f.calls.length;
  await assert.rejects(f.client.getMemories(), error =>
    error.status === 403 && !error.message.includes('fake-server-secret'));
  assert.equal(f.calls.length, before + 1);
});

test('invalid conversational payloads fail before authentication or network', async t => {
  const f = await fixture(t);
  for (const turn of [null, {}, { thread_id: '', role: 'user', content: 'a' }, { thread_id: 'a', role: 'system', content: 'b' },
    { thread_id: 'a', role: 'user', content: '' }]) await assert.rejects(f.client.capture(turn), { code: 'INVALID_PAYLOAD' });
  for (const topK of [0, -1, 101, 0.5, '8']) await assert.rejects(f.client.search('query', topK), { code: 'INVALID_PAYLOAD' });
  assert.equal(f.calls.length, 0);
  await absent(f.config.stateDir);
});

test('capture never retries and bounds ignored aborts and stalled response bodies', async t => {
  const f = await fixture(t, { timeoutMs: 30 });
  await f.signIn();
  const turn = { thread_id: 'test', role: 'user', content: 'A note.' };
  f.handler(() => json({ error: 'fake-secret' }, 401));
  await assert.rejects(f.client.capture(turn), error => error.status === 401 && !error.message.includes('fake-secret'));
  f.handler(() => new Promise(() => {}));
  await assert.rejects(f.client.capture(turn), { code: 'REQUEST_TIMEOUT' });
  let cancelled = false;
  f.handler(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(f.client.capture(turn), { code: 'REQUEST_TIMEOUT' });
  assert.equal(f.calls.length, 3);
  assert.equal(cancelled, true);
});

test('oversized and malformed responses fail without disclosing their bodies', async t => {
  const f = await fixture(t);
  await f.signIn();
  const client = createClient({ ...f.options, config: { ...f.config, maxResponseBytes: 40 } });
  f.handler(() => json({ content: 'fake-secret'.repeat(100) }));
  await assert.rejects(client.search('query'), { code: 'RESPONSE_TOO_LARGE' });
  f.handler(() => new Response('{ fake-secret'));
  await assert.rejects(client.search('query'), error => error.code === 'INVALID_RESPONSE' && !error.message.includes('fake-secret'));
  f.handler(() => json({ wrong: [] }));
  await assert.rejects(client.search('query'), { code: 'INVALID_RESPONSE' });
});

test('credential-bearing redirects are never followed', async t => {
  let redirected = 0;
  const gateway = await listen(t, async (request, response) => {
    if (request.url.endsWith('/redeem')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(pair())); }
    else if (request.url === '/evil') { redirected++; response.end('{}'); }
    else { response.writeHead(302, { Location: '/evil' }); response.end(); }
  });
  const f = await fixture(t, { deployment: fixtureDeployment(gateway), env: { MH_ALLOW_INSECURE_LOCALHOST: '1' }, timeoutMs: 1000 });
  const client = createClient({ config: f.config });
  await client.redeem('fake-enrollment');
  await assert.rejects(client.capture({ thread_id: 'test', role: 'user', content: 'A note.' }), { code: 'NETWORK_ERROR' });
  assert.equal(redirected, 0);
});

test('symlink credentials and state directories are not followed', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await mkdir(f.config.stateDir, { recursive: true });
  const target = join(f.root, 'untouched.json');
  await writeFile(target, 'untouched');
  await symlink(target, f.config.tokenPath);
  await assert.rejects(f.client.getAccessToken(), { code: 'UNSAFE_STATE' });
  await assert.rejects(f.client.redeem('fake-enrollment'), { code: 'UNSAFE_STATE' });
  assert.equal(await readFile(target, 'utf8'), 'untouched');
  assert.equal(f.calls.length, 0);
});

test('unknown locks time out without eviction or deleting another writer state', async t => {
  const f = await fixture(t, { lockTimeoutMs: 35 });
  await mkdir(f.config.lockPath, { recursive: true });
  const path = join(f.config.lockPath, 'unrelated.txt');
  await writeFile(path, 'untouched');
  await assert.rejects(f.client.redeem('fake-enrollment'), { code: 'LOCK_TIMEOUT' });
  assert.equal(await readFile(path, 'utf8'), 'untouched');
  assert.equal(f.calls.length, 0);
});

test('a replaced lock owner is not removed during cleanup', async t => {
  const f = await fixture(t);
  f.handler(async () => {
    await writeFile(join(f.config.lockPath, 'owner.json'), '{"nonce":"replacement","pid":1,"host":"other"}');
    return json(pair());
  });
  await assert.rejects(f.client.redeem('fake-enrollment'), { code: 'LOCK_OWNERSHIP_LOST' });
  assert.equal(JSON.parse(await readFile(join(f.config.lockPath, 'owner.json'), 'utf8')).nonce, 'replacement');
});

test('malformed credential caches never echo cached secrets', async t => {
  const f = await fixture(t);
  await mkdir(f.config.stateDir, { recursive: true });
  await writeFile(f.config.tokenPath, '{fake-access-secret');
  await assert.rejects(f.client.getAccessToken(), error => error.code === 'INVALID_CACHE' && !error.message.includes('fake-access-secret'));
  assert.equal(f.calls.length, 0);
});
