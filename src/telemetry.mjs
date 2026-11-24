import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, ensureDirectory, inspectDirectorySync, readState, withLock } from './state.mjs';
import { MemoryHouseError } from './errors.mjs';
import { INVITATION_POLICY } from './invitations.mjs';

// TODO(dogfood-feedback): Review this internal dogfooding feedback loop (consent, event
// contracts, queue, retention and sender) before external customer release; revise or remove as needed.
export const TELEMETRY_NOTICE_VERSION = '2026-11-06.3';
export const TELEMETRY_NOTICE = `Memory House collects retrieval telemetry by default while we dogfood it internally.

What's collected: for each memory search, its time and settings; how many results came back, with their types and positions; which results were added to your conversation and why others were left out; and whether the request succeeded. If you rate a recall in the review canvas, your ratings and the reasons you pick are collected too. These records are linked by random IDs. If the review canvas invites you to rate a recall, whether that invitation was shown, opened or dismissed is collected as well.

What isn't collected: your prompts, answers, search text or memory text. Reviewing a recall shows your memories as they are now; no copy of what was recalled is kept.

How long it's kept: 60 days from collection, in your account's Cosmos DB and in Memory House telemetry (Kusto). A rating is kept for 60 days from when you first submit it; changing or withdrawing it doesn't extend that. Only your latest ratings count, but earlier versions already sent to telemetry (at most 20 per recall) remain until then. Resetting your memories deletes all of it sooner.

Who can see it: designated Memory House maintainers, as metadata only. They don't get your memory text through it.

Opting out: you can opt out at any time. Opting out stops new collection immediately; what was already collected is kept until its retention ends. Your memories and the existing count-only usage telemetry are unaffected.`;
export const TELEMETRY_OPT_OUT = 'To opt out, use mh-telemetry or select Feedback > Opt out of new collection in the Memory House canvas.';
export const TELEMETRY_LIMITS = Object.freeze({
  events: 200, bytes: 512 * 1024, eventBytes: 16 * 1024,
  ageMs: 30 * 24 * 60 * 60 * 1000, lockMs: 250, passes: 12,
});
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const RETRIEVAL = /^ret_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HEX = /^[a-f\d]{64}$/;
const OMIT = new Set(['budget', 'duplicate_in_session', 'filtered_type', 'no_content', 'invalid_item', 'top_k']);
const OUTCOME = new Set(['ok', 'empty', 'timeout', 'http_error', 'network_error', 'invalid_response', 'cancelled', 'skipped']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const epochValue = value => integer(value, 0, Number.MAX_SAFE_INTEGER);
const uuid = value => typeof value === 'string' && UUID.test(value);
const retrievalId = value => typeof value === 'string' && RETRIEVAL.test(value);
const keysOnly = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key));
const hash = value => createHash('sha256').update(value).digest('hex');
const pathFor = config => join(config.stateDir, `telemetry-${hash(config.gatewayBase)}.json`);
const fail = (code, message) => new MemoryHouseError(code, message);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
  && Number.isFinite(Date.parse(value));

