# Get started with Memory House in the GitHub Copilot app

Memory House gives Copilot a persistent, scoped memory: what you work on is remembered across
sessions, and knowledge your team promotes becomes visible to the rest of the team. It is
delivered as a Copilot plugin backed by Azure Cosmos DB through the Inference Platform gateway.

Setup takes about five minutes and is a one-time thing per machine.

## Before you start

- The **GitHub Copilot app** (desktop).
- No Azure subscription, no local database, and no config files. The plugin talks to a hosted
  gateway; nothing memory-related runs on your machine except the small recall and capture hooks.

## Step 0: Only if you installed the older "amt-memory" plugin

Skip this if this is your first install.

Memory House used to be called **amt-memory**. Installing the new plugin does not replace the
old one, it installs alongside it, and both register the same capture hooks. The result is that
every prompt and every reply is recorded **twice**. Clear the old install first.

Paste this into any Copilot chat and follow what it tells you:

```text
I am upgrading the Copilot memory plugin from the old "amt-memory" to the new "memory-house".
Help me remove both old and current memory-plugin installations and everything they left behind
so I have a completely plugin-free clean slate before reinstalling memory-house.

Before doing anything else, ask me exactly this and wait for my reply:

  "This cleanup deletes a few files under your .copilot folder. May I run the commands for you?
   Reply yes, or no if you would rather run them yourself."

If I reply NO: run nothing at all. Print the steps below as a numbered checklist, with the
exact command for my operating system on each one so I can copy them, then stop.

If I reply YES: work through the steps in order and report what you find at each one. You
are authorized to uninstall the plugins, remove their registrations and marketplaces, and
delete their local data yourself. Do not ask me to perform the uninstall manually.

Steps:

1. Locate the Copilot directory and show which memory plugins are installed:

     macOS/Linux:
       ls ~/.copilot/installed-plugins/*/

     Windows:
       Get-ChildItem $env:USERPROFILE\.copilot\installed-plugins -Directory -Recurse -Depth 1

   Look specifically for:

   - amt-memory
   - memory-house
   - amt-memory marketplaces
   - memory-house-marketplace

   Also inspect these files for registrations belonging to either plugin:

     ~/.copilot/settings.json
     ~/.copilot/config.json
     ~/.copilot/mcp-config.json

   Report what you find before changing anything.

   If no plugin directory is listed but settings.json, config.json, mcp-config.json or the
   app configuration still contains a registration for either plugin, treat it as an orphaned
   registration and continue with the coordinated cleanup below. Do not stop or ask me to fix
   it manually.

2. Before modifying anything, create backups of these files when they exist:

     ~/.copilot/settings.json
     ~/.copilot/config.json
     ~/.copilot/mcp-config.json

   Put each backup beside the original file with the suffix:

     .before-memory-cleanup

   Do not overwrite an existing backup. If that backup name already exists, add a timestamp
   to the new backup filename.

   Confirm that each original file is valid JSON before modifying it. mcp-config.json may
   begin with comment lines; preserve those comments if present while still validating and
   editing the JSON object beneath them.

3. Uninstall amt-memory and memory-house yourself as one coordinated operation.

   Do not ask me to use Customize > Plugins. Remove the plugins' registrations and installed
   directories together so the app is not left with an orphaned registration.

   In settings.json:

   - Remove entries under "enabledPlugins" whose key belongs to amt-memory or memory-house.
   - Remove "memory-house-marketplace" from "extraKnownMarketplaces".
   - Remove any marketplace entry that clearly belongs to amt-memory.
   - Preserve all unrelated plugins, marketplaces and settings.
   - If removing an entry leaves "enabledPlugins" or "extraKnownMarketplaces" empty, either
     leave it as an empty object or remove that empty property, whichever matches the existing
     file's style.

   In config.json:

   - Remove every object from "installedPlugins" whose "name" is "amt-memory" or
     "memory-house".
   - Use each matching object's "cache_path" and "marketplace" values to identify the exact
     installed directory and marketplace being removed.
   - Preserve every unrelated installed plugin object and every unrelated setting.
   - Leave "installedPlugins" as an empty array if no plugins remain.

   In mcp-config.json:

   - Remove entries under "mcpServers" whose key is "amt-memory" or "memory-house".
   - Also remove an MCP server entry if its command, arguments or URL clearly identify it as
     belonging to amt-memory, memory-house, memory-house-marketplace or the memory gateway.
   - Do not remove or alter any unrelated MCP server.

   Parse and rewrite the configuration files structurally as JSON. Never use unrestricted
   raw text replacement. Preserve the existing formatting as closely as practical.

   After updating the registrations, delete only the corresponding plugin directories:

     macOS/Linux:
       rm -rf ~/.copilot/installed-plugins/amt-memory*
       rm -rf ~/.copilot/installed-plugins/*/amt-memory
       rm -rf ~/.copilot/installed-plugins/memory-house-marketplace

     Windows:
       Remove-Item -Recurse -Force $env:USERPROFILE\.copilot\installed-plugins\memory-house-marketplace -ErrorAction SilentlyContinue

   On Windows, also locate and remove any installed plugin directory whose final directory
   name is "amt-memory" or whose parent marketplace clearly belongs to amt-memory. Resolve
   and print each exact path before deleting it. Do not use a broad recursive wildcard
   deletion and do not remove unrelated installed plugins.

   Print every registration and exact path removed.

4. Remove all local state left by amt-memory and memory-house.

   Remove the old hook state:

     macOS/Linux:
       rm -rf ~/.copilot/amt

     Windows:
       Remove-Item -Recurse -Force $env:USERPROFILE\.copilot\amt -ErrorAction SilentlyContinue

   Remove plugin data belonging to either plugin:

     macOS/Linux:
       rm -rf ~/.copilot/plugin-data/amt-memory-marketplace
       rm -rf ~/.copilot/plugin-data/memory-house-marketplace

     Windows:
       Remove-Item -Recurse -Force $env:USERPROFILE\.copilot\plugin-data\amt-memory-marketplace -ErrorAction SilentlyContinue
       Remove-Item -Recurse -Force $env:USERPROFILE\.copilot\plugin-data\memory-house-marketplace -ErrorAction SilentlyContinue

   If the marketplace name recorded in config.json differs from the names above, remove the
   plugin-data directory for that exact recorded marketplace as well, but only when it
   contains amt-memory or memory-house plugin data.

   Remove extension log files whose names contain "amt-memory" or "memory-house":

     macOS/Linux:
       find ~/.copilot/logs/extensions -type f \
         \( -iname '*amt-memory*' -o -iname '*memory-house*' \) \
         -print -delete 2>/dev/null

     Windows:
       Get-ChildItem $env:USERPROFILE\.copilot\logs\extensions -File -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -match 'amt-memory|memory-house' } |
         ForEach-Object {
           Write-Host $_.FullName
           Remove-Item -Force $_.FullName
         }

   Print every path as it is removed. Do not delete unrelated plugin data or logs.

5. Clear ONLY cached Microsoft sign-ins associated with the memory gateway. Every unrelated
   MCP server must stay signed in.

   In ~/.copilot/mcp-oauth-config, each server has up to three files sharing one hash:

     <hash>.json
     <hash>.tokens.json
     <hash>.verifier

   Read each <hash>.json. When its "serverUrl" contains any of these identifiers, delete all
   three files belonging to that hash:

   - reranker-api
   - amt-memory
   - memory-house

   Deleting only the main .json file is not sufficient because the token file can leave the
   app silently signed in.

   Print each filename as you delete it. Never touch a hash whose serverUrl points anywhere
   else. Do not delete the whole mcp-oauth-config directory because it may contain sign-ins
   for unrelated MCP servers.

6. Verify the cleanup thoroughly.

   Confirm all of the following:

   - Neither amt-memory nor memory-house appears under installed-plugins.
   - No plugin-data directory belonging to either plugin remains.
   - The ~/.copilot/amt directory no longer exists.
   - settings.json contains no enabled-plugin registration for either plugin.
   - settings.json contains no marketplace belonging to either plugin.
   - config.json contains no installedPlugins object for either plugin.
   - mcp-config.json contains no MCP server belonging to either plugin.
   - No matching memory-gateway OAuth file triplets remain.
   - No matching extension logs remain.
   - settings.json, config.json and mcp-config.json are still valid.
   - Every unrelated plugin, marketplace, MCP server and OAuth sign-in remains unchanged.

   Search for the following case-insensitively under ~/.copilot, excluding session history,
   command history, chat history, backups and general application databases:

   - amt-memory
   - memory-house
   - memory-house-marketplace

   Report any remaining matching path or active configuration entry. Historical mentions in
   session logs, chats, command history, backup files or databases do not count as an active
   installation and should not be deleted.

   If a file is locked by the running Copilot process, do not claim cleanup succeeded. Report
   the exact locked file and tell me that Copilot must be restarted before that item can be
   removed.

7. Finally, tell me to quit Copilot completely and reopen it:

   - macOS: Cmd+Q
   - Windows: close Copilot from the tray icon

   Explain that the currently running process may still have the removed plugin loaded until
   Copilot is restarted.
```

