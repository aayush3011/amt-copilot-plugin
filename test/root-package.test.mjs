import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { buildRuntime } from '../scripts/build.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { connectMcp, isolatedEnvironment, rootSnapshot } from './helpers/runtime.mjs';
import { mockGateway } from './helpers/gateway.mjs';
import { connectCodexAppServer } from './helpers/codex.mjs';
import { PLUGIN_ROOT, MARKETPLACE_FILES, PACKAGE_FILES, verifyPayload } from '../scripts/package-files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const data = result => JSON.parse(result.content[0].text);
const hash = value => createHash('sha256').update(value).digest('hex');
const schemaRoot = new URL('./fixtures/schemas/', import.meta.url);
const ajv = new Ajv({ strict: true });
const mcpSchema = ajv.compile(JSON.parse(await readFile(new URL('agent-mcp.schema.json', schemaRoot), 'utf8')));
const HOSTS = {
  claude: { catalog: '.claude-plugin/marketplace.json', manifest: '.claude-plugin/plugin.json', variable: 'CLAUDE_PLUGIN_ROOT', directory: '.claude' },
  codex: { catalog: '.agents/plugins/marketplace.json', manifest: '.codex-plugin/plugin.json', variable: 'PLUGIN_ROOT', directory: '.codex' },
  cursor: { catalog: '.cursor-plugin/marketplace.json', manifest: '.cursor-plugin/plugin.json', variable: 'CURSOR_PLUGIN_ROOT', directory: '.cursor' },
  copilot: { catalog: '.github/plugin/marketplace.json', manifest: 'plugin.json', variable: 'PLUGIN_ROOT', directory: '.github' },
};

async function discover(root, host) {
  const spec = HOSTS[host];
  const catalog = await json(join(dirname(root), spec.catalog));
  assert.equal(catalog.name, 'memory-house-marketplace');
  assert.equal(catalog.plugins.length, 1);
  const entry = catalog.plugins[0];
  assert.equal(entry.name, 'memory-house');
  assert.equal(entry.version, '0.13.0');
  const source = entry.source.path ?? entry.source;
  assert.equal(source, './plugin');
  const pluginRoot = resolve(dirname(root), source);
  assert.equal(pluginRoot, resolve(root));
  const manifest = await json(join(pluginRoot, spec.manifest));
  assert.equal(manifest.name, 'memory-house');
  assert.equal(manifest.version, '0.13.0');
  let hookPath;
  let mcpPath;
  if (host === 'codex' || host === 'copilot') {
    assert.equal(manifest.$schema, undefined, 'A portable root would shadow Codex native hook discovery.');
    assert.equal(manifest.extensions, undefined);
    assert.equal(manifest.skills, './skills/');
    hookPath = manifest.hooks;
    mcpPath = manifest.mcpServers;
    assert.equal(hookPath, `./${spec.directory}/plugin-hooks.json`);
    assert.equal(mcpPath, host === 'codex' ? './.codex/mcp.json' : './mcp.json');
  } else {
    hookPath = manifest.hooks;
    mcpPath = manifest.mcpServers;
    assert.equal(hookPath, `./${spec.directory}/plugin-hooks.json`);
    assert.equal(mcpPath, `./${spec.directory}/mcp.json`);
  }
  const hooks = await json(join(pluginRoot, hookPath));
  const mcp = await json(join(pluginRoot, mcpPath));
  if (host === 'codex' || host === 'copilot') assert.equal(mcpSchema(mcp), true, JSON.stringify(mcpSchema.errors));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['memory-house']);
  const server = mcp.mcpServers['memory-house'];
  assert.equal(server.command, 'node');
  if (host === 'codex') {
    assert.deepEqual(server.args, ['runtime/server.mjs']);
    assert.equal(server.cwd, './');
  } else {
    assert.deepEqual(server.args, [`\${${spec.variable}}/runtime/server.mjs`]);
  }
  const events = host === 'cursor'
    ? ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'afterAgentResponse', 'sessionEnd']
    : host === 'copilot'
      ? ['sessionStart', 'userPromptSubmitted', 'userPromptTransformed', 'postToolUse', 'agentStop', 'sessionEnd']
      : ['SessionStart', 'UserPromptSubmit', 'Stop'];
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
  return { ...spec, catalog, manifest, hooks, server, root: pluginRoot };
}

