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
</style>
</head>
<body>
<header>
  <h1>Memory House</h1>
  <span id="who" class="who">Loading...</span>
  <span class="spacer"></span>
  <button id="import" class="primary" type="button">Import memory</button>
  <button id="refresh" type="button">Refresh</button>
</header>
<main>
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

  function card(memory) {
    const kind = memory.scope_kind;
    const where = kind === 'personal' ? 'Personal' : memory.scope_path || memory.scope_label;
    const pills = [
      '<span class="pill ' + esc(kind) + '">' + esc(where) + '</span>',
      memory.type ? '<span class="pill">' + esc(memory.type) + '</span>' : '',
      memory.source ? '<span class="pill">via ' + esc(memory.source) + '</span>' : '',
      memory.superseded ? '<span class="pill">superseded</span>' : '',
      ...memory.tags.slice(0, 4).map(tag => '<span class="pill">' + esc(tag) + '</span>'),
    ].join('');
    const promo = memory.promotion;
    const details = {
      id: memory.id, scope_key: memory.scope_key, scope_path: memory.scope_path || undefined, type: memory.type,
      created_at: memory.created_at, updated_at: memory.updated_at, salience: memory.salience, confidence: memory.confidence, source: memory.source,
      promoted_from: promo?.from_label || undefined, origin_user: promo?.origin || undefined,
      promotion_rationale: promo?.rationale || undefined, promoted_at: promo?.promoted_at || undefined,
    };
    const promoLines = promo ? '<div class="promo">' +
      (promo.from_label ? '<div><b>From:</b> ' + esc(promo.from_label) + '</div>' : '') +
      (promo.origin ? '<div><b>Origin:</b> ' + esc(promo.origin) + '</div>' : '') +
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

  $('refresh').addEventListener('click', load);
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

  let timer = null;
  function setAutoRefresh(seconds) {
    const value = Math.min(Math.max(Number(seconds) || 0, 0), 300);
    $('autoRefreshValue').textContent = value ? value + 's' : 'off';
    if (timer) clearInterval(timer);
    timer = value ? setInterval(() => { if (!document.hidden) load(); }, value * 1000) : null;
  }
  $('autoRefresh').addEventListener('input', event => {
    const value = Math.min(Math.max(Number(event.target.value) || 0, 0), 300);
    $('autoRefreshValue').textContent = value ? value + 's' : 'off';
  });
  $('autoRefresh').addEventListener('change', event => setAutoRefresh(event.target.value));

  load();
  setAutoRefresh($('autoRefresh').value);
</script>
</body>
</html>`;
}
