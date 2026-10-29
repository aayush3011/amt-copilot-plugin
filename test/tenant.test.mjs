import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '../src/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { runAuthCommand } from '../src/auth.mjs';
import { tenantFromChallenge } from '../src/tenant.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { seedEntraSession } from './helpers/entra.mjs';
import { mockGateway } from './helpers/gateway.mjs';
import { isolatedEnvironment } from './helpers/runtime.mjs';

const PINNED = '33333333-3333-3333-3333-333333333333';
const OTHER = '55555555-5555-5555-5555-555555555555';
const challenge = (tenant, extra = '') => `Bearer authorization_uri="https://login.microsoftonline.com/${tenant}"${extra}`;
const expiry = () => Math.floor(Date.now() / 1000) + 3600;

function deployment(base, tenantId) {
  const value = fixtureDeployment(base);
  if (tenantId === undefined) delete value.entra.tenantId;
  else value.entra.tenantId = tenantId;
  return value;
}

// A client whose token provider records each request instead of signing in.
async function fixture(t, { tenantId, challengeHeader } = {}) {
  const gateway = await mockGateway(t);
  if (challengeHeader !== undefined) gateway.state.challenge = challengeHeader;
  const env = await isolatedEnvironment(t);
  const requests = [];
  const make = settings => createClient({ config: loadConfig({ env, deployment: deployment(gateway.base, settings) }),
    acquireToken: async (config, request = {}) => {
      requests.push({ tenantId: config.tenantId, ...request });
      return { accessToken: request.resource === 'mcp' ? 'fixture-mcp-access-1' : 'fixture-access-1', expiresAt: expiry(),
        ...(request.interactive ? { mcpReady: true } : {}) };
    } });
  return { gateway, env, requests, make, client: make(tenantId) };
}

test('challenge parsing accepts only one tenant GUID on the Microsoft authority', () => {
  for (const header of [challenge(OTHER), challenge(OTHER, ', error="invalid_token"'),
    `Bearer error="invalid_token", authorization_uri="https://login.microsoftonline.com/${OTHER}"`,
    `bearer Authorization_URI=https://login.microsoftonline.com/${OTHER.toUpperCase()}/`,
    `Basic realm="x", Bearer realm="", authorization_uri="https://LOGIN.microsoftonline.com/${OTHER}"`]) {
    assert.equal(tenantFromChallenge(header), OTHER, header);
  }
  for (const header of [undefined, '', challenge(OTHER).replace('Bearer', 'Basic'),
    `Bearer authorization_uri="https://login.microsoftonline.com.evil.test/${OTHER}"`,
    `Bearer authorization_uri="https://evil.test/${OTHER}"`,
    `Bearer authorization_uri="http://login.microsoftonline.com/${OTHER}"`,
    `Bearer authorization_uri="https://login.microsoftonline.com:8443/${OTHER}"`,
    `Bearer authorization_uri="https://user@login.microsoftonline.com/${OTHER}"`,
    `Bearer authorization_uri="https://login.microsoftonline.com/${OTHER}/oauth2/authorize"`,
    `Bearer authorization_uri="https://login.microsoftonline.com/${OTHER}?x=1"`,
    `Bearer authorization_uri="https://login.microsoftonline.com/common"`,
    `Bearer authorization_uri="https://login.microsoftonline.com/organizations"`,
    `Bearer authorization_uri="https://login.microsoftonline.com/contoso.com"`,
    `${challenge(OTHER)}, authorization_uri="https://login.microsoftonline.com/${PINNED}"`,
    'Bearer realm="memory-house"', `Bearer authorization_uri="${'x'.repeat(9000)}"`]) {
    assert.equal(tenantFromChallenge(header), null, header);
  }
});

test('deployment tenants are optional single tenants; shared authorities are rejected', async t => {
  const env = await isolatedEnvironment(t);
  assert.equal(loadConfig({ env, deployment: deployment(undefined, undefined) }).tenantId, null);
  assert.equal(loadConfig({ env, deployment: deployment(undefined, 'contoso.onmicrosoft.com') }).tenantId, 'contoso.onmicrosoft.com');
  assert.equal(loadConfig({ env, deployment: deployment(undefined, PINNED) }).tenantId, PINNED);
  for (const tenantId of ['common', 'organizations', 'consumers', 'Organizations']) {
    assert.throws(() => loadConfig({ env, deployment: deployment(undefined, tenantId) }), error =>
      error.code === 'INVALID_ENTRA_CONFIG' && /common, organizations and consumers/.test(error.message));
  }
  for (const tenantId of ['not a tenant', 'contoso', '-bad.example.com', 'https://login.microsoftonline.com/x']) {
    assert.throws(() => loadConfig({ env, deployment: deployment(undefined, tenantId) }), { code: 'INVALID_ENTRA_CONFIG' });
  }
});

test('a pinned tenant signs in without a gateway challenge and is reported by status', async t => {
  const f = await fixture(t, { tenantId: PINNED, challengeHeader: null });
  const login = await f.client.login();
  assert.equal(login.tenantId, PINNED);
  assert.equal(login.mcpReady, true);
  assert.deepEqual(f.requests, [{ tenantId: PINNED, interactive: true }]);
  assert.equal(JSON.parse(await readFile(f.client.config.authStatePath, 'utf8')).tenantId, PINNED);
  const status = await f.make(PINNED).status();
  assert.equal(status.signedIn, true);
  assert.equal(status.tenantId, PINNED);
});

