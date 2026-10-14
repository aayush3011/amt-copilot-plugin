// Import engine for the Memory House canvas: reads local GitHub Copilot and Claude Code history
// (strictly read-only) and sends it to Memory House through the plugin's gateway sign-in.
//
//   Sessions -> POST /memory {extract: true, thread_id, items: [{role, content, source}]}, so the
//               AMT pipeline extracts, consolidates and summarizes them like captured turns.
//   Memories -> POST /memory {extract: false, items: [{content, source}]} (direct facts), then
//               one POST /reconcile to consolidate them against existing memories.
//
// The parsers follow the 0.8.1 canvas engine. Session files can be hundreds of megabytes, so
// they are streamed, only the event types in use are parsed, and the picker offers the newest
// sessions. Text gets the same credential and runtime-context filtering as live capture. AMT
// accepts no client timestamps or metadata, so imported turns carry only role, content and source.
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, posix, relative, sep } from 'node:path';
import { sanitizeMessage } from '../hooks.mjs';
import { MemoryHouseError, safeError } from '../errors.mjs';

export const IMPORT_LIMITS = Object.freeze({
  sessions: 100, // newest sessions offered by the picker
  selected: 200, // sessions accepted by one import request
  batchItems: 50, // AMT POST /memory accepts 1 to 50 items
  factBatchItems: 10, // direct facts are embedded while the request waits
  batchBytes: 240 * 1024, // below AMT's 256 KiB insertion limit
  factBytes: 16 * 1024,
  previewBytes: 2048,
  timeoutMs: 120_000,
});

const SOURCES = Object.freeze({
  copilot: Object.freeze({ label: 'GitHub Copilot', session: 'github-copilot', memory: 'copilot-cli-memory' }),
  claude: Object.freeze({ label: 'Claude Code', session: 'claude-code', memory: 'claude-code-memory' }),
});
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COPILOT_SESSION_EVENT = /"type"\s*:\s*"(?:session\.start|user\.message|assistant\.message)"/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function importSource(value) {
  if (typeof value !== 'string' || !Object.hasOwn(SOURCES, value)) {
    throw new MemoryHouseError('INVALID_PAYLOAD', 'Import source must be copilot or claude.');
  }
  return value;
}

export function defaultRoots(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  return {
    copilot: join(env.COPILOT_HOME || join(home, '.copilot'), 'session-state'),
    claude: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'),
  };
}

