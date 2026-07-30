#!/usr/bin/env node
/**
 * Development-only demo rig:  npm run demo
 *
 * Brings up the mock upstream, a server pointed at it, and replays a synthetic session so all three
 * layers are populated. Its purpose is regenerating the README screenshots and exercising the UI without
 * an API key — it is not part of the published package, and there is no `cclens demo` command, because
 * a first run already has something real to look at: `cclens` reads the transcripts Claude Code has
 * been writing all along, with nothing installed and no key involved.
 *
 * Every byte written goes into demo-only directories, handed to both the server and the replay through
 * these three env vars. The real data under ~/.claude/cclens and ~/.claude/projects is never read
 * and never written here.
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const home = os.homedir();
const children = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DEMO_ROOT = path.join(require('../paths').HOME, 'demo');
const DEMO_DIRS = {
  CCLENS_DATA: path.join(DEMO_ROOT, 'data'),
  CCLENS_TRANSCRIPTS: path.join(DEMO_ROOT, 'transcripts'),
  CCLENS_HOOKS_DATA: path.join(DEMO_ROOT, 'hooks'),
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

function ping(url) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: 800 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitReady(url, tries = 120) {
  for (let i = 0; i < tries; i++) { if (await ping(url)) return true; await sleep(60); }
  return false;
}

function run(script, env) {
  const c = spawn('node', [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  children.push(c);
  return c;
}

function openUrl(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref(); } catch {}
}

const die = code => { for (const c of children) { try { c.kill('SIGTERM'); } catch {} } process.exit(code || 0); };
process.on('SIGINT', () => die(0));
process.on('SIGTERM', () => die(0));

(async () => {
  // Demo data starts from scratch every time, so repeated replays don't pile up
  for (const dir of Object.values(DEMO_DIRS)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    try { fs.mkdirSync(dir, { recursive: true }); } catch {} // must exist before the first page load resolves the transcripts root
  }

  // Always a free port: a demo must never collide with, or be mistaken for, a dashboard over real data
  const demoPort = process.env.PORT ? Number(process.env.PORT) : await freePort();
  const demoUrl = `http://localhost:${demoPort}`;
  const mockPort = await freePort();

  run(path.join(ROOT, 'mock', 'upstream.js'), { PORT: String(mockPort) });
  if (!await waitReady(`http://localhost:${mockPort}/__mock/health`)) { console.error('[demo] mock upstream failed to start'); die(1); }

  run(path.join(ROOT, 'server.js'), { PORT: String(demoPort), CCLENS_UPSTREAM: `http://localhost:${mockPort}`, ...DEMO_DIRS });
  if (!await waitReady(demoUrl + '/__lens/overview')) { console.error('[demo] server failed to start'); die(1); }
  if (process.env.NO_OPEN !== '1') openUrl(demoUrl);

  console.log('[demo] Replaying simulated session…');
  const sim = run(path.join(ROOT, 'mock', 'simulate.js'), { PROXY: demoUrl, ...DEMO_DIRS });
  sim.on('exit', () => {
    console.log(`[demo] Ready → ${demoUrl}  (Ctrl+C to quit)`);
    console.log('[demo]   All three layers are populated by the replay itself:');
    console.log('[demo]   · API         /            20 requests through the mock upstream');
    console.log('[demo]   · Transcripts /transcripts  synthetic session + its Task subagent');
    console.log('[demo]   · Hooks       hook events interleaved with the requests above');
    console.log(`[demo]   Demo-only data: ${DEMO_ROOT}/{data,transcripts,hooks} (wiped and rewritten each run)`);
  });
})().catch(e => { console.error('[demo]', e); die(1); });
