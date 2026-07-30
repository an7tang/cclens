'use strict';
/**
 * hooks subtool: the Claude Code hook-event layer (a local lifecycle record).
 *
 * What the hook layer uniquely adds to the three-layer observation design: the API
 * layer only sees network requests — everything between two requests is a black box;
 * the transcript layer has semantics but not the real timing of local execution.
 * Hook events are precisely "the explanation of the gaps" — real tool execution
 * duration (PreToolUse→PostToolUse pairing), permission wait
 * (PermissionRequest→PreToolUse), compaction triggers, session start/end reasons.
 *
 * Data source (events-<UTC date>.jsonl, one event per line):
 *   ~/.claude/cclens/hooks/   this tool's recorder (registered via cclens install)
 *
 * Registration is a one-time install rather than a toggle because that is what this layer actually is:
 * once the entries are in settings.json, Claude Code invokes the recorder itself, so events keep
 * landing on disk with no cclens process running at all, and across reboots.
 *
 * Correlation keys: session_id matches the API-layer session and the transcript
 * filename; tool_use_id is globally unique — across main chain and subagents alike —
 * and is the primary key for annotating transcripts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const paths = require('./paths');
const LENS_DIR = () => paths.hooksDir();
const SETTINGS = () => process.env.CCLENS_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');

// The complete set of hook events in Claude Code 2.1.x (confirmed from the binary; has SubagentStart/PostToolUseFailure/PermissionRequest beyond the public docs)
const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PermissionRequest',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'Stop', 'SessionEnd',
];

// ---------------------------------------------------------------- recording hot path
// Called by hooks: must be fast, must never fail, must never write to stdout (Claude Code parses stdout as hook output)

function record(eventArg) {
  const chunks = [];
  const bail = setTimeout(() => process.exit(0), 5000);
  if (bail.unref) bail.unref();
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let payload;
    try { payload = JSON.parse(raw); }
    catch { payload = { _unparsed: raw.slice(0, 10000) }; }
    const ts = new Date().toISOString();
    const rec = { ts, event: payload.hook_event_name || eventArg || 'Unknown', payload: capPayload(payload) };
    try {
      paths.ensureDataDir(LENS_DIR());
      fs.appendFileSync(path.join(LENS_DIR(), `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify(rec) + '\n');
    } catch { /* a recording failure must never affect Claude Code */ }
    process.exit(0);
  });
}

// When a single event exceeds 256KB, truncate its long strings (tool_response may carry full tool output)
function capPayload(payload) {
  const LIMIT = 256 * 1024, FIELD_CAP = 64 * 1024;
  let s;
  try { s = JSON.stringify(payload); } catch { return { _unserializable: true }; }
  if (s.length <= LIMIT) return payload;
  const walk = v => {
    if (typeof v === 'string' && v.length > FIELD_CAP)
      return v.slice(0, FIELD_CAP) + `\n…[cclens truncated ${v.length - FIELD_CAP} chars]`;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  };
  const out = walk(payload);
  out._truncated = true;
  return out;
}

// ---------------------------------------------------------------- registration management
// `off` removes exactly the entries injected by this tool; the user's own hooks are kept as-is.

const OURS = h => typeof h.command === 'string' && h.command.includes('cclens') && h.command.includes('hooks record');

