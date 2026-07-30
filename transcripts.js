/**
 * cclens transcripts subtool — Claude Code session transcript (JSONL) viewer
 *
 * Read-only bypass: scans *.jsonl under the transcripts root (default ~/.claude/projects).
 * Mounted on the lens server:
 *   /transcripts            index page (session directory grouped by project)
 *   /transcripts/viewer     session viewer page (?path=<rel>)
 *   /__viewer/*             API (sessions/tail/meta/export/open/reveal/resolve)
 *
 * This layer has no command to turn it on: Claude Code writes these files regardless, cclens only
 * reads them, so there is nothing to install and nothing to keep running. It is therefore on by
 * default, and the only reason to touch it is privacy — `{"viewer": false}` in ~/.claude/cclens/config.json
 * makes the module refuse every request here. That is a config field rather than a verb precisely
 * because it is an opt-out, not a switch anyone flips day to day; it is checked per request (with an
 * mtime cache), so editing the file takes effect immediately.
 *
 * Link to the API layer: the transcript filename IS the session id —
 * /__viewer/resolve?session=<id> resolves an API-layer session to its transcript;
 * the reverse direction jumps back to the API lineage via /#s=<sessionId> on the frontend.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PUBLIC_DIR = path.join(__dirname, 'public', 'transcripts');
const CHUNK = 128 * 1024;

const CONFIG_FILE = require('./paths').configFile();

// ------------------------------------------------------------ subtool toggle (config.json, cached by mtime)

let cfgCache = { mtimeMs: -1, cfg: {} };

function readConfig() {
  let st;
  try { st = fs.statSync(CONFIG_FILE); } catch { return {}; }
  if (st.mtimeMs === cfgCache.mtimeMs) return cfgCache.cfg;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch {}
  cfgCache = { mtimeMs: st.mtimeMs, cfg };
  return cfg;
}

function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  require('./paths').ensureDataDir(path.dirname(CONFIG_FILE));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  cfgCache = { mtimeMs: -1, cfg: {} }; // invalidate; re-read next time
  return cfg;
}

function enabled() {
  return readConfig().viewer !== false; // enabled by default
}

// ------------------------------------------------------------ transcripts root directory

function transcriptsRoot() {
  const dir = process.env.CCLENS_TRANSCRIPTS || path.join(os.homedir(), '.claude', 'projects');
  try { return fs.realpathSync(path.resolve(dir)); } catch { return null; } // directory may not exist
}

// ------------------------------------------------------------ page templates
// index/viewer are both self-contained HTML; shared CSS lives in base.css and replaces the /*BASE*/ marker at response time.
// Files are re-read on every request — the pages are only tens of KB, and in exchange frontend edits need no restart.

function page(name) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'base.css'), 'utf8');
  // The replacement MUST be a function: the string form would expand $`/$&/$' in the content as special patterns
  return html.replace('/*BASE*/', () => css);
}

// ------------------------------------------------------------ session metadata (for the index page)
// Cheap: reads only 128 KB from each end of the file, cached by (size, mtime)

const metaCache = new Map(); // path -> { size, mtimeMs, meta }

function parseChunk(buf, skipFirst) {
  let lines = buf.toString('utf8').split('\n');
  if (skipFirst && lines.length) lines = lines.slice(1);
  const out = [];
  for (let ln of lines) {
    ln = ln.trim();
    if (!ln) continue;
    try { out.push(JSON.parse(ln)); } catch {} // partial line at a chunk boundary, or a corrupt line
  }
  return out;
}

