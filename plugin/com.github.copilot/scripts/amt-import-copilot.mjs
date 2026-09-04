#!/usr/bin/env node
// amt-import-copilot.mjs - GitHub Copilot CLI source for the "import memory" engine, used by
// BOTH the canvas (in-process) and the terminal CLI (as `node amt-import.mjs <subcommand>`).
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
import { join } from "node:path";
import { homedir } from "node:os";

import { resolveGatewayBase, getToken, postJson, preview } from "./amt-import.mjs";

// Re-exported so the canvas and CLI can keep importing them from the source module.
export { resolveGatewayBase, getToken, preview };


// Where Copilot CLI writes its session state. Override with --root or AMT_COPILOT_SESSION_ROOT
// when the location differs by user or OS.
export const DEFAULT_SESSION_ROOT =
  process.env.AMT_COPILOT_SESSION_ROOT || join(homedir(), ".copilot", "session-state");

// Gateway data plane (ends at /inference/memory). Single source of truth is the plugin's
// mcp.json - the one URL the customer configures - so nothing here is hardcoded per customer;
// AMT_GATEWAY_BASE overrides for tests / local dev. See resolveGatewayBase().
const SESSION_SOURCE = "github-copilot";
const MEMORY_SOURCE = "copilot-cli-memory";

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
  const first = preview(userTurns[0] || "", 72);
  if (first) return first;
  const base = session.cwd ? session.cwd.split("/").filter(Boolean).pop() : "";
  return base || session.session_id;
}

/**
 * List local sessions for the picker: a derived label plus the LAST user turn and the LAST
 * agent answer only. Tool calls, reasoning, and system/transformed prompts are already excluded
 * by the parser, and previews are flattened so the list stays scannable.
 */
export function listSessions(root = DEFAULT_SESSION_ROOT) {
  return scanSessions(root).map((session) => {
    const userTurns = session.turns.map((turn) => turn.question.content);
    const lastTurn = session.turns[session.turns.length - 1];
    return {
      session_id: session.session_id,
      label: deriveLabel(session, userTurns),
      cwd: session.cwd,
      start_time: session.start_time,
      turn_count: session.turns.length,
      last_user_turn: preview(lastTurn ? lastTurn.question.content : ""),
      last_agent_turn: preview(lastTurn ? lastTurn.response.content : ""),
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
