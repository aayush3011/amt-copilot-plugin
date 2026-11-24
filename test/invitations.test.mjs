import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createReviewSession } from '../src/canvas/review.mjs';
import { createClient } from '../src/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { flushTelemetry, telemetryCommand, telemetrySnapshot, validTelemetryEvent } from '../src/telemetry.mjs';
import { fixtureDeployment } from './helpers/deployment.mjs';
import { mockGateway } from './helpers/gateway.mjs';
import {
  INVITATION_LIMITS, confirmInvitationShown, dismissInvitation, invitationEligible, invitationPreference,
  invitationReserved, reserveInvitation, sampledRecall, setInvitationPreference,
  INVITATION_POLICY,
} from '../src/invitations.mjs';

async function setup(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'memory-house-invitations-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return { stateDir, lockTimeoutMs: 2000 };
}

test('invitation eligibility includes empty searches but excludes stale, rated and fenced recalls', () => {
  const now = Date.now();
  const item = { recorded_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 1000).toISOString(),
    epoch: 1, feedback_allowed: true, status: 'empty', feedback: null };
  assert.equal(invitationEligible(item, 1, now), true);
  for (const patch of [
    { status: 'error' }, { feedback_allowed: false }, { epoch: 2 },
    { feedback: { revision: 1, labels: 0 } },
    { recorded_at: new Date(now - INVITATION_LIMITS.recentMs).toISOString() },
    { recorded_at: new Date(now + 1).toISOString() }, { expires_at: new Date(now).toISOString() },
  ]) assert.equal(invitationEligible({ ...item, ...patch }, 1, now), false);
  assert.equal(invitationEligible({ ...item, epoch: 0 }, 0, now), false);
});

test('sampling is deterministic across panels and uses a ten percent hash threshold', () => {
  let selected = 0;
  for (let index = 0; index < 10000; index++) {
    const id = `ret_01JC3K${String(index).padStart(20, '0')}`;
    const sample = sampledRecall(id);
    assert.equal(sampledRecall(id), sample);
    if (sample) selected++;
  }
  assert.ok(selected >= 900 && selected <= 1100, `Unexpected sample count ${selected}`);
});

