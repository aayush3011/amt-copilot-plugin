import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createClient } from '../src/client.mjs';
import { createGateway, loadCanvasData, shapeCanvasData, summarizeCanvasData } from '../src/canvas/data.mjs';
import { importMemories, importSessions, listSessions } from '../src/canvas/importers.mjs';
import { canvasActionError, startCanvasServer } from '../src/canvas/index.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { mockGateway } from './helpers/gateway.mjs';

const ROOT = 'node:11111111-1111-4111-8111-111111111111';
const PYTHON = 'node:22222222-2222-4222-8222-222222222222';
const BRANCH = 'node:33333333-3333-4333-8333-333333333333';
const DOTNET = 'node:44444444-4444-4444-8444-444444444444';
const ORPHAN = 'node:99999999-9999-4999-8999-999999999999';
const NODES = [
  { id: BRANCH, root_id: ROOT, parent_id: PYTHON, name: 'hotfix-4.14.x', path: 'Cosmos DB SDKs/Python SDK/hotfix-4.14.x', tier: 'node', status: 'active' },
  { id: ROOT, root_id: ROOT, parent_id: null, name: 'Cosmos DB SDKs', path: 'Cosmos DB SDKs', tier: 'root', status: 'active', description: 'Demo root' },
  { id: PYTHON, root_id: ROOT, parent_id: ROOT, name: 'Python SDK', path: 'Cosmos DB SDKs/Python SDK', tier: 'node', status: 'active' },
  { id: DOTNET, root_id: ROOT, parent_id: ROOT, name: '.NET SDK', path: 'Cosmos DB SDKs/.NET SDK', tier: 'node', status: 'active' },
];
const MEMORIES = [
  { id: 'personal-1', scope_key: 'user:fixture', memory_type: 'fact', content: 'I prefer pytest -k for focused runs.', created_at: '2026-10-01T00:00:00Z', source: { application: 'github-copilot', source: 'github-copilot' } },
  { id: 'branch-1', scope_key: BRANCH, memory_type: 'procedural', content: 'Install packages through the approved package feed.', created_at: '2026-10-03T00:00:00Z', tags: ['pip'] },
  { id: 'python-1', scope_key: PYTHON, memory_type: 'fact', content: 'Curator note: run the emulator tests before release.', created_at: '2026-10-02T00:00:00Z' },
  { id: 'orphan-1', scope_key: ORPHAN, memory_type: 'fact', content: 'A node outside the reach view.', created_at: '2026-10-04T00:00:00Z' },
  { id: 'old-1', scope_key: 'user:fixture', memory_type: 'fact', content: 'Superseded preference.', created_at: '2026-09-01T00:00:00Z', superseded_by: 'personal-1' },
];

