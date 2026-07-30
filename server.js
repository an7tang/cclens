#!/usr/bin/env node
/**
 * cclens — local proxy + dashboard that captures every Anthropic API request Claude Code makes.
 *
 * Usage:
 *   node server.js                                    # listen on :7700
 *   ANTHROPIC_BASE_URL=http://localhost:7700 claude   # route Claude Code through the proxy
 *   open http://localhost:7700                        # open the dashboard
 *
 * Environment variables:
 *   PORT                  listen port (default 7700)
 *   CCLENS_UPSTREAM  upstream API (default https://api.anthropic.com)
 *   CCLENS_DATA      data directory (default ~/.claude/cclens/data)
 *   CCLENS_HOME      relocate everything cclens stores (default ~/.claude/cclens)
 *
 * Storage model: messages / system prompts / tool definitions are content-addressed-deduped
 * into blobs.jsonl (hashed after stripping cache_control, which moves between requests);
 * request records store only hash references — the repeated prefix accumulated across turns
 * is stored once, and prefix comparison thereby reduces to an LCP over hash arrays.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { StringDecoder } = require('string_decoder');
const transcripts = require('./transcripts'); // transcript viewer sub-tool
const hooks = require('./hooks'); // hook event layer sub-tool

const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 7700; // keep in sync with DEFAULT_PORT in bin/cclens.js
const UPSTREAM = new URL(process.env.CCLENS_UPSTREAM || 'https://api.anthropic.com');

// Dashboard API generation number — the server process is long-lived, but static files are
// read fresh from disk on every request: after a code upgrade the old process serves the new
// page (whose new UI calls routes that don't exist). Bump +1 whenever a /__lens/* endpoint is
// added/changed, in sync with EXPECT_API_GEN in public/app.js; the page uses it to prompt
// "please restart the dashboard".
// Iron rule: whenever server-side data fields the frontend logic depends on are added or
// removed (not just new routes), it MUST be bumped — otherwise the handshake still passes when
// an old process serves the new page, and the new UI silently distorts on missing data (worse
// than a 404).
// gen 6: newTuids on session items (hook join attribution) + paired flag on hook events (collapse criterion)
const API_GEN = 6;
const paths = require('./paths');
const DATA_DIR = paths.dataDir();
const PUBLIC_DIR = path.join(__dirname, 'public');

paths.ensureDataDir(DATA_DIR); // seeds the .gitignore that keeps captures out of a dotfiles repo
const BLOBS_FILE = path.join(DATA_DIR, 'blobs.jsonl');
const RECORDS_FILE = path.join(DATA_DIR, 'requests.jsonl');

// ---------------------------------------------------------------- utilities

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/** Deep-copy and strip cache_control — it moves position between requests and must not participate in the content hash */
function stripCacheControl(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(stripCacheControl);
  const out = {};
  for (const k of Object.keys(v)) {
    if (k === 'cache_control') continue;
    out[k] = stripCacheControl(v[k]);
  }
  return out;
}

function lcpLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// ---------------------------------------------------------------- storage

const blobs = new Map();      // hash -> value
const records = [];           // in write-to-disk order
const recordById = new Map();

function loadJsonl(file, fn) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { fn(JSON.parse(line)); } catch { /* skip corrupted lines */ }
  }
}

const recordIndex = new Map(); // id -> records[] index (same id: later write wins — write-ahead pending + done on completion)
const sessionCache = new Map(); // sessionKey -> buildSession result (invalidated when a new record for that session hits disk)

function upsertLoaded(r) {
  if (recordIndex.has(r.id)) records[recordIndex.get(r.id)] = r;
  else { recordIndex.set(r.id, records.length); records.push(r); }
  recordById.set(r.id, r);
}

loadJsonl(BLOBS_FILE, o => { if (o && o.h) blobs.set(o.h, o.v); });
loadJsonl(RECORDS_FILE, r => { if (r && r.id) upsertLoaded(r); });
// Requests still in flight when their capture process exited: mark as aborted rather than pending forever.
// If the request is in fact still live in another process, its completion line lands in the store within a
// second or two and the tailer below corrects this record — so the claim is only made about the record as
// it stands on disk right now, which is all this process can honestly know at startup.
for (const r of records) {
  if (r.phase === 'pending') { r.phase = 'done'; r.error = r.error || 'no completion recorded — the capturing process exited mid-request (outcome unknown)'; r.clientAborted = true; }
}

// Appends are single writeSync calls on O_APPEND descriptors rather than buffered streams, because
// capture and viewing are now separate processes (`cclens claude` runs its own proxy) and two capturers
// can therefore share this store. A buffered stream may split one record across several write() syscalls,
// which interleaves into corrupt lines that the loader silently skips — losing records outright. One
// write() per line appends atomically. It also leaves nothing in a userland buffer if a capture is killed.
const blobFd = fs.openSync(BLOBS_FILE, 'a');
const recordFd = fs.openSync(RECORDS_FILE, 'a');
const ownIds = new Set(); // ids this process wrote — the tailer below must not re-apply our own appends

let dedupSavedBytes = 0;

function putBlob(value) {
  const s = stableStringify(value);
  const h = sha1(s);
  if (!blobs.has(h)) {
    blobs.set(h, value);
    fs.writeSync(blobFd, JSON.stringify({ h, v: value }) + '\n');
  } else {
    dedupSavedBytes += Buffer.byteLength(s);
  }
  return h;
}

function saveRecord(rec) {
  upsertLoaded(rec);
  sessionCache.delete(sessionKey(rec)); // session analysis recomputed on demand
  ownIds.add(rec.id);
  fs.writeSync(recordFd, JSON.stringify(rec) + '\n');
}

let idCounter = 0;
function newId() {
  return 'r' + Date.now().toString(36) + '-' + (++idCounter).toString(36);
}

// ---------------------------------------------------------------- live SSE (real-time push to the UI)

const liveClients = new Set();

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of liveClients) {
    try { res.write(msg); } catch { liveClients.delete(res); }
  }
}

setInterval(() => {
  for (const res of liveClients) {
    try { res.write(': ping\n\n'); } catch { liveClients.delete(res); }
  }
}, 25000).unref();

// ---------------------------------------------------------------- store tailing (follow another process's captures)
// Capture and viewing are separate processes: `cclens claude` runs its own proxy and writes here, while the
// page you have open is served by a different process. Both files are append-only JSONL, so following them
// is a byte offset plus a stat — no watcher whose semantics differ per platform, and no dependency.
// Without this, an open dashboard would sit frozen on whatever it loaded at startup.
let recordsPos = fileSize(RECORDS_FILE);
let blobsPos = fileSize(BLOBS_FILE);

function fileSize(f) {
  try { return fs.statSync(f).size; } catch { return 0; }
}

/** Read whole lines appended past `pos`; returns the new offset. A trailing partial line is left for next time. */
function tailFile(file, pos, fn) {
  const size = fileSize(file);
  if (size < pos) return size; // truncated or replaced (e.g. the data dir was wiped) — resync rather than read garbage
  if (size === pos) return pos;
  let buf;
  const fd = fs.openSync(file, 'r');
  try {
    buf = Buffer.allocUnsafe(size - pos);
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    if (n < buf.length) buf = buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
  const end = buf.lastIndexOf(0x0a); // slice on the buffer, not the string: a multi-byte char split across
  if (end < 0) return pos;           // reads would make character offsets lie about byte offsets
  for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { fn(JSON.parse(line)); } catch { /* skip corrupted lines, same as the initial load */ }
  }
  return pos + end + 1;
}

function tailStore() {
  blobsPos = tailFile(BLOBS_FILE, blobsPos, o => { if (o && o.h && !blobs.has(o.h)) blobs.set(o.h, o.v); });
  const fresh = [];
  recordsPos = tailFile(RECORDS_FILE, recordsPos, r => {
    // Skip ids we wrote ourselves: our own appends are already in memory, and replaying the write-ahead
    // 'pending' line after the 'done' line has replaced it would walk the record backwards.
    if (!r || !r.id || ownIds.has(r.id)) return;
    upsertLoaded(r);
    sessionCache.delete(sessionKey(r));
    fresh.push(r);
  });
  for (const r of fresh) {
    if (r.phase === 'pending') {
      broadcast('start', {
        id: r.id, ts: r.ts, kind: r.kind, model: r.model || null,
        sessionId: r.sessionId || null, path: r.path, purpose: r.purpose || null,
      });
    } else {
      broadcast('end', {
        id: r.id, sessionId: r.sessionId || null, kind: r.kind,
        status: r.status, aborted: !!r.clientAborted,
      });
    }
  }
}

setInterval(tailStore, 1000).unref();

// The dashboard must never go down over a single exception — every request during the outage would be lost
process.on('uncaughtException', e => console.error('[cclens] uncaughtException:', e));
process.on('unhandledRejection', e => console.error('[cclens] unhandledRejection:', e));

// ---------------------------------------------------------------- request capture

const REDACT_HEADERS = new Set(['x-api-key', 'authorization', 'cookie', 'proxy-authorization']);

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const s = Array.isArray(v) ? v.join(', ') : String(v);
    out[k] = REDACT_HEADERS.has(k.toLowerCase())
      ? s.slice(0, 12) + '…(redacted)…' + s.slice(-4)
      : s;
  }
  return out;
}

