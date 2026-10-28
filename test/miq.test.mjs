import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../src/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { startCanvasServer } from '../src/canvas/index.mjs';
import { createAzureCliTokenSource, createMiqReader, miqScopeId, MIQ_DEFAULTS } from '../src/canvas/miq.mjs';
import { MemoryHouseError } from '../src/errors.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { mockGateway } from './helpers/gateway.mjs';

const TENANT = '33333333-3333-3333-3333-333333333333';
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GROUP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CURATED = '22222222-2222-4222-8222-222222222222';
const LOCKED = '44444444-4444-4444-8444-444444444444';
const BASE = 'https://miq.example';

function jwt(claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ oid: ME, tid: TENANT, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
}

const USERNAME = 'me@contoso.example';
const ACCOUNT = { token: jwt({}), oid: ME, username: USERNAME };
const fixedTokens = (token = jwt({})) => ({ calls: 0, cleared: 0, async get() { this.calls += 1; return { token, oid: ME, username: USERNAME }; }, clear() { this.cleared += 1; } });

const member = (principalId, principalType = 'User') => ({ principalId, principalType });
const SECTIONS = {
  Eng: { description: 'Engineering', children: ['Eng/Platform', 'Eng/Secret', 'Other/Escape'], curators: [member(ME), member(GROUP, 'Group')], users: [] },
  'Eng/Platform': { description: '', children: ['Eng/Platform/Storage'], curators: [], users: [member(OTHER)] },
  'Eng/Platform/Storage': { description: 'Storage team', children: [], curators: [], users: [member(ME)] },
};

// An in-process Microsoft IQ: discovery, section reads and membership reads, plus a request log.
function fakeMiq({ pages = [[{ workspaceId: WORKSPACE, playbookId: CURATED, playbookRoot: 'Eng' }]], failSection = {} } = {}) {
  const requests = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init) => {
    const target = new URL(url);
    requests.push({ path: decodeURIComponent(target.pathname), query: target.search, authorization: init.headers.Authorization, redirect: init.redirect });
    if (target.pathname === '/v1/miq/__private/playbooks') {
      const index = Number(target.searchParams.get('continuationToken') ?? 0);
      const next = index + 1 < pages.length ? { continuationToken: String(index + 1) } : {};
      return json(200, { playbooks: pages[index], ...next });
    }
    const [, rest] = target.pathname.split('/__private/sections/');
    const members = rest.startsWith('members/');
    const path = decodeURIComponent(members ? rest.slice('members/'.length) : rest);
    if (failSection[path]) return json(failSection[path], { errorCode: 'Refused', message: 'secret server text' });
    const section = SECTIONS[path];
    if (!section) return json(403, { errorCode: 'MiqSectionAccessDenied', message: 'denied' });
    if (members) return json(200, { curators: section.curators, users: section.users });
    return json(200, { path, cover: '', description: section.description, childSections: { value: section.children.map(child => ({ path: child })) } });
  };
  return { fetch, requests };
}

test('the Azure CLI token source asks for a Microsoft IQ token for the tenant and caches it until near expiry', async () => {
  let now = 1_000_000;
  const calls = [];
  const tokens = createAzureCliTokenSource({
    env: {}, platform: 'linux', now: () => now, exists: () => false,
    run: async (command, args) => { calls.push([command, ...args]); return `${jwt({ exp: (now + 3_600_000) / 1000, upn: USERNAME })}\n`; },
  });

  const first = await tokens.get(TENANT);
  await tokens.get(TENANT);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['az', 'account', 'get-access-token', '--tenant', TENANT, '--scope', MIQ_DEFAULTS.scope, '--query', 'accessToken', '-o', 'tsv']);
  assert.deepEqual([first.oid, first.username], [ME, USERNAME]);

  const unnamed = createAzureCliTokenSource({ env: {}, platform: 'linux', exists: () => false, run: async () => jwt({ upn: 'me\u0007@contoso.example', unique_name: 7 }) });
  assert.equal((await unnamed.get(TENANT)).username, null, 'a sign-in name with control characters is not kept');

  now += 56 * 60_000;
  await tokens.get(TENANT);
  assert.equal(calls.length, 2, 'refreshes once fewer than five minutes remain');
  tokens.clear();
  await tokens.get(TENANT);
  assert.equal(calls.length, 3);
});

