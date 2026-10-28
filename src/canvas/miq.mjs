// Microsoft IQ playbooks for the canvas, read live as the person using it. The Memory House
// gateway cannot call Microsoft IQ for plugin users: its on-behalf-of exchange lacks admin consent,
// and plugins sign in with hook tokens, which carry no Entra user token. So the canvas asks the local
// Azure CLI, a pre-consented Microsoft app, for the user's own Microsoft IQ token and reads only what
// Microsoft IQ lets that user see. The token stays in this process's memory and is never logged.
import { exec, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { sendRequest } from '../client.mjs';
import { MemoryHouseError } from '../errors.mjs';

export const MIQ_DEFAULTS = Object.freeze({
  baseUrl: 'https://wabi-daily-us-east2-redirect.analysis.windows.net',
  scope: 'https://analysis.windows.net/powerbi/api/.default',
  timeoutMs: 30_000,
  maxSections: 500,
  maxPages: 20,
  concurrency: 6,
});

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_ACCESS = new Set([401, 403, 404]);
const TOKEN_REFRESH_MS = 5 * 60_000;
const MIQ_SCOPE_PREFIX = 'scope:miq:';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' && value.length <= max ? value : '');

export const isGuid = value => typeof value === 'string' && GUID.test(value);

/**
 * The AMT scope node that AMT's Microsoft IQ topology sync creates for a section (`miq_scope_id` in
 * AMT's `service/app/integrations/miq/topology.py`); memories promoted into the section carry it as
 * their scope key.
 */
export function miqScopeId(playbookId, rootPath, sectionPath) {
  const scope = `${MIQ_SCOPE_PREFIX}${playbookId.toLowerCase()}`;
  if (sectionPath === rootPath) return scope;
  if (!sectionPath.startsWith(`${rootPath}/`)) throw new MemoryHouseError('INVALID_PAYLOAD', 'The section is outside its playbook.');
  return `${scope}:${sectionPath.slice(rootPath.length + 1)}`;
}

function signInMessage(tenantId) {
  return `Run \`az login --tenant ${tenantId}\` with your Microsoft account to read your Microsoft IQ playbooks, then select Refresh.`;
}

function tokenClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return isObject(claims) ? claims : null;
  } catch {
    return null;
  }
}

// GUI apps can start with a minimal PATH, so well-known install locations follow the PATH lookup.
function azCandidates(env, platform) {
  if (env.MEMORY_HOUSE_AZ_PATH) return [env.MEMORY_HOUSE_AZ_PATH];
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
    return ['az.cmd', ...roots.map(root => `${root}\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd`)];
  }
  return ['az', '/opt/homebrew/bin/az', '/usr/local/bin/az', '/usr/bin/az'];
}

function runAz(command, args, { env, platform, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const options = { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 };
    const done = (error, stdout) => (error ? reject(error) : resolve(String(stdout)));
    if (platform === 'win32') {
      // az is a .cmd script on Windows, which only runs through cmd.exe. Every argument is a
      // constant or a validated tenant GUID, so the composed command line carries no caller text.
      const quoted = command.includes(' ') ? `"${command}"` : command;
      exec([quoted, ...args].join(' '), options, done);
    } else {
      execFile(command, args, options, done);
    }
  });
}

/** The signed-in Azure CLI user's Microsoft IQ token for `tenantId`, cached until shortly before it expires. */
export function createAzureCliTokenSource({
  env = process.env, platform = process.platform, run = runAz, exists = existsSync, now = Date.now,
} = {}) {
  let cached = null;
  let pending = null;

  async function acquire(tenantId) {
    const args = ['account', 'get-access-token', '--tenant', tenantId, '--scope', MIQ_DEFAULTS.scope,
      '--query', 'accessToken', '-o', 'tsv'];
    for (const command of azCandidates(env, platform)) {
      if ((isAbsolute(command) || /[\\/]/.test(command)) && !exists(command)) continue;
      let output;
      try {
        output = await run(command, args, { env, platform, timeoutMs: MIQ_DEFAULTS.timeoutMs });
      } catch (error) {
        // ENOENT: not on PATH. 9009: cmd.exe could not find the command.
        if (error?.code === 'ENOENT' || error?.code === 9009) continue;
        if (error?.killed) throw new MemoryHouseError('MIQ_CLI_TIMEOUT', 'The Azure CLI took too long to return a Microsoft IQ token. Retry, or run `az login` again.');
        throw new MemoryHouseError('MIQ_CLI_SIGN_IN', signInMessage(tenantId));
      }
      const token = output.trim();
      const claims = tokenClaims(token);
      if (!claims || claims.idtyp === 'app' || !isGuid(claims.oid) || String(claims.tid).toLowerCase() !== tenantId.toLowerCase()) {
        throw new MemoryHouseError('MIQ_CLI_SIGN_IN', signInMessage(tenantId));
      }
      const username = [claims.upn, claims.preferred_username, claims.unique_name]
        .find(value => typeof value === 'string' && value && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)) ?? null;
      return { token, oid: claims.oid.toLowerCase(), username, expiresAt: Number(claims.exp) * 1000 || now() };
    }
    throw new MemoryHouseError('MIQ_CLI_MISSING', `Microsoft IQ playbooks use your Azure CLI sign-in. Install the Azure CLI, run \`az login --tenant ${tenantId}\`, then select Refresh.`);
  }

  return Object.freeze({
    async get(tenantId) {
      if (cached && cached.tenantId === tenantId && cached.expiresAt - now() > TOKEN_REFRESH_MS) return cached;
      pending ??= acquire(tenantId)
        .then(value => (cached = { ...value, tenantId }))
        .finally(() => { pending = null; });
      return pending;
    },
    clear() {
      cached = null;
    },
  });
}