function classifyPath(p) {
  const clean = p.split('?')[0];
  if (/\/v1\/messages\/count_tokens/.test(clean)) return 'count_tokens';
  if (/\/v1\/messages\/batches/.test(clean)) return 'batch';
  if (/\/v1\/messages$/.test(clean)) return 'messages';
  return 'other';
}

const SESSION_RE = /session[_-]([0-9a-zA-Z][0-9a-zA-Z-]{7,})/;

function extractSession(body, headers) {
  const uid = body && body.metadata && body.metadata.user_id;
  if (typeof uid === 'string') {
    // Newer CLI: user_id is a JSON string of the form {"device_id":…,"account_uuid":…,"session_id":…}
    if (uid[0] === '{') {
      try {
        const j = JSON.parse(uid);
        if (j && typeof j.session_id === 'string' && j.session_id.length >= 8) {
          return { sessionId: j.session_id.slice(0, 36), userId: uid };
        }
      } catch {}
    }
    const m = uid.match(SESSION_RE); // older CLI: …_session_xxxx
    if (m) return { sessionId: m[1].slice(0, 36), userId: uid };
  }
  // Request-header fallback (count_tokens, startup probes etc. carry it too)
  const h = headers && headers['x-claude-code-session-id'];
  if (typeof h === 'string' && h.length >= 8) {
    return { sessionId: h.slice(0, 36), userId: typeof uid === 'string' ? uid : null };
  }
  if (typeof uid === 'string') return { sessionId: 'uid-' + sha1(uid).slice(0, 8), userId: uid };
  return { sessionId: null, userId: null };
}

/** Lightweight summary of one message (role + content block types), so list views don't need to dereference blobs */
function summarizeMessage(msg) {
  const roles = { role: msg.role, blocks: [] };
  const content = msg.content;
  if (typeof content === 'string') {
    roles.blocks.push('text');
    return roles;
  }
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') roles.blocks.push('tool_use:' + (b.name || '?'));
      else if (b.type === 'tool_result') roles.blocks.push('tool_result' + (b.is_error ? ':error' : ''));
      else roles.blocks.push(b.type || '?');
    }
  }
  return roles;
}

/** Record cache_control breakpoint positions; refilled by position when reconstructing the original request */
function collectCacheMarkers(body) {
  const markers = [];
  const scan = (loc, arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item, i) => {
      if (item && item.cache_control) markers.push({ loc, i, cc: item.cache_control });
      if (item && Array.isArray(item.content)) {
        item.content.forEach((b, bi) => {
          if (b && b.cache_control) markers.push({ loc, i, b: bi, cc: b.cache_control });
        });
      }
    });
  };
  scan('system', Array.isArray(body.system) ? body.system : null);
  scan('tools', body.tools);
  scan('messages', body.messages);
  if (body.cache_control) markers.push({ loc: 'top', cc: body.cache_control });
  return markers;
}

/**
 * Parse SSE text into an array of events.
 * chunkMeta (optional) is per-network-chunk {off: char offset, t: ms since request start} —
 * when present, each event is stamped with an arrival time t (the time of the chunk containing
 * its terminator), from which generation dynamics (thinking duration, stall, tok/s) can be
 * computed. Old archives have no t; the UI must degrade gracefully.
 */
function parseSSE(text, chunkMeta) {
  const events = [];
  const timeAt = chunkMeta && chunkMeta.length ? pos => {
    let lo = 0, hi = chunkMeta.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chunkMeta[mid].off <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return chunkMeta[ans].t;
  } : null;
  const pushEvent = (raw, endPos) => {
    if (!raw.trim()) return;
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    let data = dataLines.join('\n');
    try { data = JSON.parse(data); } catch { /* keep raw text */ }
    const ev = { event, data };
    if (timeAt) ev.t = timeAt(endPos);
    events.push(ev);
  };
  const re = /\r?\n\r?\n/g;
  let start = 0, m;
  while ((m = re.exec(text))) {
    pushEvent(text.slice(start, m.index), m.index + m[0].length - 1);
    start = re.lastIndex;
  }
  if (start < text.length) pushEvent(text.slice(start), text.length - 1); // trailing partial event from an aborted stream
  return events;
}

/** Reassemble the complete response message from the SSE event stream */
function assembleFromSSE(events) {
  let msg = null;
  let error = null;
  for (const ev of events) {
    const d = ev.data;
    if (!d || typeof d !== 'object') continue;
    switch (d.type) {
      case 'message_start':
        msg = JSON.parse(JSON.stringify(d.message || {}));
        msg.content = msg.content || [];
        break;
      case 'content_block_start':
        if (msg) msg.content[d.index] = JSON.parse(JSON.stringify(d.content_block || {}));
        break;
      case 'content_block_delta': {
        if (!msg) break;
        const block = msg.content[d.index];
        if (!block) break;
        const delta = d.delta || {};
        if (delta.type === 'text_delta') block.text = (block.text || '') + delta.text;
        else if (delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + delta.thinking;
        else if (delta.type === 'input_json_delta') block._pj = (block._pj || '') + delta.partial_json;
        else if (delta.type === 'signature_delta') block.signature = delta.signature;
        else if (delta.type === 'citations_delta') { block.citations = block.citations || []; block.citations.push(delta.citation); }
        break;
      }
      case 'content_block_stop': {
        if (!msg) break;
        const block = msg.content[d.index];
        if (block && block._pj !== undefined) {
          try { block.input = JSON.parse(block._pj || '{}'); } catch { block.input_raw = block._pj; }
          delete block._pj;
        }
        break;
      }
      case 'message_delta':
        if (msg) {
          Object.assign(msg, d.delta || {});
          if (d.usage) msg.usage = Object.assign(msg.usage || {}, d.usage);
        }
        break;
      case 'error':
        error = d.error || d;
        break;
    }
  }
  return { message: msg, error };
}

function textOfMsg(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
  return '';
}

/**
 * Request identity classification — beyond the main conversation, Claude Code makes many
 * bypass background calls; distinguish them by request content features:
 *   main    main conversation chain
 *   probe   startup probe ("quota" single message, often a 404 on the [1m] model)
 *   title   session title generation      recap  recap summary on return after stepping away
 *   suggest input suggestions (SUGGESTION MODE)   topic  topic-change detection
 *   summary context compaction summary generation   aux  other tool-less bypass calls
 */
function computePurpose(rec) {
  if (rec.kind !== 'messages' || !Array.isArray(rec.msgHashes) || !rec.msgHashes.length) return null;
  const first = textOfMsg(blobs.get(rec.msgHashes[0]));
  const last = textOfMsg(blobs.get(rec.msgHashes[rec.msgHashes.length - 1]));
  if (rec.msgHashes.length === 1 && first.trim() === 'quota') return 'probe';
  if (first.startsWith('Perform a web search for the query:')) return 'websearch'; // model call made internally by the WebSearch tool
  // /goal's Stop-hook evaluation: a separate "advisor" holding the full conversation history judges whether the goal is met, deciding whether to keep pushing the main agent
  if (/has the following stopping condition been satisfied/.test(last)) return 'advisor';
  // Tool permission review: conversation summary + blocking policy, deciding whether a given tool call is allowed
  if (first.startsWith('<transcript>') && /<block>|Err on the side of blocking/.test(last)) return 'guard';
  if (/Write the title in the predominant language/.test(last)) return 'title';
  if (/The user stepped away/.test(last)) return 'recap';
  if (/SUGGESTION MODE/.test(last)) return 'suggest';
  if (/new conversation topic/i.test(last)) return 'topic';
  if (/detailed summary of the conversation/.test(last)) return 'summary';
  if (!rec.toolCount) return 'aux'; // Claude Code main chain requests always carry the full tool set
  return 'main';
}

const purposeCache = new WeakMap();
function purposeOf(rec) {
  // Compute-on-read first — as classification rules evolve, archived records benefit equally; the stored value is only a fallback when blobs are missing
  if (purposeCache.has(rec)) return purposeCache.get(rec);
  const p = computePurpose(rec) || rec.purpose || null;
  purposeCache.set(rec, p);
  return p;
}

const AUX_PURPOSES = new Set(['probe', 'title', 'recap', 'suggest', 'topic', 'summary', 'websearch', 'advisor', 'guard', 'aux']);

// ---------------------------------------------------------------- agent identity
// Every Claude Code request carries billing metadata on the first line of system (100% coverage in practice):
//   x-anthropic-billing-header: cc_version=…; cc_entrypoint=cli; cc_is_subagent=true;
// Requests from subagents (Agent/Task tools), agent team teammates, and workflow agents carry
// cc_is_subagent=true, plus an x-claude-code-agent-id request header — all requests of one
// agent (including WebSearch internal calls it triggers) share a single id. Spawn lineage can
// be a hard link, no guessing needed:
//   spawn tool_use (Agent/Task) in the parent chain's response
//     → corresponding tool_result text contains "agentId: xxx"
//     → subagent request header x-claude-code-agent-id: xxx

function sysTextOf(rec) {
  const v = rec.systemHash ? blobs.get(rec.systemHash) : null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(b => (b && b.text) || '').join('\n');
  return '';
}

const ccMetaCache = new WeakMap();
/** Parse billing metadata from the first line of system; null if absent */
function ccMetaOf(rec) {
  if (ccMetaCache.has(rec)) return ccMetaCache.get(rec);
  let meta = null;
  const line = sysTextOf(rec).slice(0, 400).split('\n', 1)[0];
  if (line.startsWith('x-anthropic-billing-header:')) {
    meta = {
      version: (line.match(/cc_version=([\w.]+)/) || [])[1] || null,
      entrypoint: (line.match(/cc_entrypoint=([\w-]+)/) || [])[1] || null,
      subagent: /cc_is_subagent=true/.test(line),
    };
  }
  ccMetaCache.set(rec, meta);
  return meta;
}

function agentIdOf(rec) {
  const h = rec.reqHeaders && rec.reqHeaders['x-claude-code-agent-id'];
  return typeof h === 'string' && h.length >= 6 ? h : null;
}

const SPAWN_TOOLS = new Set(['Agent', 'Task', 'dispatch_agent']);
const AGENT_ID_RE = /agentId:\s*'?([A-Za-z0-9][\w@.-]{5,})'?/;

/** Spawn tool_use in the response (the primary scene — this request actually initiated the spawn) */
const respSpawnCache = new WeakMap();
function spawnsOfResponse(rec) {
  if (respSpawnCache.has(rec)) return respSpawnCache.get(rec);
  let out = null;
  const c = rec.response && rec.response.content;
  if (Array.isArray(c)) {
    for (const b of c) {
      if (b && b.type === 'tool_use' && SPAWN_TOOLS.has(b.name) && b.input && typeof b.input === 'object') {
        (out = out || []).push({ toolUseId: b.id || null, name: b.name, input: b.input });
      }
    }
  }
  respSpawnCache.set(rec, out);
  return out;
}

/** Agent clues inside message blobs: assistant spawn tool_use (fallback when the response is lost) + agentId back-links in tool_results */
const blobFactsCache = new Map(); // hash -> {spawns, links} | null (cached by content hash; each blob is scanned once)
function factsOfMsgBlob(hash) {
  let f = blobFactsCache.get(hash);
  if (f !== undefined) return f;
  f = null;
  const m = blobs.get(hash);
  if (m && Array.isArray(m.content)) {
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && SPAWN_TOOLS.has(b.name) && b.input && typeof b.input === 'object') {
        (f = f || { spawns: [], links: [] }).spawns.push({ toolUseId: b.id || null, name: b.name, input: b.input });
      } else if (b.type === 'tool_result' && b.tool_use_id) {
        const text = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map(c => (c && c.text) || '').join('\n') : '';
        // agentId appears in the leading metadata of the spawn result; scanning the first 1500 chars is enough
        const mm = text && text.includes('agentId') ? text.slice(0, 1500).match(AGENT_ID_RE) : null;
        if (mm) (f = f || { spawns: [], links: [] }).links.push({ toolUseId: b.tool_use_id, agentId: mm[1] });
      }
    }
  }
  blobFactsCache.set(hash, f);
  return f;
}

