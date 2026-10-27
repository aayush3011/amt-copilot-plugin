import { loadConfig } from '../../src/config.mjs';
import { createCacheProtection } from '../../src/cache-protection.mjs';
import { atomicJson, ensureDirectory } from '../../src/state.mjs';
import { fixtureDeployment } from './deployment.mjs';

export function fixtureIdToken(config, now = Math.floor(Date.now() / 1000)) {
  return `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({
    tid: config.tenantId, oid: 'fixture-user', sub: 'fixture-user', preferred_username: 'fixture@example.test',
    aud: config.clientId, iss: `https://login.microsoftonline.com/${config.tenantId}/v2.0`, exp: now + 3600, iat: now,
  })).toString('base64url')}.fixture`;
}

export async function seedEntraSession(env, deployment = fixtureDeployment(), accessToken = 'fixture-access-1',
  { expired = false, refreshToken } = {}) {
  const config = loadConfig({ env, deployment });
  const accountId = `fixture-user.${config.tenantId}`;
  const environment = 'login.microsoftonline.com';
  const now = Math.floor(Date.now() / 1000);
  const idToken = fixtureIdToken(config, now);
  const cache = JSON.stringify({
    Account: {
      [`${accountId}-${environment}-${config.tenantId}`]: {
        home_account_id: accountId, environment, realm: config.tenantId,
        local_account_id: 'fixture-user', username: 'fixture@example.test', authority_type: 'MSSTS',
      },
    },
    AccessToken: {
      [`${accountId}-${environment}-accesstoken-${config.clientId}-${config.tenantId}-${config.scope}--`]: {
        home_account_id: accountId, environment, credential_type: 'AccessToken', client_id: config.clientId,
        secret: accessToken, realm: config.tenantId, target: config.scope, token_type: 'Bearer',
        cached_at: String(now - 3600), expires_on: String(now + (expired ? -10 : 3600)), extended_expires_on: String(now + (expired ? -10 : 3600)),
      },
    },
    IdToken: {
      [`${accountId}-${environment}-idtoken-${config.clientId}-${config.tenantId}--`]: {
        home_account_id: accountId, environment, credential_type: 'IdToken', client_id: config.clientId,
        secret: idToken, realm: config.tenantId,
      },
    },
    RefreshToken: refreshToken ? {
      [`${accountId}-${environment}-refreshtoken-${config.clientId}---`]: {
        home_account_id: accountId, environment, credential_type: 'RefreshToken', client_id: config.clientId,
        secret: refreshToken,
      },
    } : {},
    AppMetadata: {},
  });
  await ensureDirectory(config.stateDir);
  await atomicJson(config.cachePath, await createCacheProtection(config, { env }).protect(JSON.stringify({
    context: JSON.stringify([config.tenantId, config.clientId, config.scope]), accountId, cache,
  })));
  return config;
}
