#!/usr/bin/env node
// amt-import-claude.mjs - Claude Code source for the shared "import memory" engine.
//
// Sibling of amt-import.mjs, which reads GitHub Copilot CLI state. This module reads Claude
// Code state from ~/.claude/projects (STRICTLY read-only) and exposes the same two flavors,
// so the canvas and CLI treat every source identically:
//
//   1. Local sessions -> conversation turns posted to POST /memory with the ORIGINAL
//      timestamps, for AMT's own pipeline to extract, reconcile, and summarize.
//   2. Claude memories -> Claude's already-distilled memory files posted to POST /facts,
//      then a single POST /reconcile to consolidate them against existing memories.
//
// The parsers mirror the reference connector in AzureCosmosDB/AgentMemoryToolkit PR #10
// (connector/claude_code/cli.py) so both sources stay behaviourally identical:
//
//   * Transcripts live at projects/<project-slug>/<session-id>.jsonl, one JSON event per
//     line. Only `user` and `assistant` events with message content are turns. Sidechain
//     (sub-agent) and meta events are skipped, a `user` event whose content is a list is a
//     tool result rather than a typed prompt, and later assistant text in the same turn
//     supersedes earlier partial answers.
//   * Memories live at projects/<project-slug>/memory/*.md with optional YAML front matter,
//     ranked by the order MEMORY.md links to them.
//
// Dependency-free: Node built-ins plus the transport helpers from amt-import.mjs.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, posix } from "node:path";
import { homedir } from "node:os";

import { resolveGatewayBase, getToken, postJson, preview } from "./amt-import.mjs";

// Where Claude Code writes per-project session state. Override for tests or a relocated home.
export const DEFAULT_CLAUDE_ROOT =
  process.env.AMT_CLAUDE_SESSION_ROOT || join(homedir(), ".claude", "projects");

const MEMORY_DIRECTORY_NAME = "memory";
const MEMORY_INDEX_NAME = "MEMORY.md";
const SESSION_SOURCE = "claude-code";
const MEMORY_SOURCE = "claude-code-memory";

const MEMORY_LINK_PATTERN = /\[([^\]]*)\]\(([^)]+)\)/g;
const MEMORY_PATH_PATTERN = /[\w./\\-]+\.md/g;
const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FRONT_MATTER_FIELD_PATTERN = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/;

// --- transcript parsing -----------------------------------------------------------------

function readEvents(file) {
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A partially flushed final line is expected while Claude is still writing.
    }
  }
  return out;
}

// Claude message content is either a plain string or a list of typed blocks; only the text
// blocks carry the prompt or answer.
function textContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && block.type === "text")
    .map((block) => String(block.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Parse one transcript into turns, pairing each typed prompt with its final answer. */
export function readClaudeSession(file, projectSlug) {
  let sessionId = file.split("/").pop().replace(/\.jsonl$/, "");
  let startTime = "";
  let cwd = "";
  let gitBranch = "";
  let model = "";
  let question = null;
  let response = null;
  const turns = [];

  for (const event of readEvents(file)) {
    if (event.isSidechain || event.isMeta) continue;
    const type = event.type;
    const message = event.message;
    if ((type !== "user" && type !== "assistant") || !message || typeof message !== "object") {
      continue;
    }

    sessionId = String(event.sessionId || sessionId);
    cwd = String(event.cwd || cwd);
    gitBranch = String(event.gitBranch || gitBranch);
    const timestamp = String(event.timestamp || "");
    if (timestamp && (!startTime || timestamp < startTime)) startTime = timestamp;

    const content = textContent(message.content);
    if (!content) continue;

    if (type === "user") {
      // A user event carrying a list payload is a tool result, not a typed prompt.
      if (typeof message.content !== "string") continue;
      if (question && response) turns.push({ question, response });
      question = { role: "user", content, created_at: timestamp, event_id: event.uuid || "" };
      response = null;
    } else if (question) {
      model = String(message.model || model);
      // Later assistant text in the same turn supersedes earlier partial answers.
      response = { role: "agent", content, created_at: timestamp, event_id: event.uuid || "" };
    }
  }
  if (question && response) turns.push({ question, response });

  return {
    session_id: sessionId,
    start_time: startTime,
    cwd,
    project_slug: projectSlug,
    git_branch: gitBranch,
    model,
    turns,
  };
}

export function scanClaudeSessions(root = DEFAULT_CLAUDE_ROOT) {
  if (!existsSync(root)) return [];
  const sessions = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const session = readClaudeSession(join(projectDir, entry.name), project.name);
      if (session.turns.length) sessions.push(session);
    }
  }
  sessions.sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)));
  return sessions;
}

// Claude sessions have no title, so the first prompt stands in for one.
function deriveLabel(session) {
  const first = session.turns[0];
  const text = first ? first.question.content : "";
  return preview(text, 72) || session.project_slug || session.session_id;
}

