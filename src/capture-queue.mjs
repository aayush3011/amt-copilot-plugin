// Durable outbox for captured conversation turns.
//
// Hooks add each turn here and return without waiting on the network. A detached sender
// (runtime/flush.mjs) delivers queued turns in the background, and later hook runs and session
// ends start it again while turns remain. Each file holds one sealed turn and is named by a
// monotonic sequence number, so a thread's turns are always sent in the order they were queued.
// The batch a conversation is sending is recorded first (sending-<thread>.json), so a retry resends
// exactly that batch.
// Each turn is bound to the signed-in account (see client.captureIdentity) and sent only for it.
// Turn text is encrypted with the same OS-protected device key as the sign-in cache, and files
// use the state directory's owned-directory, no-follow and atomic-write protections.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, unlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { atomicJson, ensureDirectory, owned, readState, sameFile } from './state.mjs';

export const QUEUE_LIMITS = Object.freeze({
  maxEntries: 200,
  maxBytes: 4 * 1024 * 1024,
  entryBytes: 128 * 1024,
  contentBytes: 64 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  batchItems: 50,
  batchBytes: 240 * 1024,
  // The queue lock covers only local file bookkeeping, so a crashed holder blocks it briefly.
  lockTtlMs: 10 * 1000,
  lockWaitMs: 2000,
  leaseMs: 2 * 60 * 1000,
  retryBaseMs: 30 * 1000,
  retryMaxMs: 10 * 60 * 1000,
  passes: 50,
  // A turn is dropped once its requests finished as failed under this many keys, over at least this long.
  failedTurnKeys: 2,
  failedTurnMs: 60 * 60 * 1000,
});

const DIRECTORY = 'capture-queue';
const MANIFEST = /^sending-([a-f\d]{64})\.json$/;
const KEY = /^mh-capture-[a-f\d]{64}$/;
// A random suffix keeps two writers from ever sharing a file name, even if both hold a reclaimed lock.
const ENTRY = /^(\d{16})-[a-f\d]{8}\.json$/;
const STAGING = /^\..+\.write$/;
const TURN_ID = /^[a-f\d-]{36}$/i;
const HEX = /^[a-f\d]{64}$/;
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const FLUSH_SCRIPT = new URL('./flush.mjs', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const queueError = reason => Object.assign(new Error(`capture-queue:${reason}`), { reason });
const threadKey = (gatewayBase, threadId) => hash(JSON.stringify([gatewayBase, threadId]));
const manifestPath = (directory, thread) => join(directory, `sending-${thread}.json`);
// A session start or end that found a sender running asks it, through this file, to retry every conversation.
const FORCE_REQUEST = 'force.json';

export const queueDirectory = stateDir => join(stateDir, DIRECTORY);

/** A short, content-free reason for hook diagnostics. */
export function queueFailure(error) {
  if (typeof error?.reason === 'string') return error.reason;
  if (error?.code === 'SECURE_CACHE_UNAVAILABLE') return 'protection';
  if (['UNSAFE_STATE', 'UNSAFE_LOCK'].includes(error?.code)) return 'unsafe';
  return 'io';
}

async function secureDirectory(stateDir) {
  await ensureDirectory(stateDir);
  const directory = queueDirectory(stateDir);
  await ensureDirectory(directory);
  return directory;
}

/** The queue directory if it exists and is safe; a sender never creates state directories. */
async function existingDirectory(stateDir) {
  for (const path of [stateDir, queueDirectory(stateDir)]) {
    const stat = await inspect(path);
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) throw queueError('unsafe-directory');
  }
  return queueDirectory(stateDir);
}