async function execute(command, args, { env, cwd, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    const args = shell === 'pwsh' ? ['-NoProfile', '-NonInteractive', '-Command', command.command]
      : shell === 'cmd' ? ['/d', '/v:off', '/s', '/c', command.command] : ['-c', command.command];
    response = await execute(shell === 'sh' ? '/bin/sh' : shell === 'cmd' ? (env.ComSpec ?? 'cmd.exe') : 'pwsh', args, options);
  }
  assert.equal(response.code, 0, response.stderr);
  const parsed = JSON.parse(response.stdout);
  assert.equal(response.stdout.trim().split('\n').length, 1);
  return { ...response, parsed };
}

test('every root catalog selects the same curated payload and precisely its native components', async t => {
  const root = await rootSnapshot(t);
  for (const host of Object.keys(HOSTS)) await discover(root, host);
  for (const path of ['node_modules', 'src', 'dist', 'plugin', 'test', 'docs', 'scripts', '.git', '.maintainer',
    'package.json', 'package-lock.json', 'GETTING_STARTED_MH_COPILOT_PLUGIN.md', '.mcp.json', 'hooks',
    '.github/hooks', '.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', ...MARKETPLACE_FILES]) {
    await assert.rejects(access(join(root, path)), { code: 'ENOENT' });
  }
  assert.equal((await json(join(ROOT, 'package.json'))).dependencies, undefined);
  assert.equal((await json(join(ROOT, 'package.json'))).devDependencies, undefined);
  assert.equal((await json(join(ROOT, 'package.json'))).workspaces, undefined);
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

test('packaged mh commands match their directories and real MCP tools', async t => {
  const root = await rootSnapshot(t);
  assert.deepEqual((await readdir(join(root, 'skills'))).sort(), ['mh-login', 'mh-logout', 'mh-memory', 'mh-status']);
  for (const [name, tool] of [['mh-login', 'memory_login'], ['mh-logout', 'memory_logout'], ['mh-status', 'memory_status'], ['mh-memory', 'search_memories']]) {
    const source = await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(source, new RegExp(`^name: ${name}$`, 'm'));
    assert.ok(source.includes(`\`${tool}\``));
    assert.doesNotMatch(source, /^disable-model-invocation:/m);
    if (['mh-login', 'mh-logout'].includes(name)) assert.match(source, /only for an explicit user request/);
  }
  const memorySkill = await readFile(join(root, 'skills/mh-memory/SKILL.md'), 'utf8');
  assert.match(memorySkill, /`add_memory`/);
  assert.match(memorySkill, /`get_memories`/);
  assert.match(memorySkill, /Do not work around it by reading/);
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
  assert.ok(manifest.dependencies.some(value => value.name === '@modelcontextprotocol/sdk'));
  assert.ok(manifest.dependencies.some(value => value.name === '@azure/msal-node'));
  assert.equal(Object.keys(manifest.sources).some(path => path.startsWith('/')), false);
  const ignored = spawnSync('git', ['check-ignore', 'plugin/runtime/server.mjs', 'plugin/runtime/manifest.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ignored.status, 1);
  assert.equal(ignored.stdout, '');
});

test('a fresh root copy performs bundled Microsoft enrollment then search/add/recall in each host', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  const auth = await connectMcp(t, {
    args: ['--import', fileURLToPath(new URL('./helpers/direct-login-bootstrap.mjs', import.meta.url)), join(root, 'runtime/server.mjs')],
    env, cwd: env.HOME,
  });
  const login = await auth.call('memory_login');
  assert.equal(login.isError, undefined, JSON.stringify(login));
  assert.equal(data(login).signedIn, true);
  assert.equal(auth.stderr(), '');
  await auth.client.close();
  for (const host of Object.keys(HOSTS)) {
    const spec = await discover(root, host);
    const server = await connectMcp(t, {
      command: spec.server.command, args: spec.server.args.map(value => value.replaceAll(`\${${spec.variable}}`, root)),
      env: { ...env, [spec.variable]: root },
      cwd: spec.server.cwd ? resolve(root, spec.server.cwd.replaceAll(`\${${spec.variable}}`, root)) : env.HOME,
    });
    const { tools } = await server.client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['add_memory', 'get_memories', 'memory_login', 'memory_logout', 'memory_status', 'search_memories']);
    assert.equal(data(await server.call('memory_status')).signedIn, true);
    const added = await server.call('add_memory', { content: `Remember concise ${host} examples.` });
    assert.equal(added.isError, undefined);
    assert.equal(data(added).processing, 'asynchronous');
    assert.equal(data(await server.call('search_memories', { query: 'TypeScript' })).count, 1);
    const listing = data(await server.call('get_memories'));
    assert.equal(listing.count, 1);
    assert.equal(listing.truncated, false);
    const session = `${host}-one`;
    const prompt = 'Use concise TypeScript examples.';
    const startEvent = ['copilot', 'cursor'].includes(host) ? 'sessionStart' : 'SessionStart';
    const sessionPayload = host === 'cursor' ? { conversation_id: session } : { session_id: session };
    const start = await hook(host, startEvent, sessionPayload, env, root);
    assert.match(JSON.stringify(start.parsed), /TypeScript/);
    const promptEvent = host === 'cursor' ? 'beforeSubmitPrompt' : host === 'copilot' ? 'userPromptSubmitted' : 'UserPromptSubmit';
    const submitted = await hook(host, promptEvent, { ...sessionPayload, prompt, turn_id: 'turn-1' }, env, root);
    if (['claude', 'codex'].includes(host)) assert.match(submitted.parsed.hookSpecificOutput.additionalContext, /TypeScript/);
    else if (host === 'cursor') assert.deepEqual(submitted.parsed, { continue: true });
    else assert.deepEqual(submitted.parsed, {});
    if (host === 'copilot') {
      const transformed = await hook(host, 'userPromptTransformed', { ...sessionPayload, prompt, transformedPrompt: `Runtime\n${prompt}` }, env, root);
      assert.match(transformed.parsed.modifiedTransformedPrompt, /^Runtime\n/);
      assert.deepEqual((await hook(host, 'postToolUse', sessionPayload, env, root)).parsed, {});
    } else if (host === 'cursor') {
      assert.match((await hook(host, 'postToolUse', { ...sessionPayload, turn_id: 'turn-1' }, env, root)).parsed.additional_context, /TypeScript/);
      assert.deepEqual((await hook(host, 'postToolUse', { ...sessionPayload, turn_id: 'turn-1' }, env, root)).parsed, {});
    }
    const stopEvent = host === 'cursor' ? 'afterAgentResponse' : host === 'copilot' ? 'agentStop' : 'Stop';
    const finalText = host === 'cursor' ? { text: 'I will use concise examples.' } : { last_assistant_message: 'I will use concise examples.' };
    assert.deepEqual((await hook(host, stopEvent, { ...sessionPayload, turn_id: 'turn-1', ...finalText }, env, root)).parsed, {});
    assert.equal(server.stderr(), '');
    await server.client.close();
  }
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/redeem')).length, 1);
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/mcp/')).length, 3);
  assert.equal(gateway.state.turns.filter(turn => turn.thread_id.startsWith('mh:manual:')).length, 4);
  assert.equal(gateway.state.turns.filter(turn => turn.role === 'agent').length, 4);
  assert.equal(new Set(gateway.state.turns.filter(turn => !turn.thread_id.startsWith('mh:manual:')).map(turn => turn.thread_id)).size, 4);
});

test('all four native hooks capture ordinary user and agent turns without explicit memory tool calls', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  const probe = fileURLToPath(new URL('./helpers/native-auth-probe.mjs', import.meta.url));
  await run(process.execPath, [probe, join(root, 'runtime/auth.mjs')], { env, cwd: env.HOME, timeout: 15_000 });
  const expected = [];
  for (const host of Object.keys(HOSTS)) {
    const session = host === 'cursor' ? { conversation_id: `${host}-automatic` } : { session_id: `${host}-automatic` };
    const promptEvent = host === 'cursor' ? 'beforeSubmitPrompt' : host === 'copilot' ? 'userPromptSubmitted' : 'UserPromptSubmit';
    const stopEvent = host === 'cursor' ? 'afterAgentResponse' : host === 'copilot' ? 'agentStop' : 'Stop';
    for (let turn = 1; turn <= 3; turn++) {
      const prompt = `Ordinary conversation ${turn} for ${host}.`;
      const answer = `Acknowledged ordinary conversation ${turn}.`;
      await hook(host, promptEvent, { ...session, turn_id: `turn-${turn}`, prompt }, env, root);
      await hook(host, stopEvent, {
        ...session, turn_id: `turn-${turn}`,
        ...(host === 'cursor' ? { text: answer } : { last_assistant_message: answer }),
      }, env, root);
      expected.push({ role: 'user', content: prompt }, { role: 'agent', content: answer });
    }
  }
  assert.deepEqual(gateway.state.turns.map(({ role, content }) => ({ role, content })), expected);
  assert.equal(gateway.state.turns.length, 24);
  assert.ok(gateway.state.turns.every(turn => !turn.thread_id.startsWith('mh:manual:')));
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
  const probe = fileURLToPath(new URL('./helpers/native-auth-probe.mjs', import.meta.url));
  await run(process.execPath, [probe, join(root, 'runtime/auth.mjs')], { env, cwd: env.HOME, timeout: 15_000 });
  const powershell = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { env, stdio: 'ignore' }).status === 0;
  for (const host of Object.keys(HOSTS)) {
    const event = ['cursor', 'copilot'].includes(host) ? 'sessionStart' : 'SessionStart';
    const payload = host === 'cursor' ? { conversation_id: 'quoted' } : { session_id: 'quoted' };
    assert.match(JSON.stringify((await hook(host, event, payload, env, actual)).parsed), /TypeScript/);
    if (powershell && ['cursor', 'codex'].includes(host)) {
      assert.match(JSON.stringify((await hook(host, event, payload, env, actual, 'pwsh')).parsed), /TypeScript/);
    }
  }
});

