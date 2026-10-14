import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildRuntime } from '../scripts/build.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { isolatedEnvironment, rootSnapshot } from './helpers/runtime.mjs';
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
// Each app's name for the remote enroll_hook_capture tool; Claude prefixes plugin servers.
const ENROLLMENT_TOOLS = {
  claude: 'mcp__plugin_memory-house_memory-house__enroll_hook_capture',
  codex: 'mcp__memory-house__enroll_hook_capture',
  copilot: 'memory-house-enroll_hook_capture',
};

async function discover(root, host) {
  const spec = HOSTS[host];
  const catalog = await json(join(dirname(root), spec.catalog));
  assert.equal(catalog.name, 'memory-house-marketplace');
  assert.equal(catalog.plugins.length, 1);
  const entry = catalog.plugins[0];
  assert.equal(entry.name, 'memory-house');
  assert.equal(entry.version, '0.14.1');
  const source = entry.source.path ?? entry.source;
  assert.equal(source, './plugin');
  const pluginRoot = resolve(dirname(root), source);
  assert.equal(pluginRoot, resolve(root));
  const manifest = await json(join(pluginRoot, spec.manifest));
  assert.equal(manifest.name, 'memory-house');
  assert.equal(manifest.version, '0.14.1');
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
  const { gatewayBase } = await json(join(pluginRoot, 'deployment.json'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['memory-house']);
  const server = mcp.mcpServers['memory-house'];
  assert.deepEqual(Object.keys(server).sort(), ['headersHelper', 'http_headers_helper', 'type', 'url']);
  assert.equal(server.type, 'http');
  assert.equal(server.url, `${gatewayBase}/mcp/`);
  // Claude and Codex send the plugin's hook token through these launchers; Copilot signs in itself.
  assert.match(server.headersHelper, /process\.env\.CLAUDE_PLUGIN_ROOT,'runtime\/auth\.mjs'.* -- headers$/);
  assert.ok(server.http_headers_helper.includes(`['${manifest.version}','local']`));
  assert.ok(server.http_headers_helper.includes("'memory-house-marketplace','memory-house',v,'runtime','auth.mjs'"));
  const events = host === 'copilot'
    ? ['sessionStart', 'userPromptSubmitted', 'userPromptTransformed', 'postToolUse', 'agentStop', 'sessionEnd']
    : ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse'];
  assert.deepEqual(Object.keys(hooks.hooks), events);
  if (host !== 'copilot') assert.equal(hooks.hooks.PostToolUse[0].matcher, ENROLLMENT_TOOLS[host]);
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

function enrollmentCall(host) {
  const text = JSON.stringify({ enrollment_code: 'fixture-enrollment', expires_in: 300 });
  if (host === 'copilot') {
    // Copilot 1.0.95 joins the MCP text and its structured-content JSON with a blank line.
    return ['postToolUse', { sessionId: 'login', toolName: ENROLLMENT_TOOLS.copilot, toolResult: { resultType: 'success', textResultForLlm: `${text}\n\n${text}` } }];
  }
  return ['PostToolUse', {
    session_id: 'login', hook_event_name: 'PostToolUse', tool_name: ENROLLMENT_TOOLS[host], tool_input: {},
    tool_response: host === 'claude' ? [{ type: 'text', text }] : { content: [{ type: 'text', text }] },
  }];
}

// Sign in the way the mh-login skill does: the remote tool's result reaches the app's post-tool hook.
async function signIn(host, env, root) {
  const [event, payload] = enrollmentCall(host);
  const result = await hook(host, event, payload, env, root);
  assert.match(result.stdout, /completed on this device/);
  assert.doesNotMatch(result.stdout, /fixture-enrollment/);
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
  assert.deepEqual((await readdir(join(root, 'skills'))).sort(), ['mh-login', 'mh-logout', 'mh-memory', 'mh-show', 'mh-status', 'use-memory']);
  for (const [name, tool] of [['mh-login', 'enroll_hook_capture'], ['mh-logout', 'runtime/auth.mjs'], ['mh-status', 'runtime/auth.mjs'], ['mh-memory', 'search_memories'], ['mh-show', 'get_memories'], ['use-memory', 'search_memories']]) {
    const source = await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(source, new RegExp(`^name: ${name}$`, 'm'));
    assert.ok(source.includes(`\`${tool}\``));
    assert.doesNotMatch(source, /^disable-model-invocation:/m);
    if (['mh-login', 'mh-logout'].includes(name)) assert.match(source, /only for an explicit user request/);
  }
  const loginSkill = await readFile(join(root, 'skills/mh-login/SKILL.md'), 'utf8');
  assert.match(loginSkill, /Never quote, repeat, summarize or display an enrollment code/);
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
  // Microsoft sign-in is bundled for Claude and Codex; the MCP server is remote, so no MCP SDK is.
  assert.ok(manifest.dependencies.some(value => value.name === '@azure/msal-node'));
  assert.equal(manifest.dependencies.some(value => value.name.startsWith('@modelcontextprotocol/')), false);
  assert.equal(Object.keys(manifest.sources).some(path => path.startsWith('/')), false);
  const ignored = spawnSync('git', ['check-ignore', 'plugin/runtime/hook.mjs', 'plugin/runtime/manifest.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ignored.status, 1);
  assert.equal(ignored.stdout, '');
});

test('each host signs in through its post-tool hook without exposing the enrollment code', async t => {
  const gateway = await mockGateway(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  for (const host of Object.keys(HOSTS)) {
    const env = await isolatedEnvironment(t);
    assert.equal((await authStatus(env, root)).signedIn, false);
    await signIn(host, env, root);
    assert.equal((await authStatus(env, root)).signedIn, true);
  }
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/hook/redeem')).length, 3);
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/mcp/')).length, 0);
});

test('the bundled login helper signs in through Microsoft and the gateway', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  const probe = fileURLToPath(new URL('./helpers/native-auth-probe.mjs', import.meta.url));
  await run(process.execPath, [probe, join(root, 'runtime/auth.mjs')], { env, cwd: env.HOME, timeout: 15_000 });
  assert.equal((await authStatus(env, root)).signedIn, true);
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/hook/redeem')).length, 1);
});

test('the Claude and Codex header launchers find the plugin and send the shared hook token', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  const server = (await json(join(root, 'mcp.json'))).mcpServers['memory-house'];
  // Codex runs its helper from the user's directory, so the launcher reads Codex's documented install cache.
  await cp(root, join(env.CODEX_HOME, 'plugins/cache/memory-house-marketplace/memory-house/0.14.1'), { recursive: true });
  // Header helpers reach cmd.exe the same verbatim, quoted way as hook commands (see hook()).
  const launch = async (command, extraEnv) => {
    const [shell, args] = process.platform === 'win32'
      ? [env.ComSpec ?? 'cmd.exe', ['/d', '/v:off', '/s', '/c', `"${command}"`]] : ['/bin/sh', ['-c', command]];
    const response = await execute(shell, args, { env: { ...env, ...extraEnv }, cwd: env.HOME, windowsVerbatimArguments: true });
    assert.equal(response.code, 0, response.stderr);
    return JSON.parse(response.stdout);
  };
  const claude = () => launch(server.headersHelper, { CLAUDE_PLUGIN_ROOT: root });
  // Codex passes its helper only HOME and PATH (plus the fixture's loopback allowance here).
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
  assert.deepEqual(await claude(), { Authorization: 'HookToken fixture-access-1' });
  assert.deepEqual(await codex(), { Authorization: 'HookToken fixture-access-1' });
});

test('one sign-in serves recall and capture in every host', async t => {
  const gateway = await mockGateway(t);
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t, { deployment: fixtureDeployment(gateway.base) });
  await signIn('copilot', env, root);
  for (const host of Object.keys(HOSTS)) {
    const session = `${host}-one`;
    const prompt = 'Use concise TypeScript examples.';
    const startEvent = host === 'copilot' ? 'sessionStart' : 'SessionStart';
    const sessionPayload = { session_id: session };
    const start = await hook(host, startEvent, sessionPayload, env, root);
    assert.match(JSON.stringify(start.parsed), /TypeScript/);
    const promptEvent = host === 'copilot' ? 'userPromptSubmitted' : 'UserPromptSubmit';
    const submitted = await hook(host, promptEvent, { ...sessionPayload, prompt, turn_id: 'turn-1' }, env, root);
    if (['claude', 'codex'].includes(host)) assert.match(submitted.parsed.hookSpecificOutput.additionalContext, /TypeScript/);
    else assert.deepEqual(submitted.parsed, {});
    if (host === 'copilot') {
      const transformed = await hook(host, 'userPromptTransformed', { ...sessionPayload, prompt, transformedPrompt: `Runtime\n${prompt}` }, env, root);
      assert.match(transformed.parsed.modifiedTransformedPrompt, /^Runtime\n/);
      assert.deepEqual((await hook(host, 'postToolUse', sessionPayload, env, root)).parsed, {});
    }
    const stopEvent = host === 'copilot' ? 'agentStop' : 'Stop';
    const finalText = { last_assistant_message: 'I will use concise examples.' };
    assert.deepEqual((await hook(host, stopEvent, { ...sessionPayload, turn_id: 'turn-1', ...finalText }, env, root)).parsed, {});
  }
  assert.equal(gateway.state.requests.filter(request => request.path.endsWith('/redeem')).length, 1);
  assert.equal(gateway.state.turns.filter(turn => turn.role === 'agent').length, 3);
  assert.equal(new Set(gateway.state.turns.map(turn => turn.thread_id)).size, 3);
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
  assert.deepEqual(gateway.state.turns.map(({ role, content }) => ({ role, content })), expected);
  assert.equal(gateway.state.turns.length, 18);
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
  await signIn('codex', env, actual);
  const powershell = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { env, stdio: 'ignore' }).status === 0;
  for (const host of Object.keys(HOSTS)) {
    const event = host === 'copilot' ? 'sessionStart' : 'SessionStart';
    const payload = { session_id: 'quoted' };
    assert.match(JSON.stringify((await hook(host, event, payload, env, actual)).parsed), /TypeScript/);
    if (powershell && host === 'codex') {
      assert.match(JSON.stringify((await hook(host, event, payload, env, actual, 'pwsh')).parsed), /TypeScript/);
    }
  }
});

