import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runAuthCommand } from '../src/auth.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { seedEntraSession } from './helpers/entra.mjs';
import { isolatedEnvironment } from './helpers/runtime.mjs';

async function setup(t) {
  const env = await isolatedEnvironment(t);
  const pluginRoot = join(env.HOME, 'plugin');
  await mkdir(pluginRoot);
  await writeFile(join(pluginRoot, 'deployment.json'), JSON.stringify(fixtureDeployment()));
  const output = [], errors = [];
  const run = (command, extra = {}) => runAuthCommand(command, { env, pluginRoot, ...extra,
    stdout: { write: line => output.push(line) }, stderr: { write: line => errors.push(line) } });
  return { env, output, errors, run };
}

test('only explicit login requests interactive authentication and never exposes credentials', async t => {
  const s = await setup(t);
  let interactive;
  const value = await s.run('login', { acquireToken: async (config, options) => {
    interactive = options.interactive;
    return { accessToken: 'fixture-access-1', expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  } });
  assert.equal(interactive, true);
  assert.equal(value.signedIn, true);
  assert.equal(value.source, 'entra');
  assert.match(s.errors.join(''), /browser.*never enter credentials in chat/);
  assert.doesNotMatch(s.output.join(''), /fixture-access|refreshToken/);
});

test('headers and status reuse the protected MSAL session; failures keep stdout JSON-only', async t => {
  const s = await setup(t);
  assert.deepEqual(await s.run('headers'), {});
  assert.ok(s.errors.length);
  await seedEntraSession(s.env);
  assert.equal((await s.run('headers')).Authorization.split(' ')[1], 'fixture-mcp-access-1');
  assert.equal((await s.run('status')).signedIn, true);
  assert.ok(s.output.every(line => /^\{.*\}\n$/.test(line)));
  assert.doesNotMatch(s.errors.join(''), /fixture-access|fixture-refresh/);
});

test('logout removes the plugin token cache and disables background helpers', async t => {
  const s = await setup(t);
  const config = await seedEntraSession(s.env);
  assert.equal((await s.run('status')).signedIn, true);
  assert.equal((await s.run('logout')).signedOut, true);
  await assert.rejects(access(config.cachePath), { code: 'ENOENT' });
  assert.equal((await s.run('status')).signedIn, false);
  assert.deepEqual(await s.run('headers'), {});
});

test('helper usage and authentication failures are explicit and sanitized', async t => {
  const s = await setup(t);
  assert.equal((await s.run('bogus')).error.code, 'USAGE');
  assert.equal((await s.run('status')).needsLogin, true);
  const result = await s.run('login', { acquireToken: async () => { throw new Error('fixture-provider-secret'); } });
  assert.ok(result.error);
  assert.doesNotMatch(s.output.join(''), /fixture-provider-secret/);
});
