#!/usr/bin/env node
/**
 * cclens launcher.
 *
 * Three layers of ground truth, and they are not alike — the command surface follows that grain
 * rather than pretending they are three symmetric switches:
 *
 *   Transcripts  Claude Code writes them to ~/.claude/projects no matter what. Nothing to install,
 *                no process, no config. `cclens` just reads them.
 *   Hooks        registered once; from then on Claude Code itself invokes the recorder and the events
 *                land on disk. No process, survives reboots, and a failing hook cannot break claude.
 *   API          the only layer needing a live listener, because it can only be captured from inside
 *                the network path — and the only one that can stop claude reaching the API at all.
 *
 * So capture and viewing are separate acts, and each gets the shape that fits it:
 *
 *   cclens                  view what has been recorded — a foreground server, Ctrl+C stops it
 *   cclens claude [args…]   run one command with the wire captured (any command, not just claude)
 *   cclens install          install the hook recorder (idempotent)
 *   cclens uninstall        its exact inverse
 *   cclens status           what is recording, and what is stored
 *   cclens export F.jsonl   standalone HTML copy of one transcript
 *
 * The wrapper form sets ANTHROPIC_BASE_URL in the child's environment and nowhere else. It is ephemeral
 * and lexically scoped: it cannot go stale, and once the command exits nothing anywhere points at a port.
 * There is deliberately no always-on service. That would mean writing a lasting ANTHROPIC_BASE_URL into
 * ~/.claude/settings.json, and a pointer that outlives the process it names is how an observability tool
 * ends up breaking the thing it observes. `alias claude='cclens claude'` covers the same ground while
 * staying visible and reversible in the user's own shell config.
 *
 * Flags are few on purpose: they must precede the wrapped command, so each one is a token that reads
 * ambiguously right where the wrapped command begins. They modify how the single action happens
 * (--port, --no-open); anything that is a *different* action is a subcommand instead.
 *
 * Known edge: SIGKILL on the wrapper skips its exit handler, leaving its ephemeral proxy holding a random
 * port until it is killed. Nothing points at that port and nothing records it, so it is inert rather than
 * hazardous — unlike the durable-pointer version of this problem, which is what the design removes.
 *
 * Options:
 *   --port <n>   dashboard port (default 7700; also CCLENS_PORT). Must precede the wrapped command.
 *   --no-open    don't open a browser
 */
'use strict';

// hooks record hot path: invoked by every hook event; short-circuit first, without loading the rest of the CLI.
// This invocation string is written into ~/.claude/settings.json by `cclens install` — it is a wire protocol,
// not a command anyone types, and it must keep resolving for already-registered hooks to keep working.
if (process.argv[2] === 'hooks' && process.argv[3] === 'record') {
  require('../hooks').record(process.argv[4] || '');
  return; // record() reads stdin asynchronously and exits on its own; this only blocks the synchronous code below
}

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const transcripts = require('../transcripts');
const paths = require('../paths');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PORT = 7700;
// Same override hooks.js honours, so the two agree on which file they are editing (and tests can redirect both)
const SETTINGS_FILE = process.env.CCLENS_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP_KEY = 'ANTHROPIC_BASE_URL_BEFORE_LENS';
const DATA_DIR = paths.dataDir();
const EXPECT_UPSTREAM = new URL(process.env.CCLENS_UPSTREAM || 'https://api.anthropic.com').href;

// ---------------------------------------------------------------- argument parsing
// cclens' own flags come before the command, so everything after it passes through untouched —
// the same convention as `strace -f cmd` or `env VAR=x cmd`.

// Deliberately short. Anything that is not one of these is a command to wrap, so every name added here
// is a name nobody can ever wrap — the list stays at the few things that are genuinely cclens' own verbs.
const SUBCOMMANDS = ['install', 'uninstall', 'status', 'export', 'help', 'hooks'];

let port = process.env.CCLENS_PORT ? Number(process.env.CCLENS_PORT) : DEFAULT_PORT;
let openBrowser = true;
let mode = null;       // subcommand name, or null for the viewer
let subArgs = [];      // arguments belonging to the subcommand
let wrapCmd = null;    // command to wrap, when the first non-flag token is not a subcommand

{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) { port = Number(argv[++i]); continue; }
    if (a === '--no-open') { openBrowser = false; continue; }
    if (a === '--help' || a === '-h') { mode = 'help'; continue; }
    if (a === '--') { wrapCmd = argv[i + 1] || null; subArgs = argv.slice(i + 2); break; }
    if (SUBCOMMANDS.includes(a)) { mode = a; subArgs = argv.slice(i + 1); break; }
    wrapCmd = a; subArgs = argv.slice(i + 1); break;
  }
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`cclens: --port must be an integer between 1 and 65535 (got ${port})`);
  process.exit(2);
}

