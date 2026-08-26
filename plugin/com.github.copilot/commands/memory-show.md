---
name: memory-show
description: Show what AMT remembers about me, grouped by scope.
---

Summarize what AMT currently remembers about this developer. Call `get_memories` for recent
personal memories, and `search_memories` for team and org context, then present the result
grouped into three sections: Personal, Team, and Org. Keep it concise - one bullet per
memory. Do not invent memories; only show what the tools return.

(Future: this command opens an interactive memory canvas. See
Docs/amt-plugin-design-sketch.md, section 8.)
