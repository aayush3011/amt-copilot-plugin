import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { createClient, loginWithEntra } = await import(pathToFileURL(process.argv[2]).href);
const client = createClient();
const tenantId = '33333333-3333-3333-3333-333333333333';
const clientId = '11111111-1111-1111-1111-111111111111';
const user = '44444444-4444-4444-4444-444444444444';
const scope = 'api://22222222-2222-2222-2222-222222222222/memory.access';
const authority = `https://login.microsoftonline.com/${tenantId}`;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
let challenge;
let exchanged = false;
const transport = async (url, options) => {
  const parsed = new URL(url);
  assert.equal(options.redirect, 'error');
  if (parsed.origin === new URL(client.config.gatewayBase).origin) return fetch(url, options);
  assert.equal(parsed.origin, 'https://login.microsoftonline.com');
  if (parsed.pathname.includes('/discovery/instance')) {
    return json({
      tenant_discovery_endpoint: `${authority}/v2.0/.well-known/openid-configuration`,
      metadata: [{ preferred_network: 'login.microsoftonline.com', preferred_cache: 'login.windows.net', aliases: ['login.microsoftonline.com', 'login.windows.net'] }],
    });
  }
  if (parsed.pathname.includes('.well-known/openid-configuration')) {
    return json({
      authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
      token_endpoint: `${authority}/oauth2/v2.0/token`,
      end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
      issuer: `${authority}/v2.0`,
      jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
    });
  }
  assert.ok(parsed.pathname.endsWith('/oauth2/v2.0/token'));
  const form = new URLSearchParams(options.body);
  assert.equal(form.get('code'), 'fixture-auth-code');
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge);
  exchanged = true;
  const now = Math.floor(Date.now() / 1000);
  return json({
    token_type: 'Bearer', scope, expires_in: 3600,
    access_token: 'fixture-entra', refresh_token: 'fixture-entra-refresh',
    client_info: encoded({ uid: user, utid: tenantId }),
    id_token: `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({
      tid: tenantId, oid: user, sub: user, aud: clientId, iss: `${authority}/v2.0`,
      iat: now, exp: now + 3600, preferred_username: 'synthetic@example.invalid',
    })}.fixture-signature`,
  });
};
const result = await loginWithEntra({
  client, tenantId, clientId, scope, fetch: transport, redirectUri: 'http://127.0.0.1:0/callback',
  timeoutMs: 5000, onMessage: () => {},
  openBrowser: async value => {
    const url = new URL(value);
    challenge = url.searchParams.get('code_challenge');
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', url.searchParams.get('state'));
    callback.searchParams.set('code', 'fixture-auth-code');
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    await response.text();
  },
});
assert.equal(exchanged, true);
assert.equal(result.signedIn, true);
assert.doesNotMatch(JSON.stringify(result), /fixture-(entra|auth|access|refresh|enrollment)/);
process.stdout.write('{"signedIn":true,"pkce":true}\n');