The agent asks permission first, and does nothing but print the steps if you decline. It backs
up every file it edits, removes only what belongs to the two memory plugins, and leaves your
other MCP servers and their sign-ins untouched.

Then continue with Step 1.

## Step 1: Add the marketplace

The Copilot app installs plugins from a marketplace, which is just a GitHub repo.

1. Open the **GitHub Copilot app**.
2. In the sidebar, go to **Customize** then **Plugins**.
3. Click the **gear icon** next to the marketplace dropdown, then **Add custom marketplace**.
4. Enter this repository:

   ```text
   aayush3011/amt-copilot-plugin
   ```

5. The marketplace loads and **memory-house** appears in the plugins list.

The repository is public, so you do not need to be granted access first.

## Step 2: Install the plugin

1. Find **memory-house** in the plugins list and click **Install**.
2. **Quit the Copilot app completely.** Cmd+Q on macOS, or close it from the tray icon on
   Windows. Sessions that were already open do not pick up a newly installed plugin, so its
   canvas, commands, and tools appear to be missing until you restart.

Do **not** sign in from the MCP tab yet. Sign in from the CLI first, in Step 3.

## Step 3: Sign in to the memory server from the CLI

With the app still closed, sign in once using the Copilot CLI. The CLI and the app share the
same credential store, so the app picks up this sign-in automatically.

