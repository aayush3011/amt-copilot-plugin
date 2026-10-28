// Memory House canvas data: the caller's memories from GET /memories, labelled and grouped by
// the hierarchy nodes in GET /v1/me/reach, plus the identity from GET /whoami. The Playbooks view
// lists GET /memories narrowed to scope keys: a playbook's sections, or the caller's own scope. All
// calls use the plugin's existing gateway-bound HookToken sign-in; nothing here stores credentials.
import { createClient, isListingScope, MEMORY_LIST_LIMITS, MEMORY_TYPES, sendRequest } from '../client.mjs';
import { MemoryHouseError } from '../errors.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 4096) => (typeof value === 'string' && value.length <= max ? value : null);
const NODE_PREFIX = 'node:';
const MAX_TIMEOUT_MS = 300_000;
const SCOPED_LISTING_CONCURRENCY = 3;

export const CANVAS_DEFAULTS = Object.freeze({ limit: MEMORY_LIST_LIMITS.maxCount });

/** A signed-in gateway client plus an authenticated JSON request helper for canvas-only routes. */
export function createGateway(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const client = options.client ?? createClient({ ...options.clientOptions, fetch: fetchImpl });
  async function json(path, { method = 'GET', body, headers = {}, operation = 'request', timeoutMs } = {}) {
    const token = await client.getAccessToken();
    const limit = Math.min(Math.max(timeoutMs ?? client.config.timeoutMs, 1), MAX_TIMEOUT_MS);
    return sendRequest({
      url: `${client.config.gatewayBase}${path}`, fetch: fetchImpl, timeoutMs: limit,
      maxResponseBytes: client.config.maxResponseBytes, method, body, operation,
      headers: { ...headers, Authorization: `HookToken ${token}` },
    });
  }
  return Object.freeze({ client, json });
}

export function normalizeFilters(filters = {}) {
  const limit = Number(filters.limit);
  return {
    search: typeof filters.search === 'string' ? filters.search.trim().slice(0, 256) : '',
    memoryTypes: [...new Set((Array.isArray(filters.memoryTypes) ? filters.memoryTypes : [])
      .filter(type => MEMORY_TYPES.includes(type)))],
    includeSuperseded: filters.includeSuperseded === true,
    limit: Number.isInteger(limit) && limit >= 1 && limit <= MEMORY_LIST_LIMITS.maxCount ? limit : CANVAS_DEFAULTS.limit,
  };
}

function validWho(data) {
  if (!isObject(data) || !text(data.principal, 512)) return null;
  return { principal: data.principal, tenant: text(data.tenant_id, 512) };
}

function validNodes(data) {
  if (!isObject(data) || !Array.isArray(data.nodes)) return null;
  return data.nodes.flatMap(node => {
    if (!isObject(node) || !text(node.id, 256)?.startsWith(NODE_PREFIX) || !text(node.name, 1024)) return [];
    return [{
      id: node.id,
      name: node.name,
      path: text(node.path, 8192) ?? node.name,
      parentId: text(node.parent_id, 256),
      description: text(node.description, 4096),
    }];
  });
}

/**
 * Load one canvas snapshot. A listing failure (including "not signed in") rejects; a failed
 * identity or hierarchy read only adds a warning so memories still render.
 */
export async function loadCanvasData(gateway, filters = {}) {
  const selected = normalizeFilters(filters);
  const [listing, who, reach] = await Promise.allSettled([
    gateway.client.getMemories({
      recent_k: selected.limit,
      memory_types: selected.memoryTypes,
      include_superseded: selected.includeSuperseded,
    }),
    gateway.json('/whoami', { operation: 'identity' }),
    gateway.json('/v1/me/reach', { operation: 'hierarchy' }),
  ]);
  if (listing.status === 'rejected') throw listing.reason;
  const warnings = [];
  const identity = who.status === 'fulfilled' ? validWho(who.value.data) : null;
  if (!identity) warnings.push('Your signed-in identity could not be loaded.');
  const nodes = reach.status === 'fulfilled' ? validNodes(reach.value.data) : null;
  if (!nodes) warnings.push('The hierarchy could not be loaded, so shared memories are shown by node ID.');
  return shapeCanvasData({ who: identity, nodes: nodes ?? [], listing: listing.value, filters: selected, warnings });
}

