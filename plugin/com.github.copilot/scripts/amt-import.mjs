#!/usr/bin/env node
// amt-import.mjs - the shared "import memory" engine used by BOTH the canvas (in-process)
// and the terminal CLI (as `node amt-import.mjs <subcommand>`).
//
// It reads GitHub Copilot CLI state from ~/.copilot/session-state (STRICTLY read-only - it
// never creates, updates, renames, or deletes anything there) and imports it into AMT
// through the IP gateway, using the same gateway-issued hook token the plugin's hooks use
// (Authorization: HookToken <access>, minted by amt-token.sh). Two flavors:
//
//   1. Local sessions  -> conversation turns posted to POST /memory (with the ORIGINAL
//      timestamps). AMT's pipeline then extracts / reconciles / summarizes them like any
//      other turns. No extra pass needed.
//   2. Copilot memories -> Copilot's already-distilled facts posted to POST /facts
//      (pre-distilled publish, stamped with provenance), then a single POST /reconcile to
//      consolidate them against existing memories.
//
// The parser faithfully mirrors the reference connector in AzureCosmosDB/AgentMemoryToolkit
// PR #10 (connector/github_copilot/cli.py): keep only original `user.message` content and
// `assistant.message` events with phase `final_answer`; read explicit memories only from
// successful `storeMemory` tool completions. Dependency-free: Node built-ins + global fetch.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Where Copilot CLI writes its session state. Override with --root or AMT_COPILOT_SESSION_ROOT
// when the location differs by user or OS.
export const DEFAULT_SESSION_ROOT =
  process.env.AMT_COPILOT_SESSION_ROOT || join(homedir(), ".copilot", "session-state");

// Gateway data plane (ends at /inference/memory). Single source of truth is the plugin's
// .mcp.json - the one URL the customer configures - so nothing here is hardcoded per customer;
// AMT_GATEWAY_BASE overrides for tests / local dev. See resolveGatewayBase().
const SESSION_SOURCE = "github-copilot";
const MEMORY_SOURCE = "copilot-cli-memory";
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Resolve the gateway data-plane base (…/inference/memory). Order: AMT_GATEWAY_BASE override,
 * then the plugin's .mcp.json (amt-memory server url with the trailing /mcp[/] stripped). This
 * keeps the gateway customer-configurable in exactly one place and never hardcoded here.
 */
export function resolveGatewayBase() {
  if (process.env.AMT_GATEWAY_BASE) return process.env.AMT_GATEWAY_BASE.replace(/\/+$/, "");
  try {
    const mcp = JSON.parse(readFileSync(join(SCRIPT_DIR, "..", "..", ".mcp.json"), "utf8"));
    const url = mcp && mcp.mcpServers && mcp.mcpServers["amt-memory"] && mcp.mcpServers["amt-memory"].url;
    if (url) return String(url).replace(/\/mcp\/?$/i, "").replace(/\/+$/, "");
  } catch {
    /* fall through to the actionable error */
  }
  throw new Error("AMT gateway not configured: set AMT_GATEWAY_BASE or the amt-memory url in .mcp.json.");
}

// --- read-only JSONL parsing ------------------------------------------------------------

function readEvents(file) {
  // Yield JSON objects from a session file without modifying it. Bad lines are skipped so a
  // single truncated tail line can't abort an import (the reference connector raises; a GUI
  // import is better off best-effort).
  const events = [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return events;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event === "object") events.push(event);
    } catch {
      /* skip malformed line */
    }
  }
  return events;
}

function citationContent(citation) {
  // Extract user text from a Copilot memory citation when no source event matches.
  const prefix = "User input:";
  let content = citation.startsWith(prefix) ? citation.slice(prefix.length).trim() : citation.trim();
  if (content.startsWith('"') && content.endsWith('"')) {
    try {
      const decoded = JSON.parse(content);
      if (typeof decoded === "string") return decoded;
    } catch {
      /* fall through */
    }
  }
  return content;
}

// --- sessions ---------------------------------------------------------------------------

