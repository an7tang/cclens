/* cclens dashboard frontend — zero dependencies, hand-drawn SVG charts */
'use strict';

// ---------------------------------------------------------------- State

const state = {
  overview: null,
  sessionId: null,
  session: null,
  detailId: null,
  detail: null,
  detailRaw: null,         // raw detail response text — diffed on live refresh; re-render skipped if unchanged
  detailTab: 'Messages',
  pending: new Map(),      // in-flight requests id -> {ts, kind, model, sessionId}
  ctxTable: false,         // context chart table view
  tlZoom: null,            // timeline zoom range {t0, t1} (absolute ms)
  sseShown: 300,
  sharedOpen: false,
  showAux: true,           // show bypass requests in the lineage
  agentOpen: new Map(),    // expansion-state overrides for agent groups in the lineage (agentKey -> bool)
  rawBlocks: false,        // message content: false = reading view (markdown/images/key-value), true = raw format
  hooks: null,             // hook-event layer data for the current session {events, tuids} (/__hooks/session, pairing annotated server-side)
  hooksSid: null, hooksAt: 0, // fetch throttle (5s)
  // whether to interleave hook narrative rows in the lineage (supporting layer, one-click toggle, preference remembered)
  hooksNarrative: (() => { try { return localStorage.getItem('lens.hooksNarr') !== '0'; } catch { return true; } })(),
  sidebarCollapsed: (() => { try { return localStorage.getItem('lens.sidebar') === '1'; } catch { return false; } })(),
};

// ---------------------------------------------------------------- DOM helpers (textContent only — no injection)

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'title') node.title = v;
      else node.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVGNS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// ---------------------------------------------------------------- Formatting

function fmtTok(n) {
  if (n == null) return '—';
  if (n < 10000) return n.toLocaleString('en-US');
  if (n < 1e6) return (n / 1000).toFixed(1) + 'K';
  return (n / 1e6).toFixed(2) + 'M';
}
function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  if (ms < 3600000) {
    const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
    return m + 'm' + String(s).padStart(2, '0') + 's';
  }
  const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
  return h + 'h' + String(m).padStart(2, '0') + 'm';
}
function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}
/** Short timestamp for index views: HH:MM if today, M/D prefix across days */
function fmtWhen(ts) {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}
function pct(x) { return (x * 100).toFixed(1) + '%'; }

// ---------------------------------------------------------------- Model colors (fixed mapping per model family; filtering/new series never reshuffles)

const MODEL_FAMILIES = [
  { re: /fable|mythos/i, name: 'fable', cssVar: '--s8' },
  { re: /opus/i, name: 'opus', cssVar: '--s5' },
  { re: /sonnet/i, name: 'sonnet', cssVar: '--s1' },
  { re: /haiku/i, name: 'haiku', cssVar: '--s3' },
];
function modelColor(model) {
  if (!model) return 'var(--ink-3)';
  for (const f of MODEL_FAMILIES) if (f.re.test(model)) return `var(${f.cssVar})`;
  return 'var(--s4)';
}
/** Mid-tone for large filled areas (same chart philosophy as the Transcript view):
 * full-strength foreground reads heavy as a large fill, so mix in the surface color; full saturation is reserved for small marks (model dots / text emphasis) */
function modelFill(model) {
  return `color-mix(in srgb, ${modelColor(model)} 62%, var(--surface-1))`;
}
function modelShort(model) {
  if (!model) return '—';
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

// Pricing ($/MTok, for estimates): [match, input, output]
const PRICING = [
  [/fable|mythos/i, 10, 50],
  [/opus/i, 5, 25],
  [/sonnet/i, 3, 15],
  [/haiku/i, 1, 5],
];
function estCost(model, u) {
  if (!model || !u) return 0;
  const p = PRICING.find(([re]) => re.test(model));
  if (!p) return 0;
  const [, pin, pout] = p;
  return (u.input * pin + u.cacheRead * 0.1 * pin + u.cacheWrite * 1.25 * pin) / 1e6 + (u.output * pout) / 1e6;
}

const REL_LABEL = {
  root: 'origin', extends: 'continues', retry: 'retry', compact: 'compact', rewrite: 'rewrite', branch: 'new branch',
  resend: 'resend', // history rollback + fresh user input at the tail (Esc-interrupted reworded resend / slash-command rollback) — not compaction
};

// Input identity at a turn's origin (server-side classifyUserText): human text / slash command / command-output backfill / pure injection / compaction continuation
const TURN_KIND = {
  text: { cls: '', pre: '', quote: true },
  command: { cls: 'tl-cmd', pre: '', quote: false },
  stdout: { cls: 'tl-inj', pre: '↩ ', quote: false },
  reminder: { cls: 'tl-inj', pre: '⚙ ', quote: false },
  continuation: { cls: 'tl-inj', pre: '⇢ ', quote: false },
};
/** Build the label node by input identity (shared by turn section headers / lineage rows / sidebar titles) */
function kindLabel(kind, label, baseClass) {
  if (!label) return null;
  const k = TURN_KIND[kind] || TURN_KIND.text;
  return el('span', { class: (baseClass + ' ' + k.cls).trim(), title: label },
    k.quote ? '“' + label + '”' : k.pre + label);
}

// Cache break (the previous request's cached prefix missed this time) — cause-attribution copy
function breakReason(cb) {
  switch (cb.reason) {
    case 'ttl': return `${fmtMs(cb.gapMs)} since the previous request — past the cache TTL (${cb.ttlMs >= 3600000 ? '1 hour' : '5 minutes'}), cache expired`;
    case 'system': return 'system change broke the cached prefix';
    case 'tools': return 'tools change broke the cached prefix';
    default: return 'cache missed unexpectedly (cause unclear — possibly cache contention between parallel branches)';
  }
}
function breakTitle(cb) {
  return breakReason(cb) + ` — previous request had ${fmtTok(cb.parentCached)} cached, only ${fmtTok(cb.parentCached - cb.lost)} hit this time, ${fmtTok(cb.lost)} tokens rewritten`;
}
/** Estimated overpay from the break: content that could have been read at 0.1x is rewritten at 1.25x */
function breakWasteCost(model, lost) {
  const p = PRICING.find(([re]) => model && re.test(model));
  return p ? lost * p[1] * (1.25 - 0.1) / 1e6 : 0;
}

// Generation-phase labels (streaming time spent in thinking/text/tool_use)
const PHASE_LABEL = { thinking: 'thinking', text: 'text', tool_use: 'tool args' };
function phaseParts(phases) {
  if (!phases) return [];
  return Object.entries(phases)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => (PHASE_LABEL[k] || k) + ' ' + fmtMs(v));
}

// Bypass request identities (recognized server-side from request-content features)
const PURPOSE_LABEL = {
  probe: 'probe', title: 'title gen', recap: 'recap summary', suggest: 'input suggestions',
  topic: 'topic detection', summary: 'compaction summary', websearch: 'web search',
  advisor: 'goal check', // /goal Stop hook: an advisor with full history judges whether the goal is met, driving the main agent onward
  guard: 'permission review',   // tool-call gating decision (conversation summary + block policy)
  aux: 'bypass',
};
function isAux(r) {
  if (r.kind === 'other') return true;
  return r.kind === 'messages' && r.purpose && r.purpose !== 'main';
}

// ---------------------------------------------------------------- Agents (subagent / teammate / workflow agent)

function agentByKey(key) {
  const list = (state.session && state.session.agents) || [];
  return list.find(a => a.key === key) || null;
}
/** Agent display name: the spawn description (fallback: prompt head / first message), truncated by visual width (CJK counts as 2) */
function truncLabel(s, maxW) {
  let w = 0, out = '';
  for (const ch of String(s || '')) {
    w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
    if (w > maxW) return out + '…';
    out += ch;
  }
  return out;
}
/** Whether an agent group is expanded: manual toggle > default (open while running or on error, collapsed once done).
    Never auto-collapse while one of its member requests is open — the default collapse right after an agent finishes would yank away the row the user is reading */
function agentIsOpen(a) {
  if (state.agentOpen.has(a.key)) return state.agentOpen.get(a.key);
  if (a.pending > 0 || a.errors > 0) return true;
  return !!(state.detailId && state.session &&
    (state.session.requests || []).some(r => r.id === state.detailId && r.agentKey === a.key));
}

// ---------------------------------------------------------------- tooltip

const tooltip = document.getElementById('tooltip');
function showTooltip(node, x, y) {
  clear(tooltip);
  tooltip.append(node);
  tooltip.style.display = 'block';
  const r = tooltip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 10;
  if (top + r.height > innerHeight - 8) top = y - r.height - 10;
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}
function hideTooltip() { tooltip.style.display = 'none'; }
function ttRow(color, label, value) {
  return el('div', { class: 'tt-row' },
    el('i', { class: 'k', style: `background:${color}` }), label, el('b', null, value));
}

// ---------------------------------------------------------------- Data loading

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  return r.json();
}

let refreshTimer = null;
let uiDragging = false; // drag in progress (timeline brush / split handle) — a refresh rebuilds the DOM and kills the drag, so defer until it ends
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    if (uiDragging) { scheduleRefresh(); return; }
    await loadOverview();
    if (state.sessionId) await loadSession(state.sessionId, true);
    if (state.detailId) await openDetail(state.detailId, true);
  }, 250);
}

// ---- URL hash routing: #s=<session>&r=<request> — reload/share/back-forward keeps the current spot

