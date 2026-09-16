import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PACKAGE_FILES } from '../../scripts/package-files.mjs';
import { fixtureDeployment } from './deployment.mjs';

export async function isolatedEnvironment(t) {
  const home = await mkdtemp(join(tmpdir(), 'memory-house-native-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home, USERPROFILE: home,
    MEMORY_HOUSE_HOME: join(home, '.memory-house'),
    COPILOT_HOME: join(home, '.copilot'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    MH_ALLOW_INSECURE_LOCALHOST: '1',
  };
}

export async function rootSnapshot(t, { deployment, name = 'installed plugin' } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'memory-house-snapshot-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, name);
  const source = fileURLToPath(new URL('../..', import.meta.url));
  const manifest = JSON.parse(await readFile(join(source, 'runtime/manifest.json'), 'utf8'));
  const files = [...PACKAGE_FILES, ...Object.keys(manifest.outputs).map(name => `runtime/${name}`), 'runtime/manifest.json'];
  for (const name of files) {
    const target = join(root, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(source, name)));
  }
  if (deployment) await writeFile(join(root, 'deployment.json'), JSON.stringify(deployment));
  return root;
}

export async function memoryFixture(t, gateway, { loginFixture = false, browserBehavior = 'success' } = {}) {
  const env = await isolatedEnvironment(t);
  const deployment = fixtureDeployment(gateway.base);
  const root = await rootSnapshot(t, { deployment });
  const args = [
    ...(loginFixture ? ['--import', fileURLToPath(new URL('./direct-login-bootstrap.mjs', import.meta.url))] : []),
    join(root, 'runtime/server.mjs'),
  ];
  const mcp = await connectMcp(t, { args, cwd: env.HOME, env: { ...env, ...(loginFixture ? { MH_FIXTURE_BROWSER_BEHAVIOR: browserBehavior } : {}) } });
  return { env, deployment, root, ...mcp };
}

export async function connectMcp(t, { command = process.execPath, args, cwd, env }) {
  const transport = new StdioClientTransport({ command, args, env, cwd, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const client = new Client({ name: 'memory-house-fixture', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  return { client, stderr: () => stderr, call: (name, input = {}) => client.callTool({ name, arguments: input }) };
}