const LENS_URL = `http://localhost:${port}`;

// ---------------------------------------------------------------- small helpers

const sleep = ms => new Promise(r => setTimeout(r, ms));
const children = [];

function spawnChild(cmd, argv, opts) {
  const c = spawn(cmd, argv, opts);
  children.push(c);
  return c;
}

function cleanup(code) {
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
  process.exit(code || 0);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function fetchJSON(url) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: 800 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitReady(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    if (await fetchJSON(url)) return true;
    await sleep(60);
  }
  return false;
}

/** A cclens already serving at `url`, if any. `mismatch` is set when it is pointed at a different
 *  upstream than we expect, so we never hand real traffic to (say) a demo instance. */
async function serverAt(url) {
  const o = await fetchJSON(url + '/__lens/overview');
  if (!o || !o.totals) return null;
  const actual = o.totals.upstream;
  return { overview: o, mismatch: actual && actual !== EXPECT_UPSTREAM ? actual : null };
}

function openUrl(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref(); } catch {}
}

const expanduser = p =>
  p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;

/** Walk a directory tree once, returning both the total byte size and the number of .jsonl files */
function scanDir(dir) {
  let bytes = 0, jsonl = 0;
  (function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        if (e.name.endsWith('.jsonl')) jsonl++;
        try { bytes += fs.statSync(p).size; } catch {}
      }
    }
  })(dir);
  return { bytes, jsonl };
}

const fmtBytes = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;

// ---------------------------------------------------------------- ~/.claude/settings.json (read to diagnose, written only to repair)

function readSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
  try { return JSON.parse(raw); }
  catch {
    // Never write back after a parse failure — that would wipe all of the user's settings
    console.error(`[cclens] Cannot parse ${SETTINGS_FILE}; leaving it untouched to be safe. Add/remove ANTHROPIC_BASE_URL in its env manually.`);
    cleanup(1);
  }
}

function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2) + '\n');
}

// Nothing in cclens writes ANTHROPIC_BASE_URL any more — capture points a child process at a proxy
// through its own environment and nothing else. This exists purely to *repair*: earlier versions did
// write it, so an upgrade may find a pointer to a port nothing listens on, which stops claude reaching
// the API at all. status names that state and uninstall removes it.
function settingsClear(quiet) {
  const s = readSettings();
  if (!s.env || !s.env.ANTHROPIC_BASE_URL) {
    if (!quiet) console.log('[cclens] No ANTHROPIC_BASE_URL in settings.json; nothing to undo.');
    return;
  }
  if (!/^http:\/\/localhost:\d+$/.test(s.env.ANTHROPIC_BASE_URL)) {
    console.error(`[cclens] ANTHROPIC_BASE_URL=${s.env.ANTHROPIC_BASE_URL} does not look like it was written by cclens; leaving it untouched.`);
    return;
  }
  if (s.env[BACKUP_KEY]) {
    s.env.ANTHROPIC_BASE_URL = s.env[BACKUP_KEY];
    delete s.env[BACKUP_KEY];
    console.log(`[cclens] Restored original ANTHROPIC_BASE_URL=${s.env.ANTHROPIC_BASE_URL}`);
  } else {
    delete s.env.ANTHROPIC_BASE_URL;
    console.log('[cclens] Removed ANTHROPIC_BASE_URL from settings.json.');
  }
  if (Object.keys(s.env).length === 0) delete s.env;
  writeSettings(s);
}

function settingsBaseUrl() {
  try { return (JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).env || {}).ANTHROPIC_BASE_URL || null; } catch { return null; }
}

// ---------------------------------------------------------------- install / uninstall / status
// One pair of opposites, named as a pair. The hook recorder is genuinely installed rather than switched
// on: the entries go into someone else's config file and then work with nothing of ours running, which
// is the same shape as `git lfs install` or `pre-commit install` — and those spell the inverse
// `uninstall` for the same reason.

function installMode() {
  const hooks = require('../hooks');
  try {
    const r = hooks.registerOn(path.resolve(__filename));
    console.log(`[cclens] ${r.message}`);
  } catch (e) {
    console.error(`[cclens] ${e.message}`);
    process.exit(1);
  }
  console.log('');
  console.log('Recording now:');
  console.log('  Transcripts  already on disk — Claude Code writes them whether or not cclens exists');
  console.log(`  Hooks        recorder registered for ${hooks.EVENTS.length} event types (applies to newly started sessions)`);
  console.log('  API          only while you ask for it, because it needs a live proxy in the path:');
  console.log('                 cclens claude          one command');
  console.log("                 alias claude='cclens claude'    every session in this shell");
  console.log('');
  console.log('Look at any of it:  cclens          Undo all of the above:  cclens uninstall');
  process.exit(0);
}