function usageOf(rec) {
  const u = (rec.response && rec.response.usage) || {};
  return {
    input: u.input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    output: u.output_tokens || 0,
  };
}

/** Names of all tool_uses in the response (in-order, deduped) — used by gap attribution to show which tools ran locally */
function toolNamesOfResponse(rec) {
  const c = rec && rec.response && rec.response.content;
  if (!Array.isArray(c)) return null;
  const names = [];
  for (const b of c) {
    if (b && b.type === 'tool_use' && b.name && !names.includes(b.name)) names.push(b.name);
  }
  return names.length ? names : null;
}

/** The request's cache TTL (ttl from cache_control markers; default ephemeral 5 minutes) */
function cacheTtlMs(rec) {
  for (const m of rec.cacheMarkers || []) {
    if (m.cc && m.cc.ttl === '1h') return 3600_000;
  }
  return 300_000;
}

// ---------------------------------------------------------------- streaming generation dynamics
// Once SSE events carry arrival time t we can compute: per-content-block-type (thinking/text/
// tool_use) generation duration, maximum stall, and time of the first text delta. Returns null
// when archived events have no t.

const streamStatsCache = new WeakMap();
function streamStatsOf(rec) {
  if (streamStatsCache.has(rec)) return streamStatsCache.get(rec);
  let out = null;
  const evs = rec.sse && rec.sse.events;
  if (Array.isArray(evs) && evs.length && evs.some(e => typeof e.t === 'number')) {
    const phase = {};          // block type -> cumulative generation ms
    const startT = new Map();  // content block index -> {t, type}
    let prevT = null, maxStall = 0, firstTextT = null;
    for (const ev of evs) {
      const t = typeof ev.t === 'number' ? ev.t : null;
      if (t != null) {
        if (prevT != null && t - prevT > maxStall) maxStall = t - prevT;
        prevT = t;
      }
      const d = ev.data;
      if (!d || typeof d !== 'object') continue;
      switch (d.type) {
        case 'content_block_start':
          if (t != null) startT.set(d.index, { t, type: (d.content_block && d.content_block.type) || '?' });
          break;
        case 'content_block_delta':
          if (firstTextT == null && t != null && d.delta && d.delta.type === 'text_delta') firstTextT = t;
          break;
        case 'content_block_stop': {
          const s = startT.get(d.index);
          if (s && t != null) {
            phase[s.type] = (phase[s.type] || 0) + (t - s.t);
            startT.delete(d.index);
          }
          break;
        }
      }
    }
    out = { phase, maxStall, firstTextT };
  }
  streamStatsCache.set(rec, out);
  return out;
}

// ---------------------------------------------------------------- full-text search
// "Which request mentioned X" — searches message text / tool_use params / tool_result content /
// response content. Content-addressed dedup pays off again here: each blob is searched once;
// the repeated prefix resent across turns is reported only for the "first occurrence" request
// (the scene where the content first appeared at the API layer), so results aren't drowned by lineage.

/** Collect all strings in a value (skipping base64 data / signature) — readable and searchable */
function searchableText(v) {
  const parts = [];
  const walk = x => {
    if (x == null) return;
    if (typeof x === 'string') { parts.push(x); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === 'object') {
      for (const k of Object.keys(x)) {
        if (k === 'data' || k === 'signature') continue;
        walk(x[k]);
      }
    }
  };
  walk(v);
  return parts.join('\n');
}

const blobSearchCache = new Map(); // hash -> {text, lower} (built lazily; memory cost only paid when searching)
function blobSearchEntry(h) {
  let e = blobSearchCache.get(h);
  if (e === undefined) {
    const text = searchableText(blobs.get(h));
    e = { text, lower: text.toLowerCase() };
    blobSearchCache.set(h, e);
  }
  return e;
}

const respSearchCache = new WeakMap(); // rec -> {text, lower} (response appears once at completion, safe to cache)
function respSearchEntry(rec) {
  let e = respSearchCache.get(rec);
  if (e === undefined) {
    const text = rec.response && rec.response.content
      ? searchableText(rec.response.content)
      : (typeof rec.responseText === 'string' ? rec.responseText : ''); // raw-text fallback for error/aborted responses
    e = { text, lower: text.toLowerCase() };
    respSearchCache.set(rec, e);
  }
  return e;
}

function snippetAround(entry, q) {
  const idx = entry.lower.indexOf(q);
  if (idx < 0) return null;
  const start = Math.max(0, idx - 60);
  return {
    before: (start > 0 ? '…' : '') + entry.text.slice(start, idx).replace(/\s+/g, ' '),
    match: entry.text.slice(idx, idx + q.length),
    after: entry.text.slice(idx + q.length, idx + q.length + 90).replace(/\s+/g, ' ') + (idx + q.length + 90 < entry.text.length ? '…' : ''),
  };
}

/** Query tokenization: whitespace-split with AND; single CJK chars allowed (a single Chinese char is a meaningful query), single ASCII chars are too broad and still need 2+ */
function searchTerms(query) {
  return String(query || '').toLowerCase().split(/\s+/)
    .filter(t => t.length >= (/[^\x00-\x7f]/.test(t) ? 1 : 2))
    .slice(0, 8);
}

function searchAll(query, limit = 50) {
  const terms = searchTerms(query);
  if (!terms.length) return { query, results: [] };
  const matches = lower => terms.every(t => lower.includes(t));
  const anchor = terms[0]; // snippet is anchored on the first term
  const blobHit = new Map();   // hash -> boolean
  const seenBlob = new Set();  // blobs already reported (first occurrence only — repeated prefixes don't drown results)
  const results = [];
  const push = (rec, where, role, snippet) => results.push({
    id: rec.id, sessionId: sessionKey(rec), ts: rec.ts, model: rec.model || null, where, role, snippet,
  });
  const pushBlob = (rec, h, where, role) => {
    let hit = blobHit.get(h);
    if (hit === undefined) { hit = matches(blobSearchEntry(h).lower); blobHit.set(h, hit); }
    if (!hit || seenBlob.has(h)) return;
    seenBlob.add(h);
    push(rec, where, role, snippetAround(blobSearchEntry(h), anchor));
  };
  for (const rec of records) { // records are in disk order ≈ time order — first occurrence is the earliest scene
    if (Array.isArray(rec.msgHashes)) {
      for (let i = 0; i < rec.msgHashes.length; i++) {
        pushBlob(rec, rec.msgHashes[i], 'message', (rec.msgMeta && rec.msgMeta[i] && rec.msgMeta[i].role) || '?');
      }
      if (rec.systemHash) pushBlob(rec, rec.systemHash, 'system', 'system');
      if (rec.toolsHash) pushBlob(rec, rec.toolsHash, 'tools', 'tools');
    } else if (rec.requestBody) {
      // Non-message-body requests (no content addressing) — direct full-text match; too few to bother caching
      const text = searchableText(rec.requestBody);
      const lower = text.toLowerCase();
      if (matches(lower)) push(rec, 'request', rec.kind || 'request', snippetAround({ text, lower }, anchor));
    }
    if (rec.response || typeof rec.responseText === 'string') {
      const e = respSearchEntry(rec);
      if (e.text && matches(e.lower)) push(rec, 'response', 'assistant', snippetAround(e, anchor));
    }
  }
  results.sort((a, b) => b.ts - a.ts); // newest first
  return { query, total: results.length, results: results.slice(0, limit) };
}

