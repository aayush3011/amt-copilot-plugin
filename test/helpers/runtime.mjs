import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PACKAGE_FILES, PLUGIN_ROOT, MARKETPLACE_FILES } from '../../scripts/package-files.mjs';
import { installFakeAzureCli } from './azure-cli.mjs';

export async function isolatedEnvironment(t) {
  const home = await mkdtemp(join(tmpdir(), 'memory-house-native-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cli = await installFakeAzureCli(home);
  return {
    PATH: `${cli.bin}${delimiter}${process.env.PATH}`,
    AZURE_CONFIG_DIR: cli.config,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    // Unlike cmd.exe, PowerShell has no default PATHEXT; without it `node` never resolves to node.exe.
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
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
  const marketplace = join(temp, name);
  const root = join(marketplace, 'plugin');
  const source = fileURLToPath(new URL('../..', import.meta.url));
  const manifest = JSON.parse(await readFile(join(PLUGIN_ROOT, 'runtime/manifest.json'), 'utf8'));
  const files = [...PACKAGE_FILES, ...Object.keys(manifest.outputs).map(name => `runtime/${name}`), 'runtime/manifest.json'];
  for (const name of files) {
    const target = join(root, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(PLUGIN_ROOT, name)));
  }
  for (const name of MARKETPLACE_FILES) {
    const target = join(marketplace, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(source, name)));
  }
  if (deployment) {
    await writeFile(join(root, 'deployment.json'), JSON.stringify(deployment));
    // Point the remote MCP entry at the fixture gateway too, so native apps never reach the real one.
    const mcp = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'));
    mcp.mcpServers['memory-house'].url = `${deployment.gatewayBase.replace(/\/+$/, '')}/mcp/`;
    await writeFile(join(root, 'mcp.json'), JSON.stringify(mcp));
  }
  return root;
}