/** The two quoted absolute paths a registered command starts with: the node binary, then this CLI. */
const cmdPaths = cmd => {
  const m = /^"([^"]+)"\s+"([^"]+)"/.exec(cmd);
  return m ? [m[1], m[2]] : [];
};

// Being registered is not the same as working. Both paths written into settings.json are absolute and
// specific to one node version and one checkout location, so `nvm use`, a node upgrade, or moving the
// repo leaves twelve entries that point at nothing — and Claude Code fails those hooks silently, since
// a hook that cannot run must never block a session. Reporting "12/12 recording" in that state would be
// the tool lying about itself, so resolution is checked and surfaced rather than assumed.
const RESOLVES = h => { const p = cmdPaths(h.command); return p.length === 2 && p.every(x => fs.existsSync(x)); };

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Cannot parse ${SETTINGS()}: ${e.message} (aborted to avoid corrupting the config)`);
  }
}

/** ours: event types with a recorder registered. broken: those whose recorder path no longer exists —
 *  a subset of ours, and the difference between "registered" and "actually able to run". */
function registration() {
  let s;
  try { s = readSettings(); } catch { return { ours: [], broken: [], deadPath: null }; }
  const hooks = s.hooks || {};
  const scan = pred => EVENTS.filter(ev => Array.isArray(hooks[ev]) &&
    hooks[ev].some(e => Array.isArray(e.hooks) && e.hooks.some(pred)));
  const ours = scan(OURS);
  const broken = scan(h => OURS(h) && !RESOLVES(h));
  // Name the first path that is actually missing, so the message can point at the real cause
  let deadPath = null;
  for (const ev of broken) {
    for (const e of hooks[ev]) {
      for (const h of (e.hooks || [])) {
        if (!OURS(h)) continue;
        const missing = cmdPaths(h.command).find(p => !fs.existsSync(p));
        if (missing) { deadPath = missing; break; }
      }
      if (deadPath) break;
    }
    if (deadPath) break;
  }
  return { ours, broken, deadPath };
}

function registerOn(binPath) {
  const s = readSettings();
  paths.ensureDataDir(LENS_DIR());
  try { fs.copyFileSync(SETTINGS(), path.join(LENS_DIR(), `settings.backup-${Date.now()}.json`)); } catch {}
  s.hooks = s.hooks || {};
  const cmd = ev => `"${process.execPath}" "${binPath}" hooks record ${ev}`;
  for (const ev of EVENTS) {
    const arr = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : (s.hooks[ev] = []);
    // Idempotent: remove old injections before appending (node/bin paths may have changed)
    s.hooks[ev] = arr.filter(e => !(Array.isArray(e.hooks) && e.hooks.some(OURS)));
    s.hooks[ev].push({ hooks: [{ type: 'command', command: cmd(ev), timeout: 10 }] });
  }
  fs.mkdirSync(path.dirname(SETTINGS()), { recursive: true });
  fs.writeFileSync(SETTINGS(), JSON.stringify(s, null, 2) + '\n');
  return { added: EVENTS, message: `Registered ${EVENTS.length} event types in ${SETTINGS()} (takes effect in newly started claude sessions)` };
}

function registerOff() {
  const s = readSettings();
  if (!s.hooks) return { removed: 0 };
  let removed = 0;
  for (const ev of Object.keys(s.hooks)) {
    if (!Array.isArray(s.hooks[ev])) continue;
    const before = s.hooks[ev].length;
    s.hooks[ev] = s.hooks[ev]
      .map(e => (Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter(h => !OURS(h)) } : e))
      .filter(e => !Array.isArray(e.hooks) || e.hooks.length > 0);
    removed += before - s.hooks[ev].length;
    if (s.hooks[ev].length === 0) delete s.hooks[ev];
  }
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  fs.writeFileSync(SETTINGS(), JSON.stringify(s, null, 2) + '\n');
  return { removed };
}

// ---------------------------------------------------------------- data reading (incremental + cached)

// dirKey → directory; the detail endpoint addresses files as "<dirKey>/<file>" to avoid exposing absolute paths
const DIRS = () => ({ lens: LENS_DIR() });

const fileCache = new Map(); // "<dirKey>/<file>" -> { offset, events: [projected] }
let lastScan = 0;
let scanGen = 0; // +1 each time new data is actually read; clients can use it to skip redundant processing

function listDataFiles() {
  const out = [];
  const dirs = DIRS();
  for (const key of Object.keys(dirs)) {
    let names = [];
    try { names = fs.readdirSync(dirs[key]); } catch { continue; }
    for (const n of names) {
      if (/^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)) out.push({ key: key + '/' + n, file: path.join(dirs[key], n) });
    }
  }
  return out.sort((a, b) => a.key.slice(a.key.indexOf('/')) < b.key.slice(b.key.indexOf('/')) ? -1 : 1);
}

function available() {
  return listDataFiles().length > 0;
}

/** Scan all data files, incrementally reading new lines (throttled to 2s). Returns projected events merged in time order. */
function scan() {
  const now = Date.now();
  if (now - lastScan >= 2000) {
    lastScan = now;
    for (const { key, file } of listDataFiles()) {
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      let c = fileCache.get(key);
      if (!c) fileCache.set(key, c = { offset: 0, events: [] });
      if (size <= c.offset) continue;
      const buf = Buffer.alloc(size - c.offset);
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, buf.length, c.offset);
      } catch { continue; }
      finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl < 0) continue;
      let lineStart = 0;
      for (let i = 0; i <= lastNl; i++) {
        if (buf[i] !== 0x0a) continue;
        if (i > lineStart) {
          const pr = project(buf.toString('utf8', lineStart, i), key, c.offset + lineStart, i - lineStart);
          if (pr) { c.events.push(pr); scanGen++; }
        }
        lineStart = i + 1;
      }
      c.offset += lastNl + 1;
    }
  }
  const all = [];
  for (const c of fileCache.values()) all.push(...c.events);
  all.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  return all;
}

function firstStr(v, n) {
  if (typeof v !== 'string') { try { v = JSON.stringify(v); } catch { v = String(v); } }
  v = (v || '').replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n) + '…' : v;
}

/** Inline summary of tool_input: pick the most informative real field *value*
 * (command/file_path/pattern…, verbatim, never paraphrased), so skimming has no JSON
 * bracket noise; the full payload lives in the expanded event view, nothing dropped. */
function inputSum(ti) {
  if (ti == null) return '';
  if (typeof ti === 'object' && !Array.isArray(ti)) {
    if (typeof ti.command === 'string') return firstStr(ti.command, 120);
    if (typeof ti.file_path === 'string') return firstStr(ti.file_path + (typeof ti.pattern === 'string' ? ' ' + ti.pattern : ''), 120);
    if (typeof ti.pattern === 'string') return firstStr(ti.pattern + (typeof ti.path === 'string' ? ' ' + ti.path : ''), 120);
    if (typeof ti.url === 'string') return firstStr(ti.url, 120);
    if (typeof ti.prompt === 'string') return firstStr(ti.prompt, 120);
    if (typeof ti.query === 'string') return firstStr(ti.query, 120);
  }
  return firstStr(ti, 120);
}

/** Inline summary of tool_response (a Post row shows its own content, complementing the
 * Pre row's tool_input): likewise verbatim real field values — stdout first (Bash-like
 * tools), everything else truncated as a whole. */
function respSum(tr, ti) {
  if (tr === undefined) return inputSum(ti);
  if (tr && typeof tr === 'object' && !Array.isArray(tr)) {
    if (typeof tr.stdout === 'string' && tr.stdout.trim()) return firstStr(tr.stdout, 120);
    if (typeof tr.stderr === 'string' && tr.stderr.trim()) return firstStr(tr.stderr, 120);
    if (tr.file && typeof tr.file.filePath === 'string') return firstStr(tr.file.filePath, 120);
    if (typeof tr.filePath === 'string') return firstStr(tr.filePath, 120); // Edit/Write report the path at the top level, Read nests it under .file
    // Block-array responses (Task/Agent, and any tool answering in message-content form): show the text the
    // tool actually returned rather than the envelope. The full payload stays one click away on the row.
    if (Array.isArray(tr.content)) {
      const t = tr.content.find(b => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim());
      if (t) return firstStr(t.text, 120);
    }
  }
  return firstStr(tr, 120);
}

/** One raw record line → lightweight projection (full payload is lazy-loaded by offset via /__hooks/detail) */
function project(line, fileKey, o, l) {
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  const p = rec.payload || {};
  const ev = rec.event;
  const out = {
    ts: rec.ts, ev,
    sid: p.session_id || '',
    tool: p.tool_name || '', tuid: p.tool_use_id || '',
    mode: p.permission_mode || '',
    f: fileKey, o, l,
    sum: '',
  };
  if (ev === 'PreToolUse' || ev === 'PermissionRequest') out.sum = inputSum(p.tool_input);
  else if (ev === 'PostToolUse' || ev === 'PostToolUseFailure') out.sum = respSum(p.tool_response, p.tool_input);
  else if (ev === 'UserPromptSubmit') out.sum = firstStr(p.prompt, 160);
  else if (ev === 'Notification') out.sum = firstStr(p.message, 160);
  else if (ev === 'PreCompact') out.sum = p.trigger || '';
  else if (ev === 'SessionStart') out.sum = p.source || '';
  else if (ev === 'SessionEnd') out.sum = p.reason || '';
  else if (ev === 'SubagentStart' || ev === 'SubagentStop')
    out.sum = [p.agent_type, p.agent_id && 'agent-' + p.agent_id].filter(Boolean).join(' · ') || firstStr(p, 80);
  else if (ev === 'Stop') out.sum = p.stop_hook_active ? 'stop_hook_active' : '';
  else out.sum = firstStr(p, 120);
  return out;
}

/** Pairing annotation over an event sequence (written back onto the event objects in place):
 *  - PostToolUse/PostToolUseFailure → durMs (measured duration since its PreToolUse) + fail
 *  - PreToolUse → waitMs (permission wait since its preceding PermissionRequest) + paired (a Post paired successfully)
 *  - PermissionRequest → paired (consumed by a subsequent PreToolUse)
 *  `paired` is an exact marker (a factual product of the pairing algorithm) — UI folding
 *  trusts only it, no heuristic guessing: events without `paired` must be rendered
 *  standalone; no real event is ever allowed to silently disappear.
 *  Returns a tuid → { tool, durMs, waitMs, fail, preTs } summary (the primary key for transcript annotation). */
function annotate(evts) {
  const byTuid = new Map(), byToolStack = new Map(), pendPerm = new Map();
  const tuids = {};
  for (const e of evts) {
    if (e.ev === 'PermissionRequest') {
      pendPerm.set(e.tuid || e.tool, e);
    } else if (e.ev === 'PreToolUse') {
      const perm = pendPerm.get(e.tuid) || pendPerm.get(e.tool);
      if (perm) {
        e.waitMs = Date.parse(e.ts) - Date.parse(perm.ts);
        perm.paired = true;
        pendPerm.delete(e.tuid); pendPerm.delete(e.tool);
      }
      if (e.tuid) byTuid.set(e.tuid, e);
      else {
        if (!byToolStack.has(e.tool)) byToolStack.set(e.tool, []);
        byToolStack.get(e.tool).push(e);
      }
    } else if (e.ev === 'PostToolUse' || e.ev === 'PostToolUseFailure') {
      let pre = null;
      if (e.tuid && byTuid.has(e.tuid)) { pre = byTuid.get(e.tuid); byTuid.delete(e.tuid); }
      else if (byToolStack.get(e.tool) && byToolStack.get(e.tool).length) pre = byToolStack.get(e.tool).pop();
      if (pre) {
        e.durMs = Date.parse(e.ts) - Date.parse(pre.ts);
        pre.paired = true;
        if (e.ev === 'PostToolUseFailure') e.fail = true;
        const tuid = e.tuid || pre.tuid;
        if (tuid) {
          tuids[tuid] = { tool: e.tool, durMs: e.durMs, preTs: pre.ts };
          if (pre.waitMs != null) tuids[tuid].waitMs = pre.waitMs;
          if (e.fail) tuids[tuid].fail = true;
        }
      }
    }
  }
  // Pre with no Post (still running / killed) also gets an existence marker for the transcript
  for (const [tuid, pre] of byTuid) {
    if (!tuids[tuid]) {
      tuids[tuid] = { tool: pre.tool, preTs: pre.ts, open: true };
      if (pre.waitMs != null) tuids[tuid].waitMs = pre.waitMs;
    }
  }
  return tuids;
}

// ---------------------------------------------------------------- HTTP endpoints

function json(res, obj, code) {
  res.writeHead(code || 200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/__hooks/status') {
    const reg = registration();
    const files = listDataFiles();
    let bytes = 0, events = 0;
    const sids = new Set();
    for (const { file } of files) { try { bytes += fs.statSync(file).size; } catch {} }
    for (const e of scan()) { events++; if (e.sid) sids.add(e.sid); }
    return json(res, {
      available: files.length > 0,
      // `broken` is a subset of registered whose recorder path no longer resolves; those events are
      // dropped silently, so the UI must not count them as covered on the strength of registration alone
      registered: { lens: reg.ours }, broken: reg.broken, brokenPath: reg.deadPath,
      files: files.length, bytes, events, sessions: sids.size,
      allEvents: EVENTS,
    });
  }

  if (u.pathname === '/__hooks/session') {
    const id = u.searchParams.get('id') || '';
    if (!id) return json(res, { error: 'missing id' }, 400);
    const events = scan().filter(e => e.sid === id);
    const tuids = annotate(events);
    return json(res, { gen: scanGen, events, tuids });
  }

  // Global tuid → pairing results (tool_use_id is globally unique; main-chain and subagent transcripts share this one annotation set)
  if (u.pathname === '/__hooks/annotations') {
    const all = scan();
    const bySid = new Map();
    for (const e of all) {
      if (!bySid.has(e.sid)) bySid.set(e.sid, []);
      bySid.get(e.sid).push(e);
    }
    const tuids = {};
    for (const evts of bySid.values()) Object.assign(tuids, annotate(evts));
    return json(res, { gen: scanGen, tuids });
  }

  // Full raw payload lazy-loaded by (file, offset, length) — expand an event row to see all its data
  if (u.pathname === '/__hooks/detail') {
    const f = u.searchParams.get('f') || '';
    const o = Number(u.searchParams.get('o')), l = Number(u.searchParams.get('l'));
    const m = /^(lens)\/(events-\d{4}-\d{2}-\d{2}\.jsonl)$/.exec(f);
    if (!m || !Number.isFinite(o) || !Number.isFinite(l) || o < 0 || l <= 0 || l > 8 * 1024 * 1024)
      return json(res, { error: 'bad params' }, 400);
    const file = path.join(DIRS()[m[1]], m[2]);
    let rec;
    try {
      const buf = Buffer.alloc(l);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, l, o); } finally { fs.closeSync(fd); }
      rec = JSON.parse(buf.toString('utf8'));
    } catch (e) { return json(res, { error: String(e && e.message || e) }, 404); }
    return json(res, rec);
  }

  json(res, { error: 'not found' }, 404);
}

module.exports = { handle, record, available, registerOn, registerOff, registration, EVENTS };
