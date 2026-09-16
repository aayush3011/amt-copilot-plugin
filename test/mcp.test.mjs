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
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['add_memory', 'get_memories', 'memory_login', 'memory_logout', 'memory_status', 'search_memories']);
  assert.equal(mcp.client.getServerVersion().version, '0.13.0');
  assert.match(tools.find(tool => tool.name === 'memory_login').description, /Opens the Microsoft sign-in page directly in your browser/);
  assert.equal(tools.find(tool => tool.name === 'memory_login').annotations.readOnlyHint, false);
  assert.equal(tools.find(tool => tool.name === 'memory_logout').annotations.destructiveHint, true);
  assert.equal(tools.find(tool => tool.name === 'search_memories').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'get_memories').annotations.readOnlyHint, true);
  assert.match(mcp.client.getInstructions(), /Use get_memories to list recent memories/);
  assert.match(mcp.client.getInstructions(), /do not inspect plugin internals/);
  assert.match(mcp.client.getInstructions(), /same OS user/);
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
  const listing = await mcp.call('get_memories');
  assert.equal(listing.isError, true);
  assert.equal(data(listing).code, 'NOT_SIGNED_IN');
  assert.equal(gateway.state.requests.length, 0);
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
    ['get_memories', { recent_k: 0 }],
    ['get_memories', { recent_k: 201 }],
    ['get_memories', { memory_types: ['unsupported-type'] }],
    ['get_memories', { scopes: ['two scopes'] }],
    ['get_memories', { scopes: ['\u00e9'.repeat(129)] }],
    ['get_memories', { include_superseded: 'true' }],
    ['get_memories', { tenant_id: 'different-tenant' }],
    ['get_memories', { endpoint: 'https://wrong.example' }],
    ['get_memories', { token: 'fixture-forbidden-secret' }],
    ['get_memories', { cursor: 'unknown-page' }],
    ['get_memories', { offset: 50 }],
    ['add_memory', { content: 'note', user_id: 'user:other' }],
    ['add_memory', { content: 'x'.repeat(32769) }],
    ['memory_login', { access_token: 'fixture-forbidden-secret' }],
    ['memory_login', { gatewayBase: 'https://wrong.example' }],
    ['memory_logout', { refresh_token: 'fixture-forbidden-secret' }],
    ['memory_status', { user_id: 'different-user' }],
  ]) {
    const response = await mcp.call(name, input);
    assert.equal(response.isError, true);
    assert.doesNotMatch(JSON.stringify(response), /fixture-forbidden-secret/);
  }
  assert.equal((await mcp.call('add_memory', { content: 'access_token: fixture-secret' })).isError, true);
  assert.equal(gateway.state.requests.length, 0);
});

test('get_memories lists recent records with filters, metadata, and explicit truncation instead of searching', async t => {
  const gateway = await mockGateway(t);
  const mcp = await memoryFixture(t, gateway);
  await createClient({ env: mcp.env, deployment: mcp.deployment }).redeem('fixture-enrollment');
  gateway.state.memories = Array.from({ length: 53 }, (_, index) => ({
    id: `memory-${index}`, scope_key: 'scope:team', memory_type: index % 2 ? 'procedural' : 'fact',
    content: `Verified listing note ${index}.`, created_at: '2026-09-16T00:00:00Z',
    ...(index === 0 ? { superseded_by: 'memory-52' } : {}),
    access_token: 'fixture-forbidden-secret',
  }));
  const recent = data(await mcp.call('get_memories'));
  assert.equal(recent.count, 50);
  assert.equal(recent.requested, 50);
  assert.equal(recent.truncated, true);
  assert.equal(recent.gatewayTruncated, true);
  assert.equal(recent.paginationSupported, false);
  assert.equal(recent.referenceOnly, true);
  assert.match(recent.message, /not all memories/);
  assert.equal(gateway.state.requests.filter(req => req.path.endsWith('/search')).length, 0);
  const full = data(await mcp.call('get_memories', {
    recent_k: 200, memory_types: ['fact', 'procedural'], scopes: ['scope:team', 'scope:org'], include_superseded: true,
  }));
  assert.equal(full.count, 53);
  assert.equal(full.truncated, false);
  assert.equal(full.items[0].type, 'fact');
  assert.equal(full.items[0].scope_key, 'scope:team');
  assert.equal(full.items[0].superseded, true);
  assert.doesNotMatch(JSON.stringify(full), /fixture-forbidden-secret|access_token/);
  const request = gateway.state.requests.at(-1);
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/inference/memory/memories');
  assert.equal(request.body, undefined);
  assert.deepEqual(request.query, [['recent_k', '200'], ['memory_types', 'fact'], ['memory_types', 'procedural'],
    ['scopes', 'scope:team'], ['scopes', 'scope:org'], ['include_superseded', 'true']]);
  const scoped = data(await mcp.call('get_memories', { scopes: ['scope:missing'], memory_types: ['episodic'] }));
  assert.equal(scoped.count, 0);
  assert.equal(scoped.truncated, false);
  assert.equal(mcp.stderr(), '');
});

