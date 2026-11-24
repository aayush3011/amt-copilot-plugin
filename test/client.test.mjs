import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createClient } from '../src/client.mjs';
import { sameFile } from '../src/state.mjs';
import { enqueueTurn, queueDirectory } from '../src/capture-queue.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';

const epoch = 1_800_000_000_000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const absent = path => assert.rejects(access(path), { code: 'ENOENT' });

async function fixture(t, overrides = {}) {
  const root = resolve('test', `.client-fixture-${randomUUID()}`);
  const home = join(root, 'home');
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig({ home, deployment: fixtureDeployment(), env: {}, ...overrides });
  const calls = [];
  let handle = () => json({});
  let clock = epoch;
  // The Microsoft account that sign-in and token requests report.
  let objectId = 'fixture-user-1';
  const fetch = async (url, options) => {
    calls.push({ url, ...options });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return handle(url, options);
  };
  const options = { config, fetch, clock: () => clock, acquireToken: async () => ({
    accessToken: 'fake-access-1', expiresAt: Math.floor(clock / 1000) + 3600, ...(objectId ? { objectId } : {}),
  }) };
  const client = createClient(options);
  return {
    root, home, config, calls, options, client,
    handler(value) { handle = value; },
    time(value) { clock = value; },
    account(value) { objectId = value; },
    async signIn() { await client.login(); calls.length = 0; },
  };
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return `http://127.0.0.1:${server.address().port}/inference/memory`;
}

test('capture and search expose only narrow request bodies and Bearer authentication', async t => {
  const f = await fixture(t);
  await f.signIn();
  const inserted = { request_id: 'request-1', kind: 'insert', status: 'succeeded', result: { items: [{ index: 0, id: 'turn-1', status: 'stored' }] } };
  f.handler(url => json(url.endsWith('/memory') ? inserted : { items: [], count: 0 }, url.endsWith('/memory') ? 201 : 200));
  assert.deepEqual(await f.client.capture({ thread_id: 'test', role: 'agent', content: 'A note.', tenant_id: 'ignored' }), inserted);
  assert.deepEqual(await f.client.search('query', 3), { items: [], count: 0 });
  assert.deepEqual(JSON.parse(f.calls[0].body), { extract: true, thread_id: 'test', items: [{ role: 'agent', content: 'A note.' }] });
  assert.deepEqual(JSON.parse(f.calls[1].body), { query: 'query', top_k: 3 });
  // HookToken-only /hook/* routes are not used: Entra-authenticated capture and search use the data routes.
  assert.deepEqual(f.calls.map(call => [call.method, call.url]), [
    ['POST', `${f.config.gatewayBase}/memory`], ['POST', `${f.config.gatewayBase}/search`]]);
  await f.client.search('query', 50);
  assert.equal(JSON.parse(f.calls[2].body).top_k, 50);
  assert.ok(f.calls.every(call => call.headers.Authorization === 'Bearer fake-access-1'));
  assert.deepEqual(Object.keys(f.client).sort(), ['capture', 'captureIdentity', 'config', 'getAccessToken', 'getMemories', 'login', 'logout', 'recordAccount', 'search', 'status', 'telemetryEnrollment', 'telemetryReview', 'telemetrySubmit']);
  await f.client.search('query');
  assert.equal(JSON.parse(f.calls[3].body).top_k, 5);
});

test('separate MCP configuration keeps REST requests and token audiences independent', async t => {
  const f = await fixture(t, { deployment: { ...fixtureDeployment(), mcpUrl: 'https://mcp.example/mcp/memoryhouse' } });
  const resources = [];
  const client = createClient({ ...f.options, acquireToken: async (_config, { resource }) => {
    resources.push(resource);
    return { accessToken: `fake-${resource}`, expiresAt: Math.floor(epoch / 1000) + 3600 };
  } });
  f.handler(() => json({ items: [], count: 0 }));
  assert.equal(await client.getAccessToken('mcp'), 'fake-mcp');
  await client.search('query');
  assert.deepEqual(resources, ['mcp', 'gateway']);
  assert.equal(f.calls[0].url, `${f.config.gatewayBase}/search`);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer fake-gateway');
  for (const mcpUrl of ['http://remote.example/mcp', 'https://user:secret@mcp.example/mcp', 'https://mcp.example/?token=secret']) {
    assert.throws(() => createClient({ ...f.options, config: { ...f.config, mcpUrl } }), error =>
      ['INVALID_GATEWAY', 'INSECURE_GATEWAY'].includes(error.code));
  }
});