export function validTelemetryEvent(kind, body, id) {
  if (kind === 'invitation') return keysOnly(body, ['event_id', 'epoch', 'policy', 'action', 'dismissal', 'surface', 'occurred_at'])
    && uuid(body.event_id) && integer(body.epoch, 1, Number.MAX_SAFE_INTEGER) && retrievalId(id)
    && timestamp(body.occurred_at) && body.policy === INVITATION_POLICY && body.surface === 'review_canvas_banner'
    && ['shown', 'opened', 'dismissed'].includes(body.action)
    && (body.action === 'dismissed' ? ['dismiss', 'stop_asking'].includes(body.dismissal) : !Object.hasOwn(body, 'dismissal'));
  if (!object(body) || !uuid(body.event_id) || !epochValue(body.epoch) || !uuid(body.client_request_id)
    || !timestamp(body.occurred_at) || body.surface !== 'auto_recall_injection'
    || Buffer.byteLength(JSON.stringify(body)) > TELEMETRY_LIMITS.eventBytes) return false;
  if (kind === 'delivery') {
    return retrievalId(id) && keysOnly(body, ['event_id', 'epoch', 'client_request_id', 'surface', 'occurred_at',
      'budget_bytes', 'supplied_bytes', 'items'])
      && integer(body.budget_bytes, 0, 1048576) && integer(body.supplied_bytes, 0, body.budget_bytes)
      && Array.isArray(body.items) && body.items.length <= 100
      && body.items.every((item, index) => keysOnly(item, ['rank', 'supplied', 'omit_reason'])
        && item.rank === index + 1 && ['full', 'partial', 'none'].includes(item.supplied)
        && (item.supplied === 'none' ? OMIT.has(item.omit_reason) : !Object.hasOwn(item, 'omit_reason')));
  }
  return kind === 'outcome' && id === undefined
    && keysOnly(body, ['event_id', 'epoch', 'client_request_id', 'surface', 'occurred_at', 'trigger',
      'attempts', 'elapsed_ms', 'final_outcome', 'used_retrieval_id', 'http_status'])
    && body.trigger === 'auto_recall_first_prompt' && OUTCOME.has(body.final_outcome)
    && integer(body.attempts, body.final_outcome === 'skipped' ? 0 : 1, 20)
    && integer(body.elapsed_ms, 0, 600000)
    && (body.final_outcome === 'http_error' ? integer(body.http_status, 400, 599) : body.http_status === undefined)
    && (body.used_retrieval_id === undefined
      || (['ok', 'empty'].includes(body.final_outcome) && retrievalId(body.used_retrieval_id)));
}

export function validateEnrollment(value) {
  if (!object(value) || typeof value.available !== 'boolean' || typeof value.enrolled !== 'boolean'
    || !epochValue(value.epoch) || ![30, 60].includes(value.retention_days)
    || typeof value.current_notice_version !== 'string' || value.current_notice_version.length > 64
    || (value.notice_version !== null && typeof value.notice_version !== 'string')
    || (value.enrolled_at !== null && !timestamp(value.enrolled_at))
    || (value.state !== undefined && !['default_on', 'enabled', 'opted_out'].includes(value.state))
    || (value.policy_version !== undefined && (typeof value.policy_version !== 'string' || value.policy_version.length > 64))
    || (value.feedback_retention_days !== undefined && value.feedback_retention_days !== 60)
    || (value.invitation_policy !== undefined && (!object(value.invitation_policy)
      || typeof value.invitation_policy.enabled !== 'boolean'
      || typeof value.invitation_policy.version !== 'string' || value.invitation_policy.version.length > 64
      || typeof value.invitation_policy.sample_rate !== 'number' || !Number.isFinite(value.invitation_policy.sample_rate)
      || value.invitation_policy.sample_rate < 0 || value.invitation_policy.sample_rate > 1
      || typeof value.invitation_policy.sample_threshold !== 'string'
      || !/^[a-f\d]{8}$/.test(value.invitation_policy.sample_threshold)))
    || (value.opted_out_at !== undefined && value.opted_out_at !== null && !timestamp(value.opted_out_at))
    || (value.deletion !== null && (!object(value.deletion)
      || !['running', 'completed'].includes(value.deletion.status)
      || typeof value.deletion.request_id !== 'string'
      || !/^tdel_[A-Za-z0-9_-]{1,96}$/.test(value.deletion.request_id)))) {
    throw fail('INVALID_RESPONSE', 'Memory House returned an invalid telemetry enrollment response.');
  }
  return { available: value.available, enrolled: value.enrolled, epoch: value.epoch,
    notice_version: value.notice_version, current_notice_version: value.current_notice_version,
    enrolled_at: value.enrolled_at, retention_days: value.retention_days,
    ...(value.state === undefined ? {} : { state: value.state }),
    ...(value.policy_version === undefined ? {} : { policy_version: value.policy_version }),
    ...(value.feedback_retention_days === undefined ? {} : { feedback_retention_days: value.feedback_retention_days }),
    ...(value.opted_out_at === undefined ? {} : { opted_out_at: value.opted_out_at }),
    ...(value.invitation_policy === undefined ? {} : { invitation_policy: {
      version: value.invitation_policy.version, enabled: value.invitation_policy.enabled,
      sample_rate: value.invitation_policy.sample_rate, sample_threshold: value.invitation_policy.sample_threshold,
    } }),
    deletion: value.deletion === null ? null : {
      request_id: value.deletion.request_id, status: value.deletion.status,
      ...(timestamp(value.deletion.requested_at) ? { requested_at: value.deletion.requested_at } : {}),
      ...(value.deletion.completed_at === null || timestamp(value.deletion.completed_at)
        ? { completed_at: value.deletion.completed_at } : {}),
    } };
}

