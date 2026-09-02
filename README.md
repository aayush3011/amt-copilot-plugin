# AMT Memory - GitHub Copilot marketplace

A one-plugin custom marketplace for the **Agent Memory Toolkit (AMT)** memory plugin.

Add it to the GitHub Copilot app: **Customize -> Plugins -> gear icon -> Add custom
marketplace ->** `aayush3011/amt-copilot-plugin`, then install **amt-memory**.

## What the plugin gives you

- **MCP server** (`amt-memory`, 12 tools) - persistent, scoped memory over the AMT gateway.
- **Skills** - teach the agent to use memory and provide `/amt-login`.
- **Hooks** - deterministic recall/capture plus automatic, redacted login completion.
- **Canvas** - a "AMT Memory" panel showing your facts grouped Personal / Team / Org.

## How it talks to AMT

Nothing memory-related lives in this repo. The plugin config points at the deployed AMT
gateway (a public, Entra-auth-gated HTTPS endpoint). At runtime the Copilot app connects to
that gateway and signs you in with Microsoft; your memory data stays in Azure Cosmos DB,
reachable only through the authenticated gateway. This repo is just the installer.

See `plugin/INSTALL.md` for full steps and `plugin/README.md` for the plugin design.

## Layout

```text
.github/plugin/marketplace.json   # the marketplace manifest (lists amt-memory)
plugin/                           # the amt-memory Agent Plugin (source: ./plugin)
```
