# Memory House - GitHub Copilot marketplace

A one-plugin custom marketplace for the **Memory House (Memory House)** memory plugin.

Add it to the GitHub Copilot app: **Customize -> Plugins -> gear icon -> Add custom
marketplace ->** `aayush3011/amt-copilot-plugin`, then install **memory-house**.

## What the plugin gives you

- **MCP server** (`memory-house`, 12 tools) - persistent, scoped memory over the Memory House gateway.
- **Skills** - teach the agent to use memory and provide `/mh-login`.
- **Hooks** - deterministic recall/capture plus automatic, redacted login completion.
- **Canvas** - a "Memory House" panel showing your facts grouped Personal / Team / Org.

## How it talks to Memory House

Nothing memory-related lives in this repo. The plugin config points at the deployed Memory House
gateway (a public, Entra-auth-gated HTTPS endpoint). At runtime the Copilot app connects to
that gateway and signs you in with Microsoft; your memory data stays in Azure Cosmos DB,
reachable only through the authenticated gateway. This repo is just the installer.

See `plugin/INSTALL.md` for full steps and `plugin/README.md` for the plugin design.

## Layout

```text
.github/plugin/marketplace.json   # the marketplace manifest (lists memory-house)
plugin/                           # the memory-house Agent Plugin (source: ./plugin)
```
