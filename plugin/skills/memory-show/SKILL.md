---
name: memory-show
description: Open the live Memory House canvas, with an MCP-backed text fallback.
---

Open the live Memory House canvas.

1. Call `list_canvas_capabilities` with `canvasId` set to `memory-house`.
2. If that canvas is available, call `open_canvas` with `canvasId` set to `memory-house` and
   `instanceId` set to `memory-house-main`. Supply `input` only when its schema requires it.
3. Confirm in one sentence that the Memory House canvas is open.

If `memory-house` is unavailable, do not open the generic `editor` canvas. Instead, call the
exact MCP tools `amt-memory-whoami`, `amt-memory-get_memories`, and
`amt-memory-search_memories`. Search for `team and organization knowledge, standards, and
decisions`, group returned records by `scope_key` into Personal, Team, and Org, and show a
concise text fallback. Do not invent memories or return an empty response.

The MCP tools keep the `amt-memory-` prefix because that is the MCP server name; only the
canvas is named `memory-house`.