let pendingRoute = (() => {
  const m = {};
  for (const part of location.hash.replace(/^#/, '').split('&')) {
    const i = part.indexOf('=');
    if (i > 0) m[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return m.s || m.r || m.msg ? m : null;
})();

function syncHash() {
  const parts = [];
  if (state.sessionId) parts.push('s=' + encodeURIComponent(state.sessionId));
  if (state.detailId) parts.push('r=' + encodeURIComponent(state.detailId));
  const target = parts.length ? '#' + parts.join('&') : '';
  if (target !== location.hash) {
    try { history.replaceState(null, '', target || location.pathname + location.search); } catch {}
  }
}

window.addEventListener('hashchange', () => {
  const m = {};
  for (const part of location.hash.replace(/^#/, '').split('&')) {
    const i = part.indexOf('=');
    if (i > 0) m[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  if (m.s && m.s !== state.sessionId) { pendingRoute = m; selectSession(m.s); }
  else if (m.r && m.r !== state.detailId) openDetail(m.r);
  else if (!m.r && state.detailId) closeDetail();
});

// Version handshake: the server process is long-lived but static files are read fresh from disk — after a code upgrade
// an old process serves the new page, and the new UI hitting routes the old process lacks only gets baffling 404s.
// On a generation mismatch, prompt for a restart right away instead of letting the user trip over it
const EXPECT_API_GEN = 6; // keep in sync with API_GEN in server.js
let staleDismissed = false;
function staleBanner(stale) {
  const cur = document.getElementById('stale-banner');
  if (!stale || staleDismissed) { if (cur) cur.remove(); return; }
  if (cur) return;
  document.body.append(el('div', { id: 'stale-banner' },
    el('span', null, 'The server process is older than this page; some features are unavailable — restart it ',
      '(Ctrl+C the ', el('code', null, 'cclens'), ' terminal and run it again), then reload this page'),
    el('button', { class: 'btn', onclick: () => { staleDismissed = true; staleBanner(false); } }, 'Got it'),
  ));
}

async function loadOverview() {
  state.overview = await getJSON('/__lens/overview');
  const t = state.overview.totals || {};
  staleBanner(t.apiGen == null || t.apiGen < EXPECT_API_GEN);
  renderSidebar();
  renderTopbar();
  if (!state.sessionId && state.overview.sessions.length) {
    const want = pendingRoute && pendingRoute.s && state.overview.sessions.some(s => s.id === pendingRoute.s)
      ? pendingRoute.s : state.overview.sessions[0].id;
    selectSession(want);
  }
}

// session id → transcript relative path (bridge to the transcripts sub-tool; both hits and misses are cached, no lookups while the sub-tool is off)
const transcriptCache = new Map();
async function resolveTranscript(id) {
  const feat = state.overview && state.overview.features;
  if (feat && feat.viewer === false) return null;
  if (transcriptCache.has(id)) return transcriptCache.get(id);
  let rel = null;
  try { rel = (await getJSON('/__viewer/resolve?session=' + encodeURIComponent(id))).path || null; } catch {}
  transcriptCache.set(id, rel);
  return rel;
}

async function loadSession(id, keepScroll) {
  state.session = await getJSON('/__lens/session/' + encodeURIComponent(id));
  state.transcriptRel = await resolveTranscript(id);
  await loadHooks(id); // hook-event layer (present only when there is data; the detail pane renders the gap chronicle from it)
  updateViewSwitch(); // the switcher's "Transcripts" item follows the current session
  renderSession(keepScroll);
}

/** Fetch the hook-event layer for the current session (stays null when features.hooks is falsy or there is no data — the UI simply never appears).
 * Pairing annotations (durMs on PostToolUse / waitMs on PreToolUse) are written onto the events server-side. */
async function loadHooks(id) {
  const feats = state.overview && state.overview.features;
  if (!feats || !feats.hooks) { state.hooks = null; return; }
  const now = Date.now();
  if (state.hooksSid === id && now - state.hooksAt < 5000) return;
  state.hooksSid = id; state.hooksAt = now;
  try {
    state.hooks = await getJSON('/__hooks/session?id=' + encodeURIComponent(id));
    for (const e of (state.hooks && state.hooks.events) || []) e.tsMs = Date.parse(e.ts);
  } catch { state.hooks = null; }
  // Recorder-coverage disclosure: events with no registered recorder never appear in any view — this must be stated explicitly,
  // or "not shown" gets misread as "never happened" (the worst distortion an observability tool can make)
  if (state.hooks && state.hooksReg === undefined) {
    try {
      const st = await getJSON('/__hooks/status');
      const reg = new Set(st.registered.lens || []);
      // A registration whose recorder path no longer resolves runs nothing and records nothing, so it is
      // not coverage — drop those before counting, or the badge goes green over a dead recorder.
      for (const ev of st.broken || []) reg.delete(ev);
      // Recorded data is itself proof of coverage: an event type present in this session was evidently
      // captured, whatever settings.json currently says (the recorder may have been unregistered since,
      // or the data may come from elsewhere). Only types with neither a recorder nor any data are gaps.
      for (const e of state.hooks.events || []) reg.add(e.ev);
      const all = st.allEvents || [];
      state.hooksReg = { all, missing: all.filter(ev => !reg.has(ev)), brokenPath: st.brokenPath || null };
    } catch { state.hooksReg = null; }
  }
}

function selectSession(id) {
  state.sessionId = id;
  state.detailId = null;
  state.detail = null;
  state.tlZoom = null;
  document.getElementById('detail-pane').classList.remove('open');
  renderSidebar();
  syncHash();
  loadSession(id).then(() => {
    if (pendingRoute && pendingRoute.r) {
      const r = pendingRoute.r;
      pendingRoute = null;
      openDetail(r, true);
    } else if (pendingRoute && pendingRoute.msg && state.session) {
      // #msg=<api message id>: jump from a transcript record to the API request that produced it
      const hit = (state.session.requests || []).find(x => x.msgId === pendingRoute.msg);
      pendingRoute = null;
      if (hit) openDetail(hit.id, true);
    } else {
      pendingRoute = null;
    }
  }).catch(console.error);
}

// ---------------------------------------------------------------- Topbar & sidebar

/** Account-level rate-limit status (anthropic-ratelimit-* headers from the latest response; generic parsing, not tied to specific names) */
function rateLimitChip(rl) {
  const hdrs = rl.headers || {};
  const groups = new Map(); // resource -> {limit, remaining, reset}
  for (const [k, v] of Object.entries(hdrs)) {
    const m = k.match(/^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/);
    if (!m) continue;
    let g = groups.get(m[1]);
    if (!g) groups.set(m[1], g = {});
    g[m[2]] = v;
  }
  const parts = [];
  let low = false;
  for (const [res, g] of groups) {
    if (g.limit == null || g.remaining == null) continue;
    const rem = Number(g.remaining), lim = Number(g.limit);
    if (isFinite(rem) && isFinite(lim) && lim > 0 && rem / lim < 0.15) low = true;
    parts.push(res + ' ' + (isFinite(rem) ? fmtTok(rem) : g.remaining) + '/' + (isFinite(lim) ? fmtTok(lim) : g.limit));
  }
  const status = hdrs['anthropic-ratelimit-unified-status'];
  if (status && !parts.length) parts.push(status);
  if (!parts.length) return null;
  const tip = 'Rate-limit headers from the latest response (' + fmtWhen(rl.ts) + ')\n' +
    Object.entries(hdrs).map(([k, v]) => k.replace('anthropic-ratelimit-', '') + ': ' + v).join('\n');
  // narrow windows show only 1 resource; the full picture lives in the hover tooltip
  const shown = document.getElementById('content').classList.contains('narrow') ? 1 : 2;
  return el('span', { class: low ? 'rl-warn' : null, title: tip },
    'rate limit ', el('b', null, parts.slice(0, shown).join(' · ')));
}

function renderTopbar() {
  const m = document.getElementById('topbar-meta');
  clear(m);
  const t = state.overview ? state.overview.totals : null;
  if (!t) return;
  m.append(
    el('span', null, 'requests ', el('b', null, String(t.requests))),
    el('span', { class: 'm-hide-md' }, 'captured ', el('b', null, fmtBytes(t.capturedBytes))),
    el('span', { class: 'm-hide-lg', title: 'Space saved by storing repeated message content once, keyed by hash' }, 'dedup saved ', el('b', null, fmtBytes(t.dedupSavedBytes))),
  );
  const rl = t.rateLimit ? rateLimitChip(t.rateLimit) : null;
  if (rl) m.append(rl);
  updateViewSwitch();
}

/** The view switcher's "Transcripts" item (top left): hidden when the sub-tool is off; deep-links to the current session's transcript when one exists (switching keeps context) */
function updateViewSwitch() {
  const a = document.getElementById('vs-transcripts');
  if (!a) return;
  const feat = state.overview && state.overview.features;
  a.style.display = (!feat || feat.viewer !== false) ? '' : 'none';
  a.href = state.transcriptRel
    ? '/transcripts/viewer?path=' + encodeURIComponent(state.transcriptRel)
    : '/transcripts';
  a.title = state.transcriptRel ? 'Transcript view — jump to this session\'s transcript' : 'Transcript view — session transcript index';
}

function sessionActive(s) {
  if (s.pending) return true;
  if (Date.now() - s.lastTs < 15000) return true;
  for (const p of state.pending.values()) if (p.sessionId === s.id) return true;
  return false;
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  try { localStorage.setItem('lens.sidebar', state.sidebarCollapsed ? '1' : '0'); } catch { /* private mode, etc. */ }
  renderSidebar();
}

function renderSidebar() {
  const nav = document.getElementById('sidebar');
  clear(nav);
  nav.classList.toggle('collapsed', state.sidebarCollapsed);
  const sessions = state.overview ? state.overview.sessions : [];

  if (state.sidebarCollapsed) {
    const act = sessions.filter(sessionActive).length;
    nav.append(el('button', {
      class: 'side-toggle',
      title: `Expand session list (${sessions.length} sessions${act ? ', ' + act + ' active' : ''})`,
      onclick: toggleSidebar,
    }, '»'));
    if (act) nav.append(el('span', { class: 'act side-act', title: act + ' sessions active' }));
    return;
  }

  nav.append(el('div', { class: 'sidebar-title' },
    el('span', null, 'Sessions'),
    el('button', { class: 'btn side-collapse', title: 'Collapse session list', onclick: toggleSidebar }, '«'),
  ));
  if (!sessions.length) {
    nav.append(el('div', { class: 'empty-hint' },
      'No API traffic captured yet — this layer needs something in the network path:', el('br'), el('br'),
      'One command:', el('br'), el('code', null, 'cclens claude'), el('br'), el('br'),
      'Every session in a shell:', el('br'), el('code', null, "alias claude='cclens claude'"), el('br'), el('br'),
      'By hand:', el('br'),
      el('code', null, 'ANTHROPIC_BASE_URL=http://localhost:' + location.port + ' claude'),
      el('br'), el('br'), 'Already-running claude sessions cannot be attached — the proxy only sees traffic from processes that pointed at it on startup.'));
    return;
  }
  // Cards answer only what an index must answer: which session is this / is it active / anything wrong / how big, how fresh.
  // Full id, time span, bypass/abort counts etc. go into the hover tooltip — available on demand, no scanning bandwidth spent.
  for (const s of sessions) {
    const tip = [
      s.id,
      fmtTime(s.firstTs) + ' – ' + fmtTime(s.lastTs),
      s.main + ' main chain' + (s.agents ? ' · ' + s.agents + ' agents' : '') + ' · ' + s.aux + ' bypass' + (s.aborted ? ' · ' + s.aborted + ' aborted' : ''),
      Object.keys(s.models).map(modelShort).join(', '),
    ].filter(Boolean).join('\n');
    // Pure-bypass sessions (quota probes etc.): no main conversation, and their "errors" are mostly expected probe failures —
    // dim the whole card and drop the red, so real sessions stay prominent in the index
    const pureAux = !s.main && !s.agents;
    nav.append(el('div', {
      class: 'session-card' + (s.id === state.sessionId ? ' active' : '') + (pureAux ? ' dim' : ''),
      title: tip + (pureAux ? '\n(pure background bypass session, no main conversation)' : ''),
      onclick: () => selectSession(s.id),
    },
      el('div', { class: 'slabel' + (s.labelKind === 'command' ? ' sl-cmd' : '') },
        sessionActive(s) ? el('span', { class: 'act', title: 'Active' }) : null,
        (TURN_KIND[s.labelKind] && TURN_KIND[s.labelKind].pre || '') + (s.label || '(no message content)')),
      el('div', { class: 'smeta' },
        el('span', null, s.main ? s.main + ' main' : s.count + ' requests'),
        s.agents ? el('span', { title: s.agents + ' agents (subagents/teammates/workflow agents)' }, '⊂' + s.agents) : null,
        s.pending ? el('span', { class: 'm-pend' }, s.pending + ' running') : null,
        s.errors ? el('span', { class: pureAux ? 'm-err-soft' : 'm-err' }, s.errors + ' errors') : null,
        el('span', { class: 'm-when' }, fmtWhen(s.lastTs)),
        el('span', { class: 'mdots' },
          Object.keys(s.models).slice(0, 3).map(m => el('i', { style: 'background:' + modelColor(m), title: modelShort(m) }))),
      ),
    ));
  }
}

// ---------------------------------------------------------------- Session view

function renderSession(keepScroll) {
  const pane = document.getElementById('session-pane');
  const scrollY = keepScroll ? pane.scrollTop : 0;
  hideTooltip(); // the hovered element is about to be replaced and mouseleave will never fire — otherwise the tooltip sticks on screen
  clear(pane);
  if (!state.session) return;
  const reqs = state.session.requests;
  const agents = state.session.agents || [];
  const msgReqs = reqs.filter(r => r.kind === 'messages');
  const mainReqs = msgReqs.filter(r => !isAux(r) && !r.agentKey); // main conversation chain (the context chart looks only at this)
  const auxCount = reqs.filter(r => isAux(r) && !r.agentKey).length;
  const abortedCount = reqs.filter(r => r.aborted).length;

  // ---- Stat tiles (cost/usage totals include bypass — that is real spend; the context chart looks only at the main chain)
  const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let cost = 0, maxCtx = 0;
  for (const r of msgReqs) {
    sum.input += r.usage.input; sum.cacheRead += r.usage.cacheRead;
    sum.cacheWrite += r.usage.cacheWrite; sum.output += r.usage.output;
    cost += estCost(r.model, r.usage);
    maxCtx = Math.max(maxCtx, r.contextTokens);
  }
  const denom = sum.input + sum.cacheRead + sum.cacheWrite;

  // Cache-break summary (includes agent chains — breaks are real spend)
  const breaks = msgReqs.filter(r => r.cacheBreak);
  const lostTok = breaks.reduce((n, r) => n + r.cacheBreak.lost, 0);
  const wasteCost = breaks.reduce((n, r) => n + breakWasteCost(r.model, r.cacheBreak.lost), 0);
  const turns = state.session.turns || [];
  const turnRounds = turns.reduce((n, t) => n + t.rounds, 0);

  // Cache TTL countdown: until the cache written by the last main-chain request expires, the next round can still hit it;
  // after expiry the whole prefix is rewritten — show an explicit countdown for active sessions (updated in place every second)
  const cacheDesc = el('span', null,
    breaks.length ? '⚡ ' + breaks.length + ' breaks · ' + fmtTok(lostTok) + ' rewritten' : 'cache reads ÷ all input');
  const lastMainDone = [...mainReqs].reverse().find(r => r.end && r.cacheTtlMs);
  if (lastMainDone) {
    const expiry = lastMainDone.end + lastMainDone.cacheTtlMs;
    if (Date.now() < expiry) {
      cacheDesc.append(' · ', el('span', {
        class: 'ttl-count', 'data-expiry': String(expiry),
        title: 'Time until the cache written by the last main-chain request expires (TTL ' + (lastMainDone.cacheTtlMs >= 3600000 ? '1h' : '5m') + ') — after expiry the next round rewrites the whole prefix',
      }, ttlText(expiry)));
    }
  }

  const tiles = el('div', { class: 'tiles' },
    tile('API requests', String(reqs.length),
      mainReqs.length + ' main' + (agents.length ? ' · ' + agents.length + ' agents' : '') + (auxCount ? ' · ' + auxCount + ' bypass' : '') + (abortedCount ? ' · ' + abortedCount + ' aborted' : '')),
    turns.length ? tile('Turns', String(turns.length),
      'avg ' + (turnRounds / turns.length).toFixed(1) + ' API round-trips') : null,
    tile('Context peak', fmtTok(maxCtx), 'tokens / single request'),
    tile('Cache hit rate', denom ? pct(sum.cacheRead / denom) : '—', cacheDesc),
    tile('Output tokens', fmtTok(sum.output), 'new input ' + fmtTok(sum.input)),
    tile('Est. cost', '$' + cost.toFixed(3),
      wasteCost >= 0.005 ? 'incl. ~$' + wasteCost.toFixed(2) + ' overpaid on breaks' : 'estimated at list prices (incl. bypass)'),
  );
  pane.append(tiles);

  // ---- Timeline
  const zoomBtn = state.tlZoom
    ? el('button', { class: 'btn on', onclick: () => { state.tlZoom = null; renderSession(true); } }, 'Reset zoom')
    : null;
  const tlCard = el('div', { class: 'card' },
    el('h2', null, 'Request timeline ',
      el('span', { class: 'sub' }, 'bars = API requests (color = model) · hatched bars = local tool execution · drag to zoom, double-click to reset'),
      el('span', { class: 'spacer' }), zoomBtn),
  );
  const tlLegend = el('div', { class: 'legend' });
  const seen = new Set();
  for (const r of reqs) {
    const fam = MODEL_FAMILIES.find(f => r.model && f.re.test(r.model));
    const key = fam ? fam.name : (r.model ? 'other' : r.kind);
    if (seen.has(key)) continue;
    seen.add(key);
    tlLegend.append(el('span', { class: 'key' },
      el('i', { style: `background:${modelFill(r.model)}` }), r.model ? modelShort(r.model) : r.kind)); // legend swatch uses the same mid-tone as the timeline bars
  }
  // Local tool execution uses a hatch texture, not a hue — hue is reserved for model identity; tool gaps are structural "non-API time" info
  const HATCH_CSS = 'repeating-linear-gradient(45deg, color-mix(in srgb, var(--ink-1) 6%, transparent) 0 2px, var(--ink-3) 2px 4px)';
  if (reqs.some(r => r.gap && r.gap.kind === 'tools' && r.gap.ms >= 60)) {
    tlLegend.append(el('span', { class: 'key' },
      el('i', { style: `background:${HATCH_CSS};height:5px;border-radius:1px` }),
      'local tool execution'));
  }
  tlCard.append(tlLegend);

  // Main-chain time composition: how wall-clock time splits between model generation / local tools / waiting for input — the time truth of the agent loop
  // Encoded by descending lightness + texture (dark = model computing, hatch = local tools running, light = waiting on a human), without spending model hues
  const tsp = state.session.timeSplit;
  if (tsp && tsp.wallMs > 1500) {
    const segs = [
      ['model generation', tsp.apiMs, 'var(--ink-2)'],
      ['local tools', tsp.toolMs, HATCH_CSS],
      ['waiting for input', tsp.waitMs, 'var(--ctx-cache-read)'],
    ].filter(s => s[1] > 0);
    const bar = el('span', { class: 'split-bar' });
    for (const [label, v, color] of segs) {
      bar.append(el('i', { style: `width:${(v / tsp.wallMs * 100).toFixed(1)}%;background:${color}`, title: label + ' ' + fmtMs(v) }));
    }
    tlCard.append(el('div', { class: 'legend time-split' },
      el('span', null, 'main-chain wall clock ', el('b', null, fmtMs(tsp.wallMs))),
      bar,
      ...segs.map(([label, v, color]) => el('span', { class: 'key', title: label + ' ' + fmtMs(v) },
        el('i', { style: 'background:' + color }), label + ' ' + Math.round(v / tsp.wallMs * 100) + '%')),
    ));
  }

  // Hooks strip legend + pairing summary: same card as the timeline (the global view of hook events lives on the time axis — no isolated dashboard)
  const hkEvents = (state.hooks && state.hooks.events) || [];
  if (hkEvents.length) {
    const classes = new Map(); // class -> count
    let toolMs = 0, toolN = 0, waitTotal = 0, fails = 0;
    for (const e of hkEvents) {
      const c = HOOK_CLASS[e.ev] || 'life';
      classes.set(c, (classes.get(c) || 0) + 1);
      if (e.durMs != null) { toolMs += e.durMs; toolN++; }
      if (e.waitMs != null) waitTotal += e.waitMs;
      if (e.ev === 'PostToolUseFailure') fails++;
    }
    const line = el('div', { class: 'legend hooks-line' },
      el('span', { title: 'Hook-event chronicle (cclens hooks recorder) —\nthe Hooks strip on the timeline below marks every event; hover a tick for details\nTimestamps are recorder disk-write times (hook process start + write, roughly tens to ~100ms overhead), not harness-internal event times' },
        el('b', null, 'Hooks strip'), ' ' + hkEvents.length + ' events'),
      ...['human', 'tool', 'fail', 'agent', 'compact', 'life'].filter(c => classes.get(c)).map(c =>
        el('span', { class: 'key', title: HOOK_CLASS_EVENTS[c] }, el('i', { style: 'background:' + HOOK_CLASS_COLOR[c] }), HOOK_CLASS_LABEL[c] + ' ' + classes.get(c))),
      toolN ? el('span', null, 'tool time (measured) ', el('b', null, fmtMs(toolMs)),
        el('span', { class: 'ui-hint', title: 'Net execution wall clock from PreToolUse→PostToolUse pairing — excludes harness overhead and permission wait' }, '(Pre→Post paired)')) : null,
      waitTotal ? el('span', null, 'permission wait total ', el('b', null, fmtMs(waitTotal))) : null,
      fails ? el('span', { style: 'color:var(--critical)' }, 'PostToolUseFailure ', el('b', { style: 'color:var(--critical)' }, String(fails))) : null,
      // Coverage disclosure: event types with neither a recorder nor any recorded data are invisible here whatever happens underneath — state the gap explicitly
      state.hooksReg && state.hooksReg.missing.length ? el('span', {
        class: 'hk-cov-warn',
        title: 'These event types have no working recorder and no recorded data — even if they happen underneath, they will not appear in any view:\n'
          + state.hooksReg.missing.join(' / ')
          + (state.hooksReg.brokenPath
            ? `\n\nA recorder IS registered but its path no longer exists:\n${state.hooksReg.brokenPath}\nThose events are dropped silently. Re-run cclens install to repoint it.`
            : '\nRegister them with cclens install (takes effect for new sessions)'),
      }, '⚠ covered ' + (state.hooksReg.all.length - state.hooksReg.missing.length) + '/' + state.hooksReg.all.length + ' event types') : null,
      state.hooksReg && !state.hooksReg.missing.length ? el('span', {
        class: 'ui-hint',
        title: 'All ' + state.hooksReg.all.length + ' hook event types are covered — registered with a recorder, or already present in this session\'s data\n(periods before the recorder was registered still have no data)',
      }, 'covered ' + state.hooksReg.all.length + '/' + state.hooksReg.all.length) : null,
    );
    tlCard.append(line);
  }

  const tlWrap = el('div', { class: 'chart-wrap' });
  tlCard.append(tlWrap);
  pane.append(tlCard);

  // ---- Context composition (main chain only — bypass calls carry their own small contexts; mixing them in wrecks readability)
  const ctxCard = el('div', { class: 'card' });
  const tableBtn = el('button', { class: 'btn' + (state.ctxTable ? ' on' : ''), onclick: () => { state.ctxTable = !state.ctxTable; renderSession(true); } }, 'Table');
  ctxCard.append(el('h2', null, 'Context composition ', el('span', { class: 'sub' }, 'how much of each main-chain request\'s input is repeated history'), el('span', { class: 'spacer' }), tableBtn));
  ctxCard.append(el('div', { class: 'legend' },
    legendKey('var(--ctx-cache-read)', 'cache read (repeated history)'),
    legendKey('var(--ctx-cache-write)', 'cache write (newly cached)'),
    legendKey('var(--ctx-fresh)', 'new input (uncached)'),
    legendKey('var(--ctx-output)', 'output'),
  ));
  const ctxWrap = el('div', { class: 'chart-wrap' });
  ctxCard.append(ctxWrap);
  pane.append(ctxCard);

  // ---- Lineage
  const auxBtn = auxCount ? el('button', {
    class: 'btn' + (state.showAux ? ' on' : ''),
    title: 'Background calls: title generation / recap summary / input suggestions / probes, etc.',
    onclick: () => { state.showAux = !state.showAux; renderSession(true); },
  }, 'Bypass ' + auxCount) : null;
  const hkCount = ((state.hooks && state.hooks.events) || []).length;
  const hooksBtn = hkCount ? el('button', {
    class: 'btn' + (state.hooksNarrative ? ' on' : ''),
    title: 'Interleave the hook-event chronicle into the lineage (supporting rows): one row per hook event, real names shown.\n'
      + 'Narrative order = disk-write time (join anchoring guarantees no later than the request consuming its tool_result; exceptions are marked "disk +Nms" on the row);\n'
      + 'timestamps are recorder disk-write times (incl. ~100ms process overhead); for strict time geometry see the Hooks strip on the timeline above.\n'
      + 'When off, the lineage shows API request rows only.',
    onclick: () => {
      state.hooksNarrative = !state.hooksNarrative;
      try { localStorage.setItem('lens.hooksNarr', state.hooksNarrative ? '1' : '0'); } catch {}
      renderSession(true);
    },
  }, 'Hooks ' + hkCount) : null;
  const lineageCard = el('div', { class: 'card' },
    el('h2', null, 'Request lineage ', el('span', { class: 'sub' }, 'one row per real API request · agents collapse at their spawn point · ↑↓ to navigate'),
      el('span', { class: 'spacer' }), hooksBtn, auxBtn));
  lineageCard.append(renderLineage(reqs, state.session));
  pane.append(lineageCard);

  pane.scrollTop = scrollY;
  // Chart rendering needs the container to have width already; before the charts stretch the height,
  // the browser clamps scrollTop to a smaller value, so every refresh drifts the list upward —
  // restoring once more after the charts are drawn is what actually makes it stable
  requestAnimationFrame(() => {
    renderTimeline(tlWrap, reqs, state.session);
    if (state.ctxTable) renderCtxTable(ctxWrap, mainReqs);
    else renderCtxChart(ctxWrap, mainReqs);
    pane.scrollTop = scrollY;
  });
}

function tile(label, value, desc) {
  return el('div', { class: 'tile' },
    el('div', { class: 'tl' }, label),
    el('div', { class: 'tv' }, value),
    desc ? el('div', { class: 'td' }, desc) : null);
}
function legendKey(color, label) {
  return el('span', { class: 'key' }, el('i', { style: `background:${color}` }), label);
}

// ---------------------------------------------------------------- Timeline swimlane chart

function niceTicks(max, count) {
  if (max <= 0) return [0];
  const step = Math.pow(10, Math.floor(Math.log10(max / count)));
  const err = max / count / step;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const s = step * mult;
  const ticks = [];
  for (let v = 0; v <= max + 1e-9; v += s) ticks.push(v);
  return ticks;
}

function renderTimeline(wrap, reqs, session) {
  clear(wrap);
  if (!reqs.length) return;
  const lanes = session.lanes;
  const laneMeta = session.laneMeta || [];
  const agents = session.agents || [];
  const hasAgents = laneMeta.some(l => l.kind === 'agent');
  const W = Math.max(wrap.clientWidth || 600, 320);
  // With agent lanes, widen the label area for agent names; on narrow widths, tighten it to give width back to the plot;
  // with many lanes (large workflow concurrency), compress lane height
  const tight = W < 560;
  const padL = hasAgents ? (tight ? 92 : 128) : (tight ? 44 : 64), padR = 10;
  const laneH = lanes > 12 ? 20 : 26, barH = lanes > 12 ? 11 : 14;
  const axisH = 26;
  const now = Date.now();
  const full0 = Math.min(...reqs.map(r => r.ts));
  const full1 = Math.max(...reqs.map(r => r.end || now), full0 + 1000);
  const zoom = state.tlZoom;
  const t0 = zoom ? Math.max(zoom.t0, full0) : full0;
  const t1 = zoom ? Math.min(Math.max(zoom.t1, t0 + 200), full1) : full1;
  // With turn boundaries visible, reserve a label row at the top so T# doesn't sit on the first lane's request bars
  const hasTurnMarks = reqs.some(r => r.turnStart && r.turn > 1 && r.ts >= t0 && r.ts <= t1);
  const padT = hasTurnMarks ? 16 : 6;
  // Hooks strip: span bars + point ticks on the same time axis as request bars (same x scale, same zoom).
  // For paired events (Pre→Post execution / PermissionRequest→Pre permission wait) the core information is duration —
  // drawn as bars with length; point events (UserPromptSubmit/Stop/PreCompact…) only have position — kept as ticks.
  // The hatched inferred bars in the main lanes' gaps (API layer) align on the same axis with this strip's measured bars; the difference is harness overhead.
  const allHookEvs = (state.hooks && state.hooks.events) || [];
  const hookTuids = (state.hooks && state.hooks.tuids) || {};
  const hookSpans = []; // {t0,t1,kind:exec|fail|wait|run,row,e}
  const hookTicks = [];
  for (const e of allHookEvs) {
    if ((e.ev === 'PostToolUse' || e.ev === 'PostToolUseFailure') && e.durMs != null) {
      const s0 = e.tsMs - e.durMs;
      if (s0 <= t1 && e.tsMs >= t0) hookSpans.push({ t0: s0, t1: e.tsMs, kind: e.ev === 'PostToolUseFailure' ? 'fail' : 'exec', e });
      continue; // the span already expresses position — no extra tick
    }
    if (e.ev === 'PreToolUse') {
      if (e.waitMs != null && e.tsMs >= t0 && e.tsMs - e.waitMs <= t1)
        hookSpans.push({ t0: e.tsMs - e.waitMs, t1: e.tsMs, kind: 'wait', e });
      const info = e.tuid ? hookTuids[e.tuid] : null;
      if (info && info.open) { // Pre with no Post: still executing (or killed) — draw a translucent bar up to now
        if (e.tsMs <= t1) hookSpans.push({ t0: e.tsMs, t1: Math.max(Math.min(now, t1), e.tsMs + 1), kind: 'run', e });
        continue;
      }
      if (e.paired) continue; // server proved a Post pairing exists: the Post draws the span and this Pre is its left endpoint; unpaired Pres fall back to ticks
    }
    if (e.ev === 'PermissionRequest' && e.paired)
      continue; // already merged into the permission-wait span (exact marker); dangling permission requests keep their tick
    if (e.tsMs >= t0 && e.tsMs <= t1) hookTicks.push(e);
  }
  // When spans overlap (parallel agents/tools), greedily bin-pack into rows, max 4
  hookSpans.sort((a, b) => a.t0 - b.t0);
  let hookRowCount = 0;
  {
    const rowEnds = [];
    const tol = (t1 - t0) * 0.002; // sub-pixel overlap doesn't start a new row
    for (const s of hookSpans) {
      let row = rowEnds.findIndex(end => end <= s.t0 + tol);
      if (row < 0) row = rowEnds.length < 4 ? rowEnds.length : rowEnds.length - 1;
      s.row = row;
      rowEnds[row] = Math.max(rowEnds[row] || 0, s.t1);
    }
    hookRowCount = rowEnds.length;
  }
  const hookRowH = 12;
  const stripH = (hookSpans.length || hookTicks.length) ? Math.max(1, hookRowCount) * hookRowH + 6 : 0;
  const H = lanes * laneH + stripH + axisH + padT;
  const x = t => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const laneMid = i => padT + i * laneH + laneH / 2;

  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, height: H });
  // Hatch fill = local tool execution (non-API time) — distinguished by texture, not hue; hue is reserved for model identity
  root.append(svg('defs', null,
    svg('pattern', { id: 'lens-hatch', patternUnits: 'userSpaceOnUse', width: 5, height: 5, patternTransform: 'rotate(45)' },
      svg('rect', { width: 5, height: 5, fill: 'color-mix(in srgb, var(--ink-1) 6%, transparent)' }),
      svg('line', { x1: 0, y1: 0, x2: 0, y2: 5, stroke: 'var(--ink-3)', 'stroke-width': 2 }),
    ),
    // Permission-wait span: blue hatch (a human is deciding — same hue family as the human-interaction class; the hatch matches the gap inference bars' texture language = non-model time)
    svg('pattern', { id: 'lens-wait', patternUnits: 'userSpaceOnUse', width: 4, height: 4, patternTransform: 'rotate(45)' },
      svg('rect', { width: 4, height: 4, fill: 'color-mix(in srgb, var(--s1) 14%, var(--surface-1))' }),
      svg('line', { x1: 0, y1: 0, x2: 0, y2: 4, stroke: 'var(--s1)', 'stroke-width': 1.3 }),
    )));

  // Lane labels + separators
  laneMeta.forEach((lm, i) => {
    const name = lm.kind === 'agent' ? '⊂ ' + truncLabel(lm.label, tight ? 11 : 16) : lm.label;
    root.append(svg('text', {
      x: padL - 8, y: laneMid(i) + 3, 'text-anchor': 'end',
      class: 'lane-label' + (lm.kind === 'agent' ? ' lane-agent' : ''),
    }, name));
    if (i > 0) root.append(svg('line', { x1: padL, x2: W - padR, y1: padT + i * laneH - 3, y2: padT + i * laneH - 3, class: 'gridline' }));
  });

  const clampX = px => Math.min(Math.max(px, padL), W - padR);

  // Spawn connector: drawn from the spawning request (where the spawn tool_use lives) to the agent lane's first request — who spawned whom at a glance
  const bySeqId = new Map(reqs.map(r => [r.id, r]));
  for (const a of agents) {
    if (a.lane == null) continue;
    const spawnReq = a.spawnReqId ? bySeqId.get(a.spawnReqId) : null;
    const firstReq = bySeqId.get(a.firstReqId);
    if (!spawnReq || !firstReq) continue;
    if (firstReq.ts < t0 && (spawnReq.end || spawnReq.ts) < t0) continue; // outside the zoom window
    const sx = clampX(Math.min(x(spawnReq.end || spawnReq.ts), x(firstReq.ts))); // spawn point is never later than the agent's first request
    const sy = laneMid(spawnReq.lane);
    const ty = laneMid(a.lane);
    const tx = clampX(x(firstReq.ts));
    root.append(svg('path', {
      d: `M${sx},${sy} L${sx},${ty} L${tx},${ty}`,
      class: 'spawn-link', 'pointer-events': 'none',
    }));
    root.append(svg('circle', { cx: sx, cy: sy, r: 2.5, class: 'spawn-dot', 'pointer-events': 'none' }));
  }

  // Hooks strip (below the lanes, above the time axis): span bars show duration, point events show ticks; class colors match the card chips
  if (stripH) {
    const stripY = padT + lanes * laneH + 1;
    root.append(svg('line', { x1: padL, x2: W - padR, y1: stripY - 1, y2: stripY - 1, class: 'gridline' }));
    root.append(svg('text', { x: padL - 8, y: stripY + 10, 'text-anchor': 'end', class: 'lane-label' }, 'Hooks'));
    for (const s of hookSpans) {
      const x0 = clampX(x(Math.max(s.t0, t0)));
      const x1v = clampX(x(Math.min(s.t1, t1)));
      const w = Math.max(x1v - x0, 2);
      const y = stripY + 3 + s.row * hookRowH;
      const fill = s.kind === 'fail' ? 'var(--critical)'
        : s.kind === 'wait' ? 'url(#lens-wait)'
        : s.kind === 'run' ? 'color-mix(in srgb, var(--s8) 40%, var(--surface-1))'
        : HOOK_CLASS_COLOR.tool;
      root.append(svg('rect', {
        x: x0, y, width: w, height: hookRowH - 3, rx: 2, fill,
        stroke: s.kind === 'wait' ? 'var(--s1)' : 'none', 'stroke-width': s.kind === 'wait' ? 0.7 : 0,
        class: 'hook-span',
        onpointermove: ev2 => showTooltip(hookTip(s.e, s.kind), ev2.clientX, ev2.clientY),
        onpointerleave: hideTooltip,
      }));
      // In-bar labels degrade by width: real event name first, then tool name + duration, then the tooltip as fallback
      const candidates = s.kind === 'wait'
        ? ['PermissionRequest→PreToolUse ' + fmtMs(s.e.waitMs), 'waiting ' + fmtMs(s.e.waitMs)]
        : s.kind === 'run'
          ? ['PreToolUse · ' + (s.e.tool || '') + ' running', (s.e.tool || '') + ' running']
          : [s.e.ev + ' · ' + (s.e.tool || '') + ' ' + fmtMs(s.e.durMs), (s.e.tool || '') + ' ' + fmtMs(s.e.durMs)];
      const label = candidates.find(c => w > c.length * 5.4 + 8);
      if (label) {
        // Colour goes in an INLINE STYLE, not a fill attribute: `svg.chart text` sets fill in the stylesheet,
        // and any class selector beats a presentation attribute — an attribute here renders silently grey.
        // The exec/fail fills (orange #eb6834, red #d03b3b) are mid-tone, so white 8.5px text on them is only
        // ~3:1; near-black reads ~8:1 on both, and both fills are theme-independent so one constant is safe.
        const labelColor = s.kind === 'wait' ? 'var(--s1)' : s.kind === 'run' ? 'var(--ink-2)' : '#1b0f06';
        root.append(svg('text', {
          x: x0 + 4, y: y + hookRowH - 5.5, class: 'hook-span-label',
          style: `fill:${labelColor};font-size:8.5px;font-weight:${s.kind === 'run' ? 400 : 600}`,
          'pointer-events': 'none',
        }, label));
      }
    }
    for (const e of hookTicks) {
      const ex = clampX(x(e.tsMs));
      root.append(svg('rect', {
        x: ex - 1, y: stripY + 2, width: 2, height: stripH - 5, rx: 0.5,
        style: 'fill:' + hookColor(e.ev),
        class: 'hook-tick',
      }));
      // a 2px tick is too thin to hover — add a transparent widened hit zone to carry the tooltip
      root.append(svg('rect', {
        x: ex - 2.5, y: stripY, width: 5, height: stripH, fill: 'transparent',
        onpointermove: ev2 => showTooltip(hookTip(e), ev2.clientX, ev2.clientY),
        onpointerleave: hideTooltip,
      }));
    }
  }

  // Time axis
  const spanMs = t1 - t0;
  const yAxis = padT + lanes * laneH + stripH + 4;
  root.append(svg('line', { x1: padL, x2: W - padR, y1: yAxis, y2: yAxis, class: 'axisline' }));
  for (const tk of niceTicks(spanMs, 6)) {
    const xx = x(t0 + tk);
    if (xx > W - padR) continue;
    root.append(svg('line', { x1: xx, x2: xx, y1: yAxis, y2: yAxis + 4, class: 'axisline' }));
    root.append(svg('text', { x: xx, y: yAxis + 15, 'text-anchor': 'middle' }, '+' + fmtMs(tk)));
  }

  // Turn boundary lines: each new user input slices the main chain into turns
  for (const r of reqs) {
    if (!r.turnStart || r.turn === 1 || r.ts < t0 || r.ts > t1) continue;
    const tx = x(r.ts);
    root.append(svg('line', { x1: tx, x2: tx, y1: padT - 4, y2: yAxis, class: 'turn-line', 'pointer-events': 'none' }));
    root.append(svg('text', { x: tx + 3, y: padT - 6, class: 'turn-tick', 'pointer-events': 'none' }, 'T' + r.turn));
  }

  // Local tool-execution gap: the parent response ends in tool_use → this request backfills tool_result;
  // the space between the two bars is time Claude Code spent running tools locally — draw it explicitly
  for (const r of reqs) {
    if (!r.gap || r.gap.kind !== 'tools' || r.gap.ms < 60) continue;
    if (r.ts < t0 || r.ts - r.gap.ms > t1) continue;
    const gx0 = clampX(x(r.ts - r.gap.ms)), gx1 = clampX(x(r.ts));
    if (gx1 - gx0 < 2) continue;
    root.append(svg('rect', {
      x: gx0, y: laneMid(r.lane) - 2.5, width: gx1 - gx0, height: 5, rx: 1,
      fill: 'url(#lens-hatch)',
      class: 'gap-bar',
      onclick: () => openDetail(r.id),
      onpointermove: e => showTooltip(gapTip(r), e.clientX, e.clientY),
      onpointerleave: hideTooltip,
    }));
  }

  // Request bars
  for (const r of reqs) {
    if ((r.end || now) < t0 || r.ts > t1) continue; // outside the zoom window
    const bx = clampX(x(r.ts));
    const bw = Math.max(clampX(x(r.end || now)) - bx, 4);
    const by = laneMid(r.lane) - barH / 2;
    const color = r.pending ? 'color-mix(in srgb, var(--s2) 62%, var(--surface-1))'
      : (!r.aborted && (r.error || r.status >= 400)) ? 'var(--critical)' // errors stay fully saturated — semantic red must stand out
      : modelFill(r.model);
    const bar = svg('rect', {
      x: bx, y: by, width: bw, height: barH, rx: 3,
      style: `fill:${color}` + (r.aborted ? ';opacity:.45' : ''),
      class: 'tbar' + (r.pending ? ' tbar-pending' : ''),
      onclick: () => openDetail(r.id),
      onpointermove: e => showTooltip(timelineTip(r), e.clientX, e.clientY),
      onpointerleave: hideTooltip,
    });
    root.append(bar);
    if (r.aborted) {
      // Abort marker: a slash at the bar's end
      root.append(svg('text', {
        x: bx + bw + 2, y: by + barH - 3, class: 'abort-mark', 'pointer-events': 'none',
      }, '⧉'));
    }
    if (r.ttfbMs != null && r.stream) {
      // First-byte marker: a 2px surface-color vertical line inside the bar (surface-gap technique)
      const fx = x(r.ts + r.ttfbMs);
      if (fx > bx + 2 && fx < bx + bw - 2) {
        root.append(svg('rect', { x: fx, y: by, width: 2, height: barH, style: 'fill:var(--surface-1)', 'pointer-events': 'none' }));
      }
    }
  }

  // Drag-to-zoom: in long sessions request bars are sub-pixel wide — brush a range to see clearly; double-click to reset
  let drag = null;
  const band = svg('rect', { class: 'zoom-band', y: padT - 2, height: Math.max(yAxis - padT + 2, 1), x: 0, width: 0, 'pointer-events': 'none' });
  const evX = e => {
    const rect = root.getBoundingClientRect();
    return (e.clientX - rect.left) * (W / Math.max(rect.width, 1));
  };
  const pxToT = px => t0 + ((px - padL) / (W - padL - padR)) * (t1 - t0);
  root.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const px = evX(e);
    if (px < padL || px > W - padR) return;
    drag = { a: px, b: px, moved: false };
    uiDragging = true;
  });
  root.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.b = Math.min(Math.max(evX(e), padL), W - padR);
    if (Math.abs(drag.b - drag.a) > 4) {
      drag.moved = true;
      if (!band.parentNode) root.append(band);
      band.setAttribute('x', Math.min(drag.a, drag.b));
      band.setAttribute('width', Math.abs(drag.b - drag.a));
    }
  });
  const endDrag = () => {
    uiDragging = false;
    if (!drag) return;
    const { a, b, moved } = drag;
    drag = null;
    if (band.parentNode) band.remove();
    if (moved && Math.abs(b - a) > 8) {
      zoomClickGuard = Date.now();
      state.tlZoom = { t0: pxToT(Math.min(a, b)), t1: pxToT(Math.max(a, b)) };
      renderSession(true);
    }
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointerleave', endDrag);
  root.addEventListener('dblclick', () => {
    if (state.tlZoom) { state.tlZoom = null; renderSession(true); }
  });

  wrap.append(root);
}

// A click landing on a request bar right after a drag-zoom ends should not open the detail pane
let zoomClickGuard = 0;

/** Hover tooltip for the Hooks strip: real event name + time + pairing product + payload summary.
 * spanKind marks which interval this bar represents (one event may split into separate wait/exec bars). */
function hookTip(e, spanKind) {
  const n = el('div');
  n.append(el('div', { class: 'tt-title' }, e.ev + (e.tool ? ' · ' + e.tool : '')));
  // A span bar is the geometric projection of two real events — give both endpoint events' times in full
  if (spanKind === 'wait') n.append(el('div', { class: 'tt-row' },
    'PermissionRequest ' + fmtTime(e.tsMs - e.waitMs) + ' → PreToolUse ' + fmtTime(e.tsMs) + ' permission-wait span'));
  else if (spanKind === 'exec' || spanKind === 'fail') n.append(el('div', { class: 'tt-row' },
    'PreToolUse ' + fmtTime(e.tsMs - e.durMs) + ' → ' + e.ev + ' ' + fmtTime(e.tsMs) + ' measured execution span'));
  else if (spanKind === 'run') n.append(el('div', { class: 'tt-row' }, 'PreToolUse with no PostToolUse — still running, or killed'));
  n.append(ttRow(hookColor(e.ev), 'time', fmtTime(e.tsMs)));
  if (e.durMs != null) n.append(ttRow(hookColor(e.ev), 'measured exec', fmtMs(e.durMs)));
  if (e.waitMs != null) n.append(ttRow('var(--warning)', 'permission wait', fmtMs(e.waitMs)));
  if (e.sum) n.append(el('div', { class: 'tt-row' }, e.sum.slice(0, 90)));
  return n;
}

function timelineTip(r) {
  const n = el('div');
  const tag = isAux(r) ? ' · ' + (PURPOSE_LABEL[r.purpose] || 'bypass') : '';
  n.append(el('div', { class: 'tt-title' }, `#${r.seq} ${r.kind === 'messages' ? modelShort(r.model) : r.kind}${tag}`));
  if (r.agentKey) {
    const a = agentByKey(r.agentKey);
    if (a) n.append(el('div', { class: 'tt-row' }, '⊂ ' + truncLabel(a.label, 34) + (a.spawnSeq ? ' · spawned by #' + a.spawnSeq : '')));
  }
  if (r.pending) n.append(ttRow('var(--s2)', 'status', 'running ' + fmtMs(Date.now() - r.ts)));
  else if (r.aborted) n.append(ttRow('var(--critical)', 'status', 'aborted (partial response kept)'));
  n.append(ttRow(modelColor(r.model), 'duration', r.pending ? '—' : fmtMs(r.durMs)));
  if (r.ttfbMs != null) n.append(ttRow('var(--baseline)', 'first byte', fmtMs(r.ttfbMs)));
  const ph = phaseParts(r.phases);
  if (ph.length) n.append(el('div', { class: 'tt-row' }, ph.join(' · ')));
  if (r.stallMs) n.append(ttRow('var(--warning)', 'longest stall', fmtMs(r.stallMs)));
  if (r.kind === 'messages') {
    n.append(ttRow('var(--ctx-cache-read)', 'cache read', fmtTok(r.usage.cacheRead)));
    n.append(ttRow('var(--ctx-fresh)', 'new input', fmtTok(r.usage.input)));
    n.append(ttRow('var(--ctx-output)', 'output', fmtTok(r.usage.output)));
  }
  if (r.cacheBreak) n.append(ttRow('var(--s3)', '⚡cache break', fmtTok(r.cacheBreak.lost) + ' rewritten'));
  if (r.error || r.status >= 400) n.append(ttRow('var(--critical)', 'status', String(r.status || r.error)));
  return n;
}

function gapTip(r) {
  const n = el('div');
  n.append(el('div', { class: 'tt-title' }, 'Local tool execution (API idle)'));
  n.append(ttRow('var(--ink-3)', 'duration', fmtMs(r.gap.ms)));
  if (r.gap.tools) n.append(el('div', { class: 'tt-row' }, r.gap.tools.join(', ')));
  n.append(el('div', { class: 'tt-row' }, '#' + (r.parentSeq || '?') + ' responded with tool_use → #' + r.seq + ' backfilled tool_result'));
  return n;
}

// ---------------------------------------------------------------- Context composition chart

/** Model context-window inference: standard 200K; if the data already exceeds it, it must be the 1M window (context-1m beta) */
function ctxLimitFor(maxSeen) {
  return maxSeen > 200000 ? 1000000 : 200000;
}

function renderCtxChart(wrap, msgReqs) {
  clear(wrap);
  if (!msgReqs.length) { wrap.append(el('div', { class: 'note' }, 'No inference requests yet')); return; }
  const W = Math.max(wrap.clientWidth || 600, 320);
  const padL = W < 560 ? 42 : 52, padR = 10, plotH = 170, axisH = 22, padT = 6;
  const H = padT + plotH + axisH;
  const max = Math.max(...msgReqs.map(r => r.contextTokens + r.usage.output), 1);
  // When context nears the model cap, draw the cap into the chart — when compaction will hit becomes visible at a glance
  const limit = ctxLimitFor(max);
  const showLimit = max > limit * 0.5;
  const ticks = niceTicks(showLimit ? limit : max, 4);
  const yMax = showLimit ? Math.max(limit * 1.03, max) : Math.max(ticks[ticks.length - 1], max);
  const y = v => padT + plotH - (v / yMax) * plotH;

  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, height: H });

  for (const tk of ticks) {
    root.append(svg('line', { x1: padL, x2: W - padR, y1: y(tk), y2: y(tk), class: tk === 0 ? 'axisline' : 'gridline' }));
    root.append(svg('text', { x: padL - 6, y: y(tk) + 3, 'text-anchor': 'end' }, fmtTok(tk)));
  }
  if (showLimit) {
    root.append(svg('line', { x1: padL, x2: W - padR, y1: y(limit), y2: y(limit), class: 'limit-line' }));
    root.append(svg('text', { x: W - padR, y: y(limit) - 4, 'text-anchor': 'end', class: 'limit-label' },
      'model context cap ' + fmtTok(limit) + ' (peak ' + pct(max / limit) + ')'));
  }

  const band = (W - padL - padR) / msgReqs.length;
  const barW = Math.min(24, Math.max(band * 0.72, 3));

  msgReqs.forEach((r, i) => {
    const cx = padL + band * i + band / 2;
    const bx = cx - barW / 2;
    const segs = [
      ['var(--ctx-cache-read)', r.usage.cacheRead],
      ['var(--ctx-cache-write)', r.usage.cacheWrite],
      ['var(--ctx-fresh)', r.usage.input],
      ['var(--ctx-output)', r.usage.output],
    ].filter(s => s[1] > 0);
    let acc = 0;
    const g = svg('g', {
      class: 'bar',
      onclick: () => openDetail(r.id),
      onpointermove: e => showTooltip(ctxTip(r), e.clientX, e.clientY),
      onpointerleave: hideTooltip,
    });
    segs.forEach(([color, v], si) => {
      const y1 = y(acc + v), y0 = y(acc);
      acc += v;
      const isTop = si === segs.length - 1;
      const h = Math.max(y0 - y1, 1);
      if (isTop && h > 3) {
        // 3px rounded corners at the top (data end); the baseline end stays square
        const rr = Math.min(3, barW / 2);
        g.append(svg('path', {
          d: `M${bx},${y0} L${bx},${y1 + rr} Q${bx},${y1} ${bx + rr},${y1} L${bx + barW - rr},${y1} Q${bx + barW},${y1} ${bx + barW},${y1 + rr} L${bx + barW},${y0} Z`,
          style: `fill:${color}`,
        }));
      } else {
        g.append(svg('rect', { x: bx, y: y1, width: barW, height: h, style: `fill:${color}` }));
      }
      // 2px surface-color gap between segments
      if (si > 0) g.append(svg('rect', { x: bx, y: y0 - 1, width: barW, height: 2, style: 'fill:var(--surface-1)' }));
    });
    // widen the hit zone to the whole column band
    g.append(svg('rect', { x: padL + band * i, y: padT, width: band, height: plotH + axisH, fill: 'transparent' }));
    root.append(g);

    if (band > 22 || i % Math.ceil(24 / band) === 0) {
      root.append(svg('text', { x: cx, y: padT + plotH + 14, 'text-anchor': 'middle' }, '#' + r.seq));
    }
  });

  wrap.append(root);
}