async function signedIn(t, gateway, { signIn = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'memory-house-canvas-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = loadConfig({ home, deployment: fixtureDeployment(gateway.base), env: { MH_ALLOW_INSECURE_LOCALHOST: '1' } });
  const client = createClient({ config, acquireToken: async () => ({ accessToken: 'fixture-access-1', expiresAt: Math.floor(Date.now() / 1000) + 3600 }) });
  if (!signIn) await client.logout();
  return { home, client, gateway: createGateway({ client }) };
}

async function hierarchyGateway(t) {
  const gateway = await mockGateway(t);
  gateway.state.nodes = NODES;
  gateway.state.memories = MEMORIES;
  return gateway;
}

function raw(url, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: target.hostname, port: target.port, method, path, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('canvas data lists personal memories and every readable hierarchy node by path', async t => {
  const gateway = await hierarchyGateway(t);
  const { gateway: client } = await signedIn(t, gateway);
  const data = await loadCanvasData(client);
  assert.equal(data.principal, 'user:fixture');
  assert.equal(data.tenant, 'tenant-fixture');
  assert.deepEqual(data.warnings, []);
  assert.equal(data.truncated, false);
  assert.equal(data.total, 4);
  assert.deepEqual(data.rows.map(row => [row.kind, row.name, row.depth, row.count]), [
    ['personal', 'Personal', 0, 1],
    ['root', 'Cosmos DB SDKs', 0, 0],
    ['node', '.NET SDK', 1, 0],
    ['node', 'Python SDK', 1, 1],
    ['node', 'hotfix-4.14.x', 2, 1],
    ['unlisted', 'Unlisted node', 0, 1],
  ]);
  assert.equal(data.rows[4].path, 'Cosmos DB SDKs / Python SDK / hotfix-4.14.x');
  assert.equal(data.rows[1].description, 'Demo root');
  const [branch] = data.groups[BRANCH];
  assert.equal(branch.scope_kind, 'node');
  assert.equal(branch.scope_label, 'hotfix-4.14.x');
  assert.equal(branch.scope_path, 'Cosmos DB SDKs / Python SDK / hotfix-4.14.x');
  assert.deepEqual(branch.tags, ['pip']);
  assert.equal(data.groups['user:fixture'][0].source, 'github-copilot');
  assert.equal(data.groups[ORPHAN][0].scope_kind, 'unlisted');

  const listing = gateway.state.requests.filter(entry => entry.path === '/inference/memory/memories');
  assert.equal(listing.length, 1);
  assert.deepEqual(listing[0].query, [['page_size', '50']]);
  for (const path of ['/inference/memory/whoami', '/inference/memory/v1/me/reach']) {
    const call = gateway.state.requests.find(entry => entry.path === path);
    assert.match(call.authorization, /^Bearer fixture-access-/);
  }
});

test('canvas filters search locally and pass type, superseded and limit to the listing', async t => {
  const gateway = await hierarchyGateway(t);
  const { gateway: client } = await signedIn(t, gateway);
  const searched = await loadCanvasData(client, { search: 'EMULATOR' });
  assert.equal(searched.total, 1);
  assert.deepEqual(Object.keys(searched.groups), [PYTHON]);
  assert.equal(searched.rows.find(row => row.scope === BRANCH).count, 0);
  const byPath = await loadCanvasData(client, { search: 'hotfix' });
  assert.deepEqual(Object.keys(byPath.groups), [BRANCH]);

  gateway.state.requests.length = 0;
  const filtered = await loadCanvasData(client, { memoryTypes: ['fact', 'bogus'], includeSuperseded: true, limit: 3 });
  assert.equal(filtered.limit, 3);
  assert.equal(filtered.truncated, true);
  const [listing] = gateway.state.requests.filter(entry => entry.path === '/inference/memory/memories');
  assert.deepEqual(listing.query, [['page_size', '3'], ['memory_types', 'fact'], ['include_superseded', 'true']]);
  const all = await loadCanvasData(client, { includeSuperseded: true });
  assert.equal(all.groups['user:fixture'].find(item => item.id === 'old-1').superseded, true);
  assert.equal(normalizeLimit(0), 200);
  assert.equal(normalizeLimit(201), 200);
  assert.equal(normalizeLimit('7'), 7);

  function normalizeLimit(limit) {
    return shapeCanvasData({ listing: { items: [] }, filters: { limit } }).limit;
  }
});

test('promoted copies show where they came from and why, from metadata or the older summary', () => {
  const nodes = [{ id: BRANCH, name: 'hotfix-4.14.x', path: 'Cosmos DB SDKs/Python SDK/hotfix-4.14.x' }];
  const metadata = {
    promoted_from_scope: BRANCH,
    promotion_origin_principal: 'user:origin',
    topology_assessment: { rationale: 'Applies to every Python SDK branch.' },
    promoted_at: '2026-10-09T00:00:00Z',
  };
  const legacy = { from_scope: BRANCH, origin: 'user:origin', rationale: 'Applies to every Python SDK branch.', promoted_at: '2026-10-09T00:00:00Z' };
  for (const item of [{ metadata }, { promotion: legacy }]) {
    const data = shapeCanvasData({
      nodes,
      listing: { items: [{ id: 'm1', scope_key: PYTHON, memory_type: 'fact', content: 'Use the approved feed.', ...item }] },
    });
    assert.deepEqual(Object.values(data.groups).flat()[0].promotion, {
      from_scope: BRANCH,
      from_label: 'Cosmos DB SDKs / Python SDK / hotfix-4.14.x',
      origin: 'user:origin',
      rationale: 'Applies to every Python SDK branch.',
      promoted_at: '2026-10-09T00:00:00Z',
    });
  }
  const plain = shapeCanvasData({ listing: { items: [{ id: 'm2', scope_key: 'user:me', memory_type: 'fact', content: 'x', metadata: {} }] } });
  assert.equal(Object.values(plain.groups).flat()[0].promotion, null);
});

test('identity and hierarchy failures degrade to warnings; listing and sign-in failures are fatal', async t => {
  const gateway = await hierarchyGateway(t);
  const { gateway: client } = await signedIn(t, gateway);
  gateway.state.reachStatus = 503;
  gateway.state.whoamiStatus = 500;
  const degraded = await loadCanvasData(client);
  assert.equal(degraded.principal, null);
  assert.equal(degraded.warnings.length, 2);
  assert.doesNotMatch(JSON.stringify(degraded), /fixture-provider-secret/);
  assert.deepEqual(degraded.rows.map(row => row.kind), ['personal', 'unlisted', 'unlisted', 'unlisted']);

  gateway.state.listingStatus = 500;
  await assert.rejects(loadCanvasData(client), { code: 'HTTP_ERROR' });
  const { gateway: signedOut } = await signedIn(t, gateway, { signIn: false });
  await assert.rejects(loadCanvasData(signedOut), error => {
    assert.equal(error.code, 'NOT_SIGNED_IN');
    assert.equal(canvasActionError(error).code, 'not_signed_in');
    return true;
  });
});

test('the refresh summary is compact reference data labelled by node path', async t => {
  const gateway = await hierarchyGateway(t);
  const { gateway: client } = await signedIn(t, gateway);
  const summary = summarizeCanvasData(await loadCanvasData(client), { maxItems: 2, maxChars: 20 });
  assert.equal(summary.referenceOnly, true);
  assert.equal(summary.total, 4);
  assert.equal(summary.truncated, true);
  assert.deepEqual(summary.memories.map(item => item.scope), ['Personal', 'Cosmos DB SDKs / Python SDK']);
  assert.equal(summary.memories[1].content, 'Curator note: run th...');
  assert.ok(summary.scopes.some(scope => scope.name === 'hotfix-4.14.x' && scope.count === 1));
});

test('canvas server serves a nonce-protected panel and guards every API route', async t => {
  const gateway = await hierarchyGateway(t);
  const { client } = await signedIn(t, gateway);
  const server = await startCanvasServer({ gateway: { client }, roots: { copilot: join(tmpdir(), 'none-c'), claude: join(tmpdir(), 'none-d') } });
  t.after(() => server.close());
  const { port } = new URL(server.url);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const host = `127.0.0.1:${port}`;

  const page = await raw(server.url, { headers: { Host: host, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(page.status, 200);
  const nonce = page.headers['content-security-policy'].match(/script-src 'nonce-([^']+)'/)[1];
  assert.ok(page.text.includes(`<script nonce="${nonce}">`));
  assert.ok(page.text.includes(JSON.stringify(server.token)));
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['cross-origin-resource-policy'], undefined);
  assert.equal((await raw(server.url, { headers: { Host: `rebound.example:${port}` } })).status, 403);

  const api = (headers, path = '/api/memory') => raw(server.url, { path, headers: { Host: host, ...headers } });
  assert.equal((await api({})).status, 403);
  assert.equal((await api({ 'x-mh-canvas-token': `${server.token}x` })).status, 403);
  assert.equal((await api({ 'x-mh-canvas-token': server.token, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await api({ 'x-mh-canvas-token': server.token, Host: `evil.example:${port}` })).status, 403);
  assert.equal((await api({ 'x-mh-canvas-token': server.token }, '/api/unknown')).status, 404);

  const ok = await api({ 'x-mh-canvas-token': server.token, 'Sec-Fetch-Site': 'same-origin' }, '/api/memory?search=approved&limit=50');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cross-origin-resource-policy'], 'same-origin');
  const data = ok.json();
  assert.equal(data.total, 1);
  assert.equal(data.rows.find(row => row.scope === BRANCH).path, 'Cosmos DB SDKs / Python SDK / hotfix-4.14.x');

  const badSource = await api({ 'x-mh-canvas-token': server.token }, '/api/import/sessions?source=cursor');
  assert.equal(badSource.status, 400);
  assert.equal(badSource.json().error, 'INVALID_PAYLOAD');
  const post = (path, body, headers = {}) => raw(server.url, {
    method: 'POST', path, body, headers: { Host: host, 'x-mh-canvas-token': server.token, 'Content-Type': 'application/json', ...headers },
  });
  assert.equal((await post('/api/import/memories', '{"source":"copilot"}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/import/memories', '[]')).status, 400);
  assert.equal((await post('/api/import/memories', JSON.stringify({ source: 'copilot', pad: 'x'.repeat(70_000) }))).status, 413);
  assert.equal((await post('/api/import/sessions', JSON.stringify({ source: 'copilot', ids: ['../escape'] }))).status, 400);
});

test('canvas server reports a missing sign-in as 401 without leaking gateway text', async t => {
  const gateway = await hierarchyGateway(t);
  const { client } = await signedIn(t, gateway, { signIn: false });
  const server = await startCanvasServer({ gateway: { client }, roots: { copilot: tmpdir(), claude: tmpdir() } });
  t.after(() => server.close());
  const response = await raw(server.url, { path: '/api/memory', headers: { Host: new URL(server.url).host, 'x-mh-canvas-token': server.token } });
  assert.equal(response.status, 401);
  assert.equal(response.json().error, 'not_signed_in');
  assert.equal(gateway.state.requests.length, 0);
});

async function historyFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'memory-house-history-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const copilot = join(home, 'copilot', 'session-state');
  const claude = join(home, 'claude', 'projects');
  const lines = values => `${values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n')}\n`;

  const newer = join(copilot, 'aaaaaaaa-0000-4000-8000-000000000001');
  await mkdir(newer, { recursive: true });
  await writeFile(join(newer, 'events.jsonl'), lines([
    { type: 'session.start', data: { startTime: '2026-10-01T10:00:00Z', context: { cwd: '/work/azure-sdk-for-python' } } },
    { type: 'user.message', data: { interactionId: 'i1', content: 'Install azure-cosmos 4.14 for the **emulator** tests. api_key=sk-abcdefghijklmnopqrstuvwx' } },
    { type: 'assistant.message', data: { interactionId: 'i1', content: 'Checking the feed.' } },
    { type: 'assistant.message', data: { interactionId: 'i1', content: 'Installed it from the approved package feed.', phase: 'final_answer' } },
    { type: 'assistant.message', data: { interactionId: 'i1', content: 'Trailing commentary.' } },
    { type: 'tool.execution_complete', data: { success: true, toolTelemetry: { properties: { operation: 'storeMemory' }, restrictedProperties: { memoryFact: 'Use the approved package feed for pip installs.' } } } },
    { type: 'tool.execution_complete', data: { success: false, toolTelemetry: { properties: { operation: 'storeMemory' }, restrictedProperties: { memoryFact: 'Failed write.' } } } },
    { type: 'user.message', data: { interactionId: 'i2', content: 'Unanswered question' } },
    '{"type":"user.message","data":{"interactionId":"i3","content":"partial',
  ]));
  const older = join(copilot, 'aaaaaaaa-0000-4000-8000-000000000002');
  await mkdir(older, { recursive: true });
  await writeFile(join(older, 'events.jsonl'), lines([
    { type: 'user.message', data: { interactionId: 'x', content: 'The user explicitly invoked the "/mh-show" skill.' } },
    { type: 'assistant.message', data: { interactionId: 'x', content: 'Opened the canvas.' } },
    { type: 'tool.execution_complete', data: { success: true, toolTelemetry: { properties: { operation: 'storeMemory' }, restrictedProperties: { memoryFact: 'Use the approved package feed for pip installs.' } } } },
  ]));
  await utimes(join(older, 'events.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));
  await mkdir(join(copilot, 'not a session'), { recursive: true });

  const project = join(claude, '-work-azure-sdk-for-net');
  await mkdir(join(project, 'memory', 'nested'), { recursive: true });
  await writeFile(join(project, 'bbbbbbbb-0000-4000-8000-000000000003.jsonl'), lines([
    { type: 'user', cwd: '/work/azure-sdk-for-net', timestamp: '2026-10-02T09:00:00Z', message: { role: 'user', content: 'Run the .NET emulator tests.' } },
    { type: 'assistant', timestamp: '2026-10-02T09:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Starting.' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Subagent noise.' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'All emulator tests passed.' }] } },
  ]));
  await writeFile(join(project, 'memory', 'MEMORY.md'), '- [Feed](feed.md)\n');
  await writeFile(join(project, 'memory', 'feed.md'), '---\nname: feed\ntype: project\n---\nRestore NuGet packages from the approved feed.\n');
  await writeFile(join(project, 'memory', 'nested', 'empty.md'), '---\nname: empty\n---\n');
  return { home, roots: { copilot, claude } };
}

test('session listing reads newest local Copilot and Claude history with filtered previews', async t => {
  const { roots } = await historyFixture(t);
  const copilot = await listSessions('copilot', roots);
  assert.deepEqual(copilot.map(session => session.session_id), ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002']);
  const [session, older] = copilot;
  assert.equal(session.turn_count, 1);
  assert.equal(session.cwd, '/work/azure-sdk-for-python');
  assert.equal(session.last_agent_turn, 'Installed it from the approved package feed.');
  assert.match(session.label, /^Install azure-cosmos 4\.14 for the emulator tests\./);
  assert.doesNotMatch(JSON.stringify(copilot), /sk-abcdefghijklmnop|explicitly invoked/);
  assert.equal(older.label, older.session_id);
  assert.equal(older.last_user_turn, '');

  const claude = await listSessions('claude', roots);
  assert.equal(claude.length, 1);
  assert.equal(claude[0].turn_count, 1);
  assert.equal(claude[0].last_agent_turn, 'All emulator tests passed.');
  assert.deepEqual(await listSessions('copilot', { copilot: join(roots.copilot, 'missing'), claude: roots.claude }), []);
  await assert.rejects(listSessions('cursor', roots), { code: 'INVALID_PAYLOAD' });
});

test('session import sends sanitized extraction batches once, keyed for idempotent replays', async t => {
  const gateway = await mockGateway(t);
  const { gateway: client } = await signedIn(t, gateway);
  const { roots } = await historyFixture(t);
  const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'not-listed'];
  const first = await importSessions({ gateway: client, source: 'copilot', ids, roots });
  assert.deepEqual(first, { source: 'copilot', sessions: 2, messages: 3, skipped: 1, failed: 0, unknown: 0, batches: 2 });
  const [newer, older] = gateway.state.insertions;
  assert.equal(newer.body.extract, true);
  assert.equal(newer.body.thread_id, 'mh:import:copilot:aaaaaaaa-0000-4000-8000-000000000001');
  assert.deepEqual(newer.body.items.map(item => [item.role, item.source]), [['user', 'github-copilot'], ['agent', 'github-copilot']]);
  assert.match(newer.body.items[0].content, /api_key: \[REDACTED\]/);
  assert.equal(newer.body.items[1].content, 'Installed it from the approved package feed.');
  assert.deepEqual(older.body.items.map(item => item.role), ['agent']);
  assert.match(newer.key, /^mh-import-[0-9a-f]{64}$/);

  const replay = await importSessions({ gateway: client, source: 'copilot', ids, roots });
  assert.deepEqual(replay, first);
  assert.equal(gateway.state.insertions.length, 2);
  const keys = gateway.state.requests.filter(entry => entry.path === '/inference/memory/memory').map(entry => entry.headers['idempotency-key']);
  assert.deepEqual(keys.slice(2), keys.slice(0, 2));

  const claude = await importSessions({ gateway: client, source: 'claude', ids: ['bbbbbbbb-0000-4000-8000-000000000003'], roots });
  assert.equal(claude.messages, 2);
  assert.deepEqual(gateway.state.insertions.at(-1).body.items, [
    { role: 'user', content: 'Run the .NET emulator tests.', source: 'claude-code' },
    { role: 'agent', content: 'All emulator tests passed.', source: 'claude-code' },
  ]);
  await assert.rejects(importSessions({ gateway: client, source: 'copilot', ids: [], roots }), { code: 'INVALID_PAYLOAD' });
});

test('session import splits large sessions within AMT request limits and stops at the first failure', async t => {
  const gateway = await mockGateway(t);
  const { gateway: client } = await signedIn(t, gateway);
  const { roots } = await historyFixture(t);
  const big = join(roots.copilot, 'cccccccc-0000-4000-8000-000000000004');
  await mkdir(big, { recursive: true });
  const events = [];
  for (let n = 0; n < 40; n++) {
    events.push({ type: 'user.message', data: { interactionId: `q${n}`, content: `Question ${n} ${'x'.repeat(9000)}` } });
    events.push({ type: 'assistant.message', data: { interactionId: `q${n}`, content: `Answer ${n}` } });
  }
  await writeFile(join(big, 'events.jsonl'), `${events.map(value => JSON.stringify(value)).join('\n')}\n`);
  const result = await importSessions({ gateway: client, source: 'copilot', ids: ['cccccccc-0000-4000-8000-000000000004'], roots });
  assert.equal(result.messages, 80);
  assert.ok(result.batches >= 2);
  for (const { body } of gateway.state.insertions) {
    assert.ok(body.items.length <= 50);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 240 * 1024);
  }

  gateway.state.insertStatus = 503;
  const failed = await importSessions({ gateway: client, source: 'copilot', ids: ['aaaaaaaa-0000-4000-8000-000000000001'], roots });
  assert.equal(failed.messages, 0);
  assert.equal(failed.error.code, 'HTTP_ERROR');
  assert.doesNotMatch(JSON.stringify(failed), /fixture-provider-secret/);
});

test('memory import publishes deduplicated direct facts, then requests one reconciliation', async t => {
  const gateway = await mockGateway(t);
  const { gateway: client } = await signedIn(t, gateway);
  const { roots } = await historyFixture(t);
  const copilot = await importMemories({ gateway: client, source: 'copilot', roots });
  assert.deepEqual(copilot, { source: 'copilot', memories: 1, skipped: 1, failed: 0, unknown: 0, batches: 1, reconcile: 'queued' });
  assert.deepEqual(gateway.state.insertions[0].body, {
    extract: false, items: [{ content: 'Use the approved package feed for pip installs.', source: 'copilot-cli-memory' }],
  });
  assert.equal(gateway.state.reconciles, 1);

  const claude = await importMemories({ gateway: client, source: 'claude', roots });
  assert.equal(claude.memories, 1);
  assert.equal(claude.skipped, 0);
  assert.deepEqual(gateway.state.insertions.at(-1).body.items, [{ content: 'Restore NuGet packages from the approved feed.', source: 'claude-code-memory' }]);
  assert.equal(gateway.state.reconciles, 2);

  const empty = await importMemories({ gateway: client, source: 'claude', roots: { copilot: roots.copilot, claude: join(roots.claude, 'none') } });
  assert.equal(empty.memories, 0);
  assert.equal(empty.reconcile, null);
  assert.equal(gateway.state.reconciles, 2);
});