function limiter(size) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= size || !queue.length) return;
    active += 1;
    const { work, resolve, reject } = queue.shift();
    work().then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return work => new Promise((resolve, reject) => { queue.push({ work, resolve, reject }); next(); });
}

const leaf = path => path.split('/').pop() || path;

/**
 * A read-only Microsoft IQ reader. `tenantId` is the Entra tenant to sign in to; tests inject
 * `fetch`, `tokens` (an object with get/clear) and `baseUrl`. Reads take the account that
 * `verifyAccount` returned and use its token for every request, so one read never mixes accounts.
 */
export function createMiqReader({ tenantId, fetch: fetchImpl = globalThis.fetch, tokens = createAzureCliTokenSource(), baseUrl = MIQ_DEFAULTS.baseUrl, limits = {} } = {}) {
  if (!isGuid(tenantId)) throw new MemoryHouseError('INVALID_CONFIG', 'Microsoft IQ playbooks need the Memory House Entra tenant ID.');
  const settings = { ...MIQ_DEFAULTS, ...limits };

  function requireAccount(account) {
    if (!isObject(account) || typeof account.token !== 'string' || !account.token || !isGuid(account.oid)) {
      throw new MemoryHouseError('INVALID_PAYLOAD', 'Microsoft IQ is read only with a verified Azure CLI account.');
    }
    return account;
  }

  async function get(path, operation, { token }) {
    try {
      const { data } = await sendRequest({
        url: `${baseUrl}${path}`, fetch: fetchImpl, timeoutMs: settings.timeoutMs, method: 'GET',
        headers: { Authorization: `Bearer ${token}` }, operation,
      });
      return isObject(data) ? data : {};
    } catch (error) {
      // sendRequest describes the Memory House gateway; restate its failures for Microsoft IQ.
      const code = error instanceof MemoryHouseError ? error.code : 'NETWORK_ERROR';
      if (code === 'HTTP_ERROR') {
        if (error.status === 401) tokens.clear();
        throw new MemoryHouseError('MIQ_HTTP_ERROR', `Microsoft IQ answered HTTP ${error.status} to the ${operation} request.`, { status: error.status });
      }
      if (code === 'REQUEST_TIMEOUT') throw new MemoryHouseError('MIQ_TIMEOUT', `Microsoft IQ did not answer the ${operation} request in time. Try again.`);
      if (code === 'NETWORK_ERROR') throw new MemoryHouseError('MIQ_UNREACHABLE', 'Microsoft IQ could not be reached. Check your network connection and try again.');
      throw new MemoryHouseError('MIQ_INVALID_RESPONSE', `Microsoft IQ returned a ${operation} response the canvas could not read.`);
    }
  }

  async function listPlaybooks(account) {
    requireAccount(account);
    const playbooks = [];
    let continuation = null;
    for (let page = 0; page < settings.maxPages; page += 1) {
      const query = new URLSearchParams({ maxPageSize: '200' });
      if (continuation) query.set('continuationToken', continuation);
      const data = await get(`/v1/miq/__private/playbooks?${query}`, 'playbook list', account);
      for (const item of Array.isArray(data.playbooks) ? data.playbooks : []) {
        const name = text(item?.playbookRoot, 1024);
        if (isGuid(item?.workspaceId) && isGuid(item?.playbookId) && name) {
          playbooks.push({ workspaceId: item.workspaceId.toLowerCase(), playbookId: item.playbookId.toLowerCase(), name });
        }
      }
      continuation = text(data.continuationToken, 4096);
      if (!continuation) break;
    }
    playbooks.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.playbookId.localeCompare(b.playbookId));
    return { tenantId, playbooks };
  }

  // Reads the playbook's sections depth-first with their direct members. Microsoft IQ omits children
  // the user cannot read; a child refused anyway (for example, removed mid-read) is shown as refused.
  // Membership reads list direct assignments only, but Microsoft IQ makes a section's curator a curator
  // of every section below it, so a section below one the caller curates names that section in
  // `curatorVia`.
  async function loadPlaybookTree({ workspaceId, playbookId, name }, account) {
    const { oid } = requireAccount(account);
    const run = limiter(settings.concurrency);
    const base = `/v1/workspaces/${workspaceId}/playbooks/${playbookId}/__private/sections`;
    let attempted = 0;
    let sections = 0;
    let truncated = false;

    async function load(path, curatedAbove = null) {
      if (attempted >= settings.maxSections) {
        truncated = true;
        return { path, name: leaf(path), skipped: true, children: [] };
      }
      attempted += 1;
      const encoded = encodeURIComponent(path);
      const [section, members] = await Promise.all([
        run(() => get(`${base}/${encoded}`, 'section', account)),
        run(() => get(`${base}/members/${encoded}`, 'section membership', account)),
      ]);
      sections += 1;
      const assigned = role => (Array.isArray(members[role]) ? members[role] : []).filter(isObject);
      const curators = assigned('curators');
      const users = assigned('users');
      const isMe = member => String(member.principalId).toLowerCase() === oid;
      const role = curators.some(isMe) ? 'curator' : users.some(isMe) ? 'user' : null;
      const childPaths = (Array.isArray(section.childSections?.value) ? section.childSections.value : [])
        .map(child => text(child?.path, 4096))
        .filter(child => child.startsWith(`${path}/`));
      const curatedHere = role === 'curator' ? path : curatedAbove;
      const children = await Promise.all(childPaths.map(child => load(child, curatedHere).catch(error => {
        if (error instanceof MemoryHouseError && NO_ACCESS.has(error.status)) {
          return { path: child, name: leaf(child), refused: error.status, children: [] };
        }
        throw error;
      })));
      return {
        path,
        name: leaf(path),
        scope: miqScopeId(playbookId, name, path),
        description: text(section.description, 4096),
        curators: curators.length,
        users: users.length,
        groups: [...curators, ...users].filter(member => member.principalType !== 'User').length,
        role,
        ...(role !== 'curator' && curatedAbove ? { curatorVia: curatedAbove } : {}),
        children: children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      };
    }

    try {
      const root = await load(name);
      return { workspaceId, playbookId, name, access: true, sections, truncated, root };
    } catch (error) {
      // Child refusals are handled inside load(), so a refusal that reaches here is the root's.
      if (error instanceof MemoryHouseError && NO_ACCESS.has(error.status)) {
        return { workspaceId, playbookId, name, access: false, status: error.status, sections: 0, truncated: false, root: null };
      }
      throw error;
    }
  }

  /**
   * Returns the Azure CLI account, with the token every read must use, only when it is the Memory House
   * principal `principal` resolves to; the playbooks shown then belong to the person whose memories
   * are shown beside them. An Azure CLI failure is reported first, because the page reports a missing
   * Memory House sign-in on its own. A cached token can predate an `az login`, so a mismatch asks the
   * Azure CLI once more before refusing, and a refusal drops the cached token.
   */
  async function verifyAccount(principal) {
    const [cached, who] = await Promise.allSettled([tokens.get(tenantId), principal]);
    if (cached.status === 'rejected') throw cached.reason;
    if (who.status === 'rejected') throw who.reason;
    const expected = typeof who.value === 'string' ? who.value.toLowerCase() : null;
    if (expected === `user:${cached.value.oid}`) return cached.value;
    tokens.clear();
    const account = await tokens.get(tenantId);
    if (expected === `user:${account.oid}`) return account;
    tokens.clear();
    const signedIn = account.username ? `as ${account.username}` : 'with another account';
    throw new MemoryHouseError('MIQ_ACCOUNT_MISMATCH', `Azure CLI is signed in ${signedIn}, but Memory House is signed in as someone else. Run \`az login --tenant ${tenantId}\` with your Memory House account, then select Refresh.`);
  }

  return Object.freeze({ tenantId, listPlaybooks, loadPlaybookTree, verifyAccount });
}
