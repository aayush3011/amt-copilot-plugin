import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, requirePublisherConfig } from '../src/config.mjs';
import { PLUGIN_ROOT } from './package-files.mjs';

try {
  const config = loadConfig({ env: {}, home: process.cwd(), pluginRoot: PLUGIN_ROOT });
  requirePublisherConfig(config);
  const server = JSON.parse(await readFile(join(PLUGIN_ROOT, 'mcp.json'), 'utf8'))?.mcpServers?.['memory-house'];
  if (server?.type !== 'http' || server.url !== config.mcpUrl) {
    throw new Error('mcp.json must point the memory-house server at deployment.json mcpUrl, or gatewayBase + /mcp/ when omitted.');
  }
  if (server.oauthClientId !== config.clientId || server.oauthPublicClient !== true
    || server.oauthGrantType !== 'authorization_code'
    || !Array.isArray(server.oauthScopes) || server.oauthScopes.length !== 1 || server.oauthScopes[0] !== config.mcpScope
    || !Number.isInteger(server.auth?.redirectPort) || server.auth.redirectPort < 1 || server.auth.redirectPort > 65535) {
    throw new Error('mcp.json must configure the publisher public client, MCP scope, authorization_code grant and a valid auth.redirectPort for Copilot OAuth.');
  }
  process.stdout.write('Publisher gateway, remote MCP endpoint and public Entra settings are present. Live sign-in and tenant consent still require a user.\n');
} catch (error) {
  process.stderr.write(`memory-house: ${error.message}\n`);
  process.exitCode = 1;
}
