---
name: amt-import
description: Import GitHub Copilot or Claude Code history into Memory House - either the agent's own saved memories, or turns from past sessions.
---

Import existing agent history into Memory House. Two dimensions, so ask the user for both
(or use whatever they already named):

**Source** - which agent the history comes from. Pass it with `--source`:

- `copilot` (default) - GitHub Copilot CLI, read from `~/.copilot/session-state`.
- `claude` - Claude Code, read from `~/.claude/projects`.

**Kind** - what to import from that source:

- **Saved memories** - the facts the agent already distilled. Published straight into Memory
  House as facts, then reconciled against existing memories.
- **Local sessions** - past conversations. Their turns are imported and Memory House distills
  them (extract / reconcile / summarize) automatically, like any live turns.

Everything is read-only against the source's own directory (nothing there is modified) and
each item keeps its original timestamp. Auth uses the plugin's hook token; if any step
reports "not signed in", run `/amt-login` first, then retry.

Run these commands yourself in this turn. Never print a command for the user to run. In the
commands below, `$SCRIPTS` is the plugin's scripts directory:

macOS and Linux:

```bash
SCRIPTS="$(ls -d "${COPILOT_HOME:-$HOME/.copilot}"/installed-plugins/*/amt-memory/com.github.copilot/scripts | head -1)"
```

Windows (PowerShell):

```powershell
$SCRIPTS = (Get-ChildItem -Path (Join-Path $HOME '.copilot/installed-plugins') -Recurse -Directory -Filter scripts | Where-Object { $_.FullName -match 'amt-memory' } | Select-Object -First 1).FullName
```

Add `--source claude` to any command below to read Claude Code instead of Copilot. Omit it
for Copilot, which is the default.

### Saved memories
Run the engine and report how many memories were imported:
```
node "$SCRIPTS/amt-import.mjs" import-memories
node "$SCRIPTS/amt-import.mjs" import-memories --source claude
```

### Local sessions
1. List the available sessions. Each entry shows an id, a turn count, a derived label, and a
   short preview of the last exchange (`you:` and `agent:`):
   ```
   node "$SCRIPTS/amt-import.mjs" list-sessions
   node "$SCRIPTS/amt-import.mjs" list-sessions --source claude
   ```
2. Show the user that list and ask which sessions to import. Then import the chosen ids
   (space-separated), or pass `--all` to import every session. Keep `--source` consistent with
   the list the ids came from:
   ```
   node "$SCRIPTS/amt-import.mjs" import-sessions <session_id> [<session_id> ...]
   node "$SCRIPTS/amt-import.mjs" import-sessions --all --source claude
   ```
3. Report how many messages and sessions were imported.

Only use session ids returned by `list-sessions`; never invent one. The same import is also
available as a button in the AMT Memory canvas.