function uninstallMode() {
  const hooks = require('../hooks');
  try {
    const r = hooks.registerOff();
    console.log(r.removed
      ? `[cclens] Removed ${r.removed} hook entries from settings.json (your own hooks are left untouched).`
      : '[cclens] No hook entries of ours were registered.');
  } catch (e) { console.error(`[cclens] ${e.message}`); }

  settingsClear(true);

  const { bytes } = scanDir(paths.HOME);
  console.log('');
  console.log(`[cclens] Nothing of ours is registered any more. Recorded data is kept (${fmtBytes(bytes)} in ${paths.HOME}).`);
  console.log(`[cclens] Delete that too:  rm -rf ${paths.HOME}`);
  const legacy = paths.legacyHome();
  if (legacy) console.log(`[cclens] An older version also left data in ${legacy} — remove it the same way if you don't want it.`);
  process.exit(0);
}

async function statusMode() {
  const hooks = require('../hooks');

  const tRoot = transcripts.transcriptsRoot();
  if (!transcripts.enabled()) {
    console.log(`Transcripts  ○ off        ("viewer": false in ${transcripts.CONFIG_FILE})`);
  } else if (!tRoot) {
    console.log('Transcripts  ⚠ no root    (looked for CCLENS_TRANSCRIPTS, then ~/.claude/projects)');
  } else {
    console.log(`Transcripts  ● ${scanDir(tRoot).jsonl} sessions  ${tRoot}`);
  }

  const reg = hooks.registration();
  if (!reg.ours.length) {
    console.log('Hooks        ○ not installed  (cclens install)');
  } else if (reg.broken.length) {
    // Registered but unrunnable is worse than not installed, because it looks fine from settings.json
    console.log(`Hooks        ⚠ ${reg.broken.length}/${reg.ours.length} registered recorders point at a path that no longer exists`);
    console.log(`                          missing: ${reg.deadPath}`);
    console.log('                          Those events are being dropped silently. Fix: cclens install');
  } else {
    console.log(`Hooks        ● ${reg.ours.length}/${hooks.EVENTS.length} event types recording${hooks.available() ? '' : ' · nothing captured yet (starts with new sessions)'}`);
  }

  const live = await serverAt(LENS_URL);
  const gUrl = settingsBaseUrl();
  if (gUrl && /^http:\/\/localhost:\d+$/.test(gUrl)) {
    // cclens no longer writes this; finding one means an older version did, and it is a hazard either way
    console.log(live && gUrl === LENS_URL
      ? `API          ⚠ settings.json points at ${gUrl}, left by an older cclens — it answers now, but nothing keeps it alive`
      : `API          ⚠ settings.json points at ${gUrl} with nothing there — new claude sessions cannot reach the API!`);
    console.log('                          Fix: cclens uninstall');
  } else {
    console.log('API          ○ captured per command  (cclens claude …)');
  }

  const { bytes } = scanDir(DATA_DIR);
  console.log(`Store        ${fmtBytes(bytes)} in ${DATA_DIR}${live ? ` · ${live.overview.totals.requests} requests loaded` : ''}`);
  console.log(live ? `Viewing      ● ${LENS_URL}` : 'Viewing      ○ nothing serving  (cclens)');

  // The store moved into ~/.claude so it travels with a Claude Code migration. Say so when the old
  // location still holds data, rather than letting an upgrade look like the history disappeared.
  const legacy = paths.legacyHome();
  if (legacy) {
    const old = scanDir(legacy);
    console.log('');
    console.log(`[cclens] ${fmtBytes(old.bytes)} of older data is still at ${legacy}; nothing reads it now.`);
    console.log(`[cclens] Keep that history:  rsync -a ${legacy}/ ${paths.HOME}/ && rm -rf ${legacy}`);
    console.log(`[cclens] Or discard it:      rm -rf ${legacy}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- transcripts export

function exportMode(argv) {
  let src = null, out = null;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '-o' || argv[i] === '--out') && argv[i + 1]) { out = argv[++i]; continue; }
    if (!src) { src = argv[i]; continue; }
    console.error(`cclens export: unexpected extra argument ${argv[i]}`);
    process.exit(2);
  }
  if (!src) {
    console.error('Usage: cclens export FILE.jsonl [-o OUT.html]');
    process.exit(2);
  }
  src = path.resolve(expanduser(src));
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    console.error(`cclens: file not found: ${src}`);
    process.exit(1);
  }
  const dst = out ? path.resolve(expanduser(out)) : src.replace(/\.[^/.]+$/, '') + '.html';
  fs.writeFileSync(dst, transcripts.buildStandalone(src));
  console.log(`wrote ${dst}`);
  process.exit(0);
}

// ---------------------------------------------------------------- viewer (bare invocation)

async function viewerMode() {
  const live = await serverAt(LENS_URL);
  if (live && live.mismatch) {
    console.error(`[cclens] Port ${port} has a cclens pointed at ${live.mismatch}, not ${EXPECT_UPSTREAM}.`);
    console.error('[cclens] That is most likely a demo instance — serve elsewhere with --port <n>.');
    process.exit(1);
  }
  if (live) {
    // Another foreground viewer in some other terminal. Don't start a second one on the same store.
    console.log(`[cclens] Already serving at ${LENS_URL} — opening the page.`);
    if (openBrowser) openUrl(LENS_URL);
    process.exit(0);
  }

  // Foreground on purpose: the terminal is the status display and Ctrl+C is the off switch, so
  // "is it running?" is never a question you have to ask a state file to answer.
  const server = spawnChild('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  server.on('error', e => { console.error('[cclens] Could not start the server:', e.message); cleanup(1); });
  server.on('exit', code => process.exit(code ?? 0));

  if (!await waitReady(LENS_URL + '/__lens/overview')) {
    // On macOS a bind probe is fooled by SO_REUSEADDR, so connect instead to see if someone else has it
    const occupied = await new Promise(resolve => {
      const s = net.connect({ port, host: '127.0.0.1', timeout: 500 }, () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.on('timeout', () => { s.destroy(); resolve(false); });
    });
    console.error(occupied
      ? `[cclens] Port ${port} is taken by another program. Pick another with --port <n>.`
      : '[cclens] Server failed to start.');
    cleanup(1);
  }
  if (openBrowser) openUrl(LENS_URL);
  console.log(`\n[cclens] Viewing at ${LENS_URL} — Ctrl+C to stop.`);
  console.log('[cclens] Capture a session into it:  cclens claude');
}

// ---------------------------------------------------------------- wrapper (cclens <command> [args…])

async function wrapMode(cmd, cmdArgs) {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  if (which.status !== 0) {
    console.error(`[cclens] Command not found: ${cmd}`);
    if (cmd === 'claude') console.error('[cclens] Install Claude Code first, or wrap any other command that talks to the API.');
    else console.error('[cclens] Run `cclens help` for the list of subcommands.');
    process.exit(127);
  }

  // Reuse a cclens that is already listening — e.g. a viewer open in another terminal. That
  // keeps one writer on the store, and the page you are watching updates in process rather than by tailing.
  let proxyUrl, own = null, errBuf = '';
  const live = await serverAt(LENS_URL);
  if (live && !live.mismatch) {
    proxyUrl = LENS_URL;
    console.log(`[cclens] Capturing through the cclens already at ${LENS_URL}`);
  } else {
    // An ephemeral port, deliberately: nobody types it, nothing records it, and when this process exits
    // there is no pointer left anywhere to a port that has stopped listening.
    const p = await getFreePort();
    proxyUrl = `http://localhost:${p}`;
    own = spawnChild('node', [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(p) },
      stdio: ['ignore', 'ignore', 'pipe'], // never 'inherit': the server banner would land inside claude's UI
    });
    own.stderr.on('data', c => { errBuf = (errBuf + c).slice(-2000); });
    if (!await waitReady(proxyUrl + '/__lens/overview')) {
      console.error('[cclens] Could not start the capture proxy.');
      if (errBuf.trim()) console.error(errBuf.trim());
      cleanup(1);
    }
    console.log(`[cclens] Capturing ${cmd} — watch it live with \`cclens\` in another terminal, or look after it exits.`);
  }

  // Ctrl+C belongs to the wrapped command: it shares this terminal and process group, so it has already
  // received the signal itself. Exiting here would orphan it mid-keystroke.
  process.on('SIGINT', () => {});

  const child = spawn(cmd, cmdArgs, {
    env: { ...process.env, ANTHROPIC_BASE_URL: proxyUrl }, // child only — nothing durable is written anywhere
    stdio: 'inherit',
  });
  child.on('error', e => { console.error(`[cclens] Failed to launch ${cmd}:`, e.message); cleanup(1); });
  child.on('exit', async (code, signal) => {
    const o = await fetchJSON(proxyUrl + '/__lens/overview');
    if (own) { try { own.kill('SIGTERM'); } catch {} }
    if (o && o.totals) {
      const n = o.totals.requests;
      console.log(`\n[cclens] Captured ${n} request${n === 1 ? '' : 's'} · ${fmtBytes(o.totals.capturedBytes || 0)} — look at it with: cclens`);
    }
    process.exit(signal ? 1 : (code ?? 0));
  });
}