export function listClaudeSessions(root = DEFAULT_CLAUDE_ROOT) {
  return scanClaudeSessions(root).map((session) => {
    const lastTurn = session.turns[session.turns.length - 1];
    return {
      session_id: session.session_id,
      label: deriveLabel(session),
      cwd: session.cwd,
      start_time: session.start_time,
      turn_count: session.turns.length,
      last_user_turn: preview(lastTurn ? lastTurn.question.content : ""),
      last_agent_turn: preview(lastTurn ? lastTurn.response.content : ""),
    };
  });
}

/** Ingest the selected Claude sessions' turns via POST /memory, preserving timestamps. */
export async function importClaudeSessions(
  ids,
  { token, base = resolveGatewayBase(), root = DEFAULT_CLAUDE_ROOT } = {},
) {
  const wanted = new Set(ids);
  const sessions = scanClaudeSessions(root).filter((s) => wanted.has(s.session_id));
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
              project_slug: session.project_slug,
              git_branch: session.git_branch,
              model: session.model,
              cwd: session.cwd,
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

// --- memory files -----------------------------------------------------------------------

/** Map each memory file MEMORY.md links to its order, link label, and note. */
function indexEntries(memoryRoot) {
  const index = join(memoryRoot, MEMORY_INDEX_NAME);
  if (!existsSync(index)) return new Map();
  const entries = new Map();
  for (const line of readFileSync(index, "utf8").split("\n")) {
    let targets = [...line.matchAll(MEMORY_LINK_PATTERN)].map((m) => [m[1], m[2]]);
    let note = line.replace(MEMORY_LINK_PATTERN, "").trim().replace(/^[-*]+/, "").trim();
    if (!targets.length) {
      // Older indexes list bare paths rather than markdown links.
      targets = (line.match(MEMORY_PATH_PATTERN) || []).map((t) => ["", t]);
      note = line.trim().replace(/^[-*]+/, "").trim();
    }
    for (const [label, target] of targets) {
      const key = target.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
      if (!entries.has(key)) entries.set(key, { rank: entries.size + 1, label: label.trim(), note });
    }
  }
  return entries;
}

/** Split a memory file into its flattened YAML front matter and body. */
function frontMatter(text) {
  const match = FRONT_MATTER_PATTERN.exec(text);
  if (!match) return { fields: {}, body: text.trim() };
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = FRONT_MATTER_FIELD_PATTERN.exec(line);
    if (!field) continue;
    let value = field[2].trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (value) fields[field[1]] = value;
  }
  return { fields, body: text.slice(match[0].length).trim() };
}

function walkMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Read one project's persisted memory files, ranked by the order MEMORY.md lists them. */
export function readClaudeMemories(memoryRoot) {
  if (!existsSync(memoryRoot)) return [];
  const projectSlug = memoryRoot.split("/").slice(-2)[0];
  const entries = indexEntries(memoryRoot);
  const memories = [];

  for (const path of walkMarkdown(memoryRoot).sort()) {
    if (path.endsWith(MEMORY_INDEX_NAME)) continue;
    const { fields, body } = frontMatter(readFileSync(path, "utf8"));
    if (!body) continue;

    const rel = relative(memoryRoot, path).split("\\").join("/");
    const entry = entries.get(rel.toLowerCase()) || { rank: null, label: "", note: "" };
    const createdAt = fields.modified || new Date(statSync(path).mtime).toISOString();
    const name = fields.name || posix.basename(rel, ".md");
    const subject = entry.label || name;
    const description = fields.description || "";

    memories.push({
      memory_id: `${projectSlug}:${rel}`,
      session_id: fields.originSessionId || projectSlug,
      created_at: createdAt,
      subject,
      fact: body,
      citation: path,
      reason: description || entry.note,
      scope: fields.type || posix.dirname(rel).replace(".", ""),
      project_slug: projectSlug,
      name,
      rank: entry.rank,
    });
  }
  return memories;
}

export function scanClaudeMemories(root = DEFAULT_CLAUDE_ROOT) {
  if (!existsSync(root)) return [];
  const memories = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    memories.push(...readClaudeMemories(join(root, project.name, MEMORY_DIRECTORY_NAME)));
  }
  return memories;
}

export function listClaudeMemories(root = DEFAULT_CLAUDE_ROOT) {
  return scanClaudeMemories(root).map((m) => ({
    memory_id: m.memory_id,
    subject: m.subject,
    fact: m.fact,
    scope: m.scope,
    created_at: m.created_at,
  }));
}

/**
 * Publish Claude's already-distilled memories into AMT as facts (POST /facts), stamped with
 * provenance and the original timestamp, then run one reconciliation pass so they consolidate
 * against existing memories. Same contract as the Copilot memory import.
 */
export async function importClaudeMemories({
  token,
  base = resolveGatewayBase(),
  root = DEFAULT_CLAUDE_ROOT,
  reconcile = true,
} = {}) {
  const memories = scanClaudeMemories(root);
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
          project_slug: memory.project_slug,
          rank: memory.rank,
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