test('without a configured tenant, sign-in discovers it from the unauthenticated gateway challenge', async t => {
  const f = await fixture(t, { challengeHeader: challenge(OTHER, ', error="invalid_token"') });
  assert.equal(f.client.config.tenantId, null);
  assert.equal((await f.client.status()).reason, 'ENTRA_AUTH_REQUIRED');
  assert.equal(f.requests.length, 0);
  assert.equal((await f.client.login()).tenantId, OTHER);
  const [discovery] = f.gateway.state.requests;
  assert.deepEqual([discovery.method, discovery.path, discovery.authorization], ['GET', '/inference/memory/whoami', undefined]);
  // Background processes reuse the recorded tenant without another discovery request.
  const background = f.make(undefined);
  await background.capture({ thread_id: 'thread', role: 'user', content: 'Remember this.' });
  assert.equal(f.requests.at(-1).tenantId, OTHER);
  assert.equal((await background.status()).tenantId, OTHER);
  assert.equal(f.gateway.state.requests.filter(request => request.path.endsWith('/whoami')).length, 1);
});

test('a pinned tenant that differs from the gateway challenge fails before any browser sign-in', async t => {
  const f = await fixture(t, { tenantId: PINNED, challengeHeader: challenge(OTHER) });
  await assert.rejects(f.client.login(), error => error.code === 'TENANT_MISMATCH' && /deployment\.json/.test(error.message));
  assert.equal(f.requests.length, 0);
});

test('missing or untrusted challenges cannot choose the tenant', async t => {
  for (const header of [null, `Bearer authorization_uri="https://evil.test/${OTHER}"`,
    `Bearer authorization_uri="https://login.microsoftonline.com/${OTHER}/oauth2/authorize"`,
    'Bearer authorization_uri="https://login.microsoftonline.com/common"']) {
    const f = await fixture(t, { challengeHeader: header });
    await assert.rejects(f.client.login(), { code: 'TENANT_DISCOVERY_FAILED' });
    assert.equal(f.requests.length, 0);
    // A pinned tenant ignores an unusable challenge.
    assert.equal((await f.make(PINNED).login()).tenantId, PINNED);
  }
});

test('a changed pinned tenant requires a new sign-in instead of reusing the recorded one', async t => {
  const f = await fixture(t, { challengeHeader: challenge(OTHER) });
  await f.client.login();
  const pinned = f.make(PINNED);
  await assert.rejects(pinned.getAccessToken(), { code: 'TENANT_CHANGED' });
  assert.deepEqual(await pinned.status(), {
    signedIn: false, needsLogin: true, source: 'entra', tenantId: OTHER, accessExpiresAt: null, reason: 'TENANT_CHANGED',
  });
  const before = f.requests.length;
  await assert.rejects(pinned.search('query'), { code: 'TENANT_CHANGED' });
  assert.equal(f.requests.length, before);
});

test('a verified domain resolves to its tenant GUID before sign-in', async t => {
  const env = await isolatedEnvironment(t);
  const seen = [];
  const config = loadConfig({ env, deployment: deployment('https://gateway.example/inference/memory', 'contoso.onmicrosoft.com') });
  const client = createClient({ config,
    fetch: async (url, options) => {
      seen.push(url);
      assert.equal(options.redirect, 'error');
      if (url.startsWith('https://login.microsoftonline.com/')) {
        return Response.json({ issuer: `https://login.microsoftonline.com/${OTHER}/v2.0` });
      }
      return new Response('', { status: 401, headers: { 'WWW-Authenticate': challenge(OTHER) } });
    },
    acquireToken: async (settings, request) => {
      assert.equal(settings.tenantId, OTHER);
      assert.equal(request.interactive, true);
      return { accessToken: 'fixture-access-1', expiresAt: expiry() };
    } });
  assert.equal((await client.login()).tenantId, OTHER);
  assert.deepEqual(seen, ['https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0/.well-known/openid-configuration',
    'https://gateway.example/inference/memory/whoami']);
});

test('hooks and canvas use the gateway scope; only MCP headers use the MCP scope', async t => {
  const f = await fixture(t, { tenantId: PINNED });
  await f.client.login();
  f.requests.length = 0;
  const background = f.make(PINNED);
  await background.capture({ thread_id: 'thread', role: 'agent', content: 'Remember this.' });
  await background.search('query');
  await background.getMemories();
  assert.deepEqual(f.requests, [{ tenantId: PINNED, resource: 'gateway' }]);
  assert.equal(await background.getAccessToken('mcp'), 'fixture-mcp-access-1');
  assert.deepEqual(f.requests.at(-1), { tenantId: PINNED, resource: 'mcp' });
  const data = f.gateway.state.requests.filter(request => !request.path.endsWith('/whoami'));
  assert.ok(data.every(request => request.authorization === 'Bearer fixture-access-1'));
  assert.deepEqual(data.map(request => request.path), ['/inference/memory/memory', '/inference/memory/search', '/inference/memory/memories']);
  await assert.rejects(background.getAccessToken('other'), { code: 'INVALID_CONFIG' });
});

test('mh-status and headers report the tenant and MCP token without exposing credentials', async t => {
  const env = await isolatedEnvironment(t);
  const pluginRoot = join(env.HOME, 'plugin');
  await mkdir(pluginRoot);
  await writeFile(join(pluginRoot, 'deployment.json'), JSON.stringify(fixtureDeployment()));
  await seedEntraSession(env);
  const output = [];
  const run = command => runAuthCommand(command, { env, pluginRoot, stdout: { write: line => output.push(line) }, stderr: { write() {} } });
  const status = await run('status');
  assert.equal(status.signedIn, true);
  assert.equal(status.tenantId, PINNED);
  assert.equal((await run('headers')).Authorization, 'Bearer fixture-mcp-access-1');
  assert.doesNotMatch(output[0], /fixture-/);
});