test('the Azure CLI token source falls back to well-known locations and reports a missing CLI', async () => {
  const tried = [];
  const notFound = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const found = createAzureCliTokenSource({
    env: {}, platform: 'darwin', exists: path => path === '/usr/local/bin/az',
    run: async command => { tried.push(command); if (command === 'az') throw notFound; return jwt({}); },
  });
  assert.equal((await found.get(TENANT)).oid, ME);
  assert.deepEqual(tried, ['az', '/usr/local/bin/az']);

  const windows = [];
  const cmdMissing = Object.assign(new Error('not recognized'), { code: 9009 });
  const missing = createAzureCliTokenSource({
    env: { ProgramFiles: 'C:\\Program Files' }, platform: 'win32', exists: () => false,
    run: async command => { windows.push(command); throw cmdMissing; },
  });
  await assert.rejects(missing.get(TENANT), error => error.code === 'MIQ_CLI_MISSING' && error.message.includes(`az login --tenant ${TENANT}`));
  assert.deepEqual(windows, ['az.cmd'], 'absolute candidates that do not exist are not run');
});

test('the Azure CLI token source refuses failed sign-ins, app-only tokens and other tenants without echoing output', async () => {
  const failing = createAzureCliTokenSource({ env: {}, platform: 'linux', exists: () => false, run: async () => { throw Object.assign(new Error('ERROR: AADSTS secret-detail'), { code: 1 }); } });
  await assert.rejects(failing.get(TENANT), error => error.code === 'MIQ_CLI_SIGN_IN' && !error.message.includes('secret-detail'));

  for (const claims of [{ idtyp: 'app' }, { tid: '99999999-9999-4999-8999-999999999999' }, { oid: 'not-a-guid' }]) {
    const token = jwt(claims);
    const tokens = createAzureCliTokenSource({ env: {}, platform: 'linux', exists: () => false, run: async () => token });
    await assert.rejects(tokens.get(TENANT), error => error.code === 'MIQ_CLI_SIGN_IN' && !error.message.includes(token));
  }

  const slow = createAzureCliTokenSource({ env: {}, platform: 'linux', exists: () => false, run: async () => { throw Object.assign(new Error('timeout'), { killed: true }); } });
  await assert.rejects(slow.get(TENANT), { code: 'MIQ_CLI_TIMEOUT' });
});

test('playbook listing follows continuation pages, keeps valid entries and sorts them by name', async () => {
  const miq = fakeMiq({
    pages: [
      [{ workspaceId: WORKSPACE, playbookId: CURATED, playbookRoot: 'Zeta' }, { workspaceId: 'bad', playbookId: CURATED, playbookRoot: 'Broken' }],
      [{ workspaceId: WORKSPACE.toUpperCase(), playbookId: LOCKED, playbookRoot: 'alpha' }],
    ],
  });
  const token = jwt({});
  const reader = createMiqReader({ tenantId: TENANT, fetch: miq.fetch, tokens: fixedTokens(token), baseUrl: BASE });

  const listing = await reader.listPlaybooks({ token, oid: ME });

  assert.deepEqual(listing.playbooks, [
    { workspaceId: WORKSPACE, playbookId: LOCKED, name: 'alpha' },
    { workspaceId: WORKSPACE, playbookId: CURATED, name: 'Zeta' },
  ]);
  assert.deepEqual(miq.requests.map(request => request.query), ['?maxPageSize=200', '?maxPageSize=200&continuationToken=1']);
  assert.ok(miq.requests.every(request => request.authorization === `Bearer ${token}` && request.redirect === 'error'));
});