function fresh(config, binding) {
  return { version: 1, gateway: hash(config.gatewayBase), binding, revision: randomUUID(),
    epoch: null, enabled: false, pendingOptOut: false, events: [] };
}

async function load(config) {
  inspectDirectorySync(config.stateDir);
  const raw = await readState(pathFor(config), TELEMETRY_LIMITS.bytes);
  if (raw === null) return null;
  let state;
  try { state = JSON.parse(raw); } catch { throw fail('INVALID_TELEMETRY_STATE', 'Local telemetry state is invalid. No telemetry was sent.'); }
  if (!keysOnly(state, ['version', 'gateway', 'binding', 'revision', 'epoch', 'enabled', 'pendingOptOut', 'events'])
    || state.version !== 1 || state.gateway !== hash(config.gatewayBase)
    || !HEX.test(state.binding) || !uuid(state.revision)
    || !(state.epoch === null || epochValue(state.epoch)) || typeof state.enabled !== 'boolean'
    || typeof state.pendingOptOut !== 'boolean' || !Array.isArray(state.events)
    || state.events.length > TELEMETRY_LIMITS.events
    || state.events.some(event => !keysOnly(event, ['kind', 'body', 'retrievalId', 'createdAt', 'nextAt', 'attempts'])
      || !validTelemetryEvent(event.kind, event.body, event.retrievalId) || event.body.epoch !== state.epoch
      || !Number.isFinite(event.createdAt) || !Number.isFinite(event.nextAt) || !integer(event.attempts, 0, 100000))) {
    throw fail('INVALID_TELEMETRY_STATE', 'Local telemetry state is invalid. No telemetry was sent.');
  }
  return state;
}

async function modify(config, work) {
  await ensureDirectory(config.stateDir);
  return withLock(`${pathFor(config)}.lock`, TELEMETRY_LIMITS.lockMs, async () => {
    const state = await load(config);
    return work(state, async next => {
      if (Buffer.byteLength(JSON.stringify(next)) > TELEMETRY_LIMITS.bytes) {
        throw fail('TELEMETRY_QUEUE_FULL', 'Local telemetry queue reached its size limit.');
      }
      await atomicJson(pathFor(config), next);
    });
  });
}

export async function telemetrySnapshot(client) {
  const identity = await client.captureIdentity();
  if (!identity?.accountBound) return null;
  const state = await load(client.config);
  const own = state?.binding === identity.binding ? state : null;
  return { binding: identity.binding, revision: own?.revision ?? null,
    epoch: own?.enabled && !own.pendingOptOut ? own.epoch : null };
}

function matches(state, snapshot) {
  return (state?.binding === snapshot.binding ? state.revision : null) === snapshot.revision;
}

/** Recheck the local fence immediately before the authenticated sender's network request. */
export async function telemetryAllowed(config, binding, epoch, revision) {
  const state = await load(config);
  return state?.binding === binding && state.revision === revision && state.enabled
    && !state.pendingOptOut && state.epoch === epoch;
}

export async function clearTelemetry(config) {
  await modify(config, async (state, save) => {
    if (state) await save({ ...state, revision: randomUUID(), epoch: null, enabled: false, pendingOptOut: false, events: [] });
  });
}

