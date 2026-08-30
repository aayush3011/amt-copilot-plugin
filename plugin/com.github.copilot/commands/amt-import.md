---
name: amt-import
description: Import your GitHub Copilot CLI history into AMT memory - either Copilot's own saved memories, or turns from past sessions.
---

Import existing GitHub Copilot CLI memory into AMT. There are two sources - ask the user
which they want (or use the one they named):

- **Copilot memory** - the facts Copilot already distilled and saved. These are published
  straight into AMT as facts and then reconciled against your existing memories.
- **Local sessions** - past Copilot CLI conversations. Their turns are imported and AMT
  distills them (extract / reconcile / summarize) automatically, like any live turns.

Everything is read-only against `~/.copilot/session-state` (nothing there is modified) and
each item keeps its original timestamp. Auth uses the plugin's hook token; if any step
reports "not signed in", run `/amt-login` first, then retry.

First locate the plugin's scripts dir:

- macOS / Linux:
  ```
  SCRIPTS="$(find "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins" -type d -path '*amt-memory/com.github.copilot/scripts' 2>/dev/null | head -1)"
  ```
- Windows (PowerShell):
  ```
  $Scripts = (Get-ChildItem -Recurse -Directory "$env:COPILOT_HOME","$HOME/.copilot" -Filter scripts -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'amt-memory' } | Select-Object -First 1).FullName
  ```

### Copilot memory
Run the engine and report how many memories were imported:
```
node "$SCRIPTS/amt-import.mjs" import-memories
```

### Local sessions
1. List the available sessions (each line shows an id, a derived label, and the last two
   user turns):
   ```
   node "$SCRIPTS/amt-import.mjs" list-sessions
   ```
2. Show the user that list and ask which sessions to import. Then import the chosen ids
   (space-separated), or pass `--all` to import every session:
   ```
   node "$SCRIPTS/amt-import.mjs" import-sessions <session_id> [<session_id> ...]
   node "$SCRIPTS/amt-import.mjs" import-sessions --all
   ```
3. Report how many messages and sessions were imported.

Only use session ids returned by `list-sessions`; never invent one. The same import is also
available as a button in the AMT Memory canvas.
