import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildRuntime } from '../scripts/build.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { isolatedEnvironment, rootSnapshot } from './helpers/runtime.mjs';
import { seedEntraSession } from './helpers/entra.mjs';
import { mockGateway } from './helpers/gateway.mjs';
import { connectCodexAppServer } from './helpers/codex.mjs';
import { PLUGIN_ROOT, MARKETPLACE_FILES, PACKAGE_FILES, verifyPayload } from '../scripts/package-files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const HOSTS = {
  claude: { catalog: '.claude-plugin/marketplace.json', manifest: '.claude-plugin/plugin.json', variable: 'CLAUDE_PLUGIN_ROOT', directory: '.claude' },
  codex: { catalog: '.agents/plugins/marketplace.json', manifest: '.codex-plugin/plugin.json', variable: 'PLUGIN_ROOT', directory: '.codex' },
  copilot: { catalog: '.github/plugin/marketplace.json', manifest: 'plugin.json', variable: 'PLUGIN_ROOT', directory: '.github' },
};
async function discover(root, host) {
  const spec = HOSTS[host];
  const catalog = await json(join(dirname(root), spec.catalog));
  assert.equal(catalog.name, 'memory-house-marketplace');
  assert.equal(catalog.plugins.length, 1);
  const entry = catalog.plugins[0];
  assert.equal(entry.name, 'memory-house');
  assert.equal(entry.version, '0.15.0');
  const source = entry.source.path ?? entry.source;
  assert.equal(source, './plugin');
  const pluginRoot = resolve(dirname(root), source);
  assert.equal(pluginRoot, resolve(root));
  const manifest = await json(join(pluginRoot, spec.manifest));
  assert.equal(manifest.name, 'memory-house');
  assert.equal(manifest.version, '0.15.0');
  if (host === 'codex' || host === 'copilot') {
    assert.equal(manifest.$schema, undefined, 'A portable root would shadow Codex native hook discovery.');
    // Copilot loads the app canvas from immediate subdirectories of this legacy extensions path.
    assert.equal(manifest.extensions, host === 'copilot' ? './com.github.copilot/extensions/' : undefined);
    assert.equal(manifest.skills, './skills/');
  }
  assert.equal(manifest.hooks, `./${spec.directory}/plugin-hooks.json`);
  // Every app reads the same remote MCP server definition; no app starts a local server.
  assert.equal(manifest.mcpServers, './mcp.json');
  const hooks = await json(join(pluginRoot, manifest.hooks));
  const mcp = await json(join(pluginRoot, manifest.mcpServers));
  const { gatewayBase, mcpUrl, entra } = await json(join(pluginRoot, 'deployment.json'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['memory-house']);
  const server = mcp.mcpServers['memory-house'];
  assert.deepEqual(Object.keys(server).sort(), ['auth', 'headersHelper', 'http_headers_helper',
    'oauthClientId', 'oauthGrantType', 'oauthPublicClient', 'oauthScopes', 'type', 'url']);
  assert.equal(server.type, 'http');
  assert.equal(server.url, mcpUrl ?? `${gatewayBase}/mcp/`);
  assert.equal(server.oauthClientId, entra.clientId);
  assert.equal(server.oauthPublicClient, true);
  assert.deepEqual(server.oauthScopes, [entra.mcpScope]);
  assert.equal(server.oauthGrantType, 'authorization_code');
  assert.deepEqual(server.auth, { redirectPort: 33418 });
  // Claude and Codex send cached Entra tokens through these launchers; Copilot signs in itself.
  assert.match(server.headersHelper, /process\.env\.CLAUDE_PLUGIN_ROOT,'runtime\/auth\.mjs'.* -- headers$/);
  assert.ok(server.http_headers_helper.includes(`['${manifest.version}','local']`));
  assert.ok(server.http_headers_helper.includes("'memory-house-marketplace','memory-house',v,'runtime','auth.mjs'"));
  const events = host === 'copilot'
    ? ['sessionStart', 'userPromptSubmitted', 'userPromptTransformed', 'postToolUse', 'agentStop', 'sessionEnd']
    : ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
  assert.deepEqual(Object.keys(hooks.hooks), events);
  for (const entries of Object.values(hooks.hooks)) {
    assert.equal(entries.length, 1);
    const handlers = entries[0].hooks ?? entries;
    assert.equal(handlers.length, 1);
    const handler = handlers[0];
    assert.equal(handler.type, 'command');
    assert.match(JSON.stringify(handler), new RegExp(`${spec.directory.replace('.', '\\.')}/entry\\.mjs`));
    assert.ok((handler.timeout ?? handler.timeoutSec) <= 30);
  }
  return { ...spec, catalog, manifest, hooks, mcp, root: pluginRoot };
}

async function execute(command, args, { env, cwd, input = '', windowsVerbatimArguments = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated hook process timed out.')); }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}

async function hook(host, event, payload, env, root, shell = process.platform === 'win32' ? 'cmd' : 'sh') {
  const native = await discover(root, host);
  const entry = native.hooks.hooks[event][0];
  const command = entry.hooks?.[0] ?? entry;
  const options = { env: { ...env, [native.variable]: root }, cwd: env.HOME, input: JSON.stringify(payload) };
  let response;
  if (command.args) {
    response = await execute(command.exec ?? command.command,
      command.args.map(value => value.replaceAll(`\${${native.variable}}`, root)), options);
  } else {
    // Like Codex (raw_arg) and Node's `shell` option, hand cmd.exe the whole command verbatim inside one
    // pair of quotes; default argument quoting would turn its inner quotes into \", which cmd.exe keeps.
    const args = shell === 'pwsh' ? ['-NoProfile', '-NonInteractive', '-Command', command.command]
      : shell === 'cmd' ? ['/d', '/v:off', '/s', '/c', `"${command.command}"`] : ['-c', command.command];
    response = await execute(shell === 'sh' ? '/bin/sh' : shell === 'cmd' ? (env.ComSpec ?? 'cmd.exe') : 'pwsh', args,
      { ...options, windowsVerbatimArguments: shell === 'cmd' });
  }
  assert.equal(response.code, 0, response.stderr);
  const parsed = JSON.parse(response.stdout);
  assert.equal(response.stdout.trim().split('\n').length, 1);
  return { ...response, parsed };
}

const queued = name => /^\d{16}-[a-f\d]{8}\.json$/.test(name);

async function queueNames(env) {
  try { return await readdir(join(env.MEMORY_HOUSE_HOME, 'capture-queue')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/** Hooks return before capture is sent; wait for the detached sender to finish. */
async function settled(env, check = () => true, { drained = true, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  for (;;) {
    const names = await queueNames(env);
    // Two quiet polls in a row, so a sender that was still starting has finished too.
    streak = await check() && !names.includes('flush.lock') && (!drained || !names.some(queued)) ? streak + 1 : 0;
    if (streak >= 2) return names;
    if (Date.now() > deadline) throw new Error(`Captured turns did not settle: ${names.join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, streak ? 250 : 50));
  }
}

async function signIn(host, env, root, { recordAccount = true } = {}) {
  await seedEntraSession(env, await json(join(root, 'deployment.json')), 'fixture-access-1', { recordSignIn: true, recordAccount });
  const result = await run(process.execPath, [join(root, 'runtime/auth.mjs'), 'status'], { env, cwd: env.HOME, timeout: 15_000 });
  assert.equal(JSON.parse(result.stdout).signedIn, true);
  assert.doesNotMatch(result.stdout, /fixture-access/);
  return result;
}

async function authStatus(env, root) {
  const { stdout } = await run(process.execPath, [join(root, 'runtime/auth.mjs'), 'status'], { env, cwd: env.HOME, timeout: 15_000 });
  return JSON.parse(stdout);
}

test('every root catalog selects the same curated payload and precisely its native components', async t => {
  const root = await rootSnapshot(t);
  for (const host of Object.keys(HOSTS)) await discover(root, host);
  for (const path of ['node_modules', 'src', 'dist', 'plugin', 'test', 'docs', 'scripts', '.git', '.maintainer',
    'package.json', 'package-lock.json', 'GETTING_STARTED_MH_COPILOT_PLUGIN.md', '.mcp.json', 'hooks',
    '.github/hooks', '.claude/settings.json', '.codex/hooks.json', ...MARKETPLACE_FILES]) {
    await assert.rejects(access(join(root, path)), { code: 'ENOENT' });
  }
  assert.equal((await json(join(ROOT, 'package.json'))).dependencies, undefined);
  assert.equal((await json(join(ROOT, 'package.json'))).devDependencies, undefined);
  assert.equal((await json(join(ROOT, 'package.json'))).workspaces, undefined);
});

test('publisher checks accept separate MCP endpoints and reject mismatched native transport URLs', async t => {
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t);
  const repository = dirname(root);
  for (const path of ['scripts/check-publisher.mjs', 'scripts/package-files.mjs', 'src/config.mjs', 'src/state.mjs', 'src/errors.mjs']) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await cp(join(ROOT, path), join(repository, path));
  }
  const check = () => run(process.execPath, [join(repository, 'scripts/check-publisher.mjs')],
    { env, cwd: repository, timeout: 15_000 });
  await check();
  const deployment = await json(join(root, 'deployment.json'));
  deployment.mcpUrl = 'https://mcp.example/mcp/memoryhouse';
  await writeFile(join(root, 'deployment.json'), JSON.stringify(deployment));
  await assert.rejects(check(), error => /mcp\.json must point.*mcpUrl/.test(error.stderr));
  const mcp = await json(join(root, 'mcp.json'));
  mcp.mcpServers['memory-house'].url = deployment.mcpUrl;
  await writeFile(join(root, 'mcp.json'), JSON.stringify(mcp));
  await check();
  for (const host of Object.keys(HOSTS)) await discover(root, host);
  const server = mcp.mcpServers['memory-house'];
  for (const override of [{ oauthClientId: 'wrong-client' }, { oauthScopes: [deployment.entra.scope] },
    { oauthPublicClient: false }, { oauthGrantType: 'client_credentials' }, { auth: { redirectPort: 0 } }]) {
    await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { 'memory-house': { ...server, ...override } } }));
    await assert.rejects(check(), error => /publisher public client, MCP scope/.test(error.stderr));
  }
});

test('the published payload contains exactly runtime content and no empty or linked entries', async () => {
  const manifest = await json(join(PLUGIN_ROOT, 'runtime/manifest.json'));
  const actual = await verifyPayload([...Object.keys(manifest.outputs), 'manifest.json']);
  assert.equal(actual.length, PACKAGE_FILES.length + Object.keys(manifest.outputs).length + 1);
  assert.equal(await readFile(join(PLUGIN_ROOT, 'LICENSE'), 'utf8'), await readFile(join(ROOT, 'LICENSE'), 'utf8'));
});

test('payload checks reject extra maintainer files and empty directories', async t => {
  const extra = await rootSnapshot(t);
  const manifest = await json(join(extra, 'runtime/manifest.json'));
  const runtimeFiles = [...Object.keys(manifest.outputs), 'manifest.json'];
  await writeFile(join(extra, 'package.json'), '{"private":true}');
  await assert.rejects(verifyPayload(runtimeFiles, extra), /Unexpected: package\.json/);
  const empty = await rootSnapshot(t);
  await mkdir(join(empty, 'empty'));
  await assert.rejects(verifyPayload(runtimeFiles, empty), /Empty plugin payload directory: empty/);
});

test('packaged mh commands match their directories, the remote MCP tools and the sign-in helper', async t => {
  const root = await rootSnapshot(t);
  assert.deepEqual((await readdir(join(root, 'skills'))).sort(), ['mh-login', 'mh-logout', 'mh-memory', 'mh-show', 'mh-status', 'mh-telemetry', 'use-memory']);
  for (const [name, tool] of [['mh-login', 'runtime/auth.mjs'], ['mh-logout', 'runtime/auth.mjs'], ['mh-status', 'runtime/auth.mjs'], ['mh-telemetry', 'runtime/auth.mjs'], ['mh-memory', 'search_memories'], ['mh-show', 'get_memories'], ['use-memory', 'search_memories']]) {
    const source = await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(source, new RegExp(`^name: ${name}$`, 'm'));
    assert.ok(source.includes(`\`${tool}\``));
    assert.doesNotMatch(source, /^disable-model-invocation:/m);
    if (['mh-login', 'mh-logout'].includes(name)) assert.match(source, /only for an explicit user request/);
  }
  const loginSkill = await readFile(join(root, 'skills/mh-login/SKILL.md'), 'utf8');
  assert.match(loginSkill, /Never display, read or copy access tokens/);
  assert.match(loginSkill, /runtime\/auth\.mjs" login/);
  for (const name of ['mh-logout', 'mh-status']) {
    const source = await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(source, new RegExp(`runtime/auth\\.mjs" ${name === 'mh-logout' ? 'logout' : 'status'}`));
  }
  const memorySkill = await readFile(join(root, 'skills/mh-memory/SKILL.md'), 'utf8');
  assert.match(memorySkill, /`add_memory`/);
  assert.match(memorySkill, /`get_memories`/);
  assert.match(memorySkill, /Do not work around it by reading/);
  assert.match(memorySkill, /call it once with `page_size` 50/);
  assert.match(memorySkill, /Fetch further pages only when the user explicitly asks/);
  assert.match(memorySkill, /`delete_all_memories`\)\. Use them only when the user explicitly asks/);
  const showSkill = await readFile(join(root, 'skills/mh-show/SKILL.md'), 'utf8');
  const telemetrySkill = await readFile(join(root, 'skills/mh-telemetry/SKILL.md'), 'utf8');
  assert.match(telemetrySkill, /no\s+opt-in approval is required/);
  assert.match(telemetrySkill, /Never run enable just because the user signs in/);
  assert.match(telemetrySkill, /runtime\/auth\.mjs" telemetry-enable/);
  assert.doesNotMatch(telemetrySkill, /--accept-notice=/);
  assert.match(telemetrySkill, /unconfirmed server opt-out as pending/);
  assert.match(showSkill, /`open_canvas` with `canvasId` set to `memory-house`/);
  assert.match(showSkill, /`instanceId` set to\s+`memory-house-main`/);
  assert.match(showSkill, /do not invoke it unless\s+the user asks/);
  assert.match(showSkill, /Do not work around a missing canvas/);
  const extension = await readFile(join(root, 'com.github.copilot/extensions/memory-canvas/extension.mjs'), 'utf8');
  assert.match(extension, /from '@github\/copilot-sdk\/extension'/);
  assert.match(extension, /from '\.\.\/\.\.\/\.\.\/runtime\/canvas\.mjs'/);
  assert.match(extension, /id: 'memory-house'/);
  assert.doesNotMatch(extension, /console\.\w+\(/);
  await access(join(root, 'runtime/canvas.mjs'));
});

test('included runtime is reproducible, license-complete and in the Git-publishable tree', async t => {
  await buildRuntime({ check: true });
  const env = await isolatedEnvironment(t);
  const other = await buildRuntime({ outputRoot: join(env.HOME, 'rebuilt-runtime') });
  const manifest = await json(join(PLUGIN_ROOT, 'runtime/manifest.json'));
  for (const [name, digest] of Object.entries(manifest.outputs)) {
    assert.equal(hash(await readFile(join(PLUGIN_ROOT, 'runtime', name))), digest);
    assert.equal(other.files[name], digest);
  }
  const notices = await readFile(join(PLUGIN_ROOT, 'runtime/THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const dependency of manifest.dependencies) assert.ok(notices.includes(`${dependency.name}@${dependency.version}`));
  assert.ok(manifest.dependencies.some(value => value.name === '@azure/msal-node'));
  assert.equal(manifest.dependencies.some(value => value.name.startsWith('@modelcontextprotocol/')), false);
  assert.equal(Object.keys(manifest.sources).some(path => path.startsWith('/')), false);
  const ignored = spawnSync('git', ['check-ignore', 'plugin/runtime/hook.mjs', 'plugin/runtime/manifest.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ignored.status, 1);
  assert.equal(ignored.stdout, '');
});

test('each host verifies cached Entra authentication without sending enrollment requests', async t => {
  const gateway = await mockGateway(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  for (const host of Object.keys(HOSTS)) {
    const env = await isolatedEnvironment(t);
    assert.equal((await authStatus(env, root)).signedIn, false);
    await signIn(host, env, root);
    assert.equal((await authStatus(env, root)).signedIn, true);
  }
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/hook/redeem')).length, 0);
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/mcp/')).length, 0);
});

test('the Claude and Codex header launchers find the plugin and send the cached MCP-audience Entra token', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  const server = (await json(join(root, 'mcp.json'))).mcpServers['memory-house'];
  // Codex runs its helper from the user's directory, so the launcher reads Codex's documented install cache.
  await cp(root, join(env.CODEX_HOME, 'plugins/cache/memory-house-marketplace/memory-house/0.15.0'), { recursive: true });
  // Header helpers reach cmd.exe the same verbatim, quoted way as hook commands (see hook()).
  const launch = async (command, extraEnv) => {
    const [shell, args] = process.platform === 'win32'
      ? [env.ComSpec ?? 'cmd.exe', ['/d', '/v:off', '/s', '/c', `"${command}"`]] : ['/bin/sh', ['-c', command]];
    const response = await execute(shell, args, { env: { ...env, ...extraEnv }, cwd: env.HOME, windowsVerbatimArguments: true });
    assert.equal(response.code, 0, response.stderr);
    return JSON.parse(response.stdout);
  };
  const claude = () => launch(server.headersHelper, { CLAUDE_PLUGIN_ROOT: root });
  // Codex normally passes only HOME and PATH; the fixture also needs loopback allowance.
  const codexEnv = {
    HOME: env.HOME, PATH: env.PATH, USERPROFILE: env.USERPROFILE, MH_ALLOW_INSECURE_LOCALHOST: '1',
    ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
  };
  const codex = async () => {
    const [shell, args] = process.platform === 'win32'
      ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/v:off', '/s', '/c', `"${server.http_headers_helper}"`]] : ['/bin/sh', ['-c', server.http_headers_helper]];
    const response = await execute(shell, args, { env: codexEnv, cwd: env.HOME, windowsVerbatimArguments: true });
    assert.equal(response.code, 0, response.stderr);
    return JSON.parse(response.stdout);
  };
  assert.deepEqual(await claude(), {});
  assert.deepEqual(await codex(), {});
  await signIn('copilot', env, root);
  assert.deepEqual(await claude(), { Authorization: 'Bearer fixture-mcp-access-1' });
  assert.deepEqual(await codex(), { Authorization: 'Bearer fixture-mcp-access-1' });
});

test('one sign-in serves recall and capture in every host', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('copilot', env, root);
  const startup = gateway.state.memories;
  for (const host of Object.keys(HOSTS)) {
    const session = `${host}-one`;
    const prompt = 'Use concise TypeScript examples.';
    const startEvent = host === 'copilot' ? 'sessionStart' : 'SessionStart';
    const sessionPayload = { session_id: session };
    gateway.state.memories = startup;
    const start = await hook(host, startEvent, sessionPayload, env, root);
    assert.deepEqual(start.parsed, {});
    // Recall waits for the first prompt and includes both memories.
    gateway.state.memories = [...startup, { id: `${host}-watch`, memory_type: 'procedural', created_at: '2026-10-03T08:00:00Z', content: 'Run tests with --watch.' }];
    const promptEvent = host === 'copilot' ? 'userPromptSubmitted' : 'UserPromptSubmit';
    const submitted = await hook(host, promptEvent, { ...sessionPayload, prompt, turn_id: 'turn-1' }, env, root);
    let recalled;
    if (['claude', 'codex'].includes(host)) recalled = submitted.parsed.hookSpecificOutput.additionalContext;
    else assert.deepEqual(submitted.parsed, {});
    if (host === 'copilot') {
      const transformed = await hook(host, 'userPromptTransformed', { ...sessionPayload, prompt, transformedPrompt: `Runtime\n${prompt}` }, env, root);
      assert.match(transformed.parsed.modifiedTransformedPrompt, /^Runtime\n/);
      recalled = transformed.parsed.modifiedTransformedPrompt;
      assert.deepEqual((await hook(host, 'postToolUse', sessionPayload, env, root)).parsed, {});
    }
    assert.match(recalled, /- \[procedural, 2026-10-03\] Run tests with --watch\./);
    assert.match(recalled, /prefers concise TypeScript/);
    const stopEvent = host === 'copilot' ? 'agentStop' : 'Stop';
    const finalText = { last_assistant_message: 'I will use concise examples.' };
    assert.deepEqual((await hook(host, stopEvent, { ...sessionPayload, turn_id: 'turn-1', ...finalText }, env, root)).parsed, {});
    assert.deepEqual((await hook(host, promptEvent, {
      ...sessionPayload, prompt: 'Now investigate deployment.', turn_id: 'turn-2',
    }, env, root)).parsed, {});
    if (host === 'copilot') {
      assert.deepEqual((await hook(host, 'userPromptTransformed', {
        ...sessionPayload, prompt: 'Now investigate deployment.', transformedPrompt: 'Now investigate deployment.',
        turn_id: 'turn-2',
      }, env, root)).parsed, {});
      assert.deepEqual((await hook(host, 'postToolUse', sessionPayload, env, root)).parsed, {});
    }
  }
  await settled(env, () => gateway.state.turns.length >= 9);
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/redeem')).length, 0);
  const searches = gateway.state.requests.filter(request => request.path.endsWith('/search'));
  assert.equal(searches.length, 3);
  assert.ok(searches.every(request => request.body.top_k === 10));
  assert.equal(gateway.state.turns.filter(turn => turn.role === 'agent').length, 3);
  assert.equal(new Set(gateway.state.turns.map(turn => turn.thread_id)).size, 3);
});

test('bundled minimum recall length keeps each host armed and supports disabling the gate', async t => {
  const gateway = await mockGateway(t, { telemetry: true });
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('copilot', env, root);
  const searches = () => gateway.state.requests.filter(request => request.path.endsWith('/search'));
  for (const host of Object.keys(HOSTS)) {
    const before = searches().length;
    const promptEvent = host === 'copilot' ? 'userPromptSubmitted' : 'UserPromptSubmit';
    const payload = { session_id: `minimum-${host}`, prompt: 'x'.repeat(19) };
    const short = await hook(host, promptEvent, payload, env, root);
    assert.deepEqual(short.parsed, {});
    assert.match(short.stderr, /recall:skipped:short-prompt/);
    if (host === 'copilot') {
      for (let i = 0; i < 2; i++) {
        assert.deepEqual((await hook(host, 'userPromptTransformed',
          { ...payload, transformedPrompt: payload.prompt }, env, root)).parsed, {});
      }
      assert.deepEqual((await hook(host, 'postToolUse', payload, env, root)).parsed, {});
    }
    assert.equal(searches().length, before);
    const next = { ...payload, prompt: 'x'.repeat(20) };
    let response = await hook(host, promptEvent, next, env, root);
    if (host === 'copilot') response = await hook(host, 'userPromptTransformed',
      { ...next, transformedPrompt: next.prompt }, env, root);
    assert.match(JSON.stringify(response.parsed), /concise TypeScript examples/);
    assert.equal(searches().length, before + 1);
    assert.equal(searches().at(-1).body.query, 'x'.repeat(20));
    await settled(env, () => gateway.state.telemetryEvents.length === (before + 1) * 2);
  }
  const payload = { session_id: 'minimum-disabled', prompt: 'continue' };
  const disabled = { ...env, MEMORY_HOUSE_MIN_RECALL_CHARS: '0' };
  await hook('copilot', 'userPromptSubmitted', payload, disabled, root);
  const response = await hook('copilot', 'userPromptTransformed',
    { ...payload, transformedPrompt: payload.prompt }, disabled, root);
  assert.match(response.parsed.modifiedTransformedPrompt, /concise TypeScript examples/);
  assert.equal(searches().at(-1).body.query, 'continue');
  await settled(env, () => gateway.state.telemetryEvents.length === 8);
});

test('bundled default-on recall and detached metadata delivery preserve durable opt-out', async t => {
  const gateway = await mockGateway(t, { telemetry: true });
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('copilot', env, root);
  const command = async (...args) => JSON.parse((await run(process.execPath, [join(root, 'runtime/auth.mjs'), ...args],
    { env, cwd: env.HOME, timeout: 15_000 })).stdout);
  assert.equal((await command('telemetry-status')).enrolled, true);
  const notice = await command('telemetry-notice');
  assert.equal(notice.notice_version, '2026-11-06.3');
  assert.match(notice.notice, /60 days/);
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/telemetry/enrollment') && request.method === 'POST').length, 0);
  gateway.state.telemetryDelayMs = 6000;
  const payload = { session_id: 'telemetry-native', prompt: 'A private first prompt.', turn_id: 'turn-1' };
  await hook('copilot', 'userPromptSubmitted', payload, env, root);
  const started = Date.now();
  const first = await hook('copilot', 'userPromptTransformed', { ...payload, transformedPrompt: payload.prompt }, env, root);
  assert.ok(Date.now() - started < gateway.state.telemetryDelayMs, 'Recall must not await the metadata endpoint.');
  assert.match(first.parsed.modifiedTransformedPrompt, /concise TypeScript examples/);
  const second = await hook('copilot', 'userPromptTransformed', { ...payload, transformedPrompt: payload.prompt }, env, root);
  assert.deepEqual(second.parsed, first.parsed);
  await settled(env, () => gateway.state.telemetryEvents.length === 2);
  const events = gateway.state.telemetryEvents;
  const delivery = events.find(event => event.path.endsWith('/delivery')).body;
  assert.deepEqual(delivery.items, [{ rank: 1, supplied: 'full' }]);
  assert.equal(delivery.budget_bytes, 8192);
  assert.equal(delivery.epoch, 1);
  assert.doesNotMatch(JSON.stringify(events), /private first prompt|concise TypeScript|fixture-memory/);
  const search = gateway.state.requests.find(request => request.path.endsWith('/search'));
  assert.equal(search.headers['x-memory-house-client'], 'amt-copilot-plugin/0.15.0; trigger=auto_recall_first_prompt');
  assert.equal(search.headers['x-memory-house-request'], `${delivery.client_request_id}; attempt=1`);
  assert.equal((await command('telemetry-disable')).enrolled, false);
  assert.equal((await command('telemetry-status')).queued_events, 0);
  assert.equal(gateway.state.telemetryEvents.length, 2, 'Opt-out preserves previously recorded metadata.');
  const after = { ...payload, session_id: 'telemetry-after-opt-out' };
  await hook('copilot', 'userPromptSubmitted', after, env, root);
  await hook('copilot', 'userPromptTransformed', { ...after, transformedPrompt: after.prompt }, env, root);
  await settled(env, () => gateway.state.turns.length === 2);
  assert.equal(gateway.state.telemetryEvents.length, 2, 'Opt-out prevents recording new metadata.');
});

test('all three native hooks capture ordinary user and agent turns without explicit memory tool calls', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('claude', env, root);
  const expected = [];
  for (const host of Object.keys(HOSTS)) {
    const session = { session_id: `${host}-automatic` };
    const promptEvent = host === 'copilot' ? 'userPromptSubmitted' : 'UserPromptSubmit';
    const stopEvent = host === 'copilot' ? 'agentStop' : 'Stop';
    for (let turn = 1; turn <= 3; turn++) {
      const prompt = `Ordinary conversation ${turn} for ${host}.`;
      const answer = `Acknowledged ordinary conversation ${turn}.`;
      await hook(host, promptEvent, { ...session, turn_id: `turn-${turn}`, prompt }, env, root);
      await hook(host, stopEvent, {
        ...session, turn_id: `turn-${turn}`, last_assistant_message: answer,
      }, env, root);
      expected.push({ role: 'user', content: prompt }, { role: 'agent', content: answer });
    }
  }
  await settled(env, () => gateway.state.turns.length >= expected.length);
  assert.deepEqual(gateway.state.turns.map(({ role, content }) => ({ role, content })), expected);
  assert.equal(gateway.state.turns.length, 18);
  assert.ok(gateway.state.turns.every(turn => !turn.thread_id.startsWith('mh:manual:')));
});

test('hooks return before a slow capture request completes, and the turns still arrive in order', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('copilot', env, root);
  gateway.state.captureDelayMs = 6000;
  const session = { session_id: 'slow-gateway' };
  for (const [event, payload] of [['userPromptSubmitted', { ...session, prompt: 'A prompt for a slow gateway.' }],
    ['agentStop', { ...session, last_assistant_message: 'An answer for a slow gateway.' }]]) {
    const started = Date.now();
    await hook('copilot', event, payload, env, root);
    // The host gets its output, and the hook's stdio closes, while the detached sender still waits.
    assert.ok(Date.now() - started < gateway.state.captureDelayMs, `${event} waited for the capture request`);
  }
  await settled(env, () => gateway.state.turns.length >= 2, { timeoutMs: 45_000 });
  assert.deepEqual(gateway.state.turns.map(turn => turn.role), ['user', 'agent']);
});

test('a gateway outage leaves turns queued and encrypted until a later hook sends them in order', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('claude', env, root);
  gateway.state.captureStatus = 503;
  const session = { session_id: 'outage' };
  const prompt = 'OUTAGE_PROMPT_MARKER: prefer concise examples.';
  const submitted = await hook('claude', 'UserPromptSubmit', { ...session, prompt }, env, root);
  // Recall does not wait on, or depend on, the capture request.
  assert.match(submitted.parsed.hookSpecificOutput.additionalContext, /TypeScript/);
  const captures = () => gateway.state.requests.filter(request => request.path.endsWith('/memory'));
  await settled(env, () => captures().length >= 1, { drained: false });
  // After a failed send, a frequent event queues its turn without starting another sender.
  await hook('claude', 'Stop', { ...session, last_assistant_message: 'OUTAGE_ANSWER_MARKER' }, env, root);
  const names = (await settled(env, () => true, { drained: false })).filter(queued);
  assert.equal(names.length, 2);
  assert.equal(captures().length, 1);
  for (const name of names) {
    assert.doesNotMatch(await readFile(join(env.MEMORY_HOUSE_HOME, 'capture-queue', name), 'utf8'), /OUTAGE_|outage/);
  }
  gateway.state.captureStatus = 201;
  const ended = await hook('claude', 'SessionEnd', { ...session, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, env, root);
  assert.deepEqual(ended.parsed, {});
  await settled(env, () => gateway.state.turns.length >= 2);
  assert.deepEqual(gateway.state.turns.map(({ role, content }) => [role, content]),
    [['user', prompt], ['agent', 'OUTAGE_ANSWER_MARKER']]);
  // The failed request is resent with its idempotency key before the newer turn.
  const sent = captures();
  assert.equal(sent.length, 3);
  assert.match(sent[0].headers['idempotency-key'], /^mh-capture-[a-f\d]{64}$/);
  assert.equal(sent[1].headers['idempotency-key'], sent[0].headers['idempotency-key']);
  assert.ok(sent.every(request => request.body.thread_id === 'mh:claude:outage'));
});

test('a memory reset during a send keeps the backlog, which is resent whole with its key afterwards', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('codex', env, root);
  const session = { session_id: 'reset' };
  gateway.state.captureProblem = { status: 409, code: 'reset_in_progress', retry_after: 5 };
  await hook('codex', 'UserPromptSubmit', { ...session, prompt: 'A request during a reset.' }, env, root);
  const captures = () => gateway.state.requests.filter(request => request.path.endsWith('/memory'));
  await settled(env, () => captures().length >= 1, { drained: false });
  await hook('codex', 'Stop', { ...session, last_assistant_message: 'An answer during a reset.' }, env, root);
  assert.equal((await settled(env, () => true, { drained: false })).filter(queued).length, 2);
  gateway.state.captureProblem = null;
  await hook('codex', 'SessionEnd', { ...session, hook_event_name: 'SessionEnd' }, env, root);
  await settled(env, () => gateway.state.turns.length >= 2);
  assert.deepEqual(gateway.state.turns.map(turn => turn.content), ['A request during a reset.', 'An answer during a reset.']);
  const sent = captures();
  assert.equal(sent.length, 3);
  assert.equal(sent[1].headers['idempotency-key'], sent[0].headers['idempotency-key']);
  assert.deepEqual(sent[1].body.items, sent[0].body.items);
});

test('a long prompt reaches Memory House whole, as ordered parts before the reply', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('claude', env, root);
  const session = { session_id: 'long-prompt' };
  const prompt = `${Array.from({ length: 1700 }, (_, index) => `Log line ${index}: ${'detail '.repeat(4)}`).join('\n')}\nWhat failed?`;
  const submitted = await hook('claude', 'UserPromptSubmit', { ...session, prompt }, env, root);
  assert.match(submitted.parsed.hookSpecificOutput.additionalContext, /TypeScript/);
  await hook('claude', 'Stop', { ...session, last_assistant_message: 'The build failed at line 1200.' }, env, root);
  await settled(env, () => gateway.state.turns.length >= 4);
  assert.deepEqual(gateway.state.turns.map(turn => turn.role), ['user', 'user', 'user', 'agent']);
  const parts = gateway.state.turns.slice(0, 3).map(turn => turn.content);
  parts.forEach((part, index) => assert.ok(part.startsWith(`[Part ${index + 1} of 3 of one long message]\n`)));
  assert.equal(parts.map(part => part.slice(part.indexOf('\n') + 1)).join(''), prompt);
  const search = gateway.state.requests.find(request => request.path.endsWith('/search') && request.body.query.includes('Log line'));
  assert.ok(search.body.query.endsWith('What failed?'));
});

test('turns queued before signing in again with the same account are still sent; another account never gets them', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('copilot', env, root);
  const statePath = join(env.MEMORY_HOUSE_HOME, 'auth.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const session = { session_id: 'sign-in-again' };
  const queue = async prompt => {
    const before = gateway.state.requests.filter(request => request.path.endsWith('/memory')).length;
    gateway.state.captureStatus = 503;
    await hook('copilot', 'userPromptSubmitted', { ...session, prompt }, env, root);
    await settled(env, () => gateway.state.requests.filter(request => request.path.endsWith('/memory')).length > before, { drained: false });
    gateway.state.captureStatus = 201;
  };
  await queue('Queued before signing in again.');
  // What mh-login records when the same account signs in again: a new sign-in with the same account and capture epoch.
  await writeFile(statePath, JSON.stringify({ ...state, generation: randomUUID() }));
  await hook('copilot', 'sessionStart', session, env, root);
  await settled(env, () => gateway.state.turns.length >= 1);
  assert.deepEqual(gateway.state.turns.map(turn => turn.content), ['Queued before signing in again.']);
  await queue('Queued before another account signed in.');
  await writeFile(statePath, JSON.stringify({ ...state, generation: randomUUID(), objectId: 'another-user', captureEpoch: randomUUID() }));
  await hook('copilot', 'sessionStart', session, env, root);
  await settled(env);
  assert.equal(gateway.state.turns.length, 1);
});

test('a sign-in made before 0.15.0 gets its account recorded; only turns queued afterwards are sent', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('claude', env, root, { recordAccount: false });
  const statePath = join(env.MEMORY_HOUSE_HOME, 'auth.json');
  const before = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(before.objectId, undefined);
  const session = { session_id: 'older-sign-in' };
  await hook('claude', 'UserPromptSubmit', { ...session, prompt: 'Queued before the account was known.' }, env, root);
  await settled(env);
  // The bundled sender recorded the cached account (from the protected MSAL cache), with a new generation.
  const after = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(after.objectId, 'fixture-user');
  assert.match(after.captureEpoch, /^[a-f\d-]{36}$/);
  assert.notEqual(after.generation, before.generation);
  assert.equal(after.tenantId, before.tenantId);
  assert.equal(gateway.state.turns.length, 0);
  await hook('claude', 'Stop', { ...session, last_assistant_message: 'Sent once the account is known.' }, env, root);
  await settled(env, () => gateway.state.turns.length >= 1);
  assert.deepEqual(gateway.state.turns.map(turn => turn.content), ['Sent once the account is known.']);
});

test('a conversation that cannot be stored never holds up another, and a turn that keeps failing is dropped after an hour', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('claude', env, root);
  const captures = () => gateway.state.requests.filter(request => request.path.endsWith('/memory'));
  const requestsWith = text => captures().filter(request => request.body?.items?.some(item => item.content.includes(text)));
  const sessionEnd = () => hook('claude', 'SessionEnd', { session_id: 'healthy', hook_event_name: 'SessionEnd' }, env, root);
  // Three conversations queue turns while the gateway is unavailable.
  gateway.state.captureStatus = 503;
  for (const [session, prompt] of [['stale', 'STALE-MARKER request'], ['poison', 'POISON-MARKER request'], ['healthy', 'A healthy request']]) {
    await hook('claude', 'UserPromptSubmit', { session_id: session, prompt }, env, root);
    await settled(env, () => true, { drained: false });
  }
  gateway.state.captureStatus = 201;
  gateway.state.conflictContent = 'STALE-MARKER';
  gateway.state.failContent = 'POISON-MARKER';
  // In one run: a conflict before the request finished, a request that finished as failed (its record has
  // no error code, as when every write failed), and a healthy one.
  await sessionEnd();
  await settled(env, () => gateway.state.turns.length >= 1 && requestsWith('POISON-MARKER').length >= 1, { drained: false });
  assert.deepEqual(gateway.state.turns.map(turn => turn.content), ['A healthy request']);
  // The failed turn is retried alone under a new key, and kept while it has been failing for under an hour.
  const poisonKeys = () => requestsWith('POISON-MARKER').map(request => request.headers['idempotency-key']);
  await sessionEnd();
  await settled(env, () => new Set(poisonKeys()).size >= 2, { drained: false });
  assert.equal(new Set(poisonKeys()).size, 2);
  const failing = [];
  for (const name of (await queueNames(env)).filter(queued)) {
    const file = join(env.MEMORY_HOUSE_HOME, 'capture-queue', name);
    const header = JSON.parse(await readFile(file, 'utf8'));
    if (header.failedRequests) failing.push({ file, header });
  }
  assert.deepEqual(failing.map(({ header }) => header.failedRequests), [2]);
  // An hour after its first failure, failing under a third key drops it. The conflicted conversation keeps its
  // batch and key, and is stored once the conflict ends.
  const [{ file, header }] = failing;
  await writeFile(file, JSON.stringify({ ...header, firstFailedAt: header.firstFailedAt - 60 * 60 * 1000 }));
  gateway.state.conflictContent = null;
  await sessionEnd();
  await settled(env, () => gateway.state.turns.length >= 2 && new Set(poisonKeys()).size >= 3);
  assert.deepEqual(gateway.state.turns.map(turn => turn.content), ['A healthy request', 'STALE-MARKER request']);
  assert.equal(new Set(requestsWith('STALE-MARKER').map(request => request.headers['idempotency-key'])).size, 1);
  assert.equal(new Set(poisonKeys()).size, 3);
  assert.equal((await queueNames(env)).filter(queued).length, 0);
});

test('a request that stores only some of a conversation\'s turns has only the others sent again', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('claude', env, root);
  const session = { session_id: 'partial' };
  const captures = () => gateway.state.requests.filter(request => request.path.endsWith('/memory'));
  const sessionEnd = () => hook('claude', 'SessionEnd', { ...session, hook_event_name: 'SessionEnd' }, env, root);
  // While the gateway is unavailable, the conversation's turns pile up and are later sent together.
  gateway.state.captureStatus = 503;
  await hook('claude', 'UserPromptSubmit', { ...session, prompt: 'First prompt' }, env, root);
  await settled(env, () => captures().length >= 1, { drained: false });
  await hook('claude', 'Stop', { ...session, last_assistant_message: 'POISON-MARKER answer' }, env, root);
  await hook('claude', 'UserPromptSubmit', { ...session, prompt: 'Second prompt' }, env, root);
  assert.equal((await settled(env, () => true, { drained: false })).filter(queued).length, 3);
  gateway.state.captureStatus = 201;
  gateway.state.failContent = 'POISON-MARKER';
  await sessionEnd();
  await settled(env, () => gateway.state.turns.length >= 2, { drained: false });
  // The gateway answered 207: the turn after the failed one was stored, so only the failed one stays queued.
  assert.deepEqual(gateway.state.turns.map(turn => turn.content), ['First prompt', 'Second prompt']);
  assert.deepEqual(captures().at(-1).body.items.map(item => item.content), ['POISON-MARKER answer', 'Second prompt']);
  assert.equal((await queueNames(env)).filter(queued).length, 1);
  gateway.state.failContent = null;
  await sessionEnd();
  await settled(env, () => gateway.state.turns.length >= 3);
  assert.deepEqual(gateway.state.turns.map(turn => turn.content), ['First prompt', 'Second prompt', 'POISON-MARKER answer']);
  const [batch, retry] = captures().slice(-2);
  assert.deepEqual(retry.body.items.map(item => item.content), ['POISON-MARKER answer']);
  assert.notEqual(retry.headers['idempotency-key'], batch.headers['idempotency-key']);
});

test('after one conversation fails, a prompt in another is captured at once by its own hook', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('claude', env, root);
  const requestsWith = text => gateway.state.requests.filter(request => request.path.endsWith('/memory')
    && request.body?.items?.some(item => item.content.includes(text)));
  gateway.state.failContent = 'POISON-MARKER';
  await hook('claude', 'UserPromptSubmit', { session_id: 'poisoned', prompt: 'POISON-MARKER request' }, env, root);
  await settled(env, () => requestsWith('POISON-MARKER').length >= 1, { drained: false });
  // An ordinary prompt in another conversation, not a session boundary, starts a sender right away.
  await hook('claude', 'UserPromptSubmit', { session_id: 'healthy', prompt: 'A healthy request' }, env, root);
  await settled(env, () => gateway.state.turns.length >= 1, { drained: false });
  assert.deepEqual(gateway.state.turns.map(turn => turn.content), ['A healthy request']);
  // The failed conversation waits out its own delay rather than being retried early.
  assert.equal(requestsWith('POISON-MARKER').length, 1);
});

test('each entry fails open for absent/wrong plugin roots, malformed input and wrong host events', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  for (const [host, spec] of Object.entries(HOSTS)) {
    const path = join(root, spec.directory, 'entry.mjs');
    for (const [event, input, extraEnv] of [
      ['session-start', '{"session_id":"one"}', {}],
      ['session-start', '{"session_id":"one"}', { [spec.variable]: env.HOME }],
      ['session-start', 'not-json SECRET', { [spec.variable]: root }],
      ['subagent-stop', '{"session_id":"one"}', { [spec.variable]: root }],
    ]) {
      const response = await execute(process.execPath, [path, event], { env: { ...env, ...extraEnv }, cwd: env.HOME, input });
      assert.equal(response.code, 0, `${host}: ${response.stderr}`);
      assert.deepEqual(JSON.parse(response.stdout), {});
      assert.match(response.stderr, /hook skipped/);
      assert.doesNotMatch(response.stderr, /SECRET/);
    }
  }
  assert.equal(gateway.state.requests.length, 0);
});

test('native argv and shell paths are literal on POSIX and PowerShell, including special characters', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const weird = process.platform === 'win32' ? "quoted' %PATH% !bang! $name (test)" : "spaces 'quotes' \"double\" $HOME $(echo injected) `tick` ! % caf\u00e9";
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base), name: weird });
  const actual = await realpath(root);
  await signIn('codex', env, actual);
  const powershell = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { env, stdio: 'ignore' }).status === 0;
  for (const host of Object.keys(HOSTS)) {
    const event = host === 'copilot' ? 'userPromptTransformed' : 'UserPromptSubmit';
    const payload = { session_id: 'quoted', prompt: 'Use concise TypeScript.', transformedPrompt: 'Use concise TypeScript.' };
    assert.match(JSON.stringify((await hook(host, event, payload, env, actual)).parsed), /The developer prefers concise TypeScript/);
    if (powershell && host === 'codex') {
      assert.match(JSON.stringify((await hook(host, event, { ...payload, session_id: 'quoted-pwsh' }, env, actual, 'pwsh')).parsed), /The developer prefers concise TypeScript/);
    }
  }
  await settled(env, () => gateway.state.turns.length >= (powershell ? 3 : 2));
});

