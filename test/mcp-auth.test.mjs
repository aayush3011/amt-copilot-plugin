import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createClient } from '../src/client.mjs';
import { MemoryHouseError } from '../src/errors.mjs';
import { createMemoryServer } from '../src/mcp.mjs';
import { loginWithEntra } from '../src/entra.mjs';
import { openBrowserUrl } from '../src/browser.mjs';
import { isolatedEnvironment } from './helpers/runtime.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { mockGateway } from './helpers/gateway.mjs';

const data = response => JSON.parse(response.content[0].text);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function fixture(t, login = async () => { throw new Error('Unexpected fixture authentication'); }) {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const client = createClient({ env, deployment: fixtureDeployment(gateway.base) });
  const app = createMemoryServer({ env, clientFactory: () => client, login });
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'memory-house-auth-fixture', version: '1.0.0' });
  t.after(async () => { await app.close(); await mcp.close(); });
  await app.server.connect(peer);
  await mcp.connect(transport);
  return { gateway, client, app, mcp, call: (name, input = {}, options) => mcp.callTool({ name, arguments: input }, undefined, options) };
}

test('direct login passes only the configured client and suppresses provider messages and returned credentials', async t => {
  let args;
  const f = await fixture(t, async options => {
    args = options;
    options.onMessage('fixture-provider-secret');
    await options.client.redeem('fixture-enrollment');
    return { access_token: 'fixture-access-secret', message: 'fixture-provider-secret' };
  });
  const response = await f.call('memory_login');
  assert.equal(response.isError, undefined);
  assert.equal(data(response).signedIn, true);
  assert.equal(args.client, f.client);
  assert.equal(args.mode, 'browser');
  assert.ok(args.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(args).sort(), ['client', 'mode', 'onMessage', 'signal']);
  assert.doesNotMatch(JSON.stringify(response), /fixture-|https?:/);
  const status = data(await f.call('memory_status'));
  assert.equal(status.login.state, 'complete');
  assert.equal(status.signedIn, true);
  assert.equal(status.gatewayBase, undefined);
  assert.doesNotMatch(JSON.stringify(status), /fixture-|https?:/);
  assert.equal(f.gateway.state.requests.length, 1);
});

test('login never claims success without usable locally persisted credentials', async t => {
  const f = await fixture(t, async () => ({ signedIn: true }));
  const response = await f.call('memory_login');
  assert.equal(response.isError, true);
  assert.equal(data(response).code, 'SIGN_IN_NOT_CONFIRMED');
  assert.equal(data(await f.call('memory_status')).login.state, 'error');
  assert.equal(f.gateway.state.requests.length, 0);
});

test('auth errors are actionable but never disclose arbitrary provider error text', async t => {
  const f = await fixture(t, async () => { throw new Error('fixture-provider-secret'); });
  const response = await f.call('memory_login');
  assert.equal(response.isError, true);
  assert.equal(data(response).code, 'OPERATION_FAILED');
  assert.match(data(response).nextStep, /memory_login/);
  assert.doesNotMatch(JSON.stringify(response), /fixture-provider-secret/);
  assert.doesNotMatch(JSON.stringify(await f.call('memory_status')), /fixture-provider-secret/);
});

test('in-flight login allows status but rejects overlapping login or logout without duplicate redemption', async t => {
  const started = deferred();
  const finish = deferred();
  const f = await fixture(t, async ({ client, signal }) => {
    started.resolve();
    await Promise.race([
      finish.promise,
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new MemoryHouseError('ENTRA_LOGIN_CANCELLED', 'Sign-in cancelled.')), { once: true })),
    ]);
    await client.redeem('fixture-enrollment');
  });
  const pending = f.call('memory_login');
  await started.promise;
  assert.equal(data(await f.call('memory_status')).login.state, 'running');
  for (const name of ['memory_login', 'memory_logout']) {
    const busy = await f.call(name);
    assert.equal(busy.isError, true);
    assert.equal(data(busy).code, 'AUTH_OPERATION_IN_PROGRESS');
  }
  finish.resolve();
  assert.equal(data(await pending).signedIn, true);
  assert.equal(data(await f.call('memory_logout')).signedOut, true);
  assert.equal(data(await f.call('memory_status')).login.state, 'idle');
  assert.equal(f.gateway.state.requests.filter(req => req.path.endsWith('/redeem')).length, 1);
  assert.equal(f.gateway.state.requests.filter(req => req.path.endsWith('/revoke')).length, 1);
});