function ctxTip(r) {
  const n = el('div');
  n.append(el('div', { class: 'tt-title' }, `#${r.seq} ${modelShort(r.model)} · ${r.msgCount} messages`));
  n.append(ttRow('var(--ctx-cache-read)', 'cache read', fmtTok(r.usage.cacheRead)));
  n.append(ttRow('var(--ctx-cache-write)', 'cache write', fmtTok(r.usage.cacheWrite)));
  n.append(ttRow('var(--ctx-fresh)', 'new input', fmtTok(r.usage.input)));
  n.append(ttRow('var(--ctx-output)', 'output', fmtTok(r.usage.output)));
  n.append(ttRow('var(--baseline)', 'total', fmtTok(r.contextTokens + r.usage.output)));
  return n;
}

function renderCtxTable(wrap, msgReqs) {
  clear(wrap);
  const t = el('table', { class: 'data-table' });
  t.append(el('tr', null,
    ...['#', 'Model', 'Messages', 'Cache read', 'Cache write', 'New input', 'Output', 'Total'].map(h => el('th', null, h))));
  for (const r of msgReqs) {
    t.append(el('tr', null,
      el('td', null, '#' + r.seq),
      el('td', null, modelShort(r.model)),
      el('td', null, String(r.msgCount)),
      el('td', null, fmtTok(r.usage.cacheRead)),
      el('td', null, fmtTok(r.usage.cacheWrite)),
      el('td', null, fmtTok(r.usage.input)),
      el('td', null, fmtTok(r.usage.output)),
      el('td', null, fmtTok(r.contextTokens + r.usage.output)),
    ));
  }
  wrap.append(t);
}