test('get_memories discloses projection limits and strips secrets without silently claiming completeness', async t => {
  const gateway = await mockGateway(t);
  const mcp = await memoryFixture(t, gateway);
  await createClient({ env: mcp.env, deployment: mcp.deployment }).redeem('fixture-enrollment');
  gateway.state.listingResponse = {
    items: [{ id: 'one', content: 'A safe note. access_token: fixture-forbidden-secret' }, null, { content: '' },
      { id: 'legacy', text: 'A legacy text note.', memory_type: 'fact' }, { content: 'An extra record.' }],
    count: 5, truncated: false,
  };
  const listed = data(await mcp.call('get_memories', { recent_k: 4 }));
  assert.equal(listed.count, 2);
  assert.equal(listed.omittedItems, 3);
  assert.equal(listed.truncated, true);
  assert.equal(listed.sanitized, true);
  assert.equal(listed.items[1].type, 'fact');
  assert.doesNotMatch(JSON.stringify(listed), /fixture-forbidden-secret/);
  gateway.state.listingResponse = {
    items: Array.from({ length: 80 }, () => ({ content: 'A long listing note. '.repeat(440) })),
    count: 80, truncated: false,
  };
  const bounded = data(await mcp.call('get_memories', { recent_k: 200 }));
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 128 * 1024);
  assert.ok(bounded.items.length < 80);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.contentTruncated, true);
  assert.equal(bounded.omittedItems, 80 - bounded.items.length);
  assert.ok(bounded.items.every(item => Buffer.byteLength(item.content) <= 8192 && item.content_truncated));
  gateway.state.listingResponse = { items: [{ content: 'A partial record.' }], count: 2, truncated: false };
  assert.equal(data(await mcp.call('get_memories')).truncated, true);
  gateway.state.listingResponse = { items: [{ content: 'A full window is not proof of completeness.' }], count: 1, truncated: false };
  const window = data(await mcp.call('get_memories', { recent_k: 1 }));
  assert.equal(window.gatewayTruncated, false);
  assert.equal(window.limitReached, true);
  assert.equal(window.truncated, true);
});

test('listing failures and invalid truncation metadata are errors, not empty successful results', async t => {
  const gateway = await mockGateway(t);
  const mcp = await memoryFixture(t, gateway);
  await createClient({ env: mcp.env, deployment: mcp.deployment }).redeem('fixture-enrollment');
  gateway.state.listingStatus = 503;
  let response = await mcp.call('get_memories');
  assert.equal(response.isError, true);
  assert.equal(data(response).code, 'HTTP_ERROR');
  assert.doesNotMatch(JSON.stringify(response), /fixture-provider-secret/);
  assert.equal(gateway.state.requests.filter(req => req.path.endsWith('/memories')).length, 1);
  gateway.state.listingStatus = 200;
  gateway.state.listingResponse = { items: [], count: 0 };
  response = await mcp.call('get_memories');
  assert.equal(response.isError, true);
  assert.equal(data(response).code, 'INVALID_RESPONSE');
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

test('a clean MCP process opens Microsoft directly, signs in, then supports status and sign-out tools', async t => {
  const gateway = await mockGateway(t);
  const mcp = await memoryFixture(t, gateway, { loginFixture: true });
  assert.equal(gateway.state.requests.length, 0);
  const signedIn = await mcp.call('memory_login');
  assert.equal(signedIn.isError, undefined, JSON.stringify(signedIn));
  assert.equal(data(signedIn).signedIn, true);
  assert.doesNotMatch(JSON.stringify(signedIn), /https?:|fixture-(entra|access|refresh|enrollment|provider)/);
  const status = data(await mcp.call('memory_status'));
  assert.equal(status.signedIn, true);
  assert.equal(status.login.state, 'complete');
  assert.equal(status.gatewayBase, undefined);
  const count = gateway.state.requests.length;
  await mcp.call('memory_status');
  assert.equal(gateway.state.requests.length, count);
  assert.equal(data(await mcp.call('search_memories', { query: 'TypeScript' })).count, 1);
  const added = data(await mcp.call('add_memory', { content: 'Remember concise examples.' }));
  assert.equal(added.accepted, true);
  assert.equal(added.processing, 'asynchronous');
  const signedOut = await mcp.call('memory_logout');
  assert.equal(signedOut.isError, undefined);
  assert.deepEqual(data(signedOut), {
    signedOut: true, localCleared: true, revoked: true,
    message: 'Signed out of Memory House on this device. Previously issued access tokens may remain valid until expiry.',
  });
  assert.equal(data(await mcp.call('memory_status')).signedIn, false);
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/redeem')).length, 1);
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/revoke')).length, 1);
  assert.equal(gateway.state.refreshTokens.size, 0);
  assert.equal(mcp.stderr(), '');
});

for (const behavior of ['browser-failed', 'denied']) {
  test(`a clean MCP sign-in handles ${behavior} without exposing provider content or redeeming`, async t => {
    const gateway = await mockGateway(t);
    const mcp = await memoryFixture(t, gateway, { loginFixture: true, browserBehavior: behavior });
    const response = await mcp.call('memory_login');
    assert.equal(response.isError, true);
    assert.equal(data(response).code, behavior === 'browser-failed' ? 'BROWSER_LAUNCH_FAILED' : 'ENTRA_LOGIN_FAILED');
    assert.doesNotMatch(JSON.stringify(response), /fixture-|https?:/);
    const status = data(await mcp.call('memory_status'));
    assert.equal(status.login.state, 'error');
    assert.equal(status.signedIn, false);
    assert.equal(gateway.state.requests.length, 0);
    assert.equal(mcp.stderr(), '');
  });
}
