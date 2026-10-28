// The Memory House canvas page. Served by the canvas's loopback server; every dynamic value is
// escaped before it reaches the DOM, and API calls carry the per-server capability token.
export function renderPanel({ token, nonce }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Memory House</title>
<style>
  :root {
    color-scheme: light dark;
    --mh-bg: var(--background-color-default, Canvas);
    --mh-fg: var(--text-color-default, CanvasText);
    --mh-muted: var(--text-color-muted, color-mix(in srgb, CanvasText 64%, transparent));
    --mh-border: var(--border-color-default, color-mix(in srgb, CanvasText 18%, transparent));
    --mh-accent: var(--color-focus-outline, Highlight);
    --mh-soft: color-mix(in srgb, var(--mh-fg) 5%, transparent);
    --mh-chip: color-mix(in srgb, var(--mh-fg) 9%, transparent);
    --mh-danger: var(--true-color-red, #d1242f);
  }
  body { margin: 0; background: var(--mh-bg); color: var(--mh-fg);
    font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 14px); line-height: var(--leading-body-medium, 20px); }
  header { padding: 12px 16px; border-bottom: 1px solid var(--mh-border); display: flex; gap: 12px; align-items: center; }
  header h1 { font-size: 16px; margin: 0; font-weight: var(--font-weight-semibold, 600); }
  .who { font-size: 12px; color: var(--mh-muted); overflow-wrap: anywhere; }
  .spacer { flex: 1; }
  main { display: grid; grid-template-columns: minmax(280px, 34%) 1fr; min-height: calc(100vh - 58px); }
  aside { border-right: 1px solid var(--mh-border); padding: 12px 14px; overflow: auto; }
  section { padding: 12px 16px; overflow: auto; }
  h2 { font-size: 15px; margin: 0 0 10px; font-weight: var(--font-weight-semibold, 600); }
  h3 { font-size: 13px; margin: 0; font-weight: var(--font-weight-semibold, 600); }
  label { display: block; font-size: 12px; color: var(--mh-muted); margin: 12px 0 4px; }
  input, select, button { box-sizing: border-box; width: 100%; padding: 7px 8px; border-radius: 8px;
    border: 1px solid var(--mh-border); background: var(--mh-bg); color: var(--mh-fg); font: inherit; }
  button { cursor: pointer; font-weight: var(--font-weight-semibold, 600); background: var(--mh-soft); }
  button:hover { border-color: var(--mh-accent); }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--mh-accent); outline-offset: 1px; }
  button:disabled { cursor: wait; opacity: .65; }
  header button { width: auto; min-width: 92px; }
  .primary { background: color-mix(in srgb, var(--mh-accent) 22%, var(--mh-bg)); }
  .identity { box-sizing: border-box; padding: 7px 8px; border-radius: 8px; border: 1px solid var(--mh-border);
    background: var(--mh-soft); overflow-wrap: anywhere; font-size: 12px; }
  .toolbar { display: flex; justify-content: flex-end; margin-top: 10px; }
  .filter-toggle { width: auto; display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; }
  .filter-toggle svg { width: 15px; height: 15px; fill: currentColor; }
  .filter-panel { margin-top: 8px; padding: 2px 10px 12px; border: 1px solid var(--mh-border); border-radius: 10px; background: var(--mh-soft); }
  .filter-panel[hidden] { display: none; }
  .badge { min-width: 16px; padding: 0 5px; border-radius: 999px; background: var(--mh-accent); color: var(--color-white, #fff); font-size: 10px; text-align: center; }
  .filter-panel button { margin-top: 12px; }
  .checkline { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; }
  .checkline input { width: auto; }
  .range-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
  .range-row input { padding: 0; }
  .range-value { min-width: 40px; text-align: right; font-size: 12px; font-weight: 700; }
  .hint { font-size: 11px; color: var(--mh-muted); margin-top: 3px; }
  .scopes-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-top: 18px; }
  .link-button { width: auto; padding: 2px 9px; border-radius: 999px; border-color: transparent; background: transparent; font-size: 12px; }
  .link-button[aria-pressed="true"] { border-color: var(--mh-accent); background: color-mix(in srgb, var(--mh-accent) 18%, var(--mh-bg)); }
  .tree { margin-top: 6px; padding-bottom: 16px; }
  .tree-section { margin: 14px 6px 4px; font-size: 11px; font-weight: 700; color: var(--mh-muted); text-transform: uppercase; letter-spacing: .05em; }
  .tree-node { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 7px; align-items: center; text-align: left;
    padding: 6px 8px 6px calc(8px + var(--indent, 0px)); margin: 1px 0; border-color: transparent; background: transparent; font-weight: 400; }
  .tree-node.active { border-color: var(--mh-accent); background: color-mix(in srgb, var(--mh-accent) 16%, var(--mh-bg)); font-weight: 600; }
  .tree-icon { color: var(--mh-muted); text-align: center; font-size: 11px; }
  .tree-label { min-width: 0; }
  .tree-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tree-sub { display: block; margin-top: 1px; font-size: 10px; color: var(--mh-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
  .count { font-size: 11px; border-radius: 999px; padding: 1px 8px; background: var(--mh-chip); }
  .notice { margin-bottom: 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--mh-border); background: var(--mh-soft); font-size: 12px; }
  .notice[hidden] { display: none; }
  .err { color: var(--mh-danger); white-space: pre-wrap; }
  .card { border: 1px solid var(--mh-border); border-radius: 12px; padding: 12px; margin-bottom: 10px; }
  .card p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .pill { font-size: 11px; border-radius: 999px; padding: 2px 8px; background: var(--mh-chip); }
  .pill.personal { background: var(--true-color-blue-muted, color-mix(in srgb, #0969da 18%, transparent)); }
  .pill.node, .pill.root { background: var(--true-color-green-muted, color-mix(in srgb, #1a7f37 20%, transparent)); }
  .pill.unlisted, .pill.other { background: var(--true-color-orange-muted, color-mix(in srgb, #bc4c00 20%, transparent)); }
  details { margin-top: 8px; border-top: 1px solid var(--mh-border); padding-top: 6px; }
  summary { cursor: pointer; width: fit-content; font-size: 12px; font-weight: 600; color: var(--mh-muted); }
  pre { white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
  .empty { color: var(--mh-muted); padding: 22px; text-align: center; }
  code { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
  .overlay { position: fixed; inset: 0; background: color-mix(in srgb, #000 45%, transparent); display: none; align-items: center; justify-content: center; z-index: 10; }
  .overlay.show { display: flex; }
  .modal { background: var(--mh-bg); color: var(--mh-fg); border: 1px solid var(--mh-border); border-radius: 12px; padding: 18px;
    max-width: 680px; width: 90%; max-height: 82vh; overflow: auto; box-shadow: 0 10px 40px color-mix(in srgb, #000 30%, transparent); }
  .modal button { width: auto; min-width: 100px; }
  .modal .choice { display: flex; gap: 10px; margin-top: 10px; }
  .modal .choice button { flex: 1; text-align: left; padding: 14px; font-weight: 400; }
  .modal .choice .t { font-weight: 600; display: block; margin-bottom: 4px; }
  .modal .choice .d { display: block; color: var(--mh-muted); font-size: 12px; }
  .modal .bar { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .modal .msg { font-size: 12px; color: var(--mh-muted); }
  .modal .ghost { background: transparent; }
  .modal .rows { margin: 8px 0; max-height: 46vh; overflow: auto; border: 1px solid var(--mh-border); border-radius: 8px; }
  .modal .row { display: flex; gap: 8px; padding: 8px; margin: 0; align-items: flex-start; cursor: pointer; color: var(--mh-fg); font-size: 13px; }
  .modal .row:hover { background: var(--mh-soft); }
  .modal .row input { width: auto; margin-top: 3px; }
  .modal .row .body { flex: 1; min-width: 0; }
  .modal .row .lbl { font-weight: 600; }
  .modal .row .sub { color: var(--mh-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .modal .row .q { color: var(--mh-muted); font-size: 12px; margin-top: 3px; display: flex; gap: 6px; }
  .modal .row .q b { flex: 0 0 40px; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
  .modal .selall { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-top: 8px; }
  .modal .selall input { width: auto; }
  .modal .selall label { margin: 0; }
  main[hidden] { display: none; }
  .tabs { display: flex; gap: 4px; }
  .tab { width: auto; padding: 4px 12px; border-radius: 999px; border-color: transparent; background: transparent; }
  .tab[aria-selected="true"] { border-color: var(--mh-accent); background: color-mix(in srgb, var(--mh-accent) 18%, var(--mh-bg)); }
  .playbook-view { display: block; }
  .pb-list { margin-top: 12px; max-width: 960px; }
  .pb { border: 1px solid var(--mh-border); border-radius: 12px; margin-bottom: 8px; }
  .pb-head { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 8px; align-items: center; text-align: left;
    padding: 9px 12px; border: 0; border-radius: 12px; background: transparent; }
  .pb-head:hover { background: var(--mh-soft); }
  .pb-sub { display: block; font-size: 11px; color: var(--mh-muted); font-weight: 400; }
  .pb-body { padding: 2px 12px 12px 36px; }
  .sections { list-style: none; margin: 0; padding: 0 0 0 16px; border-left: 1px solid var(--mh-border); }
  .sections.top { padding-left: 0; border-left: 0; }
  .sections li { margin: 8px 0 0; }
  .sec-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .sec-name { font-weight: 600; overflow-wrap: anywhere; }
  .sec-desc { font-size: 12px; color: var(--mh-muted); margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .pill.you { background: color-mix(in srgb, var(--mh-accent) 28%, transparent); }
  .pill.refused { background: var(--true-color-orange-muted, color-mix(in srgb, #bc4c00 20%, transparent)); }
  .pb.learnings { border-color: color-mix(in srgb, var(--mh-accent) 45%, var(--mh-border)); }
  .pill.mem-toggle { width: auto; border-color: transparent; cursor: pointer;
    background: var(--true-color-green-muted, color-mix(in srgb, #1a7f37 20%, transparent)); }
  .pill.mem-toggle[aria-expanded="true"] { border-color: var(--mh-accent); }
  .sec-mem { margin: 8px 0 4px; }
</style>
</head>
<body>
<header>
  <h1>Memory House</h1>
  <nav class="tabs" role="tablist" aria-label="Views">
    <button id="tabMemories" class="tab" role="tab" type="button" aria-selected="true" aria-controls="memoryView">Memories</button>
    <button id="tabPlaybooks" class="tab" role="tab" type="button" aria-selected="false" aria-controls="playbookView">Playbooks</button>
  </nav>
  <span id="who" class="who">Loading...</span>
  <span class="spacer"></span>
  <button id="import" class="primary" type="button">Import memory</button>
  <button id="refresh" type="button">Refresh</button>
</header>
<main id="memoryView" role="tabpanel" aria-labelledby="tabMemories">
  <aside>
    <label>Signed-in principal</label><div id="principal" class="identity">Loading...</div>
    <label>Tenant</label><div id="tenant" class="identity">Loading...</div>

    <div class="toolbar">
      <button id="filterToggle" class="filter-toggle" type="button" aria-expanded="false" aria-controls="filterPanel" title="Filters">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2.25A.75.75 0 0 1 2.25 1.5h11.5a.75.75 0 0 1 .58 1.225L9.5 8.628v4.122a.75.75 0 0 1-.416.671l-2 1A.75.75 0 0 1 6 13.75V8.628L1.67 2.725a.75.75 0 0 1-.17-.475Z"/></svg>
        <span>Filters</span><span id="filterCount" class="badge" hidden>0</span>
      </button>
    </div>
    <div id="filterPanel" class="filter-panel" hidden>
      <label for="search">Search</label><input id="search" placeholder="Content, node, id or tag" />
      <label for="memoryType">Memory type</label>
      <select id="memoryType">
        <option value="">All</option><option value="fact">Fact</option><option value="episodic">Episodic</option><option value="procedural">Procedural</option>
      </select>
      <label for="limit">Newest memories to load (1-200)</label><input id="limit" type="number" min="1" max="200" value="200" />
      <div class="checkline"><input id="includeSuperseded" type="checkbox" /><label for="includeSuperseded" style="margin:0">Include superseded</label></div>
      <button id="apply" type="button">Apply filters</button>
    </div>

    <label for="autoRefresh">Auto-refresh</label>
    <div class="range-row">
      <input id="autoRefresh" type="range" min="0" max="300" step="5" value="15" />
      <span id="autoRefreshValue" class="range-value">15s</span>
    </div>
    <div class="hint">0 turns auto-refresh off. Promotion and extraction run in the background, so new memories can appear without any action here.</div>

    <div class="scopes-head">
      <h3>Where your memories live</h3>
      <button id="showAll" class="link-button" type="button" aria-pressed="true">All</button>
    </div>
    <div class="hint">Your personal memories, then every hierarchy node you can read.</div>
    <div id="tree" class="tree" role="tree" aria-label="Memory scopes"></div>
  </aside>
  <section>
    <h2 id="heading">Memories</h2>
    <div id="error" class="notice err" role="alert" hidden></div>
    <div id="notices" class="notice" hidden></div>
    <div id="cards"></div>
  </section>
</main>
<main id="playbookView" class="playbook-view" role="tabpanel" aria-labelledby="tabPlaybooks" hidden>
  <section>
    <h2>Playbooks</h2>
    <div class="hint">My Learnings lists your personal memories. Below it are the playbooks and sections Microsoft IQ shows you, read with your Azure CLI sign-in, which must be the account you use for Memory House, and the memories promoted into each section. Select a playbook to load its sections. Memories refresh on the Memories tab's auto-refresh interval, and playbooks and open sections every 10 minutes while this tab is showing, unless auto-refresh is off. Nothing is changed in Microsoft IQ or Memory House.</div>
    <div id="playbooks" class="pb-list"></div>
  </section>
</main>

<div id="overlay" class="overlay" role="dialog" aria-modal="true" aria-label="Import memory">
  <div class="modal" id="modal"></div>
</div>

<script nonce="${nonce}">
  const TOKEN = ${JSON.stringify(token)};
  const HEADERS = { 'x-mh-canvas-token': TOKEN };
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICONS = { personal: '&#9679;', root: '&#9670;', node: '&#9632;', unlisted: '&#9675;', other: '&#9675;' };
  const state = { data: null, selected: null, filters: { search: '', memoryTypes: [], limit: 200, includeSuperseded: false }, loading: false };

  function rowFor(scope) {
    return (state.data?.rows || []).find(row => row.scope === scope) || null;
  }

  function rowLabel(row) {
    if (!row) return 'All memories';
    if (row.kind === 'personal') return 'Personal';
    return row.path || row.name;
  }

  function treeHtml() {
    const data = state.data || { rows: [] };
    const button = row => {
      const active = row.scope === state.selected;
      const indent = row.depth * 18;
      const sub = row.kind === 'personal' ? (data.principal || row.scope)
        : row.kind === 'unlisted' ? 'Not in your hierarchy view: ' + row.scope
        : row.kind === 'other' ? 'Unrecognized scope' : (row.description || row.path);
      return '<button type="button" class="tree-node' + (active ? ' active' : '') + '" role="treeitem" aria-level="' + (row.depth + 1) +
        '" aria-selected="' + active + '" data-scope="' + esc(row.scope) + '" style="--indent:' + indent + 'px" title="' + esc(row.path || row.scope) + '">' +
        '<span class="tree-icon" aria-hidden="true">' + ICONS[row.kind] + '</span><span class="tree-label"><span class="tree-name">' + esc(row.name) +
        '</span><span class="tree-sub">' + esc(sub) + '</span></span><span class="count">' + row.count + '</span></button>';
    };
    const personal = data.rows.filter(row => row.kind === 'personal');
    const shared = data.rows.filter(row => row.kind === 'root' || row.kind === 'node');
    const other = data.rows.filter(row => row.kind === 'unlisted' || row.kind === 'other');
    let html = '<div class="tree-section">Personal</div>' + (personal.length ? personal.map(button).join('') : '<div class="hint">No personal scope yet.</div>');
    html += '<div class="tree-section">Shared hierarchy</div>' + (shared.length ? shared.map(button).join('')
      : '<div class="hint">You are not a member or curator of any hierarchy node yet.</div>');
    if (other.length) html += '<div class="tree-section">Other scopes</div>' + other.map(button).join('');
    return html;
  }

  // In the Playbooks view the section names the scope, and the caller's own principal reads as "You".
  function card(memory, options = {}) {
    const kind = memory.scope_kind;
    const where = kind === 'personal' ? 'Personal' : memory.scope_path || memory.scope_label;
    const pills = [
      options.hideScope ? '' : '<span class="pill ' + esc(kind) + '">' + esc(where) + '</span>',
      memory.type ? '<span class="pill">' + esc(memory.type) + '</span>' : '',
      memory.source ? '<span class="pill">via ' + esc(memory.source) + '</span>' : '',
      memory.superseded ? '<span class="pill">superseded</span>' : '',
      ...memory.tags.slice(0, 4).map(tag => '<span class="pill">' + esc(tag) + '</span>'),
    ].join('');
    const promo = memory.promotion;
    const mine = value => Boolean(options.principal) && value === options.principal;
    const fromLabel = promo && mine(promo.from_scope) ? 'Your personal memories' : promo?.from_label;
    const origin = promo && mine(promo.origin) ? 'You' : promo?.origin;
    const details = {
      id: memory.id, scope_key: memory.scope_key, scope_path: memory.scope_path || undefined, type: memory.type,
      created_at: memory.created_at, updated_at: memory.updated_at, salience: memory.salience, confidence: memory.confidence, source: memory.source,
      promoted_from: promo?.from_label || undefined, origin_user: promo?.origin || undefined,
      promotion_rationale: promo?.rationale || undefined, promoted_at: promo?.promoted_at || undefined,
    };
    const promoLines = promo ? '<div class="promo">' +
      (fromLabel ? '<div><b>From:</b> ' + esc(fromLabel) + '</div>' : '') +
      (origin ? '<div><b>Origin:</b> ' + esc(origin) + '</div>' : '') +
      (promo.rationale ? '<div><b>Why:</b> ' + esc(promo.rationale) + '</div>' : '') + '</div>' : '';
    return '<article class="card"><p>' + esc(memory.content || '(no text)') + '</p>' + promoLines + '<div class="meta">' + pills +
      '</div><details><summary>Details</summary><pre>' + esc(JSON.stringify(details, null, 2)) + '</pre></details></article>';
  }

  function visible() {
    const groups = state.data?.groups || {};
    if (state.selected) return groups[state.selected] || [];
    return (state.data?.rows || []).flatMap(row => groups[row.scope] || []);
  }

  function render() {
    const data = state.data || {};
    $('who').textContent = data.principal || '';
    $('principal').textContent = data.principal || 'Unknown';
    $('tenant').textContent = data.tenant || 'Unknown';
    $('tree').innerHTML = treeHtml();
    $('showAll').setAttribute('aria-pressed', String(!state.selected));
    const list = visible();
    $('heading').textContent = rowLabel(rowFor(state.selected)) + ' (' + list.length + ')';
    $('cards').innerHTML = list.length ? list.map(card).join('')
      : '<div class="empty">' + (state.selected ? 'No memories in this scope yet.' : 'No memories to show yet.') + '</div>';
    const notes = [...(data.warnings || [])];
    if (data.truncated) notes.push('Showing the newest ' + data.limit + ' memories you can read. Use filters to narrow the list.');
    $('notices').innerHTML = notes.map(esc).join('<br>');
    $('notices').hidden = notes.length === 0;
    const active = [state.filters.search, state.filters.memoryTypes.length, state.filters.includeSuperseded, state.filters.limit !== 200].filter(Boolean).length;
    $('filterCount').textContent = String(active);
    $('filterCount').hidden = active === 0;
  }

  function showError(html) {
    $('error').innerHTML = html;
    $('error').hidden = !html;
  }

  async function errorText(response) {
    try {
      const body = await response.json();
      if (body && typeof body.message === 'string') return body.message;
    } catch {}
    return 'Memory House request failed (HTTP ' + response.status + ').';
  }

  function query() {
    const params = new URLSearchParams({ limit: String(state.filters.limit) });
    if (state.filters.search) params.set('search', state.filters.search);
    for (const type of state.filters.memoryTypes) params.append('memory_types', type);
    if (state.filters.includeSuperseded) params.set('include_superseded', 'true');
    return params;
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    $('refresh').disabled = true;
    try {
      const response = await fetch('/api/memory?' + query(), { headers: HEADERS, cache: 'no-store' });
      if (response.status === 401) {
        showError('Not signed in to Memory House. Run <code>/mh-login</code> in a chat, then select Refresh.');
        return;
      }
      if (!response.ok) { showError(esc(await errorText(response))); return; }
      state.data = await response.json();
      if (state.selected && !rowFor(state.selected)) state.selected = null;
      showError('');
      render();
    } catch {
      showError('Could not reach the Memory House canvas. Close and reopen it if this continues.');
    } finally {
      state.loading = false;
      $('refresh').disabled = false;
    }
  }

  $('refresh').addEventListener('click', () => refreshView());
  $('filterToggle').addEventListener('click', () => {
    const panel = $('filterPanel');
    panel.hidden = !panel.hidden;
    $('filterToggle').setAttribute('aria-expanded', String(!panel.hidden));
  });
  $('apply').addEventListener('click', () => {
    const type = $('memoryType').value;
    const limit = Number($('limit').value);
    state.filters = {
      search: $('search').value.trim(),
      memoryTypes: type ? [type] : [],
      limit: Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 200,
      includeSuperseded: $('includeSuperseded').checked,
    };
    $('limit').value = String(state.filters.limit);
    load();
  });
  $('search').addEventListener('keydown', event => { if (event.key === 'Enter') $('apply').click(); });
  $('tree').addEventListener('click', event => {
    const node = event.target.closest('.tree-node');
    if (!node) return;
    state.selected = node.getAttribute('data-scope');
    render();
  });
  $('showAll').addEventListener('click', () => { state.selected = null; render(); });

  // Import: choose the source agent, then what to import from it.
  const SOURCES = {
    copilot: { label: 'GitHub Copilot', memory: 'Copilot memories', memoryText: 'Facts Copilot saved with its memory tool on this device.', sessionText: 'Pick recent Copilot sessions; their turns go through Memory House extraction.' },
    claude: { label: 'Claude Code', memory: 'Claude memories', memoryText: 'Memory files Claude Code saved for your projects.', sessionText: 'Pick recent Claude Code sessions; their turns go through Memory House extraction.' },
  };
  const overlay = $('overlay');
  const modal = $('modal');
  let importing = false;
  let source = 'copilot';
  const close = () => { if (importing) return; overlay.classList.remove('show'); modal.innerHTML = ''; };
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });

  async function post(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.status === 401) throw new Error('Not signed in to Memory House. Run /mh-login in a chat, then try again.');
    if (!response.ok) throw new Error(await errorText(response));
    return response.json();
  }

  function outcome(result, noun) {
    const sent = noun === 'memories' ? result.memories : result.messages;
    let text = noun === 'memories'
      ? 'Sent ' + sent + ' memories' + (result.reconcile ? ' and requested reconciliation.' : '.')
      : 'Sent ' + sent + ' messages from ' + result.sessions + ' session(s) for extraction.';
    if (result.skipped) text += ' Skipped ' + result.skipped + ' empty or filtered item(s).';
    if (result.failed || result.unknown) text += ' ' + (result.failed + result.unknown) + ' item(s) were not confirmed.';
    if (noun === 'messages' && sent) text += ' New memories appear after background processing.';
    if (result.error) text += ' Stopped early: ' + result.error.message;
    return text;
  }

  function openChoice() {
    modal.innerHTML = '<h2>Import memory</h2><div class="msg">Which agent on this device should Memory House import from?</div>' +
      '<div class="choice"><button type="button" data-source="copilot"><span class="t">GitHub Copilot</span><span class="d">Sessions and saved memories from Copilot.</span></button>' +
      '<button type="button" data-source="claude"><span class="t">Claude Code</span><span class="d">Sessions and memory files from Claude Code.</span></button></div>' +
      '<div class="bar"><span class="spacer"></span><button type="button" class="ghost" id="m-cancel">Cancel</button></div>';
    overlay.classList.add('show');
    $('m-cancel').onclick = close;
    for (const button of modal.querySelectorAll('[data-source]')) button.onclick = () => openKind(button.getAttribute('data-source'));
  }

  function openKind(selected) {
    source = selected;
    const info = SOURCES[source];
    modal.innerHTML = '<h2>Import from ' + esc(info.label) + '</h2>' +
      '<div class="choice"><button type="button" id="k-memory"><span class="t">' + esc(info.memory) + '</span><span class="d">' + esc(info.memoryText) + '</span></button>' +
      '<button type="button" id="k-sessions"><span class="t">Recent sessions</span><span class="d">' + esc(info.sessionText) + '</span></button></div>' +
      '<div class="msg" style="margin-top:10px">Imports go to your personal memories. Text is filtered for credentials first; original timestamps are not kept.</div>' +
      '<div class="bar"><span id="k-msg" class="msg"></span><span class="spacer"></span><button type="button" class="ghost" id="k-back">Back</button><button type="button" class="ghost" id="k-cancel">Cancel</button></div>';
    $('k-back').onclick = openChoice;
    $('k-cancel').onclick = close;
    $('k-memory').onclick = importMemories;
    $('k-sessions').onclick = openSessions;
  }

  async function importMemories() {
    const message = $('k-msg');
    for (const button of modal.querySelectorAll('button')) button.disabled = true;
    importing = true;
    message.textContent = 'Importing ' + SOURCES[source].label + ' memories...';
    try {
      const result = await post('/api/import/memories', { source });
      message.textContent = outcome(result, 'memories');
      if (result.error) message.classList.add('err');
      load();
    } catch (error) {
      message.innerHTML = '<span class="err">' + esc(error.message) + '</span>';
    } finally {
      importing = false;
      for (const button of modal.querySelectorAll('button')) button.disabled = false;
    }
  }

  async function openSessions() {
    modal.innerHTML = '<h2>Import recent sessions</h2><div class="msg">Reading local ' + esc(SOURCES[source].label) + ' sessions...</div>';
    let listing;
    try {
      const response = await fetch('/api/import/sessions?source=' + encodeURIComponent(source), { headers: HEADERS });
      if (!response.ok) throw new Error(await errorText(response));
      listing = await response.json();
    } catch (error) {
      modal.innerHTML = '<h2>Import recent sessions</h2><div class="err">' + esc(error.message) + '</div>' +
        '<div class="bar"><span class="spacer"></span><button type="button" class="ghost" id="s-back">Back</button></div>';
      $('s-back').onclick = () => openKind(source);
      return;
    }
    const sessions = listing.sessions || [];
    if (!sessions.length) {
      modal.innerHTML = '<h2>Import recent sessions</h2><div class="msg">No local ' + esc(SOURCES[source].label) + ' sessions with complete turns were found.</div>' +
        '<div class="bar"><span class="spacer"></span><button type="button" class="ghost" id="s-back">Back</button></div>';
      $('s-back').onclick = () => openKind(source);
      return;
    }
    const folder = cwd => String(cwd || '').split(/[\\\\/]/).filter(Boolean).pop() || '';
    const when = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(); };
    modal.innerHTML = '<h2>Import recent sessions <span class="msg">(' + sessions.length + ', newest first)</span></h2>' +
      '<div class="selall"><input type="checkbox" id="s-all"><label for="s-all">Select all</label></div>' +
      '<div class="rows">' + sessions.map(session =>
        '<label class="row"><input type="checkbox" class="s-pick" value="' + esc(session.session_id) + '"><span class="body">' +
        '<div class="lbl">' + esc(session.label) + '</div>' +
        '<div class="sub">' + esc([folder(session.cwd), when(session.start_time), session.turn_count + ' turn(s)'].filter(Boolean).join(' - ')) + '</div>' +
        (session.last_user_turn ? '<div class="q"><b>You</b><span>' + esc(session.last_user_turn) + '</span></div>' : '') +
        (session.last_agent_turn ? '<div class="q"><b>Agent</b><span>' + esc(session.last_agent_turn) + '</span></div>' : '') +
        '</span></label>').join('') + '</div>' +
      '<div class="bar"><span id="s-msg" class="msg"></span><span class="spacer"></span><button type="button" class="ghost" id="s-back">Back</button>' +
      '<button type="button" class="primary" id="s-import">Import</button></div>';
    const picks = [...modal.querySelectorAll('.s-pick')];
    $('s-all').onchange = event => picks.forEach(pick => { pick.checked = event.target.checked; });
    $('s-back').onclick = () => openKind(source);
    $('s-import').onclick = async () => {
      const ids = picks.filter(pick => pick.checked).map(pick => pick.value);
      const message = $('s-msg');
      if (!ids.length) { message.innerHTML = '<span class="err">Select at least one session.</span>'; return; }
      for (const button of modal.querySelectorAll('button, input')) button.disabled = true;
      importing = true;
      message.textContent = 'Importing ' + ids.length + ' session(s). Large sessions can take a few minutes...';
      try {
        const result = await post('/api/import/sessions', { source, ids });
        message.textContent = outcome(result, 'messages');
        if (result.error) message.classList.add('err');
        load();
      } catch (error) {
        message.innerHTML = '<span class="err">' + esc(error.message) + '</span>';
      } finally {
        importing = false;
        for (const button of modal.querySelectorAll('button, input')) button.disabled = false;
      }
    };
  }

  $('import').addEventListener('click', openChoice);

  // Microsoft IQ playbooks, read through the canvas server with the user's own Azure CLI sign-in.
  // Each playbook's sections load when it is first expanded. The memories promoted into those
  // sections and the My Learnings entry come from Memory House, and refresh on the auto-refresh
  // interval without reading Microsoft IQ. Playbooks and sections change rarely and read slowly,
  // so the list and the open playbooks refresh quietly every 10 minutes instead.
  const LEARNINGS = 'learnings';
  const PLAYBOOK_REFRESH_MS = 10 * 60 * 1000;
  const pb = {
    view: 'memories', list: null, listError: '', listLoading: false, listTicket: 0, listCheckedAt: 0,
    trees: new Map(), treeLoadedAt: new Map(), treeErrors: new Map(), treeRefreshing: new Set(), memories: new Map(),
    learnings: null, open: new Set(), openSections: new Set(), tickets: new Map(), inflight: new Set(), generation: 0,
  };
  const pbKey = playbook => playbook.workspaceId + '/' + playbook.playbookId;
  const treePath = playbook => '/api/miq/tree?' + new URLSearchParams({ workspace_id: playbook.workspaceId, playbook_id: playbook.playbookId });
  const plural = (count, noun, nouns) => Number(count) + ' ' + (Number(count) === 1 ? noun : nouns || noun + 's');
  const ready = value => Boolean(value) && value !== 'loading' && !(value instanceof Error);
  const me = () => (ready(pb.learnings) ? pb.learnings.principal : null);

  function refreshView() {
    if (pb.view === 'playbooks') loadPlaybooks();
    else load();
  }

  function setView(view) {
    pb.view = view;
    const playbooks = view === 'playbooks';
    $('memoryView').hidden = playbooks;
    $('playbookView').hidden = !playbooks;
    $('tabMemories').setAttribute('aria-selected', String(!playbooks));
    $('tabPlaybooks').setAttribute('aria-selected', String(playbooks));
    if (!playbooks) return;
    if (!pb.list && !pb.listLoading) loadPlaybooks();
    else refreshPlaybooksIfStale();
  }

  async function getJson(path) {
    const response = await fetch(path, { headers: HEADERS, cache: 'no-store' });
    if (response.status === 401) throw new Error('Not signed in to Memory House. Run /mh-login in a chat, then select Refresh.');
    if (!response.ok) {
      let body = null;
      try { body = await response.json(); } catch {}
      const error = new Error(body && typeof body.message === 'string' ? body.message : 'Memory House request failed (HTTP ' + response.status + ').');
      error.code = body && typeof body.error === 'string' ? body.error : '';
      throw error;
    }
    return response.json();
  }

  // Playbooks read with an Azure CLI account that is not the Memory House user would pair someone else's
  // playbooks with these memories, so none stay shown. Open playbooks reopen once the account matches.
  const isAccountMismatch = value => value instanceof Error && value.code === 'MIQ_ACCOUNT_MISMATCH';
  function dropPlaybooks(message) {
    pb.list = null;
    pb.listError = message;
    pb.generation += 1;
    pb.trees.clear();
    pb.treeLoadedAt.clear();
    pb.treeErrors.clear();
    pb.memories.clear();
    renderPlaybooks();
  }

  // Memory House is now signed in as someone else, so the playbooks shown were read for the previous person.
  function reloadForNewAccount() {
    dropPlaybooks('You are now signed in to Memory House as someone else. Loading your playbooks...');
    loadPlaybooks();
  }

  // Returns true when an answer was about the account rather than the data, after acting on it.
  function handledAccountChange(value) {
    if (isAccountMismatch(value)) { dropPlaybooks(value.message); return true; }
    if (value instanceof Error && value.code === 'MIQ_ACCOUNT_CHANGED') { reloadForNewAccount(); return true; }
    return false;
  }

  // A background refresh skips a key whose last request is still running, keeps what is shown until
  // new data arrives, and redraws only on a change. An explicit load supersedes a running request.
  // An answer that is no longer current is dropped, and an account change is acted on even in the background.
  async function fetchMemories(key, path, read, write, quiet, isCurrent = () => true) {
    if (quiet && pb.inflight.has(key)) return;
    const ticket = (pb.tickets.get(key) || 0) + 1;
    pb.tickets.set(key, ticket);
    pb.inflight.add(key);
    const previous = read();
    if (!quiet || !ready(previous)) { write('loading'); renderPlaybooks(); }
    let next;
    try {
      next = await getJson(path);
    } catch (error) {
      next = error instanceof Error ? error : new Error('Could not load memories.');
    }
    if (pb.tickets.get(key) !== ticket) return;
    pb.inflight.delete(key);
    if (!isCurrent() || handledAccountChange(next)) return;
    if (quiet && ready(previous) && (next instanceof Error || JSON.stringify(next) === JSON.stringify(previous))) return;
    write(next);
    renderPlaybooks();
  }

  function loadLearnings(quiet = false) {
    return fetchMemories(LEARNINGS, '/api/learnings', () => pb.learnings, value => {
      const before = ready(pb.learnings) ? pb.learnings.principal : null;
      pb.learnings = value;
      // Memory House is now signed in as someone else: reload the playbooks for that person.
      if (before && ready(value) && value.principal !== before) setTimeout(reloadForNewAccount, 0);
    }, quiet);
  }

  function loadSectionMemories(key, quiet = false) {
    const playbook = (pb.list || []).find(item => pbKey(item) === key);
    if (!playbook) return;
    // Memories requested before the playbooks were reloaded or hidden belong to trees no longer shown.
    const generation = pb.generation;
    const query = new URLSearchParams({ workspace_id: playbook.workspaceId, playbook_id: playbook.playbookId });
    return fetchMemories(key, '/api/miq/memories?' + query, () => pb.memories.get(key),
      value => pb.memories.set(key, value), quiet, () => generation === pb.generation);
  }

  function memoryCards(records) {
    const principal = me();
    return records.map(record => card(record, { hideScope: true, principal })).join('');
  }

  function sectionHtml(key, node, memories) {
    const records = ready(memories) && node.scope ? memories.groups[node.scope] || [] : [];
    const sectionKey = key + ' ' + node.scope;
    const showing = records.length > 0 && pb.openSections.has(sectionKey);
    const pills = [];
    if (node.refused) pills.push('<span class="pill refused">no access (HTTP ' + esc(node.refused) + ')</span>');
    else if (node.skipped) pills.push('<span class="pill refused">not loaded</span>');
    else {
      if (records.length) {
        pills.push('<button type="button" class="pill mem-toggle" aria-expanded="' + showing + '" data-section="' + esc(sectionKey) +
          '" title="' + (showing ? 'Hide' : 'Show') + ' the memories in this section"><span aria-hidden="true">' + (showing ? '&#9662; ' : '&#9656; ') +
          '</span>' + esc(plural(records.length, 'memory', 'memories')) + '</button>');
      }
      if (node.role === 'curator') pills.push('<span class="pill you">you: curator</span>');
      else if (node.curatorVia) {
        pills.push('<span class="pill you" title="' + esc('You curate ' + node.curatorVia.split('/').join(' / ') + ', which covers the sections below it.') +
          '">you: curator (inherited)</span>');
      } else if (node.role) pills.push('<span class="pill you">you: ' + esc(node.role) + '</span>');
      pills.push('<span class="pill">' + esc(plural(node.curators, 'direct curator')) + '</span>');
      pills.push('<span class="pill">' + esc(plural(node.users, 'direct user')) + '</span>');
      if (node.groups) pills.push('<span class="pill">' + esc(plural(node.groups, 'group or app', 'groups or apps')) + '</span>');
    }
    const children = (node.children || []).length
      ? '<ul class="sections">' + node.children.map(child => '<li>' + sectionHtml(key, child, memories) + '</li>').join('') + '</ul>' : '';
    return '<div class="sec-row"><span class="sec-name">' + esc(node.name) + '</span>' + pills.join('') + '</div>' +
      (node.description ? '<div class="sec-desc">' + esc(node.description) + '</div>' : '') +
      (showing ? '<div class="sec-mem">' + memoryCards(records) + '</div>' : '') + children;
  }

  function memoryNote(memories) {
    if (memories === 'loading') return '<div class="hint">Loading the memories in these sections...</div>';
    if (memories instanceof Error) return '<div class="notice err">Memories could not be loaded: ' + esc(memories.message) + '</div>';
    if (!ready(memories)) return '';
    if (!memories.total) return '<div class="hint">No memories have been promoted into these sections yet.</div>';
    return memories.truncated ? '<div class="hint">Showing the newest memories: Memory House returns up to 200 for every 20 sections.</div>' : '';
  }

  function pbHtml(key, name, sub, body, extraClass) {
    const open = pb.open.has(key);
    return '<div class="pb' + (extraClass ? ' ' + extraClass : '') + '"><button type="button" class="pb-head" aria-expanded="' + open + '" data-key="' + esc(key) + '">' +
      '<span class="tree-icon" aria-hidden="true">' + (open ? '&#9662;' : '&#9656;') + '</span>' +
      '<span><span class="tree-name">' + esc(name) + '</span><span class="pb-sub">' + esc(sub) + '</span></span></button>' +
      (open && body ? '<div class="pb-body">' + body + '</div>' : '') + '</div>';
  }

  function learningsHtml() {
    const data = pb.learnings;
    if (data instanceof Error) return pbHtml(LEARNINGS, 'My Learnings', data.message, '', 'learnings');
    if (!ready(data)) return pbHtml(LEARNINGS, 'My Learnings', 'Loading your personal memories...', '', 'learnings');
    const sub = data.truncated ? 'Your newest ' + plural(data.total, 'personal memory', 'personal memories')
      : plural(data.total, 'personal memory', 'personal memories');
    const body = data.memories.length ? memoryCards(data.memories)
      : '<div class="empty">No personal memories yet. Memory House saves them from your conversations.</div>';
    return pbHtml(LEARNINGS, 'My Learnings', sub, body, 'learnings');
  }

  function playbookHtml(playbook) {
    const key = pbKey(playbook);
    const tree = pb.trees.get(key);
    const memories = pb.memories.get(key);
    let sub = 'Select to load its sections';
    let body = '';
    if (tree === 'loading') sub = 'Loading sections...';
    else if (tree instanceof Error) { sub = 'Could not load its sections'; body = '<div class="err">' + esc(tree.message) + '</div>'; }
    else if (tree && !tree.access) sub = 'No access: Microsoft IQ answered HTTP ' + tree.status;
    else if (tree) {
      const parts = [plural(tree.sections, 'section')];
      if (ready(memories)) parts.push(plural(memories.total, 'memory', 'memories'));
      if (tree.root && tree.root.role) parts.push('you: ' + tree.root.role);
      sub = parts.join(' - ');
      const refreshError = pb.treeErrors.get(key);
      body = (refreshError ? '<div class="notice err">These sections could not be refreshed and may be out of date: ' + esc(refreshError) + '</div>' : '') +
        memoryNote(memories) + '<ul class="sections top"><li>' + sectionHtml(key, tree.root, memories) + '</li></ul>' +
        (tree.truncated ? '<div class="hint">Showing the first ' + esc(tree.sections) + ' sections.</div>' : '');
    }
    return pbHtml(key, playbook.name, sub, body, '');
  }

  // innerHTML replaces every button, so focus moves to the replacement of the focused one.
  function renderPlaybooks() {
    const container = $('playbooks');
    const active = container.contains(document.activeElement) ? document.activeElement : null;
    const focus = active && ['data-section', 'data-key'].find(name => active.hasAttribute(name));
    const focusValue = focus ? active.getAttribute(focus) : null;
    let html = learningsHtml();
    if (pb.listError) html += '<div class="notice err" role="alert">' + esc(pb.listError) + '</div>';
    if (pb.list === null) html += pb.listLoading ? '<div class="empty">Loading your Microsoft IQ playbooks...</div>' : '';
    else if (!pb.list.length) html += '<div class="empty">Microsoft IQ lists no playbooks for you.</div>';
    else html += pb.list.map(playbookHtml).join('');
    container.innerHTML = html;
    if (!focus) return;
    for (const element of container.querySelectorAll('[' + focus + ']')) {
      if (element.getAttribute(focus) === focusValue) { element.focus(); return; }
    }
  }

  async function openPlaybook(key) {
    const playbook = (pb.list || []).find(item => pbKey(item) === key);
    if (!playbook) return;
    pb.open.add(key);
    const cached = pb.trees.get(key);
    if (cached && !(cached instanceof Error)) {
      renderPlaybooks();
      // Sections cached while the playbook was closed show at once and refresh quietly when old.
      if (ready(cached) && Date.now() - (pb.treeLoadedAt.get(key) || 0) >= PLAYBOOK_REFRESH_MS) refreshTree(key);
      return;
    }
    const generation = pb.generation;
    pb.trees.set(key, 'loading');
    pb.treeErrors.delete(key);
    renderPlaybooks();
    let tree;
    try {
      tree = await getJson(treePath(playbook));
    } catch (error) {
      tree = error instanceof Error ? error : new Error('Could not load this playbook.');
    }
    if (generation !== pb.generation || handledAccountChange(tree)) return;
    pb.trees.set(key, tree);
    if (ready(tree)) pb.treeLoadedAt.set(key, Date.now());
    renderPlaybooks();
    if (ready(tree) && tree.access) loadSectionMemories(key);
  }

  // Re-reads an open playbook's sections without clearing what is shown. A failure keeps the sections
  // and says so above them; a change redraws them, keeping expanded sections, and refreshes their memories.
  async function refreshTree(key) {
    const playbook = (pb.list || []).find(item => pbKey(item) === key);
    if (!playbook || pb.treeRefreshing.has(key)) return;
    pb.treeRefreshing.add(key);
    const generation = pb.generation;
    let tree;
    try {
      tree = await getJson(treePath(playbook));
    } catch (error) {
      tree = error instanceof Error ? error : new Error('Could not refresh this playbook.');
    } finally {
      pb.treeRefreshing.delete(key);
    }
    if (generation !== pb.generation || !ready(pb.trees.get(key)) || handledAccountChange(tree)) return;
    if (tree instanceof Error) {
      if (pb.treeErrors.get(key) !== tree.message) { pb.treeErrors.set(key, tree.message); renderPlaybooks(); }
      return;
    }
    pb.treeLoadedAt.set(key, Date.now());
    const recovered = pb.treeErrors.delete(key);
    if (recovered || JSON.stringify(tree) !== JSON.stringify(pb.trees.get(key))) {
      pb.trees.set(key, tree);
      if (!tree.access) pb.memories.delete(key);
      renderPlaybooks();
    }
    if (tree.access) loadSectionMemories(key, true);
  }

  // Refresh reloads the list and every open playbook. The background refresh re-reads the list and
  // the open playbooks quietly and redraws only what changed. Either way, sections and memories are
  // replaced only once a new list arrives, so a failed refresh keeps what is shown and reports the
  // failure above the list. A newer load supersedes an older one.
  async function loadPlaybooks(quiet = false) {
    if (quiet && pb.listLoading) return;
    const ticket = ++pb.listTicket;
    pb.listLoading = true;
    pb.listCheckedAt = Date.now();
    if (!quiet) loadLearnings();
    let data;
    try {
      data = await getJson('/api/miq/playbooks');
    } catch (error) {
      data = error instanceof Error ? error : new Error('Could not load your Microsoft IQ playbooks.');
    }
    if (ticket !== pb.listTicket) return;
    pb.listLoading = false;
    if (handledAccountChange(data)) return;
    const error = data instanceof Error ? data.message : '';
    let changed = !quiet || error !== pb.listError;
    pb.listError = error;
    if (!error) {
      const list = Array.isArray(data.playbooks) ? data.playbooks : [];
      if (quiet) changed = mergeList(list) || changed;
      else replaceList(list);
    }
    if (changed) renderPlaybooks();
  }

  function replaceList(list) {
    pb.list = list;
    pb.generation += 1;
    pb.trees.clear();
    pb.treeLoadedAt.clear();
    pb.treeErrors.clear();
    pb.memories.clear();
    for (const key of [...pb.open]) {
      if (key === LEARNINGS) continue;
      if (list.some(item => pbKey(item) === key)) openPlaybook(key);
      else pb.open.delete(key);
    }
  }

  // Applies a background list: drops playbooks that are gone, re-reads the open ones and retries an open
  // playbook whose sections failed to load. Closed playbooks refresh when next opened. Returns whether
  // the list changed.
  function mergeList(list) {
    const changed = JSON.stringify(list) !== JSON.stringify(pb.list);
    pb.list = list;
    const listed = new Set(list.map(pbKey));
    for (const key of [...pb.trees.keys()]) {
      if (listed.has(key)) continue;
      pb.trees.delete(key);
      pb.treeLoadedAt.delete(key);
      pb.treeErrors.delete(key);
      pb.memories.delete(key);
    }
    for (const key of [...pb.open]) {
      if (key === LEARNINGS) continue;
      if (!listed.has(key)) { pb.open.delete(key); continue; }
      const tree = pb.trees.get(key);
      if (ready(tree)) refreshTree(key);
      else if (tree !== 'loading') openPlaybook(key);
    }
    return changed;
  }

  // Memories refresh on the Memories tab's auto-refresh interval, without reading Microsoft IQ.
  function refreshPlaybookMemories() {
    loadLearnings(true);
    for (const [key, tree] of pb.trees) if (ready(tree) && tree.access) loadSectionMemories(key, true);
  }

  // Checked every minute and when the Playbooks tab is selected. Like the memory refresh, it stops
  // while auto-refresh is off or the panel is hidden.
  function refreshPlaybooksIfStale() {
    if (document.hidden || !autoRefreshSeconds || pb.view !== 'playbooks' || pb.listLoading) return;
    if (Date.now() - pb.listCheckedAt >= PLAYBOOK_REFRESH_MS) loadPlaybooks(true);
  }

  $('tabMemories').addEventListener('click', () => setView('memories'));
  $('tabPlaybooks').addEventListener('click', () => setView('playbooks'));
  $('playbooks').addEventListener('click', event => {
    const toggle = event.target.closest('.mem-toggle');
    if (toggle) {
      const section = toggle.getAttribute('data-section');
      if (pb.openSections.has(section)) pb.openSections.delete(section);
      else pb.openSections.add(section);
      renderPlaybooks();
      return;
    }
    const head = event.target.closest('.pb-head');
    if (!head) return;
    const key = head.getAttribute('data-key');
    if (pb.open.has(key)) { pb.open.delete(key); renderPlaybooks(); }
    else if (key === LEARNINGS) { pb.open.add(key); renderPlaybooks(); }
    else openPlaybook(key);
  });

  let timer = null;
  let autoRefreshSeconds = 0;
  function setAutoRefresh(seconds) {
    const value = Math.min(Math.max(Number(seconds) || 0, 0), 300);
    autoRefreshSeconds = value;
    $('autoRefreshValue').textContent = value ? value + 's' : 'off';
    if (timer) clearInterval(timer);
    timer = value ? setInterval(() => {
      if (document.hidden) return;
      if (pb.view === 'memories') load();
      else refreshPlaybookMemories();
    }, value * 1000) : null;
  }
  $('autoRefresh').addEventListener('input', event => {
    const value = Math.min(Math.max(Number(event.target.value) || 0, 0), 300);
    $('autoRefreshValue').textContent = value ? value + 's' : 'off';
  });
  $('autoRefresh').addEventListener('change', event => setAutoRefresh(event.target.value));

  load();
  setAutoRefresh($('autoRefresh').value);
  setInterval(refreshPlaybooksIfStale, 60 * 1000);
</script>
</body>
</html>`;
}