// ---------------------------------------------------------------- Lineage list

function describeAdded(added) {
  if (!added || !added.length) return '';
  // Listing a large batch of additions one by one (resume origins, compaction rebuilds…) carries no signal — summarize as role counts + tool names
  if (added.length > 4) {
    const roles = {};
    const tools = new Set();
    for (const m of added) {
      roles[m.role] = (roles[m.role] || 0) + 1;
      for (const b of m.blocks || []) if (b.startsWith('tool_use:')) tools.add(b.slice(9));
    }
    let s = Object.entries(roles).map(([r, c]) => r + '×' + c).join(' · ');
    if (tools.size) s += ' · tools ' + [...tools].slice(0, 4).join(', ') + (tools.size > 4 ? '…' : '');
    return s;
  }
  return added.map(m => {
    const blocks = m.blocks || [];
    const counts = {};
    for (const b of blocks) {
      const key = b.startsWith('tool_use:') ? 'tool_use ' + b.slice(9) : b;
      counts[key] = (counts[key] || 0) + 1;
    }
    const inner = Object.entries(counts).map(([k, c]) => c > 1 ? `${k}×${c}` : k).join(', ');
    return `${m.role}(${inner || 'text'})`;
  }).join(' + ');
}

function renderLineage(reqs, session) {
  const agents = (session && session.agents) || [];
  const byKey = new Map(agents.map(a => [a.key, a]));

  // Split streams: the root stream (main conversation + unattributed bypass) vs. each agent's member requests; the bypass filter never touches requests inside agents
  const members = new Map();
  const root = [];
  for (const r of reqs) {
    if (r.agentKey && byKey.has(r.agentKey)) {
      if (!members.has(r.agentKey)) members.set(r.agentKey, []);
      members.get(r.agentKey).push(r);
    } else {
      if (!state.showAux && isAux(r)) continue;
      root.push(r);
    }
  }
  const maxTotal = Math.max(...reqs.map(r => r.contextTokens + (r.usage ? r.usage.output : 0)), 1);

  // Agent-group mount points: prefer right after the spawning request row (incl. nesting — when the spawning row lives inside a parent agent's member stream, the group nests along);
  // when the spawn point is unknown (missing response / prompt match failed), insert into the root stream by first-request time
  const afterReq = new Map();
  const byTime = [];
  for (const a of agents) {
    if (a.spawnReqId && reqs.some(r => r.id === a.spawnReqId)) {
      if (!afterReq.has(a.spawnReqId)) afterReq.set(a.spawnReqId, []);
      afterReq.get(a.spawnReqId).push(a);
    } else {
      byTime.push(a);
    }
  }
  byTime.sort((x, y) => x.firstTs - y.firstTs);

  function groupNode(a) {
    const open = agentIsOpen(a);
    const dur = a.lastTs > a.firstTs ? fmtMs(a.lastTs - a.firstTs) : null;
    const spawnLink = a.spawnSeq
      ? el('a', { class: 'ag-spawn', onclick: e => { e.stopPropagation(); openDetail(a.spawnReqId); } }, 'spawned by #' + a.spawnSeq)
      : null;
    const head = el('div', {
      class: 'ag-head',
      onclick: () => { state.agentOpen.set(a.key, !agentIsOpen(a)); renderSession(true); },
    },
      el('span', { class: 'ag-chevron' }, open ? '▾' : '▸'),
      el('span', { class: 'ag-glyph' }, '⊂'),
      el('span', { class: 'ag-label', title: a.label }, truncLabel(a.label, 44)),
      a.type ? el('span', { class: 'ag-type' }, a.type) : null,
      spawnLink,
      a.pending ? el('span', { class: 'rel pend' }, 'running') : null,
      a.errors ? el('span', { class: 'err' }, a.errors + ' errors') : null,
      a.aborted ? el('span', { class: 'rel abort' }, a.aborted + ' aborted') : null,
      el('span', { class: 'ag-stats' },
        a.count + ' requests · output ' + fmtTok(a.usage.output) + (dur ? ' · ' + dur : '')
        // hook rows belonging to this group hide along with the collapse — disclose the count explicitly so the books balance (not shown ≠ never happened)
        + (!open && hkNarr && (hkNarr.get(a.key) || []).length
            ? ' · ' + hkNarr.get(a.key).length + ' hook events' : '')),
    );
    const g = el('li', { class: 'agent-group' });
    g.append(head);
    if (open) g.append(buildList(members.get(a.key) || [], false, a.key));
    return g;
  }

  // Turn separators: each new user input on the main chain starts a turn (skip the noise when the session has only 1)
  const turnsList = (session && session.turns) || [];
  const turnByN = new Map(turnsList.map(t => [t.n, t]));
  const showTurns = turnsList.length > 1;

  function turnSep(r) {
    const ta = turnByN.get(r.turn) || {};
    const stats = [];
    if (ta.rounds) stats.push(ta.rounds + ' rounds');
    if (ta.apiMs) stats.push('model ' + fmtMs(ta.apiMs));
    if (ta.toolMs) stats.push('tools ' + fmtMs(ta.toolMs));
    return el('li', { class: 'turn-sep' },
      el('span', { class: 'turn-no' }, 'Turn ' + r.turn),
      kindLabel(r.turnKind, r.turnLabel, 'turn-label'),
      stats.length ? el('span', { class: 'turn-stats' }, stats.join(' · ')) : null,
    );
  }

  // Hook narrative layer (supporting cast): one merged timeline per container (principles in the hookNarrativeIndex comment)
  const hkNarr = state.hooksNarrative ? hookNarrativeIndex(reqs) : null;

  function buildList(items, isRoot, containerKey) {
    const list = el('ul', { class: 'lineage' + (isRoot ? '' : ' agent-members') });
    const entries = (hkNarr && hkNarr.get(containerKey)) || [];
    let ti = 0, hi = 0;
    // One unified timeline: request rows (by ts), agent groups (by firstTs), hook rows (by sort key k)
    // interleaved under a single cursor scheme — letting any one class "go first as a batch" causes cross-class overtaking.
    // Relies on the invariant: items are monotonic by ts (an order-preserving subsequence of the server sort).
    const flushTo = limit => { while (hi < entries.length && entries[hi].k <= limit) list.append(hookNarrRow(entries[hi++])); };
    for (const r of items) {
      if (isRoot) while (ti < byTime.length && byTime[ti].firstTs <= r.ts) {
        flushTo(byTime[ti].firstTs); // events before the group's start come out first; the group doesn't overtake as a batch
        list.append(groupNode(byTime[ti++]));
      }
      if (isRoot && showTurns && r.turnStart) {
        // Anchor the turn separator to the real event that triggered it: the first UserPromptSubmit/SessionStart in the window
        // (multiple queued inputs in one window all belong to the new turn — anchor the first); earlier events (Stop / tool wrap-up…)
        // belong to the previous turn. With no input event (unrecorded/continuation), the separator hugs the request row.
        let sepIdx = -1;
        for (let j = hi; j < entries.length && entries[j].k <= r.ts; j++) {
          const ev = entries[j].e.ev;
          if (ev === 'UserPromptSubmit' || ev === 'SessionStart') { sepIdx = j; break; }
        }
        if (sepIdx >= 0) { while (hi < sepIdx) list.append(hookNarrRow(entries[hi++])); }
        else flushTo(r.ts);
        list.append(turnSep(r));
      }
      flushTo(r.ts);
      list.append(rowOf(r));
      for (const a of afterReq.get(r.id) || []) {
        flushTo(a.firstTs); // the spawn tool's PreToolUse happens before the group — emit it first (bracketing narrative)
        list.append(groupNode(a));
      }
    }
    if (isRoot) while (ti < byTime.length) { flushTo(byTime[ti].firstTs); list.append(groupNode(byTime[ti++])); }
    flushTo(Infinity);
    return list;
  }

  // First principle of the row design: every row answers "what happened in this step".
  // The default case (continuation) stays quiet — no badge, the description gives the content directly (tool names / user input);
  // only exceptional cases (origin/retry/compact/rewrite/branch/bypass/cache break/error) jump out with a badge.
  // Two fixed metric columns: the context-composition bar + value (replay mechanics), and duration. One layout from full width down to the nav rail.
  function rowOf(r) {
    const isMsg = r.kind === 'messages';
    const aux = isAux(r);

    let relClass = '', relText = '';
    if (isMsg && aux) {
      relClass = 'auxp'; relText = PURPOSE_LABEL[r.purpose] || 'bypass';
    } else if (isMsg && r.relation && r.relation !== 'extends') {
      relClass = r.relation; relText = REL_LABEL[r.relation] || r.relation;
    } else if (r.kind === 'count_tokens') {
      relClass = 'auxp'; relText = 'count';
    } else if (!isMsg) {
      relClass = 'auxp'; relText = r.kind;
    }

    // Description = "what happened in this step"
    let what;
    if (isMsg && !aux) {
      if (r.relation === 'retry') {
        what = el('span', { class: 'w-dim' }, 'same request body as #' + r.parentSeq + ' resent');
      } else if (r.relation === 'compact' || r.relation === 'rewrite' || r.relation === 'resend') {
        // For compact/rewrite/resend the mechanics numbers beat a "new input" marker (the quote is already in the turn header)
        what = el('span', null, `kept ${r.sharedPrefix} · dropped ${r.removedCount} · new ${r.msgCount - r.sharedPrefix}`);
      } else if (r.turnStart && r.turnLabel) {
        // With a turn header the label already sits in the header, so the row only marks the input identity; single-turn sessions have no header — the label goes in the row
        const KIND_WORD = { text: 'new input', command: 'command', stdout: 'stdout backfill', reminder: 'injection', continuation: 'continuation' };
        what = showTurns
          ? el('span', { class: 'w-dim' }, KIND_WORD[r.turnKind] || 'new input')
          : el('span', null, kindLabel(r.turnKind, r.turnLabel, r.turnKind === 'text' ? 'w-quote' : ''));
      } else {
        // Tool-loop row: the tools the previous response asked for finished locally; results ride back with this request
        const counts = new Map();
        for (const m of r.addedMsgs || [])
          for (const b of m.blocks || [])
            if (b.startsWith('tool_use:')) counts.set(b.slice(9), (counts.get(b.slice(9)) || 0) + 1);
        if (counts.size) {
          const names = [...counts.entries()].map(([n, c]) => n + (c > 1 ? ' ×' + c : ''));
          what = el('span', null, names.slice(0, 3).join(' · ') + (names.length > 3 ? ' +' + (names.length - 3) : ''));
        } else if (r.relation === 'extends' && r.sharedPrefix != null) {
          what = el('span', { class: 'w-dim' }, '+' + Math.max(0, r.msgCount - r.sharedPrefix) + ' msgs');
        } else {
          what = el('span', { class: 'w-dim' }, r.msgCount != null ? r.msgCount + ' messages' : '');
        }
      }
      if (r.systemChanged || r.toolsChanged) {
        what = el('span', null, what, el('span', { class: 'w-dim' },
          (r.systemChanged ? ' · system changed' : '') + (r.toolsChanged ? ' · tools changed' : '')));
      }
    } else if (isMsg) {
      what = el('span', { class: 'w-dim' }, modelShort(r.model) +
        (r.usage && r.usage.output ? ' · output ' + fmtTok(r.usage.output) : ''));
    } else if (r.kind === 'count_tokens') {
      what = el('span', { class: 'w-dim' },
        (r.inputTokensCounted != null ? 'counted ' + fmtTok(r.inputTokensCounted) + ' · ' : '') + modelShort(r.model));
    } else {
      what = el('span', { class: 'w-dim' }, (r.method || '') + ' ' + (r.path || ''));
    }

    const ctxbar = el('div', { class: 'ctxbar' });
    let tokText = '';
    if (isMsg && r.usage) {
      const total = r.contextTokens + r.usage.output;
      for (const [v, cssVar] of [[r.usage.cacheRead, '--ctx-cache-read'], [r.usage.cacheWrite, '--ctx-cache-write'], [r.usage.input, '--ctx-fresh'], [r.usage.output, '--ctx-output']]) {
        const w = (v / maxTotal) * 100;
        if (w > 0.15) ctxbar.append(el('i', { style: `width:${w}%;background:var(${cssVar})` }));
      }
      if (total === 0) ctxbar.style.visibility = 'hidden';
      else {
        tokText = fmtTok(r.contextTokens);
        ctxbar.title = 'Context composition — cache read ' + fmtTok(r.usage.cacheRead) + ' · cache write ' + fmtTok(r.usage.cacheWrite)
          + ' · uncached ' + fmtTok(r.usage.input) + ' · output ' + fmtTok(r.usage.output);
      }
    } else {
      ctxbar.style.visibility = 'hidden';
    }

    // The hover tooltip carries the full information (the description is trimmed for readability)
    const tip = ['#' + r.seq];
    if (relText) tip.push(relText + (r.parentSeq != null && r.relation !== 'root' ? ' from #' + r.parentSeq : ''));
    else if (r.relation === 'extends') tip.push('continues');
    if (isMsg && !aux && r.turnStart && r.turnLabel) tip.push('“' + r.turnLabel + '”');
    if (isMsg && (r.relation === 'extends' || r.relation === 'branch' || r.relation === 'root')) {
      const d = describeAdded(r.addedMsgs);
      if (d) tip.push('added ' + d);
    }
    if (isMsg) {
      tip.push(r.msgCount + ' messages', modelShort(r.model));
      if (r.contextTokens) tip.push('context ' + fmtTok(r.contextTokens));
    }
    if (!r.pending && r.durMs != null) tip.push(fmtMs(r.durMs));

    return el('li', {
      class: (r.id === state.detailId ? 'selected ' : '') + (aux ? 'aux-row ' : '') + (r.pending ? 'pending' : ''),
      'data-rid': r.id,
      title: tip.join(' · '),
      onclick: () => openDetail(r.id),
    },
      el('span', { class: 'seq' }, '#' + r.seq),
      el('span', { class: 'model-dot', style: `background:${modelColor(r.model)}` }),
      relText ? el('span', { class: 'rel ' + relClass }, relText) : null,
      el('span', { class: 'desc' }, what),
      r.cacheBreak ? el('span', { class: 'rel break', title: breakTitle(r.cacheBreak) }, '⚡break') : null,
      r.pending ? el('span', { class: 'rel pend' }, 'running') : null,
      r.aborted ? el('span', { class: 'rel abort', title: 'Aborted client-side — the partial response received before the interrupt is kept' }, 'aborted') : null,
      (!r.pending && !r.aborted && (r.error || r.status >= 400)) ? el('span', { class: 'err' }, String(r.status >= 400 ? r.status : '✕')) : null,
      ctxbar,
      el('span', { class: 'tok' }, tokText),
      el('span', { class: 'dur' }, r.pending ? fmtMs(Date.now() - r.ts) + '…' : fmtMs(r.durMs)),
    );
  }

  return buildList(root, true, '_root');
}

