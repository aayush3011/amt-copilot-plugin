import assert from 'node:assert/strict';
import test from 'node:test';
import { mockGateway } from './helpers/gateway.mjs';
import { memoryFixture } from './helpers/runtime.mjs';
import { createClient } from '../src/client.mjs';

const data = result => JSON.parse(result.content[0].text);

test('real stdio MCP initialization and discovery work before sign-in', async t => {
  const gateway = await mockGateway(t);
  const mcp = await memoryFixture(t, gateway);
  assert.equal(mcp.client.getServerVersion().name, 'memory-house');
  const { tools } = await mcp.client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['add_memory', 'memory_login', 'memory_setup', 'memory_status', 'search_memories']);
  assert.equal(tools.find(tool => tool.name === 'search_memories').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'add_memory').annotations.readOnlyHint, false);
  assert.equal(tools.find(tool => tool.name === 'add_memory').annotations.idempotentHint, false);
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
  const status = data(await mcp.call('memory_status'));
  assert.equal(status.signedIn, false);
  assert.equal(gateway.state.requests.length, 0);
  const missing = await mcp.call('search_memories', { query: 'my preferences' });
  assert.equal(missing.isError, true);
  assert.equal(data(missing).code, 'NOT_SIGNED_IN');
  assert.match(data(missing).nextStep, /memory_login/);
  assert.equal(mcp.stderr(), '');
});

test('app-visible search and insert share the existing credential store and narrow gateway routes', async t => {
  const gateway = await mockGateway(t);
  const mcp = await memoryFixture(t, gateway);
  await createClient({ env: mcp.env, deployment: mcp.deployment }).redeem('fixture-enrollment');
  const found = await mcp.call('search_memories', { query: 'TypeScript', top_k: 3 });
  assert.equal(found.isError, undefined);
  assert.match(data(found).items[0].content, /TypeScript/);
  assert.deepEqual(found.structuredContent, data(found));
  const added = await mcp.call('add_memory', { content: 'Please remember that I prefer concise TypeScript examples. access_token: fixture-secret' });
  assert.equal(added.isError, undefined);
  assert.equal(data(added).processing, 'asynchronous');
  assert.equal(data(added).accepted, true);
  assert.doesNotMatch(JSON.stringify(added), /fixture-secret/);
  assert.equal(gateway.state.turns.length, 1);
  const turn = gateway.state.turns[0];
  assert.match(turn.thread_id, /^mh:manual:/);
  assert.equal(turn.role, 'user');
  assert.doesNotMatch(turn.content, /fixture-secret/);
  assert.deepEqual(Object.keys(turn).sort(), ['content', 'role', 'thread_id']);
  assert.deepEqual(gateway.state.requests.map(req => req.path), [
    '/inference/memory/hook/redeem', '/inference/memory/hook/search', '/inference/memory/hook/capture',
  ]);
  assert.doesNotMatch(JSON.stringify(await mcp.call('memory_status')), /fixture-(access|refresh|enrollment)/);
  assert.equal(mcp.stderr(), '');
});

test('MCP inputs reject identities, endpoints, credentials, and oversize text before network activity', async t => {
  const gateway = await mockGateway(t);
  const mcp = await memoryFixture(t, gateway);
  for (const [name, input] of [
    ['search_memories', { query: '', top_k: 2 }],
    ['search_memories', { query: 'x', top_k: 21 }],
    ['search_memories', { query: 'x', gateway: 'https://wrong.example' }],
    ['search_memories', { query: '\u00e9'.repeat(4096) }],
    ['add_memory', { content: 'note', user_id: 'user:other' }],
    ['add_memory', { content: 'x'.repeat(32769) }],
    ['memory_login', { access_token: 'fixture-forbidden-secret' }],
    ['memory_setup', { gatewayBase: 'https://wrong.example' }],
  ]) {
    const response = await mcp.call(name, input);
    assert.equal(response.isError, true);
    assert.doesNotMatch(JSON.stringify(response), /fixture-forbidden-secret/);
  }
  assert.equal((await mcp.call('add_memory', { content: 'access_token: fixture-secret' })).isError, true);
  assert.equal(gateway.state.requests.length, 0);
});

test('MCP capture failures are actionable errors with no automatic replay or provider details', async t => {
  const gateway = await mockGateway(t);
  const mcp = await memoryFixture(t, gateway);
  await createClient({ env: mcp.env, deployment: mcp.deployment }).redeem('fixture-enrollment');
  gateway.state.captureStatus = 503;
  const failed = await mcp.call('add_memory', { content: 'Remember this note.' });
  assert.equal(failed.isError, true);
  assert.match(data(failed).message, /HTTP 503/);
  gateway.state.captureStatus = 200;
  await mcp.call('search_memories', { query: 'note' });
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/capture')).length, 1);
  assert.equal(gateway.state.turns.length, 0);
});

test('model-visible setup and login return only a local page, never enrollment or sign-in credentials', async t => {
  const gateway = await mockGateway(t);
  const mcp = await memoryFixture(t, gateway);
  const opened = data(await mcp.call('memory_setup'));
  const url = new URL(opened.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.search + url.hash, '');
  assert.equal(opened.browserOpened, false);
  assert.equal(data(await mcp.call('memory_login')).url, opened.url);
  const page = await fetch(opened.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Sign in with Microsoft/);
  assert.equal(gateway.state.requests.length, 0);
  await mcp.client.close();
  await assert.rejects(fetch(opened.url));
});
