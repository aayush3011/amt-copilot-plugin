import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { syntheticEntra } from './entra-auth.mjs';

const { createClient, loginWithEntra } = await import(pathToFileURL(process.argv[2]).href);
const client = createClient();
const fixture = syntheticEntra(client.config);
const result = await loginWithEntra({
  client, fetch: fixture.fetch, openBrowser: fixture.openBrowser,
  timeoutMs: 5000, onMessage: () => {},
});
assert.equal(fixture.state.browserCalls, 1);
assert.equal(fixture.state.exchanged, true);
assert.equal(result.signedIn, true);
assert.doesNotMatch(JSON.stringify(result), /fixture-(entra|auth|access|refresh|enrollment)/);
process.stdout.write('{"signedIn":true,"pkce":true}\n');