// ---------------------------------------------------------------- Detail pane

/** Across a layout change (list reflow caused by the detail pane opening/closing), keep the given row's viewport position fixed */
function anchorScroll(row, mutate) {
  const pane = document.getElementById('session-pane');
  const before = row ? row.getBoundingClientRect().top : null;
  mutate();
  if (row && before != null) pane.scrollTop += row.getBoundingClientRect().top - before;
}

/** Update the lineage selection in place — no full re-render; list scroll and hover state stay untouched */
function updateLineageSelection() {
  for (const li of document.querySelectorAll('#session-pane .lineage li[data-rid]')) {
    li.classList.toggle('selected', li.dataset.rid === state.detailId);
  }
}

async function openDetail(id, silent) {
  if (Date.now() - zoomClickGuard < 300) return; // the click that ends a drag-zoom
  let text;
  try {
    const resp = await fetch('/__lens/request/' + encodeURIComponent(id));
    if (!resp.ok) throw new Error('/__lens/request → ' + resp.status);
    text = await resp.text();
  } catch (e) {
    if (!silent) console.error(e);
    return;
  }
  const isNew = state.detailId !== id;
  // When a live refresh (triggered by other requests coming and going) returns content identical to what's rendered, leave the DOM alone —
  // preserving expansion state, text selection, and reading position. The response body is deterministic for a given data state, so text comparison is reliable
  if (!isNew && text === state.detailRaw) return;
  try { state.detail = JSON.parse(text); } catch (e) { if (!silent) console.error(e); return; }
  state.detailRaw = text;
  if (isNew) { state.detailTab = 'Messages'; state.sharedOpen = false; state.sseShown = 300; }
  state.detailId = id;
  syncHash();
  // Opening the detail pane the first time narrows and reflows the left list — anchor the clicked row so its viewport position holds
  const row = document.querySelector('#session-pane .lineage li[data-rid="' + CSS.escape(id) + '"]');
  anchorScroll(row, () => {
    renderDetail();
    updateLineageSelection();
  });
  if (isNew) document.getElementById('detail-pane').scrollTop = 0; // scroll to top only when the request changed
}

function closeDetail() {
  const row = document.querySelector('#session-pane .lineage li.selected');
  state.detailId = null;
  state.detail = null;
  state.detailRaw = null;
  syncHash();
  anchorScroll(row, () => {
    document.getElementById('detail-pane').classList.remove('open');
    updateLineageSelection();
  });
}

let lastDetailViewKey = '';

/** Cross-layer deep-link slot: the transcript record for this request's response (message id shared across both layers).
 * Only messages that actually land in a transcript get a link: main chain → session transcript; agent requests → their own agent-<id>.jsonl.
 * Bypass calls (title/suggestions/advisor…) never land in a transcript — no fake links. Transcript path resolution is async: placeholder first, filled later. */
function transcriptSlot(d) {
  if (!d.response || !d.response.id) return null;
  const slot = el('span', { class: 'detail-transcript-slot' });
  const relP = d.agent && d.agent.agentId
    ? resolveTranscript(d.agent.agentId)
    : (d.purpose === 'main' ? Promise.resolve(state.transcriptRel) : Promise.resolve(null));
  relP.then(rel => {
    if (!rel || state.detailId !== d.id) return;
    slot.append(el('a', {
      class: 'nav-link detail-transcript',
      href: '/transcripts/viewer?path=' + encodeURIComponent(rel) + '#msg=' + encodeURIComponent(d.response.id),
      target: '_blank', rel: 'noopener',
      title: 'Locate this assistant message in the transcript (session semantic layer)',
    }, 'Transcript ↗'));
  });
  return slot;
}

// ---- Hook-event chronicle: what actually happened locally between two API requests ----
// The API layer can only *infer* what a gap was for (d.gap: local tool execution / waiting for input / retry backoff);
// the hook layer is the *chronicle*: real tool execution time (PreToolUse→PostToolUse), permission wait
// (PermissionRequest→PreToolUse), and lifecycle events like compaction/subagents/notifications. The two corroborate each other.
// Presentation principle (user-mandated): list events under their *real names*, one by one — the heart of observability is seeing what actually happened;
// no collapsing, no paraphrasing; explanatory text goes only into hover annotations.

const HOOK_EV_GLOSS = {
  SessionStart: 'Session process started (source: startup/resume/clear…)',
  SessionEnd: 'Session process exited (reason in payload)',
  UserPromptSubmit: 'User submitted input',
  PermissionRequest: 'Permission request — the time until the next PreToolUse for the same tool is human decision time',
  PreToolUse: 'Tool about to execute (pairing start; annotated with permission wait when a PermissionRequest precedes it)',
  PostToolUse: 'Tool finished — paired with PreToolUse to yield measured execution time',
  PostToolUseFailure: 'Tool execution failed',
  Notification: 'Desktop notification (awaiting input / permission reminders, etc.)',
  SubagentStart: 'Subagent started', SubagentStop: 'Subagent finished',
  PreCompact: 'Context compaction imminent (trigger: auto / manual = /compact)',
  Stop: 'Main turn ended (model stopped generating)',
};

// Events are colored by semantic class (12 colors are unreadable; 5-6 classes scan well). Hue semantics align with both views' existing conventions:
// blue = human (Transcript's user blue), orange = tool (Transcript's tool orange), green = session lifecycle
// (Transcript's system green), purple = subagent, amber = compaction (same semantics as the lineage compact badge), red = failure (global semantic red).
// Used only for small marks (event-name text / strip ticks / chip dots) — large fills still follow the model-identity and mid-tone principles.
const HOOK_CLASS = {
  UserPromptSubmit: 'human', PermissionRequest: 'human', Notification: 'human',
  PreToolUse: 'tool', PostToolUse: 'tool',
  PostToolUseFailure: 'fail',
  PreCompact: 'compact',
  SubagentStart: 'agent', SubagentStop: 'agent',
  SessionStart: 'life', SessionEnd: 'life', Stop: 'life',
};
const HOOK_CLASS_COLOR = {
  human: 'var(--s1)',
  tool: 'var(--s8)',
  fail: 'var(--critical)',
  compact: 'color-mix(in srgb, var(--s3) 78%, var(--ink-1))',
  agent: 'var(--s5)',
  life: 'var(--s4)',
};
const HOOK_CLASS_LABEL = { human: 'human interaction', tool: 'tool execution', fail: 'failure', agent: 'subagent', compact: 'compaction', life: 'lifecycle' };
// Legend hover: which real event names each class contains
const HOOK_CLASS_EVENTS = (() => {
  const m = {};
  for (const [ev, c] of Object.entries(HOOK_CLASS)) m[c] = (m[c] ? m[c] + ' / ' : '') + ev;
  return m;
})();
function hookColor(ev) {
  const c = HOOK_CLASS[ev];
  return c ? HOOK_CLASS_COLOR[c] : 'var(--ink-2)';
}

/** Lineage narrative index — how hook events interleave between request rows (the supporting layer).
 *
 * **One hook event = one row = one payload; no event is ever merged** (the iron rule the user stated twice:
 * observation stays faithful to the real event stream; Pre/Post pairing is an analysis artifact and lives only as annotations on the real event rows —
 * durMs on the PostToolUse row, waitMs on the PreToolUse row, same convention as the Transcript view;
 * only the timeline's geometric projection draws a span as one bar — the event list is always one-by-one).
 *
 * Attribution beats chronology: events carrying a tool_use_id (Pre/Post/PermissionRequest) anchor before
 * the row of "the request that consumes their tool_result", ordered within the group by event time — narrative order is causal order.
 * The join is done only for main-chain (incl. agent-chain) requests — bypass calls (input suggestions/advisor/guard…) may replay
 * history containing tool_results in their request bodies: letting them into the consuming map would steal anchors, and those rows
 * would silently vanish when bypass is hidden. Un-joined events (lifecycle, parallel agents falling in the window) interleave by time with a subdued marker. */
/** Ordering principle (settled after a three-agent analysis + validation on real data): **one merged timeline per container**.
 * Each event's sort key k = joined ? min(own time, consuming request start - 1ms) : own time —
 * in measured data every joined event's disk-write time preceded its consuming request (5 sessions, 0 exceptions), so the clamp almost never fires
 * and display order = real time order; if a recorder's disk write ever lags past the consuming request, the clamp preserves causality
 * (the result was produced before the request) and a lagMs marker discloses it explicitly. The old scheme "bucket-positioned" joined events
 * before their consuming request, overtaking later bypass/timed rows (display order changed with the bypass toggle) — abandoned.
 * Container attribution: joined events follow their consuming request's container (root stream or an agent group); un-joined ones go to the root stream.
 * Same-millisecond ties sort stably by original scan order (server already sorts by disk-write order). */
function hookNarrativeIndex(reqs) {
  const evs = (state.hooks && state.hooks.events) || [];
  if (!evs.length) return null;
  const consuming = new Map(); // tuid -> the request consuming that tool_result
  for (const r of reqs) {
    if (r.kind !== 'messages' || isAux(r)) continue;
    for (const t of r.newTuids || []) if (!consuming.has(t)) consuming.set(t, r);
  }
  const byContainer = new Map(); // '_root' | agentKey -> [entry]
  evs.forEach((e, i) => {
    const r = e.tuid ? consuming.get(e.tuid) : null;
    const entry = { e, i, joined: !!r, k: e.tsMs };
    let container = '_root';
    if (r) {
      if (e.tsMs >= r.ts) { entry.k = r.ts - 1; entry.lagMs = e.tsMs - r.ts; }
      if (r.agentKey) container = r.agentKey;
    }
    if (!byContainer.has(container)) byContainer.set(container, []);
    byContainer.get(container).push(entry);
  });
  for (const arr of byContainer.values()) arr.sort((a, b) => a.k - b.k || a.i - b.i);
  return byContainer;
}

/** One hook narrative row in the lineage (supporting cast): **one real event per row**, event name first (in its class color,
 * the row's sole color carrier), tool name second, summary subdued (Pre = tool_input, Post = tool_response;
 * the server projection already picks the most informative real field values); indentation + small monospace + low row opacity keep it
 * distinguishable from request rows at a glance without stealing the show. Pairing products are annotations only: durMs right-aligns on the Post row
 * to the request duration column, waitMs becomes a badge on the Pre row. Click to expand **this event's** full payload (lazy-loaded). */
function hookNarrRow(entry) {
  const e = entry.e;
  const isFail = e.ev === 'PostToolUseFailure';
  const isToolEv = e.ev === 'PreToolUse' || e.ev === 'PostToolUse' || e.ev === 'PostToolUseFailure' || e.ev === 'PermissionRequest';
  const tip = [(HOOK_EV_GLOSS[e.ev] || e.ev)];
  if (isToolEv) tip.push(entry.joined
    ? '✓ tool_use_id matches the request consuming its tool_result (join proves attribution)'
    : '⚠ No join evidence — placed by time only (may belong to a parallel agent); judge for yourself');
  if (entry.lagMs != null) tip.push('⚠ Recorder disk write landed ' + fmtMs(entry.lagMs) + ' after the consuming request started'
    + ' — display position follows causality (the result was produced before the request); the timestamp is the true disk-write time');
  tip.push('time ' + fmtTime(e.tsMs), 'Click to expand this event\'s full payload');
  const li = el('li', {
    class: 'hk-row' + (isFail ? ' hk-fail' : '') + (isToolEv && !entry.joined ? ' hk-unjoined' : ''),
    title: tip.join('\n'),
    onclick: ev2 => { ev2.stopPropagation(); toggleHookDet(li, e); },
  });
  li.append(el('span', { class: 'hk-ev', style: 'color:' + hookColor(e.ev) }, e.ev));
  if (e.tool) li.append(el('span', { class: 'hk-tool' }, e.tool));
  li.append(el('span', { class: 'hk-sum' }, e.sum || ''));
  if (isToolEv && !entry.joined) li.append(el('span', { class: 'hk-mark' }, '≈time?'));
  if (entry.lagMs != null) li.append(el('span', { class: 'hk-mark', title: 'Recorder disk write landed after the consuming request started — ordered by join causal evidence' }, 'disk +' + fmtMs(entry.lagMs)));
  if (e.waitMs != null) li.append(el('span', { class: 'hk-chip wait', title: 'PermissionRequest → PreToolUse permission wait (pairing annotation)' }, 'wait ' + fmtMs(e.waitMs)));
  li.append(e.durMs != null
    ? el('span', { class: 'hk-dur' + (isFail ? ' fail' : ''), title: 'PreToolUse → ' + e.ev + ' measured execution time (pairing annotation)' }, fmtMs(e.durMs))
    : el('span', { class: 'hk-time' }, fmtTime(e.tsMs)));
  return li;
}

/** The detail pane's "Hooks breakdown" — attribution summary only, no event listing (the chronicle duty moved to the lineage narrative rows).
 *
 * gap = permission wait + net tool execution + harness residual. The first two come from join-attributed hook spans
 * (tool_use_id matching this request's newTuids — the same evidence the lineage uses); residual = gap − span union,
 * i.e. harness overhead like message assembly / disk writes / process scheduling — worth chasing when unusually large.
 * Union dedup: with parallel execution the net totals can exceed wall clock; computing the residual against the union is the honest way.
 * Bypass requests consume no hook events, so the block never appears; the gap window reuses the chain-parent computation (d.gap). */
function hooksGapBlock(d) {
  const events = state.hooks && state.hooks.events;
  if (!events || !events.length) return null;
  if (d.kind !== 'messages') return null;
  if (d.purpose && d.purpose !== 'main') return null;
  const reqs = (state.session && state.session.requests) || [];
  const me = reqs.find(r => r.id === d.id);
  if (!me) return null;
  const t1 = me.ts;
  const ownTuids = new Set(me.newTuids || []);
  if (!ownTuids.size) return null; // requests carrying no tool_results back (user-input driven) have no attributable execution

  let t0 = null;
  if (d.gap && d.gap.ms != null) t0 = t1 - d.gap.ms;
  else {
    let prev = -Infinity;
    for (const r of reqs) if (r.id !== me.id && (r.end || r.ts) <= t1) prev = Math.max(prev, r.end || r.ts);
    if (isFinite(prev)) t0 = prev;
  }

  // Join-attributed spans: execution (Post.durMs) and permission wait (Pre.waitMs)
  const execs = [], waits = [];
  for (const e of events) {
    if (!e.tuid || !ownTuids.has(e.tuid)) continue;
    // compact/resend addition ranges replay historical tool_results — those executions happened in earlier gaps; the time window filters them out
    if (t0 != null && (e.tsMs > t1 + 2000 || e.tsMs < t0 - 2000)) continue;
    if ((e.ev === 'PostToolUse' || e.ev === 'PostToolUseFailure') && e.durMs != null) execs.push(e);
    else if (e.ev === 'PreToolUse' && e.waitMs != null) waits.push(e);
  }
  if (!execs.length && !waits.length) return null;

  const execMs = execs.reduce((s, e) => s + e.durMs, 0);
  const waitMs = waits.reduce((s, e) => s + e.waitMs, 0);
  // Span union (execution + wait) — the honest basis for the residual
  const ivs = [
    ...execs.map(e => [e.tsMs - e.durMs, e.tsMs]),
    ...waits.map(e => [e.tsMs - e.waitMs, e.tsMs]),
  ].sort((a, b) => a[0] - b[0]);
  let covered = 0, curS = null, curE = null;
  for (const [s, en] of ivs) {
    if (curE == null || s > curE) { if (curE != null) covered += curE - curS; curS = s; curE = en; }
    else curE = Math.max(curE, en);
  }
  if (curE != null) covered += curE - curS;
  const gap = t0 != null ? Math.max(0, t1 - t0) : null;
  const residual = gap != null ? Math.max(0, gap - covered) : null;
  const parallel = gap != null && execMs + waitMs > gap * 1.02; // parallel execution: totals exceed wall clock

  // Per-tool summary (failures counted separately)
  const byTool = new Map();
  for (const e of execs) {
    const k = e.tool || '?';
    const t = byTool.get(k) || { ms: 0, n: 0, fail: 0 };
    t.ms += e.durMs; t.n++;
    if (e.ev === 'PostToolUseFailure') t.fail++;
    byTool.set(k, t);
  }

  const wrap = el('div', { class: 'hooks-gap' });
  wrap.append(el('div', {
    class: 'hg-head',
    title: 'Attribution basis: hook pairing spans whose tool_use_id matches a tool_result newly carried by this request (join proof)\n' +
      'harness residual = gap − union of measured spans (message assembly / disk writes / process scheduling overhead)\n' +
      'The per-event chronicle lives in the lineage\'s hook narrative rows on the left (Hooks toggle)',
  },
    el('b', null, 'Hooks breakdown'),
    gap != null ? el('span', null, ' · gap ', el('b', null, fmtMs(gap)), ' =') : el('span', null, ' ·'),
    waitMs ? el('span', { class: 'hg-chip wait' }, 'permission wait ' + fmtMs(waitMs)) : null,
    el('span', { class: 'hg-chip exec' }, 'net tool exec ' + fmtMs(execMs)),
    residual != null ? el('span', { class: 'hg-chip rest', title: 'gap − union of measured spans' }, 'harness ' + fmtMs(residual)) : null,
    parallel ? el('span', { class: 'hg-conc-note', title: 'Measured totals exceed the gap wall clock — parallel execution present (residual already computed against the span union)' }, ' parallel') : null,
  ));

  // Breakdown bar: a 100% bar as wide as the gap — wait / per-tool execution / residual
  if (gap != null && gap > 0) {
    const bar = el('div', { class: 'hg-bill-bar' });
    const seg = (ms, cls, label) => {
      if (ms <= 0) return;
      const w = Math.min(100, ms / gap * 100);
      if (w < 0.4) return;
      bar.append(el('i', { class: cls, style: 'width:' + w + '%', title: label + ' ' + fmtMs(ms) }));
    };
    seg(waitMs, 'seg-wait', 'permission wait');
    for (const [name, t] of byTool) seg(t.ms, t.fail ? 'seg-fail' : 'seg-exec', name);
    seg(residual, 'seg-rest', 'harness residual');
    wrap.append(bar);
  }

  // Per-tool chips (clicking a tool name goes nowhere — the chronicle rows live in the lineage)
  const chips = [...byTool.entries()].sort((a, b) => b[1].ms - a[1].ms).map(([name, t]) =>
    el('span', { class: 'hg-tool-chip' + (t.fail ? ' fail' : '') },
      name + (t.n > 1 ? ' ×' + t.n : '') + ' ' + fmtMs(t.ms) + (t.fail ? ' ✗' : '')));
  if (chips.length) wrap.append(el('div', { class: 'hg-tools' }, chips));
  return wrap;
}

