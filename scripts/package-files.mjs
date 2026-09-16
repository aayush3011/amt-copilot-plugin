import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = fileURLToPath(new URL('../plugin/', import.meta.url));
export const MARKETPLACE_FILES = Object.freeze([
  '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json',
  '.cursor-plugin/marketplace.json', '.github/plugin/marketplace.json',
]);

export const PACKAGE_FILES = Object.freeze([
  'plugin.json', 'mcp.json', 'deployment.json', 'LICENSE',
  '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json',
  '.claude/entry.mjs', '.claude/mcp.json', '.claude/plugin-hooks.json',
  '.codex/entry.mjs', '.codex/mcp.json', '.codex/plugin-hooks.json',
  '.cursor/entry.mjs', '.cursor/mcp.json', '.cursor/plugin-hooks.json',
  '.github/entry.mjs', '.github/plugin-hooks.json',
  'skills/mh-memory/SKILL.md', 'skills/mh-login/SKILL.md',
  'skills/mh-logout/SKILL.md', 'skills/mh-status/SKILL.md',
]);

export async function verifyPayload(runtimeFiles, root = PLUGIN_ROOT) {
  const files = [];
  async function walk(directory = '') {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    if (!entries.length) throw new Error(`Empty plugin payload directory: ${directory}`);
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unsupported plugin payload entry: ${path}`);
    }
  }
  await walk();
  const expected = [...PACKAGE_FILES, ...runtimeFiles.map(name => `runtime/${name}`)].sort();
  if (JSON.stringify(files.sort()) !== JSON.stringify(expected)) {
    const unexpected = files.filter(path => !expected.includes(path));
    const missing = expected.filter(path => !files.includes(path));
    throw new Error(`Plugin payload differs from its inventory. Unexpected: ${unexpected.join(', ')}; missing: ${missing.join(', ')}.`);
  }
  return files;
}