function readSession(file, folderName) {
  // Parse original user prompts paired only with FINAL assistant answers. Transformed
  // prompts, reasoning, tool calls, and non-final assistant events are intentionally ignored.
  let sessionId = folderName;
  let startTime = "";
  let cwd = "";
  const questions = new Map();
  const turns = [];

  for (const event of readEvents(file)) {
    const data = event.data;
    if (!data || typeof data !== "object") continue;

    if (event.type === "session.start") {
      sessionId = String(data.sessionId || sessionId);
      startTime = String(data.startTime || event.timestamp || "");
      const context = data.context;
      if (context && typeof context === "object") cwd = String(context.cwd || "");
    } else if (event.type === "user.message") {
      const interactionId = data.interactionId;
      const content = data.content;
      if (typeof interactionId === "string" && typeof content === "string") {
        questions.set(interactionId, {
          role: "user",
          content,
          created_at: String(event.timestamp || ""),
          event_id: String(event.id || ""),
          interaction_id: interactionId,
          parent_agent_task_id: data.parentAgentTaskId ?? null,
        });
      }
    } else if (event.type === "assistant.message" && data.phase === "final_answer") {
      const interactionId = data.interactionId;
      const content = data.content;
      const question = typeof interactionId === "string" ? questions.get(interactionId) : null;
      if (question && typeof content === "string") {
        turns.push({
          question,
          response: {
            role: "agent",
            content,
            created_at: String(event.timestamp || ""),
            event_id: String(event.id || ""),
            interaction_id: interactionId,
            parent_agent_task_id: data.parentAgentTaskId ?? null,
          },
        });
      }
    }
  }

  return { session_id: sessionId, start_time: startTime, cwd, turns };
}

function scanSessions(root) {
  // Read non-empty session folders (each holds an events.jsonl) newest first.
  if (!existsSync(root)) return [];
  const sessions = [];
  for (const folder of readdirSync(root)) {
    const file = join(root, folder, "events.jsonl");
    if (!existsSync(file)) continue;
    const session = readSession(file, folder);
    if (session.turns.length) sessions.push(session);
  }
  sessions.sort((a, b) => (a.start_time < b.start_time ? 1 : a.start_time > b.start_time ? -1 : 0));
  return sessions;
}

function deriveLabel(session, userTurns) {
  // Copilot session state carries no title, so derive a human label: the first user prompt
  // (the best "what was this about"), falling back to the working directory or the id.
  const first = (userTurns[0] || "").replace(/\s+/g, " ").trim();
  if (first) return first.length > 72 ? `${first.slice(0, 69)}...` : first;
  const base = session.cwd ? session.cwd.split("/").filter(Boolean).pop() : "";
  return base || session.session_id;
}

/** List local sessions with a derived label and the last two user turns (for the picker). */
export function listSessions(root = DEFAULT_SESSION_ROOT) {
  return scanSessions(root).map((session) => {
    const userTurns = session.turns.map((turn) => turn.question.content);
    return {
      session_id: session.session_id,
      label: deriveLabel(session, userTurns),
      cwd: session.cwd,
      start_time: session.start_time,
      turn_count: session.turns.length,
      last_user_turns: userTurns.slice(-2).map((t) => t.replace(/\s+/g, " ").trim()),
    };
  });
}

/** Ingest the selected sessions' turns into AMT via POST /memory, preserving timestamps. */
export async function importSessions(ids, { token, base = resolveGatewayBase(), root = DEFAULT_SESSION_ROOT } = {}) {
  const wanted = new Set(ids);
  const sessions = scanSessions(root).filter((session) => wanted.has(session.session_id));
  const authToken = token || getToken();
  let messages = 0;
  for (const session of sessions) {
    for (const turn of session.turns) {
      for (const message of [turn.question, turn.response]) {
        await postJson(
          `${base}/memory`,
          {
            thread_id: session.session_id,
            role: message.role,
            content: message.content,
            created_at: message.created_at || undefined,
            metadata: {
              source: SESSION_SOURCE,
              event_id: message.event_id,
              interaction_id: message.interaction_id,
              parent_agent_task_id: message.parent_agent_task_id,
            },
          },
          authToken,
        );
        messages += 1;
      }
    }
  }
  return { sessions: sessions.length, messages };
}

// --- explicit Copilot memories ----------------------------------------------------------

function readMemories(events, sessionId) {
  // Extract successful `storeMemory` completions and their cited user inputs.
  const users = new Map();
  for (const event of events) {
    if (
      event.type === "user.message" &&
      event.data &&
      typeof event.data === "object" &&
      typeof event.data.interactionId === "string"
    ) {
      users.set(event.data.interactionId, event);
    }
  }

  const memories = [];
  for (const event of events) {
    const data = event.data;
    if (event.type !== "tool.execution_complete" || !data || typeof data !== "object") continue;
    const telemetry = data.toolTelemetry;
    if (!data.success || !telemetry || typeof telemetry !== "object") continue;
    const properties = telemetry.properties;
    const restricted = telemetry.restrictedProperties;
    if (!properties || typeof properties !== "object" || properties.operation !== "storeMemory") continue;
    if (!restricted || typeof restricted !== "object") continue;

    const memoryId = String(event.id || "");
    const interactionId = String(data.interactionId || "");
    const fact = restricted.memoryFact;
    const citation = restricted.memoryCitations;
    if (!memoryId || typeof fact !== "string" || typeof citation !== "string") continue;

    const userEvent = users.get(interactionId);
    const userContent =
      userEvent && userEvent.data && typeof userEvent.data === "object" ? userEvent.data.content : null;

    memories.push({
      memory_id: memoryId,
      session_id: sessionId,
      created_at: String(event.timestamp || ""),
      subject: String(restricted.memorySubject || ""),
      citation,
      reason: String(restricted.memoryReason || ""),
      scope: String(properties.scope || ""),
      model: String(data.model || ""),
      agent: String(properties.agent || ""),
      fact,
      cited_input: typeof userContent === "string" ? userContent : citationContent(citation),
    });
  }
  return memories;
}