const hooksDetCache = new Map(); // "f:o" -> full record (the full payload shown when an event row expands)

/** Expand a hook row's full raw record. When evs is an array, show each record (an exec row is the paired presentation
 * of two real records, Pre + Post — only the presentation is collapsed; expansion must give both, neither may be unreachable). */
async function toggleHookDet(row, evs) {
  const list = (Array.isArray(evs) ? evs : [evs]).filter(Boolean);
  const next = row.nextElementSibling;
  if (next && next.classList.contains('hg-det')) { next.remove(); return; }
  // Container follows the host: a div row in the detail pane, an li row in the lineage (a legal child of ul)
  const box = el(row.tagName === 'LI' ? 'li' : 'div', { class: 'hg-det' }, 'Loading…');
  row.after(box);
  const parts = [];
  for (const ev of list) {
    const k = ev.f + ':' + ev.o;
    let rec = hooksDetCache.get(k);
    if (!rec) {
      try {
        rec = await getJSON('/__hooks/detail?f=' + encodeURIComponent(ev.f) + '&o=' + ev.o + '&l=' + ev.l);
        hooksDetCache.set(k, rec);
      } catch (e) { rec = { error: String(e) }; }
    }
    parts.push({ ev, rec });
  }
  clear(box);
  for (const { ev, rec } of parts) {
    if (parts.length > 1) box.append(el('div', { class: 'hg-det-head' },
      el('span', { style: 'color:' + hookColor(ev.ev) }, ev.ev), ' · ' + fmtTime(ev.tsMs)));
    box.append(jsonPre(rec));
  }
}

function renderDetail() {
  const pane = document.getElementById('detail-pane');
  const scrollY = pane.scrollTop; // in-place refresh (live updates / expand-collapse / raw-format toggle) keeps the reading position
  const d = state.detail;
  hideTooltip();
  // In-place redraw of the same request + same view (content genuinely changed: streaming in progress / spawned agents arriving):
  // record which long-content items are expanded and restore after the rebuild — these lists only append at the tail, so leading indices are stable
  const viewKey = d ? [d.id, state.detailTab, state.rawBlocks, state.sharedOpen].join('|') : '';
  const expandedIdx = [];
  if (viewKey && viewKey === lastDetailViewKey) {
    pane.querySelectorAll('.expand-btn').forEach((b, i) => { if (b.textContent === 'Collapse') expandedIdx.push(i); });
  }
  lastDetailViewKey = viewKey;
  clear(pane);
  if (!d) return;
  pane.classList.add('open');

  const head = el('div', { class: 'detail-head' });
  head.append(el('div', { class: 'row1' },
    el('h3', null, (d.seq ? '#' + d.seq + ' · ' : '') + (d.kind === 'messages' ? 'Inference request' : d.kind)),
    el('span', { class: 'chip' }, el('span', { class: 'model-dot', style: `background:${modelColor(d.model)}` }), modelShort(d.model)),
    d.agent ? el('span', { class: 'chip', title: 'This request was made by an agent' + (d.agent.agentId ? ' (agent-id ' + d.agent.agentId + ')' : '') }, '⊂ ' + truncLabel(d.agent.label, 24)) : null,
    !d.agent && d.cc && d.cc.subagent ? el('span', { class: 'chip', title: 'The system first-line billing metadata says cc_is_subagent=true, but it could not be attributed to a specific agent' }, 'subagent') : null,
    d.purpose && d.purpose !== 'main' ? el('span', { class: 'chip', title: 'Background bypass call' }, PURPOSE_LABEL[d.purpose] || d.purpose) : null,
    d.stream ? el('span', { class: 'chip' }, 'SSE streaming') : null,
    d.pending ? el('span', { class: 'chip' }, 'running…') : el('span', { class: 'chip' + (d.status >= 400 ? ' err' : '') }, 'HTTP ' + d.status),
    d.aborted ? el('span', { class: 'chip err', title: 'Aborted client-side; below is the partial response received before the interrupt' }, 'aborted') : null,
    transcriptSlot(d),
    el('button', { class: 'btn close', onclick: closeDetail }, 'Close ✕'),
  ));

  const dur = d.timing && d.timing.end ? d.timing.end - d.timing.start : null;
  const ttfb = d.timing && d.timing.firstByte ? d.timing.firstByte - d.timing.start : null;
  const phSpans = phaseParts(d.phases).map(s => {
    const i = s.lastIndexOf(' ');
    return el('span', { title: 'Streaming generation time for this block type (computed from SSE event timing)' }, s.slice(0, i) + ' ', el('b', null, s.slice(i + 1)));
  });
  head.append(el('div', { class: 'meta' },
    el('span', null, fmtTime(d.ts)),
    el('span', null, 'duration ', el('b', null, fmtMs(dur))),
    ttfb != null ? el('span', null, 'first byte ', el('b', null, fmtMs(ttfb))) : null,
    ...phSpans,
    d.stallMs ? el('span', { title: 'Longest interval between adjacent SSE events in the streaming response (a generation stall)' }, 'longest stall ', el('b', null, fmtMs(d.stallMs))) : null,
    d.response && d.response.stop_reason ? el('span', null, 'stop: ', el('b', null, d.response.stop_reason)) : null,
    el('span', null, 'request body ', el('b', null, fmtBytes(d.reqSize))),
    el('span', null, 'response ', el('b', null, fmtBytes(d.resSize))),
    d.sse ? el('span', null, 'SSE events ', el('b', null, String(d.sse.count))) : null,
  ));

  // Request-parameter line: what Claude Code chose for this call (sampling params / thinking config / beta capabilities / CLI version)
  if (d.kind === 'messages') {
    const br = d.bodyRest || {};
    const params = [];
    if (br.max_tokens != null) params.push(['max_tokens', fmtTok(br.max_tokens)]);
    if (br.thinking && br.thinking.type) {
      params.push(['thinking', br.thinking.type + (br.thinking.budget_tokens ? ' · ' + fmtTok(br.thinking.budget_tokens) : '')]);
    }
    if (br.temperature != null) params.push(['temperature', String(br.temperature)]);
    if (br.top_p != null) params.push(['top_p', String(br.top_p)]);
    if (br.top_k != null) params.push(['top_k', String(br.top_k)]);
    if (Array.isArray(br.stop_sequences) && br.stop_sequences.length) params.push(['stop_seq', String(br.stop_sequences.length)]);
    if (br.context_management) params.push(['context_mgmt', 'on']);
    const beta = (d.reqHeaders && d.reqHeaders['anthropic-beta']) || '';
    if (params.length || beta) {
      head.append(el('div', { class: 'meta param-line' },
        ...params.map(([k, v]) => el('span', null, k + ' ', el('b', null, v))),
        beta ? el('span', { title: beta.split(',').join('\n') }, 'beta ', el('b', null, String(beta.split(',').length))) : null,
        d.cc && d.cc.version ? el('span', null, 'cli ', el('b', null, d.cc.version)) : null,
      ));
    }
  }

  if (d.usage) {
    head.append(el('div', { class: 'mini-usage' },
      miniUsage('cache read', d.usage.cacheRead, 'var(--ctx-cache-read)'),
      miniUsage('cache write', d.usage.cacheWrite, 'var(--ctx-cache-write)'),
      miniUsage('new input', d.usage.input, 'var(--ctx-fresh)'),
      miniUsage('output', d.usage.output, 'var(--ctx-output)'),
    ));
  }

  if (d.agent) {
    const a = d.agent;
    const note = el('div', { class: 'relation-note' });
    note.append('Agent: ', el('b', null, a.label || '?'));
    if (a.type || a.toolName) note.append(` (${[a.type, a.toolName && a.toolName + ' tool'].filter(Boolean).join(' · ')})`);
    if (a.spawnSeq) note.append(' · spawned by ', el('a', { onclick: () => openDetail(a.spawnReqId) }, '#' + a.spawnSeq));
    note.append(` · ${a.count} requests total`);
    head.append(note);
  }
  if (d.spawnedAgents && d.spawnedAgents.length) {
    const note = el('div', { class: 'relation-note' });
    note.append(`This request spawned ${d.spawnedAgents.length} agents: `);
    d.spawnedAgents.forEach((a, i) => {
      if (i) note.append(' · ');
      note.append(el('a', { onclick: () => openDetail(a.firstReqId) }, '⊂ ' + truncLabel(a.label, 24)));
    });
    head.append(note);
  }

  if (d.kind === 'messages' || d.kind === 'count_tokens') {
    const note = el('div', { class: 'relation-note' });
    if (d.parentId) {
      note.append('Relation: ', el('b', null, REL_LABEL[d.relation] || d.relation), ' from ',
        el('a', { onclick: () => openDetail(d.parentId) }, '#' + (d.parentSeq || '?')),
        ` · shared prefix ${d.sharedPrefix} messages`);
      if (d.relation === 'extends') note.append(` · ${d.messages.length - d.sharedPrefix} added`);
      if (d.removedCount) note.append(` · ${d.removedCount} dropped (history rewritten)`);
      note.append(' · system ' + (d.systemChanged ? 'changed' : 'unchanged'), ' · tools ' + (d.toolsChanged ? 'changed' : 'unchanged'));
      if (d.gap) {
        const what = d.gap.kind === 'tools' ? 'local tool execution' + (d.gap.tools ? ': ' + d.gap.tools.join(', ') : '')
          : d.gap.kind === 'user' ? 'waiting for user input'
          : d.gap.kind === 'retry' ? 'retry backoff' : 'idle';
        note.append(el('br'), fmtMs(d.gap.ms), ' after the previous request ended', ` (${what})`);
      }
    } else {
      note.append('Relation: ', el('b', null,
        d.agent ? 'agent context origin (a brand-new context, independent of the main chain)'
          : d.relation === 'branch' ? 'new branch (no shared prefix with existing chains, e.g. subagent/new task)' : 'session origin'));
    }
    head.append(note);
  }
  if (d.cacheBreak) {
    const cb = d.cacheBreak;
    head.append(el('div', { class: 'relation-note warn-note' },
      '⚡ Cache break: ', breakReason(cb),
      '. Previous request had ', el('b', null, fmtTok(cb.parentCached)),
      ' cached, only ', el('b', null, fmtTok(cb.parentCached - cb.lost)),
      ' hit this time, ', el('b', null, fmtTok(cb.lost)),
      ' tokens rewritten — cache writes bill at 1.25x while cache reads are just 0.1x, so this cost about $' + breakWasteCost(d.model, cb.lost).toFixed(3) + ' extra'));
  }
  if (d.responseError) {
    head.append(el('div', { class: 'relation-note', style: 'background:color-mix(in srgb, var(--critical) 8%, transparent);border-color:color-mix(in srgb, var(--critical) 30%, transparent)' },
      'API error: ', el('b', null, d.responseError.type || 'error'), ' — ', d.responseError.message || ''));
  }
  if (d.error) {
    head.append(el('div', { class: 'relation-note', style: 'background:color-mix(in srgb, var(--critical) 8%, transparent);border-color:color-mix(in srgb, var(--critical) 30%, transparent)' },
      'Proxy error: ', d.error));
  }
  const hg = hooksGapBlock(d); // hook-event chronicle: what happened locally in the gap before this request
  if (hg) head.append(hg);
  pane.append(head);

  // ---- Tabs
  const tabNames = [];
  if (d.messages) tabNames.push('Messages');
  tabNames.push('Response');
  if (d.system != null) tabNames.push('System');
  if (d.tools) tabNames.push('Tools (' + d.tools.length + ')');
  if (d.sse) tabNames.push('SSE events');
  tabNames.push('Raw');
  if (!tabNames.some(t => t.startsWith(state.detailTab.split(' ')[0]))) state.detailTab = tabNames[0];

  const tabs = el('div', { class: 'tabs' });
  for (const name of tabNames) {
    const isOn = name.split(' ')[0] === state.detailTab.split(' ')[0];
    tabs.append(el('button', {
      class: isOn ? 'on' : '',
      onclick: () => { state.detailTab = name; renderDetail(); pane.scrollTop = 0; }, // back to the top on tab switch
    }, name));
  }
  // Content-block rendering toggle: reading view (markdown / image preview / key-value params) ⇄ raw format
  tabs.append(el('span', { class: 'spacer' }));
  tabs.append(el('button', {
    class: 'btn raw-toggle' + (state.rawBlocks ? ' on' : ''),
    title: 'Toggle how message content is shown: reading view (Markdown rendering, image previews, tool params as key-value) ⇄ raw format',
    onclick: () => { state.rawBlocks = !state.rawBlocks; renderDetail(); },
  }, state.rawBlocks ? 'Raw format ✓' : 'Raw format'));
  pane.append(tabs);

  const body = el('div', { class: 'tab-body' });
  const cur = state.detailTab.split(' ')[0];
  if (cur === 'Messages') body.append(tabMessages(d));
  else if (cur === 'Response') body.append(tabResponse(d));
  else if (cur === 'System') body.append(tabSystem(d));
  else if (cur === 'Tools') body.append(tabTools(d));
  else if (cur === 'SSE') body.append(tabSSE(d));
  else body.append(tabRaw(d));
  pane.append(body);
  if (expandedIdx.length) {
    const btns = pane.querySelectorAll('.expand-btn');
    for (const i of expandedIdx) if (btns[i] && btns[i].textContent !== 'Collapse') btns[i].click();
  }
  pane.scrollTop = scrollY;
}

function miniUsage(label, v, color) {
  return el('div', { class: 'mu' },
    el('div', { class: 'l' }, el('i', { style: `background:${color}` }), label),
    el('div', { class: 'v' }, fmtTok(v)));
}

// ---- Messages tab: shared-prefix collapse + addition highlight + cache breakpoints

function tabMessages(d) {
  const box = el('div');
  if (!d.messages || !d.messages.length) { box.append(el('div', { class: 'note' }, 'No messages')); return box; }

  const markers = d.cacheMarkers || [];
  const markerAt = (i) => markers.filter(m => m.loc === 'messages' && m.i === i);

  const sharedCount = d.sharedPrefix || 0;
  if (sharedCount > 0) {
    box.append(el('div', {
      class: 'collapse-shared',
      onclick: () => { state.sharedOpen = !state.sharedOpen; renderDetail(); },
    }, (state.sharedOpen ? '▾ Hide' : '▸ Show') + ` the first ${sharedCount} messages identical to #${d.parentSeq || '?'} (repeated history, stored deduplicated by content hash)`));
  }

  d.messages.forEach((m, i) => {
    if (m.shared && !state.sharedOpen) return;
    box.append(renderMessage(m.msg, {
      shared: m.shared, isNew: !m.shared && sharedCount > 0, hash: m.hash, index: i,
    }));
    for (const mk of markerAt(i)) {
      box.append(el('div', { class: 'cache-flag' }, `⚑ cache_control breakpoint (${(mk.cc && mk.cc.type) || 'ephemeral'}${mk.cc && mk.cc.ttl ? ', ttl ' + mk.cc.ttl : ''})${mk.b != null ? ' · block ' + mk.b : ''}`));
    }
  });
  return box;
}

function renderMessage(msg, opts) {
  opts = opts || {};
  const role = msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system' ? msg.role : 'other';
  const wrap = el('div', { class: 'msg role-' + role + (opts.shared ? ' shared' : '') + (opts.isNew ? ' new' : '') });
  wrap.append(el('div', { class: 'msg-head' },
    el('span', { class: 'role-dot' }),
    el('span', { class: 'role ' + (msg.role || '') }, msg.role || '?'),
    opts.isNew ? el('span', { class: 'newtag' }, 'NEW') : null,
    opts.index != null ? el('span', null, 'msg[' + opts.index + ']') : null,
    opts.hash ? el('span', { class: 'hash', title: 'Content hash (dedup storage key)' }, opts.hash.slice(0, 10)) : null,
  ));
  const blocks = el('div', { class: 'blocks' });
  const content = msg.content;
  if (typeof content === 'string') blocks.append(renderBlock({ type: 'text', text: content }));
  else if (Array.isArray(content)) for (const b of content) blocks.append(renderBlock(b));
  wrap.append(blocks);
  return wrap;
}

function renderBlock(b) {
  if (!b || typeof b !== 'object') return renderTextBlock('?', String(b));
  const raw = state.rawBlocks;
  switch (b.type) {
    case 'text': {
      // btag shows only the real API-layer type field; markdown rendering is a platform preview capability, never mixed into data labels
      if (raw) return renderTextBlock('text', b.text || '');
      const box = el('div', { class: 'block block-text' });
      box.append(el('span', { class: 'btag text' }, 'text'));
      const t = b.text || '';
      box.append(t ? clampNode(renderMarkdown(t), t.length) : el('div', { class: 'note' }, '(empty string)'));
      return box;
    }
    case 'thinking': {
      if (raw) return renderTextBlock('thinking', b.thinking || '');
      const box = el('div', { class: 'block thinking-block' });
      box.append(el('span', { class: 'btag thinking' }, 'thinking'));
      const t = b.thinking || '';
      box.append(t ? clampNode(renderMarkdown(t), t.length) : el('div', { class: 'note' }, '(empty string)'));
      return box;
    }
    case 'redacted_thinking': return renderTextBlock('thinking', '[redacted]');
    case 'tool_use': {
      const box = el('div', { class: 'block block-tool_use' });
      box.append(el('span', { class: 'btag tool_use' }, 'tool_use · ' + (b.name || '?') + (b.id ? ' · ' + b.id : '')));
      box.append(raw ? jsonPre(b.input) : toolInputView(b.input));
      return box;
    }
    case 'tool_result': {
      const box = el('div', { class: 'block block-tool_result' + (b.is_error ? ' block-tool_error' : '') });
      box.append(el('span', { class: 'btag ' + (b.is_error ? 'tool_result_error' : 'tool_result') },
        'tool_result' + (b.is_error ? ' · ERROR' : '') + (b.tool_use_id ? ' · ' + b.tool_use_id : '')));
      const c = b.content;
      if (typeof c === 'string') box.append(clampPre(c));
      else if (Array.isArray(c)) for (const cb of c) {
        if (cb && cb.type === 'text') box.append(clampPre(cb.text || ''));
        else if (cb && cb.type === 'image' && !raw) box.append(imageView(cb));
        else box.append(jsonPre(cb));
      }
      return box;
    }
    case 'image': {
      if (raw) {
        const s = b.source || {};
        const obj = { ...b, source: { ...s, data: s.data ? s.data.slice(0, 64) + `…(${s.data.length} base64 chars total)` : s.data } };
        return el('div', { class: 'block' }, el('span', { class: 'btag image' }, 'image'), jsonPre(obj));
      }
      return imageView(b);
    }
    case 'document': return renderTextBlock('document', '[document]');
    default: {
      const box = el('div', { class: 'block' });
      box.append(el('span', { class: 'btag' }, b.type || '?'));
      box.append(jsonPre(b));
      return box;
    }
  }
}

function renderTextBlock(tag, text) {
  const box = el('div', { class: 'block' });
  box.append(el('span', { class: 'btag ' + tag }, tag));
  box.append(clampPre(text));
  return box;
}

// ---------------------------------------------------------------- Markdown rendering (zero dependencies, pure DOM construction — no injection)

// The rendered view = styled source (developer-oriented): formatting applies while **all source markers are kept** (dimmed monospace);
// bold/italic/strikethrough/inline code/link URLs all map back to the API original at a glance — copy what you see, get the original
const mdMark = s => el('span', { class: 'mdmark' }, s);

