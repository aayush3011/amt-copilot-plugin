import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runAuthCommand } from '../src/auth.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { signInAzureCli } from './helpers/azure-cli.mjs';
import { isolatedEnvironment } from './helpers/runtime.mjs';

async function setup(t) {
  const env = await isolatedEnvironment(t);
  const pluginRoot = join(env.HOME, 'plugin');
  await mkdir(pluginRoot);
  await writeFile(join(pluginRoot, 'deployment.json'), JSON.stringify(fixtureDeployment()));
  const output = [], errors = [];
  const run = command => runAuthCommand(command, { env, pluginRoot,
    stdout: { write: line => output.push(line) }, stderr: { write: line => errors.push(line) } });
  return { env, output, errors, run };
}

test('login verifies the existing CLI session without prompting or exposing credentials', async t => {
  const s = await setup(t);
  const denied = await s.run('login');
  assert.equal(denied.error.code, 'AZURE_CLI_AUTH_REQUIRED');
  assert.match(denied.error.message, /az login --tenant .* --scope https:\/\/dbinference.azure.com\/.default/);
  await signInAzureCli(s.env);
  assert.equal((await s.run('login')).signedIn, true);
  assert.equal((await s.run('status')).signedIn, true);
  assert.doesNotMatch(s.output.join(''), /fixture-access|fixture-provider-secret|refreshToken/);
  await assert.rejects(access(join(s.env.MEMORY_HOUSE_HOME, 'token.json')), { code: 'ENOENT' });
});

test('header helper uses Bearer, renews through CLI and keeps stdout JSON-only on failure', async t => {
  const s = await setup(t);
  assert.deepEqual(await s.run('headers'), {});
  assert.ok(s.errors.length);
  await signInAzureCli(s.env);
  assert.deepEqual(await s.run('headers'), { Authorization: 'Bearer fixture-access-1' });
  await signInAzureCli(s.env, { accessToken: 'fixture-access-2' });
  assert.deepEqual(await s.run('headers'), { Authorization: 'Bearer fixture-access-2' });
  assert.ok(s.output.every(line => /^\{.*\}\n$/.test(line)));
  assert.doesNotMatch(s.errors.join(''), /fixture-access|fixture-provider-secret/);
});

test('logout disables all plugin helpers without clearing the shared CLI session', async t => {
  const s = await setup(t);
  await signInAzureCli(s.env);
  await s.run('login');
  const cliCache = await readFile(join(s.env.AZURE_CONFIG_DIR, 'token.json'), 'utf8');
  const result = await s.run('logout');
  assert.equal(result.signedOut, true);
  assert.equal(result.azureCliSignedOut, false);
  assert.equal((await s.run('status')).signedIn, false);
  assert.deepEqual(await s.run('headers'), {});
  assert.equal(await readFile(join(s.env.AZURE_CONFIG_DIR, 'token.json'), 'utf8'), cliCache);
  assert.equal((await s.run('login')).signedIn, true);
  assert.equal((await s.run('status')).signedIn, true);
  const calls = await readFile(join(s.env.AZURE_CONFIG_DIR, 'calls.jsonl'), 'utf8');
  assert.ok(calls.trim().split('\n').every(line => JSON.parse(line)[0] === 'account'));
});

test('helper usage and CLI failures are explicit and sanitized', async t => {
  const s = await setup(t);
  assert.equal((await s.run('bogus')).error.code, 'USAGE');
  assert.equal((await s.run('status')).needsLogin, true);
  await signInAzureCli(s.env, { accessToken: 'invalid\nheader' });
  assert.equal((await s.run('login')).error.code, 'AZURE_CLI_TOKEN_INVALID');
  assert.doesNotMatch(s.output.join(''), /fixture-provider-secret|invalid\\nheader/);
});