test('batched capture keeps turn order, carries an idempotency key and is bound to the queuing account', async t => {
  const f = await fixture(t);
  assert.equal(await f.client.captureIdentity(), null);
  await f.signIn();
  const identity = await f.client.captureIdentity();
  assert.match(identity.generation, /^[a-f\d-]{36}$/);
  assert.match(identity.binding, /^[a-f\d]{64}$/);
  assert.equal(identity.tenantId, '33333333-3333-3333-3333-333333333333');
  f.handler(() => json({ status: 'succeeded' }, 201));
  const items = [{ role: 'user', content: 'One.' }, { role: 'agent', content: 'Two.' }];
  await f.client.capture({ thread_id: 'test', items }, { idempotencyKey: 'mh-capture-abc', binding: identity.binding });
  assert.deepEqual(JSON.parse(f.calls[0].body), { extract: true, thread_id: 'test', items });
  assert.equal(f.calls[0].headers['Idempotency-Key'], 'mh-capture-abc');
  assert.equal(f.calls[0].headers.Authorization, 'Bearer fake-access-1');
  await assert.rejects(f.client.capture({ thread_id: 'test', items }, { binding: 'f'.repeat(64) }), { code: 'NOT_SIGNED_IN' });
  for (const turn of [{ thread_id: 'test', items: [] }, { thread_id: 'test', items: Array(51).fill(items[0]) },
    { thread_id: 'test', items: [items[0], { role: 'system', content: 'x' }] }, { thread_id: 'test', items: 'not-a-list' }]) {
    await assert.rejects(f.client.capture(turn), { code: 'INVALID_PAYLOAD' });
  }
  await assert.rejects(f.client.capture({ thread_id: 'test', items }, { idempotencyKey: 'not a key' }), { code: 'INVALID_PAYLOAD' });
  assert.equal(f.calls.length, 1);
  // Signing out discards turns queued under this sign-in and ends capture.
  const sealing = { async protect(text) { return { data: Buffer.from(text).toString('base64') }; } };
  await enqueueTurn({ stateDir: f.config.stateDir, gatewayBase: f.config.gatewayBase, protection: sealing,
    account: identity.binding, threadId: 'test', role: 'user', content: 'Queued.' });
  assert.match((await f.client.logout()).message, /unsent captured turns discarded/);
  assert.equal(await f.client.captureIdentity(), null);
  assert.deepEqual((await readdir(queueDirectory(f.config.stateDir))).filter(name => name.endsWith('.json')), []);
});

test('queued captures stay with the account across sign-ins, and a sign-out ends them', async t => {
  const f = await fixture(t);
  await f.signIn();
  const first = await f.client.captureIdentity();
  const state = JSON.parse(await readFile(f.config.authStatePath, 'utf8'));
  assert.equal(state.objectId, 'fixture-user-1');
  assert.match(state.captureEpoch, /^[a-f\d-]{36}$/);
  assert.doesNotMatch(JSON.stringify(state), /fake-access/);
  // Signing in again with the same account, as after an expired sign-in, keeps the binding.
  await f.signIn();
  const again = await f.client.captureIdentity();
  assert.notEqual(again.generation, first.generation);
  assert.equal(again.binding, first.binding);
  f.handler(() => json({}, 201));
  await f.client.capture({ thread_id: 'test', role: 'user', content: 'Queued earlier.' }, { binding: first.binding });
  // Another account, or a sign-in after a sign-out, binds afresh; other processes see the same binding.
  f.account('fixture-user-2');
  await f.signIn();
  const other = await f.client.captureIdentity();
  assert.notEqual(other.binding, first.binding);
  await assert.rejects(f.client.capture({ thread_id: 'test', role: 'user', content: 'Not mine.' }, { binding: first.binding }),
    { code: 'NOT_SIGNED_IN' });
  assert.equal((await createClient(f.options).captureIdentity()).binding, other.binding);
  await f.client.logout();
  await f.signIn();
  assert.notEqual((await f.client.captureIdentity()).binding, other.binding);
});

