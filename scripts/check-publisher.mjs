import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, requirePublisherConfig } from '../src/config.mjs';
import { PLUGIN_ROOT } from './package-files.mjs';

try {
  const config = loadConfig({ env: {}, home: process.cwd(), pluginRoot: PLUGIN_ROOT });
  requirePublisherConfig(config);
  const server = JSON.parse(await readFile(join(PLUGIN_ROOT, 'mcp.json'), 'utf8'))?.mcpServers?.['memory-house'];
  if (server?.type !== 'http' || server.url !== config.mcpUrl) {
    throw new Error('mcp.json must point the memory-house server at the deployment gateway\'s /mcp/ endpoint.');
  }
  process.stdout.write('Publisher gateway, remote MCP endpoint and public Entra settings are present. Live sign-in and tenant consent still require a user.\n');
} catch (error) {
  process.stderr.write(`memory-house: ${error.message}\n`);
  process.exitCode = 1;
}