async function updateEnrollment(client, snapshot, response, explicit = false) {
  const enrollment = validateEnrollment(response);
  return modify(client.config, async (prior, save) => {
    if (!matches(prior, snapshot) || (await client.captureIdentity())?.binding !== snapshot.binding) {
      throw fail('TELEMETRY_STATE_CHANGED', 'Sign-in or telemetry preference changed during the operation. Check telemetry status.');
    }
    const state = prior?.binding === snapshot.binding ? prior : fresh(client.config, snapshot.binding);
    // A GET must not undo an opt-out whose DELETE has not been acknowledged.
    if (state.pendingOptOut && !explicit) return { ...enrollment, local_collection_paused: true, queued_events: 0 };
    const changed = state.epoch !== enrollment.epoch || !enrollment.enrolled || !enrollment.available || explicit;
    await save({ ...state, revision: changed ? randomUUID() : state.revision,
      enabled: enrollment.enrolled && enrollment.available, epoch: enrollment.epoch,
      pendingOptOut: false, events: changed ? [] : state.events });
    return { ...enrollment, local_collection_paused: !enrollment.enrolled || !enrollment.available,
      queued_events: changed ? 0 : state.events.length };
  });
}

export async function telemetryCommand(client, action, noticeVersion = TELEMETRY_NOTICE_VERSION, { expectedBinding } = {}) {
  if (action === 'notice') return { notice_version: TELEMETRY_NOTICE_VERSION, notice: TELEMETRY_NOTICE };
  if (!['status', 'enable', 'disable'].includes(action)) throw fail('USAGE', 'Telemetry action must be notice, status, enable or disable.');
  await ensureDirectory(client.config.stateDir);
  // Serialize explicit preference changes, not hook bookkeeping or background delivery.
  return withLock(`${pathFor(client.config)}.command.lock`, client.config.lockTimeoutMs, async () => {
    let snapshot = await telemetrySnapshot(client);
    if (!snapshot) throw fail('NOT_SIGNED_IN', 'Sign in to Memory House before changing telemetry preferences.');
    if (expectedBinding !== undefined && snapshot.binding !== expectedBinding) {
      throw fail('TELEMETRY_STATE_CHANGED', 'Sign-in changed. Refresh before changing telemetry preferences.');
    }
    if (action === 'disable') {
      await modify(client.config, async (prior, save) => {
        if (!matches(prior, snapshot)) throw fail('TELEMETRY_STATE_CHANGED', 'Telemetry preference changed. Retry opt-out.');
        const state = prior?.binding === snapshot.binding ? prior : fresh(client.config, snapshot.binding);
        const next = { ...state, revision: randomUUID(), enabled: false, pendingOptOut: true, events: [] };
        await save(next);
        snapshot = { ...snapshot, revision: next.revision };
      });
    }
    let response;
    try {
      const current = action === 'status' ? null : await client.telemetryEnrollment('GET', { binding: snapshot.binding });
      response = await client.telemetryEnrollment(action === 'status' ? 'GET' : action === 'enable' ? 'POST' : 'DELETE',
        { binding: snapshot.binding, noticeVersion, ...(current ? { epoch: current.epoch } : {}) });
    } catch (error) {
      if (action !== 'disable') {
        if (error.problem === 'enrollment_changed') throw fail('TELEMETRY_STATE_CHANGED', 'Telemetry enrollment changed. Check its status and confirm the preference again.');
        if (error.problem === 'telemetry_unavailable') throw fail('TELEMETRY_UNAVAILABLE', 'Optional retrieval telemetry is unavailable for this account.');
        throw error;
      }
      throw fail('TELEMETRY_OPT_OUT_PENDING',
        'Local telemetry is paused and queued events were discarded, but server opt-out is unconfirmed. Retry telemetry-disable to stop new server collection. Previously recorded metadata retains its original expiry.');
    }
    if (action === 'enable' && (!response.enrolled || !response.available)) {
      throw fail('INVALID_RESPONSE', 'Memory House did not confirm telemetry enrollment.');
    }
    if (action === 'disable' && response.enrolled) {
      throw fail('TELEMETRY_OPT_OUT_PENDING', 'Local telemetry is paused, but server opt-out was not confirmed. Retry telemetry-disable.');
    }
    return updateEnrollment(client, snapshot, response, action !== 'status');
  });
}