function mdInline(text) {
  const out = [];
  // Split out inline code first (no parsing inside), then parse links/bold/italic/strikethrough in the rest
  for (const part of String(text).split(/(`[^`\n]*`)/)) {
    if (!part) continue;
    if (part.length > 1 && part[0] === '`' && part[part.length - 1] === '`') {
      out.push(el('code', { class: 'mdc' }, mdMark('`'), part.slice(1, -1), mdMark('`')));
      continue;
    }
    // Beyond markdown syntax, two high-value content kinds are also recognized (zero-ambiguity patterns only, no guessing):
    // XML-style tags — Claude prompt engineering delimits sections with pseudo-XML; they are the prompt's structural skeleton;
    // bare URLs — https:// prefixes have zero false positives, linkified as clickable. Paths/emails skipped (heuristics misfire too often)
    const re = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|(^|[\s（(【>])\*([^*\n]+)\*(?=[\s）)】.,;:!?、。，；：！？]|$)|~~([^~\n]+)~~|(<\/?[a-zA-Z][\w.-]*(?:\s[^<>\n]*?)?\/?>)|(https?:\/\/[^\s<>）)】」，。；！？"']+)/g;
    let last = 0, m;
    while ((m = re.exec(part))) {
      if (m.index > last) out.push(part.slice(last, m.index));
      if (m[2]) {
        out.push(mdMark('['), el('a', { href: m[2], target: '_blank', rel: 'noopener' }, m[1]),
          mdMark(']('), el('span', { class: 'mdmark mdurl' }, m[2]), mdMark(')'));
      } else if (m[3] != null) {
        out.push(mdMark('**'), el('strong', null, m[3]), mdMark('**'));
      } else if (m[5] != null) {
        if (m[4]) out.push(m[4]);
        out.push(mdMark('*'), el('em', null, m[5]), mdMark('*'));
      } else if (m[6] != null) {
        out.push(mdMark('~~'), el('s', null, m[6]), mdMark('~~'));
      } else if (m[7] != null) {
        out.push(el('span', { class: 'mdtag' }, m[7]));
      } else if (m[8] != null) {
        out.push(el('a', { href: m[8], target: '_blank', rel: 'noopener' }, m[8]));
      }
      last = re.lastIndex;
    }
    if (last < part.length) out.push(part.slice(last));
  }
  return out;
}

function renderMarkdown(text) {
  const root = el('div', { class: 'md' });
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const para = [];
  const flushPara = () => {
    if (!para.length) return;
    root.append(el('p', null, ...mdInline(para.join('\n'))));
    para.length = 0;
  };
  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  while (i < lines.length) {
    const ln = lines[i];

    // Code fences — fence lines kept verbatim (```lang and the closing ```, dimmed)
    const fence = ln.match(/^\s*```(.*)$/);
    if (fence) {
      flushPara();
      const buf = [];
      let closeLn = null;
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      if (i < lines.length) closeLn = lines[i++].trim(); // closing fence (source may be unclosed)
      root.append(el('div', { class: 'mdpre-wrap' },
        el('div', { class: 'mdmark md-fence' }, ln.trim()),
        el('pre', { class: 'mdpre' }, buf.join('\n')),
        closeLn != null ? el('div', { class: 'mdmark md-fence' }, closeLn) : null));
      continue;
    }
    // Headings — keep the original # markers (dim monospace) so developers map back to the source hierarchy at a glance
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      root.append(el('h' + Math.min(h[1].length + 3, 6), { class: 'mdh' },
        mdMark(h[1] + ' '), ...mdInline(h[2])));
      i++; continue;
    }
    // Horizontal rule — source chars dimmed + an extending line
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) {
      flushPara();
      root.append(el('div', { class: 'md-hr' }, mdMark(ln.trim())));
      i++; continue;
    }
    // Blockquotes — each line's > prefix kept verbatim (rendered line by line, not merged)
    if (/^\s*>\s?/.test(ln)) {
      flushPara();
      const quote = el('blockquote');
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        const qm = lines[i].match(/^(\s*>\s?)(.*)$/);
        quote.append(el('div', { class: 'md-qline' }, mdMark(qm[1]), ...mdInline(qm[2])));
        i++;
      }
      root.append(quote);
      continue;
    }
    // Lists (two indent levels) — list markers use the source's own characters (CSS auto-numbering would rewrite the source's numbers — a lie)
    if (LIST_RE.test(ln)) {
      flushPara();
      const items = [];
      while (i < lines.length && (LIST_RE.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        const lm = lines[i].match(LIST_RE);
        if (lm) items.push({ indent: lm[1].length, marker: lm[2], text: lm[3] });
        else if (items.length) items[items.length - 1].text += '\n' + lines[i].trim(); // continuation line
        i++;
      }
      const makeList = arr => {
        const list = el('ul', { class: 'md-list' });
        let k = 0;
        while (k < arr.length) {
          const it = arr[k];
          const li = el('li', null, mdMark(it.marker + ' '), ...mdInline(it.text));
          const kids = [];
          k++;
          while (k < arr.length && arr[k].indent > it.indent) kids.push(arr[k++]);
          if (kids.length) li.append(makeList(kids));
          list.append(li);
        }
        return list;
      };
      root.append(makeList(items));
      continue;
    }
    // Tables
    if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i + 1])) {
      flushPara();
      const cells = s => s.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const table = el('table', { class: 'mdtable' });
      table.append(el('thead', null, el('tr', null, ...cells(ln).map(c => el('th', null, ...mdInline(c))))));
      i += 2;
      const tbody = el('tbody');
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tbody.append(el('tr', null, ...cells(lines[i]).map(c => el('td', null, ...mdInline(c)))));
        i++;
      }
      table.append(tbody);
      root.append(table);
      continue;
    }
    // Blank line = paragraph boundary
    if (!ln.trim()) { flushPara(); i++; continue; }
    para.push(ln);
    i++;
  }
  flushPara();
  return root;
}

/** Long-content collapse (same interaction as clampPre, works on any node) */
function clampNode(node, charLen) {
  if (charLen <= 1500) return node;
  const holder = el('div');
  node.classList.add('clamp');
  const btn = el('button', {
    class: 'btn expand-btn',
    onclick: () => { node.classList.toggle('clamp'); btn.textContent = node.classList.contains('clamp') ? `Expand all (${charLen.toLocaleString()} chars)` : 'Collapse'; },
  }, `Expand all (${charLen.toLocaleString()} chars)`);
  holder.append(node, btn);
  return holder;
}

/** Key-value view of tool_use input — string fields shown readably instead of escaped JSON */
function toolInputView(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return jsonPre(input);
  const keys = Object.keys(input);
  if (!keys.length) return jsonPre(input); // an empty object is faithfully shown as {}
  const box = el('div', { class: 'tool-kv' });
  for (const k of keys) {
    const v = input[k];
    const row = el('div', { class: 'tkv-row' });
    row.append(el('span', { class: 'tkv-k' }, k));
    if (typeof v === 'string') {
      if (v.includes('\n') || v.length > 120) row.append(el('div', { class: 'tkv-block' }, clampPre(v)));
      else row.append(el('span', { class: 'tkv-v' }, v));
    } else if (v == null || typeof v === 'number' || typeof v === 'boolean') {
      row.append(el('span', { class: 'tkv-v tkv-lit' }, String(v)));
    } else {
      row.append(el('div', { class: 'tkv-block' }, jsonPre(v)));
    }
    box.append(row);
  }
  return box;
}

/** Fullscreen lightbox for large images (click the overlay or press Esc to close) */
function openLightbox(url) {
  const ov = el('div', { class: 'lightbox' });
  const img = el('img', { src: url, alt: 'image' });
  ov.append(img, el('div', { class: 'lightbox-hint' }, 'Click anywhere or press Esc to close'));
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  ov.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
}

/** Image block preview — click to open the fullscreen lightbox */
function imageView(b) {
  const src = b.source || {};
  let url = null;
  if (src.type === 'base64' && src.data) url = `data:${src.media_type || 'image/png'};base64,${src.data}`;
  else if (src.type === 'url' && /^https?:\/\//.test(src.url || '')) url = src.url;
  const box = el('div', { class: 'block block-image' });
  // The data tag carries only API-layer fields (type/media_type); size is derived and the action hint is platform UI — shown separately in a subdued style
  const sizeKB = src.data ? (src.data.length * 3 / 4 / 1024).toFixed(0) + ' KB' : '';
  box.append(
    el('span', { class: 'btag image' }, 'image · ' + (src.media_type || src.type || '?')),
    el('span', { class: 'ui-hint' }, (sizeKB ? '≈' + sizeKB + ' · ' : '') + 'click image to view fullscreen'),
  );
  if (!url) { box.append(el('div', { class: 'note' }, '(cannot preview: unknown image source format)')); return box; }
  const img = el('img', { class: 'img-preview', src: url, alt: 'image block', title: 'Click to view fullscreen' });
  img.addEventListener('click', () => openLightbox(url));
  box.append(img);
  return box;
}

/** Collapse shell for long pres (an "Expand all" button past the threshold) — shared by clampPre/jsonPre */
function clampWrap(pre, charLen) {
  if (charLen <= 800) return pre;
  const holder = el('div');
  pre.classList.add('clamp');
  const btn = el('button', {
    class: 'btn expand-btn',
    onclick: () => { pre.classList.toggle('clamp'); btn.textContent = pre.classList.contains('clamp') ? `Expand all (${charLen.toLocaleString()} chars)` : 'Collapse'; },
  }, `Expand all (${charLen.toLocaleString()} chars)`);
  holder.append(pre, btn);
  return holder;
}

function clampPre(text) {
  return clampWrap(el('pre', null, text), text.length);
}

// JSON syntax highlighting: a single-pass token scan into four classes —
// key (string followed by a colon) / string value / number / true|false|null. Punctuation and whitespace pass through in the base color.
// Used only for content known to be JSON; plain text (tool output etc.) is never guessed. Pure DOM textContent construction — no injection.
const JSON_TOK = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
function jsonHiPre(src) {
  const pre = el('pre', { class: 'json-hl' });
  const LIMIT = 300000; // color only the first 300K: big payloads don't spawn hundreds of thousands of nodes, yet the most-read opening stays colored
  const frag = document.createDocumentFragment();
  let last = 0, m;
  JSON_TOK.lastIndex = 0;
  while ((m = JSON_TOK.exec(src))) {
    if (m.index > LIMIT) break;
    if (m.index > last) frag.append(src.slice(last, m.index));
    if (m[1] !== undefined) {
      frag.append(el('span', { class: m[2] !== undefined ? 'jk' : 'js' }, m[1]));
      if (m[2] !== undefined) frag.append(m[2]);
    } else if (m[3] !== undefined) {
      frag.append(el('span', { class: 'jb' }, m[0]));
    } else {
      frag.append(el('span', { class: 'jn' }, m[0]));
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) frag.append(src.slice(last));
  pre.append(frag);
  return pre;
}

function jsonPre(v) {
  let s;
  try { s = JSON.stringify(v, null, 2); } catch { s = String(v); }
  if (s == null) s = 'null';
  return clampWrap(jsonHiPre(s), s.length);
}

// ---- Response tab

function tabResponse(d) {
  const box = el('div');
  const r = d.response;
  if (d.kind === 'count_tokens' && r) {
    box.append(el('div', { class: 'note' }, 'count_tokens result'));
    box.append(jsonPre(r));
    return box;
  }
  if (!r) {
    box.append(el('div', { class: 'note' }, d.responseText ? 'Non-JSON response:' : 'No response body'));
    if (d.responseText) box.append(clampPre(d.responseText));
    return box;
  }
  if (r.type === 'error') { box.append(jsonPre(r)); return box; }

  if (Array.isArray(r.content)) {
    for (const b of r.content) box.append(renderBlock(b));
  }
  const kv = el('div', { class: 'kv', style: 'margin-top:10px' });
  const pairs = [
    ['id', r.id], ['model', r.model], ['stop_reason', r.stop_reason], ['stop_sequence', r.stop_sequence],
  ];
  if (r.usage) for (const [k, v] of Object.entries(r.usage)) {
    if (v != null && typeof v !== 'object') pairs.push(['usage.' + k, v]);
  }
  for (const [k, v] of pairs) {
    if (v == null) continue;
    kv.append(el('div', null, el('span', { class: 'k' }, k), el('span', { class: 'v' }, String(v))));
  }
  box.append(kv);
  return box;
}

// ---- System / Tools (incl. diff against the parent request — revealing exactly what system injection / toolset changes contained)

function sysTextOf(sys) {
  if (sys == null) return '';
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) return sys.map(b => (b && b.text) || '').join('\n');
  return JSON.stringify(sys);
}

/** Line-level diff: trim the common prefix/suffix and show the change window in between (system changes are almost always local) */
function diffView(oldText, newText, oldLabel, newLabel) {
  const a = String(oldText).split('\n'), b = String(newText).split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const removed = a.slice(p, a.length - s), added = b.slice(p, b.length - s);
  const box = el('div', { class: 'diff-view' });
  box.append(el('div', { class: 'note' },
    `common prefix ${p} lines · common suffix ${s} lines · change window −${removed.length} / +${added.length} lines` +
    ' (prefix cache is invalidated from the first difference onward)'));
  if (!removed.length && !added.length) {
    box.append(el('div', { class: 'note' }, 'Text matches line by line — the difference may lie in block structure or non-text fields'));
    return box;
  }
  if (removed.length) box.append(el('div', { class: 'diff-block diff-del' },
    el('span', { class: 'diff-tag' }, '− ' + oldLabel), clampPre(removed.join('\n'))));
  if (added.length) box.append(el('div', { class: 'diff-block diff-add' },
    el('span', { class: 'diff-tag' }, '+ ' + newLabel), clampPre(added.join('\n'))));
  return box;
}

/** "Diff against parent" button: on click, fetch the parent request's detail and render the diff in place */
function diffButton(d, render) {
  const holder = el('div', { style: 'margin: 8px 0' });
  const btn = el('button', {
    class: 'btn',
    onclick: async () => {
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        const parent = await getJSON('/__lens/request/' + encodeURIComponent(d.parentId));
        btn.remove();
        holder.append(render(parent));
      } catch (e) {
        btn.textContent = 'Load failed: ' + e.message;
        btn.disabled = false;
      }
    },
  }, 'Diff against parent #' + (d.parentSeq || '?'));
  holder.append(btn);
  return holder;
}

function tabSystem(d) {
  const box = el('div');
  const sys = d.system;
  box.append(el('div', { class: 'note' },
    'hash ' + (d.systemHash || '—') + ' · ' + (d.parentId ? (d.systemChanged ? 'differs from the previous request (breaks the cached prefix!)' : 'identical to the previous request (prefix-cache friendly)') : 'first request in this chain')));
  if (d.systemChanged && d.parentId) {
    box.append(diffButton(d, parent =>
      diffView(sysTextOf(parent.system), sysTextOf(sys), 'parent #' + (d.parentSeq || '?'), 'this request #' + (d.seq || '?'))));
  }
  if (sys == null) { box.append(el('div', { class: 'note' }, 'No system')); return box; }
  if (typeof sys === 'string') { box.append(clampPre(sys)); return box; }
  const markers = (d.cacheMarkers || []).filter(m => m.loc === 'system');
  sys.forEach((blk, i) => {
    box.append(renderBlock(blk));
    if (markers.some(m => m.i === i)) box.append(el('div', { class: 'cache-flag' }, '⚑ cache_control breakpoint'));
  });
  return box;
}

function toolsDiffView(parent, d) {
  const keyOf = t => t.name || t.type || '?';
  const oldMap = new Map((parent.tools || []).map(t => [keyOf(t), JSON.stringify(t)]));
  const newMap = new Map((d.tools || []).map(t => [keyOf(t), JSON.stringify(t)]));
  const added = [...newMap.keys()].filter(k => !oldMap.has(k));
  const removed = [...oldMap.keys()].filter(k => !newMap.has(k));
  const changed = [...newMap.keys()].filter(k => oldMap.has(k) && oldMap.get(k) !== newMap.get(k));
  const box = el('div', { class: 'diff-view' });
  box.append(el('div', { class: 'note' },
    `parent ${oldMap.size} → this request ${newMap.size} (toolset hashes differ — tools sit before system in the cached prefix, so any change breaks the cache)`));
  for (const [tag, cls, names] of [['+ added', 'diff-add', added], ['− removed', 'diff-del', removed], ['≠ definition changed', 'diff-mod', changed]]) {
    if (names.length) box.append(el('div', { class: 'diff-block ' + cls },
      el('span', { class: 'diff-tag' }, tag + ' '), names.join(', ')));
  }
  if (!added.length && !removed.length && !changed.length) {
    box.append(el('div', { class: 'note' }, 'Tool names and definitions match one by one — the difference may be order alone (order breaks the cache too)'));
  }
  return box;
}

function tabTools(d) {
  const box = el('div');
  if (!d.tools || !d.tools.length) { box.append(el('div', { class: 'note' }, 'No tool definitions')); return box; }
  box.append(el('div', { class: 'note' },
    `${d.tools.length} tools · hash ${d.toolsHash || '—'} · ` +
    (d.parentId ? (d.toolsChanged ? 'differs from the previous request (breaks the cache!)' : 'identical to the previous request') : 'first request in this chain')));
  if (d.toolsChanged && d.parentId) {
    box.append(diffButton(d, parent => toolsDiffView(parent, d)));
  }
  const markers = (d.cacheMarkers || []).filter(m => m.loc === 'tools');
  d.tools.forEach((t, i) => {
    const det = el('details', { class: 'raw-sec' });
    const size = JSON.stringify(t).length;
    det.append(el('summary', null, `${t.name || t.type || '?'} `, el('span', { style: 'color:var(--ink-3)' }, `· ${fmtBytes(size)}${t.description ? ' · ' + t.description.slice(0, 80) : ''}`)));
    det.append(jsonHiPre(JSON.stringify(t, null, 2)));
    box.append(det);
    if (markers.some(m => m.i === i)) box.append(el('div', { class: 'cache-flag' }, '⚑ cache_control breakpoint'));
  });
  return box;
}

// ---- SSE events

function ssePreview(data) {
  if (!data || typeof data !== 'object') return String(data).slice(0, 120);
  switch (data.type) {
    case 'content_block_delta': {
      const dl = data.delta || {};
      if (dl.type === 'text_delta') return JSON.stringify(dl.text);
      if (dl.type === 'input_json_delta') return 'json: ' + JSON.stringify(dl.partial_json);
      if (dl.type === 'thinking_delta') return 'thinking: ' + JSON.stringify(dl.thinking);
      return dl.type || '';
    }
    case 'content_block_start': {
      const cb = data.content_block || {};
      return `index ${data.index} · ${cb.type}${cb.name ? ' · ' + cb.name : ''}`;
    }
    case 'content_block_stop': return 'index ' + data.index;
    case 'message_start': {
      const u = (data.message && data.message.usage) || {};
      return `input ${u.input_tokens ?? '?'} · cache_read ${u.cache_read_input_tokens ?? 0} · cache_write ${u.cache_creation_input_tokens ?? 0}`;
    }
    case 'message_delta': {
      const u = data.usage || {};
      return `${(data.delta && data.delta.stop_reason) || ''} · output ${u.output_tokens ?? '?'}`;
    }
    case 'error': return (data.error && data.error.message) || 'error';
    default: return '';
  }
}