test('a sign-in without a recorded account binds captures to that sign-in only', async t => {
  const f = await fixture(t);
  f.account(null);
  await f.signIn();
  const first = await f.client.captureIdentity();
  assert.equal(JSON.parse(await readFile(f.config.authStatePath, 'utf8')).objectId, undefined);
  await f.signIn();
  assert.notEqual((await f.client.captureIdentity()).binding, first.binding);
  // An earlier plugin's sign-in has no account either; malformed account fields are ignored, never trusted.
  const state = JSON.parse(await readFile(f.config.authStatePath, 'utf8'));
  for (const extra of [{}, { objectId: 'fixture-user-1' }, { objectId: 'bad id', captureEpoch: '11111111-2222-4333-8444-555555555555' },
    { objectId: 'fixture-user-1', captureEpoch: 'not-an-epoch' }]) {
    await writeFile(f.config.authStatePath, JSON.stringify({ ...state, ...extra }));
    assert.equal((await f.client.captureIdentity()).binding,
      createHash('sha256').update(JSON.stringify(['sign-in', state.generation])).digest('hex'));
  }
  // A new sign-in cannot prove the earlier sign-in's account, so it starts a new account binding.
  f.account('fixture-user-1');
  await f.signIn();
  const upgraded = await f.client.captureIdentity();
  await f.signIn();
  assert.equal((await f.client.captureIdentity()).binding, upgraded.binding);
});

test('queued turns are never sent with a token for another account', async t => {
  const f = await fixture(t);
  await f.signIn();
  const { binding } = await f.client.captureIdentity();
  f.handler(() => json({}, 201));
  // A fresh process whose cached Microsoft account changed (for example mid sign-in) before the sign-in state did.
  f.account('fixture-user-2');
  const sender = createClient(f.options);
  await assert.rejects(sender.capture({ thread_id: 'test', role: 'user', content: 'Queued.' }, { binding }), { code: 'NOT_SIGNED_IN' });
  // A token whose account is unknown is not trusted either.
  f.account(null);
  await assert.rejects(createClient(f.options).capture({ thread_id: 'test', role: 'user', content: 'Queued.' }, { binding }),
    { code: 'NOT_SIGNED_IN' });
  await sender.capture({ thread_id: 'test', role: 'user', content: 'A direct capture.' });
  assert.equal(f.calls.length, 1);
});

