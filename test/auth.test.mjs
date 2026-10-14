import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runAuthCommand } from '../src/auth.mjs';
import { createClient } from '../src/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { syntheticEntra } from './helpers/entra-auth.mjs';
import { mockGateway } from './helpers/gateway.mjs';
import { isolatedEnvironment } from './helpers/runtime.mjs';

async function setup(t) {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const pluginRoot = join(env.HOME, 'plugin');
  await mkdir(pluginRoot);
  await writeFile(join(pluginRoot, 'deployment.json'), JSON.stringify(fixtureDeployment(gateway.base)));
  const output = [];
  const run = (command, options = {}) => runAuthCommand(command, { env, pluginRoot, stdout: { write: line => output.push(line) }, ...options });
  const config = loadConfig({ env, pluginRoot });
  const signIn = () => createClient({ config }).redeem('fixture-enrollment');
  return { gateway, output, run, signIn, config };
}

test('the status helper reports local sign-in without network calls, credentials or URLs', async t => {
  const s = await setup(t);
  assert.deepEqual(await s.run('status'), {
    signedIn: false, needsLogin: true, canRefresh: false, accessExpiresAt: null, refreshExpiresAt: null,
  });
  assert.equal(s.gateway.state.requests.length, 0);
  await s.signIn();
  const requests = s.gateway.state.requests.length;
  const status = await s.run('status');
  assert.equal(status.signedIn, true);
  assert.equal(status.needsLogin, false);
  assert.equal(s.gateway.state.requests.length, requests);
  assert.equal(s.output.length, 2);
  assert.doesNotMatch(s.output.join(''), /fixture-(access|refresh)|HookToken|https?:/);
});

test('the logout helper revokes the hook token and clears the shared sign-in', async t => {
  const s = await setup(t);
  await s.signIn();
  const result = await s.run('logout');
  assert.equal(result.signedOut, true);
  assert.equal(result.revoked, true);
  assert.ok(s.gateway.state.requests.some(request => request.path.endsWith('/hook/revoke')));
  assert.equal((await s.run('status')).signedIn, false);
});

test('the helper reports failures and unknown commands without credentials', async t => {
  const s = await setup(t);
  await s.signIn();
  s.gateway.state.revokeStatus = 500;
  const failed = await s.run('logout');
  assert.equal(failed.error.code, 'REVOCATION_FAILED');
  assert.equal((await s.run('status')).signedIn, false);
  assert.equal((await s.run('bogus')).error.code, 'USAGE');
  assert.doesNotMatch(s.output.join(''), /fixture-(access|refresh|provider-secret)/);
});

test('the headers helper sends the hook token only while signed in, refreshing it when needed', async t => {
  const s = await setup(t);
  assert.deepEqual(await s.run('headers'), {});
  await s.signIn();
  assert.deepEqual(await s.run('headers'), { Authorization: 'HookToken fixture-access-1' });
  const expired = JSON.parse(await readFile(s.config.tokenPath, 'utf8'));
  await writeFile(s.config.tokenPath, JSON.stringify({ ...expired, expires_at: 1 }));
  assert.deepEqual(await s.run('headers'), { Authorization: 'HookToken fixture-access-2' });
  await s.run('logout');
  assert.deepEqual(await s.run('headers'), {});
  assert.ok(s.output.every(line => /^\{.*\}\n$/.test(line)));
});

test('the login helper signs in through Microsoft and enrollment without printing credentials', async t => {
  const s = await setup(t);
  const fixture = syntheticEntra(s.config);
  const result = await s.run('login', { login: { fetch: fixture.fetch, openBrowser: fixture.openBrowser, timeoutMs: 5000 } });
  assert.equal(fixture.state.browserCalls, 1);
  assert.equal(fixture.state.exchanged, true);
  assert.equal(result.signedIn, true);
  assert.equal((await s.run('status')).signedIn, true);
  assert.ok(s.gateway.state.requests.some(request => request.path.endsWith('/hook/redeem')));
  assert.doesNotMatch(s.output.join(''), /fixture-(entra|auth|access|refresh|enrollment)|https?:/);
  const denied = syntheticEntra(s.config, { behavior: 'denied' });
  const failed = await s.run('login', { login: { fetch: denied.fetch, openBrowser: denied.openBrowser, timeoutMs: 5000 } });
  assert.ok(failed.error.code);
  assert.doesNotMatch(JSON.stringify(failed), /fixture-provider-secret/);
});