// ---------------------------------------------------------------- help

function printHelp(all) {
  console.log(`cclens — see what Claude Code is actually doing.

  cclens                look at everything recorded so far (Ctrl+C stops it)
  cclens claude         run claude with the wire captured — cost, cache, retries, SSE timing
  cclens install        install the hook recorder: tool durations and permission waits
  cclens status         what's recording, and what's stored

More
  cclens uninstall      remove the hook recorder — the exact inverse of install
  cclens export F.jsonl standalone HTML copy of one transcript
  cclens <cmd> [args…]  wrap any command, not just claude — Agent SDK scripts too

  --port <n>  serve on another port (default 7700)   --no-open  don't open a browser
  Flags come before the command; everything after it is passed through untouched.
  cclens help --all     how the three layers differ, and why the commands are shaped this way`);

  if (all) {
    console.log(`
The three layers are not alike, and the commands follow that rather than hiding it.

  Transcripts  need nothing installed. Claude Code writes them to ~/.claude/projects regardless and
               cclens only reads them, so a first run already has something real to show. Opt out
               with {"viewer": false} in ~/.claude/cclens/config.json — a config field and not a flag on
               purpose, because a privacy switch you have to remember to pass is one you will one day
               forget, and forgetting it would serve the data rather than withhold it.

  Hooks        are registered once (cclens install); from then on Claude Code invokes the recorder
               itself, so events keep landing on disk with no cclens process running and across
               reboots. A failing hook cannot break claude. Costs about 23ms per event.

  API          can only be captured from inside the network path, so it is the only layer that needs
               a live process — and the only one that could stop claude reaching the API at all.
               So it is scoped to a command you type:

    cclens claude   a proxy on an ephemeral port for exactly as long as the command runs.
                    ANTHROPIC_BASE_URL is set in the child's environment and nowhere else, so
                    nothing durable is written: it cannot go stale and cannot break claude.

               Want every session captured?  alias claude='cclens claude'
               That stays explicit, lives in your shell config where you can see it, and needs no
               daemon. There is deliberately no always-on service: it would have to write a lasting
               ANTHROPIC_BASE_URL into ~/.claude/settings.json, and a pointer that outlives the
               process it points at is exactly how an observability tool breaks the thing it watches.

Capture writes to ~/.claude/cclens/data; viewing reads it back and follows appends, so a page you already
have open updates live even while the capture happens in a different process.

Showing the dashboard to someone else? Each layer reads its path from the environment, so pointing one
at an empty directory hides it for that run — no flag needed, and it composes:

    CCLENS_TRANSCRIPTS=$(mktemp -d) cclens    serve with no session history at all
    CCLENS_DATA=$(mktemp -d) cclens           serve with an empty API store

  Storage      everything lives under ~/.claude/cclens, so backing up or moving ~/.claude carries the
               recordings with it. A .gitignore is seeded there: ~/.claude is often a dotfiles repo,
               and captures are plaintext prompts and code.
  Environment  CCLENS_HOME relocates all of it · CCLENS_PORT, CCLENS_DATA, CCLENS_UPSTREAM,
               CCLENS_TRANSCRIPTS, CCLENS_HOOKS_DATA override one thing each
  Internal     cclens hooks record <Event> — the invocation registered in settings.json, never typed`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- dispatch

process.on('SIGTERM', () => cleanup(0));

async function main() {
  if (mode === 'help') return printHelp(subArgs.includes('--all') || subArgs.includes('all'));
  if (mode === 'export') return exportMode(subArgs);
  if (mode === 'install') return installMode();
  if (mode === 'uninstall') return uninstallMode();
  if (mode === 'status') return statusMode();
  if (mode === 'hooks') {
    // `hooks record` is intercepted at the top of this file; anything else here was the old on/off toggle
    console.error('[cclens] Hook recording is installed with `cclens install` and removed with `cclens uninstall`.');
    console.error('[cclens] Current state: cclens status');
    process.exit(2);
  }
  if (wrapCmd) return wrapMode(wrapCmd, subArgs);
  process.on('SIGINT', () => cleanup(0)); // viewer only: no child owns the terminal, so Ctrl+C is ours
  return viewerMode();
}

main().catch(e => { console.error('[cclens]', e); cleanup(1); });