test('a playbook tree nests readable sections with member counts and the caller\'s direct role', async () => {
  const miq = fakeMiq();
  const reader = createMiqReader({ tenantId: TENANT, fetch: miq.fetch, tokens: fixedTokens(), baseUrl: BASE });

  const tree = await reader.loadPlaybookTree({ workspaceId: WORKSPACE, playbookId: CURATED, name: 'Eng' }, ACCOUNT);

  assert.equal(tree.access, true);
  assert.equal(tree.sections, 3);
  assert.deepEqual(
    { ...tree.root, children: undefined },
    { path: 'Eng', name: 'Eng', scope: `scope:miq:${CURATED}`, description: 'Engineering', curators: 2, users: 0, groups: 1, role: 'curator', children: undefined },
  );
  const [platform, secret] = tree.root.children;
  assert.deepEqual([platform.name, platform.role, platform.users, platform.scope], ['Platform', null, 1, `scope:miq:${CURATED}:Platform`]);
  assert.deepEqual([platform.curatorVia, platform.children[0].curatorVia], ['Eng', 'Eng'], 'sections below a curated one carry the inherited curator role');
  assert.deepEqual(secret, { path: 'Eng/Secret', name: 'Secret', refused: 403, children: [] });
  assert.deepEqual([platform.children[0].name, platform.children[0].role, platform.children[0].description, platform.children[0].scope],
    ['Storage', 'user', 'Storage team', `scope:miq:${CURATED}:Platform/Storage`]);
  assert.ok(!miq.requests.some(request => request.path.includes('Other/Escape')), 'children outside the section are ignored');
  assert.ok(miq.requests.some(request => request.path === `/v1/workspaces/${WORKSPACE}/playbooks/${CURATED}/__private/sections/members/Eng/Platform`));
});

test('a refused root is no access, a failed read is a safe error, and a 401 drops the cached token', async () => {
  const tokens = fixedTokens();
  const refused = createMiqReader({ tenantId: TENANT, fetch: fakeMiq({ failSection: { Eng: 401 } }).fetch, tokens, baseUrl: BASE });
  assert.deepEqual(
    await refused.loadPlaybookTree({ workspaceId: WORKSPACE, playbookId: CURATED, name: 'Eng' }, ACCOUNT),
    { workspaceId: WORKSPACE, playbookId: CURATED, name: 'Eng', access: false, status: 401, sections: 0, truncated: false, root: null },
  );
  assert.ok(tokens.cleared >= 1);

  const failing = createMiqReader({ tenantId: TENANT, fetch: fakeMiq({ failSection: { 'Eng/Platform': 500 } }).fetch, tokens: fixedTokens(), baseUrl: BASE });
  await assert.rejects(
    failing.loadPlaybookTree({ workspaceId: WORKSPACE, playbookId: CURATED, name: 'Eng' }, ACCOUNT),
    error => error.code === 'MIQ_HTTP_ERROR' && error.message === 'Microsoft IQ answered HTTP 500 to the section request.',
  );

  const unreachable = createMiqReader({ tenantId: TENANT, fetch: async () => { throw new TypeError('fetch failed'); }, tokens: fixedTokens(), baseUrl: BASE });
  await assert.rejects(unreachable.listPlaybooks(ACCOUNT), { code: 'MIQ_UNREACHABLE' });
});

