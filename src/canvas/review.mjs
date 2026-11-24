import { randomUUID } from 'node:crypto';
import { MemoryHouseError } from '../errors.mjs';
import { TELEMETRY_NOTICE, TELEMETRY_NOTICE_VERSION, TELEMETRY_OPT_OUT, enqueueTelemetry, flushTelemetry,
  telemetryAllowed, telemetryCommand, telemetrySnapshot } from '../telemetry.mjs';
import { FEEDBACK_ERRORS, validFeedback, validateRecallDetail, validateRecallPage } from '../feedback.mjs';
import { INVITATION_LIMITS, INVITATION_POLICY, confirmInvitationShown, dismissInvitation, invitationEligible, invitationPreference,
  invitationReserved, reserveInvitation, sampledRecall, setInvitationPreference, supportedInvitationPolicy } from '../invitations.mjs';

// TODO(dogfood-feedback): Review the internal dogfooding review/participation surface
// before external customer release; its APIs and UI may be revised or removed.
export function createReviewSession(client, { clock = Date.now } = {}) {
  let binding;
  let generation;
  let session;
  let enrollment;
  let invitation;
  let inviting = false;
  let sending;
  const log = message => process.stderr.write(`memory-house:${message}\n`);
  const viewed = new Map();
  const allowedKeys = (body, names) => body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => names.includes(key));
  const invalid = () => { throw new MemoryHouseError('INVALID_PAYLOAD', 'Invalid recall review request.'); };

  async function identity() {
    const current = await client.captureIdentity();
    if (!current?.accountBound) throw new MemoryHouseError('NOT_SIGNED_IN', 'Sign in to Memory House before reviewing recalls.');
    return current;
  }

  async function status() {
    const before = await identity();
    const state = await telemetryCommand(client, 'status', undefined, { expectedBinding: before.binding });
    const after = await identity();
    if (before.binding !== after.binding || before.generation !== after.generation) {
      throw new MemoryHouseError('TELEMETRY_STATE_CHANGED', 'Sign-in changed. Refresh the review before continuing.');
    }
    if (binding !== after.binding || generation !== after.generation) {
      session = randomUUID();
      viewed.clear();
      invitation = null;
    }
    binding = after.binding;
    generation = after.generation;
    enrollment = state;
    if (!state.enrolled || !state.available || state.local_collection_paused
      || !supportedInvitationPolicy(state.invitation_policy) || invitation?.snapshot.epoch !== state.epoch) invitation = null;
    return { enrollment, session, invitations: await invitationPreference(client.config),
      notice: TELEMETRY_NOTICE, opt_out: TELEMETRY_OPT_OUT, notice_version: TELEMETRY_NOTICE_VERSION };
  }

  async function check(expected) {
    const current = await identity();
    if (!session || expected !== session || binding !== current.binding || generation !== current.generation) {
      throw new MemoryHouseError('TELEMETRY_STATE_CHANGED', 'Sign-in changed or the review expired. Refresh before continuing.');
    }
    return current;
  }

  async function preference(body) {
    if (!body || Object.keys(body).some(key => !['action', 'session'].includes(key))
      || !['enable', 'disable'].includes(body.action)) {
      throw new MemoryHouseError('INVALID_PAYLOAD', 'Choose enable or disable.');
    }
    const current = await check(body.session);
    const enrollment = await telemetryCommand(client, body.action, undefined, { expectedBinding: current.binding });
    await check(body.session);
    viewed.clear();
    invitation = null;
    return { enrollment };
  }

  async function request(expected, action, options) {
    const current = await check(expected);
    try {
      const result = await client.telemetryReview(action, { ...options, binding: current.binding });
      await check(expected);
      return result;
    } catch (error) {
      if (Object.hasOwn(FEEDBACK_ERRORS, error.problem ?? '')) {
        throw new MemoryHouseError('FEEDBACK_REJECTED', FEEDBACK_ERRORS[error.problem],
          { status: error.status, problem: error.problem });
      }
      throw error;
    }
  }

  async function list(body) {
    if (!allowedKeys(body, ['session', 'cursor']) || (body.cursor !== undefined
      && (typeof body.cursor !== 'string' || !body.cursor.length || body.cursor.length > 16384))) invalid();
    return validateRecallPage(await request(body.session, 'list', { ...(body.cursor === undefined ? {} : { cursor: body.cursor }) }));
  }

  async function detail(body) {
    if (!allowedKeys(body, ['session', 'retrieval_id', 'include_current'])
      || (body.include_current !== undefined && typeof body.include_current !== 'boolean')) invalid();
    const includeCurrent = body.include_current === true;
    const data = validateRecallDetail(await request(body.session, 'detail',
      { retrievalId: body.retrieval_id, includeCurrent }), body.retrieval_id, includeCurrent);
    viewed.delete(data.retrieval_id);
    viewed.set(data.retrieval_id, { epoch: data.epoch, count: data.count, allowed: data.feedback_allowed,
      states: new Map(data.items.map(item => [item.rank, item.memory_state])) });
    if (viewed.size > 50) viewed.delete(viewed.keys().next().value);
    return data;
  }

  async function feedback(body) {
    if (!allowedKeys(body, ['session', 'retrieval_id', 'event']) || !validFeedback(body.event)) invalid();
    await check(body.session);
    const recall = viewed.get(body.retrieval_id);
    if (!recall || !recall.allowed || recall.epoch !== body.event.epoch) {
      throw new MemoryHouseError('TELEMETRY_STATE_CHANGED', 'Refresh and select an eligible recall before submitting feedback.');
    }
    if (body.event.labels.some(label => label.target !== 'retrieval' && (label.target > recall.count
      || (label.action === 'set' && recall.states.get(label.target) !== 'unchanged')))) {
      throw new MemoryHouseError('INVALID_PAYLOAD', 'Only unchanged, currently readable results can receive new result ratings.');
    }
    // Nothing is persisted locally and no background submission is inferred. The UI
    // retains its event UUID only for an explicit retry of this same submission.
    const snapshot = await telemetrySnapshot(client);
    if (snapshot?.binding !== binding || snapshot.epoch !== body.event.epoch) {
      throw new MemoryHouseError('TELEMETRY_STATE_CHANGED', 'Local collection is paused or participation changed. Refresh before submitting.');
    }
    return request(body.session, 'feedback', { retrievalId: body.retrieval_id, body: body.event, revision: snapshot.revision });
  }

  // TODO(dogfood-feedback): Canvas-only sampled invitations and metadata events.
  // Keep the reservation local; never persist reviewed content or auto-submit ratings.
  async function candidate(body) {
    if (!allowedKeys(body, ['session'])) invalid();
    await check(body.session);
    if (inviting) return { invitation: null };
    inviting = true;
    try {
      await status();
      await check(body.session);
      if (!enrollment.available || !enrollment.enrolled || enrollment.local_collection_paused
        || !supportedInvitationPolicy(enrollment.invitation_policy)
        || !(await invitationPreference(client.config)).enabled) return { invitation: null };
      const snapshot = await telemetrySnapshot(client);
      const page = await list(body);
      const item = page.items.find(item => invitationEligible(item, snapshot.epoch, clock()) && sampledRecall(item.retrieval_id));
      if (!item) return { invitation: null };
      const reservation = await reserveInvitation(client.config, clock());
      if (!reservation) return { invitation: null };
      await check(body.session);
      if (!await telemetryAllowed(client.config, snapshot.binding, snapshot.epoch, snapshot.revision)) return { invitation: null };
      const expiresAt = Math.min(clock() + INVITATION_LIMITS.leaseMs, Date.parse(item.expires_at),
        Date.parse(item.recorded_at) + INVITATION_LIMITS.recentMs);
      invitation = { id: randomUUID(), session: body.session, snapshot, reservation, expiresAt,
        retrievalId: item.retrieval_id, events: new Map() };
      return { invitation: { invitation_id: invitation.id, retrieval_id: item.retrieval_id,
        recorded_at: item.recorded_at, count: item.count, expires_at: new Date(expiresAt).toISOString() } };
    } finally { inviting = false; }
  }

  async function recordInvitation(current, action, dismissal) {
    await check(current.session);
    if (current.expiresAt <= clock()
      || !await telemetryAllowed(client.config, current.snapshot.binding, current.snapshot.epoch, current.snapshot.revision)) {
      throw new MemoryHouseError('TELEMETRY_STATE_CHANGED', 'The invitation expired or participation changed.');
    }
    let event = current.events.get(action);
    if (!event) {
      event = { queued: false, body: { event_id: randomUUID(), epoch: current.snapshot.epoch,
        policy: INVITATION_POLICY, action, surface: 'review_canvas_banner', occurred_at: new Date(clock()).toISOString(),
        ...(action === 'dismissed' ? { dismissal } : {}) } };
      current.events.set(action, event);
    }
    if (!event.queued) {
      event.queued = await enqueueTelemetry(client, current.snapshot,
        [{ kind: 'invitation', retrievalId: current.retrievalId, body: event.body }], current.snapshot.epoch, { clock, log });
      if (!event.queued) throw new MemoryHouseError('TELEMETRY_STATE_CHANGED', 'Participation changed; the invitation event was not queued.');
    }
    sending ??= flushTelemetry({ client, clock, log }).finally(() => { sending = null; });
    return { status: 'queued' };
  }

  async function invitationEvent(body) {
    if (!allowedKeys(body, ['session', 'invitation_id', 'action']) || !['shown', 'opened', 'dismissed'].includes(body.action)) invalid();
    await check(body.session);
    const current = invitation;
    if (!current || body.invitation_id !== current.id || current.session !== body.session
      || !await invitationReserved(client.config, current.reservation)) {
      throw new MemoryHouseError('TELEMETRY_STATE_CHANGED', 'This invitation is no longer active.');
    }
    if (body.action === 'shown') {
      await status();
      if (current !== invitation) throw new MemoryHouseError('TELEMETRY_STATE_CHANGED', 'Invitations or collection are now disabled.');
      const page = await list({ session: body.session });
      if (!page.items.some(item => item.retrieval_id === current.retrievalId
        && invitationEligible(item, current.snapshot.epoch, clock()))) {
        throw new MemoryHouseError('TELEMETRY_STATE_CHANGED', 'This recall is no longer eligible for an invitation.');
      }
      if (!current.events.has('shown') && !await confirmInvitationShown(client.config, current.reservation, clock())) {
        throw new MemoryHouseError('TELEMETRY_STATE_CHANGED', 'Invitations are now disabled or this reservation expired.');
      }
    } else if (!current.events.get('shown')?.queued
      || (body.action === 'opened' && !viewed.has(current.retrievalId))) invalid();
    if (body.action === 'dismissed') await dismissInvitation(client.config, current.reservation, clock());
    const result = await recordInvitation(current, body.action, 'dismiss');
    if (body.action !== 'shown') invitation = null;
    return result;
  }

  async function invitationSettings(body) {
    if (!allowedKeys(body, ['session', 'enabled']) || typeof body.enabled !== 'boolean') invalid();
    await check(body.session);
    const current = invitation;
    const result = await setInvitationPreference(client.config, body.enabled, clock());
    invitation = null;
    if (!body.enabled && current?.events.get('shown')?.queued) {
      try { await recordInvitation(current, 'dismissed', 'stop_asking'); }
      catch {
        // The local preference must take effect even if metadata cannot be queued.
        result.warning = 'Invitations are off on this installation, but the dismissal event could not be queued.';
        log('invitation:dismissal:not-queued');
      }
    }
    return result;
  }

  return { status, check, preference, list, detail, feedback, candidate, invitationEvent, invitationSettings,
    close: async () => { await sending; } };
}