This order matters on Windows. Signing in from the app's MCP tab can fail there with
`ENTRA_CONFIG ... code 2002`; the CLI uses a different sign-in path that is not affected. See
the troubleshooting entry if you want the details.

1. Install and start the CLI:

   ```bash
   agency copilot
   ```

2. In the CLI, list the MCP servers:

   ```text
   /mcp
   ```

3. Sign in to **memory-house**. A browser window opens for Microsoft sign-in.
4. Confirm it now shows as **connected** in `/mcp`, then exit the CLI.

## Step 4: Reopen the app and confirm the connection

1. Open the **GitHub Copilot app**.
2. Go to the **MCP** tab and confirm **memory-house** shows as connected, with its tools
   listed. You should not be asked to sign in again.


## Step 5: Enroll this device

Open a **new** chat and run:

```text
/mh-login
```

The agent fetches a short-lived enrollment code and redeems it for you. It should finish by saying it is signed in, without showing you a code or asking you to run anything.

```text
Signed in to Memory House. Capture and recall are now active on this device.
```

## Step 6: Open the memory canvas

In a Copilot chat, run:

```text
/mh-show
```

The **Memory House** canvas opens and shows your memories in three columns:

- **Personal** is what Memory House has learned from your own sessions.
- **Team** is knowledge promoted to your team's shared scope.
- **Org** is knowledge promoted broadly across the organization.

## Step 7: Confirm it is working

In a chat, ask:

```text
Call the memory-house whoami tool
```

You should get back your `user:<oid>` and the tenant id. That confirms sign-in, the gateway,
and the MCP server are all connected.

## Everyday use

You do not need to do anything special. Once installed, the plugin recalls relevant memory
before each prompt and captures what matters at the end of each turn.

## Troubleshooting

