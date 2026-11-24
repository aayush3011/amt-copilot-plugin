import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicJson, ensureDirectory, inspectDirectorySync, readState, withLock } from './state.mjs';
import { MemoryHouseError } from './errors.mjs';

// TODO(dogfood-feedback): Review this internal invitation policy before external
// customer release; sampling, local preferences and the surface may change or be removed.
export const INVITATION_POLICY = 'inv-2026-11-06.1';
export const INVITATION_LIMITS = Object.freeze({
  sampleRate: 0.1, recentMs: 86400000, intervalMs: 86400000,
  dismissMs: 7 * 86400000, leaseMs: 5 * 60000,
});
const pathFor = config => join(config.stateDir, 'invitations.json');
const invalid = () => new MemoryHouseError('INVALID_INVITATION_STATE',
  'Local invitation preferences are invalid. No invitation was shown.');

async function load(config) {
  inspectDirectorySync(config.stateDir);
  const raw = await readState(pathFor(config), 4096);
  if (raw === null) return { version: 1, enabled: true, nextAt: 0, revision: null };
  let state;
  try { state = JSON.parse(raw); } catch { throw invalid(); }
  if (!state || Array.isArray(state) || Object.keys(state).some(key => !['version', 'enabled', 'nextAt', 'revision'].includes(key))
    || state.version !== 1 || typeof state.enabled !== 'boolean'
    || !Number.isSafeInteger(state.nextAt) || state.nextAt < 0
    || typeof state.revision !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(state.revision)) throw invalid();
  return state;
}

async function modify(config, work) {
  await ensureDirectory(config.stateDir);
  return withLock(`${pathFor(config)}.lock`, config.lockTimeoutMs, async () =>
    work(await load(config), next => atomicJson(pathFor(config), next)));
}

export async function invitationPreference(config) {
  return { enabled: (await load(config)).enabled };
}

export async function setInvitationPreference(config, enabled, now = Date.now()) {
  if (typeof enabled !== 'boolean') throw new MemoryHouseError('INVALID_PAYLOAD', 'Choose whether to show invitations.');
  return modify(config, async (state, save) => {
    await save({ ...state, enabled, nextAt: enabled ? state.nextAt : Math.max(state.nextAt, now + INVITATION_LIMITS.dismissMs),
      revision: randomUUID() });
    return { enabled };
  });
}

export function sampledRecall(id) {
  return createHash('sha256').update(`${INVITATION_POLICY}:${id}`).digest('hex').slice(0, 8) < '19999999';
}

export function supportedInvitationPolicy(policy) {
  return policy?.enabled === true && policy.version === INVITATION_POLICY
    && policy.sample_rate === INVITATION_LIMITS.sampleRate && policy.sample_threshold === '19999999';
}

export function invitationEligible(item, epoch, now = Date.now()) {
  const age = now - Date.parse(item.recorded_at);
  return item.epoch === epoch && epoch > 0 && item.feedback_allowed
    && ['ok', 'empty'].includes(item.status) && item.feedback === null
    && age >= 0 && age < INVITATION_LIMITS.recentMs && Date.parse(item.expires_at) > now;
}

export async function reserveInvitation(config, now = Date.now()) {
  return modify(config, async (state, save) => {
    if (!state.enabled || state.nextAt > now) return null;
    const revision = randomUUID();
    // Reserve before rendering so concurrent panels cannot both invite. A closed
    // or hidden panel may consume the cap, but never creates a false shown event.
    await save({ ...state, revision, nextAt: now + INVITATION_LIMITS.intervalMs });
    return revision;
  });
}

export async function invitationReserved(config, revision) {
  const state = await load(config);
  return state.enabled && state.revision === revision;
}

export async function confirmInvitationShown(config, revision, now = Date.now()) {
  return modify(config, async (state, save) => {
    if (!state.enabled || state.revision !== revision) return false;
    await save({ ...state, nextAt: Math.max(state.nextAt, now + INVITATION_LIMITS.intervalMs) });
    return true;
  });
}

export async function dismissInvitation(config, revision, now = Date.now()) {
  return modify(config, async (state, save) => {
    if (!state.enabled || state.revision !== revision) return false;
    await save({ ...state, nextAt: Math.max(state.nextAt, now + INVITATION_LIMITS.dismissMs), revision: randomUUID() });
    return true;
  });
}
