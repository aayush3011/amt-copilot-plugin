import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireAzureCliToken, runAzureCli } from '../src/azure-cli.mjs';
import { createClient } from '../src/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { MemoryHouseError } from '../src/errors.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { fixtureToken, installFakeAzureCli, signInAzureCli } from './helpers/azure-cli.mjs';
import { isolatedEnvironment } from './helpers/runtime.mjs';

async function setup(t, options = {}) {
  const env = await isolatedEnvironment(t);
  const config = loadConfig({ env, deployment: fixtureDeployment(), ...options });
  return { env, config };
}

test('token acquisition requests the exact tenant and scope without copying credentials', async t => {
  const { env, config } = await setup(t);
  await signInAzureCli(env);
  const value = await acquireAzureCliToken(config, { env });
  assert.equal(value.accessToken, 'fixture-access-1');
  const calls = (await readFile(join(env.AZURE_CONFIG_DIR, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [['account', 'get-access-token', '--tenant', config.tenantId, '--scope', config.scope,
    '--output', 'json', '--only-show-errors']]);
  await assert.rejects(access(config.stateDir), { code: 'ENOENT' });
});

test('malformed, expired, wrong-tenant and non-Bearer CLI responses are rejected safely', async t => {
  const { config } = await setup(t);
  for (const value of [null, [], {}, fixtureToken({ accessToken: '' }), fixtureToken({ accessToken: 'secret\nheader' }),
    fixtureToken({ accessToken: 'x'.repeat(32 * 1024 + 1) }), fixtureToken({ tokenType: 'HookToken' }),
    fixtureToken({ tokenType: 1 }), fixtureToken({ tenant: 1 }), fixtureToken({ tenant: 'other' }),
    fixtureToken({ expires_on: undefined }), fixtureToken({ expires_on: 1 }),
    fixtureToken({ expires_on: 1.2 }), fixtureToken({ expires_on: '1e20' })]) {
    await assert.rejects(acquireAzureCliToken(config, { run: async () => JSON.stringify(value) }), error =>
      error.code === 'AZURE_CLI_TOKEN_INVALID' && !error.message.includes('secret'));
  }
  await assert.rejects(acquireAzureCliToken(config, { run: async () => 'not-json-secret' }), { code: 'AZURE_CLI_OUTPUT_INVALID' });
  const seconds = Math.floor(Date.now() / 1000) + 3600;
  assert.equal((await acquireAzureCliToken(config, { run: async () => JSON.stringify(fixtureToken({ expires_on: String(seconds) })) })).expiresAt, seconds);
});

test('missing CLI, noninteractive sign-in failures and unsafe arguments fail without provider output', async t => {
  const { env, config } = await setup(t);
  await assert.rejects(acquireAzureCliToken(config, { env: { PATH: '' } }), { code: 'AZURE_CLI_NOT_FOUND' });
  await assert.rejects(acquireAzureCliToken(config, { env }), error =>
    error.code === 'AZURE_CLI_AUTH_REQUIRED' && !error.message.includes('fixture-provider-secret'));
  await assert.rejects(runAzureCli(['account', '&whoami'], { env, timeoutMs: 1000 }), { code: 'INVALID_ENTRA_CONFIG' });
  for (const extra of [{ tenantId: 'common' }, { scope: 'https://gateway/.default&whoami' }, { scope: 'x --flag' }]) {
    await assert.rejects(acquireAzureCliToken({ ...config, ...extra }, { run: () => assert.fail('must not run') }), { code: 'INVALID_ENTRA_CONFIG' });
  }
});

test('CLI timeout and response bounds return safe failures', async t => {
  const { env, config } = await setup(t, { authTimeoutMs: 1500 });
  await assert.rejects(acquireAzureCliToken(config, { env: { ...env, MH_FAKE_AZ_HANG: '1' } }), { code: 'AZURE_CLI_TIMEOUT' });
  const pid = Number(await readFile(join(env.AZURE_CONFIG_DIR, 'hung-pid'), 'utf8'));
  const alive = () => {
    try { process.kill(pid, 0); return true; } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      return false;
    }
  };
  for (let attempt = 0; attempt < 40 && alive(); attempt++) await delay(25);
  assert.equal(alive(), false, 'timeout must stop the CLI child, not just its shell');
  await writeFile(join(env.AZURE_CONFIG_DIR, 'token.json'), 'secret'.repeat(32 * 1024));
  await assert.rejects(acquireAzureCliToken({ ...config, authTimeoutMs: 5000 }, { env }), { code: 'AZURE_CLI_OUTPUT_INVALID' });
});

test('CLI launcher paths with spaces and shell punctuation remain literal', async t => {
  const { env, config } = await setup(t);
  const cli = await installFakeAzureCli(join(env.HOME, 'CLI path & (test) !literal!'));
  const isolated = { ...env, PATH: cli.bin, AZURE_CONFIG_DIR: cli.config };
  await signInAzureCli(isolated);
  assert.equal((await acquireAzureCliToken(config, { env: isolated })).accessToken, 'fixture-access-1');
});

test('client deduplicates acquisition and reacquires near expiry without a persistent token cache', async t => {
  const { config } = await setup(t);
  let now = 1_800_000_000_000;
  let acquisitions = 0;
  const client = createClient({ config, clock: () => now, acquireToken: async () => {
    acquisitions++;
    await delay(20);
    return { accessToken: `fixture-access-${acquisitions}`, expiresAt: now / 1000 + 3600 };
  } });
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => client.getAccessToken())), Array(6).fill('fixture-access-1'));
  now += 3_500_000;
  assert.equal(await client.getAccessToken(), 'fixture-access-2');
  assert.equal(acquisitions, 2);
  await assert.rejects(access(config.stateDir), { code: 'ENOENT' });
});

test('logout blocks ongoing acquisition and other clients until explicit login, without calling CLI logout', async t => {
  const { config } = await setup(t);
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const options = { config, acquireToken: async () => {
    entered();
    await pending;
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
  const state = await readFile(config.authStatePath, 'utf8');
  assert.equal(JSON.parse(state).disabled, false);
  assert.match(JSON.parse(state).generation, /^[a-f\d-]{36}$/i);
  assert.doesNotMatch(state, /fixture-access|refresh/);
});

test('an explicit login invalidates old in-memory tokens in long-lived clients', async t => {
  const { config } = await setup(t);
  let account = 'one';
  const options = { config, acquireToken: async () => ({
    accessToken: `fixture-account-${account}`, expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }) };
  const canvas = createClient(options);
  const helper = createClient(options);
  await helper.login();
  assert.equal(await canvas.getAccessToken(), 'fixture-account-one');
  account = 'two';
  await helper.login();
  assert.equal(await canvas.getAccessToken(), 'fixture-account-two');
});

test('migration ignores legacy credentials and removes them only on explicit login or logout', async t => {
  const { config } = await setup(t);
  await mkdir(config.stateDir);
  const legacy = join(config.stateDir, 'token.json');
  await writeFile(legacy, 'legacy-secret-not-json');
  const denied = createClient({ config, acquireToken: async () => { throw new MemoryHouseError('AZURE_CLI_AUTH_REQUIRED', 'Sign in.'); } });
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