test('Microsoft IQ is read only with a verified account, and one read never switches accounts', async () => {
  const miq = fakeMiq();
  // The token cache now names someone else; a read keeps the account it was given.
  const tokens = { calls: 0, async get() { this.calls += 1; return { token: 'someone-else', oid: OTHER, username: 'other@contoso.example' }; }, clear() {} };
  const reader = createMiqReader({ tenantId: TENANT, fetch: miq.fetch, tokens, baseUrl: BASE });

  await assert.rejects(reader.listPlaybooks(), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(reader.loadPlaybookTree({ workspaceId: WORKSPACE, playbookId: CURATED, name: 'Eng' }, { token: 'x', oid: 'not-a-guid' }), { code: 'INVALID_PAYLOAD' });
  const tree = await reader.loadPlaybookTree({ workspaceId: WORKSPACE, playbookId: CURATED, name: 'Eng' }, ACCOUNT);

  assert.equal(tokens.calls, 0, 'reads never ask the token cache');
  assert.ok(miq.requests.length > 0 && miq.requests.every(request => request.authorization === 'Bearer ' + ACCOUNT.token));
  assert.equal(tree.root.role, 'curator', 'roles are matched with the given account');
});

test('the account check asks the Azure CLI again before refusing a cached token', async () => {
  // A token cached for one person, then `az login` as another, who is also the Memory House user now.
  const accounts = [{ token: 'first', oid: ME, username: 'first@contoso.example' }, { token: 'second', oid: OTHER, username: 'second@contoso.example' }];
  let current = 0;
  const tokens = { cleared: 0, async get() { return accounts[current]; }, clear() { this.cleared += 1; current = 1; } };
  const reader = createMiqReader({ tenantId: TENANT, fetch: fakeMiq().fetch, tokens, baseUrl: BASE });

  assert.deepEqual(await reader.verifyAccount(Promise.resolve(`user:${OTHER}`)), accounts[1]);
  assert.equal(tokens.cleared, 1);

  // Still another person after a fresh token: refuse, naming the Azure CLI account, and drop the token.
  await assert.rejects(reader.verifyAccount(Promise.resolve(`user:${ME}`)), error =>
    error.code === 'MIQ_ACCOUNT_MISMATCH' && error.message.startsWith('Azure CLI is signed in as second@contoso.example,'));
  assert.equal(tokens.cleared, 3);

  // An Azure CLI failure is reported before a Memory House one.
  const missing = createMiqReader({ tenantId: TENANT, fetch: fakeMiq().fetch, tokens: { async get() { throw new MemoryHouseError('MIQ_CLI_MISSING', 'Install the Azure CLI.'); }, clear() {} }, baseUrl: BASE });
  await assert.rejects(missing.verifyAccount(Promise.reject(new MemoryHouseError('NOT_SIGNED_IN', 'Sign in.'))), { code: 'MIQ_CLI_MISSING' });
});

test('large playbooks stop at the section limit and say so', async () => {
  const reader = createMiqReader({ tenantId: TENANT, fetch: fakeMiq().fetch, tokens: fixedTokens(), baseUrl: BASE, limits: { maxSections: 2 } });

  const tree = await reader.loadPlaybookTree({ workspaceId: WORKSPACE, playbookId: CURATED, name: 'Eng' }, ACCOUNT);

  assert.equal(tree.truncated, true);
  assert.equal(tree.sections, 2);
  assert.deepEqual(tree.root.children[0].children[0], { path: 'Eng/Platform/Storage', name: 'Storage', skipped: true, children: [] });
});

test('section scope IDs match the ones the AMT topology sync creates', () => {
  // The same vectors as AMT's service/tests/test_miq_topology_sync.py.
  const playbook = 'FA6B2449-DDC8-429B-890A-C87FE0D05BA9';
  assert.equal(miqScopeId(playbook, 'Eng', 'Eng'), 'scope:miq:fa6b2449-ddc8-429b-890a-c87fe0d05ba9');
  assert.equal(miqScopeId(playbook, 'Eng', 'Eng/Platform'), 'scope:miq:fa6b2449-ddc8-429b-890a-c87fe0d05ba9:Platform');
  assert.equal(miqScopeId(playbook, 'Eng', 'Eng/Platform/Storage'), 'scope:miq:fa6b2449-ddc8-429b-890a-c87fe0d05ba9:Platform/Storage');
  assert.throws(() => miqScopeId(playbook, 'Eng', 'Engine/Platform'), { code: 'INVALID_PAYLOAD' });
});

async function signedInClient(t, gateway, { signIn = true, principal = `user:${ME}` } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'memory-house-miq-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const client = createClient({ config: loadConfig({ home, deployment: fixtureDeployment(gateway.base), env: { MH_ALLOW_INSECURE_LOCALHOST: '1' } }) });
  if (signIn) await client.redeem('fixture-enrollment');
  gateway.state.whoami = { ...gateway.state.whoami, principal, tenant_id: TENANT };
  return client;
}

test('canvas server lists the memories in a loaded playbook\'s sections and the caller\'s own learnings', async t => {
  const ROOT_SCOPE = `scope:miq:${CURATED}`;
  const STORAGE_SCOPE = `${ROOT_SCOPE}:Platform/Storage`;
  const PERSONAL = `user:${ME}`;
  const gateway = await mockGateway(t);
  gateway.state.memories = [
    { id: 'root-1', scope_key: ROOT_SCOPE, memory_type: 'fact', content: 'Release on Tuesdays.', created_at: '2026-10-01T00:00:00Z',
      metadata: { promoted_from_scope: `${ROOT_SCOPE}:Platform`, promotion_origin_principal: 'user:colleague', assessment_rationale: 'Applies to every team.' } },
    { id: 'storage-1', scope_key: STORAGE_SCOPE, memory_type: 'procedural', content: 'Rotate storage keys monthly.', created_at: '2026-10-03T00:00:00Z',
      metadata: { promoted_from_scope: PERSONAL, promotion_origin_principal: PERSONAL, assessment_rationale: 'A team practice.' } },
    { id: 'personal-1', scope_key: PERSONAL, memory_type: 'fact', content: 'I prefer short answers.', created_at: '2026-10-02T00:00:00Z' },
    { id: 'other-1', scope_key: 'scope:other-team', memory_type: 'fact', content: 'Another team note.', created_at: '2026-10-04T00:00:00Z' },
  ];
  const client = await signedInClient(t, gateway);
  const miq = fakeMiq();
  const server = await startCanvasServer({ gateway: { client }, roots: { copilot: tmpdir(), claude: tmpdir() }, miq: { tenantId: TENANT, fetch: miq.fetch, tokens: fixedTokens(), baseUrl: BASE } });
  t.after(() => server.close());
  const get = path => fetch(new URL(path, server.url), { headers: { 'x-mh-canvas-token': server.token } });
  const playbook = `workspace_id=${WORKSPACE}&playbook_id=${CURATED}`;

  const early = await get(`/api/miq/memories?${playbook}`);
  assert.deepEqual([early.status, (await early.json()).error], [404, 'playbook_not_loaded']);
  const invalid = await get('/api/miq/memories?workspace_id=x&playbook_id=y');
  assert.deepEqual([invalid.status, (await invalid.json()).error], [400, 'invalid_playbook']);

  assert.equal((await get(`/api/miq/tree?${playbook}`)).status, 200);
  const miqReads = miq.requests.length;
  const response = await get(`/api/miq/memories?${playbook}`);
  assert.equal(response.status, 200);
  const memories = await response.json();
  assert.equal(miq.requests.length, miqReads, 'memories reuse the loaded tree instead of reading Microsoft IQ again');
  assert.deepEqual([memories.total, memories.truncated], [2, false]);
  assert.deepEqual(Object.keys(memories.groups).sort(), [ROOT_SCOPE, STORAGE_SCOPE]);
  const [storage] = memories.groups[STORAGE_SCOPE];
  assert.deepEqual(
    [storage.id, storage.scope_kind, storage.scope_label, storage.scope_path, storage.promotion.from_scope, storage.promotion.rationale],
    ['storage-1', 'node', 'Storage', 'Eng / Platform / Storage', PERSONAL, 'A team practice.'],
  );
  assert.equal(memories.groups[ROOT_SCOPE][0].promotion.from_label, 'Eng / Platform', 'a promotion from a child section names its path');
  const listing = gateway.state.requests.filter(entry => entry.path === '/inference/memory/memories').at(-1);
  assert.deepEqual(listing.query.filter(([key]) => key === 'scopes').map(([, value]) => value).sort(),
    [ROOT_SCOPE, `${ROOT_SCOPE}:Platform`, STORAGE_SCOPE], 'only the readable sections are listed');

  const learnings = await get('/api/learnings');
  assert.equal(learnings.status, 200);
  const personal = await learnings.json();
  assert.deepEqual([personal.principal, personal.total, personal.truncated], [PERSONAL, 1, false]);
  assert.deepEqual(personal.memories.map(memory => [memory.id, memory.scope_kind]), [['personal-1', 'personal']]);
  assert.deepEqual(gateway.state.requests.filter(entry => entry.path === '/inference/memory/memories').at(-1).query,
    [['page_size', '50'], ['scopes', PERSONAL]]);
});

test('learnings need a Memory House sign-in but not Microsoft IQ', async t => {
  const gateway = await mockGateway(t);
  const client = await signedInClient(t, gateway, { signIn: false });
  const server = await startCanvasServer({ gateway: { client }, roots: { copilot: tmpdir(), claude: tmpdir() }, miq: { tenantId: TENANT } });
  t.after(() => server.close());

  const response = await fetch(new URL('/api/learnings', server.url), { headers: { 'x-mh-canvas-token': server.token } });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'not_signed_in');
  assert.equal(gateway.state.requests.length, 0);
});

