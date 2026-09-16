#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMemoryServer } from './mcp.mjs';

const app = createMemoryServer();
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } catch {
    process.stderr.write('memory-house: MCP shutdown failed.\n');
    process.exitCode = 1;
  }
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
process.stdin.once('end', close);
try {
  await app.server.connect(new StdioServerTransport());
} catch {
  process.stderr.write('memory-house: unable to start the MCP server. Install Node.js 20+ and the complete native plugin artifact.\n');
  process.exitCode = 1;
  await close();
}
