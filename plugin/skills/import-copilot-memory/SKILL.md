---
name: import-copilot-memory
description: Import the memories GitHub Copilot already distilled into Memory House, then reconcile them against what is already stored.
---

Import GitHub Copilot's own saved memories into Memory House. Run this immediately, without
asking the user anything first - the source and the kind are both fixed, so there is nothing
to choose. For past *conversations* rather than distilled memories, or for a different agent,
use `/amt-import` instead.

The engine reads Copilot's saved memories read-only (nothing there is modified), publishes each
one into Memory House as a fact keeping its original timestamp, and then runs a reconcile pass
so duplicates fold and contradictions supersede rather than accumulate.

Run the command yourself in this turn. Never print it for the user to run.

macOS and Linux:

```bash
SCRIPTS="$(ls -d "${COPILOT_HOME:-$HOME/.copilot}"/installed-plugins/*/amt-memory/com.github.copilot/scripts | head -1)"
node "$SCRIPTS/amt-import.mjs" import-memories
```

Windows (PowerShell):

```powershell
$SCRIPTS = (Get-ChildItem -Path (Join-Path $HOME '.copilot/installed-plugins') -Recurse -Directory -Filter scripts | Where-Object { $_.FullName -match 'amt-memory' } | Select-Object -First 1).FullName
node (Join-Path $SCRIPTS 'amt-import.mjs') import-memories
```

The command prints `Published <count> GitHub Copilot memories and reconciled.` Report that
count back in one short line, for example `12 memories imported.` If it reports zero, say so
plainly rather than treating it as a failure - it just means Copilot has no distilled memories
saved on this device yet.

If any step reports that the device is not signed in, run `/amt-login` first, then retry once.