/** Snapshot of anthropic-ratelimit-* headers from the most recent response (account-level rate-limit state) */
function rateLimitSnapshot() {
  for (let i = records.length - 1; i >= 0; i--) {
    const h = records[i].resHeaders;
    if (!h) continue;
    let out = null;
    for (const k of Object.keys(h)) {
      if (k.startsWith('anthropic-ratelimit-')) (out = out || {})[k] = h[k];
    }
    if (out) return { ts: records[i].ts, headers: out };
  }
  return null;
}

/**
 * Build a request record. phase='pending' is written ahead the moment the request arrives
 * (guaranteeing a trace regardless of outcome); phase='done' overwrites with the response side
 * on completion/abort (JSONL appends a line with the same id; on load, later writes win).
 */
function buildRec(ctx, phase) {
  const rec = {
    id: ctx.id,
    ts: ctx.start,
    method: ctx.method,
    path: ctx.path,
    kind: ctx.kind,
    phase,
    status: ctx.status || 0,
    reqHeaders: ctx.reqHeaders,
    resHeaders: ctx.resHeaders || {},
    timing: { start: ctx.start, firstByte: ctx.firstByte || null, end: phase === 'done' ? Date.now() : null },
    reqSize: ctx.reqSize || 0,
    resSize: ctx.resSize || 0,
    error: ctx.error || null,
    clientAborted: !!ctx.clientAborted,
  };

  const body = ctx.body;
  if (body && (ctx.kind === 'messages' || ctx.kind === 'count_tokens')) {
    const sess = extractSession(body, ctx.reqHeaders);
    rec.model = body.model || null;
    rec.stream = !!body.stream;
    rec.sessionId = sess.sessionId;
    rec.userId = sess.userId;

    const norm = stripCacheControl(body);
    rec.systemHash = norm.system !== undefined ? putBlob(norm.system) : null;
    rec.toolsHash = Array.isArray(norm.tools) && norm.tools.length ? putBlob(norm.tools) : null;
    rec.toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
    rec.msgHashes = (norm.messages || []).map(m => putBlob(m));
    rec.msgMeta = (body.messages || []).map(summarizeMessage);
    rec.cacheMarkers = collectCacheMarkers(body);
    const { system, tools, messages, metadata, ...rest } = body;
    rec.bodyRest = rest;
    rec.metadata = metadata || null;
  } else if (body) {
    rec.requestBody = body;
    rec.sessionId = null;
  } else {
    rec.sessionId = null;
  }
  if (!rec.sessionId) {
    // Any request (including GET probes) that carries the session header is assigned to that session
    const h = ctx.reqHeaders && ctx.reqHeaders['x-claude-code-session-id'];
    if (typeof h === 'string' && h.length >= 8) rec.sessionId = h.slice(0, 36);
  }
  rec.purpose = computePurpose(rec);

  if (phase !== 'done') return rec;

  // Response (on abort, still parse the partial stream received — you can see what was generated before the interruption)
  if (ctx.sseEvents) {
    const { message, error } = assembleFromSSE(ctx.sseEvents);
    rec.response = message;
    rec.sse = { count: ctx.sseEvents.length, events: ctx.sseEvents };
    if (error) rec.responseError = error;
  } else if (ctx.resText) {
    try { rec.response = JSON.parse(ctx.resText); }
    catch { rec.responseText = ctx.resText.slice(0, 20000); }
    if (rec.response && rec.response.type === 'error') {
      rec.responseError = rec.response.error;
    }
  }
  return rec;
}

/** Write-ahead capture on arrival — whatever happens later (abort/crash/timeout), the request itself is never lost */
function preRecord(ctx) {
  const rec = buildRec(ctx, 'pending');
  saveRecord(rec);
  broadcast('start', {
    id: rec.id, ts: rec.ts, kind: rec.kind, model: rec.model || null,
    sessionId: rec.sessionId || null, path: rec.path, purpose: rec.purpose || null,
  });
}

function finalize(ctx) {
  const rec = buildRec(ctx, 'done');
  saveRecord(rec);
  broadcast('end', {
    id: rec.id, sessionId: rec.sessionId || null, kind: rec.kind,
    status: rec.status, aborted: !!rec.clientAborted,
  });
}

// ---------------------------------------------------------------- upstream proxy

// Upstream connection reuse (keep-alive), so each request doesn't pay a TLS handshake
const upstreamAgent = UPSTREAM.protocol === 'https:'
  ? new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 32 })
  : new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 32 });

function proxyRequest(req, res, bodyBuf) {
  const id = newId();
  const kind = classifyPath(req.url);
  let body = null;
  if (bodyBuf.length) {
    try { body = JSON.parse(bodyBuf.toString('utf8')); } catch { /* not JSON */ }
  }

  const ctx = {
    id,
    start: Date.now(),
    method: req.method,
    path: req.url,
    kind,
    body,
    reqHeaders: redactHeaders(req.headers),
    reqSize: bodyBuf.length,
  };

  // Write-ahead: a record exists as soon as the request arrives; no outcome can lose it
  try { preRecord(ctx); } catch (e) { console.error('[cclens] preRecord failed:', e); }

  const chunks = [];
  const chunkTimes = []; // arrival time of each response chunk (ms since request start) — the raw basis for SSE event timing
  let total = 0;
  let isSSE = false;

  const completeCapture = () => {
    if (ctx.finalized) return;
    ctx.finalized = true;
    ctx.resSize = total;
    if (total) {
      if (isSSE) {
        // Decode chunk by chunk with StringDecoder (multi-byte chars may span chunk boundaries),
        // while recording each chunk's char offset — event time = arrival time of the chunk containing its terminator
        const dec = new StringDecoder('utf8');
        const meta = [];
        const parts = [];
        let off = 0;
        for (let i = 0; i < chunks.length; i++) {
          const s = dec.write(chunks[i]);
          meta.push({ off, t: chunkTimes[i] });
          off += s.length;
          parts.push(s);
        }
        parts.push(dec.end());
        ctx.sseEvents = parseSSE(parts.join(''), meta);
      } else {
        ctx.resText = Buffer.concat(chunks).toString('utf8');
      }
    }
    try { finalize(ctx); } catch (e) { console.error('[cclens] finalize failed:', e); }
  };

  const headers = { ...req.headers, host: UPSTREAM.host };
  delete headers['accept-encoding']; // guarantees plaintext is parseable, and simplifies pass-through
  delete headers['connection'];

  const mod = UPSTREAM.protocol === 'https:' ? https : http;
  const upReq = mod.request({
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port || (UPSTREAM.protocol === 'https:' ? 443 : 80),
    path: req.url,
    method: req.method,
    headers,
    agent: upstreamAgent,
  }, upRes => {
    ctx.status = upRes.statusCode;
    ctx.resHeaders = redactHeaders(upRes.headers);
    isSSE = /text\/event-stream/.test(upRes.headers['content-type'] || '');

    const outHeaders = { ...upRes.headers };
    delete outHeaders['connection'];
    delete outHeaders['keep-alive'];
    delete outHeaders['transfer-encoding'];
    try {
      res.writeHead(upRes.statusCode, outHeaders);
      if (res.flushHeaders) res.flushHeaders();
    } catch { /* client may have disconnected */ }

    upRes.on('data', c => {
      if (!ctx.firstByte) ctx.firstByte = Date.now();
      chunkTimes.push(Date.now() - ctx.start);
      chunks.push(c);
      total += c.length;
      if (!res.destroyed && res.writable) {
        try { res.write(c); } catch {} // pass through immediately, adding no streaming latency
      }
    });
    upRes.on('end', () => {
      try { res.end(); } catch {}
      completeCapture();
    });
    upRes.on('error', e => {
      ctx.error = ctx.error || ('upstream response error: ' + e.message);
      try { res.end(); } catch {}
      completeCapture();
    });
    upRes.on('aborted', () => {
      ctx.error = ctx.error || 'upstream connection aborted';
      try { res.end(); } catch {}
      completeCapture();
    });
  });

  // Client abort (user pressed Esc / sent a new message interrupting the stream) —
  // save the partial output received and mark aborted, and immediately disconnect upstream to stop pointless generation
  res.on('close', () => {
    if (ctx.finalized) return;
    ctx.clientAborted = true;
    ctx.error = ctx.error || 'client aborted (user interrupt or connection closed)';
    try { upReq.destroy(); } catch {}
    completeCapture();
  });

  upReq.on('error', e => {
    if (ctx.finalized) return; // the destroy triggered by a client abort also lands here
    ctx.error = 'upstream connection error: ' + e.message;
    ctx.status = ctx.status || 502;
    if (!res.headersSent) {
      try {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: e.message } }));
      } catch {}
    } else {
      try { res.end(); } catch {}
    }
    completeCapture();
  });

  upReq.end(bodyBuf);
}

// ---------------------------------------------------------------- session / lineage analysis