async function mapLimited(values, limit, work) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await work(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

/**
 * The newest memories the caller can read in each of `scopes`, as canvas records grouped by scope
 * key. AMT filters one listing by at most 20 scopes and returns at most 200 memories, so scopes are
 * listed in batches of 20, and `truncated` is true when a batch had more. `labels` maps a scope to
 * `{ name, path }` for card labels. Scope keys AMT cannot filter by, such as keys longer than 512
 * characters, are skipped.
 */
export async function loadScopedMemories(gateway, scopes, { labels = new Map(), principal = null } = {}) {
  const wanted = [...new Set(scopes)].filter(isListingScope);
  const batches = [];
  for (let index = 0; index < wanted.length; index += MEMORY_LIST_LIMITS.maxScopes) {
    batches.push(wanted.slice(index, index + MEMORY_LIST_LIMITS.maxScopes));
  }
  const listings = await mapLimited(batches, SCOPED_LISTING_CONCURRENCY,
    batch => gateway.client.getMemories({ recent_k: MEMORY_LIST_LIMITS.maxCount, scopes: batch }));
  const keep = new Set(wanted);
  const groups = {};
  const seen = new Set();
  let total = 0;
  for (const item of listings.flatMap(listing => listing.items)) {
    if (!isObject(item) || typeof item.id !== 'string' || seen.has(item.id) || !keep.has(item.scope_key)) continue;
    seen.add(item.id);
    const record = shapeRecord(item, labels, principal);
    (groups[record.scope_key] ||= []).push(record);
    total += 1;
  }
  for (const list of Object.values(groups)) list.sort(newestFirst);
  return { groups, total, truncated: listings.some(listing => listing.has_more === true) };
}

/** The caller's personal memories: the newest 200 in the principal scope that GET /whoami names. */
export async function loadPersonalMemories(gateway) {
  const who = await loadIdentity(gateway);
  if (!isListingScope(who.principal)) {
    throw new MemoryHouseError('INVALID_RESPONSE', 'Memory House did not return your signed-in identity. Try again.');
  }
  const { groups, total, truncated } = await loadScopedMemories(gateway, [who.principal], { principal: who.principal });
  return { principal: who.principal, tenant: who.tenant, memories: groups[who.principal] ?? [], total, truncated };
}

/** The signed-in Memory House principal and tenant from GET /whoami. */
export async function loadIdentity(gateway) {
  const who = validWho((await gateway.json('/whoami', { operation: 'identity' })).data);
  if (!who) throw new MemoryHouseError('INVALID_RESPONSE', 'Memory House did not return your signed-in identity. Try again.');
  return who;
}

function displayPath(path) {
  return String(path || '').split('/').filter(Boolean).join(' / ');
}

function memoryText(item) {
  for (const key of ['content', 'text', 'summary', 'title', 'name']) {
    if (typeof item[key] === 'string' && item[key].trim()) return item[key];
  }
  return '';
}

function shapeRecord(item, nodes, principal) {
  const scope = typeof item.scope_key === 'string' ? item.scope_key : '';
  const node = nodes.get(scope);
  const personal = scope.startsWith('user:') && (!principal || scope === principal);
  const kind = personal ? 'personal' : node ? 'node' : scope.startsWith(NODE_PREFIX) ? 'unlisted' : 'other';
  const source = isObject(item.source) ? text(item.source.source, 256) ?? text(item.source.application, 256) : null;
  return {
    id: item.id,
    scope_key: scope,
    scope_kind: kind,
    scope_label: personal ? 'Personal' : node ? node.name : kind === 'unlisted' ? 'Unlisted node' : scope || 'Unknown scope',
    scope_path: node ? displayPath(node.path) : '',
    type: text(item.memory_type, 64) ?? text(item.type, 64),
    content: memoryText(item),
    tags: Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === 'string').slice(0, 20) : [],
    created_at: text(item.created_at, 64),
    updated_at: text(item.updated_at, 64),
    salience: typeof item.salience === 'number' ? item.salience : null,
    confidence: typeof item.confidence === 'number' ? item.confidence : null,
    source,
    superseded: typeof item.superseded_by === 'string' && item.superseded_by.length > 0,
    promotion: shapePromotion(promotionDetails(item), nodes),
  };
}