/** Queue only constructed, allowlisted metadata; never persist the search response or query. */
export async function enqueueTelemetry(client, snapshot, events, epoch, { clock = Date.now, log = () => {} } = {}) {
  if (!snapshot || !epochValue(epoch) || !events.length) return false;
  if (events.some(event => !keysOnly(event, ['kind', 'body', 'retrievalId'])
    || !validTelemetryEvent(event.kind, event.body, event.retrievalId) || event.body.epoch !== epoch)) {
    throw fail('INVALID_PAYLOAD', 'Telemetry contains unsupported metadata; no events were queued.');
  }
  return modify(client.config, async (prior, save) => {
    if (!matches(prior, snapshot) || (await client.captureIdentity())?.binding !== snapshot.binding) return false;
    const state = prior?.binding === snapshot.binding ? prior : fresh(client.config, snapshot.binding);
    if (state.pendingOptOut) return false;
    if (state.epoch !== null && epoch < state.epoch) return false;
    const now = clock();
    const kept = state.epoch === epoch
      ? state.events.filter(event => now - event.createdAt < TELEMETRY_LIMITS.ageMs && event.createdAt <= now) : [];
    for (const event of events) {
      if (!kept.some(prior => prior.body.event_id === event.body.event_id)) {
        kept.push({ ...event, createdAt: now, attempts: 0, nextAt: now });
      }
    }
    let evicted = 0;
    const next = { ...state, revision: state.epoch === epoch ? state.revision : randomUUID(), epoch, enabled: true, events: kept };
    while (kept.length > TELEMETRY_LIMITS.events || Buffer.byteLength(JSON.stringify(next)) > TELEMETRY_LIMITS.bytes) {
      kept.shift();
      evicted++;
    }
    await save(next);
    if (evicted) log(`telemetry:queue:evicted:${evicted}`);
    return true;
  });
}

export async function recordRecallTelemetry({ client, snapshot, requestId, result, rendered, error,
  startedAt, clock = Date.now, log = () => {} }) {
  if (!snapshot) return false;
  const retrieval = result?.retrieval;
  if (retrieval?.recording === 'off' && ['not_enrolled', 'unavailable'].includes(retrieval.reason)) {
    await modify(client.config, async (state, save) => {
      if (state?.binding === snapshot.binding && matches(state, snapshot) && !state.pendingOptOut) {
        await save({ ...state, revision: randomUUID(), enabled: false, epoch: null, events: [] });
      }
    });
    return false;
  }
  const recorded = retrieval?.recording === 'recorded' && retrievalId(retrieval.id) && epochValue(retrieval.epoch);
  if (retrieval?.recording === 'recorded' && !recorded) {
    log('telemetry:recall:invalid-metadata');
    return false;
  }
  const epoch = recorded ? retrieval.epoch : snapshot.epoch;
  if (!epochValue(epoch)) return false;
  const now = clock();
  const common = { epoch, client_request_id: requestId, surface: 'auto_recall_injection', occurred_at: new Date(now).toISOString() };
  let finalOutcome = Array.isArray(result?.items) && !result.items.length ? 'empty' : 'ok';
  if (error) finalOutcome = error.code === 'REQUEST_TIMEOUT' || ['AbortError', 'TimeoutError'].includes(error.name)
    ? 'timeout' : integer(error.status, 400, 599) ? 'http_error'
      : ['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'].includes(error.code) ? 'invalid_response' : 'network_error';
  const events = [];
  if (recorded && rendered?.ok) {
    if (!Array.isArray(result.items) || result.items.length > 100 || rendered.presentation?.length !== result.items.length
      || result.items.some((item, index) => item?.rank !== index + 1)) {
      log('telemetry:recall:invalid-ranks');
      return false;
    }
    events.push({ kind: 'delivery', retrievalId: retrieval.id, body: {
      ...common, event_id: randomUUID(), budget_bytes: 8192, supplied_bytes: Buffer.byteLength(rendered.context),
      items: rendered.presentation.map(item => ({ rank: item.rank,
        supplied: item.supplied ? (item.partial ? 'partial' : 'full') : 'none',
        ...(item.supplied ? {} : { omit_reason: item.omit_reason }) })),
    } });
  }
  events.push({ kind: 'outcome', body: { ...common, event_id: randomUUID(),
    trigger: 'auto_recall_first_prompt', attempts: 1, elapsed_ms: Math.min(600000, Math.max(0, now - startedAt)),
    final_outcome: finalOutcome, ...(finalOutcome === 'http_error' ? { http_status: error.status } : {}),
    ...(recorded && !error ? { used_retrieval_id: retrieval.id } : {}),
  } });
  return enqueueTelemetry(client, snapshot, events, epoch, { clock, log });
}

