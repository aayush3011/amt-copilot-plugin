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
- **When a durable decision, preference, or convention emerges** in the conversation,
  persist it with `add_memory` so future sessions inherit it.
- **Never ask the user for their identity, tenant, or scope.** The server resolves all of
  that from the trusted context; no tool takes an identity argument.
- Use a stable `thread_id` of the form `chat-<short-uuid>` for the whole conversation, and
  a fresh one only in a new chat.
