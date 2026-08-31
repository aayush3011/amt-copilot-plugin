---
name: memory-show
description: Open the live AMT Memory canvas, with an MCP-backed text fallback.
---

Open the live AMT Memory canvas.

1. Call `list_canvas_capabilities` with `canvasId` set to `amt-memory`.
2. If that canvas is available, call `open_canvas` with `canvasId` set to `amt-memory` and
   `instanceId` set to `amt-memory-main`. Supply `input` only when its schema requires it.
3. Confirm in one sentence that the AMT Memory canvas is open.

If `amt-memory` is unavailable, do not open the generic `editor` canvas. Instead, call the
exact MCP tools `amt-memory-whoami`, `amt-memory-get_memories`, and
`amt-memory-search_memories`. Search for `team and organization knowledge, standards, and
decisions`, group returned records by `scope_key` into Personal, Team, and Org, and show a
concise text fallback. Do not invent memories or return an empty response.