test('a sign-in without a recorded account never sends queued turns until its account is recorded', async t => {
  const f = await fixture(t);
  f.account(null);
  await f.signIn();
  const legacy = await f.client.captureIdentity();
  assert.equal(legacy.accountBound, false);
  f.handler(() => json({}, 201));
  const turn = { thread_id: 'test', role: 'user', content: 'Queued.' };
  const sent = () => f.calls.filter(call => call.url.endsWith('/memory')).length;
  // Unchanged state and no sign-in in progress: the token cannot be matched to the queuing account either way.
  for (const objectId of [null, 'fixture-user-1', 'fixture-user-2']) {
    f.account(objectId);
    await assert.rejects(createClient(f.options).capture(turn, { binding: legacy.binding }), { code: 'NOT_SIGNED_IN' });
  }
  // A sender records the cached account once, with a new generation so that every client drops older tokens.
  let acquisitions = 0;
  const canvas = createClient({ ...f.options, acquireToken: async (...args) => { acquisitions++; return f.options.acquireToken(...args); } });
  await canvas.getAccessToken();
  await canvas.getAccessToken();
  assert.equal(acquisitions, 1);
  f.account(null);
  assert.equal(await createClient(f.options).recordAccount(), false);
  f.account('fixture-user-2');
  const sender = createClient(f.options);
  assert.equal(await sender.recordAccount(), true);
  await canvas.getAccessToken();
  assert.equal(acquisitions, 2);
  const state = JSON.parse(await readFile(f.config.authStatePath, 'utf8'));
  assert.equal(state.objectId, 'fixture-user-2');
  assert.notEqual(state.generation, legacy.generation);
  assert.equal((await f.client.captureIdentity()).generation, state.generation);
  const bound = await sender.captureIdentity();
  assert.equal(bound.accountBound, true);
  assert.notEqual(bound.binding, legacy.binding);
  await assert.rejects(sender.capture(turn, { binding: legacy.binding }), { code: 'NOT_SIGNED_IN' });
  await sender.capture(turn, { binding: bound.binding });
  assert.equal(sent(), 1);
  assert.equal(await sender.recordAccount(), true);
  assert.equal(JSON.parse(await readFile(f.config.authStatePath, 'utf8')).captureEpoch, state.captureEpoch);
  await sender.logout();
  assert.equal(await sender.recordAccount(), false);
});

test('capture errors carry the problem code and retry delay, never the problem text', async t => {
  let reply = () => {};
  const gateway = await listen(t, (request, response) => {
    if (request.url.endsWith('/whoami')) { response.writeHead(404).end(); return; }
    request.resume();
    request.on('end', () => reply(response));
  });
  const f = await fixture(t, { deployment: fixtureDeployment(gateway), env: { MH_ALLOW_INSECURE_LOCALHOST: '1' }, timeoutMs: 2000 });
  const client = createClient({ config: f.config, acquireToken: f.options.acquireToken });
  await client.login();
  const problem = (status, body, headers = {}) => response => {
    response.writeHead(status, { 'Content-Type': 'application/problem+json', ...headers });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const turn = { thread_id: 'test', role: 'user', content: 'A note.' };
  const failure = () => client.capture(turn).then(() => assert.fail('capture must fail'), error => error);
  reply = problem(409, { code: 'reset_in_progress', retry_after: 5, detail: 'fake-problem-secret' }, { 'Retry-After': '7' });
  let error = await failure();
  assert.deepEqual([error.code, error.status, error.problem, error.retryAfterSeconds], ['HTTP_ERROR', 409, 'reset_in_progress', 7]);
  assert.doesNotMatch(error.message, /fake-problem-secret|reset_in_progress/);
  reply = problem(409, { code: 'IDEMPOTENCY_CONFLICT', retry_after: 5 });
  error = await failure();
  assert.deepEqual([error.problem, error.retryAfterSeconds], ['idempotency_conflict', 5]);
  // Capture reads up to 64 KiB of an error body, enough for a failed request's record.
  for (const body of [{ code: 'not a code' }, 'not json', { code: 'x'.repeat(65) }, { code: 'big', detail: 'x'.repeat(70_000) }]) {
    reply = problem(409, body);
    error = await failure();
    assert.equal(error.status, 409);
    assert.equal(error.problem, undefined);
  }
  reply = problem(503, { code: 'unavailable' });
  await assert.rejects(client.search('query'), error => error.status === 503 && error.problem === undefined);
});

test('a request the engine finished as failed is recognized by its record, with or without an error code, never its message', async t => {
  let reply = () => {};
  const gateway = await listen(t, (request, response) => {
    if (request.url.endsWith('/whoami')) { response.writeHead(404).end(); return; }
    request.resume();
    request.on('end', () => reply(response));
  });
  const f = await fixture(t, { deployment: fixtureDeployment(gateway), env: { MH_ALLOW_INSECURE_LOCALHOST: '1' }, timeoutMs: 2000 });
  const client = createClient({ config: f.config, acquireToken: f.options.acquireToken });
  await client.login();
  // The gateway answers with the request's record, which lists its items: larger than a problem document.
  const record = (status, overrides = {}) => response => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      request_id: 'fixture-request-7', kind: 'insert', status: 'failed', replayed: true,
      error: { code: 'internal_error', message: 'fake-failure-secret' },
      result: { items: Array.from({ length: 50 }, (_, index) => ({ index, status: 'failed', note: 'x'.repeat(600) })) },
      ...overrides,
    }));
  };
  const failure = () => client.capture({ thread_id: 'test', role: 'user', content: 'A note.' })
    .then(() => assert.fail('capture must fail'), error => error);
  reply = record(503);
  let error = await failure();
  assert.equal(error.status, 503);
  assert.deepEqual(error.requestFailure, { code: 'internal_error', requestId: 'fixture-request-7' });
  assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /fake-failure-secret/);
  reply = record(409, { error: { code: 'write_conflict' } });
  assert.deepEqual((await failure()).requestFailure, { code: 'write_conflict', requestId: 'fixture-request-7' });
  reply = record(504, { request_id: 'not a request id', error: { code: 'deadline_exceeded' } });
  assert.deepEqual((await failure()).requestFailure, { code: 'deadline_exceeded' });
  // When every write failed, the engine's record has no error of its own, only failed items.
  for (const overrides of [{ error: undefined }, { error: { message: 'no code' } }, { error: { code: 'not a code' } }]) {
    reply = record(503, overrides);
    error = await failure();
    assert.deepEqual(error.requestFailure, { requestId: 'fixture-request-7' });
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /fake-failure-secret|no code|not a code/);
  }
  for (const overrides of [{ status: 'succeeded' }, { status: 'partial' }, { request_id: 7 }]) {
    reply = record(503, overrides);
    error = await failure();
    assert.equal(error.status, 503);
    assert.equal(error.requestFailure, undefined);
  }
});

