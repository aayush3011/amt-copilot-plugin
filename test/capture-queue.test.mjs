import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { lstat, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  QUEUE_LIMITS, clearCaptureQueue, conversationKey, enqueueTurn, enqueueTurns, flushCaptures, queueDirectory, startCaptureFlush,
} from '../src/capture-queue.mjs';

const gatewayBase = 'https://memory.example.test';
// The sign-in generation paces retries; the account binding owns the queued turns.
const generation = '11111111-2222-4333-8444-555555555555';
const otherGeneration = '99999999-2222-4333-8444-555555555555';
const account = createHash('sha256').update('fixture-account').digest('hex');
const otherAccount = createHash('sha256').update('other-account').digest('hex');
const sealing = {
  async protect(text) { return { version: 1, scheme: 'fixture', data: Buffer.from(text).toString('base64') }; },
  async unprotect(value) { return Buffer.from(value.data, 'base64').toString('utf8'); },
};

async function setup(t) {
  const dir = resolve('test', `.queue-fixture-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state');
  const requests = [];
  let identity = { binding: account, generation, tenantId: 'fixture-tenant', accountBound: true };
  let respond = async () => ({ status: 'succeeded' });
  const client = {
    config: { stateDir, gatewayBase },
    async captureIdentity() { return identity; },
    async capture(turn, options) {
      requests.push({ thread: turn.thread_id, items: turn.items.map(item => `${item.role}:${item.content}`), ...options });
      return respond(turn, options);
    },
  };
  const add = (threadId, role, content, extra = {}) => enqueueTurn({
    stateDir, gatewayBase, protection: sealing, account, threadId, role, content, ...extra,
  });
  const flush = (extra = {}) => flushCaptures({ client, protectionFor: () => sealing, ...extra });
  const files = async () => {
    try { return (await readdir(queueDirectory(stateDir))).filter(name => /^\d{16}-[a-f\d]{8}\.json$/.test(name)).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return {
    dir, stateDir, client, requests, add, flush, files,
    respondWith(handler) { respond = handler; },
    signIn(value) { identity = value; },
  };
}

test('queued turns are sealed, permission-restricted and named without session IDs', async t => {
  const q = await setup(t);
  await q.add('mh:claude:SECRET_SESSION_ID', 'user', 'PLAINTEXT_PROMPT_MARKER');
  const [name] = await q.files();
  assert.match(name, /^\d{16}-[a-f\d]{8}\.json$/);
  const path = join(queueDirectory(q.stateDir), name);
  const raw = await readFile(path, 'utf8');
  assert.ok(!/PLAINTEXT_PROMPT_MARKER|SECRET_SESSION_ID/.test(raw));
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['account', 'gateway', 'sealed', 'thread', 'version']);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await lstat(queueDirectory(q.stateDir))).mode & 0o777, 0o700);
  }
});

test('each thread is sent in queue order as one batch, with a stable idempotency key', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'A1');
  await q.add('thread-b', 'user', 'B1');
  await q.add('thread-a', 'agent', 'A2');
  await q.add('thread-b', 'agent', 'B2');
  await q.add('thread-a', 'user', 'A3');
  const summary = await q.flush();
  assert.equal(summary.sent, 5);
  assert.deepEqual(q.requests.map(({ thread, items }) => [thread, items]), [
    ['thread-a', ['user:A1', 'agent:A2', 'user:A3']],
    ['thread-b', ['user:B1', 'agent:B2']],
  ]);
  assert.ok(q.requests.every(request => /^mh-capture-[a-f\d]{64}$/.test(request.idempotencyKey) && request.binding === account));
  assert.notEqual(q.requests[0].idempotencyKey, q.requests[1].idempotencyKey);
  assert.deepEqual(await q.files(), []);
  assert.deepEqual(await q.flush(), { sent: 0, dropped: 0, error: null, busy: false, generation });
});

test('a failed send keeps the thread blocked in order and later resends the same batch first', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'A1');
  await q.add('thread-a', 'agent', 'A2');
  await q.add('thread-b', 'user', 'B1');
  q.respondWith(async () => { throw Object.assign(new Error('timed out'), { code: 'REQUEST_TIMEOUT' }); });
  const failed = await q.flush();
  assert.equal(failed.error, 'timeout');
  assert.equal(q.requests.length, 1);
  assert.equal((await q.files()).length, 3);
  await q.add('thread-a', 'user', 'A3');
  q.respondWith(async () => ({}));
  await q.flush();
  assert.deepEqual(q.requests.slice(1).map(({ items }) => items), [['user:A1', 'agent:A2'], ['user:A3'], ['user:B1']]);
  // The retry reuses the failed request's key, so a gateway that did accept it replays instead of duplicating.
  assert.equal(q.requests[1].idempotencyKey, q.requests[0].idempotencyKey);
  assert.deepEqual(await q.files(), []);
});

test('a refused batch is resent one turn at a time so only the refused turn is dropped', async t => {
  const q = await setup(t);
  for (const content of ['one', 'BAD', 'three']) await q.add('thread-a', 'user', content);
  q.respondWith(async turn => {
    if (turn.items.some(item => item.content === 'BAD')) throw Object.assign(new Error('rejected'), { status: 422 });
    return {};
  });
  const summary = await q.flush();
  assert.deepEqual({ sent: summary.sent, dropped: summary.dropped, error: summary.error }, { sent: 2, dropped: 1, error: null });
  assert.deepEqual(q.requests.map(({ items }) => items), [['user:one', 'user:BAD', 'user:three'], ['user:one'], ['user:BAD'], ['user:three']]);
  assert.deepEqual(await q.files(), []);
});

test('the queue is bounded: the oldest turns make room, never the batch being sent, and expired turns are dropped', async t => {
  const q = await setup(t);
  for (let index = 0; index < QUEUE_LIMITS.maxEntries; index++) await q.add('thread-a', 'user', `turn ${index}`);
  const names = await q.files();
  assert.equal(names.length, QUEUE_LIMITS.maxEntries);
  // An interrupted run was sending the two oldest turns; making room must not split that batch.
  const { thread } = JSON.parse(await readFile(join(queueDirectory(q.stateDir), names[0]), 'utf8'));
  const key = `mh-capture-${'a'.repeat(64)}`;
  await writeFile(join(queueDirectory(q.stateDir), `sending-${thread}.json`), JSON.stringify({ version: 1, thread, key, files: names.slice(0, 2) }));
  for (let index = QUEUE_LIMITS.maxEntries; index < QUEUE_LIMITS.maxEntries + 5; index++) await q.add('thread-a', 'user', `turn ${index}`);
  const after = await q.files();
  assert.equal(after.length, QUEUE_LIMITS.maxEntries);
  assert.deepEqual(after.slice(0, 2), names.slice(0, 2));
  await q.flush();
  assert.deepEqual(q.requests[0].items, ['user:turn 0', 'user:turn 1']);
  assert.equal(q.requests[0].idempotencyKey, key);
  assert.equal(q.requests[1].items[0], 'user:turn 7');
  assert.equal(q.requests.flatMap(request => request.items).length, QUEUE_LIMITS.maxEntries);
  assert.ok(q.requests.every(request => request.items.length <= QUEUE_LIMITS.batchItems));
  const large = 'x'.repeat(60 * 1024);
  for (let index = 0; index < 60; index++) await q.add('thread-b', 'agent', large);
  const sizes = await Promise.all((await q.files()).map(async name => (await lstat(join(queueDirectory(q.stateDir), name))).size));
  assert.ok(sizes.reduce((sum, size) => sum + size, 0) <= QUEUE_LIMITS.maxBytes);
  let now = Date.now();
  await q.add('thread-c', 'user', 'old turn', { clock: () => now });
  now += QUEUE_LIMITS.maxAgeMs + 60_000;
  q.requests.length = 0;
  await q.add('thread-c', 'user', 'new turn', { clock: () => now });
  await q.flush({ clock: () => now });
  assert.ok(!q.requests.some(request => request.items.includes('user:old turn')));
  assert.ok(q.requests.some(request => request.items.includes('user:new turn')));
});

test('turns stay with their account: a new sign-in to it sends them, another account or a sign-out discards them', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'Queued before signing in again.');
  q.signIn({ binding: account, generation: otherGeneration, tenantId: 'fixture-tenant', accountBound: true });
  assert.equal((await q.flush()).sent, 1);
  assert.deepEqual(q.requests.map(({ items, binding }) => [items, binding]), [[['user:Queued before signing in again.'], account]]);
  await q.add('thread-a', 'user', 'Queued before switching accounts.');
  q.signIn({ binding: otherAccount, generation, tenantId: 'fixture-tenant', accountBound: true });
  assert.equal((await q.flush()).dropped, 1);
  assert.equal(q.requests.length, 1);
  await q.add('thread-a', 'user', 'Queued before signing out.', { account: otherAccount });
  q.signIn(null);
  assert.equal((await q.flush()).dropped, 1);
  assert.deepEqual(await q.files(), []);
  assert.equal(q.requests.length, 1);
  q.signIn({ binding: account, generation, tenantId: 'fixture-tenant', accountBound: true });
  await q.add('thread-a', 'user', 'Cleared by logout.');
  await clearCaptureQueue(q.stateDir);
  assert.deepEqual(await q.files(), []);
});

test('turns for another deployment are left for it, and unreadable turns are dropped', async t => {
  const q = await setup(t);
  await enqueueTurn({ stateDir: q.stateDir, gatewayBase: 'https://other.example.test', protection: sealing, account, threadId: 'thread-x', role: 'user', content: 'Other gateway.' });
  await q.add('thread-a', 'user', 'Unreadable.');
  await q.add('thread-a', 'agent', 'Readable.');
  const unreadable = { ...sealing, async unprotect(value) {
    const text = await sealing.unprotect(value);
    if (text.includes('Unreadable.')) throw new Error('tampered');
    return text;
  } };
  const summary = await q.flush({ protectionFor: () => unreadable });
  assert.deepEqual({ sent: summary.sent, dropped: summary.dropped }, { sent: 1, dropped: 1 });
  assert.deepEqual(q.requests.map(({ items }) => items), [['agent:Readable.']]);
  assert.equal((await q.files()).length, 1);
});

test('after a conversation fails only it waits: others, session boundaries and new sign-ins still start a sender', async t => {
  const q = await setup(t);
  let now = Date.now();
  const clock = () => now;
  let launches = 0;
  const launch = async () => { launches++; };
  const a = conversationKey(gatewayBase, 'thread-a');
  const b = conversationKey(gatewayBase, 'thread-b');
  const start = options => startCaptureFlush({ stateDir: q.stateDir, generation, clock, launch, ...options });
  assert.equal(await start({ conversation: a, queued: true }), false);
  await q.add('thread-a', 'user', 'Pending.');
  q.respondWith(async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); });
  assert.equal((await q.flush({ clock })).error, 'server');
  // The failed conversation's hooks, and hooks that queued nothing, wait; a turn queued elsewhere goes now.
  assert.equal(await start({ conversation: a, queued: true }), false);
  assert.equal(await start({ conversation: b }), false);
  assert.equal(await start({ conversation: b, queued: true }), true);
  assert.equal(await start({ conversation: a, queued: true, force: true }), true);
  assert.equal(await start({ conversation: a, queued: true, generation: otherGeneration }), true);
  now += QUEUE_LIMITS.retryBaseMs + 1;
  assert.equal(await start({ conversation: a, queued: true }), true);
  assert.equal(await start({ conversation: b }), true);
  assert.equal(launches, 5);
  // A failure that would meet every conversation makes every hook wait.
  q.respondWith(async () => { throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }); });
  assert.equal((await q.flush({ clock })).error, 'transport');
  const status = JSON.parse(await readFile(join(queueDirectory(q.stateDir), 'status.json'), 'utf8'));
  assert.equal(status.run.error, 'transport');
  assert.equal(await start({ conversation: b, queued: true }), false);
  now += QUEUE_LIMITS.retryBaseMs + 1;
  assert.equal(await start({ conversation: b, queued: true }), true);
  q.respondWith(async () => ({}));
  await q.flush({ clock });
  await assert.rejects(readFile(join(queueDirectory(q.stateDir), 'status.json')), { code: 'ENOENT' });
});

test('one sender runs at a time, and a crashed sender\'s lease expires', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'Pending.');
  const lease = join(queueDirectory(q.stateDir), 'flush.lock');
  await writeFile(lease, '');
  let launches = 0;
  assert.equal(await startCaptureFlush({ stateDir: q.stateDir, generation, launch: async () => { launches++; } }), false);
  assert.equal((await q.flush()).busy, true);
  assert.equal(q.requests.length, 0);
  const stale = new Date(Date.now() - QUEUE_LIMITS.leaseMs - 1000);
  await utimes(lease, stale, stale);
  assert.equal(await startCaptureFlush({ stateDir: q.stateDir, generation, launch: async () => { launches++; } }), true);
  assert.equal((await q.flush()).sent, 1);
  assert.equal(launches, 1);
  await assert.rejects(lstat(lease), { code: 'ENOENT' });
});

test('linked queue entries and directories are never followed', { skip: process.platform === 'win32' }, async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'Real turn.');
  const outside = join(q.dir, 'outside.json');
  await writeFile(outside, 'UNRELATED');
  await symlink(outside, join(queueDirectory(q.stateDir), '0000000000000001-deadbeef.json'));
  await q.flush();
  assert.equal(await readFile(outside, 'utf8'), 'UNRELATED');
  assert.deepEqual(q.requests.map(({ items }) => items), [['user:Real turn.']]);
  const linked = await setup(t);
  const target = join(linked.dir, 'elsewhere');
  await mkdir(target);
  await mkdir(linked.stateDir);
  await symlink(target, queueDirectory(linked.stateDir));
  await assert.rejects(linked.add('thread-a', 'user', 'Never written.'), { code: 'UNSAFE_STATE' });
  assert.deepEqual(await readdir(target), []);
  await assert.rejects(clearCaptureQueue(linked.stateDir), /unsafe-directory/);
  assert.equal((await linked.flush()).error, 'unsafe-directory');
  assert.deepEqual(await readdir(target), []);
});

test('a sender with nothing queued creates no state', async t => {
  const q = await setup(t);
  assert.deepEqual(await q.flush(), { sent: 0, dropped: 0, error: null, busy: false, generation: null });
  await assert.rejects(lstat(q.stateDir), { code: 'ENOENT' });
});

test('invalid turns are refused before anything is written', async t => {
  const q = await setup(t);
  for (const [role, content, extra] of [['system', 'x'], ['user', ''], ['user', '   '], ['user', 'x'.repeat(QUEUE_LIMITS.contentBytes + 1)],
    ['user', 'x', { account: 'not-an-account' }], ['user', 'x', { threadId: '' }]]) {
    await assert.rejects(q.add('thread-a', role, content, extra), /invalid-turn/);
  }
  assert.deepEqual(await q.files(), []);
});

test('a batch the gateway accepted is not resent when the sender stopped while removing it', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'A1');
  await q.add('thread-a', 'agent', 'A2');
  const names = await q.files();
  const { thread } = JSON.parse(await readFile(join(queueDirectory(q.stateDir), names[0]), 'utf8'));
  await writeFile(join(queueDirectory(q.stateDir), `sending-${thread}.json`),
    JSON.stringify({ version: 1, thread, key: `mh-capture-${'b'.repeat(64)}`, files: names }));
  await rm(join(queueDirectory(q.stateDir), names[0]));
  await q.flush();
  assert.equal(q.requests.length, 0);
  assert.deepEqual(await q.files(), []);
  await assert.rejects(lstat(join(queueDirectory(q.stateDir), `sending-${thread}.json`)), { code: 'ENOENT' });
});

test('after a refusal each turn is retried on its own with its own key', async t => {
  const q = await setup(t);
  for (const content of ['one', 'BAD', 'three']) await q.add('thread-a', 'user', content);
  let offline = false;
  q.respondWith(async turn => {
    if (turn.items.some(item => item.content === 'BAD')) throw Object.assign(new Error('rejected'), { status: 422 });
    if (offline) throw Object.assign(new Error('timed out'), { code: 'REQUEST_TIMEOUT' });
    return {};
  });
  offline = true;
  assert.equal((await q.flush()).error, 'timeout');
  assert.deepEqual(q.requests.map(({ items }) => items), [['user:one', 'user:BAD', 'user:three'], ['user:one']]);
  offline = false;
  await q.flush();
  assert.deepEqual(q.requests.slice(2).map(({ items }) => items), [['user:one'], ['user:BAD', 'user:three'], ['user:BAD'], ['user:three']]);
  // The single that timed out is resent with the same key, so an accepted copy is replayed.
  assert.equal(q.requests[2].idempotencyKey, q.requests[1].idempotencyKey);
  assert.deepEqual(await q.files(), []);
});

test('an unavailable credential store or unreadable sign-in keeps queued turns for later', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'Keep me.');
  const locked = {
    async protect() { throw Object.assign(new Error('locked'), { code: 'SECURE_CACHE_UNAVAILABLE' }); },
    async unprotect() { throw Object.assign(new Error('locked'), { code: 'SECURE_CACHE_UNAVAILABLE' }); },
  };
  assert.equal((await q.flush({ protectionFor: () => locked })).error, 'protection');
  assert.equal((await q.files()).length, 1);
  q.client.captureIdentity = async () => { throw Object.assign(new Error('unreadable'), { code: 'STATE_IO_ERROR' }); };
  assert.equal((await q.flush()).error, 'sign-in');
  assert.equal((await q.files()).length, 1);
  q.client.captureIdentity = async () => ({ binding: account, generation, tenantId: 'fixture-tenant', accountBound: true });
  assert.equal((await q.flush()).sent, 1);
});

test('nothing is queued once the sign-in has changed, even if it changed while sealing', async t => {
  const q = await setup(t);
  await assert.rejects(q.add('thread-a', 'user', 'After logout.', { confirm: async () => false }), /signed-out/);
  await assert.rejects(q.add('thread-a', 'user', 'Unknown state.', { confirm: async () => { throw new Error('io'); } }), /signed-out/);
  assert.deepEqual(await q.files(), []);
  await q.add('thread-a', 'user', 'Still signed in.', { confirm: async () => true });
  assert.equal((await q.files()).length, 1);
});

test('a turn queued while the sender finds nothing to send is not stranded', async t => {
  const q = await setup(t);
  await enqueueTurn({ stateDir: q.stateDir, gatewayBase: 'https://other.example.test', protection: sealing, account, threadId: 'thread-x', role: 'user', content: 'Other gateway.' });
  let calls = 0;
  q.client.captureIdentity = async () => {
    // After the sender listed the queue, a hook queues a turn and sees the lease held, so it starts no sender.
    if (++calls === 1) {
      await q.add('thread-a', 'user', 'Arrived meanwhile.');
      assert.equal(await startCaptureFlush({ stateDir: q.stateDir, generation, launch: async () => assert.fail('lease is held') }), false);
    }
    return { binding: account, generation, tenantId: 'fixture-tenant', accountBound: true };
  };
  const summary = await q.flush();
  assert.equal(calls, 2);
  assert.equal(summary.sent, 1);
  assert.deepEqual(q.requests.map(({ items }) => items), [['user:Arrived meanwhile.']]);
});

test('a turn that fails to open once is retried before it is treated as damaged', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'Flaky store.');
  let failures = 1;
  const flaky = { ...sealing, async unprotect(value) {
    if (failures-- > 0) throw Object.assign(new Error('transient'), { code: 'SECURE_CACHE_UNAVAILABLE' });
    return sealing.unprotect(value);
  } };
  const summary = await q.flush({ protectionFor: () => flaky });
  assert.deepEqual({ sent: summary.sent, dropped: summary.dropped }, { sent: 1, dropped: 0 });
});

test('logout waits for an enqueue holding the queue lock, then purges', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'Queued.');
  const lock = join(queueDirectory(q.stateDir), 'queue.lock');
  await writeFile(lock, '');
  let cleared = false;
  const clearing = clearCaptureQueue(q.stateDir).then(() => { cleared = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(cleared, false);
  assert.equal((await q.files()).length, 1);
  await rm(lock);
  await clearing;
  assert.deepEqual(await q.files(), []);
});

test('a sender that runs out of passes while turns keep arriving hands them to a successor', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'First.');
  let arrivals = 0;
  q.client.captureIdentity = async () => {
    await q.add('thread-a', 'user', `Arrival ${++arrivals}.`);
    return { binding: account, generation, tenantId: 'fixture-tenant', accountBound: true };
  };
  let relaunched = 0;
  const summary = await q.flush({ relaunch: async () => { relaunched++; } });
  assert.equal(arrivals, QUEUE_LIMITS.passes);
  assert.equal(summary.sent, QUEUE_LIMITS.passes);
  assert.equal(relaunched, 1);
  assert.equal((await q.files()).length, 1);
});

const problem = (status, code, extra = {}) => Object.assign(new Error('HTTP error'), { code: 'HTTP_ERROR', status, ...(code ? { problem: code } : {}), ...extra });

test('a conflict such as a memory reset keeps the batch whole and resends it later with the same key', async t => {
  const q = await setup(t);
  for (const content of ['A1', 'A2', 'A3']) await q.add('thread-a', 'user', content);
  let reply = async () => { throw problem(409, 'reset_in_progress', { retryAfterSeconds: 5 }); };
  q.respondWith((...args) => reply(...args));
  const first = await q.flush();
  assert.deepEqual({ sent: first.sent, dropped: first.dropped, error: first.error }, { sent: 0, dropped: 0, error: 'conflict' });
  // Not split into single turns, and nothing dropped.
  assert.equal(q.requests.length, 1);
  assert.equal((await q.files()).length, 3);
  for (const code of ['stale_generation', 'write_conflict', undefined]) {
    reply = async () => { throw problem(409, code); };
    assert.equal((await q.flush({ force: true })).error, 'conflict');
  }
  reply = async () => ({});
  assert.equal((await q.flush({ force: true })).sent, 3);
  assert.equal(new Set(q.requests.map(request => request.idempotencyKey)).size, 1);
  assert.ok(q.requests.every(request => request.items.join() === 'user:A1,user:A2,user:A3'));
  assert.deepEqual(await q.files(), []);
});

test('an idempotency conflict means the batch was delivered before: it is removed, not split or resent', async t => {
  const q = await setup(t);
  for (const content of ['A1', 'A2']) await q.add('thread-a', 'user', content);
  await q.add('thread-a', 'agent', 'A3');
  let calls = 0;
  q.respondWith(async () => {
    if (++calls === 1) throw problem(409, 'idempotency_conflict');
    return {};
  });
  const logs = [];
  const summary = await q.flush({ log: message => logs.push(message) });
  assert.deepEqual({ sent: summary.sent, dropped: summary.dropped, error: summary.error }, { sent: 3, dropped: 0, error: null });
  assert.equal(q.requests.length, 1);
  assert.deepEqual(await q.files(), []);
  assert.ok(logs.includes('capture:queue:already-delivered'));
});

test('400, 413 and 422 still refuse a turn; a rate limit stops the run and its longer Retry-After is honored', async t => {
  for (const status of [400, 413, 422]) {
    const q = await setup(t);
    await q.add('thread-a', 'user', 'Refused.');
    q.respondWith(async () => { throw problem(status, 'invalid_request'); });
    assert.deepEqual(await q.flush().then(({ sent, dropped }) => ({ sent, dropped })), { sent: 0, dropped: 1 });
    assert.deepEqual(await q.files(), []);
  }
  const q = await setup(t);
  await q.add('thread-a', 'user', 'Rate limited.');
  const now = Date.now();
  q.respondWith(async () => { throw problem(429, undefined, { retryAfterSeconds: 120 }); });
  assert.equal((await q.flush({ clock: () => now })).error, 'throttled');
  const status = JSON.parse(await readFile(join(queueDirectory(q.stateDir), 'status.json'), 'utf8'));
  assert.equal(status.run.retryAt, now + 120_000);
});

test('the parts of one message are queued together, in order, and sent before later turns', async t => {
  const q = await setup(t);
  await enqueueTurns({
    stateDir: q.stateDir, gatewayBase, protection: sealing, account, threadId: 'thread-a',
    turns: ['Part 1', 'Part 2', 'Part 3'].map(content => ({ role: 'user', content })),
  });
  await q.add('thread-a', 'agent', 'Reply.');
  const names = await q.files();
  assert.equal(names.length, 4);
  assert.deepEqual(names.map(name => Number(name.slice(0, 16))).slice(1, 3),
    [Number(names[0].slice(0, 16)) + 1, Number(names[0].slice(0, 16)) + 2]);
  await q.flush();
  assert.deepEqual(q.requests.map(({ items }) => items), [['user:Part 1', 'user:Part 2', 'user:Part 3', 'agent:Reply.']]);
  await assert.rejects(enqueueTurns({ stateDir: q.stateDir, gatewayBase, protection: sealing, account, threadId: 'thread-a',
    turns: [{ role: 'user', content: 'Fine.' }, { role: 'user', content: ' ' }] }), /invalid-turn/);
  await assert.rejects(enqueueTurns({ stateDir: q.stateDir, gatewayBase, protection: sealing, account, threadId: 'thread-a', turns: [] }), /invalid-turn/);
  assert.deepEqual(await q.files(), []);
});

test('a message is removed whole when a write fails after its file became visible', { skip: process.platform === 'win32' }, async t => {
  const q = await setup(t);
  // Fail the second part's directory sync, which runs after its file was renamed into place.
  const promises = createRequire(import.meta.url)('node:fs/promises');
  const original = promises.open;
  let directorySyncs = 0;
  t.mock.method(promises, 'open', function (path, flags, ...rest) {
    if (typeof flags === 'number' && (flags & constants.O_DIRECTORY) && String(path).endsWith('capture-queue') && ++directorySyncs === 2) {
      return Promise.reject(Object.assign(new Error('directory sync failed'), { code: 'EIO' }));
    }
    return original.call(this, path, flags, ...rest);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(enqueueTurns({ stateDir: q.stateDir, gatewayBase, protection: sealing, account, threadId: 'thread-a',
      turns: ['Part 1', 'Part 2', 'Part 3'].map(content => ({ role: 'user', content })) }));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(directorySyncs, 2);
  assert.deepEqual(await q.files(), []);
});

test('turns queued under a sign-in without a recorded account are never sent; its account is recorded once', async t => {
  const q = await setup(t);
  const unbound = createHash('sha256').update('unbound-sign-in').digest('hex');
  await q.add('thread-a', 'user', 'Before the account was recorded.', { account: unbound });
  let recorded = false;
  q.client.captureIdentity = async () => (recorded
    ? { binding: account, generation, tenantId: 'fixture-tenant', accountBound: true }
    : { binding: unbound, generation, tenantId: 'fixture-tenant', accountBound: false });
  // If the account cannot be recorded, nothing is sent and the unverifiable turns are discarded.
  q.client.recordAccount = async () => { throw new Error('sign-in lock busy'); };
  assert.deepEqual(await q.flush().then(({ sent, dropped }) => ({ sent, dropped })), { sent: 0, dropped: 1 });
  await q.add('thread-a', 'user', 'Also before.', { account: unbound });
  const logs = [];
  q.client.recordAccount = async () => { recorded = true; return true; };
  assert.deepEqual(await q.flush({ log: message => logs.push(message) }).then(({ sent, dropped }) => ({ sent, dropped })), { sent: 0, dropped: 1 });
  assert.ok(logs.includes('capture:queue:account-recorded'));
  await q.add('thread-a', 'user', 'After the account was recorded.');
  assert.equal((await q.flush()).sent, 1);
  assert.deepEqual(q.requests.map(({ items }) => items), [['user:After the account was recorded.']]);
});

// A request the engine finished as failed; when every write failed, its record has no error code.
const finished = (status, code) => Object.assign(new Error('HTTP error'),
  { code: 'HTTP_ERROR', status, requestFailure: { ...(code ? { code } : {}), requestId: 'fixture-request' } });
const failureCount = header => ({ failedRequests: header.failedRequests, firstFailedAt: header.firstFailedAt });
const turnHeader = async (q, name) => JSON.parse(await readFile(join(queueDirectory(q.stateDir), name), 'utf8'));
const records = async q => (await readdir(queueDirectory(q.stateDir))).filter(file => /^sending-[a-f\d]{64}\.json$/.test(file));

test('a turn whose request finished as failed is retried under a new key each time, and dropped only after two keys and an hour', async t => {
  const q = await setup(t);
  const started = Date.now();
  let now = started;
  const clock = () => now;
  await q.add('thread-a', 'user', 'A1');
  const [name] = await q.files();
  const { thread } = await turnHeader(q, name);
  const recorded = [];
  q.respondWith(async () => {
    // The key in use is recorded before each request is sent.
    recorded.push(JSON.parse(await readFile(join(queueDirectory(q.stateDir), `sending-${thread}.json`), 'utf8')).key);
    throw finished(503);
  });
  assert.equal((await q.flush({ clock })).error, 'finished');
  assert.deepEqual(failureCount(await turnHeader(q, name)), { failedRequests: 1, firstFailedAt: started });
  assert.deepEqual(await records(q), []);
  // Failing again within the hour, as during a storage incident, it is kept and retried.
  for (const minutes of [1, 59]) {
    now = started + minutes * 60_000;
    assert.equal((await q.flush({ clock, force: true })).dropped, 0);
  }
  assert.deepEqual(failureCount(await turnHeader(q, name)), { failedRequests: 3, firstFailedAt: started });
  const logs = [];
  now = started + QUEUE_LIMITS.failedTurnMs;
  const last = await q.flush({ clock, force: true, log: message => logs.push(message) });
  assert.deepEqual({ sent: last.sent, dropped: last.dropped, error: last.error }, { sent: 0, dropped: 1, error: null });
  assert.ok(logs.includes('capture:queue:dropped:kept-failing'));
  assert.deepEqual(await q.files(), []);
  const keys = q.requests.map(request => request.idempotencyKey);
  assert.equal(new Set(keys).size, 4);
  assert.deepEqual(recorded, keys);
});

test('a turn is never dropped for its first failed request, and is retried however long ago that was', async t => {
  const q = await setup(t);
  let now = Date.now();
  const clock = () => now;
  await q.add('thread-a', 'user', 'A1');
  let failing = true;
  q.respondWith(async () => {
    if (failing) throw finished(504, 'deadline_exceeded');
    return {};
  });
  assert.equal((await q.flush({ clock })).error, 'finished');
  now += 2 * QUEUE_LIMITS.failedTurnMs;
  failing = false;
  assert.equal((await q.flush({ clock, force: true })).sent, 1);
  await q.add('thread-a', 'user', 'A2');
  failing = true;
  assert.equal((await q.flush({ clock })).error, 'finished');
  now += 2 * QUEUE_LIMITS.failedTurnMs;
  assert.equal((await q.flush({ clock, force: true })).dropped, 1);
  assert.deepEqual(q.requests.map(({ items }) => items), [['user:A1'], ['user:A1'], ['user:A2'], ['user:A2']]);
});

test('a clock set back restarts the hour before a failing turn is dropped, rather than prolonging it', async t => {
  const q = await setup(t);
  const started = Date.now();
  let now = started;
  const clock = () => now;
  await q.add('thread-a', 'user', 'A1');
  q.respondWith(async () => { throw finished(503); });
  await q.flush({ clock });
  now = started - 24 * QUEUE_LIMITS.failedTurnMs;
  assert.equal((await q.flush({ clock, force: true })).dropped, 0);
  now += QUEUE_LIMITS.failedTurnMs;
  assert.equal((await q.flush({ clock, force: true })).dropped, 1);
});

test('a replayed failure of the same request counts once', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'A1');
  const [name] = await q.files();
  let reply = async () => { throw Object.assign(new Error('timed out'), { code: 'REQUEST_TIMEOUT' }); };
  q.respondWith((...args) => reply(...args));
  assert.equal((await q.flush()).error, 'timeout');
  // The engine finished the request meanwhile; resent under the same key, its failure is replayed.
  reply = async () => { throw finished(503); };
  assert.equal((await q.flush()).error, 'finished');
  assert.equal(q.requests[1].idempotencyKey, q.requests[0].idempotencyKey);
  assert.equal((await turnHeader(q, name)).failedRequests, 1);
  assert.equal((await q.flush({ force: true })).error, 'finished');
  assert.notEqual(q.requests[2].idempotencyKey, q.requests[1].idempotencyKey);
  assert.equal((await turnHeader(q, name)).failedRequests, 2);
});
test('the turns of a failed batch are retried alone, so one bad turn holds back only the turns after it, and not for long', async t => {
  const q = await setup(t);
  let now = Date.now();
  const clock = () => now;
  for (const content of ['A1', 'BAD', 'A3']) await q.add('thread-a', 'user', content);
  q.respondWith(async turn => {
    if (turn.items.some(item => item.content === 'BAD')) throw finished(409, 'write_conflict');
    return {};
  });
  assert.equal((await q.flush({ clock })).error, 'finished');
  // Within the hour, the bad turn is kept, and the turn after it waits, so the conversation stays in order.
  const second = await q.flush({ clock, force: true });
  assert.deepEqual({ sent: second.sent, dropped: second.dropped, error: second.error }, { sent: 1, dropped: 0, error: 'finished' });
  now += QUEUE_LIMITS.failedTurnMs;
  const third = await q.flush({ clock, force: true });
  assert.deepEqual({ sent: third.sent, dropped: third.dropped, error: third.error }, { sent: 1, dropped: 1, error: null });
  assert.deepEqual(q.requests.map(({ items }) => items),
    [['user:A1', 'user:BAD', 'user:A3'], ['user:A1'], ['user:BAD'], ['user:BAD'], ['user:A3']]);
  assert.equal(new Set(q.requests.map(request => request.idempotencyKey)).size, 5);
  assert.deepEqual(await q.files(), []);
});

test('a request that stored only some turns settles those, and the others count a failed request', async t => {
  const q = await setup(t);
  for (const content of ['A1', 'BAD', 'LOST', 'A4']) await q.add('thread-a', 'user', content);
  // The engine's partial result (207): one write failed, and another's outcome is unknown.
  const status = content => ({ BAD: 'failed', LOST: 'unknown' })[content] ?? 'stored';
  let reply = async turn => ({ request_id: 'fixture-request', status: 'partial',
    result: { items: turn.items.map((item, index) => ({ index, id: `turn-${index}`, status: status(item.content) })) } });
  q.respondWith((...args) => reply(...args));
  const logs = [];
  const first = await q.flush({ log: message => logs.push(message) });
  assert.deepEqual({ sent: first.sent, dropped: first.dropped, error: first.error }, { sent: 2, dropped: 0, error: 'finished' });
  assert.ok(logs.includes('capture:queue:partly-stored'));
  assert.deepEqual(await records(q), []);
  const remaining = await q.files();
  assert.equal(remaining.length, 2);
  for (const name of remaining) assert.equal((await turnHeader(q, name)).failedRequests, 1);
  // Each is retried alone under a new key. A turn whose outcome was unknown may be stored twice.
  reply = async () => ({ request_id: 'fixture-request', status: 'succeeded' });
  assert.equal((await q.flush({ force: true })).sent, 2);
  assert.deepEqual(q.requests.map(({ items }) => items),
    [['user:A1', 'user:BAD', 'user:LOST', 'user:A4'], ['user:BAD'], ['user:LOST']]);
  assert.equal(new Set(q.requests.map(request => request.idempotencyKey)).size, 3);
  assert.deepEqual(await q.files(), []);
});

test('a sender stopped while settling a partial result removes the stored turns afterwards, never sending them again', async t => {
  const q = await setup(t);
  for (const content of ['A1', 'BAD', 'A3', 'LOST']) await q.add('thread-a', 'user', content);
  const record = join(queueDirectory(q.stateDir), `sending-${conversationKey(gatewayBase, 'thread-a')}.json`);
  const settling = () => {
    try { return Array.isArray(JSON.parse(readFileSync(record, 'utf8')).stored); } catch { return false; }
  };
  // The sender stops just after recording which turns were stored, before it changed any turn.
  let stopped = false;
  const clock = () => {
    if (!stopped && settling()) {
      stopped = true;
      throw new Error('stopped');
    }
    return Date.now();
  };
  q.respondWith(async turn => ({ request_id: 'fixture-request', status: 'partial', result: { items: turn.items.map((item, index) =>
    ({ index, status: ['BAD', 'LOST'].includes(item.content) ? 'failed' : 'stored' })) } }));
  assert.equal((await q.flush({ clock })).error, 'io');
  assert.equal(stopped, true);
  assert.equal((await q.files()).length, 4);
  q.respondWith(async () => ({}));
  const logs = [];
  assert.equal((await q.flush({ log: message => logs.push(message) })).sent, 2);
  assert.ok(logs.includes('capture:queue:partly-stored-after-restart'));
  assert.deepEqual(q.requests.map(({ items }) => items), [['user:A1', 'user:BAD', 'user:A3', 'user:LOST'], ['user:BAD', 'user:LOST']]);
  assert.notEqual(q.requests[1].idempotencyKey, q.requests[0].idempotencyKey);
  assert.deepEqual(await q.files(), []);
  assert.deepEqual(await records(q), []);
});

test('a partial result that does not say which turns were stored has every turn sent again', async t => {
  // No list; a list that does not name the turns; and contradicting reports, either way round.
  for (const items of [undefined, 'not a list', [{ index: 9, status: 'stored' }, { index: '0', status: 'stored' }],
    [{ index: 0, status: 'failed' }, { index: 0, status: 'stored' }, { index: 1, status: 'stored' }, { index: 1, status: 'unknown' }]]) {
    const q = await setup(t);
    await q.add('thread-a', 'user', 'A1');
    await q.add('thread-a', 'user', 'A2');
    let partial = true;
    q.respondWith(async () => (partial ? { request_id: 'fixture-request', status: 'partial', result: { items } } : {}));
    assert.deepEqual(await q.flush().then(({ sent, error }) => ({ sent, error })), { sent: 0, error: 'finished' });
    partial = false;
    assert.equal((await q.flush({ force: true })).sent, 2);
    assert.deepEqual(q.requests.map(({ items: sent }) => sent), [['user:A1', 'user:A2'], ['user:A1'], ['user:A2']]);
  }
});

test('a request still running under its key is not taken for stored: the same batch and key are sent again later', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'A1');
  await q.add('thread-b', 'user', 'B1');
  let reply = async turn => (turn.thread_id === 'thread-a' ? { request_id: 'fixture-request', status: 'running' } : {});
  q.respondWith((...args) => reply(...args));
  const summary = await q.flush();
  assert.deepEqual({ sent: summary.sent, error: summary.error }, { sent: 1, error: 'unfinished' });
  assert.equal((await q.files()).length, 1);
  assert.equal((await records(q)).length, 1);
  reply = async () => ({ request_id: 'fixture-request', status: 'succeeded' });
  assert.equal((await q.flush({ force: true })).sent, 1);
  assert.equal(q.requests[2].idempotencyKey, q.requests[0].idempotencyKey);
  assert.deepEqual(await q.files(), []);
});
test('turns that a memory reset superseded are dropped, not stored afterwards', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'A1');
  await q.add('thread-a', 'agent', 'A2');
  await q.add('thread-b', 'user', 'B1');
  q.respondWith(async turn => {
    if (turn.thread_id === 'thread-a') throw finished(503, 'reset_superseded');
    return {};
  });
  const logs = [];
  const summary = await q.flush({ log: message => logs.push(message) });
  assert.deepEqual({ sent: summary.sent, dropped: summary.dropped, error: summary.error }, { sent: 1, dropped: 2, error: null });
  assert.equal(logs.filter(line => line === 'capture:queue:dropped:superseded').length, 2);
  assert.equal(q.requests.length, 2);
  assert.deepEqual(await q.files(), []);
});

test('one conversation\'s failure does not stop the others in the same run', async t => {
  for (const [failure, sameKey] of [[problem(503), true], [problem(409, 'reset_in_progress'), true], [finished(504, 'deadline_exceeded'), false]]) {
    const q = await setup(t);
    await q.add('thread-a', 'user', 'A1');
    await q.add('thread-b', 'user', 'B1');
    await q.add('thread-c', 'user', 'C1');
    let failing = true;
    q.respondWith(async turn => {
      if (failing && turn.thread_id === 'thread-a') throw failure;
      return {};
    });
    const logs = [];
    const summary = await q.flush({ log: message => logs.push(message) });
    assert.equal(summary.sent, 2);
    assert.ok(logs.some(line => line.startsWith('capture:queue:conversation-retry-later:')));
    assert.deepEqual(q.requests.map(request => request.thread), ['thread-a', 'thread-b', 'thread-c']);
    assert.equal((await q.files()).length, 1);
    // A failure before the request finished keeps the batch and key; a finished failure needs a new key.
    failing = false;
    assert.equal((await q.flush({ force: true })).sent, 1);
    assert.equal(q.requests[3].thread, 'thread-a');
    assert.equal(q.requests[3].idempotencyKey === q.requests[0].idempotencyKey, sameKey);
  }
});

test('a failure that would meet every conversation stops the run', async t => {
  for (const [failure, kind] of [[Object.assign(new Error('timed out'), { code: 'REQUEST_TIMEOUT' }), 'timeout'],
    [Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }), 'transport'], [problem(401), 'auth'], [problem(429), 'throttled']]) {
    const q = await setup(t);
    await q.add('thread-a', 'user', 'A1');
    await q.add('thread-b', 'user', 'B1');
    q.respondWith(async () => { throw failure; });
    assert.equal((await q.flush()).error, kind);
    assert.equal(q.requests.length, 1);
    assert.equal((await q.files()).length, 2);
  }
});

test('a conversation that failed waits for the next run, while turns queued meanwhile elsewhere are sent', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'A1');
  let arrived = false;
  q.respondWith(async turn => {
    if (turn.thread_id !== 'thread-a') return {};
    if (!arrived) {
      arrived = true;
      await q.add('thread-b', 'user', 'B1');
    }
    throw problem(503);
  });
  const summary = await q.flush();
  assert.equal(summary.sent, 1);
  assert.deepEqual(q.requests.map(request => request.thread), ['thread-a', 'thread-b']);
});

test('a conversation\'s wait grows with its own failures, honors Retry-After and ends once it is sent', async t => {
  const q = await setup(t);
  let now = Date.now();
  const clock = () => now;
  const status = async () => JSON.parse(await readFile(join(queueDirectory(q.stateDir), 'status.json'), 'utf8'));
  const a = conversationKey(gatewayBase, 'thread-a');
  let failing = true;
  q.respondWith(async turn => {
    if (failing && turn.thread_id === 'thread-a') throw problem(503, undefined, { retryAfterSeconds: 45 });
    return {};
  });
  await q.add('thread-a', 'user', 'A1');
  await q.flush({ clock });
  assert.deepEqual([(await status()).conversations[a].failures, (await status()).conversations[a].retryAt], [1, now + 45_000]);
  // Another conversation sent meanwhile leaves it alone, and it is not retried early.
  await q.add('thread-b', 'user', 'B1');
  assert.equal((await q.flush({ clock })).sent, 1);
  assert.equal((await status()).conversations[a].failures, 1);
  assert.equal(q.requests.filter(request => request.thread === 'thread-a').length, 1);
  now += 45_001;
  await q.flush({ clock });
  assert.deepEqual([(await status()).conversations[a].failures, (await status()).conversations[a].retryAt], [2, now + QUEUE_LIMITS.retryBaseMs * 2]);
  failing = false;
  assert.equal((await q.flush({ clock, force: true })).sent, 1);
  await assert.rejects(readFile(join(queueDirectory(q.stateDir), 'status.json')), { code: 'ENOENT' });
});

test('a conversation queued after another one failed is sent at once, and the failed one is not retried early', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'A1');
  q.respondWith(async turn => {
    if (turn.thread_id === 'thread-a') throw problem(503);
    return {};
  });
  assert.equal((await q.flush()).error, 'server');
  // The failed run is over; a hook in another conversation queues a turn and starts a sender right away.
  await q.add('thread-b', 'user', 'B1');
  let launched = false;
  assert.equal(await startCaptureFlush({ stateDir: q.stateDir, generation, conversation: conversationKey(gatewayBase, 'thread-b'),
    queued: true, launch: async () => { launched = true; } }), true);
  assert.equal(launched, true);
  assert.equal((await q.flush()).sent, 1);
  assert.deepEqual(q.requests.map(request => request.thread), ['thread-a', 'thread-b']);
  // Session start and end retry the waiting conversation.
  q.respondWith(async () => ({}));
  assert.equal((await q.flush({ force: true })).sent, 1);
});

test('a session boundary while a sender is running still has the waiting conversations retried', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'A1');
  q.respondWith(async () => { throw problem(503); });
  assert.equal((await q.flush()).error, 'server');
  await q.add('thread-b', 'user', 'B1');
  let requested;
  q.respondWith(async turn => {
    if (turn.thread_id === 'thread-b') {
      // Session end fires while this ordinary sender holds the lease; the sender takes over its request.
      requested = await startCaptureFlush({ stateDir: q.stateDir, generation, force: true,
        launch: async () => assert.fail('the running sender takes the request') });
    }
    return {};
  });
  const summary = await q.flush();
  assert.equal(requested, false);
  assert.equal(summary.sent, 2);
  assert.deepEqual(q.requests.map(request => request.thread), ['thread-a', 'thread-b', 'thread-a']);
  assert.deepEqual(await q.files(), []);
  assert.deepEqual((await readdir(queueDirectory(q.stateDir))).filter(name => name === 'force.json'), []);
});

test('a request to retry every conversation that cannot be removed neither stops nor repeats a run', async t => {
  const q = await setup(t);
  await q.add('thread-a', 'user', 'A1');
  // Unlink fails on a directory on every platform, like a request file another program holds open.
  await mkdir(join(queueDirectory(q.stateDir), 'force.json'));
  let relaunched = 0;
  const summary = await q.flush({ relaunch: async () => { relaunched++; } });
  assert.equal(summary.error, null);
  assert.equal(summary.sent, 1);
  assert.equal(relaunched, 0);
  assert.equal(q.requests.length, 1);
  assert.deepEqual(await q.files(), []);
});