test('MCP cancellation and shutdown abort the direct authentication helper', async t => {
  for (const mode of ['request', 'shutdown']) {
    await t.test(mode, async t => {
      const started = deferred();
      const cancelled = deferred();
      let signal;
      const f = await fixture(t, options => {
        signal = options.signal;
        started.resolve();
        return new Promise((_, reject) => signal.addEventListener('abort', () => {
          cancelled.resolve();
          reject(new MemoryHouseError('ENTRA_LOGIN_CANCELLED', 'Sign-in cancelled.'));
        }, { once: true }));
      });
      const controller = new AbortController();
      const pending = f.call('memory_login', {}, { signal: controller.signal });
      const rejected = assert.rejects(pending);
      await started.promise;
      if (mode === 'request') controller.abort();
      else await f.app.close();
      await cancelled.promise;
      await rejected;
      assert.equal(signal.aborted, true);
      assert.equal(f.gateway.state.requests.length, 0);
      if (mode === 'request') {
        await setImmediate();
        assert.equal(data(await f.call('memory_status')).login.state, 'cancelled');
      }
    });
  }
});

test('cancelling an MCP sign-in closes its actual OAuth callback listener without enrollment', async t => {
  const opened = deferred();
  const finished = deferred();
  const f = await fixture(t, options => loginWithEntra({
    ...options,
    pca: {
      async getAuthCodeUrl(request) {
        const url = new URL('https://login.microsoftonline.com/fixture/oauth2/v2.0/authorize');
        url.searchParams.set('redirect_uri', request.redirectUri);
        url.searchParams.set('state', request.state);
        return url.href;
      },
      async acquireTokenByCode() { throw new Error('Unexpected token exchange'); },
    },
    openBrowser: async url => { opened.resolve(new URL(url).searchParams.get('redirect_uri')); },
    fetch: async () => { throw new Error('Unexpected network request'); },
  }).finally(finished.resolve));
  const controller = new AbortController();
  const pending = f.call('memory_login', {}, { signal: controller.signal });
  const rejected = assert.rejects(pending);
  const callback = await opened.promise;
  const response = await fetch(callback);
  assert.equal(response.status, 400);
  await response.text();
  controller.abort();
  await rejected;
  await finished.promise;
  await assert.rejects(fetch(callback));
  assert.equal(f.gateway.state.requests.length, 0);
});

test('logout is explicit, truthful and secret-free, including revocation failure after local clearing', async t => {
  const f = await fixture(t);
  const tools = (await f.mcp.listTools()).tools;
  assert.equal(tools.find(tool => tool.name === 'memory_logout').annotations.destructiveHint, true);
  const missing = await f.call('memory_logout');
  assert.equal(missing.isError, undefined);
  assert.equal(data(missing).revoked, false);
  assert.equal(f.gateway.state.requests.length, 0);
  await f.client.redeem('fixture-enrollment');
  f.gateway.state.revokeStatus = 503;
  const failed = await f.call('memory_logout');
  assert.equal(failed.isError, true);
  assert.equal(data(failed).code, 'REVOCATION_FAILED');
  assert.match(data(failed).message, /Local.*cleared/);
  assert.doesNotMatch(JSON.stringify(failed), /fixture-/);
  assert.equal(data(await f.call('memory_status')).signedIn, false);
});

test('the browser opener rejects loopback pages and non-Microsoft URLs without spawning a browser', async () => {
  for (const url of ['http://127.0.0.1:63485/', 'https://example.test', 'https://user:password@login.microsoftonline.com/', 'https://login.microsoftonline.com/#secret']) {
    await assert.rejects(openBrowserUrl(url), { code: 'BROWSER_URL_INVALID' });
  }
});