test('memory listing uses the existing GET route with encoded repeated filters and shared Bearer auth', async t => {
  const f = await fixture(t);
  await f.signIn();
  f.handler(() => json({ items: [], count: 0, next_cursor: null, has_more: false }));
  assert.deepEqual(await f.client.getMemories(), { items: [], count: 0, has_more: false });
  assert.equal(f.calls[0].url, `${f.config.gatewayBase}/memories?page_size=50`);
  await f.client.getMemories({ recent_k: 200, memory_types: ['fact', 'procedural', 'fact'], include_superseded: true });
  const filtered = new URL(f.calls[1].url);
  assert.equal(filtered.pathname, '/inference/memory/memories');
  assert.deepEqual([...filtered.searchParams], [
    ['page_size', '50'], ['memory_types', 'fact'], ['memory_types', 'procedural'], ['include_superseded', 'true'],
  ]);
  await f.client.getMemories({ recent_k: 20, memory_types: ['episodic'] });
  assert.equal(f.calls[2].url, `${f.config.gatewayBase}/memories?page_size=20&memory_types=episodic`);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.method === 'GET' && call.body === undefined && call.headers.Authorization === 'Bearer fake-access-1'));
});

test('memory listing follows the gateway cursor with a fixed page size up to the requested count', async t => {
  const f = await fixture(t);
  await f.signIn();
  const stored = Array.from({ length: 130 }, (_, index) => ({ id: `memory-${index}`, content: `Note ${index}.` }));
  const pages = [];
  f.handler(url => {
    const query = new URL(url).searchParams;
    pages.push([...query]);
    const size = Number(query.get('page_size'));
    const offset = query.has('cursor') ? Number(query.get('cursor').replace('position-', '')) : 0;
    const items = stored.slice(offset, offset + size);
    const more = offset + size < stored.length;
    return json({ items, count: items.length, next_cursor: more ? `position-${offset + size}` : null, has_more: more });
  });
  const all = await f.client.getMemories({ recent_k: 200 });
  assert.deepEqual(all, { items: stored, count: 130, has_more: false });
  assert.deepEqual(pages.map(query => query.find(([key]) => key === 'cursor')?.[1] ?? null), [null, 'position-50', 'position-100']);
  assert.ok(pages.every(query => query[0][0] === 'page_size' && query[0][1] === '50'));
  pages.length = 0;
  const window = await f.client.getMemories({ recent_k: 70 });
  assert.equal(pages.length, 2);
  assert.deepEqual(window.items, stored.slice(0, 70));
  assert.equal(window.count, 70);
  assert.equal(window.has_more, true);
  pages.length = 0;
  const sample = await f.client.getMemories();
  assert.equal(pages.length, 1);
  assert.equal(sample.count, 50);
  assert.equal(sample.has_more, true);
  pages.length = 0;
  f.handler(url => {
    pages.push(url);
    return pages.length === 1
      ? json({ items: [{ content: 'First page.' }], count: 1, next_cursor: 'position-1', has_more: true })
      : json({ error: 'fake-server-secret' }, 503);
  });
  await assert.rejects(f.client.getMemories({ recent_k: 100, memory_types: ['fact'] }), error =>
    error.status === 503 && !error.message.includes('fake-server-secret'));
  assert.equal(pages.length, 2);
  assert.deepEqual([...new URL(pages[1]).searchParams], [['page_size', '50'], ['memory_types', 'fact'], ['cursor', 'position-1']]);
});