function sessionMeta(p, root) {
  const st = fs.statSync(p);
  const cached = metaCache.get(p);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.meta;

  const fd = fs.openSync(p, 'r');
  let head, tail = Buffer.alloc(0);
  try {
    head = Buffer.alloc(Math.min(CHUNK, st.size));
    fs.readSync(fd, head, 0, head.length, 0);
    if (st.size > 2 * CHUNK) {
      tail = Buffer.alloc(CHUNK);
      fs.readSync(fd, tail, 0, CHUNK, st.size - CHUNK);
    }
  } finally {
    fs.closeSync(fd);
  }
  const objs = parseChunk(head, false).concat(parseChunk(tail, true));

  const rel = path.relative(root, p).split(path.sep).join('/');
  const parts = rel.split('/');
  const meta = {
    path: rel,
    project: parts.length > 1 ? parts[0] : '(root)',
    sub: parts.slice(1, -1).join('/'),
    file: path.basename(p),
    size: st.size,
    mtime: st.mtimeMs / 1000,
    sessionId: '',
    title: '',
    firstPrompt: '',
    models: [],
    startTs: '',
    endTs: '',
    agentName: '',
    cwd: '',
    pr: null,
  };
  const models = [];
  let aiTitle = '', customTitle = '';
  for (const o of objs) {
    if (typeof o !== 'object' || o === null) continue;
    if (!meta.sessionId && o.sessionId) meta.sessionId = o.sessionId;
    if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;
    else if (o.type === 'custom-title' && o.customTitle) customTitle = o.customTitle;
    else if (!aiTitle && o.type === 'summary' && o.summary) aiTitle = o.summary;
    if (o.type === 'agent-name' && o.agentName) meta.agentName = o.agentName;
    if (o.type === 'pr-link' && o.prUrl) meta.pr = { n: o.prNumber, url: o.prUrl };
    // The project directory name is a lossy encoding of the cwd ('/' -> '-'), so decoding it mangles any
    // path segment that legitimately contains a hyphen. The records carry the real cwd — prefer it.
    if (!meta.cwd && typeof o.cwd === 'string' && o.cwd) meta.cwd = o.cwd;
    if (!meta.firstPrompt && o.type === 'user' && !o.isMeta) {
      const c = (o.message || {}).content;
      if (typeof c === 'string' && c && !c.startsWith('<')) meta.firstPrompt = c.slice(0, 200);
    }
    const m = (o.message || {}).model;
    if (m && !models.includes(m)) models.push(m);
    const ts = o.timestamp;
    if (ts) {
      if (!meta.startTs || ts < meta.startTs) meta.startTs = ts;
      if (ts > meta.endTs) meta.endTs = ts;
    }
  }
  meta.models = models;
  meta.title = customTitle || aiTitle;   // a user-assigned name wins over the AI-generated one
  // A subagent transcript itself carries no agent-name record, but the agent-<id>.meta.json next to it records the type and task description
  if (!meta.agentName && /^agent-.+\.jsonl$/.test(meta.file)) {
    try {
      const mj = JSON.parse(fs.readFileSync(p.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      if (mj.agentType || mj.description) meta.agentName = [mj.agentType, mj.description].filter(Boolean).join(': ');
    } catch {} // older transcripts without a meta.json
  }
  metaCache.set(p, { size: st.size, mtimeMs: st.mtimeMs, meta });
  return meta;
}

function listSessions(root) {
  const out = [];
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { out.push(sessionMeta(p, root)); } catch {} // file vanished mid-scan
      }
    }
  })(root);
  return out;
}

// ------------------------------------------------------------ session id → transcript path (linkage with the API layer)
// The transcript filename IS the session id (main chain <id>.jsonl; subagent agent-<id>.jsonl).
// Scans directory names only, never file contents; hits are cached forever (files do not move), misses rescan at most every 3s.

const resolveCache = new Map(); // sessionId -> rel path
let lastResolveScan = 0;

function resolveSession(id) {
  if (!id || !/^[\w-]+$/.test(id)) return null;
  if (resolveCache.has(id)) return resolveCache.get(id);
  const root = transcriptsRoot();
  if (!root) return null;
  if (Date.now() - lastResolveScan < 3000) return null;
  lastResolveScan = Date.now();
  const names = new Set([`${id}.jsonl`, `agent-${id}.jsonl`]);
  let found = null;
  (function walk(dir) {
    if (found) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (found) return;
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (names.has(e.name)) found = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
    }
  })(root);
  if (found) resolveCache.set(id, found);
  return found;
}

// ------------------------------------------------------------ tail — incrementally read whole lines from a byte offset

