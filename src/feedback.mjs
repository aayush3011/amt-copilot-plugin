import { MemoryHouseError } from './errors.mjs';

// TODO(dogfood-feedback): These internal dogfooding review/feedback contracts may
// change or be removed; review them before external customer release.
export const FEEDBACK_VALUES = Object.freeze({
  benefit: {
    helped: ['saved_time', 'avoided_repeating_myself', 'right_context', 'recalled_decision'],
    no_difference: ['already_known', 'not_needed', 'not_relevant', 'missing_information'],
    harmed: ['wrong_information', 'outdated_information', 'wrong_scope', 'distracting'], unsure: [],
  },
  relevance: {
    relevant: [], partly_relevant: ['too_general', 'missing_context', 'partly_outdated'],
    irrelevant: ['wrong_topic', 'wrong_project', 'wrong_person', 'duplicate'], unsure: [],
  },
  correctness: {
    correct: [], outdated: ['changed_since', 'superseded_decision'],
    incorrect: ['never_true', 'wrong_details', 'misattributed'], unsure: [],
  },
  applicability: {
    applies: [], partly_applies: ['missing_condition', 'missing_exception', 'too_general'],
    does_not_apply: ['wrong_project', 'wrong_person', 'wrong_environment', 'no_longer_applies'], unsure: [],
  },
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value);
const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
export const validRetrievalId = value => typeof value === 'string' && /^ret_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
const labelTarget = label => label.target === 'retrieval'
  ? label.dimension === 'benefit'
  : integer(label.target, 1, 100) && ['relevance', 'correctness', 'applicability'].includes(label.dimension);
const labelValue = label => Object.hasOwn(FEEDBACK_VALUES[label.dimension] ?? {}, label.value)
  && (label.reasons === undefined || (Array.isArray(label.reasons) && label.reasons.length <= 3
    && new Set(label.reasons).size === label.reasons.length
    && label.reasons.every(reason => FEEDBACK_VALUES[label.dimension][label.value].includes(reason))));

export function validFeedback(body) {
  if (!keys(body, ['event_id', 'epoch', 'surface', 'attestation', 'occurred_at', 'labels'])
    || !uuid(body.event_id) || !integer(body.epoch, 1) || body.surface !== 'review_canvas'
    || body.attestation !== 'client_ui' || !time(body.occurred_at)
    || !Array.isArray(body.labels) || !body.labels.length || body.labels.length > 301
    || Buffer.byteLength(JSON.stringify(body)) > 16 * 1024) return false;
  const seen = new Set();
  return body.labels.every(label => {
    if (!object(label) || !labelTarget(label)) return false;
    const key = `${label.target}:${label.dimension}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return label.action === 'withdraw' ? keys(label, ['target', 'dimension', 'action'])
      : label.action === 'set' && keys(label, ['target', 'dimension', 'action', 'value', 'reasons']) && labelValue(label);
  });
}

function expect(condition) {
  if (!condition) throw new MemoryHouseError('INVALID_RESPONSE', 'Memory House returned an invalid recall review response.');
}

function summary(value) {
  expect(object(value) && validRetrievalId(value.retrieval_id) && time(value.recorded_at) && time(value.expires_at)
    && integer(value.epoch, 1) && integer(value.count, 0, 100) && ['ok', 'empty', 'error'].includes(value.status)
    && typeof value.feedback_allowed === 'boolean'
    && (value.client === null || (object(value.client)
      && ['name', 'version', 'trigger'].every(key => typeof value.client[key] === 'string' && value.client[key].length <= 128)))
    && (value.supplied_ranks === null || (Array.isArray(value.supplied_ranks)
      && new Set(value.supplied_ranks).size === value.supplied_ranks.length
      && value.supplied_ranks.every(rank => integer(rank, 1, value.count))))
    && (value.final_outcome === null || ['ok', 'empty', 'timeout', 'http_error', 'network_error',
      'invalid_response', 'cancelled', 'skipped'].includes(value.final_outcome)));
}

export function validateRecallPage(value) {
  expect(object(value) && Array.isArray(value.items) && value.items.length <= 50
    && (value.cursor === null || (typeof value.cursor === 'string' && value.cursor.length > 0 && value.cursor.length <= 16384)));
  const seen = new Set();
  for (const item of value.items) {
    summary(item);
    expect(!seen.has(item.retrieval_id));
    seen.add(item.retrieval_id);
    expect(item.feedback === null || (object(item.feedback) && integer(item.feedback.revision, 0, 20)
      && integer(item.feedback.labels, 0, 301) && time(item.feedback.updated_at)));
  }
  return value;
}

export function validateRecallDetail(value, id, includeCurrent) {
  summary(value);
  expect(value.retrieval_id === id && Array.isArray(value.items) && value.items.length === value.count);
  const ranks = new Set();
  for (const item of value.items) {
    expect(object(item) && integer(item.rank, 1, value.count) && !ranks.has(item.rank)
      && ['ranked', 'preference', 'procedure', 'insight', 'episode', 'backfill'].includes(item.position)
      && [null, 'full', 'partial', 'none'].includes(item.supplied)
      && (item.supplied === 'none' ? ['budget', 'duplicate_in_session', 'filtered_type', 'no_content', 'invalid_item', 'top_k'].includes(item.omit_reason) : item.omit_reason === null)
      && ['unchanged', 'changed', 'superseded', 'unavailable'].includes(item.memory_state));
    ranks.add(item.rank);
    if (item.memory_state === 'unavailable') {
      expect(keys(item, ['rank', 'position', 'supplied', 'omit_reason', 'memory_state']));
    } else {
      expect(typeof item.memory_id === 'string' && typeof item.memory_type === 'string');
      expect(item.memory_state === 'unchanged' || includeCurrent ? object(item.memory) : item.memory === undefined);
      expect(item.successor_id === undefined || (item.memory_state === 'superseded' && typeof item.successor_id === 'string'));
    }
  }
  if (value.feedback !== null) {
    const feedback = value.feedback;
    expect(object(feedback) && integer(feedback.revision, 0, 20) && integer(feedback.revisions_left, 0, 20)
      && [feedback.first_submitted_at, feedback.updated_at, feedback.expires_at].every(time)
      && Array.isArray(feedback.labels) && feedback.labels.length <= 301);
    const seen = new Set();
    for (const label of feedback.labels) {
      expect(object(label) && labelTarget(label) && labelValue(label) && time(label.updated_at)
        && (label.target === 'retrieval' || label.target <= value.count) && !seen.has(`${label.target}:${label.dimension}`));
      seen.add(`${label.target}:${label.dimension}`);
    }
  }
  return value;
}

export const FEEDBACK_ERRORS = Object.freeze({
  not_enrolled: 'Collection is off. New feedback was not accepted.',
  enrollment_changed: 'Participation changed. Refresh and review a current-epoch recall.',
  telemetry_unavailable: 'Collection is unavailable. You can still review retained recalls.',
  retrieval_not_ready: 'This recall is not ready yet. Retry shortly.',
  retrieval_not_found: 'This recall is unavailable, expired or reset.',
  client_not_allowed: 'This client is not permitted to submit feedback.',
  feedback_limit: 'This recall has reached its limit of 20 feedback revisions.',
  invalid_request: 'The feedback request was rejected. Refresh before trying again.',
  invalid_cursor: 'The recall list changed or its cursor expired. Refresh recalls to restart from the newest page.',
  payload_too_large: 'The feedback request is too large.',
});