test('canvas server serves playbooks and trees behind its guards, for listed playbooks only', async t => {
  const gateway = await mockGateway(t);
  const client = await signedInClient(t, gateway);
  const miq = fakeMiq({ pages: [[{ workspaceId: WORKSPACE, playbookId: CURATED, playbookRoot: 'Eng' }, { workspaceId: WORKSPACE, playbookId: LOCKED, playbookRoot: 'Locked' }]], failSection: { Locked: 403 } });
  const server = await startCanvasServer({ gateway: { client }, roots: { copilot: tmpdir(), claude: tmpdir() }, miq: { fetch: miq.fetch, tokens: fixedTokens(), baseUrl: BASE } });
  t.after(() => server.close());
  const get = (path, headers = { 'x-mh-canvas-token': server.token }) => fetch(new URL(path, server.url), { headers });

  assert.equal((await get('/api/miq/playbooks', {})).status, 403);
  assert.equal((await get('/api/miq/playbooks', { 'x-mh-canvas-token': server.token, 'Sec-Fetch-Site': 'cross-site' })).status, 403);

  const listing = await get('/api/miq/playbooks');
  assert.equal(listing.status, 200);
  assert.equal(listing.headers.get('cross-origin-resource-policy'), 'same-origin');
  const body = await listing.json();
  assert.equal(body.tenantId, TENANT, 'the tenant comes from deployment.json');
  assert.deepEqual(body.playbooks.map(playbook => playbook.name), ['Eng', 'Locked']);

  const tree = await get(`/api/miq/tree?workspace_id=${WORKSPACE}&playbook_id=${CURATED.toUpperCase()}`);
  assert.equal(tree.status, 200);
  assert.equal((await tree.json()).root.children[0].children[0].name, 'Storage');
  assert.deepEqual(await (await get(`/api/miq/tree?workspace_id=${WORKSPACE}&playbook_id=${LOCKED}`)).json(),
    { workspaceId: WORKSPACE, playbookId: LOCKED, name: 'Locked', access: false, status: 403, sections: 0, truncated: false, root: null });

  const invalid = await get('/api/miq/tree?workspace_id=../x&playbook_id=1');
  assert.deepEqual([invalid.status, (await invalid.json()).error], [400, 'invalid_playbook']);
  const unlisted = await get(`/api/miq/tree?workspace_id=${WORKSPACE}&playbook_id=99999999-9999-4999-8999-999999999999`);
  assert.deepEqual([unlisted.status, (await unlisted.json()).error], [404, 'playbook_not_listed']);
});