test('publisher defaults cannot be overridden through model tools or environment variables', async t => {
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t);
  const server = await connectMcp(t, {
    args: [join(root, 'runtime/server.mjs')], cwd: env.HOME,
    env: { ...env, MEMORY_HOUSE_GATEWAY: 'http://127.0.0.1:9', MEMORY_HOUSE_ENTRA_CLIENT_ID: 'wrong', AMT_ACCESS_TOKEN: 'fake-secret' },
  });
  const status = data(await server.call('memory_status'));
  assert.equal(status.signedIn, false);
  assert.equal(status.publisherConfigReady, true);
  assert.equal(status.gatewayBase, undefined);
  assert.doesNotMatch(JSON.stringify(status), /https?:/);
  for (const input of [{ gatewayBase: 'https://wrong.example' }, { token: 'fake-secret' }]) {
    const result = await server.call('memory_login', input);
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /fake-secret/);
  }
});

test('rebuilds refuse locally edited or unrecognized generated files', async t => {
  await assert.rejects(buildRuntime({ outputRoot: PLUGIN_ROOT }), /dedicated runtime output directory/);
  const env = await isolatedEnvironment(t);
  const path = join(env.HOME, 'owned-runtime');
  await buildRuntime({ outputRoot: path });
  await writeFile(join(path, 'server.mjs'), 'user edit');
  await assert.rejects(buildRuntime({ outputRoot: path }), /local edits/);
  assert.equal(await readFile(join(path, 'server.mjs'), 'utf8'), 'user edit');
  const unknown = join(env.HOME, 'unknown-runtime');
  await mkdir(unknown);
  await writeFile(join(unknown, 'my-file.txt'), 'keep');
  await assert.rejects(buildRuntime({ outputRoot: unknown }), /unrecognized/);
  assert.equal(await readFile(join(unknown, 'my-file.txt'), 'utf8'), 'keep');
});

