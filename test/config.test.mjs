import assert from 'node:assert/strict';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig as loadPublisherConfig, requirePublisherConfig } from '../src/config.mjs';
import { PLUGIN_ROOT } from '../scripts/package-files.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { isolatedEnvironment } from './helpers/runtime.mjs';

const loadConfig = options => loadPublisherConfig({ pluginRoot: PLUGIN_ROOT, ...options });

test('packaged publisher defaults contain the verified public registration and exact callback', async t => {
  const env = await isolatedEnvironment(t);
  const config = loadConfig({ env });
  assert.equal(config.tenantId, '72f988bf-86f1-41af-91ab-2d7cd011db47');
  assert.equal(config.clientId, '45cdeed7-4e4e-481d-9f00-6708c0631565');
  assert.equal(config.scope, 'api://45cdeed7-4e4e-481d-9f00-6708c0631565/Inference.Execute');
  assert.equal(config.redirectUri, 'http://127.0.0.1:33418');
  assert.deepEqual(config.publisherMissing, []);
  assert.doesNotThrow(() => requirePublisherConfig(config));
  assert.equal(config.hookBase, `${config.gatewayBase}/hook`);
  assert.equal(config.mcpUrl, `${config.gatewayBase}/mcp/`);
  await assert.rejects(access(config.stateDir), { code: 'ENOENT' });
});

test('environment endpoints, token overrides and old per-user config cannot repoint the publisher deployment', async t => {
  const env = await isolatedEnvironment(t);
  await mkdir(env.MEMORY_HOUSE_HOME);
  await writeFile(join(env.MEMORY_HOUSE_HOME, 'config.json'), '{"gatewayBase":"https://wrong.example","auth":{"clientId":"wrong"}}');
  await writeFile(join(env.MEMORY_HOUSE_HOME, 'token.json'), 'not read during configuration');
  const config = loadConfig({
    env: { ...env, MEMORY_HOUSE_GATEWAY: 'https://wrong.example', AMT_GATEWAY_BASE: 'https://wrong.example',
      MEMORY_HOUSE_ENTRA_CLIENT_ID: 'wrong', AMT_ACCESS_TOKEN: 'fake-secret' },
  });
  assert.equal(config.clientId, '45cdeed7-4e4e-481d-9f00-6708c0631565');
  assert.notEqual(config.gatewayBase, 'https://wrong.example');
  assert.equal(await readFile(join(env.MEMORY_HOUSE_HOME, 'token.json'), 'utf8'), 'not read during configuration');
});

test('publisher metadata is loaded from deployment.json rather than native MCP transport definitions', async t => {
  const env = await isolatedEnvironment(t);
  const root = join(env.HOME, 'package');
  await mkdir(root);
  await writeFile(join(root, 'deployment.json'), JSON.stringify(fixtureDeployment('https://chosen.example/memory/mcp/')));
  await writeFile(join(root, 'mcp.json'), '{"mcpServers":{"memory-house":{"command":"node","args":["runtime/server.mjs"]}}}');
  assert.equal(loadConfig({ env, pluginRoot: root }).gatewayBase, 'https://chosen.example/memory');
  await writeFile(join(root, 'deployment.json'), '{fake-secret');
  assert.throws(() => loadConfig({ env, pluginRoot: root }), error =>
    error.code === 'INVALID_DEPLOYMENT' && !error.message.includes('fake-secret'));
});

test('missing public settings are named as publisher work, not an end-user configuration form', async t => {
  const env = await isolatedEnvironment(t);
  const deployment = fixtureDeployment();
  deployment.entra.clientId = null;
  deployment.entra.redirectUri = null;
  const config = loadConfig({ env, deployment });
  assert.deepEqual(config.publisherMissing, ['entra.clientId', 'entra.redirectUri']);
  assert.throws(() => requirePublisherConfig(config), error =>
    error.code === 'PUBLISHER_CONFIG_MISSING' && /publisher/.test(error.message));
});

test('publisher files reject credential fields and invalid shapes without reflecting secret values', async t => {
  const env = await isolatedEnvironment(t);
  const valid = fixtureDeployment();
  for (const deployment of [null, [], { ...valid, version: 2 }, { ...valid, access_token: 'fake-secret' },
    { ...valid, entra: [] }, { ...valid, entra: { ...valid.entra, clientSecret: 'fake-secret' } },
    { ...valid, entra: { ...valid.entra, tenantId: 'invalid\nline' } }]) {
    const options = { env, deployment: deployment ?? {} };
    assert.throws(() => loadConfig(options), error =>
      error.code === 'INVALID_DEPLOYMENT' && !error.message.includes('fake-secret'));
  }
});

test('gateways require HTTPS except explicitly enabled loopback fixtures', async t => {
  const env = await isolatedEnvironment(t);
  for (const gatewayBase of ['/relative', 'https:example.com', 'file:///tmp', 'http://remote.example',
    'https://example.test/?token=fake-secret', 'https://example.test/#bad', 'https://u:p@example.test',
    'https://example.test\\bad', 'http://127.0.0.1:1234']) {
    assert.throws(() => loadConfig({ env: { ...env, MH_ALLOW_INSECURE_LOCALHOST: '' }, deployment: fixtureDeployment(gatewayBase) }), error =>
      ['INVALID_GATEWAY', 'INSECURE_GATEWAY'].includes(error.code) && !error.message.includes('fake-secret'));
  }
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(loadConfig({ env, deployment: fixtureDeployment(`http://${host}:1234/memory`) }).gatewayBase, `http://${host}:1234/memory`);
  }
});

test('state selection and limits are bounded and malformed state settings fail explicitly', async t => {
  const env = await isolatedEnvironment(t);
  const config = loadConfig({ env: { ...env, MEMORY_HOUSE_HOME: '~/memory', MEMORY_HOUSE_TIMEOUT_MS: '4000',
    MEMORY_HOUSE_LOCK_TIMEOUT_MS: '1500', MEMORY_HOUSE_TOKEN_SKEW_SECONDS: '30' } });
  assert.equal(config.stateDir, join(env.HOME, 'memory'));
  assert.equal(config.timeoutMs, 4000);
  assert.equal(config.lockTimeoutMs, 1500);
  assert.equal(config.tokenSkewSeconds, 30);
  for (const override of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { lockTimeoutMs: -1 },
    { maxResponseBytes: 0 }, { tokenSkewSeconds: -1 }, { stateDir: '/' }, { stateDir: '' }, { stateDir: '\0' }]) {
    assert.throws(() => loadConfig({ env, ...override }), { code: 'INVALID_CONFIG' });
  }
});

test('a linked state directory cannot redirect credential access', { skip: process.platform === 'win32' }, async t => {
  const env = await isolatedEnvironment(t);
  const target = join(env.HOME, 'untouched');
  await mkdir(target);
  await symlink(target, env.MEMORY_HOUSE_HOME);
  assert.throws(() => loadConfig({ env }), { code: 'UNSAFE_STATE' });
});