// Block-type colors for the generation-dynamics curve (echoing the message view's btag hues)
const PHASE_COLOR = { thinking: 'var(--s5)', text: 'var(--s1)', tool_use: 'var(--s8)' };

/**
 * Generation-dynamics curve: x = time, y = cumulative output characters. Slope = generation speed, plateau = stall,
 * bottom color band = the content-block type currently generating (thinking/text/tool_use) —
 * "how long it thought before it started talking" is visible at a glance. Needs event timing (not drawn for old captures without t).
 */
function sseCurve(d) {
  const events = (d.sse && d.sse.events) || [];
  if (!events.some(e => typeof e.t === 'number')) return null;
  const pts = [{ t: 0, c: 0 }];
  const bands = [];              // {t0, t1, type} generation spans of content blocks
  const open = new Map();        // index -> {t0, type}
  let cum = 0, tMax = 0;
  for (const ev of events) {
    const t = typeof ev.t === 'number' ? ev.t : null;
    if (t == null) continue;
    tMax = Math.max(tMax, t);
    const dd = ev.data;
    if (!dd || typeof dd !== 'object') continue;
    if (dd.type === 'content_block_start') {
      open.set(dd.index, { t0: t, type: (dd.content_block && dd.content_block.type) || '?' });
    } else if (dd.type === 'content_block_stop') {
      const o = open.get(dd.index);
      if (o) { bands.push({ t0: o.t0, t1: t, type: o.type }); open.delete(dd.index); }
    } else if (dd.type === 'content_block_delta') {
      const dl = dd.delta || {};
      const s = dl.text || dl.thinking || dl.partial_json || '';
      if (s) { cum += s.length; pts.push({ t, c: cum }); }
    }
  }
  for (const o of open.values()) bands.push({ t0: o.t0, t1: tMax, type: o.type }); // blocks left unclosed by an abort
  if (pts.length < 3 || tMax <= 0 || !cum) return null;
  pts.push({ t: tMax, c: cum });

  const pane = document.getElementById('detail-pane');
  const W = Math.max(((pane && pane.clientWidth) || 600) - 44, 380);
  const padL = 46, padR = 8, plotH = 56;
  const bandY = 8 + plotH + 4;
  const H = bandY + 5 + 16;
  const x = t => padL + (t / tMax) * (W - padL - padR);
  const y = c => 8 + plotH - (c / cum) * plotH;
  const root = svg('svg', { class: 'chart sse-curve', viewBox: `0 0 ${W} ${H}`, height: H });

  root.append(svg('line', { x1: padL, x2: W - padR, y1: 8 + plotH, y2: 8 + plotH, class: 'axisline' }));
  root.append(svg('text', { x: padL - 5, y: 13, 'text-anchor': 'end' },
    cum >= 1000 ? (cum / 1000).toFixed(1) + 'K' : String(cum)));
  root.append(svg('text', { x: padL - 5, y: 8 + plotH + 3, 'text-anchor': 'end' }, 'chars'));
  for (const tk of niceTicks(tMax, 5)) {
    const xx = x(tk);
    if (xx > W - padR) continue;
    root.append(svg('text', { x: xx, y: bandY + 5 + 13, 'text-anchor': 'middle' }, '+' + fmtMs(tk)));
  }

  // Block-type color band
  for (const b of bands) {
    const bw = x(b.t1) - x(b.t0);
    if (bw < 1) continue;
    root.append(svg('rect', {
      x: x(b.t0), y: bandY, width: bw, height: 4, rx: 2,
      style: `fill:${PHASE_COLOR[b.type] || 'var(--ink-3)'}`,
    }, svg('title', null, (PHASE_LABEL[b.type] || b.type) + ' · ' + fmtMs(b.t1 - b.t0))));
  }

  // Cumulative-characters polyline (sampled down to ≤400 points)
  const step = Math.max(1, Math.ceil(pts.length / 400));
  let dPath = '';
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i];
    dPath += (dPath ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + y(p.c).toFixed(1);
  }
  const last = pts[pts.length - 1];
  dPath += 'L' + x(last.t).toFixed(1) + ',' + y(last.c).toFixed(1);
  root.append(svg('path', { d: dPath, class: 'curve-line' }));

  const wrap = el('div');
  const types = [...new Set(bands.map(b => b.type))];
  wrap.append(el('div', { class: 'legend' },
    legendKey('var(--ink-2)', 'cumulative output chars (plateau = stall)'),
    ...types.map(t => legendKey(PHASE_COLOR[t] || 'var(--ink-3)', PHASE_LABEL[t] || t)),
  ));
  wrap.append(root);
  return wrap;
}

function tabSSE(d) {
  const box = el('div');
  if (!d.sse) { box.append(el('div', { class: 'note' }, 'Non-streaming response')); return box; }
  const events = d.sse.events || [];
  const ttfb = d.timing && d.timing.firstByte ? d.timing.firstByte - d.timing.start : null;
  const streamMs = d.timing && d.timing.firstByte ? d.timing.end - d.timing.firstByte : null;
  const outTok = d.usage ? d.usage.output : null;
  const ph = phaseParts(d.phases);
  box.append(el('div', { class: 'sse-summary' },
    el('span', null, 'events ', el('b', null, String(events.length))),
    ttfb != null ? el('span', null, 'first event ', el('b', null, fmtMs(ttfb))) : null,
    streamMs != null && outTok ? el('span', null, 'throughput ', el('b', null, (outTok / (streamMs / 1000)).toFixed(1)), ' tok/s') : null,
    ...ph.map(s => {
      const i = s.lastIndexOf(' ');
      return el('span', null, s.slice(0, i) + ' ', el('b', null, s.slice(i + 1)));
    }),
    d.stallMs ? el('span', null, 'longest stall ', el('b', null, fmtMs(d.stallMs))) : null,
  ));

  const curve = sseCurve(d);
  if (curve) box.append(curve);

  const hasT = events.some(e => typeof e.t === 'number');
  const list = el('div', { class: 'sse-list' });
  const n = Math.min(events.length, state.sseShown);
  for (let i = 0; i < n; i++) {
    const ev = events[i];
    const item = el('div', { class: 'sse-item' },
      el('span', { class: 'idx' }, String(i)),
      hasT ? el('span', { class: 'etime' }, typeof ev.t === 'number' ? '+' + (ev.t / 1000).toFixed(2) + 's' : '') : null,
      el('span', { class: 'etype et-' + ev.event }, ev.event),
      el('span', { class: 'epreview' }, ssePreview(ev.data)),
    );
    item.addEventListener('click', () => {
      const existing = item.querySelector('pre');
      if (existing) { existing.remove(); return; }
      item.append(jsonHiPre(JSON.stringify(ev.data, null, 2)));
    });
    list.append(item);
  }
  box.append(list);
  if (events.length > n) {
    box.append(el('button', { class: 'btn', style: 'margin-top:8px', onclick: () => { state.sseShown += 500; renderDetail(); } },
      `Load more (${events.length - n} remaining)`));
  }
  return box;
}

// ---- Raw JSON

function reconstructRequest(d) {
  if (d.requestBody) return d.requestBody;
  const body = { ...(d.bodyRest || {}) };
  if (d.system != null) body.system = JSON.parse(JSON.stringify(d.system));
  if (d.tools) body.tools = JSON.parse(JSON.stringify(d.tools));
  if (d.messages) body.messages = d.messages.map(m => JSON.parse(JSON.stringify(m.msg)));
  if (d.metadata) body.metadata = d.metadata;
  // Backfill cache_control markers
  for (const mk of d.cacheMarkers || []) {
    try {
      if (mk.loc === 'top') body.cache_control = mk.cc;
      else {
        const arr = body[mk.loc === 'messages' ? 'messages' : mk.loc];
        if (!Array.isArray(arr)) continue;
        const target = mk.b != null ? arr[mk.i] && arr[mk.i].content && arr[mk.i].content[mk.b] : arr[mk.i];
        if (target && typeof target === 'object') target.cache_control = mk.cc;
      }
    } catch { /* ignore */ }
  }
  return body;
}

function tabRaw(d) {
  const box = el('div');
  box.append(el('div', { class: 'note' }, d.method + ' ' + d.path + ' · session ' + (d.sessionId || '—') + (d.userId ? ' · ' + d.userId : '')));

  const secs = [
    ['Request headers (credentials redacted)', d.reqHeaders],
    ['Request body (rebuilt from dedup storage, cache_control backfilled at recorded positions)', reconstructRequest(d)],
    ['Response headers', d.resHeaders],
    ['Response body' + (d.sse ? ' (reassembled from the SSE event stream)' : ''), d.response || d.responseText || null],
  ];
  secs.forEach(([title, obj], i) => {
    if (obj == null) return;
    const det = el('details', { class: 'raw-sec' });
    if (i === 1) det.open = true;
    det.append(el('summary', null, title));
    // Objects (headers / request body / reassembled response) are definitely JSON → syntax coloring; raw strings (non-JSON response bodies) are never guessed
    det.append(typeof obj === 'string' ? el('pre', null, obj) : jsonHiPre(JSON.stringify(obj, null, 2)));
    box.append(det);
  });
  return box;
}

// ---------------------------------------------------------------- Full-text search
// "Which request mentioned X" — the server dedups by content hash (repeated history reports only the first-occurrence request);
// clicking a result deep-links to that request across sessions via hash routing.

function initSearch() {
  const input = document.getElementById('search');
  const panel = document.getElementById('search-results');
  if (!input || !panel) return;
  let timer = null, seq = 0;

  const close = () => { panel.hidden = true; };
  const sessionLabel = sid => {
    const s = state.overview && state.overview.sessions.find(x => x.id === sid);
    return s ? (s.label || sid.slice(0, 12)) : sid.slice(0, 12);
  };

  const WHERE_LABEL = { response: 'response', system: 'system', tools: 'tools', request: 'request body' };
  const note = msg => { clear(panel); panel.hidden = false; panel.append(el('div', { class: 'sr-empty' }, msg)); };

  async function run() {
    const q = input.value.trim();
    if (!q) { close(); return; }
    // Same minimum-length rule as the server: single CJK characters pass; single ASCII characters get a hint instead of silence
    if (q.length < 2 && !/[^\x00-\x7f]/.test(q)) { note('Type one more character to search (single CJK characters work as-is)'); return; }
    const my = ++seq;
    if (panel.hidden || !panel.querySelector('.sr-row')) note('Searching…');
    let data;
    try {
      const resp = await fetch('/__lens/search?q=' + encodeURIComponent(q));
      // 404 = the server process is an old version without the search route (the request was passed through upstream) — reloading won't help, restart is needed
      if (resp.status === 404) throw Object.assign(
        new Error('The server process is an old version (missing the search endpoint). Restart it — Ctrl+C the cclens terminal and run cclens again — then reload this page'),
        { diagnosed: true });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      data = await resp.json();
      if (!data || !Array.isArray(data.results)) throw new Error('unexpected response shape');
    } catch (e) {
      // Silent failure is what makes search feel "broken" — every failure gets an actionable hint
      if (my === seq) note('Search failed: ' + e.message + (e.diagnosed ? '' : '. If the dashboard was just upgraded, force-reload the page (⌘⇧R)'));
      return;
    }
    if (my !== seq || input.value.trim() !== q) return; // a newer query exists
    clear(panel);
    panel.hidden = false;
    if (!data.results.length) {
      panel.append(el('div', { class: 'sr-empty' }, 'No matches — search covers: messages / tool params / tool results / responses / system / tools. Multiple words must all be present'));
      return;
    }
    panel.append(el('div', { class: 'sr-head' },
      `${data.total} first occurrences` + (data.total > data.results.length ? ` (showing first ${data.results.length})` : '') +
      ' · repeated history deduplicated · ↑↓ to select, Enter to open'));
    for (const r of data.results) {
      const snip = r.snippet || {};
      panel.append(el('div', {
        class: 'sr-row',
        onclick: () => {
          close();
          input.blur();
          const target = '#s=' + encodeURIComponent(r.sessionId) + '&r=' + encodeURIComponent(r.id);
          if (location.hash === target) openDetail(r.id); // clicked the current request: an unchanged hash won't trigger routing, open directly
          else location.hash = target;
        },
      },
        el('div', { class: 'sr-meta' },
          el('span', { class: 'model-dot', style: `background:${modelColor(r.model)}` }),
          el('span', { class: 'sr-sess' }, sessionLabel(r.sessionId)),
          el('span', { class: 'sr-where' }, WHERE_LABEL[r.where] || (r.role + ' message')),
          el('span', { class: 'sr-when' }, fmtWhen(r.ts)),
        ),
        el('div', { class: 'sr-snippet' }, snip.before || '', el('mark', null, snip.match || ''), snip.after || ''),
      ));
    }
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  input.addEventListener('focus', () => { if (panel.childElementCount) panel.hidden = false; });
  input.addEventListener('keydown', e => {
    if (e.isComposing) return; // keys during IME composition (Enter/arrows picking candidates) are not actions
    if (e.key === 'Escape') { e.stopPropagation(); input.blur(); close(); return; }
    const rows = [...panel.querySelectorAll('.sr-row')];
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !panel.hidden && rows.length) {
      e.preventDefault();
      let i = rows.findIndex(r => r.classList.contains('active'));
      i = e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0);
      rows.forEach((r, j) => r.classList.toggle('active', j === i));
      rows[i].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      clearTimeout(timer);
      const active = rows.find(r => r.classList.contains('active'));
      if (!panel.hidden && active) active.click();
      else run(); // Enter with nothing selected = search immediately (skip the debounce)
    }
  });
  document.addEventListener('click', e => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== input) close();
  });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== input &&
        !/^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '')) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

// ---------------------------------------------------------------- Live updates

function connectLive() {
  const dot = document.getElementById('live-dot');
  const es = new EventSource('/__lens/live');
  let pollTimer = null; // polling fallback while SSE is down — the page doesn't go blind during dashboard restarts / network flaps
  es.onopen = () => {
    dot.classList.add('on');
    dot.title = 'Live connection healthy';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    scheduleRefresh();
  };
  es.onerror = () => {
    dot.classList.remove('on');
    dot.title = 'Live connection lost, polling as fallback (auto-reconnecting)';
    if (!pollTimer) pollTimer = setInterval(scheduleRefresh, 4000);
  };
  es.addEventListener('start', e => {
    try {
      const p = JSON.parse(e.data);
      state.pending.set(p.id, p);
      scheduleRefresh();
    } catch {}
  });
  es.addEventListener('end', e => {
    try {
      const p = JSON.parse(e.data);
      state.pending.delete(p.id);
      scheduleRefresh();
    } catch {}
  });
}

// ---------------------------------------------------------------- Startup

// ---- Responsive: a half-screen terminal side by side is this tool's primary use case — narrow windows are the norm, not an edge case ----
// When the content area is too narrow and the detail pane is open, the lineage compresses into a "nav rail" (CSS :has rule); the list stays visible and clickable
const contentEl = document.getElementById('content');
function updateNarrow() {
  const narrow = contentEl.clientWidth < 1060;
  if (contentEl.classList.contains('narrow') !== narrow) {
    contentEl.classList.toggle('narrow', narrow);
    renderTopbar(); // the number of rate-limit entries varies with width
  }
}
updateNarrow();
new ResizeObserver(updateNarrow).observe(contentEl);

// After the session pane's width changes (window resize, detail open/close, sidebar collapse/expand), redraw charts at the new width —
// scaling SVG via viewBox squashes text; redrawing is what gets the correct width
let resizeTimer = null;
const paneEl = document.getElementById('session-pane');
let lastPaneW = paneEl.clientWidth;
new ResizeObserver(() => {
  const w = paneEl.clientWidth;
  if (Math.abs(w - lastPaneW) <= 24) return; // height changes (content growing/shrinking) don't trigger
  lastPaneW = w;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.session) renderSession(true); }, 150);
}).observe(paneEl);

// ---- Two-pane split drag: drag the lineage/detail divider left-right, double-click to reset ----
// The wide content area and the nav rail each remember their own ratio (the two modes want different proportions), persisted in localStorage;
// a CSS-side clamp guarantees both panes a minimum readable width — dragging out of bounds can't squeeze either pane away
{
  const handle = document.getElementById('split-handle');
  const varName = () => contentEl.classList.contains('narrow') ? '--split-rail' : '--split';
  const keyName = () => 'lens.' + (contentEl.classList.contains('narrow') ? 'splitRail' : 'split');
  for (const k of ['--split', '--split-rail']) {
    const v = localStorage.getItem('lens.' + (k === '--split' ? 'split' : 'splitRail'));
    if (v) contentEl.style.setProperty(k, v);
  }
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch {}
    handle.classList.add('dragging');
    document.body.classList.add('splitting');
    uiDragging = true;
    const rect = contentEl.getBoundingClientRect();
    const onMove = ev => {
      const pct = Math.min(88, Math.max(12, (ev.clientX - rect.left) / rect.width * 100));
      contentEl.style.setProperty(varName(), pct.toFixed(1) + '%');
    };
    const onUp = () => {
      uiDragging = false;
      handle.classList.remove('dragging');
      document.body.classList.remove('splitting');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const v = contentEl.style.getPropertyValue(varName());
      if (v) localStorage.setItem(keyName(), v);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
  handle.addEventListener('dblclick', () => {
    contentEl.style.removeProperty(varName());
    localStorage.removeItem(keyName());
  });
}

// Esc closes the detail pane (the lightbox's and search's own Esc handlers already stopPropagation at the source)
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.detailId && !document.querySelector('.lightbox')) closeDetail();
});

// ↑/↓ steps through requests along the lineage — "compare request by request" is the high-frequency workflow once the detail pane is open.
// Take over the arrow keys only while the detail pane is open (otherwise keep page scrolling); document order is visual order (incl. agent member rows)
document.addEventListener('keydown', e => {
  if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !state.detailId) return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const rows = [...document.querySelectorAll('#session-pane .lineage li[data-rid]')];
  const i = rows.findIndex(li => li.dataset.rid === state.detailId);
  const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
  if (i < 0 || !next) return;
  e.preventDefault();
  next.scrollIntoView({ block: 'nearest' });
  openDetail(next.dataset.rid);
});

function ttlText(expiry) {
  const left = expiry - Date.now();
  return left > 0 ? 'cache expires in ' + fmtMs(left) : 'cache expired (next round rewrites in full)';
}

// In-place updates every second (no full re-render — that's what keeps scroll/hover/selection stable): running timers + cache TTL countdown
setInterval(() => {
  for (const t of document.querySelectorAll('.ttl-count')) {
    const exp = Number(t.dataset.expiry);
    t.textContent = ttlText(exp);
    const left = exp - Date.now();
    t.classList.toggle('ttl-soon', left < 60000);
  }
  if (!state.session) return;
  const pending = new Map(state.session.requests.filter(r => r.pending).map(r => [r.id, r]));
  if (!pending.size) return;
  for (const li of document.querySelectorAll('#session-pane .lineage li[data-rid]')) {
    const r = pending.get(li.dataset.rid);
    if (!r) continue;
    const d = li.querySelector('.dur');
    if (d) d.textContent = fmtMs(Date.now() - r.ts) + '…';
  }
}, 1000);

initSearch();
connectLive();
loadOverview().catch(err => {
  console.error(err);
  document.getElementById('session-pane').append(el('div', { class: 'empty-hint' }, 'Load failed: ' + err.message));
});
