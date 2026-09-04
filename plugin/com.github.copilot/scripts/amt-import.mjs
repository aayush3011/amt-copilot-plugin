#!/usr/bin/env node
// amt-import.mjs - the shared "import memory" engine and CLI dispatcher.
//
// This file owns everything that is the same for every source: gateway resolution, auth,
// transport, preview formatting, and the terminal CLI. Each agent's own reader lives beside
// it and imports these helpers:
//
//   amt-import-copilot.mjs   GitHub Copilot CLI  (~/.copilot/session-state)
//   amt-import-claude.mjs    Claude Code         (~/.claude/projects)
//
// Both sources offer the same two flavors:
//
//   1. Local sessions -> conversation turns posted to POST /memory with the ORIGINAL
//      timestamps, for AMT's pipeline to extract, reconcile, and summarize.
//   2. Saved memories -> the agent's already-distilled facts posted to POST /facts, then a
//      single POST /reconcile to consolidate them against existing memories.
//
// This mirrors the reference connector in AzureCosmosDB/AgentMemoryToolkit PR #10, where
// main.py maps `--source` onto per-source modules over one shared client.
//
// The source modules are loaded with dynamic import inside runCli, not at the top of the
// file. They import these helpers from here, so a static import would make the two files
// circular; deferring it to call time keeps module evaluation acyclic.
//
//   node amt-import.mjs list-sessions [--source claude]
//   node amt-import.mjs import-sessions --all [--source claude]
//   node amt-import.mjs list-memories [--source claude]
//   node amt-import.mjs import-memories [--source claude]
//
// Dependency-free: Node built-ins plus global fetch.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REQUEST_TIMEOUT_MS = 90_000;

// --- shared helpers ---------------------------------------------------------------------

/**
 * Resolve the gateway data-plane base (…/inference/memory). Order: AMT_GATEWAY_BASE override,
 * then the plugin's mcp.json (amt-memory server url with the trailing /mcp[/] stripped). This
 * keeps the gateway customer-configurable in exactly one place and never hardcoded here.
 */
export function resolveGatewayBase() {
  if (process.env.AMT_GATEWAY_BASE) return process.env.AMT_GATEWAY_BASE.replace(/\/+$/, "");
  try {
    const mcp = JSON.parse(readFileSync(join(SCRIPT_DIR, "..", "..", "mcp.json"), "utf8"));
    const url = mcp && mcp.mcpServers && mcp.mcpServers["amt-memory"] && mcp.mcpServers["amt-memory"].url;
    if (url) return String(url).replace(/\/mcp\/?$/i, "").replace(/\/+$/, "");
  } catch {
    /* fall through to the actionable error */
  }
  throw new Error("AMT gateway not configured: set AMT_GATEWAY_BASE or the amt-memory url in mcp.json.");
}

// Flatten a turn into a short, single-line preview for the picker. Strips fenced code blocks,
// markdown emphasis/headings, and collapses whitespace, so the list stays readable instead of
// dumping raw prompt or answer text into the UI.
export function preview(text, max = 130) {
  const flat = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/[*_>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}


/** Return a valid AMT hook access token, reusing the plugin's token authority (amt-token.sh). */
export function getToken() {
  if (process.env.AMT_ACCESS_TOKEN) return process.env.AMT_ACCESS_TOKEN.trim();
  const isWindows = platform() === "win32";
  try {
    const out = isWindows
      ? execFileSync(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(SCRIPT_DIR, "amt-token.ps1")],
          { encoding: "utf8", timeout: 30_000 },
        )
      : execFileSync("bash", [join(SCRIPT_DIR, "amt-token.sh")], { encoding: "utf8", timeout: 30_000 });
    const token = (out || "").trim();
    if (token) return token;
  } catch {
    /* fall through to the actionable error */
  }
  throw new Error("Not signed in to AMT. Run /amt-login first, then retry the import.");
}