test('publisher defaults and sign-in cannot be overridden through environment variables', async t => {
  const env = await isolatedEnvironment(t);
  const root = await rootSnapshot(t);
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

test('available Claude CLI validates, installs and connects the remote MCP server with the hook token in an isolated profile', async t => {
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
  for (const file of ['mcp.json', 'runtime/hook.mjs', 'runtime/auth.mjs', '.claude/entry.mjs', 'deployment.json']) {
    await access(join(installedRoot, file));
  }
  await assert.rejects(access(join(installedRoot, 'runtime/server.mjs')), { code: 'ENOENT' });
  await assert.rejects(access(join(installedRoot, 'node_modules')), { code: 'ENOENT' });
  await assert.rejects(access(join(installedRoot, 'package-lock.json')), { code: 'ENOENT' });
  assert.equal((await authStatus(env, installedRoot)).signedIn, false);
  // After the plugin's sign-in, Claude's header helper connects the remote MCP server with the hook token.
  await signIn('claude', env, root);
  const listed = await run('claude', ['mcp', 'list'], { env, cwd: env.HOME, timeout: 60_000 });
  assert.match(listed.stdout, /plugin:memory-house:memory-house: .*\(HTTP\) - ✔ Connected/);
  assert.ok(gateway.state.requests.some(request => request.path === '/inference/memory/mcp/' && request.authorization === 'HookToken fixture-access-1'));
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
  assert.match(listed.stdout, /0\.14\.1/);
  assert.match(listed.stdout, /memory-house-marketplace/);
  assert.equal((listed.stdout.match(/0\.14\.1/g) ?? []).length, 1, listed.stdout);
  const skills = await run('copilot', ['skill', 'list'], { env, cwd: env.HOME, timeout: 30_000 });
  for (const name of ['mh-login', 'mh-logout', 'mh-status', 'mh-memory', 'mh-show', 'use-memory']) assert.match(skills.stdout, new RegExp(`\\b${name}\\b`));
  // Copilot ignores the Claude and Codex launcher fields and signs in to the remote server itself.
  const mcp = await run('copilot', ['mcp', 'get', 'memory-house'], { env, cwd: env.HOME, timeout: 30_000 });
  assert.match(mcp.stdout, /Type: http/);
  assert.match(mcp.stdout, /URL: https:\/\/[^\s]+\/inference\/memory\/mcp\//);
  assert.match(mcp.stdout, /Source: Plugin/);
});

test('available Codex registers the remote MCP server, six named skills and four native hooks beside the legacy Copilot root', async t => {
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
  assert.deepEqual(hooks.map(value => value.eventName).sort(), ['postToolUse', 'sessionStart', 'stop', 'userPromptSubmit']);
  assert.equal(hooks.find(value => value.eventName === 'postToolUse').matcher, ENROLLMENT_TOOLS.codex);
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
    'memory-house:use-memory',
  ]);
  assert.ok(ownSkills.every(skill => skill.enabled));
});