async function discard(path) {
  // unlink removes a link itself, never its target.
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

async function inspect(path) {
  return lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
}

/**
 * An exclusive lock file that a crashed owner cannot hold forever: after `ttlMs` without a touch,
 * the next caller removes it. Returns null when another owner still holds it after `waitMs`.
 */
async function lockFile(path, { ttlMs, waitMs = 0, clock }) {
  const started = performance.now();
  for (;;) {
    let handle;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (handle) {
      let stat;
      try {
        const time = clock() / 1000;
        await handle.utimes(time, time);
        stat = await handle.stat();
      } catch (error) {
        await handle.close().catch(() => {});
        await discard(path).catch(() => {});
        throw error;
      }
      await handle.close();
      return {
        async touch() {
          const current = await inspect(path);
          if (!current || !sameFile(current, stat)) throw queueError('lease-lost');
          const time = clock() / 1000;
          await utimes(path, time, time);
        },
        async release() {
          try {
            const current = await inspect(path);
            if (current && sameFile(current, stat)) await unlink(path);
          } catch {
            // A lock that cannot be removed expires after its TTL.
          }
        },
      };
    }
    const stat = await inspect(path);
    if (stat && (!stat.isFile() || stat.nlink !== 1 || !owned(stat))) throw queueError('unsafe-lock');
    if (stat && clock() - stat.mtimeMs > ttlMs) {
      await discard(path);
      continue;
    }
    if (stat && performance.now() - started >= waitMs) return null;
    if (stat) await sleep(10 + Math.floor(Math.random() * 15));
  }
}

async function withQueueLock(directory, clock, work) {
  const lock = await lockFile(join(directory, 'queue.lock'), {
    ttlMs: QUEUE_LIMITS.lockTtlMs, waitMs: QUEUE_LIMITS.lockWaitMs, clock,
  });
  if (!lock) throw queueError('busy');
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

/** Queued turn files in sequence order. Links and foreign files are removed, never followed. */
async function listEntries(directory) {
  const entries = [];
  for (const name of await readdir(directory)) {
    const match = ENTRY.exec(name);
    if (!match) continue;
    const path = join(directory, name);
    const stat = await inspect(path);
    if (!stat) continue;
    if (!stat.isFile() || stat.nlink !== 1 || !owned(stat)) {
      await discard(path);
      continue;
    }
    entries.push({ name, seq: Number(match[1]), path, stat });
  }
  return entries.sort((a, b) => a.seq - b.seq || (a.name < b.name ? -1 : 1));
}

const expired = (seq, now) => seq < now - QUEUE_LIMITS.maxAgeMs || seq > now + QUEUE_LIMITS.maxAgeMs;

/** The header, null when the file can never be used, or undefined when it vanished. I/O errors throw. */
async function readHeader(path) {
  let raw;
  try {
    raw = await readState(path, QUEUE_LIMITS.entryBytes);
  } catch (error) {
    if (error?.code === 'STATE_IO_ERROR') throw queueError('io');
    return null;
  }
  if (raw === null) return undefined;
  try {
    const header = JSON.parse(raw);
    // failedRequests: how many requests with this turn finished as failed, each under its own key;
    // firstFailedAt: when the first of them did.
    return isObject(header) && header.version === 1 && HEX.test(header.gateway) && HEX.test(header.thread)
      && typeof header.account === 'string' && HEX.test(header.account) && isObject(header.sealed)
      && ((header.failedRequests === undefined && header.firstFailedAt === undefined)
        || (Number.isSafeInteger(header.failedRequests) && header.failedRequests >= 1 && Number.isFinite(header.firstFailedAt)))
      ? header : null;
  } catch {
    return null;
  }
}

/**
 * The batch each conversation is sending: its idempotency key and files, in order, by thread. `stored`
 * marks a partial result being settled: the files the engine stored.
 */
async function readManifests(directory) {
  const manifests = new Map();
  for (const name of await readdir(directory)) {
    const match = MANIFEST.exec(name);
    if (!match) continue;
    let raw;
    try {
      raw = await readState(join(directory, name), 16 * 1024);
    } catch (error) {
      if (error?.code === 'STATE_IO_ERROR') throw queueError('io');
      raw = 'invalid';
    }
    if (raw === null) continue;
    try {
      const manifest = JSON.parse(raw);
      if (isObject(manifest) && manifest.version === 1 && manifest.thread === match[1] && KEY.test(manifest.key)
        && Array.isArray(manifest.files) && manifest.files.length >= 1 && manifest.files.length <= QUEUE_LIMITS.batchItems
        && manifest.files.every(file => typeof file === 'string' && ENTRY.test(file))
        && (manifest.stored === undefined || (Array.isArray(manifest.stored) && manifest.stored.length >= 1
          && new Set(manifest.stored).size === manifest.stored.length && manifest.stored.every(file => manifest.files.includes(file))))) {
        manifests.set(manifest.thread, manifest);
        continue;
      }
    } catch {
      // Fall through: a damaged record is removed.
    }
    await discard(join(directory, name));
  }
  return manifests;
}

/**
 * Seal and queue turns, such as the parts of one long message, as consecutive entries. The lock is
 * held only for local bookkeeping and the writes, never while encrypting or sending. When the queue
 * is full the oldest turns make room, except the batch being sent. `confirm` re-checks the
 * account binding just before the writes, so nothing is written after a logout or account switch.
 */
export async function enqueueTurns({
  stateDir, gatewayBase, protection, account, threadId, turns, clock = Date.now, confirm,
}) {
  if (typeof stateDir !== 'string' || typeof gatewayBase !== 'string' || typeof threadId !== 'string' || !threadId
    || typeof account !== 'string' || !HEX.test(account) || !Array.isArray(turns) || !turns.length
    || turns.length > QUEUE_LIMITS.batchItems || turns.some(turn => !isObject(turn) || !['user', 'agent'].includes(turn.role)
      || typeof turn.content !== 'string' || !turn.content.trim() || Buffer.byteLength(turn.content) > QUEUE_LIMITS.contentBytes)) {
    throw queueError('invalid-turn');
  }
  const thread = threadKey(gatewayBase, threadId);
  const records = await Promise.all(turns.map(async ({ role, content }) => ({
    version: 1, gateway: hash(gatewayBase), thread, account,
    sealed: await protection.protect(JSON.stringify({ id: randomUUID(), gateway: gatewayBase, thread_id: threadId, account, role, content })),
  })));
  const sizes = records.map(record => Buffer.byteLength(`${JSON.stringify(record)}\n`));
  if (sizes.some(size => size > QUEUE_LIMITS.entryBytes)) throw queueError('entry-size');
  const bytes = sizes.reduce((sum, size) => sum + size, 0);
  const directory = await secureDirectory(stateDir);
  return withQueueLock(directory, clock, async () => {
    if (confirm && !(await confirm().catch(() => false))) throw queueError('signed-out');
    const now = clock();
    for (const name of await readdir(directory)) {
      if (!STAGING.test(name)) continue;
      const stat = await inspect(join(directory, name));
      if (stat?.isFile() && now - stat.mtimeMs > QUEUE_LIMITS.lockTtlMs) await discard(join(directory, name));
    }
    const sending = new Set([...(await readManifests(directory)).values()].flatMap(manifest => manifest.files));
    const entries = await listEntries(directory);
    const kept = [];
    let evicted = 0;
    for (const entry of entries) {
      if (sending.has(entry.name)) continue;
      if (expired(entry.seq, now)) {
        await discard(entry.path);
        evicted++;
      } else {
        kept.push(entry);
      }
    }
    const remaining = [...kept, ...entries.filter(entry => sending.has(entry.name))];
    let count = remaining.length;
    let total = remaining.reduce((sum, entry) => sum + entry.stat.size, 0);
    while (kept.length && (count + records.length > QUEUE_LIMITS.maxEntries || total + bytes > QUEUE_LIMITS.maxBytes)) {
      const oldest = kept.shift();
      await discard(oldest.path);
      count--;
      total -= oldest.stat.size;
      evicted++;
    }
    const first = Math.max((entries.at(-1)?.seq ?? 0) + 1, Math.floor(now));
    const written = [];
    try {
      for (const [index, record] of records.entries()) {
        const name = `${String(first + index).padStart(16, '0')}-${randomBytes(4).toString('hex')}.json`;
        // Tracked before writing: a write can fail after its file became visible.
        written.push(name);
        await atomicJson(join(directory, name), record);
      }
    } catch (error) {
      // A message is queued whole or not at all.
      for (const name of written) await discard(join(directory, name)).catch(() => {});
      throw error;
    }
    return { seq: first, evicted };
  });
}

/** Seal and queue one turn. */
export function enqueueTurn({ role, content, ...options }) {
  return enqueueTurns({ ...options, turns: [{ role, content }] });
}

async function entryNames(directory) {
  try {
    return (await readdir(directory)).filter(name => ENTRY.test(name));
  } catch {
    return [];
  }
}

/**
 * Discard every queued turn, for example when Memory House is signed out on this device. It waits
 * out the queue lock, which a crashed holder loses after its TTL, so no enqueue lands afterwards.
 */
export async function clearCaptureQueue(stateDir) {
  const directory = queueDirectory(stateDir);
  const stat = await inspect(directory);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) throw queueError('unsafe-directory');
  const lock = await lockFile(join(directory, 'queue.lock'), {
    ttlMs: QUEUE_LIMITS.lockTtlMs, waitMs: QUEUE_LIMITS.lockTtlMs + 1000, clock: Date.now,
  });
  if (!lock) throw queueError('busy');
  try {
    for (const name of await readdir(directory)) {
      if (MANIFEST.test(name)) await discard(join(directory, name));
    }
    for (const name of await readdir(directory)) {
      if (ENTRY.test(name) || STAGING.test(name) || name === 'status.json' || name === FORCE_REQUEST) await discard(join(directory, name));
    }
  } finally {
    await lock.release();
  }
}

const validWait = wait => isObject(wait) && Number.isSafeInteger(wait.failures) && wait.failures > 0
  && Number.isFinite(wait.retryAt) && typeof wait.error === 'string';

/**
 * Retry waits after failures: `run` after one that would meet every conversation (it stopped the run),
 * and `conversations` for each conversation whose own requests failed. Content-free.
 */
async function readStatus(directory) {
  try {
    const status = JSON.parse(await readState(join(directory, 'status.json'), 64 * 1024));
    return isObject(status) && status.version === 2 && (status.generation === null || typeof status.generation === 'string')
      && (status.run === null || validWait(status.run)) && isObject(status.conversations)
      && Object.entries(status.conversations).every(([thread, wait]) => HEX.test(thread) && validWait(wait)) ? status : null;
  } catch {
    return null;
  }
}

/** How long to wait after a number of consecutive failures; a longer Retry-After is honored, up to the maximum. */
const retryDelay = (failures, retryAfterMs = 0) =>
  Math.min(Math.max(QUEUE_LIMITS.retryBaseMs * 2 ** (failures - 1), retryAfterMs), QUEUE_LIMITS.retryMaxMs);

/**
 * Record the waits after this run, so that frequent hook events do not start senders that cannot get
 * through. A conversation's wait grows with its own consecutive failures and ends when it is sent; one
 * that was not attempted keeps its wait. The run-level wait grows with consecutive stopped runs.
 */
async function recordOutcome(directory, run, generation, queued, clock) {
  const now = clock();
  // `queued` is null when a pass failed before it listed the conversations: their waits stay as they were.
  generation ??= run.previous?.generation ?? null;
  const previous = run.previous?.generation === generation ? run.previous : null;
  const conversations = queued === null ? { ...previous?.conversations } : {};
  for (const thread of queued ?? []) {
    const prior = previous?.conversations[thread];
    const failure = run.failed.get(thread);
    if (failure) {
      const failures = Math.min((prior?.failures ?? 0) + 1, 32);
      conversations[thread] = { failures, retryAt: now + retryDelay(failures, failure.retryAfterMs), error: failure.error };
    } else if (prior && !run.attempted.has(thread)) {
      conversations[thread] = prior;
    }
  }
  let stopped = null;
  if (run.stop) {
    const failures = Math.min((previous?.run?.failures ?? 0) + 1, 32);
    stopped = { failures, retryAt: now + retryDelay(failures, run.stop.retryAfterMs), error: run.stop.error };
  }
  const path = join(directory, 'status.json');
  if (!stopped && !Object.keys(conversations).length) {
    await discard(path).catch(() => {});
    return;
  }
  await atomicJson(path, { version: 2, generation, run: stopped, conversations }).catch(() => {});
}

/** Start the background sender as its own detached process, so it can outlive the hook. */
export function launchFlushProcess({ env = process.env, force = false, script = fileURLToPath(FLUSH_SCRIPT) } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...(force ? ['--force'] : [])], {
      cwd: tmpdir(), env, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** The hash that identifies a conversation's turns, records and retry wait in the queue. */
export const conversationKey = threadKey;

/**
 * Start a sender when turns are queued and none is running. Session start and end (`force`) always do,
 * and their sender retries every conversation. Otherwise, after a failure that would meet every
 * conversation, all wait. After a run that finished, the turns still queued belong to conversations that
 * wait, so a hook that just queued a turn (`queued`) starts a sender unless its own `conversation` waits,
 * and any other hook only once some conversation's wait is over.
 */
export async function startCaptureFlush({
  stateDir, generation = null, conversation = null, queued = false, force = false, clock = Date.now, launch = launchFlushProcess,
}) {
  if (typeof stateDir !== 'string' || !stateDir) return false;
  const directory = queueDirectory(stateDir);
  const stat = await inspect(directory).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || !(await entryNames(directory)).length) return false;
  const running = async () => {
    const lease = await inspect(join(directory, 'flush.lock')).catch(() => null);
    return Boolean(lease) && clock() - lease.mtimeMs <= QUEUE_LIMITS.leaseMs;
  };
  if (await running()) {
    if (!force) return false;
    // The running sender takes this request when it finishes a pass. If it released its lease meanwhile,
    // it may have looked already, so a new sender is started instead.
    await atomicJson(join(directory, FORCE_REQUEST), { version: 1 }).catch(() => {});
    if (await running()) return false;
  }
  if (!force) {
    const status = await readStatus(directory);
    const now = clock();
    if (status && status.generation === generation) {
      if (status.run) {
        if (status.run.retryAt > now) return false;
      } else if (queued) {
        if (conversation && status.conversations[conversation]?.retryAt > now) return false;
      } else {
        const waits = Object.values(status.conversations);
        if (waits.length && waits.every(wait => wait.retryAt > now)) return false;
      }
    }
  }
  await launch({ force });
  return true;
}

// Failures that only one conversation's requests meet; any other failure would meet them all.
const CONVERSATION_FAILURES = new Set(['server', 'conflict', 'finished', 'unfinished']);

function sendFailure(error) {
  const status = error?.status ?? error?.statusCode;
  const code = typeof error?.code === 'string' ? error.code : '';
  if (status === 401 || status === 403 || /^(?:NOT_SIGNED_IN|ENTRA_|TENANT_|INVALID_AUTH_STATE|INVALID_CACHE|SECURE_CACHE)/.test(code)) return 'auth';
  // The engine finished this request as failed and replays that result for its key for 24 hours, so a
  // retry needs a new key. A memory reset (delete all) that superseded it means: do not store these turns.
  if (error?.requestFailure) return error.requestFailure.code === 'reset_superseded' ? 'superseded' : 'finished';
  if (status === 409) {
    // The key is derived from these turns, so a conflicting earlier request under it carried them already.
    // Other conflicts are raised before a request finishes (a memory reset in progress, a stale write),
    // so the same batch and key are retried later.
    return error.problem === 'idempotency_conflict' ? 'delivered' : 'conflict';
  }
  // The gateway refused the request itself; sending it again cannot succeed.
  if ([400, 413, 422].includes(status) || code === 'INVALID_PAYLOAD') return 'rejected';
  if (status === 429) return 'throttled';
  if (code === 'REQUEST_TIMEOUT') return 'timeout';
  return Number.isInteger(status) ? 'server' : 'transport';
}

// A key comes from its turns and how many of their requests already finished as failed, so the same
// attempt always has the same key, and a retry after such a failure a new one.
const batchKey = batch => `mh-capture-${hash(JSON.stringify(batch.map(entry =>
  [entry.turn.id, ...(entry.header.failedRequests ? [entry.header.failedRequests] : [])])))}`;

/**
 * Open one sealed turn. A locked or unavailable credential store fails the same way as a damaged
 * turn, so after a failure the store is checked with a fresh seal and the turn is tried once more
 * before it is treated as unreadable.
 */
async function openEntry(entry, context) {
  const { protection, gatewayBase, account } = context;
  let text;
  try {
    text = await protection.unprotect(entry.header.sealed);
  } catch {
    const works = await protection.protect('probe').then(sealed => protection.unprotect(sealed))
      .then(value => value === 'probe', () => false);
    if (!works) throw queueError('protection');
    text = await protection.unprotect(entry.header.sealed).catch(() => {
      throw queueError('unreadable');
    });
  }
  try {
    const turn = JSON.parse(text);
    if (isObject(turn) && typeof turn.id === 'string' && TURN_ID.test(turn.id) && turn.gateway === gatewayBase
      && turn.account === account && typeof turn.thread_id === 'string'
      && threadKey(gatewayBase, turn.thread_id) === entry.header.thread && ['user', 'agent'].includes(turn.role)
      && typeof turn.content === 'string' && turn.content.trim() && Buffer.byteLength(turn.content) <= QUEUE_LIMITS.contentBytes) {
      return turn;
    }
  } catch {
    // Damaged after sealing.
  }
  throw queueError('unreadable');
}

/**
 * Record the batch a conversation is about to send. Done under the queue lock, so enqueue never evicts
 * it; returns the turns that were evicted before it could be recorded.
 */
async function recordSending(directory, thread, key, batch, clock) {
  return withQueueLock(directory, clock, async () => {
    const missing = [];
    for (const entry of batch) {
      const current = await inspect(entry.path);
      if (!current || !sameFile(current, entry.stat)) missing.push(entry);
    }
    if (!missing.length) {
      await atomicJson(manifestPath(directory, thread), { version: 1, thread, key, files: batch.map(entry => entry.name) });
    }
    return missing;
  });
}

/** The batch is settled (stored, or dropped): remove its turns, then its record. */
async function acknowledge(directory, thread, batch) {
  for (const entry of batch) await discard(entry.path);
  await discard(manifestPath(directory, thread));
}

/**
 * A request with this batch finished as failed, or stored only the `stored` turns. First its record
 * goes, so the other turns are never taken for delivered, or, after a partial result, is replaced by
 * one that names the stored turns, so a sender stopped meanwhile removes them rather than sending them
 * again. Each other turn counts one more failed request, which gives its next request a new key, and is
 * retried alone, until it has failed under `failedTurnKeys` keys over at least `failedTurnMs`; then it
 * is dropped, so it cannot hold up its conversation for long. Returns the dropped turns.
 */
async function recordFailure(directory, thread, key, batch, stored, clock) {
  return withQueueLock(directory, clock, async () => {
    const record = manifestPath(directory, thread);
    if (stored.size) {
      await atomicJson(record, { version: 1, thread, key, files: batch.map(entry => entry.name),
        stored: batch.filter(entry => stored.has(entry)).map(entry => entry.name) });
    } else {
      await discard(record);
    }
    const now = clock();
    const dropped = [];
    for (const entry of batch) {
      if (stored.has(entry)) continue;
      const current = await inspect(entry.path);
      if (!current || !sameFile(current, entry.stat)) continue;
      const failedRequests = (entry.header.failedRequests ?? 0) + 1;
      // A clock set back restarts the period rather than prolonging it.
      const firstFailedAt = Math.min(entry.header.firstFailedAt ?? now, now);
      if (failedRequests >= QUEUE_LIMITS.failedTurnKeys && now - firstFailedAt >= QUEUE_LIMITS.failedTurnMs) {
        await discard(entry.path);
        dropped.push(entry);
      } else {
        entry.header = { ...entry.header, failedRequests, firstFailedAt };
        await atomicJson(entry.path, entry.header);
        entry.stat = await lstat(entry.path);
      }
    }
    for (const entry of stored) await discard(entry.path);
    await discard(record);
    return dropped;
  });
}

/**
 * What an answered request did with the batch's turns. The engine finishes it as succeeded; as partial
 * (207), when some turns were stored and the others failed or their outcome is unknown; or not yet
 * (202), while another attempt with the same key is still running. `stored` holds the positions that
 * a partial result reports stored; any other turn is sent again.
 */
function answered(result, count) {
  const status = isObject(result) ? result.status : undefined;
  if (status === 'queued' || status === 'running') return { outcome: 'unfinished' };
  if (status === 'failed') return { outcome: result.error?.code === 'reset_superseded' ? 'superseded' : 'finished' };
  if (status !== 'partial') return { outcome: 'sent' };
  const reports = new Map();
  for (const item of Array.isArray(result.result?.items) ? result.result.items : []) {
    if (!isObject(item) || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= count) continue;
    reports.set(item.index, (reports.get(item.index) ?? true) && ['stored', 'ready'].includes(item.status));
  }
  return { outcome: 'partial', stored: new Set([...reports].filter(([, stored]) => stored).map(([index]) => index)) };
}

/** Send a batch. Returns `{ outcome, stored }`, where `stored` lists the positions a partial result stored. */
async function deliver(context, batch, key) {
  const { client, account, log } = context;
  let result;
  try {
    result = await client.capture({
      thread_id: batch[0].turn.thread_id,
      items: batch.map(entry => ({ role: entry.turn.role, content: entry.turn.content })),
    }, { idempotencyKey: key, binding: account });
  } catch (error) {
    const outcome = sendFailure(error);
    if (outcome === 'delivered') {
      log('capture:queue:already-delivered');
      return { outcome: 'sent' };
    }
    if (Number.isFinite(error?.retryAfterSeconds)) {
      context.retryAfterMs = Math.max(context.retryAfterMs ?? 0, error.retryAfterSeconds * 1000);
    }
    return { outcome };
  }
  if (result === false || result?.ok === false || result?.success === false
    || result?.accepted === false || result?.captured === false) return { outcome: 'rejected' };
  const answer = answered(result, batch.length);
  if (answer.outcome === 'partial') log('capture:queue:partly-stored');
  return answer;
}

/** Send one conversation's turns in order. Returns why it stopped early, or null when it is done. */
async function sendThread(queue, context) {
  const { directory, lease, clock, log, summary, manifests } = context;
  const thread = queue[0].header.thread;
  const remove = entry => {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  };
  const dropped = (count, reason) => {
    summary.dropped += count;
    for (let index = 0; index < count; index++) log(`capture:queue:dropped:${reason}`);
  };
  const settle = async (batch, outcome) => {
    await acknowledge(directory, thread, batch);
    batch.forEach(remove);
    if (outcome === 'sent') summary.sent += batch.length;
    else dropped(batch.length, outcome);
  };
  // The request finished as failed, or stored only the turns at `positions`. Returns whether turns
  // remain to retry under a new key after the usual wait.
  const failed = async (batch, key, positions = new Set()) => {
    const stored = new Set(batch.filter((_, index) => positions.has(index)));
    const gone = await recordFailure(directory, thread, key, batch, stored, clock);
    for (const entry of [...stored, ...gone]) remove(entry);
    summary.sent += stored.size;
    dropped(gone.length, 'kept-failing');
    return gone.length + stored.size < batch.length;
  };
  while (queue.length) {
    // A batch recorded by an interrupted run is resent exactly, with its key, before anything newer.
    // A turn whose request failed is retried alone; other turns are batched up to the limits.
    const recorded = manifests.get(thread);
    manifests.delete(thread);
    let window = [];
    if (recorded) window = queue.slice(0, recorded.files.length);
    else if (queue[0].header.failedRequests) window = queue.slice(0, 1);
    else {
      for (const entry of queue) {
        if (window.length >= QUEUE_LIMITS.batchItems || entry.header.failedRequests) break;
        window.push(entry);
      }
    }
    let batch = [];
    let bytes = 0;
    let unreadable = null;
    for (const entry of window) {
      if (!entry.turn) {
        try {
          entry.turn = await openEntry(entry, context);
        } catch (error) {
          if (error.reason !== 'unreadable') return error.reason ?? 'protection';
          unreadable = entry;
          break;
        }
        await lease.touch();
      }
      bytes ||= Buffer.byteLength(JSON.stringify({ extract: true, thread_id: entry.turn.thread_id, items: [] }));
      const size = Buffer.byteLength(JSON.stringify({ role: entry.turn.role, content: entry.turn.content })) + 1;
      if (!recorded && batch.length && bytes + size > QUEUE_LIMITS.batchBytes) break;
      batch.push(entry);
      bytes += size;
    }
    if (unreadable) {
      if (recorded) await discard(manifestPath(directory, thread));
      await discard(unreadable.path);
      remove(unreadable);
      dropped(1, 'unreadable');
      continue;
    }
    const key = recorded?.key ?? batchKey(batch);
    if (!recorded) {
      const missing = await recordSending(directory, thread, key, batch, clock);
      if (missing.length) {
        missing.forEach(remove);
        continue;
      }
    }
    await lease.touch();
    const { outcome, stored } = await deliver(context, batch, key);
    if (['sent', 'superseded'].includes(outcome) || (outcome === 'rejected' && batch.length === 1)) {
      await settle(batch, outcome);
      continue;
    }
    if (['finished', 'partial'].includes(outcome)) {
      if (await failed(batch, key, stored)) return 'finished';
      continue;
    }
    // On any other failure the record stays, so the next run resends exactly this batch.
    if (outcome !== 'rejected') return outcome;
    // The gateway stored nothing from a refused batch: send its turns one at a time, each recorded.
    for (const entry of batch) {
      const single = batchKey([entry]);
      if ((await recordSending(directory, thread, single, [entry], clock)).length) {
        remove(entry);
        continue;
      }
      await lease.touch();
      const { outcome: result, stored } = await deliver(context, [entry], single);
      if (['sent', 'rejected', 'superseded'].includes(result)) {
        await settle([entry], result);
        continue;
      }
      if (['finished', 'partial'].includes(result)) {
        if (await failed([entry], single, stored)) return 'finished';
        continue;
      }
      return result;
    }
  }
  return null;
}

/**
 * One pass over the queue. Returns the turn files it listed, whether a failure ended the run, and the
 * conversations that still have queued turns (null when unknown).
 */
async function sendQueued(context) {
  const { directory, client, gatewayBase, protectionFor, clock, log, summary, run, force } = context;
  const entries = await listEntries(directory);
  const seen = new Set(entries.map(entry => entry.name));
  const manifests = await readManifests(directory);
  const dropManifest = async thread => {
    await discard(manifestPath(directory, thread));
    manifests.delete(thread);
  };
  // Unreadable sign-in state is not a sign-out: keep the queue and retry later.
  let identity;
  try {
    identity = typeof client.captureIdentity === 'function' ? await client.captureIdentity() : null;
    // A sign-in made before 0.15.0 recorded no account. Record it once, so that later turns are bound
    // to it; turns queued before cannot be matched to an account and are discarded below.
    if (identity && !identity.accountBound && typeof client.recordAccount === 'function'
      && await client.recordAccount().catch(() => false)) {
      log('capture:queue:account-recorded');
      identity = await client.captureIdentity();
    }
  } catch {
    summary.error = 'sign-in';
    run.stop = { error: 'sign-in' };
    return { seen, stopped: true, queued: null };
  }
  summary.generation = identity?.generation ?? null;
  if (!entries.length) {
    for (const thread of [...manifests.keys()]) await dropManifest(thread);
    return { seen, stopped: false, queued: new Set() };
  }
  if (!identity) {
    // Signed out, or never signed in on this device: these turns can never be sent.
    await withQueueLock(directory, clock, async () => {
      for (const thread of [...manifests.keys()]) await dropManifest(thread);
      for (const entry of entries) await discard(entry.path);
    });
    log(`capture:queue:discarded-signed-out:${entries.length}`);
    summary.dropped += entries.length;
    return { seen, stopped: false, queued: new Set() };
  }
  for (const [thread, manifest] of [...manifests]) {
    if (manifest.stored) {
      // The sender stopped while settling a partial result: remove the turns the engine stored; the
      // others stay queued and are sent again.
      for (const name of manifest.stored) await discard(join(directory, name));
      await dropManifest(thread);
      log('capture:queue:partly-stored-after-restart');
      continue;
    }
    if (manifest.files.every(name => seen.has(name))) continue;
    // The gateway accepted this batch and the sender stopped while removing it: finish removing it.
    for (const entry of entries) if (manifest.files.includes(entry.name)) await discard(entry.path);
    await dropManifest(thread);
    log('capture:queue:acknowledged-after-restart');
  }
  const gateway = hash(gatewayBase);
  const threads = new Map();
  const now = clock();
  let discarded = 0;
  for (const entry of entries) {
    const present = await inspect(entry.path);
    if (!present) continue;
    entry.header = expired(entry.seq, now) ? null : await readHeader(entry.path);
    if (entry.header === undefined) continue;
    if (entry.header && entry.header.gateway !== gateway) continue; // Another deployment's turn.
    if (!entry.header || entry.header.account !== identity.binding || !identity.accountBound) {
      // Expired, damaged, queued for another account or before a sign-out, or for an unverified account.
      for (const [thread, manifest] of [...manifests]) if (manifest.files.includes(entry.name)) await dropManifest(thread);
      await discard(entry.path);
      discarded++;
      continue;
    }
    if (!threads.has(entry.header.thread)) threads.set(entry.header.thread, []);
    threads.get(entry.header.thread).push(entry);
  }
  if (discarded) log(`capture:queue:discarded:${discarded}`);
  summary.dropped += discarded;
  for (const [thread, manifest] of [...manifests]) {
    const queue = threads.get(thread) ?? [];
    // A record that no longer heads its thread's queue cannot be resent as it was.
    if (!manifest.files.every((name, index) => queue[index]?.name === name)) await dropManifest(thread);
  }
  const sendContext = { ...context, account: identity.binding, protection: protectionFor(identity), manifests };
  const waits = run.previous?.generation === identity.generation ? run.previous.conversations : {};
  const queued = new Set(threads.keys());
  const started = clock();
  for (const queue of [...threads.values()].sort((a, b) => a[0].seq - b[0].seq || (a[0].name < b[0].name ? -1 : 1))) {
    const thread = queue[0].header.thread;
    // A conversation that failed earlier in this run, or whose wait is not over, is left for later.
    if (run.failed.has(thread) || (!force && waits[thread]?.retryAt > started)) continue;
    run.attempted.add(thread);
    sendContext.retryAfterMs = 0;
    const failure = await sendThread(queue, sendContext);
    if (!queue.length) queued.delete(thread);
    if (!failure) continue;
    const wait = { error: failure, retryAfterMs: sendContext.retryAfterMs };
    if (CONVERSATION_FAILURES.has(failure)) {
      // Only this conversation waits; the others are still sent in this run.
      summary.error ??= failure;
      run.failed.set(thread, wait);
      log(`capture:queue:conversation-retry-later:${failure}`);
      continue;
    }
    summary.error = failure;
    run.stop = wait;
    log(`capture:queue:retry-later:${failure}`);
    return { seen, stopped: true, queued };
  }
  return { seen, stopped: false, queued };
}

/**
 * Send queued turns: each conversation's turns in queue order, batched, and only for the account that
 * queued them. One sender runs at a time. A failure that only one conversation meets leaves the others
 * to be sent; the run stops for failures that would meet them all (sign-in, network, timeout, rate limit,
 * credential store). After releasing its lease the sender looks for turns queued meanwhile, so a hook
 * that saw the lease held never strands its turn.
 */
export async function flushCaptures({ client, stateDir = client?.config?.stateDir, gatewayBase = client?.config?.gatewayBase,
  protectionFor, clock = Date.now, log = () => {}, relaunch, force = false } = {}) {
  const summary = { sent: 0, dropped: 0, error: null, busy: false, generation: null };
  if (typeof stateDir !== 'string' || typeof gatewayBase !== 'string' || typeof client?.capture !== 'function'
    || typeof protectionFor !== 'function') return summary;
  let directory;
  try {
    directory = await existingDirectory(stateDir);
  } catch (error) {
    summary.error = queueFailure(error);
    return summary;
  }
  if (!directory) return summary;
  // What this run attempted, which conversations failed, and a failure that stopped it.
  const run = { attempted: new Set(), failed: new Map(), stop: null };
  for (let pass = 0; pass < QUEUE_LIMITS.passes; pass++) {
    const lease = await lockFile(join(directory, 'flush.lock'), { ttlMs: QUEUE_LIMITS.leaseMs, clock }).catch(() => null);
    if (!lease) {
      summary.busy = true;
      break;
    }
    let seen = new Set();
    let stopped = true;
    try {
      if (!('previous' in run)) run.previous = await readStatus(directory);
      // A session start or end that found this run going asked it to retry every conversation.
      if (await inspect(join(directory, FORCE_REQUEST)).catch(() => null)) {
        await discard(join(directory, FORCE_REQUEST)).catch(() => {});
        force = true;
      }
      let queued;
      ({ seen, stopped, queued } = await sendQueued({ directory, client, gatewayBase, protectionFor, clock, log, lease, summary, run, force }));
      await recordOutcome(directory, run, summary.generation, queued, clock);
    } catch (error) {
      summary.error = queueFailure(error);
      run.stop = { error: summary.error };
      // Another sender took over after this one stalled; it owns the outcome now.
      if (summary.error !== 'lease-lost') await recordOutcome(directory, run, summary.generation, null, clock);
    } finally {
      await lease.release();
    }
    // Each pass handles every turn it listed, so only turns queued since then need another pass, or a
    // request made meanwhile to retry every conversation, unless this run already does.
    const requested = !force && Boolean(await inspect(join(directory, FORCE_REQUEST)).catch(() => null));
    if (stopped || (!requested && !(await entryNames(directory)).some(name => !seen.has(name)))) return summary;
  }
  // Out of passes with turns still arriving: hand them to a fresh sender rather than strand them.
  if (!summary.busy && typeof relaunch === 'function') await relaunch().catch(() => {});
  return summary;
}