export async function postJson(url, body, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `HookToken ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`POST ${url} -> ${response.status}: ${detail.slice(0, 300)}`);
    }
    if (response.status === 204) return {};
    return await response.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}


// --- terminal CLI -----------------------------------------------------------------------

// Source modules are described by name only; runCli imports the chosen one at call time so
// this file and the source files are not circular.
const SOURCES = {
  copilot: { label: "GitHub Copilot", module: "./amt-import-copilot.mjs", prefix: "" },
  claude: { label: "Claude Code", module: "./amt-import-claude.mjs", prefix: "Claude" },
};
const DEFAULT_SOURCE = "copilot";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}

// Each source exports the same four operations, Claude's under a Claude* prefix so both can
// be imported side by side without colliding.
async function loadSource(argv) {
  const name = argValue(argv, "--source") || DEFAULT_SOURCE;
  const spec = SOURCES[name];
  if (!spec) {
    throw new Error(`Unknown --source ${name}. Expected one of: ${Object.keys(SOURCES).sort().join(", ")}.`);
  }
  const mod = await import(spec.module);
  const p = spec.prefix;
  return {
    label: spec.label,
    defaultRoot: p ? mod.DEFAULT_CLAUDE_ROOT : mod.DEFAULT_SESSION_ROOT,
    listSessions: p ? mod.listClaudeSessions : mod.listSessions,
    importSessions: p ? mod.importClaudeSessions : mod.importSessions,
    listMemories: p ? mod.listClaudeMemories : mod.listMemories,
    importMemories: p ? mod.importClaudeMemories : mod.importMemories,
  };
}

async function runCli(argv) {
  const command = argv[0];
  const json = argv.includes("--json");
  const source = await loadSource(argv);
  const root = argValue(argv, "--root") || source.defaultRoot;

  if (command === "list-sessions") {
    const sessions = source.listSessions(root);
    if (json) {
      process.stdout.write(JSON.stringify(sessions));
      return 0;
    }
    if (!sessions.length) {
      console.log(`No local ${source.label} sessions found.`);
      return 0;
    }
    for (const session of sessions) {
      console.log(`- ${session.session_id}  (${session.turn_count} turns)  ${session.label}`);
      if (session.last_user_turn) console.log(`    you:   ${session.last_user_turn}`);
      if (session.last_agent_turn) console.log(`    agent: ${session.last_agent_turn}`);
    }
    return 0;
  }

  if (command === "import-sessions") {
    const skip = new Set([argValue(argv, "--root"), argValue(argv, "--source")].filter(Boolean));
    const ids = argv.includes("--all")
      ? source.listSessions(root).map((session) => session.session_id)
      : argv.slice(1).filter((value) => !value.startsWith("--") && !skip.has(value));
    if (!ids.length) {
      console.error("Nothing to import: pass session ids or --all.");
      return 1;
    }
    const result = await source.importSessions(ids, { root });
    console.log(
      `Imported ${result.messages} messages from ${result.sessions} session(s). AMT will extract and reconcile them.`,
    );
    return 0;
  }

  if (command === "list-memories") {
    const memories = source.listMemories(root);
    if (json) {
      process.stdout.write(JSON.stringify(memories));
      return 0;
    }
    if (!memories.length) {
      console.log(`No explicit ${source.label} memories found.`);
      return 0;
    }
    for (const memory of memories) {
      console.log(`- [${memory.subject || "memory"}] ${memory.fact}`);
    }
    return 0;
  }

  if (command === "import-memories") {
    const result = await source.importMemories({ root });
    console.log(`Published ${result.memories} ${source.label} memories and reconciled.`);
    return 0;
  }

  console.error(
    "Usage: amt-import.mjs <list-sessions|import-sessions|list-memories|import-memories> " +
      "[--source copilot|claude] [--all] [--json] [--root <dir>] [ids...]",
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code || 0))
    .catch((error) => {
      console.error(String((error && error.message) || error));
      process.exit(1);
    });
}