function tailFile(p, offset) {
  const size = fs.statSync(p).size;
  if (offset > size) return { truncated: true, offset: 0, lines: [], size };
  if (offset === size) return { truncated: false, offset, lines: [], size };
  const fd = fs.openSync(p, 'r');
  let data;
  try {
    const buf = Buffer.alloc(size - offset);
    const n = fs.readSync(fd, buf, 0, buf.length, offset);
    data = buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
  const nl = data.lastIndexOf(0x0a);
  const complete = nl >= 0 ? data.subarray(0, nl + 1) : Buffer.alloc(0);
  const rest = nl >= 0 ? data.subarray(nl + 1) : data;
  const lines = complete.toString('utf8').split('\n').filter(ln => ln.trim());
  let newOffset = offset + complete.length;
  const restStr = rest.toString('utf8');
  if (restStr.trim()) {
    // Final line with no trailing newline — deliver it only if it is already complete JSON; otherwise leave it for the next poll
    try {
      JSON.parse(restStr);
      lines.push(restStr);
      newOffset = offset + data.length;
    } catch {}
  }
  return { truncated: false, offset: newOffset, lines, size };
}

// ------------------------------------------------------------ export a single-file HTML snapshot

function buildStandalone(file) {
  const recs = [];
  for (let ln of fs.readFileSync(file, 'utf8').split('\n')) {
    ln = ln.trim();
    if (!ln) continue;
    try { recs.push(JSON.parse(ln)); }
    catch { recs.push({ type: 'parse-error', raw: ln.slice(0, 2000) }); }
  }
  const data = JSON.stringify(recs).replace(/<\//g, '<\\/');
  const embed = `<script id="session-data" type="application/json">${data}</script>`;
  return page('viewer.html').replace('<!--EMBED-->', () => embed); // function form, same as above
}

// ------------------------------------------------------------ open / reveal a file in the OS

function osOpen(p, reveal) {
  let cmd, argv;
  if (process.platform === 'darwin') {
    cmd = 'open'; argv = reveal ? ['-R', p] : [p];
  } else if (process.platform === 'win32') {
    if (reveal) { cmd = 'explorer'; argv = ['/select,', p]; }
    else { cmd = 'cmd'; argv = ['/c', 'start', '', p]; }
  } else {
    cmd = 'xdg-open'; argv = [reveal ? path.dirname(p) : p];
  }
  return new Promise(resolve => {
    const c = spawn(cmd, argv, { detached: true, stdio: 'ignore' });
    c.on('error', e => resolve(String(e.message || e)));
    c.on('spawn', () => { c.unref(); resolve(null); });
  });
}

// ------------------------------------------------------------ request dispatch (called by the lens server)

const DISABLED_PAGE = `<!doctype html><meta charset="utf-8"><title>cclens</title>
<body style="font:14px/1.6 system-ui;max-width:36em;margin:15vh auto;padding:0 2em;color:#444">
<h1 style="font-size:18px">Transcripts are turned off</h1>
<p>Someone set <code style="background:#eee;padding:2px 6px;border-radius:4px">"viewer": false</code> in
<code style="background:#eee;padding:2px 6px;border-radius:4px">${CONFIG_FILE}</code>. Remove that line to read
session transcripts again — it takes effect immediately, with no restart.</p>
<p><a href="/">← Back to the API dashboard</a></p>`;

/** Handle /transcripts* and /__viewer/* requests. The caller has already dispatched by prefix; this always responds. */
async function handle(req, res) {
  const send = (code, body, ctype = 'text/html; charset=utf-8', extra = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(code, { 'Content-Type': ctype, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
    res.end(buf);
  };
  const json = (obj, code = 200) => send(code, JSON.stringify(obj), 'application/json; charset=utf-8');
  const u = new URL(req.url, 'http://localhost');

  if (!enabled()) {
    if (u.pathname.startsWith('/__viewer/')) return json({ error: 'transcripts turned off', hint: `remove "viewer": false from ${CONFIG_FILE}` }, 403);
    return send(200, DISABLED_PAGE);
  }

  const root = transcriptsRoot();
  // ?path= only accepts a real, existing .jsonl inside the root (validated after realpath, so even symlinks cannot escape)
  function resolveJsonl(rel) {
    if (!root || !rel || !rel.endsWith('.jsonl')) return null;
    let target;
    try { target = fs.realpathSync(path.resolve(root, rel)); } catch { return null; }
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    try { return fs.statSync(target).isFile() ? target : null; } catch { return null; }
  }

  try {
    if (u.pathname === '/transcripts' || u.pathname === '/transcripts/') {
      send(200, page('index.html'));
    } else if (u.pathname === '/transcripts/viewer') {
      send(200, page('viewer.html'));
    } else if (u.pathname === '/__viewer/sessions') {
      json(root ? listSessions(root) : []);
    } else if (u.pathname === '/__viewer/resolve') {
      const rel = resolveSession(u.searchParams.get('session') || '');
      json({ path: rel || null });
    } else if (u.pathname === '/__viewer/tail') {
      const p = resolveJsonl(u.searchParams.get('path'));
      if (!p) return json({ error: 'bad path' }, 404);
      json(tailFile(p, Number(u.searchParams.get('offset') || '0')));
    } else if (u.pathname === '/__viewer/meta') {
      const p = resolveJsonl(u.searchParams.get('path'));
      if (!p) return json({ error: 'bad path' }, 404);
      json(sessionMeta(p, root));
    } else if (u.pathname === '/__viewer/export') {
      const p = resolveJsonl(u.searchParams.get('path'));
      if (!p) return json({ error: 'bad path' }, 404);
      send(200, buildStandalone(p), 'text/html; charset=utf-8',
        { 'Content-Disposition': `attachment; filename="${path.basename(p, '.jsonl')}.html"` });
    } else if (u.pathname === '/__viewer/open' || u.pathname === '/__viewer/reveal') {
      const p = resolveJsonl(u.searchParams.get('path'));
      if (!p) return json({ error: 'bad path' }, 404);
      const err = await osOpen(p, u.pathname === '/__viewer/reveal');
      if (err) return json({ error: err }, 500);
      json({ ok: true, path: p });
    } else {
      send(404, 'not found', 'text/plain; charset=utf-8');
    }
  } catch (e) { // one bad request must never bring down the service
    try { json({ error: String(e && e.message || e) }, 500); } catch {}
  }
}

module.exports = { handle, enabled, readConfig, writeConfig, buildStandalone, transcriptsRoot, CONFIG_FILE };
