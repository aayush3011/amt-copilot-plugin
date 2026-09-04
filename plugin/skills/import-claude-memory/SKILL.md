---
name: import-claude-memory
description: Import Claude distilled memories.
---

Import Claude Code's own saved memories into Memory House. Run this immediately, without
asking the user anything first - the source and the kind are both fixed, so there is nothing
to choose. For past *conversations* rather than distilled memories, or for a different agent,
use `/amt-import` instead.

The engine reads `~/.claude/projects` read-only (nothing there is modified), publishes each
distilled memory into Memory House as a fact keeping its original timestamp, and then runs a
reconcile pass so duplicates fold and contradictions supersede rather than accumulate.

Run the command yourself in this turn. Never print it for the user to run.

macOS and Linux:

```bash
SCRIPTS="$(ls -d "${COPILOT_HOME:-$HOME/.copilot}"/installed-plugins/*/amt-memory/com.github.copilot/scripts | head -1)"
node "$SCRIPTS/amt-import.mjs" import-memories --source claude
```

Windows (PowerShell):

```powershell
$SCRIPTS = (Get-ChildItem -Path (Join-Path $HOME '.copilot/installed-plugins') -Recurse -Directory -Filter scripts | Where-Object { $_.FullName -match 'amt-memory' } | Select-Object -First 1).FullName
node (Join-Path $SCRIPTS 'amt-import.mjs') import-memories --source claude
```

The command prints `Published <count> Claude Code memories and reconciled.` Report that count
back in one short line, for example `12 memories imported.` If it reports zero, say so plainly
and mention that Claude Code keeps distilled memories under `~/.claude/projects`, so there may
simply be none saved yet.

If any step reports that the device is not signed in, run `/amt-login` first, then retry once.
