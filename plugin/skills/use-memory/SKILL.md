---
name: use-memory
description: Consult and update the developer's persistent AMT memory during real work.
---

This repository is connected to the `amt-memory` MCP server (Agent Memory Toolkit). It is
the single source of truth for durable, cross-session memory about this developer and their
conventions.

Use it like this:

- **Before starting a task**, call `search_memories` to load this developer's prior
  decisions, conventions, and context for the work at hand. Treat what comes back as
  established fact for this developer, not as suggestions to re-litigate.
- **Do NOT decide what is worth remembering.** Every conversation turn is captured to AMT
  automatically (by the plugin's hooks), and AMT's own extraction pipeline decides what
  becomes a durable memory. You are not the gatekeeper for capture, so do not call
  `add_memory` just because something seems important - that would double-record and put
  the memory decision in the wrong place.
- **Only call `add_memory` when the user explicitly asks you to remember something**
  (e.g. "remember that ..."), as a direct, one-off write. Routine capture is the hooks' job.
- **Never ask the user for their identity, tenant, or scope.** The server resolves all of
  that from the trusted context; no tool takes an identity argument.
