# Installing the AMT plugin into the GitHub Copilot app (Mac)

The Copilot app installs plugins from a **marketplace** (a GitHub repo), not from a local
folder. This repo is now set up to be that marketplace: `.github/plugin/marketplace.json`
lists the `amt-memory` plugin, sourced from `./plugin`.

## One-time: publish the marketplace

The app reads the marketplace from GitHub, so the manifest and plugin must be pushed to a
branch the app can fetch.

```bash
git add .github/plugin/marketplace.json plugin/
git commit -m "Add amt-memory plugin + marketplace manifest"
git push
```

Note the branch. The app's marketplace fetch uses the repo's default branch unless the
source pins a ref; if you push to a feature branch, either open it as the default for
testing or merge to the default branch.

## Add the custom marketplace in the app

1. Open the **GitHub Copilot app**.
2. Sidebar -> **Customize** -> **Plugins**.
3. Click the **gear icon** next to the marketplace dropdown -> **Add custom marketplace**.
4. Enter the repo: `aayush3011/AgentMemoryToolkit-private`
   (or the full URL `https://github.com/aayush3011/AgentMemoryToolkit-private`).
5. The marketplace loads and `amt-memory` appears in the Plugins list.

## Install and use

1. Find **amt-memory** in the Plugins list -> **Install**.
2. The app loads its pieces:
   - **MCP server** (`amt-memory`, 12 tools) -> sign in with Microsoft when prompted
     (the gateway's OAuth discovery drives this).
   - **Skill** (`use-memory`) -> appears under Customize -> Skills.
   - **Hooks** (inject / capture) -> run locally; need `jq` and `curl` on PATH.
   - **Canvas** (`AMT Memory`) -> appears under Customize -> Canvas; open it in a session.
3. Verify: in a chat, "call the amt-memory whoami tool" -> expect your `user:<oid>` and
   tenant. Then open the **AMT Memory** canvas to see facts grouped by Personal / Team / Org.

## Things to confirm on first install (spec is new/evolving)

- **Private repo access**: the app must be able to read this repo. If the app cannot fetch
  a private repo's marketplace, make a dedicated public marketplace repo (or push the
  `plugin/` there) and point the app at that.
- **Canvas registration key**: registered under the native top-level `extensions` field in
  `plugin.json`, alongside the top-level `hooks`, `skills`, `commands`, and `mcpServers`
  component paths expected by Copilot.
- **Hook auth**: run `/amt-login` once after the MCP server is connected. It enrolls the
  hook scripts and caches a gateway-issued access/refresh token under the Copilot home.
- **Windows**: PowerShell hook entries and `.ps1` script twins are included.

## Iterating during development

The app caches the marketplace. After editing `plugin/`, push again and re-install (or
remove + re-add the marketplace) so the app refetches. For fast local iteration on just the
MCP server or canvas, the Copilot CLI's `--plugin-dir ./plugin` loads the folder directly
without a marketplace.
