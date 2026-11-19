import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import test from 'node:test';
import { createReviewSession } from '../src/canvas/review.mjs';
import { renderPanel } from '../src/canvas/panel.mjs';
import { REVIEW_SCRIPT } from '../src/canvas/review-panel.mjs';
import { TELEMETRY_NOTICE_VERSION } from '../src/telemetry.mjs';
import { createClient } from '../src/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { validFeedback, validateRecallDetail, validateRecallPage, FEEDBACK_VALUES } from '../src/feedback.mjs';
import { startCanvasServer } from '../src/canvas/index.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { mockGateway } from './helpers/gateway.mjs';

const event = (epoch, labels = [{ target: 'retrieval', dimension: 'benefit', action: 'set', value: 'helped', reasons: ['saved_time'] }]) =>
  ({ event_id: randomUUID(), epoch, surface: 'review_canvas', attestation: 'client_ui', occurred_at: new Date().toISOString(), labels });

async function integrated(t, { search: runSearch = true } = {}) {
  const gateway = await mockGateway(t, { telemetry: true });
  const home = await mkdtemp(join(tmpdir(), 'memory-house-review-http-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = loadConfig({ home, deployment: fixtureDeployment(gateway.base), env: { MH_ALLOW_INSECURE_LOCALHOST: '1' } });
  const client = createClient({ config, acquireToken: async () => ({ accessToken: 'fixture-access-1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600, objectId: 'fixture-user' }) });
  await client.login();
  const search = runSearch ? await client.search('test recall') : null;
  const review = createReviewSession(client);
  const status = await review.status();
  return { gateway, client, review, session: status.session, id: search?.retrieval.id };
}

async function setup(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'memory-house-review-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const state = {
    identity: { accountBound: true, binding: 'a'.repeat(64), generation: randomUUID() },
    enrollment: { available: true, enrolled: true, epoch: 1, notice_version: TELEMETRY_NOTICE_VERSION,
      current_notice_version: TELEMETRY_NOTICE_VERSION, enrolled_at: new Date().toISOString(),
      retention_days: 60, deletion: null },
    calls: [],
  };
  const client = {
    config: { stateDir, gatewayBase: 'https://fixture.invalid/inference/memory', lockTimeoutMs: 1000 },
    captureIdentity: async () => state.identity && { ...state.identity },
    telemetryEnrollment: async (method, options) => {
      state.calls.push({ method, options });
      if (options.binding !== state.identity?.binding) throw new Error('wrong account');
      if (method === 'DELETE') state.enrollment.enrolled = false;
      if (method === 'POST' && !state.enrollment.enrolled) {
        state.enrollment.enrolled = true;
        state.enrollment.epoch++;
      }
      return { ...state.enrollment };
    },
  };
  return { state, client, review: createReviewSession(client) };
}

test('review participation reflects default-on enrollment, with explicit opt-out and re-enable', async t => {
  const { state, review } = await setup(t);
  const status = await review.status();
  assert.equal(status.enrollment.enrolled, true);
  assert.equal(status.enrollment.retention_days, 60);
  assert.deepEqual(state.calls.map(call => call.method), ['GET']);
  assert.equal((await review.preference({ session: status.session, action: 'disable' })).enrollment.enrolled, false);
  assert.equal((await review.status()).enrollment.enrolled, false, 'Viewing status must not re-enable collection.');
  assert.equal((await review.preference({ session: status.session, action: 'enable' })).enrollment.epoch, 2);
});

test('review session fences account switches and same-account sign-in changes before a write', async t => {
  const { state, review } = await setup(t);
  const old = await review.status();
  state.identity.generation = randomUUID();
  await assert.rejects(review.preference({ session: old.session, action: 'disable' }), { code: 'TELEMETRY_STATE_CHANGED' });
  assert.equal(state.calls.length, 1);
  const fresh = await review.status();
  assert.notEqual(fresh.session, old.session);
  state.identity.binding = 'b'.repeat(64);
  await assert.rejects(review.preference({ session: fresh.session, action: 'disable' }), { code: 'TELEMETRY_STATE_CHANGED' });
  assert.equal(state.calls.length, 2);
  state.identity = null;
  await assert.rejects(review.status(), { code: 'NOT_SIGNED_IN' });
});

test('review preference rejects an arbitrary action or content before contacting the backend', async t => {
  const { state, review } = await setup(t);
  const { session } = await review.status();
  for (const body of [{ session, action: 'delete' }, { session, action: 'enable', content: 'private' }]) {
    await assert.rejects(review.preference(body), { code: 'INVALID_PAYLOAD' });
  }
  await assert.rejects(review.preference({ session: randomUUID(), action: 'disable' }), { code: 'TELEMETRY_STATE_CHANGED' });
  assert.equal(state.calls.length, 1);
});

test('an account change between canvas validation and the preference command cannot mutate the new account', async t => {
  const { state, client, review } = await setup(t);
  const { session } = await review.status();
  let reads = 0;
  const original = client.captureIdentity;
  client.captureIdentity = async () => {
    if (++reads === 2) state.identity.binding = 'b'.repeat(64);
    return original();
  };
  await assert.rejects(review.preference({ session, action: 'disable' }), { code: 'TELEMETRY_STATE_CHANGED' });
  assert.deepEqual(state.calls.map(call => call.method), ['GET']);
  assert.equal(state.enrollment.enrolled, true);
});

test('review UI uses explicit controls and emits syntactically valid inline JavaScript', () => {
  const page = renderPanel({ token: 'fixture-token', nonce: 'fixture-nonce' });
  assert.match(page, /Recent recalls &amp; privacy/);
  assert.match(page, /Opt out of new collection/);
  assert.match(page, /role="alert"/);
  assert.match(page, /60 days/);
  const scripts = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  for (const [, script] of scripts) assert.doesNotThrow(() => new Script(script));
});

test('review text includes conflict notes covered by the recalled fingerprint', () => {
  const memory = { content: 'Current preference', conflicts_with: [{ content: 'Conflicting preference', created_at: '2026-10-05' }] };
  const script = new Script(REVIEW_SCRIPT + `\nmemoryText(${JSON.stringify(memory)})`);
  const text = script.runInNewContext({ $: () => ({ addEventListener() {} }) });
  assert.match(text, /^Current preference/);
  assert.match(text, /Conflict notes:/);
  assert.match(text, /Conflicting preference/);
  assert.match(text, /2026-10-05/);
});

test('feedback contract rejects unsupported dimensions, content, duplicate labels, reasons and oversized payloads', () => {
  const original = event(1);
  assert.equal(validFeedback(original), true);
  for (const [dimension, values] of Object.entries(FEEDBACK_VALUES)) {
    for (const [value, reasons] of Object.entries(values)) {
      assert.equal(validFeedback(event(1, [{ target: dimension === 'benefit' ? 'retrieval' : 1,
        dimension, action: 'set', value, reasons: reasons.slice(0, 3) }])), true);
    }
  }
  for (const bad of [
    { ...original, content: 'private' }, { ...original, epoch: 0 }, { ...original, attestation: 'verified_human' },
    { ...original, surface: 'agent_tool' }, { ...original, labels: [] },
    { ...original, labels: [original.labels[0], original.labels[0]] },
    event(1, [{ ...original.labels[0], target: 1 }]),
    event(1, [{ ...original.labels[0], reasons: ['private free text'] }]),
    event(1, [{ ...original.labels[0], reasons: ['saved_time', 'saved_time'] }]),
    event(1, [{ target: 'retrieval', dimension: 'benefit', action: 'withdraw', value: 'helped' }]),
    event(1, [{ target: 'retrieval', dimension: 'benefit', action: 'withdraw', reasons: [] }]),
  ]) assert.equal(validFeedback(bad), false, JSON.stringify(bad));
  assert.equal(validFeedback(event(1, [{ target: 'retrieval', dimension: 'benefit', action: 'withdraw' }])), true);
});

test('review HTTP flow lists, rates, replaces, withdraws and retries without changing memories or retention', async t => {
  const { gateway, review, session, id } = await integrated(t);
  const before = structuredClone(gateway.state.memories);
  const page = await review.list({ session });
  assert.equal(page.items[0].retrieval_id, id);
  assert.equal(page.cursor, null);
  assert.equal(page.items[0].supplied_ranks, null);
  const detail = await review.detail({ session, retrieval_id: id });
  assert.equal(detail.items[0].memory_state, 'unchanged');
  const submitted = { session, retrieval_id: id, event: event(detail.epoch) };
  assert.equal((await review.feedback(submitted)).status, 'recorded');
  assert.equal((await review.feedback(submitted)).status, 'duplicate');
  assert.equal(gateway.state.feedbackEvents.size, 1);
  const saved = await review.detail({ session, retrieval_id: id });
  const expiry = saved.feedback.expires_at;
  assert.equal(saved.feedback.labels[0].value, 'helped');
  await review.feedback({ ...submitted, event: event(detail.epoch, [
    { target: 'retrieval', dimension: 'benefit', action: 'set', value: 'harmed', reasons: ['wrong_information'] },
  ]) });
  assert.equal((await review.detail({ session, retrieval_id: id })).feedback.labels[0].value, 'harmed');
  await review.feedback({ ...submitted, event: event(detail.epoch, [{ target: 'retrieval', dimension: 'benefit', action: 'withdraw' }]) });
  const withdrawn = await review.detail({ session, retrieval_id: id });
  assert.deepEqual(withdrawn.feedback.labels, []);
  assert.equal(withdrawn.feedback.expires_at, expiry);
  assert.deepEqual(gateway.state.memories, before);
  assert.equal(gateway.state.turns.length, 0);
  assert.equal(gateway.state.requests.some(call => call.path.endsWith('/mcp/')), false);
  for (const call of gateway.state.requests.filter(call => call.path.endsWith('/feedback'))) {
    assert.doesNotMatch(JSON.stringify(call.body), /fixture-memory|concise TypeScript examples/);
    assert.equal(call.headers['x-memory-house-client'], 'amt-copilot-plugin/source; trigger=user_command');
  }
});

test('guided review saves four dimensions in one revision, leaving unselected answers absent', async t => {
  const { gateway, review, session, id } = await integrated(t);
  await review.detail({ session, retrieval_id: id });
  const labels = [
    { target: 'retrieval', dimension: 'benefit', action: 'set', value: 'helped', reasons: ['saved_time'] },
    { target: 1, dimension: 'correctness', action: 'set', value: 'correct', reasons: [] },
    { target: 1, dimension: 'applicability', action: 'set', value: 'applies', reasons: [] },
    { target: 1, dimension: 'relevance', action: 'set', value: 'unsure', reasons: [] },
  ];
  const ack = await review.feedback({ session, retrieval_id: id, event: event(1, labels) });
  assert.equal(ack.revision, 1);
  const detail = await review.detail({ session, retrieval_id: id });
  assert.equal(detail.feedback.labels.length, 4);
  assert.equal(detail.feedback.revisions_left, 19);
  assert.equal(gateway.state.requests.filter(call => call.path.endsWith('/feedback')).length, 1);
});

test('review requires explicit detail selection and never rates changed or unavailable original content', async t => {
  const { gateway, review, session, id } = await integrated(t);
  const body = { session, retrieval_id: id, event: event(1) };
  await assert.rejects(review.feedback(body), { code: 'TELEMETRY_STATE_CHANGED' });
  const stored = gateway.state.reviewDetails.get(id);
  stored.items[0].memory_state = 'changed';
  const hidden = await review.detail({ session, retrieval_id: id });
  assert.equal(hidden.items[0].memory, undefined);
  const current = await review.detail({ session, retrieval_id: id, include_current: true });
  assert.equal(current.items[0].memory.content, gateway.state.memories[0].content);
  await assert.rejects(review.feedback({ ...body, event: event(1, [
    { target: 1, dimension: 'correctness', action: 'set', value: 'correct' },
  ]) }), { code: 'INVALID_PAYLOAD' });
  assert.equal((await review.feedback(body)).status, 'recorded', 'Whole-recall benefit remains reportable.');
  stored.items[0] = { rank: 1, position: 'ranked', supplied: null, omit_reason: null, memory_state: 'unavailable' };
  const unavailable = await review.detail({ session, retrieval_id: id });
  assert.equal(unavailable.items[0].memory_id, undefined);
  assert.throws(() => validateRecallDetail({ ...unavailable,
    items: [{ ...unavailable.items[0], memory_id: 'no-longer-readable' }] }, id, false), { code: 'INVALID_RESPONSE' });
  assert.throws(() => validateRecallPage({ items: [], cursor: 9 }), { code: 'INVALID_RESPONSE' });
});

test('opt-out preserves review but prevents feedback; re-enrollment never relabels old recalls', async t => {
  const { gateway, review, session, id } = await integrated(t);
  await review.detail({ session, retrieval_id: id });
  await review.preference({ session, action: 'disable' });
  const page = await review.list({ session });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].feedback_allowed, false);
  await review.detail({ session, retrieval_id: id });
  await assert.rejects(review.feedback({ session, retrieval_id: id, event: event(1) }), { code: 'TELEMETRY_STATE_CHANGED' });
  await review.preference({ session, action: 'enable' });
  assert.equal(gateway.state.telemetry.epoch, 2);
  const old = await review.detail({ session, retrieval_id: id });
  assert.equal(old.epoch, 1);
  assert.equal(old.feedback_allowed, false);
  assert.equal(gateway.state.feedbackEvents.size, 0);
});

test('canvas HTTP review routes require capability and reject invalid or unsigned submissions', async t => {
  const { client, id } = await integrated(t);
  const server = await startCanvasServer({ gateway: { client } });
  t.after(() => server.close());
  const send = async (path, body, extraHeaders = {}) => fetch(new URL(path, server.url), {
    method: body ? 'POST' : 'GET', headers: { 'x-mh-canvas-token': server.token,
      'Content-Type': 'application/json', ...extraHeaders }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const status = await (await send('/api/telemetry/status')).json();
  for (const path of ['invitation', 'invitation-event', 'invitation-preference']) {
    assert.equal((await send(`/api/telemetry/${path}`, { session: status.session },
      { 'x-mh-canvas-token': 'wrong' })).status, 403);
    assert.equal((await send(`/api/telemetry/${path}`, { session: status.session },
      { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await send(`/api/telemetry/${path}`, { session: status.session, content: 'must-not-be-saved' })).status, 400);
  }
  assert.equal((await send('/api/telemetry/recalls', { session: status.session }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await send('/api/telemetry/feedback', { session: status.session, retrieval_id: id, event: event(1) },
    { 'x-mh-canvas-token': 'wrong' })).status, 403);
  assert.equal((await send('/api/telemetry/recall', { session: status.session, retrieval_id: id })).status, 200);
  assert.equal((await send('/api/telemetry/feedback', { session: status.session, retrieval_id: id, event: event(1) })).status, 200);
  const malformed = await send('/api/telemetry/feedback', { session: status.session, retrieval_id: id,
    event: { ...event(1), content: 'private text' } });
  assert.equal(malformed.status, 400);
});

test('default-on can be opted out at epoch zero before the first search, even under the kill switch', async t => {
  const { gateway, client } = await integrated(t, { search: false });
  gateway.state.telemetry.available = false;
  const review = createReviewSession(client);
  const status = await review.status();
  assert.equal(status.enrollment.state, 'default_on');
  assert.equal(status.enrollment.epoch, 0);
  const disabled = await review.preference({ session: status.session, action: 'disable' });
  assert.equal(disabled.enrollment.state, 'opted_out');
  assert.equal(disabled.enrollment.epoch, 0);
  gateway.state.telemetry.available = true;
  const search = await client.search('after opt-out');
  assert.equal(search.retrieval.recording, 'off');
  assert.equal((await review.status()).enrollment.enrolled, false);
  assert.equal(gateway.state.reviewDetails.size, 0);
});

test('an in-flight review response is discarded if sign-in changes before it returns', async t => {
  const { state, client, review } = await setup(t);
  const { session } = await review.status();
  client.telemetryReview = async () => {
    state.identity.binding = 'b'.repeat(64);
    return { items: [], cursor: null };
  };
  await assert.rejects(review.list({ session }), { code: 'TELEMETRY_STATE_CHANGED' });
});

test('review reports backend policy errors safely and validates pagination before HTTP', async t => {
  const { state, client, review } = await setup(t);
  const { session } = await review.status();
  let requests = 0;
  client.telemetryReview = async () => {
    requests++;
    throw Object.assign(new Error('private backend diagnostics'), { status: 404, problem: 'retrieval_not_found' });
  };
  for (const cursor of ['', 0, null, 'x'.repeat(16385)]) await assert.rejects(review.list({ session, cursor }), { code: 'INVALID_PAYLOAD' });
  assert.equal(requests, 0);
  await assert.rejects(review.list({ session }), error => {
    assert.equal(error.code, 'FEEDBACK_REJECTED');
    assert.equal(error.status, 404);
    assert.doesNotMatch(error.message, /private backend/);
    return true;
  });
  assert.equal(state.calls.length, 1);
});