| Symptom | Start here |
| --- | --- |
| Team or Org is empty | Confirm your account belongs to a configured team. |
| Every turn shows up twice | The old `amt-memory` plugin is still installed. See Step 0. |
| Nothing is captured or the canvas asks you to sign in | Run `/mh-login`, then inspect the hook log. |
| A feature is "not available in this workspace" | Restart Copilot and open a new chat. |
| The MCP tab returns to **Sign in** | Verify with `whoami`; the badge may be stale. |
| Sign-in fails with `ENTRA_CONFIG ... 2002` (Windows) | Sign in from the CLI instead. See Step 3. |
| The MCP server shows no tools | Check disabled and duplicate MCP server settings. |
| The plugin looks outdated | Re-add the marketplace and reinstall the plugin. |

### Every turn shows up twice

You still have the older **amt-memory** plugin installed alongside **memory-house**. Both
register the same capture hooks, so each prompt and reply is sent twice. Follow Step 0 to clear
the old install, then reinstall.

To confirm before running anything, list what is installed:

```bash
ls ~/.copilot/installed-plugins/*/
```

Seeing both `amt-memory` and `memory-house` means Step 0 has not been run yet.

### Uninstall fails with "Plugin is not installed"

The app still lists a plugin, but uninstalling it reports:

```text
Failed to uninstall plugin "amt-memory@amt-memory-marketplace"
Plugin "amt-memory@amt-memory-marketplace" is not installed
```

This happens when the plugin's directory was deleted directly while its registration was left
behind. The app lists the plugin from its registration in `config.json`, then cannot uninstall
it because the files it would remove are gone. Restarting does not help, and neither does
disabling it.

**Quit Copilot completely first (Cmd+Q, or close the tray icon on Windows).** `config.json` is
managed by the app, and it rewrites the file from memory on exit, so an edit made while it is
running is silently undone.

```bash
cd ~/.copilot && cp config.json config.json.bak && cp settings.json settings.json.bak
python3 - <<'PY'
import json, os, re
H = os.path.expanduser("~/.copilot")
STALE = ("amt-memory", "memory-house")
MKTS  = ("amt-memory-marketplace", "memory-house-marketplace")

# config.json is the real plugin registry, and is JSONC: keep its leading comments.
p = os.path.join(H, "config.json")
raw = open(p).read()
m = re.match(r'((?:\s*//[^\n]*\n)*)', raw)
header, d = m.group(1), json.loads(raw[m.end():])
kept = [x for x in d.get("installedPlugins", []) if x.get("name") not in STALE]
print("installedPlugins:", len(d.get("installedPlugins", [])), "->", len(kept))
d["installedPlugins"] = kept
open(p, "w").write(header + json.dumps(d, indent=2) + "\n")

# settings.json holds the enable/disable flag and the marketplace registration.
p = os.path.join(H, "settings.json")
s = json.load(open(p))
for k in list(s.get("enabledPlugins") or {}):
    if k.split("@", 1)[0] in STALE:
        del s["enabledPlugins"][k]; print("enabledPlugins: removed", k)
for k in list(s.get("extraKnownMarketplaces") or {}):
    if k in MKTS:
        del s["extraKnownMarketplaces"][k]; print("marketplace: removed", k)
ext = (s.get("extensions") or {}).get("disabledExtensions")
if isinstance(ext, list):
    keep = [x for x in ext if not any(t in x for t in STALE)]
    if keep != ext:
        s["extensions"]["disabledExtensions"] = keep; print("disabledExtensions: cleared")
json.dump(s, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
rm -rf ~/.copilot/installed-plugins/*-marketplace
```

Reopen Copilot. The stale entry is gone and you can install cleanly.

### Team or Org memories are empty

Shared memory is scoped to teams configured on the server. Seeing only **Personal** is
expected when your account is not in the demo membership list. Ask Aayush to add your Entra
object ID to a team.

### Capture is not working or the canvas asks you to sign in

1. Run `/mh-login` once.
2. Send one ordinary prompt.
3. Inspect the hook log:

   ```bash
   cat ~/.copilot/amt/hook.log
   ```

Useful log entries:

- `login:auto:ok` means device enrollment completed.
- `capture:agent:ok:201` means an agent turn was ingested successfully.
- `skipped:no-hook-token:<reason>` means the hook had no usable token, and the reason says why.
  `not signed in` means you never enrolled, `refresh rejected` means the device was signed out
  and needs `/mh-login` again, and `refresh unreachable` means the gateway was not reachable
  and the next prompt will retry on its own.
- No log file means the hooks did not load. Missing `jq` on `PATH` is the most common cause.

If the agent prints an enrollment code, do not copy or share it. Reinstall the latest plugin
version and restart Copilot; the current plugin redeems that credential locally and redacts it
from the response.

### A plugin feature is "not available in this workspace"

The chat started before the plugin was installed. Quit Copilot completely with **Cmd+Q**,
reopen it, and start a new chat.

### The MCP tab returns to Sign in

> [!NOTE]
> This is intermittent GitHub Copilot MCP status/reconnect flakiness, not an
> `memory-house`-specific authentication failure. We have observed the same stale sign-in
> behavior with the separately configured `bluebird-cosmosdb` MCP server.

Copilot can cache the OAuth token successfully while an older MCP tab continues to show
**Sign in**. To verify the real connection state:

1. Complete Microsoft sign-in once.
2. Close and reopen the MCP tab, then start a new Copilot chat.
3. Ask the new chat to call the `memory-house` `whoami` tool.
4. If `whoami` returns your `user:<oid>`, authentication is working regardless of the badge.
5. If it still fails, quit Copilot completely with **Cmd+Q**, reopen it, and retry `whoami`.

Do not repeatedly sign in, delete credentials, or reinstall the plugin unless Microsoft shows
an actual Entra/AAD error.

### Sign-in fails with "ENTRA_CONFIG ... code 2002"

The MCP tab reports something like:

```
Microsoft Entra sign-in for https://<gateway>/inference/memory/mcp/ failed:
ENTRA_CONFIG: the authenticator rejected the configuration [code 2002, tag ...]
```

**This is why Step 3 signs in from the CLI.** If you followed the steps in order you should
not hit it.

It affects Windows only, and only the desktop app. Devices set up for GitHub Enterprise
Managed Users carry a machine-wide variable, `COPILOT_ENTRA_AUTH_AUD`, that exists for
Copilot's own GitHub sign-in. The app's Windows-only broker path also applies it to MCP
sign-in, which pins the wrong audience and makes the broker reject the configuration before
any network call. The CLI does not use that path, which is why signing in there works, and
macOS is unaffected because that build has no broker path at all.

Nothing on the server causes this and nothing on the server fixes it.

Do this in order:

1. **Sign in from the CLI instead**, as in Step 3. This is the recommended fix; it needs no
   changes to your machine.

   ```bash
   npm install -g @github/copilot
   copilot
   ```

   Then `/mcp`, sign in to **memory-house**, exit, and reopen the app.

2. If you have already signed in and the app still shows the error, clear the cached sign-in
   for this server only and retry from the CLI. Step 0's cleanup prompt does this for you.

3. Only if neither works, launch the app once with the variable removed from that process:

   ```powershell
   Remove-Item Env:\COPILOT_ENTRA_AUTH_AUD
   Start-Process "$env:LOCALAPPDATA\Programs\GitHub Copilot\github.exe"
   ```

   Do **not** delete the machine-wide variable. On an EMU-managed device it is used for
   Copilot's own GitHub sign-in, and removing it permanently can block that later. Clearing it
   for a single process is safe.

### The MCP server shows no tools

Check that:

- `memory-house` is not listed under `disabledMcpServers` in Copilot's `settings.json`.
- You are not also running a manually added MCP server named `memory-house`.

### You signed in with the wrong account

Run `/mh-logout`, then `/mh-login` again with the intended Microsoft account.

### The plugin looks outdated after an update

Copilot caches marketplace content. Remove and re-add the marketplace, then reinstall the
plugin so Copilot fetches the current version.

## Where your data lives

Memories are stored in Azure Cosmos DB and are reachable only through the authenticated
gateway. Your personal memories are visible only to you. A memory becomes visible to your team
only when it is promoted into a shared scope, which happens server side under a policy that
checks relevance and safety. Installing the plugin does not copy anything off your machine
beyond the conversation memory Memory House extracts.
