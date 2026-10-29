import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryHouseError } from './errors.mjs';
import { inspectDirectorySync } from './state.mjs';

export { MemoryHouseError } from './errors.mjs';
const AUTH_FIELDS = ['tenantId', 'clientId', 'scope', 'mcpScope', 'redirectUri'];
// Without a configured tenant, mh-login discovers it from the gateway's sign-in challenge.
const OPTIONAL_AUTH_FIELDS = new Set(['tenantId']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const GUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const SCOPE = /^(?:https:\/\/|api:\/\/)[a-z\d._:/-]+\/[a-z\d._-]+$/i;
const DOMAIN = /^(?=.{4,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/i;
// Multi-tenant authorities cannot sign in guests from personal accounts, and they would let any tenant's
// account satisfy the token tenant check.
const SHARED_AUTHORITIES = new Set(['common', 'organizations', 'consumers']);

export const isTenantGuid = value => typeof value === 'string' && GUID.test(value);
export const isTenantDomain = value => typeof value === 'string' && !SHARED_AUTHORITIES.has(value.toLowerCase()) && DOMAIN.test(value);

export function validateTenantSetting(value) {
  if (value === null || value === undefined || isTenantGuid(value) || isTenantDomain(value)) return;
  throw new MemoryHouseError('INVALID_ENTRA_CONFIG', typeof value === 'string' && SHARED_AUTHORITIES.has(value.toLowerCase())
    ? 'deployment.json entra.tenantId must name one tenant; common, organizations and consumers are not supported. Omit it to discover the gateway tenant.'
    : 'deployment.json entra.tenantId must be a tenant GUID or verified domain, or be omitted to discover the gateway tenant.');
}

export function validateEntraConfig(config) {
  const invalid = message => new MemoryHouseError('INVALID_ENTRA_CONFIG', message);
  validateTenantSetting(config.tenantId);
  if (!GUID.test(config.clientId ?? '') || typeof config.scope !== 'string' || !SCOPE.test(config.scope)
    || typeof config.mcpScope !== 'string' || !SCOPE.test(config.mcpScope)) {
    throw invalid('Configure the registered public-client ID, gateway scope and MCP scope in deployment.json.');
  }
  let url;
  try { url = new URL(config.redirectUri); } catch { throw invalid('Configure the registered loopback redirect URI.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash) {
    throw invalid('Use a registered http://127.0.0.1:<port> loopback redirect URI.');
  }
}

export function assertSafeUrl(value, { allowInsecureLocalhost = false } = {}) {
  let url;
  try {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\x00-\x20\x7f\\]/.test(value)) throw new Error('format');
    url = new URL(value);
  } catch {
    throw new MemoryHouseError('INVALID_GATEWAY', 'The publisher must provide a valid absolute Memory House gateway URL in deployment.json.');
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new MemoryHouseError('INVALID_GATEWAY', 'The gateway URL must not contain credentials, a query, or a fragment.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && allowInsecureLocalhost)) {
    throw new MemoryHouseError('INSECURE_GATEWAY', 'Memory House requires HTTPS. Isolated loopback fixtures may explicitly enable MH_ALLOW_INSECURE_LOCALHOST=1.');
  }
  return url;
}

function integer(value, fallback, name, min, max) {
  if (value === undefined || value === '') return fallback;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw new MemoryHouseError('INVALID_CONFIG', `${name} must be an integer.`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new MemoryHouseError('INVALID_CONFIG', `${name} is outside its supported range.`);
  }
  return result;
}

export function readDeployment(pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))) {
  try {
    const raw = readFileSync(join(pluginRoot, 'deployment.json'), 'utf8');
    if (Buffer.byteLength(raw) > 16 * 1024) throw new Error('size');
    return JSON.parse(raw);
  } catch {
    throw new MemoryHouseError('INVALID_DEPLOYMENT', 'Unable to read deployment.json. Reinstall a complete publisher-provided Memory House plugin.');
  }
}

export function requirePublisherConfig(config) {
  if (config.publisherMissing.length) {
    throw new MemoryHouseError('PUBLISHER_CONFIG_MISSING',
      `The publisher must configure deployment.json before Microsoft sign-in is available. Missing: ${config.publisherMissing.join(', ')}. End users should not supply application registration details.`);
  }
}

export function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const pluginRoot = options.pluginRoot ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const deployment = options.deployment ?? readDeployment(pluginRoot);
  if (!object(deployment) || deployment.version !== 1
    || Object.keys(deployment).some(key => !['version', 'gatewayBase', 'entra'].includes(key))
    || !object(deployment.entra) || Object.keys(deployment.entra).some(key => !AUTH_FIELDS.includes(key))) {
    throw new MemoryHouseError('INVALID_DEPLOYMENT', 'deployment.json must contain version 1, gatewayBase, and public entra settings only.');
  }
  const auth = {};
  const publisherMissing = [];
  for (const name of AUTH_FIELDS) {
    const value = deployment.entra[name];
    if (value === null || value === undefined || value === '') {
      auth[name] = null;
      if (!OPTIONAL_AUTH_FIELDS.has(name)) publisherMissing.push(`entra.${name}`);
    } else if (typeof value !== 'string' || value !== value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new MemoryHouseError('INVALID_DEPLOYMENT', `deployment.json entra.${name} must be public text without control characters.`);
    } else {
      auth[name] = value;
    }
  }
  validateTenantSetting(auth.tenantId);
  if (!publisherMissing.length) validateEntraConfig(auth);
  const allowInsecureLocalhost = env.MH_ALLOW_INSECURE_LOCALHOST === '1';
  const url = assertSafeUrl(deployment.gatewayBase, { allowInsecureLocalhost });
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/mcp$/, '').replace(/\/+$/, '');
  const gatewayBase = url.href.replace(/\/$/, '');
  const home = resolve(options.home ?? (env.HOME || env.USERPROFILE || homedir()));
  const selected = options.stateDir ?? env.MEMORY_HOUSE_HOME ?? join(home, '.memory-house');
  if (typeof selected !== 'string' || !selected.trim() || /[\x00-\x1f\x7f]/.test(selected)) {
    throw new MemoryHouseError('INVALID_CONFIG', 'Memory House state must be a non-empty local directory.');
  }
  const stateDir = resolve(selected === '~' ? home : selected.startsWith('~/') ? join(home, selected.slice(2)) : selected);
  if (stateDir === parse(stateDir).root) throw new MemoryHouseError('INVALID_CONFIG', 'The Memory House state directory cannot be a filesystem root.');
  inspectDirectorySync(stateDir);
  return Object.freeze({
    gatewayBase, mcpUrl: `${gatewayBase}/mcp/`,
    stateDir, authStatePath: join(stateDir, 'auth.json'), lockPath: join(stateDir, 'auth.json.lock'),
    cachePath: join(stateDir, 'msal-cache.json.enc'), cacheLockPath: join(stateDir, 'msal-cache.lock'),
    auth: Object.freeze(auth), ...auth, publisherMissing: Object.freeze(publisherMissing),
    allowInsecureLocalhost,
    timeoutMs: integer(options.timeoutMs ?? env.MEMORY_HOUSE_TIMEOUT_MS, 20_000, 'MEMORY_HOUSE_TIMEOUT_MS', 1, 300_000),
    authTimeoutMs: integer(options.authTimeoutMs ?? env.MEMORY_HOUSE_AUTH_TIMEOUT_MS, 10_000, 'MEMORY_HOUSE_AUTH_TIMEOUT_MS', 1, 30_000),
    lockTimeoutMs: integer(options.lockTimeoutMs ?? env.MEMORY_HOUSE_LOCK_TIMEOUT_MS, 30_000, 'MEMORY_HOUSE_LOCK_TIMEOUT_MS', 1, 300_000),
    tokenSkewSeconds: integer(options.tokenSkewSeconds ?? env.MEMORY_HOUSE_TOKEN_SKEW_SECONDS, 120, 'MEMORY_HOUSE_TOKEN_SKEW_SECONDS', 0, 3600),
    maxResponseBytes: integer(options.maxResponseBytes, 1024 * 1024, 'maxResponseBytes', 1, 8 * 1024 * 1024),
  });
}