test('available Claude CLI validates and installs the same root catalog in an isolated profile', async t => {
  const env = {
    ...await isolatedEnvironment(t), DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', GIT_CONFIG_NOSYSTEM: '1',
  };
  const available = spawnSync('claude', ['plugin', 'validate', '--help'], {
    env, cwd: env.HOME, stdio: 'ignore', timeout: 20_000,
  });
  if (available.error?.code === 'ENOENT') { t.skip('Claude CLI is not installed on this test host.'); return; }
  assert.equal(available.status, 0, 'Claude plugin validator must be available without sign-in.');
  const root = await rootSnapshot(t);
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
  for (const file of ['runtime/server.mjs', 'runtime/hook.mjs', '.claude/entry.mjs', 'deployment.json']) {
    await access(join(installedRoot, file));
  }
  await assert.rejects(access(join(installedRoot, 'node_modules')), { code: 'ENOENT' });
  await assert.rejects(access(join(installedRoot, 'package-lock.json')), { code: 'ENOENT' });
  const mcp = await connectMcp(t, { args: [join(installedRoot, 'runtime/server.mjs')], env, cwd: env.HOME });
  assert.equal(data(await mcp.call('memory_status')).publisherConfigReady, true);
  assert.equal(data(await mcp.call('memory_status')).signedIn, false);
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
  assert.match(listed.stdout, /0\.13\.0/);
  assert.match(listed.stdout, /memory-house-marketplace/);
  assert.equal((listed.stdout.match(/0\.13\.0/g) ?? []).length, 1, listed.stdout);
  const skills = await run('copilot', ['skill', 'list'], { env, cwd: env.HOME, timeout: 30_000 });
  for (const name of ['mh-login', 'mh-logout', 'mh-status', 'mh-memory']) assert.match(skills.stdout, new RegExp(`\\b${name}\\b`));
});

