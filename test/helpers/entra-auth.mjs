import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function syntheticEntra(config, { behavior = 'success' } = {}) {
  const actualFetch = globalThis.fetch;
  const gateway = new URL(config.gatewayBase);
  assert.equal(gateway.protocol, 'http:');
  assert.equal(gateway.hostname, '127.0.0.1');
  const { tenantId, clientId, scope } = config;
  const authority = `https://login.microsoftonline.com/${tenantId}`;
  const user = '44444444-4444-4444-4444-444444444444';
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const state = { browserCalls: 0, exchanged: false, challenge: null };
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(options.redirect, 'error');
    if (parsed.origin === gateway.origin && parsed.pathname.startsWith(`${gateway.pathname}/`)) return actualFetch(url, options);
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
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), state.challenge);
    state.exchanged = true;
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
  const openBrowser = async value => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://login.microsoftonline.com');
    assert.equal(url.searchParams.get('client_id'), clientId);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    state.browserCalls++;
    if (behavior === 'browser-failed') throw new Error('fixture-provider-secret');
    state.challenge = url.searchParams.get('code_challenge');
    const callback = new URL(url.searchParams.get('redirect_uri'));
    assert.equal(callback.hostname, '127.0.0.1');
    assert.equal(callback.pathname, new URL(config.redirectUri).pathname);
    callback.searchParams.set('state', url.searchParams.get('state'));
    if (behavior === 'denied') {
      callback.searchParams.set('error', 'access_denied');
      callback.searchParams.set('error_description', 'fixture-provider-secret');
    } else {
      callback.searchParams.set('code', 'fixture-auth-code');
    }
    const response = await actualFetch(callback, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, behavior === 'denied' ? 400 : 200);
    assert.doesNotMatch(await response.text(), /fixture-(auth|provider|entra)/);
  };
  return { fetch, openBrowser, state };
}