test('publisher defaults and sign-in cannot be overridden through environment variables', async t => {
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment() });
  const overrides = { ...env, MEMORY_HOUSE_GATEWAY: 'http://127.0.0.1:9', MEMORY_HOUSE_ENTRA_CLIENT_ID: 'wrong', AMT_ACCESS_TOKEN: 'fake-secret' };
  const { stdout } = await run(process.execPath, [join(root, 'runtime/auth.mjs'), 'status'], { env: overrides, cwd: env.HOME, timeout: 15_000 });
  assert.equal(JSON.parse(stdout).signedIn, false);
  assert.doesNotMatch(stdout, /https?:|fake-secret/);
  const { gatewayBase } = await json(join(root, 'deployment.json'));
  assert.notEqual(gatewayBase, 'http://127.0.0.1:9');
});

test('rebuilds refuse locally edited or unrecognized generated files', async t => {
  await assert.rejects(buildRuntime({ outputRoot: PLUGIN_ROOT }), /dedicated runtime output directory/);
  const env = await isolatedEnvironment(t);
  const path = join(env.HOME, 'owned-runtime');
  await buildRuntime({ outputRoot: path });
  await writeFile(join(path, 'hook.mjs'), 'user edit');
  await assert.rejects(buildRuntime({ outputRoot: path }), /local edits/);
  assert.equal(await readFile(join(path, 'hook.mjs'), 'utf8'), 'user edit');
  const unknown = join(env.HOME, 'unknown-runtime');
  await mkdir(unknown);
  await writeFile(join(unknown, 'my-file.txt'), 'keep');
  await assert.rejects(buildRuntime({ outputRoot: unknown }), /unrecognized/);
  assert.equal(await readFile(join(unknown, 'my-file.txt'), 'utf8'), 'keep');
});