function sessionKey(rec) {
  if (rec.sessionId) return rec.sessionId;
  if (rec.kind === 'messages' || rec.kind === 'count_tokens') {
    return 'anon-' + (rec.systemHash || 'nosys').slice(0, 8);
  }
  return '_misc';
}

/** User text fragment with injected content stripped — shared by session titles and the agent-label fallback */
function cleanLabel(raw) {
  return String(raw)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<\/?session>/g, ' ')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, ' ')
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Input identity of a user message — user text at the API layer is not necessarily typed by a human:
    it may be slash-command structure (<command-name>/loop etc. + args + stdout), local command
    output backfill, a post-compaction continuation summary, or pure injection (<system-reminder>:
    hooks / goal reminders / memory recall all come through here).
    A slash command is a first-class identity (an explicit user action); the old approach of
    stripping it to find the "original words" amounted to pretending it never happened. */
function classifyUserText(raw) {
  const s = String(raw || '');
  const cmd = s.match(/<command-name>\s*(\/?[\w.:-]+)\s*<\/command-name>/);
  if (cmd) {
    const args = (s.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    const name = cmd[1].startsWith('/') ? cmd[1] : '/' + cmd[1];
    return { kind: 'command', label: (name + ' ' + args.replace(/\s+/g, ' ').trim()).trim().slice(0, 60) };
  }
  if (/^\s*This session is being continued from a previous conversation/.test(s)) {
    return { kind: 'continuation', label: 'compaction continuation' };
  }
  const stripped = cleanLabel(s);
  if (stripped) return { kind: 'text', label: stripped };
  if (/<local-command-stdout>/.test(s)) {
    const out = (s.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/) || [])[1] || '';
    return { kind: 'stdout', label: out.replace(/\s+/g, ' ').trim().slice(0, 60) };
  }
  if (/<system-reminder>/.test(s)) {
    const inner = (s.match(/<system-reminder>\s*([\s\S]*?)<\/system-reminder>/) || [])[1] || '';
    const head = inner.replace(/^[#\s]+/, '').split('\n', 1)[0].replace(/\s+/g, ' ').trim();
    return { kind: 'reminder', label: head.slice(0, 60) };
  }
  return { kind: 'text', label: '' };
}

function buildOverview() {
  const sessions = new Map();
  for (const rec of records) {
    const key = sessionKey(rec);
    let s = sessions.get(key);
    if (!s) {
      s = {
        id: key, count: 0, firstTs: rec.ts, lastTs: rec.ts,
        models: {}, kinds: {}, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        errors: 0, main: 0, aux: 0, pending: 0, aborted: 0, agents: 0, _agentIds: new Set(),
      };
      sessions.set(key, s);
    }
    s.count++;
    // Agent counting: the agent-id header is exact; id-less subagents (foreground Task etc.) are approximated by first-message hash
    const aid = agentIdOf(rec);
    const cc = ccMetaOf(rec);
    const isAgentReq = !!aid || !!(cc && cc.subagent);
    if (aid) s._agentIds.add(aid);
    else if (cc && cc.subagent && Array.isArray(rec.msgHashes) && rec.msgHashes.length) {
      s._agentIds.add('h:' + rec.msgHashes[0]);
    }
    s.firstTs = Math.min(s.firstTs, rec.ts);
    s.lastTs = Math.max(s.lastTs, (rec.timing && rec.timing.end) || rec.ts);
    if (rec.model) s.models[rec.model] = (s.models[rec.model] || 0) + 1;
    s.kinds[rec.kind] = (s.kinds[rec.kind] || 0) + 1;
    if (rec.status >= 400 || rec.error) s.errors++;
    const p = purposeOf(rec);
    if (p === 'main' && !isAgentReq) s.main++; // main-chain definition matches the session view: agent requests excluded
    else if (AUX_PURPOSES.has(p) && !isAgentReq) s.aux++;
    if (rec.phase === 'pending') s.pending++;
    if (rec.clientAborted) s.aborted++;
    const u = usageOf(rec);
    s.usage.input += u.input; s.usage.cacheRead += u.cacheRead;
    s.usage.cacheWrite += u.cacheWrite; s.usage.output += u.output;
  }
  const list = [...sessions.values()].sort((a, b) => b.lastTs - a.lastTs);
  for (const s of list) {
    s.agents = s._agentIds.size;
    delete s._agentIds;
  }
  // Session title = the user text fragment (injected content stripped) from the session's first message, for telling sessions apart
  for (const s of list) {
    // Prefer main-conversation requests for the title — a bypass call's first message is an instruction template, a subagent's first message is its spawn task; neither is user content
    const isMainConvo = r => purposeOf(r) === 'main' && !agentIdOf(r) && !(ccMetaOf(r) || {}).subagent;
    const first =
      records.find(r => sessionKey(r) === s.id && Array.isArray(r.msgHashes) && r.msgHashes.length && isMainConvo(r)) ||
      records.find(r => sessionKey(r) === s.id && Array.isArray(r.msgHashes) && r.msgHashes.length);
    if (!first) continue;
    let label = '', labelKind = null;
    for (const h of first.msgHashes.slice(0, 3)) { // if the first message is all injection, look at the next two
      const m = blobs.get(h);
      if (!m) continue;
      let text = '';
      if (typeof m.content === 'string') text = m.content;
      else if (Array.isArray(m.content)) {
        const t = m.content.find(b => b && b.type === 'text' && cleanLabel(b.text));
        text = t ? t.text : (m.content.find(b => b && b.type === 'text') || {}).text || '';
      }
      const cls = classifyUserText(text);
      if (cls.label) { label = cls.label; labelKind = cls.kind; break; }
    }
    s.labelKind = labelKind;
    if (!label) {
      const m = blobs.get(first.msgHashes[0]);
      label = m && Array.isArray(m.content) ? ((m.content[0] && m.content[0].type) || '') : '';
    }
    s.label = label;
  }
  return {
    sessions: list,
    totals: {
      requests: records.length,
      capturedBytes: records.reduce((n, r) => n + (r.reqSize || 0) + (r.resSize || 0), 0),
      dedupSavedBytes,
      blobs: blobs.size,
      upstream: UPSTREAM.href,
      rateLimit: rateLimitSnapshot(),
      pid: process.pid, // shown by cclens status, and how a second `cclens` knows a viewer is already up
      apiGen: API_GEN,  // version handshake: when an old server process serves fresh-from-disk new UI files, the page uses this to prompt a restart
    },
    // Sub-tool toggle state (frontend shows/hides the corresponding entries); hooks = whether hook event data exists on disk
    features: { viewer: transcripts.enabled(), hooks: hooks.available() },
  };
}

/** Session analysis cache — the detail/session endpoints are called frequently; an active session recomputes only once per record written to disk */
function buildSession(sessionId) {
  let s = sessionCache.get(sessionId);
  if (!s) {
    s = computeSession(sessionId);
    sessionCache.set(sessionId, s);
  }
  return s;
}

/** Compute the parent-child chain relations of all requests in one session */
function computeSession(sessionId) {
  const recs = records.filter(r => sessionKey(r) === sessionId)
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

  // Only main chain requests participate in lineage derivation — bypass calls (title/recap/
  // suggest/probe etc.) share message prefixes but are not the same context bloodline; mixing them in only pollutes the chain structure
  const msgRecs = recs.filter(r =>
    r.kind === 'messages' && Array.isArray(r.msgHashes) && purposeOf(r) === 'main');
  const chainInfo = new Map(); // id -> {parent, lcp, relation, chainId}

  msgRecs.forEach((rec, i) => {
    // Parent = the earlier request with the longest shared prefix; ties prefer matching system/model, then the most recent
    let best = null, bestLcp = 0, bestSame = false;
    for (let j = i - 1; j >= 0 && j >= i - 200; j--) {
      const prev = msgRecs[j];
      const l = lcpLen(rec.msgHashes, prev.msgHashes);
      if (l === 0) continue;
      const same = prev.systemHash === rec.systemHash && prev.model === rec.model;
      if (l > bestLcp || (l === bestLcp && same && !bestSame)) {
        best = prev; bestLcp = l; bestSame = same;
      }
      if (bestSame && bestLcp === rec.msgHashes.length) break; // can't do better
    }
    // Context bloodline requires matching system and model; sharing some messages but with a
    // different system/model (e.g. background haiku title generation) is an independent call, not the same chain
    const sameCtx = bestSame;
    let relation, parent = null;
    if (!best || bestLcp === 0 || !sameCtx) {
      relation = i === 0 ? 'root' : 'branch';
    } else {
      parent = best;
      const pLen = best.msgHashes.length, sLen = rec.msgHashes.length;
      if (bestLcp === pLen && bestLcp === sLen) relation = 'retry';
      else if (bestLcp === pLen && sLen > pLen) relation = 'extends';
      else if (bestLcp < pLen && sLen < pLen) relation = 'compact';
      else relation = 'rewrite';
    }
    const chainId = parent ? chainInfo.get(parent.id).chainId : rec.id;
    chainInfo.set(rec.id, { parent, lcp: bestLcp, relation, chainId });
  });

  // ---- Agent identification: first gather all spawn points (Agent/Task tool_use) and agentId back-links ----
  const spawnByToolUse = new Map(); // toolUseId -> {rec|null, spawn} (rec=null means the response is missing and it was recovered from later messages)
  const agentIdToToolUse = new Map(); // agentId -> toolUseId
  for (const rec of recs) {
    if (rec.kind !== 'messages') continue;
    for (const s of spawnsOfResponse(rec) || []) {
      if (s.toolUseId && !spawnByToolUse.has(s.toolUseId)) spawnByToolUse.set(s.toolUseId, { rec, spawn: s });
    }
    if (!Array.isArray(rec.msgHashes)) continue;
    for (const h of rec.msgHashes) {
      const f = factsOfMsgBlob(h);
      if (!f) continue;
      for (const s of f.spawns) {
        if (s.toolUseId && !spawnByToolUse.has(s.toolUseId)) spawnByToolUse.set(s.toolUseId, { rec: null, spawn: s });
      }
      for (const l of f.links) {
        if (!agentIdToToolUse.has(l.agentId)) agentIdToToolUse.set(l.agentId, l.toolUseId);
      }
    }
  }

  // ---- Chain-level actor determination: is a chain the main conversation or some agent, three signal tiers in descending order ----
  //   1) x-claude-code-agent-id request header (newer CLI; aggregates one agent across chains)
  //   2) cc_is_subagent=true on the system billing first line (marked but id-less; aggregate per chain)
  //   3) the chain root's first message text contains some spawn tool_use's prompt (older CLI has no API-layer marker at all)
  const chainMembers = new Map(); // chainId -> recs (in time order)
  for (const rec of msgRecs) {
    const cid = chainInfo.get(rec.id).chainId;
    if (!chainMembers.has(cid)) chainMembers.set(cid, []);
    chainMembers.get(cid).push(rec);
  }
  const normWs = s => String(s).replace(/\s+/g, ' ').trim();
  const claimedSpawns = new Set();
  const chainActor = new Map(); // chainId -> actorKey | null
  const chainSpawn = new Map(); // actorKey -> spawn entry (direct product of a tier-3 match)
  const chainIds = [...chainMembers.keys()];
  for (const cid of chainIds) {
    const members = chainMembers.get(cid);
    let key = null;
    for (const m of members) { const aid = agentIdOf(m); if (aid) { key = 'agent:' + aid; break; } }
    if (!key && members.some(m => (ccMetaOf(m) || {}).subagent)) key = 'agent:chain:' + cid;
    if (!key && cid !== chainIds[0]) { // the session's first chain is the main chain; it doesn't participate in tier 3
      const root = members[0];
      const firstText = Array.isArray(root.msgHashes) && root.msgHashes.length
        ? normWs(textOfMsg(blobs.get(root.msgHashes[0]))) : '';
      if (firstText) {
        for (const [tuid, cand] of spawnByToolUse) {
          if (claimedSpawns.has(tuid)) continue;
          const spawnerChain = cand.rec && chainInfo.get(cand.rec.id);
          if (spawnerChain && spawnerChain.chainId === cid) continue; // a chain cannot spawn itself
          const prompt = normWs(String(cand.spawn.input.prompt || ''));
          if (prompt.length >= 20 && firstText.includes(prompt.slice(0, 200))) {
            key = 'agent:spawn:' + tuid;
            claimedSpawns.add(tuid);
            chainSpawn.set(key, cand);
            break;
          }
        }
      }
    }
    chainActor.set(cid, key);
  }

  // ---- Request attribution (actor): chain members follow their chain; off-chain requests (websearch and other bypass) rejoin via agent-id ----
  const actorOf = new Map(); // rec.id -> 'agent:xxx' | null
  const agents = new Map();  // actorKey -> agent aggregate
  for (const rec of recs) {
    const info = rec.kind === 'messages' ? chainInfo.get(rec.id) : null;
    const key = info ? chainActor.get(info.chainId) : (agentIdOf(rec) ? 'agent:' + agentIdOf(rec) : null);
    actorOf.set(rec.id, key);
    if (!key) continue;
    let a = agents.get(key);
    if (!a) {
      a = {
        key, agentId: agentIdOf(rec), label: null, type: null, toolName: null,
        spawnReqId: null, spawnToolUseId: null, parentKey: null,
        firstReqId: rec.id, firstTs: rec.ts, lastTs: rec.ts,
        count: 0, pending: 0, errors: 0, aborted: 0,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        models: new Set(), _firstMain: null,
      };
      agents.set(key, a);
    }
    a.count++;
    if (!a.agentId) a.agentId = agentIdOf(rec);
    a.lastTs = Math.max(a.lastTs, (rec.timing && rec.timing.end) || rec.ts);
    if (rec.phase === 'pending') a.pending++;
    if (rec.clientAborted) a.aborted++;
    if (!rec.clientAborted && (rec.error || rec.status >= 400) && rec.phase !== 'pending') a.errors++;
    if (rec.model) a.models.add(rec.model);
    const u = usageOf(rec);
    a.usage.input += u.input; a.usage.cacheRead += u.cacheRead;
    a.usage.cacheWrite += u.cacheWrite; a.usage.output += u.output;
    if (!a._firstMain && purposeOf(rec) === 'main') a._firstMain = rec;
  }

  // ---- Agent spawn-point resolution: hard links (agentId back-link) / chain-level prompt match first; fuzzy-match the rest ----
  const resolvedSpawn = new Map(); // actorKey -> spawn entry
  for (const a of agents.values()) {
    let sp = null;
    if (a.agentId && agentIdToToolUse.has(a.agentId)) {
      sp = spawnByToolUse.get(agentIdToToolUse.get(a.agentId)) || null;
    }
    if (!sp) sp = chainSpawn.get(a.key) || null;
    if (sp) {
      if (sp.spawn.toolUseId) claimedSpawns.add(sp.spawn.toolUseId);
      resolvedSpawn.set(a.key, sp);
    }
  }
  for (const a of agents.values()) {
    if (resolvedSpawn.has(a.key)) continue;
    // A background agent's tool_result contains agentId (hard link); a foreground agent's tool_result is the final answer —
    // the latter is matched by "the agent's first message contains the spawn prompt"
    const fr = a._firstMain || recordById.get(a.firstReqId);
    const firstText = fr && Array.isArray(fr.msgHashes) && fr.msgHashes.length
      ? normWs(textOfMsg(blobs.get(fr.msgHashes[0]))) : '';
    if (!firstText) continue;
    for (const [tuid, cand] of spawnByToolUse) {
      if (claimedSpawns.has(tuid)) continue;
      const prompt = normWs(String(cand.spawn.input.prompt || ''));
      if (prompt.length >= 20 && firstText.includes(prompt.slice(0, 200))) {
        claimedSpawns.add(tuid);
        resolvedSpawn.set(a.key, cand);
        break;
      }
    }
  }
  for (const a of agents.values()) {
    const sp = resolvedSpawn.get(a.key);
    if (sp) {
      a.toolName = sp.spawn.name;
      a.type = sp.spawn.input.subagent_type || sp.spawn.input.agentType || null;
      const promptHead = normWs(String(sp.spawn.input.prompt || '')).slice(0, 60);
      a.label = (sp.spawn.input.description ? String(sp.spawn.input.description) : promptHead) || null;
      a.spawnToolUseId = sp.spawn.toolUseId;
      if (sp.rec) {
        a.spawnReqId = sp.rec.id;
        a.parentKey = actorOf.get(sp.rec.id) || null; // agents spawning agents form nesting
      }
    }
    if (!a.label) {
      const fr = a._firstMain || recordById.get(a.firstReqId);
      if (fr && Array.isArray(fr.msgHashes)) {
        for (const h of fr.msgHashes.slice(0, 3)) {
          const l = cleanLabel(textOfMsg(blobs.get(h)));
          if (l) { a.label = l; break; }
        }
      }
      if (!a.label) a.label = 'unidentified agent';
    }
  }

  // ---- Lanes: main conversation chains first (the first one is the main chain), one lane per agent (by first-request time), bypass calls collected in the last lane ----
  const laneKeys = [];
  const laneKeyOf = rec => {
    const actor = actorOf.get(rec.id);
    if (actor) return actor;
    const info = chainInfo.get(rec.id);
    if (info) return 'chain:' + info.chainId;
    return '_aux';
  };
  for (const rec of recs) {
    const k = laneKeyOf(rec);
    if (k !== '_aux' && !laneKeys.includes(k)) laneKeys.push(k);
  }
  laneKeys.push('_aux');
  let chainNo = 0;
  const laneMeta = laneKeys.map(k => {
    if (k === '_aux') return { key: k, kind: 'aux', label: 'bypass' };
    if (k.startsWith('agent:')) {
      const a = agents.get(k);
      return { key: k, kind: 'agent', label: (a && a.label) || 'agent' };
    }
    chainNo++;
    return { key: k, kind: chainNo === 1 ? 'main' : 'branch', label: chainNo === 1 ? 'main chain' : 'branch ' + chainNo };
  });
  const laneIndex = new Map(laneKeys.map((k, i) => [k, i]));

  let seq = 0;
  const items = recs.map(rec => {
    const u = usageOf(rec);
    const info = chainInfo.get(rec.id);
    const pending = rec.phase === 'pending';
    const item = {
      id: rec.id,
      seq: ++seq,
      ts: rec.ts,
      end: rec.timing && rec.timing.end ? rec.timing.end : null,
      durMs: rec.timing && rec.timing.end ? rec.timing.end - rec.timing.start : null,
      pending,
      aborted: !!rec.clientAborted,
      purpose: purposeOf(rec),
      ttfbMs: rec.timing && rec.timing.firstByte ? rec.timing.firstByte - rec.timing.start : null,
      kind: rec.kind,
      path: rec.path,
      model: rec.model || null,
      status: rec.status,
      stream: !!rec.stream,
      usage: u,
      contextTokens: u.input + u.cacheRead + u.cacheWrite,
      msgCount: Array.isArray(rec.msgHashes) ? rec.msgHashes.length : null,
      toolCount: rec.toolCount || 0,
      stopReason: rec.response && rec.response.stop_reason || null,
      msgId: rec.response && rec.response.id || null, // API message id — same origin as message.id in transcript records; the join key for cross-layer deep links
      error: rec.error || (rec.responseError ? (rec.responseError.type || 'error') : null),
      sseCount: rec.sse ? rec.sse.count : null,
      reqSize: rec.reqSize, resSize: rec.resSize,
      inputTokensCounted: rec.kind === 'count_tokens' && rec.response ? rec.response.input_tokens : null,
    };
    item.agentKey = actorOf.get(rec.id) || null;
    item.lane = laneIndex.get(laneKeyOf(rec));
    if (rec.kind === 'messages') item.cacheTtlMs = cacheTtlMs(rec);
    // Streaming generation dynamics (needs event timing; omitted for old archives without it)
    const ss = pending ? null : streamStatsOf(rec);
    if (ss) {
      if (ss.phase && Object.keys(ss.phase).length) item.phases = ss.phase;
      if (ss.maxStall > 2000) item.stallMs = ss.maxStall;
      if (ss.firstTextT != null) item.firstTextMs = ss.firstTextT;
    }
    if (info) {
      item.relation = info.relation;
      // An agent chain's start is not "a branch with no shared prefix against existing chains" — it IS this agent's context origin
      if (item.agentKey && item.relation === 'branch') item.relation = 'root';
      item.parentId = info.parent ? info.parent.id : null;
      item.sharedPrefix = info.lcp;
      item.chainId = info.chainId;
      if (info.parent) {
        item.addedMsgs = (rec.msgMeta || []).slice(info.lcp);
        item.removedCount = Math.max(0, info.parent.msgHashes.length - info.lcp);
        item.systemChanged = rec.systemHash !== info.parent.systemHash;
        item.toolsChanged = rec.toolsHash !== info.parent.toolsHash;
      } else {
        item.addedMsgs = rec.msgMeta || [];
        item.removedCount = 0;
      }
    }
    // tool_result ids carried in the newly added messages — evidence for hook event join attribution (shared by the lineage narrative and the detail bill).
    // Only scan the added region (usually 1-2 messages), never replay the whole prefix
    if (rec.kind === 'messages' && Array.isArray(rec.msgHashes)) {
      const from = info && info.parent ? info.lcp : 0;
      let tuids = null;
      for (let i = from; i < rec.msgHashes.length; i++) {
        const m = blobs.get(rec.msgHashes[i]);
        if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
        for (const b of m.content) {
          if (b && b.type === 'tool_result' && b.tool_use_id) (tuids || (tuids = [])).push(b.tool_use_id);
        }
      }
      if (tuids) item.newTuids = tuids;
    }
    return item;
  });

  // Annotate each seq with its parent seq
  const seqById = new Map(items.map(it => [it.id, it.seq]));
  for (const it of items) if (it.parentId) it.parentSeq = seqById.get(it.parentId) || null;

  // ---- Turn segmentation / gap attribution / cache break — the agent loop's time truth and cache economics ----
  // The gap between request bars is not "nothing happening": if the parent response ends in
  // tool_use and the child request backfills tool_result, the gap is local tool execution; if
  // the child request adds user text, the gap is waiting for input. Turn = the whole string of
  // API round-trips triggered by one user input. Cache break = the prefix the parent request
  // had cached did not get a cache hit this time (TTL expired / prefix changed).
  const itemById = new Map(items.map(it => [it.id, it]));
  const recById2 = new Map(recs.map(r => [r.id, r]));
  // "Main conversation" = non-agent chains (including follow-up chains produced by compact/branch) — turns are numbered continuously across chains
  const isRootFlowChain = cid => !chainActor.get(cid);
  const turnAgg = new Map();
  let turnNo = 0;
  let lastRootItem = null; // previous request in the main conversation flow (for attributing cross-chain gaps)

  for (const it of items) {
    if (!it.chainId) continue;
    const rec = recById2.get(it.id);
    const parentIt = it.parentId ? itemById.get(it.parentId) : null;

    // "New user input" among the added messages (a user message with text/image and no tool_result; take the last one)
    const startIdx = it.sharedPrefix || 0;
    const meta = (rec && rec.msgMeta) || [];
    let lastUserInput = -1, hasToolResult = false;
    for (let i = startIdx; i < meta.length; i++) {
      const m = meta[i];
      if (!m || m.role !== 'user') continue;
      const blocks = m.blocks || [];
      if (blocks.some(b => String(b).startsWith('tool_result'))) { hasToolResult = true; continue; }
      if (blocks.includes('text') || blocks.includes('image')) lastUserInput = i;
    }

    // (0) Semantic correction of compact/rewrite — LCP can only tell "history was rolled back and rewritten"; the semantics live in the new tail content:
    //    added messages containing a compaction continuation summary = real compaction; ending
    //    with new user input (real human text / slash command) = "resend" (the user pressed Esc,
    //    reworded and resent, or a rollback triggered by a command like /goal) — not compaction.
    //    /loop and /goal scenarios were once mislabeled as compaction because of this.
    if ((it.relation === 'compact' || it.relation === 'rewrite') && rec && lastUserInput >= (it.sharedPrefix || 0)) {
      // Any message in the rewritten region bearing the compaction-continuation fingerprint = real compaction (compaction may also carry new user input, so the last message alone is not proof)
      let hasContinuation = false;
      for (let i = it.sharedPrefix || 0; i < meta.length; i++) {
        const m = meta[i];
        if (!m || m.role !== 'user' || !(m.blocks || []).includes('text')) continue;
        if (classifyUserText(textOfMsg(blobs.get(rec.msgHashes[i]))).kind === 'continuation') { hasContinuation = true; break; }
      }
      if (hasContinuation) it.relation = 'compact';
      else {
        const cls = classifyUserText(textOfMsg(blobs.get(rec.msgHashes[lastUserInput])));
        // Rewritten region ending with new user input (real human text / slash command) = resend; the tail may still carry the partial response from before the interruption
        if (cls.kind === 'text' || cls.kind === 'command') it.relation = 'resend';
      }
    }

    // (1) Gap attribution
    if (parentIt && parentIt.end != null) {
      const gapMs = it.ts - parentIt.end;
      if (gapMs >= 0) {
        let kind = 'other';
        if (it.relation === 'retry') kind = 'retry';
        else if (hasToolResult) kind = 'tools';
        else if (lastUserInput >= 0) kind = 'user';
        it.gap = { ms: gapMs, kind };
        if (kind === 'tools') {
          const tools = toolNamesOfResponse(recById2.get(parentIt.id));
          if (tools) it.gap.tools = tools;
        }
      }
    }

    // (2) Cache break detection (only for completed extends/retries; error responses have no usage and are excluded)
    if (parentIt && !it.pending && (it.relation === 'extends' || it.relation === 'retry')
        && (it.usage.cacheRead + it.usage.cacheWrite + it.usage.input > 0)) {
      const parentCached = parentIt.usage.cacheRead + parentIt.usage.cacheWrite;
      const lost = parentCached - it.usage.cacheRead;
      if (parentCached >= 4096 && lost > Math.max(2048, parentCached * 0.2)) {
        const gapMs = parentIt.end != null ? it.ts - parentIt.end : null;
        const ttlMs = cacheTtlMs(rec);
        let reason = 'unknown';
        if (gapMs != null && gapMs > ttlMs) reason = 'ttl';
        else if (it.systemChanged) reason = 'system';
        else if (it.toolsChanged) reason = 'tools';
        it.cacheBreak = { lost, parentCached, reason, gapMs, ttlMs };
      }
    }

    // (3) Turns (main conversation flow only — agent chains are almost always single-turn; labeling them just adds noise)
    if (isRootFlowChain(it.chainId)) {
      // A gap across a context reset (branch / new chain start) has no parent request to lean on — attribute it as waiting for input against the main flow's previous request
      if (!parentIt && !it.gap && lastRootItem && lastRootItem.end != null) {
        const gapMs = it.ts - lastRootItem.end;
        if (gapMs >= 0) it.gap = { ms: gapMs, kind: 'user' };
      }
      const isStart = !parentIt
        || (lastUserInput >= 0 && (it.relation === 'extends'
            // resend = a rollback-rewrite driven by new user input, always starts a new turn; same for compact/rewrite ending with user input
            || it.relation === 'resend'
            || ((it.relation === 'compact' || it.relation === 'rewrite') && lastUserInput === meta.length - 1)));
      if (isStart) {
        turnNo++;
        it.turnStart = true;
        if (rec && lastUserInput >= 0) {
          const cls = classifyUserText(textOfMsg(blobs.get(rec.msgHashes[lastUserInput])));
          it.turnLabel = cls.label || null;
          it.turnKind = cls.kind; // text / command / stdout / reminder / continuation — the UI renders by identity
        }
      }
      it.turn = turnNo || 1;
      let ta = turnAgg.get(it.turn);
      if (!ta) {
        ta = { n: it.turn, startId: it.id, startSeq: it.seq, label: it.turnLabel || null, kind: it.turnKind || null,
               rounds: 0, apiMs: 0, toolMs: 0, waitMs: 0, output: 0, errors: 0 };
        turnAgg.set(it.turn, ta);
      }
      ta.rounds++;
      if (it.durMs) ta.apiMs += it.durMs;
      if (it.gap && it.gap.kind === 'tools') ta.toolMs += it.gap.ms;
      if (it.gap && it.gap.kind === 'user') ta.waitMs += it.gap.ms;
      ta.output += it.usage.output;
      if (!it.aborted && !it.pending && (it.error || it.status >= 400)) ta.errors++;
      lastRootItem = it;
    }
  }

  // Session time composition (main conversation flow view): how wall-clock time splits between model generation / local tools / waiting for input
  const mainItems = items.filter(it => it.chainId && isRootFlowChain(it.chainId));
  let timeSplit = null;
  if (mainItems.length) {
    const t0 = mainItems[0].ts;
    const t1 = Math.max(...mainItems.map(it => it.end || it.ts));
    timeSplit = {
      wallMs: t1 - t0,
      apiMs: mainItems.reduce((n, it) => n + (it.durMs || 0), 0),
      toolMs: mainItems.reduce((n, it) => n + (it.gap && it.gap.kind === 'tools' ? it.gap.ms : 0), 0),
      waitMs: mainItems.reduce((n, it) => n + (it.gap && it.gap.kind === 'user' ? it.gap.ms : 0), 0),
    };
  }

  // Agent payload (serialized) + reverse annotation on spawning requests
  const agentList = [...agents.values()].map(a => ({
    key: a.key, agentId: a.agentId, label: a.label, type: a.type, toolName: a.toolName,
    spawnReqId: a.spawnReqId, spawnSeq: a.spawnReqId ? seqById.get(a.spawnReqId) || null : null,
    spawnToolUseId: a.spawnToolUseId, parentKey: a.parentKey,
    firstReqId: a.firstReqId, firstTs: a.firstTs, lastTs: a.lastTs,
    count: a.count, pending: a.pending, errors: a.errors, aborted: a.aborted,
    usage: a.usage, models: [...a.models], lane: laneIndex.get(a.key),
  }));
  for (const a of agentList) {
    if (!a.spawnReqId) continue;
    const it = items.find(x => x.id === a.spawnReqId);
    if (it) (it.spawnedAgents = it.spawnedAgents || []).push(a.key);
  }

  return {
    id: sessionId, requests: items, lanes: laneKeys.length, laneMeta, agents: agentList,
    turns: [...turnAgg.values()], timeSplit,
  };
}

/** Rebuild the full detail of one request (dereference blobs, refill cache_control) */
function buildRequestDetail(id) {
  const rec = recordById.get(id);
  if (!rec) return null;

  const detail = {
    id: rec.id, ts: rec.ts, method: rec.method, path: rec.path, kind: rec.kind,
    status: rec.status, timing: rec.timing, stream: !!rec.stream,
    purpose: purposeOf(rec), pending: rec.phase === 'pending', aborted: !!rec.clientAborted,
    model: rec.model || null, sessionId: sessionKey(rec), userId: rec.userId || null,
    reqHeaders: rec.reqHeaders, resHeaders: rec.resHeaders,
    reqSize: rec.reqSize, resSize: rec.resSize,
    error: rec.error || null, responseError: rec.responseError || null,
    response: rec.response || null, responseText: rec.responseText || null,
    sse: rec.sse || null,
    metadata: rec.metadata || null,
    bodyRest: rec.bodyRest || null,
    cacheMarkers: rec.cacheMarkers || [],
  };

  detail.cc = ccMetaOf(rec);

  if (Array.isArray(rec.msgHashes)) {
    // Find the parent request and annotate the shared prefix
    const sess = buildSession(sessionKey(rec));
    const item = sess.requests.find(r => r.id === id) || {};
    detail.relation = item.relation || null;
    detail.parentId = item.parentId || null;
    detail.parentSeq = item.parentSeq || null;
    detail.seq = item.seq || null;
    detail.sharedPrefix = item.sharedPrefix || 0;
    detail.removedCount = item.removedCount || 0;
    detail.systemChanged = !!item.systemChanged;
    detail.toolsChanged = !!item.toolsChanged;
    detail.usage = item.usage;
    detail.gap = item.gap || null;
    detail.cacheBreak = item.cacheBreak || null;
    detail.phases = item.phases || null;
    detail.stallMs = item.stallMs || null;
    detail.firstTextMs = item.firstTextMs != null ? item.firstTextMs : null;
    detail.turn = item.turn || null;
    detail.turnKind = item.turnKind || null;
    // Spawn relations (both directions): the agent this request belongs to / the agents this request spawned
    detail.agent = item.agentKey ? sess.agents.find(a => a.key === item.agentKey) || null : null;
    if (item.spawnedAgents) {
      detail.spawnedAgents = item.spawnedAgents
        .map(k => sess.agents.find(a => a.key === k)).filter(Boolean);
    }

    detail.system = rec.systemHash ? blobs.get(rec.systemHash) : null;
    detail.systemHash = rec.systemHash;
    detail.tools = rec.toolsHash ? blobs.get(rec.toolsHash) : null;
    detail.toolsHash = rec.toolsHash;
    detail.messages = rec.msgHashes.map((h, i) => ({
      hash: h,
      shared: i < (detail.sharedPrefix || 0),
      msg: blobs.get(h) || { role: '?', content: '[blob missing]' },
    }));
  } else if (rec.requestBody) {
    detail.requestBody = rec.requestBody;
  }
  return detail;
}

// ---------------------------------------------------------------- HTTP server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(full)] || 'application/octet-stream',
    // Small local files aren't worth caching — without cache headers, the browser's heuristic caching keeps an upgraded page running the old UI
    'cache-control': 'no-cache',
  });
  res.end(fs.readFileSync(full));
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const u = req.url || '/';

  // ---- The dashboard's own API (/__lens/ namespace, avoiding collisions with upstream API paths)
  if (u === '/__lens/overview') return json(res, buildOverview());
  if (u === '/__lens/search' || u.startsWith('/__lens/search?')) {
    const qi = u.indexOf('?');
    const params = new URLSearchParams(qi >= 0 ? u.slice(qi + 1) : '');
    return json(res, searchAll(params.get('q') || ''));
  }
  if (u.startsWith('/__lens/session/')) {
    const id = decodeURIComponent(u.slice('/__lens/session/'.length));
    return json(res, buildSession(id));
  }
  if (u.startsWith('/__lens/request/')) {
    const id = decodeURIComponent(u.slice('/__lens/request/'.length));
    const d = buildRequestDetail(id);
    return d ? json(res, d) : json(res, { error: 'not found' }, 404);
  }
  if (u === '/__lens/live') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    liveClients.add(res);
    req.on('close', () => liveClients.delete(res));
    return;
  }

  // ---- transcripts sub-tool (page + /__viewer/ API; the module intercepts internally when toggled off)
  if (u === '/transcripts' || u.startsWith('/transcripts/') || u.startsWith('/transcripts?') || u.startsWith('/__viewer/')) {
    transcripts.handle(req, res).catch(() => { try { res.end(); } catch {} });
    return;
  }

  // ---- hooks sub-tool (hook event layer API: session event stream / tuid pairing annotation / full payloads)
  if (u.startsWith('/__hooks/')) {
    hooks.handle(req, res).catch(() => { try { res.end(); } catch {} });
    return;
  }

  // ---- Dashboard static pages (exact paths only)
  if (req.method === 'GET' && (u === '/' || u === '/index.html')) return serveStatic(res, 'index.html');
  if (req.method === 'GET' && u === '/app.js') return serveStatic(res, 'app.js');
  if (req.method === 'GET' && u === '/style.css') return serveStatic(res, 'style.css');

  // ---- Everything else is passed through upstream and captured (/v1/*, plus any other endpoint the CLI might call)
  const chunks = [];
  let bodyDone = false;
  req.on('data', c => chunks.push(c));
  req.on('end', () => { bodyDone = true; proxyRequest(req, res, Buffer.concat(chunks)); });
  req.on('error', () => { try { res.end(); } catch {} });
  req.on('close', () => {
    // Request body upload aborted midway — must still leave a trace, never vanish silently
    if (bodyDone) return;
    const bodyBuf = Buffer.concat(chunks);
    let body = null;
    try { body = JSON.parse(bodyBuf.toString('utf8')); } catch {}
    const ctx = {
      id: newId(), start: Date.now(), method: req.method, path: u,
      kind: classifyPath(u), body, reqHeaders: redactHeaders(req.headers),
      reqSize: bodyBuf.length, clientAborted: true,
      error: 'request body upload aborted midway (' + bodyBuf.length + ' bytes received)',
      finalized: false,
    };
    try { finalize(ctx); } catch (e) { console.error('[cclens] failed to record aborted upload:', e); }
  });
});

server.requestTimeout = 0;      // streaming requests can last minutes
server.headersTimeout = 60000;
server.keepAliveTimeout = 0;    // never proactively close idle connections — the 5s default races with client connection reuse, causing sporadic request failures/retries

server.listen(PORT, () => {
  const actual = server.address().port;
  console.log(`[cclens] dashboard+proxy:  http://localhost:${actual}`);
  console.log(`[cclens] upstream:         ${UPSTREAM.href}`);
  console.log(`[cclens] data dir:         ${DATA_DIR}  (loaded ${records.length} requests, ${blobs.size} blobs)`);
  console.log(`[cclens] connect with:     ANTHROPIC_BASE_URL=http://localhost:${actual} claude`);
});