test('canvas server reports a missing Azure CLI with its safe message', async t => {
  const tokens = createAzureCliTokenSource({ env: {}, platform: 'linux', exists: () => false, run: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  const server = await startCanvasServer({ roots: { copilot: tmpdir(), claude: tmpdir() }, miq: { tenantId: TENANT, tokens, fetch: fakeMiq().fetch, baseUrl: BASE } });
  t.after(() => server.close());

  const response = await fetch(new URL('/api/miq/playbooks', server.url), { headers: { 'x-mh-canvas-token': server.token } });

  // This server has no usable Memory House sign-in either; the Azure CLI problem is reported first.
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: 'MIQ_CLI_MISSING',
    message: `Microsoft IQ playbooks use your Azure CLI sign-in. Install the Azure CLI, run \`az login --tenant ${TENANT}\`, then select Refresh.`,
  });
});

test('playbooks are read only when the Azure CLI account is the person signed in to Memory House', async t => {
  const gateway = await mockGateway(t);
  const client = await signedInClient(t, gateway, { principal: `user:${OTHER}` });
  const miq = fakeMiq();
  const tokens = fixedTokens();
  const server = await startCanvasServer({ gateway: { client }, roots: { copilot: tmpdir(), claude: tmpdir() }, miq: { tenantId: TENANT, fetch: miq.fetch, tokens, baseUrl: BASE } });
  t.after(() => server.close());
  const get = path => fetch(new URL(path, server.url), { headers: { 'x-mh-canvas-token': server.token } });
  const routes = ['/api/miq/playbooks', `/api/miq/tree?workspace_id=${WORKSPACE}&playbook_id=${CURATED}`];

  for (const path of routes) {
    const response = await get(path);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: 'MIQ_ACCOUNT_MISMATCH',
      message: `Azure CLI is signed in as ${USERNAME}, but Memory House is signed in as someone else. Run \`az login --tenant ${TENANT}\` with your Memory House account, then select Refresh.`,
    });
  }
  assert.equal(miq.requests.length, 0, 'Microsoft IQ is not read for the wrong person');
  assert.equal(tokens.cleared, 4, 'each refusal retries with a fresh token, then drops it');

  gateway.state.whoami = { ...gateway.state.whoami, principal: `user:${ME.toUpperCase()}` };
  for (const path of routes) assert.equal((await get(path)).status, 200);
  const memories = `/api/miq/memories?workspace_id=${WORKSPACE}&playbook_id=${CURATED}`;
  assert.equal((await get(memories)).status, 200);

  // Signing in to Memory House as someone else ends the use of trees read for the previous person.
  gateway.state.whoami = { ...gateway.state.whoami, principal: `user:${OTHER}` };
  const changed = await get(memories);
  assert.deepEqual([changed.status, (await changed.json()).error], [502, 'MIQ_ACCOUNT_CHANGED']);
  const forgotten = await get(memories);
  assert.deepEqual([forgotten.status, (await forgotten.json()).error], [404, 'playbook_not_loaded']);
  assert.equal((await (await get('/api/miq/playbooks')).json()).error, 'MIQ_ACCOUNT_MISMATCH');
  gateway.state.whoami = { ...gateway.state.whoami, principal: `user:${ME}` };

  await client.logout();
  for (const path of routes) {
    const response = await get(path);
    assert.deepEqual([response.status, (await response.json()).error], [401, 'not_signed_in']);
  }
});

test('the canvas page offers a Playbooks tab with its own view', async t => {
  const server = await startCanvasServer({ roots: { copilot: tmpdir(), claude: tmpdir() }, miq: { tenantId: TENANT } });
  t.after(() => server.close());

  const page = await (await fetch(server.url)).text();

  assert.match(page, /<button id="tabPlaybooks" class="tab" role="tab" type="button" aria-selected="false" aria-controls="playbookView">Playbooks<\/button>/);
  assert.match(page, /<main id="playbookView" class="playbook-view" role="tabpanel" aria-labelledby="tabPlaybooks" hidden>/);
  assert.ok(page.includes("getJson('/api/miq/playbooks')"));
  assert.ok(page.includes("'/api/learnings'") && page.includes("'My Learnings'"), 'My Learnings loads the personal memories');
  assert.ok(page.includes("'/api/miq/memories?'"), 'sections load their memories');
});