test('one reservation per rolling day is atomic across panels and survives restart', async t => {
  const config = await setup(t);
  const now = Date.now();
  const attempts = await Promise.all(Array.from({ length: 5 }, () => reserveInvitation(config, now)));
  assert.equal(attempts.filter(Boolean).length, 1);
  const reservation = attempts.find(Boolean);
  assert.equal(await invitationReserved(config, reservation), true);
  assert.equal(await confirmInvitationShown(config, reservation, now + 1000), true);
  assert.equal(await reserveInvitation({ ...config }, now + INVITATION_LIMITS.intervalMs - 1), null);
  assert.equal(await reserveInvitation(config, now + INVITATION_LIMITS.intervalMs), null, 'Cap starts at display, not just selection.');
  const next = await reserveInvitation(config, now + INVITATION_LIMITS.intervalMs + 1000);
  assert.ok(next);
  assert.equal(await invitationReserved(config, reservation), false);
  const raw = await readFile(join(config.stateDir, 'invitations.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['enabled', 'nextAt', 'revision', 'version']);
});

test('dismissal cooldown and stop asking persist independently of telemetry or sign-in', async t => {
  const config = await setup(t);
  const now = Date.now();
  assert.deepEqual(await invitationPreference(config), { enabled: true });
  const reservation = await reserveInvitation(config, now);
  assert.equal(await dismissInvitation(config, reservation, now), true);
  assert.equal(await dismissInvitation(config, reservation, now), false);
  assert.equal(await reserveInvitation(config, now + INVITATION_LIMITS.intervalMs), null);
  assert.ok(await reserveInvitation(config, now + INVITATION_LIMITS.dismissMs));
  await setInvitationPreference(config, false);
  assert.deepEqual(await invitationPreference({ ...config }), { enabled: false });
  assert.equal(await reserveInvitation(config, now + 30 * INVITATION_LIMITS.intervalMs), null);
  await setInvitationPreference(config, true);
  assert.ok(await reserveInvitation(config, now + 30 * INVITATION_LIMITS.intervalMs));
});

test('unsafe or malformed invitation state fails explicitly rather than re-enabling invitations', async t => {
  const config = await setup(t);
  const path = join(config.stateDir, 'invitations.json');
  await writeFile(path, '{"enabled":true}');
  await assert.rejects(invitationPreference(config), { code: 'INVALID_INVITATION_STATE' });
  await assert.rejects(reserveInvitation(config), { code: 'INVALID_INVITATION_STATE' });
  await rm(path);
  const target = join(config.stateDir, 'target.json');
  await writeFile(target, '{}');
  await symlink(target, path);
  await assert.rejects(invitationPreference(config), { code: 'UNSAFE_STATE' });
});

async function integrated(t) {
  const { stateDir } = await setup(t);
  const gateway = await mockGateway(t, { telemetry: true });
  const config = loadConfig({ home: stateDir, deployment: fixtureDeployment(gateway.base), env: { MH_ALLOW_INSECURE_LOCALHOST: '1' } });
  const client = createClient({ config, acquireToken: async () => ({
    accessToken: 'fixture-access-1', expiresAt: Math.floor(Date.now() / 1000) + 3600, objectId: 'fixture-user',
  }) });
  await client.login();
  let id;
  for (let index = 0; index < 100; index++) {
    id = (await client.search('fixture')).retrieval.id;
    if (sampledRecall(id)) break;
  }
  assert.ok(sampledRecall(id));
  let now = Date.now();
  const clock = () => now;
  const review = createReviewSession(client, { clock });
  t.after(() => review.close());
  const { session } = await review.status();
  const events = () => gateway.state.telemetryEvents.filter(event => event.path.endsWith('/invitation'));
  return { gateway, client, review, session, id, events, clock, advance: ms => { now += ms; } };
}

test('invitation wire contract permits only bounded metadata, never rating or content fields', () => {
  const id = 'ret_01JC3K00000000000000000000';
  const body = { event_id: randomUUID(), epoch: 1, policy: INVITATION_POLICY, action: 'shown',
    surface: 'review_canvas_banner', occurred_at: new Date().toISOString() };
  assert.equal(validTelemetryEvent('invitation', body, id), true);
  for (const patch of [
    { action: 'rated' }, { epoch: 0 }, { policy: 'future-policy' }, { action: 'dismissed' },
    { dismissal: 'dismiss' }, { content: 'secret' }, { labels: [] }, { retrieval_id: id },
    { occurred_at: 'yesterday' }, { surface: 'agent_tool' },
  ]) assert.equal(validTelemetryEvent('invitation', { ...body, ...patch }, id), false);
  for (const dismissal of ['dismiss', 'stop_asking']) {
    assert.equal(validTelemetryEvent('invitation', { ...body, action: 'dismissed', dismissal }, id), true);
  }
});

test('canvas selects exact recall, records only visible/opened claims and never submits a rating', async t => {
  const f = await integrated(t);
  const { invitation } = await f.review.candidate({ session: f.session });
  assert.equal(invitation.retrieval_id, f.id);
  assert.equal(f.events().length, 0, 'Reservation alone is not a shown event.');
  const body = { session: f.session, invitation_id: invitation.invitation_id };
  await assert.rejects(f.review.invitationEvent({ ...body, action: 'opened' }), { code: 'INVALID_PAYLOAD' });
  await f.review.invitationEvent({ ...body, action: 'shown' });
  await f.review.close();
  await f.review.invitationEvent({ ...body, action: 'shown' });
  await f.review.close();
  assert.equal(f.events().length, 1, 'Same visible claim reuses its stable event.');
  await assert.rejects(f.review.invitationEvent({ ...body, action: 'opened' }), { code: 'INVALID_PAYLOAD' });
  await f.review.detail({ session: f.session, retrieval_id: f.id });
  await f.review.invitationEvent({ ...body, action: 'opened' });
  await f.review.close();
  assert.deepEqual(f.events().map(event => event.body.action), ['shown', 'opened']);
  assert.equal(f.gateway.state.feedbackEvents.size, 0);
  assert.equal(f.gateway.state.turns.length, 0);
  for (const call of f.gateway.state.requests.filter(call => call.path.endsWith('/invitation'))) {
    assert.equal(call.headers['x-memory-house-client'], 'amt-copilot-plugin/source; trigger=user_command');
  }
  assert.deepEqual((await f.review.candidate({ session: f.session })).invitation, null);
});

test('Stop asking records a dismissal while leaving telemetry on, and persists across panels', async t => {
  const f = await integrated(t);
  const { invitation } = await f.review.candidate({ session: f.session });
  await f.review.invitationEvent({ session: f.session, invitation_id: invitation.invitation_id, action: 'shown' });
  assert.deepEqual(await f.review.invitationSettings({ session: f.session, enabled: false }), { enabled: false });
  await f.review.close();
  assert.equal(f.gateway.state.telemetry.enrolled, true);
  assert.equal(f.events().find(event => event.body.action === 'dismissed').body.dismissal, 'stop_asking');
  const next = createReviewSession(f.client);
  const status = await next.status();
  assert.deepEqual(status.invitations, { enabled: false });
  assert.equal((await next.candidate({ session: status.session })).invitation, null);
});

test('dismissal extends cooldown without disabling collection', async t => {
  const f = await integrated(t);
  const { invitation } = await f.review.candidate({ session: f.session });
  const body = { session: f.session, invitation_id: invitation.invitation_id };
  await f.review.invitationEvent({ ...body, action: 'shown' });
  await f.review.invitationEvent({ ...body, action: 'dismissed' });
  await f.review.close();
  assert.equal(f.events()[1].body.dismissal, 'dismiss');
  assert.equal(await reserveInvitation(f.client.config, Date.now() + 2 * INVITATION_LIMITS.intervalMs), null);
});

test('old servers, disabled policy, opt-out and kill switch never invite', async t => {
  const f = await integrated(t);
  const original = structuredClone(f.gateway.state.telemetry);
  for (const patch of [
    { invitation_policy: undefined },
    { invitation_policy: { ...original.invitation_policy, enabled: false } },
    { invitation_policy: { ...original.invitation_policy, version: 'future-policy' } },
    { enrolled: false }, { available: false },
  ]) {
    Object.assign(f.gateway.state.telemetry, original, patch);
    assert.equal((await f.review.candidate({ session: f.session })).invitation, null);
  }
  assert.equal(f.events().length, 0);
});

test('rating and local opt-out races fence a selected invitation before it is shown', async t => {
  const f = await integrated(t);
  const { invitation } = await f.review.candidate({ session: f.session });
  const body = { session: f.session, invitation_id: invitation.invitation_id, action: 'shown' };
  f.gateway.state.reviewDetails.get(f.id).feedback = { revision: 1, labels: [], updated_at: new Date().toISOString() };
  await assert.rejects(f.review.invitationEvent(body), { code: 'TELEMETRY_STATE_CHANGED' });
  f.gateway.state.reviewDetails.get(f.id).feedback = null;
  await telemetryCommand(f.client, 'disable');
  await assert.rejects(f.review.invitationEvent(body), { code: 'TELEMETRY_STATE_CHANGED' });
  assert.equal(f.events().length, 0);
});

test('invitation sender accepts natural-key duplicate ack and never sends after a local fence', async t => {
  const f = await integrated(t);
  const snapshot = await telemetrySnapshot(f.client);
  const body = { event_id: randomUUID(), epoch: snapshot.epoch, policy: INVITATION_POLICY,
    action: 'shown', surface: 'review_canvas_banner', occurred_at: new Date().toISOString() };
  const options = { retrievalId: f.id, binding: snapshot.binding, revision: snapshot.revision };
  await f.client.telemetrySubmit('invitation', body, options);
  const ack = await f.client.telemetrySubmit('invitation', { ...body, event_id: randomUUID() }, options);
  assert.equal(ack.status, 'duplicate');
  assert.equal(ack.event_id, body.event_id);
  await telemetryCommand(f.client, 'disable');
  await assert.rejects(f.client.telemetrySubmit('invitation', body, options), { code: 'TELEMETRY_STATE_CHANGED' });
  assert.equal(f.events().length, 1);
  assert.deepEqual(await flushTelemetry({ client: f.client }), { sent: 0 });
});

test('lease expiry, reset and sign-out fence previously reserved invitations', async t => {
  for (const change of ['expiry', 'reset', 'logout']) await t.test(change, async t => {
    const f = await integrated(t);
    const { invitation } = await f.review.candidate({ session: f.session });
    if (change === 'expiry') f.advance(INVITATION_LIMITS.leaseMs);
    if (change === 'reset') f.gateway.state.telemetry.epoch++;
    if (change === 'logout') await f.client.logout();
    await assert.rejects(f.review.invitationEvent({ session: f.session,
      invitation_id: invitation.invitation_id, action: 'shown' }), error =>
      ['TELEMETRY_STATE_CHANGED', 'NOT_SIGNED_IN'].includes(error.code));
    assert.equal(f.events().length, 0);
  });
});

test('uncertain invitation delivery retries its original event without new metadata or retention timestamps', async t => {
  const f = await integrated(t);
  const client = { ...f.client };
  const sent = [];
  let fail = true;
  client.telemetrySubmit = async (kind, body, options) => {
    sent.push(structuredClone(body));
    if (fail) throw Object.assign(new Error('fixture transient failure'), { status: 503 });
    return f.client.telemetrySubmit(kind, body, options);
  };
  const review = createReviewSession(client, { clock: f.clock });
  t.after(() => review.close());
  const { session } = await review.status();
  const { invitation } = await review.candidate({ session });
  await review.invitationEvent({ session, invitation_id: invitation.invitation_id, action: 'shown' });
  await review.close();
  assert.equal(sent.length, 1);
  fail = false;
  f.advance(31000);
  assert.equal((await flushTelemetry({ client, clock: f.clock })).sent, 1);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(f.events().length, 1);
});