/** Flatten a turn into one short, credential-filtered line for the picker. */
export function preview(value, max = 130) {
  const flat = sanitizeMessage(value, { maxBytes: IMPORT_LIMITS.previewBytes })
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/[*_>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

// --- file access ------------------------------------------------------------------------

async function* jsonLines(file, keep) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (keep && !keep(line)) continue;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const value = JSON.parse(trimmed);
        if (isObject(value)) yield value;
      } catch {
        // A partially written final line is expected while an agent is still running.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function fileInfo(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

async function directories(root) {
  try {
    return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
}

// Parsed results are reused until the file's size or modification time changes.
const parsed = new Map();
async function cached(kind, file, info, read) {
  const key = `${kind}\0${file}`;
  const hit = parsed.get(key);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.value;
  const value = await read();
  parsed.delete(key);
  parsed.set(key, { mtimeMs: info.mtimeMs, size: info.size, value });
  if (parsed.size > 2000) parsed.delete(parsed.keys().next().value);
  return value;
}

// --- GitHub Copilot ---------------------------------------------------------------------

async function readCopilotSession(file, id) {
  let startTime = '';
  let cwd = '';
  const questions = new Map();
  const answers = new Map();
  for await (const event of jsonLines(file, line => COPILOT_SESSION_EVENT.test(line))) {
    const data = event.data;
    if (!isObject(data)) continue;
    if (event.type === 'session.start') {
      startTime = String(data.startTime || event.timestamp || '');
      if (isObject(data.context)) cwd = String(data.context.cwd || '');
    } else if (event.type === 'user.message') {
      if (typeof data.interactionId === 'string' && typeof data.content === 'string' && data.content.trim()) {
        questions.set(data.interactionId, { role: 'user', content: data.content });
      }
    } else if (event.type === 'assistant.message') {
      // The answer is the last assistant text in the interaction; an explicit final_answer wins.
      const interactionId = data.interactionId;
      if (typeof interactionId !== 'string' || !questions.has(interactionId)) continue;
      if (typeof data.content !== 'string' || !data.content.trim()) continue;
      const final = data.phase === 'final_answer';
      if (answers.get(interactionId)?.final && !final) continue;
      answers.set(interactionId, { role: 'agent', content: data.content, final });
    }
  }
  const turns = [];
  for (const [interactionId, question] of questions) {
    const answer = answers.get(interactionId);
    if (answer) turns.push({ question, response: { role: answer.role, content: answer.content } });
  }
  return { session_id: id, start_time: startTime, cwd, turns };
}

async function copilotSessionFiles(root) {
  const files = [];
  for (const name of await directories(root)) {
    if (!SESSION_ID.test(name)) continue;
    const file = join(root, name, 'events.jsonl');
    const info = await fileInfo(file);
    if (info) files.push({ id: name, file, info });
  }
  return files;
}

async function readCopilotMemories(file, id) {
  const memories = [];
  for await (const event of jsonLines(file, line => line.includes('storeMemory'))) {
    const data = event.data;
    if (event.type !== 'tool.execution_complete' || !isObject(data) || !data.success) continue;
    const telemetry = data.toolTelemetry;
    if (!isObject(telemetry) || !isObject(telemetry.properties) || telemetry.properties.operation !== 'storeMemory') continue;
    const restricted = telemetry.restrictedProperties;
    if (!isObject(restricted) || typeof restricted.memoryFact !== 'string') continue;
    memories.push({ memory_id: String(event.id || ''), session_id: id, fact: restricted.memoryFact });
  }
  return memories;
}

// --- Claude Code ------------------------------------------------------------------------

function claudeText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => isObject(block) && block.type === 'text')
    .map(block => String(block.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function readClaudeSession(file, id) {
  let startTime = '';
  let cwd = '';
  let question = null;
  let response = null;
  const turns = [];
  for await (const event of jsonLines(file)) {
    if (event.isSidechain || event.isMeta) continue;
    const message = event.message;
    if ((event.type !== 'user' && event.type !== 'assistant') || !isObject(message)) continue;
    cwd = String(event.cwd || cwd);
    const timestamp = String(event.timestamp || '');
    if (timestamp && (!startTime || timestamp < startTime)) startTime = timestamp;
    const content = claudeText(message.content);
    if (!content) continue;
    if (event.type === 'user') {
      // A user event with a list payload is a tool result, not a typed prompt.
      if (typeof message.content !== 'string') continue;
      if (question && response) turns.push({ question, response });
      question = { role: 'user', content };
      response = null;
    } else if (question) {
      // Later assistant text in the same turn supersedes earlier partial answers.
      response = { role: 'agent', content };
    }
  }
  if (question && response) turns.push({ question, response });
  return { session_id: id, start_time: startTime, cwd, turns };
}

async function claudeSessionFiles(root) {
  const files = [];
  for (const project of await directories(root)) {
    let entries = [];
    try {
      entries = await readdir(join(root, project), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const id = entry.name.slice(0, -'.jsonl'.length);
      if (!SESSION_ID.test(id)) continue;
      const file = join(root, project, entry.name);
      const info = await fileInfo(file);
      if (info) files.push({ id, file, info });
    }
  }
  return files;
}

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

async function markdownFiles(directory, out = []) {
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await markdownFiles(path, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}

async function scanClaudeMemories(root) {
  const memories = [];
  for (const project of await directories(root)) {
    const memoryRoot = join(root, project, 'memory');
    for (const path of (await markdownFiles(memoryRoot)).sort()) {
      if (basename(path) === 'MEMORY.md') continue;
      const body = (await readFile(path, 'utf8')).replace(FRONT_MATTER, '').trim();
      if (!body) continue;
      const rel = relative(memoryRoot, path).split(sep).join(posix.sep);
      memories.push({ memory_id: `${project}:${rel}`, session_id: project, fact: body });
    }
  }
  return memories;
}

// --- listing ----------------------------------------------------------------------------

async function sessionFiles(source, roots) {
  return source === 'claude' ? claudeSessionFiles(roots.claude) : copilotSessionFiles(roots.copilot);
}

async function readSession(source, entry) {
  const read = source === 'claude' ? readClaudeSession : readCopilotSession;
  return cached(`${source}-session`, entry.file, entry.info, () => read(entry.file, entry.id));
}

function label(session) {
  const first = session.turns[0];
  return preview(first ? first.question.content : '', 72)
    || session.cwd.split(/[\\/]/).filter(Boolean).pop() || session.session_id;
}

/** The newest local sessions with turns, summarized for the picker. */
export async function listSessions(source, roots, { limit = IMPORT_LIMITS.sessions } = {}) {
  importSource(source);
  const entries = (await sessionFiles(source, roots)).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const sessions = [];
  for (const entry of entries) {
    if (sessions.length >= limit) break;
    const session = await readSession(source, entry);
    if (!session.turns.length) continue;
    const last = session.turns[session.turns.length - 1];
    sessions.push({
      session_id: session.session_id,
      label: label(session),
      cwd: session.cwd,
      start_time: session.start_time,
      turn_count: session.turns.length,
      last_user_turn: preview(last.question.content),
      last_agent_turn: preview(last.response.content),
    });
  }
  return sessions;
}

// --- import -----------------------------------------------------------------------------

function selectedIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > IMPORT_LIMITS.selected
    || ids.some(id => typeof id !== 'string' || !SESSION_ID.test(id))) {
    throw new MemoryHouseError('INVALID_PAYLOAD', `Select 1 to ${IMPORT_LIMITS.selected} listed sessions to import.`);
  }
  return [...new Set(ids)];
}

function* batches(items, maxItems, envelope) {
  let chunk = [];
  for (const item of items) {
    if (chunk.length && (chunk.length >= maxItems
      || Buffer.byteLength(JSON.stringify(envelope([...chunk, item]))) > IMPORT_LIMITS.batchBytes)) {
      yield envelope(chunk);
      chunk = [];
    }
    chunk.push(item);
  }
  if (chunk.length) yield envelope(chunk);
}

async function postMemory(gateway, body) {
  // A key derived from the exact batch makes an unchanged re-import replay instead of duplicating.
  const key = `mh-import-${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
  const { data } = await gateway.json('/memory', {
    method: 'POST', body, headers: { 'Idempotency-Key': key }, operation: 'import', timeoutMs: IMPORT_LIMITS.timeoutMs,
  });
  return data;
}

function tally(result, field, sent, response) {
  result.batches += 1;
  const outcome = isObject(response) ? response.result : null;
  if (isObject(outcome) && Number.isSafeInteger(outcome.succeeded)) {
    result[field] += outcome.succeeded;
    result.failed += Number.isSafeInteger(outcome.failed) ? outcome.failed : 0;
    result.unknown += Number.isSafeInteger(outcome.unknown) ? outcome.unknown : 0;
  } else {
    // Queued or still running: accepted for processing, not yet confirmed per item.
    result[field] += sent;
  }
}

/** Send the selected sessions' turns for extraction. Stops at the first failed request. */
export async function importSessions({ gateway, source, ids, roots }) {
  importSource(source);
  const wanted = selectedIds(ids);
  const result = { source, sessions: 0, messages: 0, skipped: 0, failed: 0, unknown: 0, batches: 0 };
  try {
    const entries = new Map((await sessionFiles(source, roots)).map(entry => [entry.id, entry]));
    for (const id of wanted) {
      const entry = entries.get(id);
      if (!entry) continue;
      const session = await readSession(source, entry);
      if (!session.turns.length) continue;
      const items = [];
      for (const turn of session.turns) {
        for (const message of [turn.question, turn.response]) {
          const content = sanitizeMessage(message.content);
          if (content) items.push({ role: message.role, content, source: SOURCES[source].session });
          else result.skipped += 1;
        }
      }
      if (!items.length) continue;
      result.sessions += 1;
      const threadId = `mh:import:${source}:${id}`;
      for (const body of batches(items, IMPORT_LIMITS.batchItems, chunk => ({ extract: true, thread_id: threadId, items: chunk }))) {
        tally(result, 'messages', body.items.length, await postMemory(gateway, body));
      }
    }
  } catch (error) {
    return { ...result, error: safeError(error) };
  }
  return result;
}

async function scanMemories(source, roots) {
  if (source === 'claude') return scanClaudeMemories(roots.claude);
  const memories = [];
  for (const entry of await copilotSessionFiles(roots.copilot)) {
    memories.push(...await cached('copilot-memories', entry.file, entry.info, () => readCopilotMemories(entry.file, entry.id)));
  }
  return memories;
}

/** Publish the source's own saved memories as direct facts, then request one reconciliation. */
export async function importMemories({ gateway, source, roots }) {
  importSource(source);
  const result = { source, memories: 0, skipped: 0, failed: 0, unknown: 0, batches: 0, reconcile: null };
  try {
    const items = [];
    const seen = new Set();
    for (const memory of await scanMemories(source, roots)) {
      const content = sanitizeMessage(memory.fact, { maxBytes: IMPORT_LIMITS.factBytes });
      if (!content || seen.has(content)) {
        result.skipped += 1;
        continue;
      }
      seen.add(content);
      items.push({ content, source: SOURCES[source].memory });
    }
    for (const body of batches(items, IMPORT_LIMITS.factBatchItems, chunk => ({ extract: false, items: chunk }))) {
      tally(result, 'memories', body.items.length, await postMemory(gateway, body));
    }
    if (result.memories > 0) {
      const { data } = await gateway.json('/reconcile', {
        method: 'POST', body: {}, operation: 'reconcile', timeoutMs: IMPORT_LIMITS.timeoutMs,
      });
      result.reconcile = isObject(data) && typeof data.status === 'string' ? data.status : 'requested';
    }
  } catch (error) {
    return { ...result, error: safeError(error) };
  }
  return result;
}
