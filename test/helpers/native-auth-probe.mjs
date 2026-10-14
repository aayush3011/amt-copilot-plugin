import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../../src/config.mjs';
import { syntheticEntra } from './entra-auth.mjs';

// Runs the bundled `runtime/auth.mjs login` against synthetic Entra endpoints and a fixture gateway.
const helper = process.argv[2];
const pluginRoot = dirname(dirname(helper));
const { runAuthCommand } = await import(pathToFileURL(helper).href);
const fixture = syntheticEntra(loadConfig({ pluginRoot }));
const result = await runAuthCommand('login', {
  pluginRoot, stdout: { write() {} },
  login: { fetch: fixture.fetch, openBrowser: fixture.openBrowser, timeoutMs: 5000 },
});
assert.equal(fixture.state.browserCalls, 1);
assert.equal(fixture.state.exchanged, true);
assert.equal(result.signedIn, true);
assert.doesNotMatch(JSON.stringify(result), /fixture-(entra|auth|access|refresh|enrollment)/);
process.stdout.write('{"signedIn":true,"pkce":true}\n');
