import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import test from 'node:test';
import { createSetupService } from '../src/setup.mjs';
import { createClient, MemoryHouseError } from '../src/client.mjs';
import { mockGateway } from './helpers/gateway.mjs';
import { isolatedEnvironment } from './helpers/runtime.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';

async function fixture(t, overrides = {}) {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const deployment = fixtureDeployment(gateway.base);
  const service = createSetupService({ env, clientOptions: { deployment }, ...overrides });
  t.after(() => service.close());
  const opened = await service.open();
  const response = await fetch(opened.url);
  const html = await response.text();
  const csrf = JSON.parse(/const csrf=("[a-f0-9]+");/.exec(html)[1]);
  const headers = { 'x-memory-house-setup': csrf, 'Content-Type': 'application/json', Origin: new URL(opened.url).origin };
  const api = (path, body) => fetch(new URL(path, opened.url), {
    method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { gateway, env, deployment, service, opened, headers, api, html };
}

test('local setup enforces host/origin/CSRF checks and never starts sign-in from a GET', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/state')).status, 200);
  const endpoint = new URL('/api/config', f.opened.url);
  for (const headers of [
    { 'Content-Type': 'application/json' },
    { ...f.headers, Origin: 'https://attacker.example' },
    { ...f.headers, Host: 'attacker.example' },
    { ...f.headers, 'sec-fetch-site': 'cross-site' },
    { ...f.headers, 'x-memory-house-setup': 'x'.repeat(64) },
  ]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(endpoint, { method: 'POST', headers }, res => {
        res.resume();
        res.once('end', () => resolve(res.statusCode));
      });
      req.once('error', reject);
      req.end('{}');
    });
    assert.equal(status, 403);
  }
  assert.equal((await f.api('/api/login')).status, 404);
  assert.equal(f.gateway.state.requests.length, 0);
});

test('sign-in has no configuration form or endpoint and cannot accept identity or endpoint overrides', async t => {
  const f = await fixture(t);
  const input = { gatewayBase: f.gateway.base, auth: {
    tenantId: 'example.onmicrosoft.com', clientId: '11111111-1111-1111-1111-111111111111',
    scope: 'api://example/memory.access', redirectUri: 'http://127.0.0.1:8400/callback',
  } };
  assert.equal((await f.api('/api/config', input)).status, 404);
  assert.doesNotMatch(f.html, /<input|<form|Save public settings|\/api\/config/);
  assert.equal((await f.api('/api/config', { ...input, access_token: 'fixture-secret' })).status, 404);
  assert.equal((await f.api('/api/login', { gatewayBase: 'https://wrong.example', access_token: 'fixture-secret' })).status, 400);
  await assert.rejects(access(join(f.env.MEMORY_HOUSE_HOME, 'config.json')), { code: 'ENOENT' });
  assert.equal(f.gateway.state.requests.length, 0);
});

test('human-triggered sign-in uses publisher settings, never exposes provider text, and reports safe status', async t => {
  let args;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { login: async value => {
    args = value;
    value.onMessage('fixture-entra-secret fixture-enrollment');
    await waiting;
    return value.client.redeem('fixture-enrollment');
  } });
  const started = await f.api('/api/login', {});
  assert.equal(started.status, 202);
  assert.equal(args.client.config.scope, f.deployment.entra.scope);
  assert.equal(args.mode, 'browser');
  assert.equal((await f.api('/api/login', {})).status, 409);
  assert.equal((await f.api('/api/logout', {})).status, 409);
  release();
  for (let index = 0; index < 30 && f.service.status().state === 'running'; index++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.service.status().state, 'complete');
  const state = await (await f.api('/api/state')).json();
  assert.equal(state.status.signedIn, true);
  assert.doesNotMatch(JSON.stringify(state), /fixture-(entra|access|refresh|enrollment)/);
  assert.equal((await createClient({ env: f.env, deployment: f.deployment }).status()).signedIn, true);
  assert.equal((await f.api('/api/logout', {})).status, 200);
  assert.equal((await createClient({ env: f.env, deployment: f.deployment }).status()).signedIn, false);
});

test('setup expiry closes the loopback listener and error messages do not disclose tokens', async t => {
  const f = await fixture(t, { lifetimeMs: 150 });
  await new Promise(resolve => setTimeout(resolve, 200));
  await assert.rejects(fetch(f.opened.url));
  const { safeError } = await import('../src/setup.mjs');
  assert.doesNotMatch(JSON.stringify(safeError(new Error('fixture-secret'))), /fixture-secret/);
  assert.equal(safeError(new MemoryHouseError('NOT_SIGNED_IN', 'Sign in first.')).code, 'NOT_SIGNED_IN');
});
