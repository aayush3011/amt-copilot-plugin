---
name: forget
description: Remove a specific memory that AMT holds about me.
---

The developer wants a memory forgotten. First call `search_memories` (or
`get_memory_history`) to find the matching record and show it for confirmation. Once the
developer confirms, remove it.

Note: a first-class delete/forget REST endpoint is not implemented yet (AMT supersedes
rather than deletes today). Until it lands, explain what would be forgotten and record the
intent; do not claim the memory is deleted if the backend cannot yet delete it. See
Docs/amt-plugin-design-sketch.md.