function scanMemories(root = DEFAULT_SESSION_ROOT) {
  if (!existsSync(root)) return [];
  const all = [];
  for (const folder of readdirSync(root)) {
    const file = join(root, folder, "events.jsonl");
    if (!existsSync(file)) continue;
    all.push(...readMemories(readEvents(file), folder));
  }
  // A memory can be snapshotted across sessions; keep one row per completion event id.
  const seen = new Set();
  const unique = [];
  for (const memory of all) {
    if (seen.has(memory.memory_id)) continue;
    seen.add(memory.memory_id);
    unique.push(memory);
  }
  unique.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return unique;
}

/** List the explicit Copilot memories available for import. */
export function listMemories(root = DEFAULT_SESSION_ROOT) {
  return scanMemories(root).map((memory) => ({
    memory_id: memory.memory_id,
    subject: memory.subject,
    fact: memory.fact,
    scope: memory.scope,
    created_at: memory.created_at,
  }));
}

/**
 * Publish Copilot's already-distilled memories into AMT as facts (POST /facts), stamping
 * provenance and the original timestamp, then run a single reconciliation pass so they are
 * consolidated against existing memories.
 */
export async function importMemories({ token, base = resolveGatewayBase(), root = DEFAULT_SESSION_ROOT, reconcile = true } = {}) {
  const memories = scanMemories(root);
  const authToken = token || getToken();
  let published = 0;
  for (const memory of memories) {
    await postJson(
      `${base}/facts`,
      {
        content: memory.fact,
        memory_type: "fact",
        provenance: {
          application: SESSION_SOURCE,
          source: MEMORY_SOURCE,
          source_ids: [memory.memory_id],
        },
        created_at: memory.created_at || undefined,
        metadata: {
          subject: memory.subject,
          citation: memory.citation,
          reason: memory.reason,
          scope: memory.scope,
          model: memory.model,
          agent: memory.agent,
          cited_input: memory.cited_input,
          origin_session_id: memory.session_id,
        },
      },
      authToken,
    );
    published += 1;
  }
  let reconciled = null;
  if (reconcile && published > 0) {
    reconciled = await postJson(`${base}/reconcile`, {}, authToken);
  }
  return { memories: published, reconciled };
}

// --- auth + transport -------------------------------------------------------------------

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

async function postJson(url, body, token) {
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

function rootFromArgs(argv) {
  const i = argv.indexOf("--root");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : DEFAULT_SESSION_ROOT;
}

async function runCli(argv) {
  const command = argv[0];
  const json = argv.includes("--json");
  const root = rootFromArgs(argv);

  if (command === "list-sessions") {
    const sessions = listSessions(root);
    if (json) {
      process.stdout.write(JSON.stringify(sessions));
      return 0;
    }
    if (!sessions.length) {
      console.log("No local Copilot sessions found.");
      return 0;
    }
    for (const session of sessions) {
      console.log(`- ${session.session_id}  (${session.turn_count} turns)  ${session.label}`);
      for (const turn of session.last_user_turns) {
        console.log(`    > ${turn.length > 100 ? `${turn.slice(0, 97)}...` : turn}`);
      }
    }
    return 0;
  }

  if (command === "import-sessions") {
    const all = argv.includes("--all");
    const ids = argv.slice(1).filter((arg) => !arg.startsWith("--") && arg !== root);
    const targets = all ? listSessions(root).map((session) => session.session_id) : ids;
    if (!targets.length) {
      console.error("No sessions selected. Pass session ids or --all.");
      return 1;
    }
    const result = await importSessions(targets, { token: getToken(), root });
    console.log(`Imported ${result.messages} messages from ${result.sessions} session(s). AMT will extract and reconcile them.`);
    return 0;
  }

  if (command === "list-memories") {
    const memories = listMemories(root);
    if (json) {
      process.stdout.write(JSON.stringify(memories));
      return 0;
    }
    if (!memories.length) {
      console.log("No explicit Copilot memories found.");
      return 0;
    }
    for (const memory of memories) {
      console.log(`- [${memory.subject || "memory"}] ${memory.fact}`);
    }
    return 0;
  }

  if (command === "import-memories") {
    const result = await importMemories({ token: getToken(), root });
    console.log(`Published ${result.memories} Copilot memories and reconciled.`);
    return 0;
  }

  console.error("Usage: amt-import.mjs <list-sessions|import-sessions|list-memories|import-memories> [--all] [--json] [--root <dir>] [ids...]");
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