test('available Codex loads six MCP tools, four named skills and three native hooks beside the legacy Copilot root', async t => {
  const env = { ...await isolatedEnvironment(t), GIT_CONFIG_NOSYSTEM: '1' };
  await mkdir(env.CODEX_HOME, { recursive: true });
  const available = spawnSync('codex', ['plugin', '--help'], { env, cwd: env.HOME, stdio: 'ignore', timeout: 20_000 });
  if (available.error?.code === 'ENOENT') { t.skip('Codex CLI is not installed on this test host.'); return; }
  assert.equal(available.status, 0);
  const root = await rootSnapshot(t);
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
  assert.deepEqual(hooks.map(value => value.eventName).sort(), ['sessionStart', 'stop', 'userPromptSubmit']);
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
  assert.equal(memory.toolsError, null);
  assert.equal(memory.serverInfo?.version, '0.13.0');
  assert.deepEqual(Object.keys(memory.tools).sort(), ['add_memory', 'get_memories', 'memory_login', 'memory_logout', 'memory_status', 'search_memories']);
  const skills = await server.request('skills/list', { cwds: [env.HOME], forceReload: true });
  const ownSkills = skills.data.flatMap(entry => entry.skills.filter(skill => skill.pluginId === 'memory-house@memory-house-marketplace'));
  assert.deepEqual(ownSkills.map(skill => skill.name).sort(), [
    'memory-house:mh-login', 'memory-house:mh-logout', 'memory-house:mh-memory', 'memory-house:mh-status',
  ]);
  assert.ok(ownSkills.every(skill => skill.enabled));
});
