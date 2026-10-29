// The Entra tenant mh-login signs in to. deployment.json may pin one (GUID or verified domain); without
// it, the tenant comes from the gateway's unauthenticated 401 challenge. Only the Microsoft authority
// host is trusted, and only a single tenant GUID is accepted from it.
import { isTenantGuid, MemoryHouseError } from './config.mjs';
import { sendRequest } from './client.mjs';

const AUTHORITY_HOST = 'login.microsoftonline.com';
const TENANT_PATH = /^\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\/?$/i;
const fail = (code, message) => new MemoryHouseError(code, message);

function authorityTenant(value, path = TENANT_PATH) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== AUTHORITY_HOST || url.port || url.username || url.password
    || url.search || url.hash) return null;
  return path.exec(url.pathname)?.[1].toLowerCase() ?? null;
}

/** The tenant GUID in a `Bearer authorization_uri="https://login.microsoftonline.com/<tenant>"` challenge, or null. */
export function tenantFromChallenge(header) {
  if (typeof header !== 'string' || header.length > 8192 || !/(?:^|,)\s*bearer(?:\s|$)/i.test(header)) return null;
  const tenants = new Set([...header.matchAll(/(?:^|[\s,])authorization_uri\s*=\s*(?:"([^"]*)"|([^\s,"]+))/gi)]
    .map(match => authorityTenant(match[1] ?? match[2])));
  return tenants.size === 1 && !tenants.has(null) ? [...tenants][0] : null;
}

export async function discoverTenant(config, { fetch: fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`${config.gatewayBase}/whoami`, {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(config.authTimeoutMs),
    });
  } catch {
    throw fail('TENANT_DISCOVERY_FAILED', 'Unable to reach the Memory House gateway to find its Microsoft Entra tenant. Check connectivity and retry mh-login.');
  }
  // Only the challenge header is used; the body is never read.
  void response.body?.cancel().catch(() => {});
  const tenant = response.status === 401 ? tenantFromChallenge(response.headers.get('www-authenticate')) : null;
  if (!tenant) {
    throw fail('TENANT_DISCOVERY_FAILED', 'The Memory House gateway did not identify a valid Microsoft Entra tenant. The publisher must set entra.tenantId in deployment.json.');
  }
  return tenant;
}

/** Resolves a verified domain to its tenant GUID from the domain's Microsoft OpenID metadata. */
export async function resolveDomainTenant(config, domain, { fetch: fetchImpl = globalThis.fetch } = {}) {
  let tenant = null;
  try {
    const { data } = await sendRequest({
      url: `https://${AUTHORITY_HOST}/${encodeURIComponent(domain)}/v2.0/.well-known/openid-configuration`,
      fetch: fetchImpl, method: 'GET', timeoutMs: config.authTimeoutMs, maxResponseBytes: 64 * 1024, operation: 'tenant lookup',
    });
    tenant = typeof data?.issuer === 'string' ? authorityTenant(data.issuer, /^\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\/v2\.0\/?$/i) : null;
  } catch {
    tenant = null;
  }
  if (!tenant) throw fail('TENANT_LOOKUP_FAILED', 'Unable to resolve the configured Entra tenant domain. Check connectivity and deployment.json entra.tenantId.');
  return tenant;
}

/**
 * The tenant GUID for an interactive sign-in. A pinned tenant is still compared with the gateway's
 * challenge when the gateway provides one, so a deployment cannot sign users in to the wrong tenant.
 */
export async function resolveLoginTenant(config, options = {}) {
  const setting = config.tenantId;
  const configured = !setting ? null : isTenantGuid(setting) ? setting.toLowerCase() : await resolveDomainTenant(config, setting, options);
  let discovered = null;
  try {
    discovered = await discoverTenant(config, options);
  } catch (error) {
    if (!configured) throw error;
  }
  if (configured && discovered && configured !== discovered) {
    throw fail('TENANT_MISMATCH', 'deployment.json entra.tenantId does not match the Memory House gateway tenant. The publisher must correct the deployment.');
  }
  return configured ?? discovered;
}