// A promoted copy records where it came from and why in its metadata. AMT releases that
// returned no metadata sent the same values as a separate `promotion` summary.
function promotionDetails(item) {
  const metadata = isObject(item.metadata) ? item.metadata : null;
  if (metadata && typeof metadata.promoted_from_scope === 'string') {
    const assessment = isObject(metadata.topology_assessment) ? metadata.topology_assessment : {};
    return {
      from_scope: metadata.promoted_from_scope,
      origin: metadata.promotion_origin_principal,
      rationale: metadata.assessment_rationale ?? assessment.rationale,
      promoted_at: metadata.promoted_at,
    };
  }
  return isObject(item.promotion) ? item.promotion : null;
}

function shapePromotion(value, nodes) {
  if (!isObject(value)) return null;
  const from = text(value.from_scope, 256);
  const node = from ? nodes.get(from) : null;
  const promotion = {
    from_scope: from,
    from_label: node ? displayPath(node.path) : from,
    origin: text(value.origin, 256),
    rationale: text(value.rationale, 2000),
    promoted_at: text(value.promoted_at, 64),
  };
  return Object.values(promotion).some(Boolean) ? promotion : null;
}

function matchesSearch(record, needle) {
  return [record.content, record.id, record.scope_label, record.scope_path, ...record.tags]
    .some(value => String(value || '').toLowerCase().includes(needle));
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
const newestFirst = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));

/** Pure shaping step: groups memories by scope and lays out Personal, then the hierarchy tree. */
export function shapeCanvasData({ who = null, nodes = [], listing, filters = {}, warnings = [] }) {
  const selected = normalizeFilters(filters);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const principal = who?.principal ?? null;
  const needle = selected.search.toLowerCase();
  const groups = {};
  const seen = new Set();
  let total = 0;
  for (const item of Array.isArray(listing?.items) ? listing.items : []) {
    if (!isObject(item) || typeof item.id !== 'string' || seen.has(item.id)) continue;
    seen.add(item.id);
    const record = shapeRecord(item, byId, principal);
    if (needle && !matchesSearch(record, needle)) continue;
    (groups[record.scope_key] ||= []).push(record);
    total += 1;
  }
  for (const list of Object.values(groups)) list.sort(newestFirst);
  const count = scope => (groups[scope] || []).length;

  const rows = [];
  const personalScopes = new Set(principal ? [principal] : []);
  for (const scope of Object.keys(groups)) if (scope.startsWith('user:')) personalScopes.add(scope);
  for (const scope of personalScopes) {
    rows.push({ scope, kind: 'personal', name: 'Personal', path: '', depth: 0, count: count(scope) });
  }

  const children = new Map();
  for (const node of nodes) {
    const parent = node.parentId && byId.has(node.parentId) ? node.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node);
  }
  const visited = new Set();
  const walk = (parent, depth) => {
    for (const node of (children.get(parent) || []).sort(byName)) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      rows.push({
        scope: node.id, kind: parent === null ? 'root' : 'node', name: node.name,
        path: displayPath(node.path), description: node.description, depth, count: count(node.id),
      });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);

  for (const scope of Object.keys(groups).sort()) {
    if (personalScopes.has(scope) || visited.has(scope)) continue;
    const unlisted = scope.startsWith(NODE_PREFIX);
    rows.push({
      scope, kind: unlisted ? 'unlisted' : 'other', name: unlisted ? 'Unlisted node' : scope,
      path: scope, depth: 0, count: count(scope),
    });
  }

  return {
    principal,
    tenant: who?.tenant ?? null,
    rows,
    groups,
    total,
    truncated: listing?.has_more === true,
    limit: selected.limit,
    warnings,
    updatedAt: new Date().toISOString(),
  };
}

/** A compact snapshot for the agent-facing refresh action. */
export function summarizeCanvasData(data, { maxItems = 100, maxChars = 1000 } = {}) {
  const memories = [];
  for (const row of data.rows) {
    for (const record of data.groups[row.scope] || []) {
      if (memories.length >= maxItems) break;
      memories.push({
        scope: row.kind === 'personal' ? 'Personal' : row.path || row.name,
        type: record.type,
        content: record.content.length > maxChars ? `${record.content.slice(0, maxChars)}...` : record.content,
        created_at: record.created_at,
      });
    }
  }
  return {
    principal: data.principal,
    total: data.total,
    truncated: data.truncated || memories.length < data.total,
    scopes: data.rows.map(({ scope, kind, name, path, count }) => ({ scope, kind, name, path, count })),
    memories,
    warnings: data.warnings,
    referenceOnly: true,
  };
}