export async function telemetryPending(client, clock = Date.now) {
  const snapshot = await telemetrySnapshot(client);
  if (!snapshot) return false;
  const state = await load(client.config);
  return state?.binding === snapshot.binding && state.enabled && !state.pendingOptOut
    && state.events.some(event => event.nextAt <= clock());
}

/** Bounded asynchronous sender. Claims are local; HTTP requests never hold the bookkeeping lock. */
export async function flushTelemetry({ client, clock = Date.now, log = () => {}, wait = delay }) {
  let sent = 0;
  for (let pass = 0; pass < TELEMETRY_LIMITS.passes; pass++) {
    let selected;
    try {
      const identity = await client.captureIdentity();
      if (!identity?.accountBound) { await clearTelemetry(client.config); break; }
      await modify(client.config, async (state, save) => {
        if (!state) return;
        if (state.binding !== identity.binding) {
          await save(fresh(client.config, identity.binding));
          return;
        }
        if (!state.enabled || state.pendingOptOut) return;
        const now = clock();
        const events = state.events.filter(event => event.createdAt <= now && now - event.createdAt < TELEMETRY_LIMITS.ageMs);
        const event = events.find(item => item.nextAt <= now);
        if (event) {
          event.attempts++;
          event.nextAt = now + 60_000;
          selected = { ...event, binding: state.binding, revision: state.revision };
        }
        if (events.length !== state.events.length) log('telemetry:queue:expired');
        await save({ ...state, events });
      });
      if (!selected) break;
      let error;
      try {
        await client.telemetrySubmit(selected.kind, selected.body, {
          retrievalId: selected.retrievalId, binding: selected.binding, revision: selected.revision,
        });
        sent++;
      } catch (failure) { error = failure; }
      const fenced = error?.status === 409 && ['not_enrolled', 'enrollment_changed', 'telemetry_unavailable'].includes(error.problem);
      const notReadyExpired = error?.problem === 'retrieval_not_ready' && clock() - selected.createdAt >= 60_000;
      const drop = !error || fenced || notReadyExpired
        || [400, 404, 413, 422].includes(error.status)
        || ['INVALID_PAYLOAD', 'NOT_SIGNED_IN', 'TELEMETRY_STATE_CHANGED'].includes(error.code);
      await modify(client.config, async (state, save) => {
        if (!state || state.binding !== selected.binding || state.revision !== selected.revision) return;
        if (fenced) {
          await save({ ...state, revision: randomUUID(), enabled: false, epoch: null, events: [] });
          return;
        }
        const events = state.events.filter(event => !(drop && event.body.event_id === selected.body.event_id));
        if (!drop) {
          const event = events.find(item => item.body.event_id === selected.body.event_id);
          if (event) event.nextAt = clock() + Math.max(
            error?.problem === 'retrieval_not_ready' ? 1000 : Math.min(600_000, 30_000 * 2 ** Math.min(event.attempts - 1, 5)),
            Math.min(86400, error?.retryAfterSeconds ?? 0) * 1000);
        }
        await save({ ...state, events });
      });
      if (error) {
        log(`telemetry:sender:${fenced ? 'consent-changed' : drop ? 'discarded' : 'retry-later'}`);
        if (fenced) {
          const snapshot = await telemetrySnapshot(client);
          if (snapshot) await updateEnrollment(client, snapshot, await client.telemetryEnrollment('GET', { binding: snapshot.binding }));
        }
        if (!drop && error.problem === 'retrieval_not_ready' && clock() - selected.createdAt < 60_000) {
          await wait(Math.min(60_000 - (clock() - selected.createdAt), Math.max(1000, (error.retryAfterSeconds ?? 1) * 1000)));
        } else if (!drop || fenced) break;
      }
    } catch (error) {
      log(`telemetry:sender:failed:${error instanceof MemoryHouseError ? error.code.toLowerCase() : 'io'}`);
      break;
    }
  }
  return { sent };
}
