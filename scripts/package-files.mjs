// Minimum runtime verification/provenance inventory, not a Git clone filter.
export const PACKAGE_FILES = Object.freeze([
  'plugin.json', 'mcp.json', 'deployment.json', 'package.json', 'README.md', 'docs/maintaining.md', 'LICENSE', '.gitattributes',
  '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json',
  '.cursor-plugin/plugin.json', '.cursor-plugin/marketplace.json',
  '.agents/plugins/marketplace.json', '.github/plugin/marketplace.json',
  '.claude/entry.mjs', '.claude/mcp.json', '.claude/plugin-hooks.json',
  '.codex/entry.mjs', '.codex/plugin-hooks.json',
  '.cursor/entry.mjs', '.cursor/mcp.json', '.cursor/plugin-hooks.json',
  '.github/entry.mjs', 'com.github.copilot/hooks/hooks.json',
  'skills/mh-memory/SKILL.md', 'skills/mh-login/SKILL.md',
  'skills/mh-logout/SKILL.md', 'skills/mh-status/SKILL.md',
  'skills/mh-login/agents/openai.yaml', 'skills/mh-logout/agents/openai.yaml',
]);
