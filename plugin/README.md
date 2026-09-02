# AMT Memory - Agent Plugin (POC)

Packages the deployed AMT memory service as an Agent Plugin 1.0 for the GitHub Copilot app
(also VS Code and the CLI). It bundles:

- **MCP server** (`mcp.json`) - the `amt-memory` server with its 12 tools, via the IP
  gateway (OAuth sign-in handled by the client, no token in the file).
- **Skills** (`skills/use-memory/`, `skills/amt-login/`) - teach the agent to use memory and
  provide the `/amt-login` workflow.
- **Hooks** (`hooks/hooks.json`) - deterministic recall and capture that MCP alone
  cannot do:
  - `userPromptSubmitted` -> `inject.sh` captures the sanitized user turn.
  - `userPromptTransformed` -> `inject.sh` retrieves memories and adds them to the
    model-facing prompt.
  - `postToolUse` on `enroll_hook_capture` -> redeems the credential locally and replaces
    the tool result so the credential cannot appear in the agent response.
  - `agentStop` -> `capture.sh` appends the turn to AMT.
- **Commands** (`com.github.copilot/commands/`) - `/memory-show`, `/forget`.
- **Canvas** (`com.github.copilot/extensions/memory-canvas/`) - a "Memory" panel that
  shows what AMT remembers about you, grouped by Personal / Team / Org, with refresh /
  forget / promote actions. See its own README.

The backend (gateway + managed service + core + durable pipeline + Cosmos) is unchanged;
this is purely a client-surface package.

## Layout

```text
plugin/
├── plugin.json
├── mcp.json
├── hooks/hooks.json
├── skills/{use-memory,amt-login}/SKILL.md
└── com.github.copilot/
    ├── scripts/{inject,capture,complete-login,amt-token}.sh
    ├── commands/{memory-show,forget}.md
    └── extensions/memory-canvas/{package.json,extension.mjs,README.md}
```

## Prerequisites

- `jq` and `curl` on PATH (used by the macOS/Linux hook scripts).
- Run `/amt-login` once after connecting the MCP server so the hooks have a gateway-issued
  access/refresh token.
- The scripts are executable: `chmod +x com.github.copilot/scripts/*.sh`.

## What is demo-grade vs. real

- **Auth (`amt-token.sh`)**: reads and silently refreshes the hook token enrolled by
  `/amt-login`; it does not depend on an interactive Azure CLI session.
- **Login completion**: `/amt-login` only calls `enroll_hook_capture`; `complete-login.sh`
  performs redemption deterministically in `postToolUse`. It does not depend on the model
  remembering a second step or on opening the canvas first.
- **Hook lifecycle**: `userPromptSubmitted` performs capture as a side effect and returns `{}`;
  current config-file hooks discard its output. Recall runs in `userPromptTransformed` and
  returns `modifiedTransformedPrompt`, as defined by the
  [Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference).
- **Diagnostics**: hook invocations and non-sensitive outcomes are appended to
  `~/.copilot/amt/hook.log`; prompts, memories, and tokens are never logged there.
- **Windows**: PowerShell hook entries and `.ps1` twins are included.
- **`/forget`**: no delete endpoint exists yet (AMT supersedes, not deletes).

## Quick local check (no Copilot needed)

Verify the scripts talk to AMT with your identity:

```bash
# user capture phase
echo '{"sessionId":"plugin-smoke","prompt":"test user turn from the plugin"}' \
  | AMT_HOOK_PHASE=capture ./com.github.copilot/scripts/inject.sh

# recall phase: what would be sent to the model
echo '{"sessionId":"plugin-smoke","prompt":"what did we decide about signing x-amt-context?","transformedPrompt":"what did we decide about signing x-amt-context?"}' \
  | AMT_HOOK_PHASE=recall ./com.github.copilot/scripts/inject.sh

# capture path: append the last agent message from a Copilot-style transcript
printf '%s\n' '{"type":"assistant.message","data":{"content":"test turn from the plugin"}}' \
  > /tmp/amt-plugin-smoke.jsonl
echo '{"sessionId":"plugin-smoke","transcriptPath":"/tmp/amt-plugin-smoke.jsonl"}' \
  | ./com.github.copilot/scripts/capture.sh
rm /tmp/amt-plugin-smoke.jsonl
```

## Install (GitHub Copilot app / CLI / VS Code)

MCP-only path works today with just `mcp.json` (add the server URL in the app's Customize
tab; sign in when prompted). Full plugin install (with hooks + commands) follows the Agent
Plugins install flow for your client; point it at this `plugin/` directory. Hooks run
locally, so `jq` and `curl` must be available in the shell the client uses.

See `Docs/amt-plugin-design-sketch.md` for the full design, the canvas ("see my memories")
surface, and the effort breakdown.
