# AMT Memory - Agent Plugin (POC)

Packages the deployed AMT memory service as an Agent Plugin 1.0 for the GitHub Copilot app
(also VS Code and the CLI). It bundles:

- **MCP server** (`.mcp.json`) - the `amt-memory` server with its 12 tools, via the IP
  gateway (OAuth sign-in handled by the client, no token in the file).
- **Skill** (`skills/use-memory/`) - teaches the agent to consult and update memory during
  real work.
- **Hooks** (`com.github.copilot/hooks/`) - deterministic recall and capture that MCP alone
  cannot do:
  - `userPromptSubmitted` -> `inject.sh` retrieves memories and injects them before the
    model sees the prompt.
  - `agentStop` -> `capture.sh` appends the turn to AMT.
- **Commands** (`com.github.copilot/commands/`) - `/memory-show`, `/forget`.
- **Canvas** (`com.github.copilot/extensions/memory-canvas/`) - a "Memory" panel that
  shows what AMT remembers about you, grouped by Personal / Team / Org, with refresh /
  forget / promote actions. See its own README.

The backend (gateway + managed service + core + durable pipeline + Cosmos) is unchanged;
this is purely a client-surface package.

## Layout

```text
plugin/
├── plugin.json
├── mcp.json
├── skills/use-memory/SKILL.md
└── com.github.copilot/
    ├── hooks/hooks.json
    ├── scripts/{inject,capture,amt-token}.sh
    ├── commands/{memory-show,forget}.md
    └── extensions/memory-canvas/{package.json,extension.mjs,README.md}
```

## Prerequisites

- Azure CLI (`az`) installed and signed in: `az login` (tenant `72f988bf-...`).
- `jq` and `curl` on PATH (used by the hook scripts).
- The scripts are executable: `chmod +x com.github.copilot/scripts/*.sh`.

## What is demo-grade vs. real

- **Auth (`amt-token.sh`)**: uses `az account get-access-token` - fine for the demo,
  expires ~1h. A first-class token path is the main follow-up.
- **`userPromptSubmitted` injection field**: uses `additionalContext` (the documented hook
  output for injecting model context). Confirm the field on first run against the
  [Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference).
- **Windows**: only `bash` hook entries are provided. Add `.ps1` equivalents and
  `powershell` keys in `hooks.json` for Windows hosts.
- **`/forget`**: no delete endpoint exists yet (AMT supersedes, not deletes).

## Quick local check (no Copilot needed)

Verify the scripts talk to AMT with your identity:

```bash
# recall path: what would be injected for a prompt
echo '{"prompt":"what did we decide about signing the x-amt-context header"}' \
  | ./com.github.copilot/scripts/inject.sh

# capture path: append a turn
echo '{"prompt":"test turn from the plugin","threadId":"plugin-smoke"}' \
  | ./com.github.copilot/scripts/capture.sh
```

## Install (GitHub Copilot app / CLI / VS Code)

MCP-only path works today with just `.mcp.json` (add the server URL in the app's Customize
tab; sign in when prompted). Full plugin install (with hooks + commands) follows the Agent
Plugins install flow for your client; point it at this `plugin/` directory. Hooks run
locally, so `az`, `jq`, and `curl` must be available in the shell the client uses.

See `Docs/amt-plugin-design-sketch.md` for the full design, the canvas ("see my memories")
surface, and the effort breakdown.