test('memory listing validates filters and rejects identity or endpoint overrides before auth or network', async t => {
  const f = await fixture(t);
  for (const options of [null, [], { recent_k: null }, { recent_k: 0 }, { recent_k: 201 }, { recent_k: '50' }, { recent_k: 1.5 },
    { memory_types: ['unknown'] }, { memory_types: 'fact' }, { memory_types: Array(4).fill('fact') },
    { scopes: ['scope:one'] }, { include_superseded: 'true' }, { page_size: 10 }, { cursor: 'position-1' },
    { token: 'fake-secret' }, { user_id: 'other' }, { gatewayBase: 'https://other.example' }, { offset: 50 }]) {
    await assert.rejects(f.client.getMemories(options), { code: 'INVALID_PAYLOAD' });
  }
  assert.equal(f.calls.length, 0);
  await absent(f.config.stateDir);
});

test('listing validates continuation metadata and preserves safe transport failures without retry', async t => {
  const f = await fixture(t);
  await f.signIn();
  for (const bad of [{}, { items: [] }, { items: [], count: -1, has_more: false, next_cursor: null },
    { items: [], count: 1, has_more: false, next_cursor: null }, { items: [], count: 0, has_more: 'false', next_cursor: null },
    { items: 'fake-secret', count: 1, has_more: false, next_cursor: null }, { items: [], count: 0, truncated: false },
    { items: [], count: 0, has_more: true, next_cursor: null }, { items: [], count: 0, has_more: true, next_cursor: '' },
    { items: [], count: 0, has_more: true, next_cursor: 'x'.repeat(8193) }, { items: [], count: 0, has_more: false, next_cursor: 'stale' }]) {
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
    { thread_id: 'a', role: 'user', content: '' }, { thread_id: 'a', role: 'assistant', content: 'b' },
    ...['a/b', 'a\\b', 'a?b', 'a#b', 'a\u0001b', 'x'.repeat(257), '\u00e9'.repeat(129)].map(thread_id => ({ thread_id, role: 'user', content: 'a' })),
    { thread_id: 'a', role: 'user', content: 'x'.repeat(256 * 1024 - 50) }]) {
    await assert.rejects(f.client.capture(turn), { code: 'INVALID_PAYLOAD' });
  }
  for (const topK of [0, -1, 51, 0.5, '8']) await assert.rejects(f.client.search('query', topK), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(f.client.search('x'.repeat(16 * 1024 + 1), 8), { code: 'INVALID_PAYLOAD' });
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
  // A stalled error body is cancelled by the same deadline.
  let errorCancelled = false;
  f.handler(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"code":')); },
    cancel() { errorCancelled = true; },
  }), { status: 409, headers: { 'Content-Type': 'application/problem+json' } }));
  await assert.rejects(f.client.capture(turn), { code: 'REQUEST_TIMEOUT' });
  assert.equal(f.calls.length, 4);
  assert.equal(cancelled, true);
  assert.equal(errorCancelled, true);
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
    if (request.url === '/evil') { redirected++; response.end('{}'); }
    else { response.writeHead(302, { Location: '/evil' }); response.end(); }
  });
  const f = await fixture(t, { deployment: fixtureDeployment(gateway), env: { MH_ALLOW_INSECURE_LOCALHOST: '1' }, timeoutMs: 1000 });
  const client = createClient({ config: f.config, acquireToken: f.options.acquireToken });
  await client.login();
  await assert.rejects(client.capture({ thread_id: 'test', role: 'user', content: 'A note.' }), { code: 'NETWORK_ERROR' });
  assert.equal(redirected, 0);
});