test('available Claude CLI validates, installs and connects the remote MCP server with a cached Entra token in an isolated profile', async t => {
  const env = {
    ...await isolatedEnvironment(t), DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', GIT_CONFIG_NOSYSTEM: '1',
  };
  const available = spawnSync('claude', ['plugin', 'validate', '--help'], {
    env, cwd: env.HOME, stdio: 'ignore', timeout: 20_000,
  });
  if (available.error?.code === 'ENOENT') { t.skip('Claude CLI is not installed on this test host.'); return; }
  assert.equal(available.status, 0, 'Claude plugin validator must be available without sign-in.');
  const gateway = await mockGateway(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  for (const file of [join(root, '.claude-plugin/plugin.json'), join(dirname(root), '.claude-plugin/marketplace.json')]) {
    const validated = await run('claude', ['plugin', 'validate', file, '--strict'], { env, cwd: env.HOME, timeout: 30_000 });
    assert.match(validated.stdout, /Validation passed/);
  }
  await run('claude', ['plugin', 'marketplace', 'add', dirname(root)], { env, cwd: env.HOME, timeout: 30_000 });
  await run('claude', ['plugin', 'install', 'memory-house@memory-house-marketplace', '--scope', 'user'], {
    env, cwd: env.HOME, timeout: 30_000,
  });
  const record = await json(join(env.CLAUDE_CONFIG_DIR, 'plugins/installed_plugins.json'));
  const installed = record.plugins['memory-house@memory-house-marketplace'];
  assert.equal(installed.length, 1);
  const installedRoot = installed[0].installPath;
  assert.ok(installedRoot.startsWith(env.CLAUDE_CONFIG_DIR));
  for (const file of ['mcp.json', 'runtime/hook.mjs', 'runtime/flush.mjs', 'runtime/auth.mjs', '.claude/entry.mjs', 'deployment.json']) {
    await access(join(installedRoot, file));
  }
  await assert.rejects(access(join(installedRoot, 'runtime/server.mjs')), { code: 'ENOENT' });
  await assert.rejects(access(join(installedRoot, 'node_modules')), { code: 'ENOENT' });
  await assert.rejects(access(join(installedRoot, 'package-lock.json')), { code: 'ENOENT' });
  assert.equal((await authStatus(env, installedRoot)).signedIn, false);
  // After sign-in, Claude's header helper connects the remote MCP server with the cached Entra token.
  await signIn('claude', env, root);
  const listed = await run('claude', ['mcp', 'list'], { env, cwd: env.HOME, timeout: 60_000 });
  assert.match(listed.stdout, /plugin:memory-house:memory-house: .*\(HTTP\) - ✔ Connected/);
  assert.ok(gateway.state.requests.some(request => request.path === '/inference/memory/mcp/' && request.authorization === 'Bearer fixture-mcp-access-1'));
});

test('available Copilot CLI registers the native catalog and installs exactly one root plugin in isolation', async t => {
  const env = { ...await isolatedEnvironment(t), COPILOT_AUTO_UPDATE: 'false', CI: 'true', GIT_CONFIG_NOSYSTEM: '1' };
  const available = spawnSync('copilot', ['plugin', '--help'], { env, cwd: env.HOME, stdio: 'ignore', timeout: 20_000 });
  if (available.error?.code === 'ENOENT') { t.skip('Copilot CLI is not installed on this test host.'); return; }
  assert.equal(available.status, 0);
  const root = await rootSnapshot(t);
  await run('copilot', ['plugin', 'marketplace', 'add', dirname(root)], { env, cwd: env.HOME, timeout: 30_000 });
  await run('copilot', ['plugin', 'install', 'memory-house@memory-house-marketplace'], { env, cwd: env.HOME, timeout: 30_000 });
  const listed = await run('copilot', ['plugin', 'list'], { env, cwd: env.HOME, timeout: 30_000 });
  assert.match(listed.stdout, /memory-house/);
  assert.match(listed.stdout, /0\.15\.0/);
  assert.match(listed.stdout, /memory-house-marketplace/);
  assert.equal((listed.stdout.match(/0\.15\.0/g) ?? []).length, 1, listed.stdout);
  const skills = await run('copilot', ['skill', 'list'], { env, cwd: env.HOME, timeout: 30_000 });
  for (const name of ['mh-login', 'mh-logout', 'mh-status', 'mh-memory', 'mh-show', 'mh-telemetry', 'use-memory']) assert.match(skills.stdout, new RegExp(`\\b${name}\\b`));
  // Copilot ignores the Claude and Codex launcher fields and signs in to the remote server itself.
  const mcp = await run('copilot', ['mcp', 'get', 'memory-house'], { env, cwd: env.HOME, timeout: 30_000 });
  assert.match(mcp.stdout, /Type: http/);
  const deployment = await json(join(root, 'deployment.json'));
  assert.ok(mcp.stdout.includes(`URL: ${deployment.mcpUrl ?? `${deployment.gatewayBase}/mcp/`}`));
  assert.match(mcp.stdout, /Source: Plugin/);
});

test('available Codex registers the remote MCP server, seven named skills and four native hooks beside the legacy Copilot root', async t => {
  const env = { ...await isolatedEnvironment(t), GIT_CONFIG_NOSYSTEM: '1' };
  await mkdir(env.CODEX_HOME, { recursive: true });
  const available = spawnSync('codex', ['plugin', '--help'], { env, cwd: env.HOME, stdio: 'ignore', timeout: 20_000 });
  if (available.error?.code === 'ENOENT') { t.skip('Codex CLI is not installed on this test host.'); return; }
  assert.equal(available.status, 0);
  const gateway = await mockGateway(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await run('codex', ['plugin', 'marketplace', 'add', dirname(root), '--json'], { env, cwd: env.HOME, timeout: 30_000 });
  const installed = await run('codex', ['plugin', 'add', 'memory-house@memory-house-marketplace', '--json'], {
    env, cwd: env.HOME, timeout: 30_000,
  });
  const installedRoot = JSON.parse(installed.stdout).installedPath;
  const server = await connectCodexAppServer(t, { env, cwd: env.HOME });
  const { data: entries } = await server.request('hooks/list', { cwds: [env.HOME] });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].warnings, []);
  const hooks = entries[0].hooks.filter(value => value.pluginId === 'memory-house@memory-house-marketplace');
  assert.deepEqual(hooks.map(value => value.eventName).sort(), ['sessionEnd', 'sessionStart', 'stop', 'userPromptSubmit']);
  const hookPath = await realpath(join(installedRoot, '.codex/plugin-hooks.json'));
  for (const value of hooks) {
    assert.equal(value.source, 'plugin');
    assert.equal(value.enabled, true);
    assert.equal(value.trustStatus, 'untrusted');
    assert.equal(await realpath(value.sourcePath), hookPath);
  }
  await assert.rejects(access(join(env.CODEX_HOME, 'hooks.json')), { code: 'ENOENT' });
  const { data: servers } = await server.request('mcpServerStatus/list', { limit: 100 });
  const memory = servers.find(value => value.pluginId === 'memory-house@memory-house-marketplace');
  assert.ok(memory, 'The native Codex loader must register the plugin MCP server.');
  assert.equal(memory.name, 'memory-house');
  // Codex gives its header helper only HOME and PATH, so the helper refuses this plain-HTTP fixture
  // gateway; the launcher test covers the token with exactly that environment.
  assert.ok(gateway.state.requests.some(request => request.path === '/inference/memory/mcp/' && request.body?.method === 'initialize'));
  const skills = await server.request('skills/list', { cwds: [env.HOME], forceReload: true });
  const ownSkills = skills.data.flatMap(entry => entry.skills.filter(skill => skill.pluginId === 'memory-house@memory-house-marketplace'));
  assert.deepEqual(ownSkills.map(skill => skill.name).sort(), [
    'memory-house:mh-login', 'memory-house:mh-logout', 'memory-house:mh-memory', 'memory-house:mh-show', 'memory-house:mh-status',
    'memory-house:mh-telemetry', 'memory-house:use-memory',
  ]);
  assert.ok(ownSkills.every(skill => skill.enabled));
});
