import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createClient } from '../src/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { referenceContext } from '../src/hooks.mjs';
import {
  TELEMETRY_LIMITS, TELEMETRY_NOTICE, TELEMETRY_NOTICE_VERSION, enqueueTelemetry, flushTelemetry,
  recordRecallTelemetry, telemetryCommand, telemetryPending, telemetrySnapshot, validTelemetryEvent, validateEnrollment,
} from '../src/telemetry.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';

const RET = 'ret_01JC3K00000000000000000000';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const problem = (code, status = 409) => json({ code, status, message: 'not logged' }, status);

async function setup(t) {
  const root = resolve('test', `.telemetry-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig({ home: root, env: {}, deployment: fixtureDeployment() });
  let now = Date.now(), account = 'fixture-user';
  const enrollment = { available: true, enrolled: false, epoch: 0, notice_version: null,
    current_notice_version: TELEMETRY_NOTICE_VERSION, enrolled_at: null, retention_days: 60, deletion: null };
  const calls = [];
  let intercept;
  const fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    const call = { url, method: options.method, body, headers: options.headers };
    calls.push(call);
    if (intercept) {
      const response = await intercept(call);
      if (response) return response;
    }
    if (url.includes('/telemetry/enrollment')) {
      if (options.method === 'POST') Object.assign(enrollment, { enrolled: true, epoch: enrollment.epoch + 1,
        notice_version: TELEMETRY_NOTICE_VERSION, enrolled_at: new Date(now).toISOString() });
      if (options.method === 'DELETE') enrollment.enrolled = false;
      return json(enrollment);
    }
    if (url.endsWith('/search')) return json({ items: [], count: 0 });
    return json({ status: 'recorded', event_id: body.event_id });
  };
  const client = createClient({ config, fetch, clock: () => now,
    acquireToken: async () => ({ accessToken: 'fixture-token', expiresAt: Math.floor(now / 1000) + 3600, objectId: account }) });
  await client.login();
  calls.length = 0;
  const logs = [];
  const clock = () => now;
  const log = line => logs.push(line);
  const statePath = async () => join(config.stateDir, (await readdir(config.stateDir)).find(name => /^telemetry-[a-f\d]{64}\.json$/.test(name)));
  const state = async () => JSON.parse(await readFile(await statePath(), 'utf8'));
  const enable = () => telemetryCommand(client, 'enable', TELEMETRY_NOTICE_VERSION);
  const outcome = (epoch = enrollment.epoch) => ({ kind: 'outcome', body: {
    event_id: randomUUID(), epoch, client_request_id: randomUUID(), surface: 'auto_recall_injection',
    occurred_at: new Date(now).toISOString(), trigger: 'auto_recall_first_prompt',
    attempts: 1, elapsed_ms: 20, final_outcome: 'timeout',
  } });
  const queue = async event => enqueueTelemetry(client, await telemetrySnapshot(client), [event ?? outcome()], enrollment.epoch, { clock, log });
  const flush = () => flushTelemetry({ client, clock, log });
  return { root, config, client, calls, enrollment, logs, clock, log, state, statePath, enable, outcome, queue, flush,
    advance: ms => { now += ms; }, account: value => { account = value; }, intercept: fn => { intercept = fn; } };
}

test('notice does not authenticate; explicit re-enable needs no separate approval flag', async t => {
  const f = await setup(t);
  assert.deepEqual(await telemetryCommand(f.client, 'notice'), { notice_version: TELEMETRY_NOTICE_VERSION, notice: TELEMETRY_NOTICE });
  assert.equal(f.calls.length, 0);
  await telemetryCommand(f.client, 'enable');
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST']);
  assert.deepEqual(f.calls[1].body, { notice_version: TELEMETRY_NOTICE_VERSION, expected_epoch: 0 });
  assert.equal((await telemetrySnapshot(f.client)).epoch, 1);
});

test('a policy version change does not add a re-consent gate to explicit re-enable', async t => {
  const f = await setup(t);
  f.enrollment.current_notice_version = 'new-version';
  assert.equal((await f.enable()).enrolled, true);
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST']);
});

test('default-on recorded recall queues metadata without a client enrollment POST', async t => {
  const f = await setup(t);
  Object.assign(f.enrollment, { enrolled: true, epoch: 1 });
  const result = { retrieval: { id: RET, recording: 'recorded', epoch: 1 }, items: [] };
  assert.equal(await recordRecallTelemetry({ client: f.client, snapshot: await telemetrySnapshot(f.client),
    result, rendered: referenceContext(result, 10, [], f.log), requestId: randomUUID(),
    startedAt: f.clock(), clock: f.clock }), true);
  assert.equal((await f.state()).enabled, true);
  assert.equal((await f.state()).events.length, 2);
  assert.equal(f.calls.length, 0);
});

test('enrollment accepts current and legacy retention without extending the local queue lifetime', async t => {
  const f = await setup(t);
  for (const days of [30, 60]) assert.equal(validateEnrollment({ ...f.enrollment, retention_days: days }).retention_days, days);
  assert.throws(() => validateEnrollment({ ...f.enrollment, retention_days: 90 }), { code: 'INVALID_RESPONSE' });
  assert.equal(TELEMETRY_LIMITS.ageMs, 30 * 24 * 60 * 60 * 1000);
});

test('engine enrollment and deletion timestamps accept UTC offsets and microsecond precision', async t => {
  const f = await setup(t);
  f.enrollment.enrolled_at = '2026-11-06T07:09:10.227192+00:00';
  f.enrollment.deletion = {
    request_id: 'tdel_01M6QV17PRKSDB7DKBAW3DE014', status: 'running',
    requested_at: '2026-11-06T07:09:10.232286+00:00', completed_at: null,
  };
  const result = await telemetryCommand(f.client, 'status');
  assert.equal(result.enrolled_at, f.enrollment.enrolled_at);
  assert.deepEqual(result.deletion, f.enrollment.deletion);
  f.enrollment.deletion.request_id = 'tdel_r_93fd33e590d84be0a3839e0c52f83c53';
  assert.deepEqual((await telemetryCommand(f.client, 'status')).deletion, f.enrollment.deletion);
  assert.throws(() => validateEnrollment({ ...f.enrollment, deletion: { ...f.enrollment.deletion, request_id: 'tdel_invalid/path' } }),
    { code: 'INVALID_RESPONSE' });
  assert.throws(() => validateEnrollment({ ...f.enrollment, enrolled_at: 'not-a-date' }), { code: 'INVALID_RESPONSE' });
});

test('search correlation is narrow metadata and does not change the request body', async t => {
  const f = await setup(t);
  const requestId = randomUUID();
  await f.client.search('a private query', 10, { requestId, attempt: 1, trigger: 'auto_recall_first_prompt' });
  assert.equal(f.calls[0].headers['x-memory-house-request'], `${requestId}; attempt=1`);
  assert.match(f.calls[0].headers['x-memory-house-client'], /^amt-copilot-plugin\/source; trigger=auto_recall_first_prompt$/);
  assert.deepEqual(f.calls[0].body, { query: 'a private query', top_k: 10 });
  await assert.rejects(f.client.search('query', 10, { requestId: 'private query' }), { code: 'INVALID_PAYLOAD' });
});

test('recorded recall queues only metadata and supplies exact whole-memory budget decisions', async t => {
  const f = await setup(t);
  await f.enable();
  const snapshot = await telemetrySnapshot(f.client);
  const result = { retrieval: { id: RET, recording: 'recorded', epoch: 1 }, items: [
    { rank: 1, id: 'secret-memory-id', content: 'Private memory contents.' },
    { rank: 2, content: 'q'.repeat(9000) },
  ] };
  const rendered = referenceContext(result, 10, [], f.log);
  await recordRecallTelemetry({ client: f.client, snapshot, result, rendered, requestId: randomUUID(),
    startedAt: f.clock() - 150, clock: f.clock, log: f.log });
  const state = await f.state();
  assert.equal(state.events.length, 2);
  assert.doesNotMatch(JSON.stringify(state), /secret-memory-id|Private memory|qqqq|fixture-token/);
  assert.deepEqual(state.events[0].body.items, [
    { rank: 1, supplied: 'full' }, { rank: 2, supplied: 'none', omit_reason: 'budget' },
  ]);
  assert.equal(state.events[0].body.supplied_bytes, Buffer.byteLength(rendered.context));
  assert.equal(state.events[1].body.used_retrieval_id, RET);
  assert.equal((await f.flush()).sent, 2);
  assert.equal((await f.state()).events.length, 0);
});

test('unrecorded/off responses never produce a delivery; an unenrolled first failure has no guessed epoch', async t => {
  const f = await setup(t);
  const snapshot = await telemetrySnapshot(f.client);
  assert.equal(await recordRecallTelemetry({ client: f.client, snapshot, error: Object.assign(new Error(), { code: 'REQUEST_TIMEOUT' }),
    requestId: randomUUID(), startedAt: f.clock(), clock: f.clock }), false);
  await f.enable();
  const result = { items: [], retrieval: { id: RET, recording: 'not_recorded', reason: 'ledger_error' } };
  await recordRecallTelemetry({ client: f.client, snapshot: await telemetrySnapshot(f.client), result,
    rendered: referenceContext(result, 10, [], f.log), requestId: randomUUID(), startedAt: f.clock(), clock: f.clock });
  assert.equal((await f.state()).events.length, 1);
  assert.equal((await f.state()).events[0].body.used_retrieval_id, undefined);
  result.retrieval = { id: RET, recording: 'off', reason: 'not_enrolled' };
  await recordRecallTelemetry({ client: f.client, snapshot: await telemetrySnapshot(f.client), result,
    requestId: randomUUID(), startedAt: f.clock(), clock: f.clock });
  assert.equal((await f.state()).events.length, 0);
  assert.equal((await f.state()).enabled, false);
});

test('timeout and HTTP outcomes do not require a retrieval ID or copy error text', async t => {
  const f = await setup(t);
  await f.enable();
  for (const error of [Object.assign(new Error('private-error'), { code: 'REQUEST_TIMEOUT' }),
    Object.assign(new Error('private-error'), { code: 'HTTP_ERROR', status: 503 }),
    Object.assign(new Error('private-error'), { code: 'INVALID_RESPONSE' }),
    Object.assign(new Error('private-error'), { code: 'RESPONSE_TOO_LARGE' })]) {
    await recordRecallTelemetry({ client: f.client, snapshot: await telemetrySnapshot(f.client), error,
      requestId: randomUUID(), startedAt: f.clock() - 5000, clock: f.clock });
  }
  const events = (await f.state()).events;
  assert.deepEqual(events.map(event => event.body.final_outcome), ['timeout', 'http_error', 'invalid_response', 'invalid_response']);
  assert.equal(events[1].body.http_status, 503);
  assert.doesNotMatch(JSON.stringify(events), /private-error/);
});

test('not-ready retrieval delivery retries in the background without requiring another hook', async t => {
  const f = await setup(t);
  await f.enable();
  await f.queue();
  let attempts = 0;
  f.intercept(call => call.url.endsWith('/request-outcomes') && ++attempts === 1 ? problem('retrieval_not_ready') : null);
  await flushTelemetry({ client: f.client, clock: f.clock, log: f.log, wait: async ms => f.advance(ms) });
  assert.equal(attempts, 2);
  assert.equal((await f.state()).events.length, 0);
});

test('retry preserves event ID, obeys backoff and only accepts a valid acknowledgement', async t => {
  const f = await setup(t);
  await f.enable();
  const event = f.outcome();
  await f.queue(event);
  f.intercept(call => call.url.endsWith('/request-outcomes') ? problem('temporary', 503) : null);
  await f.flush();
  assert.equal((await f.state()).events[0].body.event_id, event.body.event_id);
  const count = f.calls.length;
  await f.flush();
  assert.equal(f.calls.length, count);
  f.advance(30001);
  f.intercept(call => call.url.endsWith('/request-outcomes') ? json({ status: 'recorded', event_id: randomUUID() }) : null);
  await f.flush();
  assert.equal((await f.state()).events.length, 1);
  f.advance(60001);
  f.intercept(call => call.url.endsWith('/request-outcomes') ? json({ status: 'duplicate', event_id: randomUUID() }) : null);
  await f.flush();
  assert.equal((await f.state()).events.length, 0);
  assert.ok(f.calls.filter(call => call.url.endsWith('/request-outcomes')).every(call => call.body.event_id === event.body.event_id));
});

test('opt-out clears and fences events before contacting the server, including failed opt-out', async t => {
  const f = await setup(t);
  await f.enable();
  const old = await telemetrySnapshot(f.client);
  await f.queue();
  f.intercept(async call => {
    if (call.method === 'DELETE') {
      assert.equal((await f.state()).events.length, 0);
      assert.equal((await f.state()).pendingOptOut, true);
      assert.match(call.url, /\?epoch=1$/);
      return problem('temporary', 503);
    }
  });
  await assert.rejects(telemetryCommand(f.client, 'disable'), { code: 'TELEMETRY_OPT_OUT_PENDING' });
  assert.equal(await enqueueTelemetry(f.client, old, [f.outcome()], 1), false);
  assert.equal((await telemetryCommand(f.client, 'status')).local_collection_paused, true);
  const count = f.calls.length;
  await f.flush();
  assert.equal(f.calls.length, count);
  f.intercept(() => null);
  await telemetryCommand(f.client, 'disable');
  assert.equal((await f.state()).pendingOptOut, false);
  assert.equal((await f.state()).enabled, false);
});

test('sign-out and account changes cannot send earlier metadata', async t => {
  const f = await setup(t);
  await f.enable();
  await f.queue();
  const old = await telemetrySnapshot(f.client);
  await f.client.logout();
  assert.equal((await f.state()).events.length, 0);
  f.account('different-user');
  await f.client.login();
  assert.equal(await enqueueTelemetry(f.client, old, [f.outcome()], 1), false);
  await f.flush();
  assert.equal(f.calls.filter(call => call.url.endsWith('/request-outcomes')).length, 0);
});

test('server reset epoch rejection discards stale queue and refreshes enrollment without relabeling events', async t => {
  const f = await setup(t);
  await f.enable();
  await f.queue();
  await f.queue();
  f.enrollment.epoch = 2;
  f.intercept(call => call.url.endsWith('/request-outcomes') ? problem('enrollment_changed') : null);
  await f.flush();
  assert.equal((await f.state()).events.length, 0);
  assert.equal((await telemetrySnapshot(f.client)).epoch, 2);
  assert.equal(f.calls.filter(call => call.url.endsWith('/request-outcomes')).length, 1);
});

test('a late response cannot roll the local enrollment epoch backwards', async t => {
  const f = await setup(t);
  await f.enable();
  const old = await telemetrySnapshot(f.client);
  await enqueueTelemetry(f.client, old, [f.outcome(2)], 2);
  assert.equal(await enqueueTelemetry(f.client, old, [f.outcome(1)], 1), false);
  assert.equal((await f.state()).epoch, 2);
  assert.deepEqual((await f.state()).events.map(event => event.body.epoch), [2]);
});

test('a customer kill switch fences queued metadata instead of retrying disabled submissions', async t => {
  const f = await setup(t);
  await f.enable();
  await f.queue();
  await f.queue();
  f.enrollment.available = false;
  f.intercept(call => call.url.endsWith('/request-outcomes') ? problem('telemetry_unavailable') : null);
  await f.flush();
  assert.equal((await f.state()).events.length, 0);
  assert.equal((await f.state()).enabled, false);
  assert.equal((await telemetrySnapshot(f.client)).epoch, null);
  const count = f.calls.length;
  await f.flush();
  assert.equal(f.calls.length, count);
  assert.equal(f.calls.filter(call => call.url.endsWith('/request-outcomes')).length, 1);
});

test('malformed telemetry and extra content fields fail closed before persistence', async t => {
  const f = await setup(t);
  await f.enable();
  const event = f.outcome();
  event.body.query = 'private text';
  assert.equal(validTelemetryEvent(event.kind, event.body), false);
  await assert.rejects(f.queue(event), { code: 'INVALID_PAYLOAD' });
  assert.doesNotMatch(JSON.stringify(await f.state()), /private text/);
});

test('queue is bounded and expires events after 30 days', async t => {
  const f = await setup(t);
  await f.enable();
  const snapshot = await telemetrySnapshot(f.client);
  await enqueueTelemetry(f.client, snapshot, Array.from({ length: 205 }, () => f.outcome()), 1, { clock: f.clock, log: f.log });
  assert.equal((await f.state()).events.length, TELEMETRY_LIMITS.events);
  assert.match(f.logs.join('\n'), /evicted:5/);
  f.advance(TELEMETRY_LIMITS.ageMs + 1);
  await f.flush();
  assert.equal((await f.state()).events.length, 0);
  assert.equal(f.calls.filter(call => call.url.endsWith('/request-outcomes')).length, 0);
});

test('unsafe local state is refused rather than following a symlink', async t => {
  const f = await setup(t);
  await f.enable();
  const path = await f.statePath();
  const outside = join(f.root, 'outside.json');
  const original = await readFile(path, 'utf8');
  await writeFile(outside, original);
  await rm(path);
  await symlink(outside, path);
  await assert.rejects(telemetrySnapshot(f.client), { code: 'UNSAFE_STATE' });
  assert.equal(await readFile(outside, 'utf8'), original);
});

test('concurrent senders claim an event once and do not hold the file lock during HTTP', async t => {
  const f = await setup(t);
  await f.enable();
  await f.queue();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  f.intercept(async call => {
    if (call.url.endsWith('/request-outcomes')) { entered(); await gate; }
  });
  const first = f.flush();
  await ready;
  await f.flush();
  await f.queue();
  release();
  await first;
  assert.equal((await f.state()).events.length, 0);
  assert.equal(f.calls.filter(call => call.url.endsWith('/request-outcomes')).length, 2);
});