test('symlink authentication state is not followed', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await mkdir(f.config.stateDir, { recursive: true });
  const target = join(f.root, 'untouched.json');
  await writeFile(target, 'untouched');
  await symlink(target, f.config.authStatePath);
  await assert.rejects(f.client.getAccessToken(), { code: 'UNSAFE_STATE' });
  await assert.rejects(f.client.login(), { code: 'UNSAFE_STATE' });
  assert.equal(await readFile(target, 'utf8'), 'untouched');
  assert.equal(f.calls.length, 0);
});

test('unknown locks time out without eviction or deleting another writer state', async t => {
  const f = await fixture(t, { lockTimeoutMs: 35 });
  await mkdir(f.config.lockPath, { recursive: true });
  const path = join(f.config.lockPath, 'unrelated.txt');
  await writeFile(path, 'untouched');
  await assert.rejects(f.client.login(), { code: 'LOCK_TIMEOUT' });
  assert.equal(await readFile(path, 'utf8'), 'untouched');
  assert.equal(f.calls.length, 0);
});

test('a replaced lock owner is not removed during cleanup', async t => {
  const f = await fixture(t);
  f.options.acquireToken = async () => {
    await writeFile(join(f.config.lockPath, 'owner.json'), '{"nonce":"replacement","pid":1,"host":"other"}');
    return { accessToken: 'fake-access-1', expiresAt: epoch / 1000 + 3600 };
  };
  await assert.rejects(createClient(f.options).login(), { code: 'LOCK_OWNERSHIP_LOST' });
  assert.equal(JSON.parse(await readFile(join(f.config.lockPath, 'owner.json'), 'utf8')).nonce, 'replacement');
});

test('file identity ignores the volume serial only on Windows', () => {
  // Node before 22.17 on Windows 11 24H2: a path reports the 64-bit volume serial, an open handle the 32-bit one.
  const byPath = { ino: 42, dev: 0x1a2b3c4d5e6f };
  const byHandle = { ino: 42, dev: 0x3c4d5e6f };
  assert.equal(sameFile(byPath, byHandle, 'win32'), true);
  assert.equal(sameFile(byPath, byHandle, 'linux'), false);
  assert.equal(sameFile(byPath, { ...byHandle, ino: 43 }, 'win32'), false);
  assert.equal(sameFile(byPath, { ...byPath }, 'darwin'), true);
});

test('malformed authentication state never echoes its contents', async t => {
  const f = await fixture(t);
  await mkdir(f.config.stateDir, { recursive: true });
  await writeFile(f.config.authStatePath, '{fake-access-secret');
  await assert.rejects(f.client.getAccessToken(), error => error.code === 'INVALID_AUTH_STATE' && !error.message.includes('fake-access-secret'));
  assert.equal(f.calls.length, 0);
});
