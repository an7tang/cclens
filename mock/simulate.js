#!/usr/bin/env node
/**
 * Session simulator — replays the request shapes of a real Claude Code session against the
 * cclens proxy, for demoing/validating the dashboard. Scenarios covered:
 *   - count_tokens preflight
 *   - Multi-turn main chain: the messages array grows each turn (large repeated prefix + incremental tool_use/tool_result)
 *   - Parallel haiku background call (title generation)
 *   - 529 overloaded error + retry with the identical request body
 *   - Task subagent: a fresh-context branch within the same session
 *   - Context compaction (history rewritten as a summary)
 *
 * It also feeds the other two observation layers, which have no proxy to record them:
 *   - hook events, appended inline so their timestamps genuinely interleave with the requests
 *   - a synthetic transcript (main chain + Task subagent), written when the replay finishes
 * Both are written only when CCLENS_HOOKS_DATA / CCLENS_TRANSCRIPTS point somewhere
 * (mock/demo.js points them at demo-only directories); without them this script behaves
 * exactly as it always did and touches no files at all.
 *
 * Prereqs: mock/upstream.js running on :8378, server.js running on :8377 with CCLENS_UPSTREAM=http://localhost:8378
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PROXY = process.env.PROXY || 'http://localhost:8377';
const SESSION = 'demo0000-1111-2222-3333-444455556666';
const METADATA = { user_id: `user_a1b2c3d4_account_e5f6a7b8_session_${SESSION}` };
const MODEL = 'claude-opus-4-8';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64 = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

async function call(path, body, mock, extraHeaders) {
  const res = await fetch(PROXY + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-api03-SIMULATED-KEY-0000000000000000',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
      'user-agent': 'claude-cli/2.1.0 (external, cli)',
      ...(extraHeaders || {}),
      ...(mock ? { 'x-mock': b64(mock) } : {}),
    },
    body: JSON.stringify(body),
  });
  await res.text(); // drain the stream
  return res.status;
}

// ---------------------------------------------------------------- Fixed prefix

const SYSTEM = [
  // In real traffic the first system line carries billing metadata (cclens uses it to tell cli/subagent apart)
  { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.202.demo; cc_entrypoint=cli;\nYou are Claude Code, Anthropic\'s official CLI for Claude.' },
  {
    type: 'text',
    text: `You are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

# Tone and style
You should be concise, direct, and to the point. Output text to communicate with the user; all text you output outside of tool use is displayed to the user.

# Tool usage policy
When doing file search, prefer to use dedicated tools in order to reduce context usage. You have the capability to call multiple tools in a single response.

# Environment
Working directory: /Users/dev/example-project
Platform: darwin
Today's date: 2026-07-02
${'Per-module responsibilities and collaboration conventions (filler simulating a long system prompt at realistic size). '.repeat(40)}`,
    cache_control: { type: 'ephemeral' },
  },
];

const TOOLS = [
  {
    name: 'Bash',
    description: 'Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.',
    input_schema: { type: 'object', properties: { command: { type: 'string', description: 'The command to execute' }, timeout: { type: 'number' }, description: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'Read',
    description: 'Reads a file from the local filesystem. The file_path parameter must be an absolute path. By default reads up to 2000 lines.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] },
  },
  {
    name: 'Write',
    description: 'Writes a file to the local filesystem, overwriting if one exists.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
  },
  {
    name: 'Edit',
    description: 'Performs exact string replacement in a file. old_string must match the file exactly and be unique.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] },
  },
  {
    name: 'Grep',
    description: 'Fast content search tool built on ripgrep. Supports full regex syntax, file pattern filtering, and multiple output modes.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] } }, required: ['pattern'] },
  },
  {
    name: 'Glob',
    description: 'Fast file pattern matching tool that works with any codebase size.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'Task',
    description: 'Launch a new agent to handle complex, multi-step tasks autonomously.',
    input_schema: { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' }, subagent_type: { type: 'string' } }, required: ['description', 'prompt'] },
  },
  {
    name: 'TodoWrite',
    description: 'Create and manage a structured task list for the current coding session.',
    input_schema: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object' } } }, required: ['todos'] },
    cache_control: { type: 'ephemeral' },
  },
];

// ---------------------------------------------------------------- Conversation content

const u1 = { role: 'user', content: 'Look into why token refresh in src/auth intermittently returns 401, then fix it' };

const a1 = [
  { type: 'text', text: 'Let me start by searching the auth module for token-refresh-related code.' },
  { type: 'tool_use', id: 'toolu_grep01', name: 'Grep', input: { pattern: 'refresh|expires', path: 'src/auth', output_mode: 'content' } },
];

const u2 = {
  role: 'user',
  content: [{
    type: 'tool_result', tool_use_id: 'toolu_grep01',
    content: 'src/auth/refresh.ts:42:  if (token.expiresAt < Date.now()) {\nsrc/auth/refresh.ts:57:  const fresh = await refreshToken(token);\nsrc/auth/client.ts:88:  headers.Authorization = `Bearer ${token.value}`;\nsrc/auth/client.ts:91:  // TODO: race condition when parallel requests trigger refresh',
  }],
};

const a2 = [
  { type: 'tool_use', id: 'toolu_read01', name: 'Read', input: { file_path: '/Users/dev/example-project/src/auth/refresh.ts' } },
];

const u3 = {
  role: 'user',
  content: [{
    type: 'tool_result', tool_use_id: 'toolu_read01',
    content: '     1→import { Token } from "./types";\n     2→\n     3→let refreshing = false;\n' +
      '    40→export async function ensureFresh(token: Token) {\n    41→  // trigger refresh 30s before expiry\n    42→  if (token.expiresAt < Date.now()) {\n    43→    if (refreshing) return token; // BUG: returns the stale token\n    44→    refreshing = true;\n    45→    try {\n    46→      return await refreshToken(token);\n    47→    } finally { refreshing = false; }\n    48→  }\n    49→  return token;\n    50→}\n' +
      '(remaining 180 lines omitted...)'.repeat(12),
  }],
};

const a3 = [
  { type: 'thinking', thinking: 'When concurrent requests enter ensureFresh at the same time, the second caller hits the refreshing=true branch and gets the expired token back, hence the intermittent 401s. Concurrent callers should await the same refresh Promise.' },
  { type: 'text', text: 'Found it: `refresh.ts:43` returns the stale token during a concurrent refresh, causing the intermittent 401s. I will change it to share a single refresh Promise:' },
  {
    type: 'tool_use', id: 'toolu_edit01', name: 'Edit',
    input: {
      file_path: '/Users/dev/example-project/src/auth/refresh.ts',
      old_string: '  if (token.expiresAt < Date.now()) {\n    if (refreshing) return token; // BUG: returns the stale token\n    refreshing = true;\n    try {\n      return await refreshToken(token);\n    } finally { refreshing = false; }\n  }',
      new_string: '  if (token.expiresAt < Date.now()) {\n    if (!refreshPromise) {\n      refreshPromise = refreshToken(token).finally(() => { refreshPromise = null; });\n    }\n    return await refreshPromise;\n  }',
    },
  },
];

const u4 = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit01', content: 'The file /Users/dev/example-project/src/auth/refresh.ts has been updated.' }] };

const a4 = [
  { type: 'text', text: 'Fix applied. I will dispatch a subagent to run the tests and summarize the results.' },
  { type: 'tool_use', id: 'toolu_task01', name: 'Task', input: { description: 'Run auth tests', prompt: 'Run npm test -- auth from the repo root and summarize failures and timing.', subagent_type: 'general-purpose' } },
];

const u5 = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_task01', content: 'Subagent result: all 18 auth tests passed (3.2s). The concurrent-refresh regression test token-refresh.race.test.ts also passed.' }] };

const a5 = [
  { type: 'text', text: 'Done. The issue was that `ensureFresh` handed late concurrent callers the expired token; all concurrent calls now share a single refresh Promise. All 18 auth tests pass, including the new race regression test.' },
];

// Subagent side (foreground Task — system carries the cc_is_subagent flag, no agent-id header; the spawn point is located by prompt matching)
const SUB_SYSTEM = [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.202.demo; cc_entrypoint=cli; cc_is_subagent=true;\nYou are an agent for Claude Code. Given the user\'s message, you should use the tools available to complete the task. Do what has been asked; nothing more, nothing less.', cache_control: { type: 'ephemeral' } }];
const su1 = { role: 'user', content: 'Run npm test -- auth from the repo root and summarize failures and timing.' };
const sa1 = [
  { type: 'tool_use', id: 'toolu_bash01', name: 'Bash', input: { command: 'npm test -- auth', description: 'Run auth-related tests' } },
];
const su2 = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash01', content: 'PASS src/auth/refresh.test.ts (18 tests, 3.2s)\nPASS src/auth/token-refresh.race.test.ts' }] };
const sa2 = [{ type: 'text', text: 'All 18 auth tests passed (3.2s), including the concurrent-refresh race regression test.' }];

// Background agent (Agent with run_in_background — tool_result carries agentId, requests carry the x-claude-code-agent-id header, a hard link)
const BG_AGENT_ID = 'a5demo88bgagent01';
const aSpawnBg = [
  { type: 'text', text: 'I will also dispatch a background agent to look up known cases of the same class of issue.' },
  { type: 'tool_use', id: 'toolu_agent01', name: 'Agent', input: { description: 'Find similar race-condition cases', prompt: 'Search the web for known race condition issues around OAuth token refresh causing intermittent 401, summarize the top 3 findings with links.', subagent_type: 'general-purpose', run_in_background: true } },
];
const uBgLaunched = {
  role: 'user',
  content: [{
    type: 'tool_result', tool_use_id: 'toolu_agent01',
    content: `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${BG_AGENT_ID} (internal ID - do not mention to user. Use SendMessage with to: '${BG_AGENT_ID}' to continue this agent.)\nThe agent is working in the background.`,
  }],
};
const bgU1 = { role: 'user', content: 'Search the web for known race condition issues around OAuth token refresh causing intermittent 401, summarize the top 3 findings with links.' };
const bgA1 = [
  { type: 'thinking', thinking: 'Need to search for public cases where an OAuth token refresh race causes intermittent 401s.' },
  { type: 'tool_use', id: 'toolu_ws01', name: 'WebSearch', input: { query: 'OAuth token refresh race condition intermittent 401' } },
];
const bgU2 = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ws01', content: 'Web search results:\n1. oauth2-client #412 — parallel refresh returns stale token\n2. axios-auth-refresh README — queue concurrent 401 retries\n3. RFC 6749 §6 discussion thread' }] };
const bgA2 = [{ type: 'text', text: 'Found 3 similar cases: oauth2-client #412 (concurrent refresh returns a stale token — same root cause as ours), axios-auth-refresh\'s queueing of concurrent 401 retries, and a discussion thread around RFC 6749 §6.' }];
// Model call made inside the WebSearch tool (server tool, separate small request, shares the agent-id header with the agent)
const WS_TOOLS = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];
const wsU1 = { role: 'user', content: 'Perform a web search for the query: OAuth token refresh race condition intermittent 401' };

// ---------------------------------------------------------------- Usage figures
// Shared by the API-layer mock directives and the transcript records below, so the two layers
// report the same numbers for the same turn.

const USAGE = {
  a1: { input_tokens: 320, cache_creation_input_tokens: 14200, cache_read_input_tokens: 0, output_tokens: 96 },
  a2: { input_tokens: 210, cache_creation_input_tokens: 430, cache_read_input_tokens: 14200, output_tokens: 58 },
  a3: { input_tokens: 1620, cache_creation_input_tokens: 300, cache_read_input_tokens: 14630, output_tokens: 340 },
  a4: { input_tokens: 240, cache_creation_input_tokens: 2110, cache_read_input_tokens: 14930, output_tokens: 132 },
  a5: { input_tokens: 190, cache_creation_input_tokens: 470, cache_read_input_tokens: 17520, output_tokens: 118 },
  a6: { input_tokens: 380, cache_creation_input_tokens: 14340, cache_read_input_tokens: 14200, output_tokens: 72 },
  a7: { input_tokens: 460, cache_creation_input_tokens: 29200, cache_read_input_tokens: 0, output_tokens: 118 },
  sa1: { input_tokens: 260, cache_creation_input_tokens: 8300, cache_read_input_tokens: 0, output_tokens: 64 },
  sa2: { input_tokens: 120, cache_creation_input_tokens: 180, cache_read_input_tokens: 8560, output_tokens: 46 },
  spawnBg: { input_tokens: 180, cache_creation_input_tokens: 460, cache_read_input_tokens: 17040, output_tokens: 88 },
  goal: { input_tokens: 240, cache_creation_input_tokens: 610, cache_read_input_tokens: 29200, output_tokens: 46 },
  resend: { input_tokens: 210, cache_creation_input_tokens: 380, cache_read_input_tokens: 29800, output_tokens: 38 },
};

// ---------------------------------------------------------------- Hook event layer
// Same record shape hooks.js `record()` writes: one {ts, event, payload} per line in
// events-<UTC date>.jsonl. Emitted inline during the replay, never afterwards, so
// PreToolUse→PostToolUse spans are measured wall clock and the dashboard can explain the
// gaps between two API requests. No fallback directory: if the env var is unset nothing is
// written anywhere.

const HOOKS_DIR = process.env.CCLENS_HOOKS_DATA || '';
const CWD = '/Users/dev/example-project';
const PROJECT_DIR = '-Users-dev-example-project'; // Claude Code encodes the cwd into the directory name
const VERSION = '2.1.202.demo';
const TASK_AGENT_ID = 'a7demo11task01'; // foreground Task subagent → agent-<id>.jsonl

const TRANSCRIPTS_DIR = process.env.CCLENS_TRANSCRIPTS || '';
const TRANSCRIPT_PATH = TRANSCRIPTS_DIR ? path.join(TRANSCRIPTS_DIR, PROJECT_DIR, `${SESSION}.jsonl`) : '';

const hookCounts = Object.create(null);

function emit(event, payload) {
  hookCounts[event] = (hookCounts[event] || 0) + 1;
  if (!HOOKS_DIR) return;
  const ts = new Date().toISOString();
  const rec = {
    ts, event,
    payload: {
      session_id: SESSION, transcript_path: TRANSCRIPT_PATH, cwd: CWD,
      hook_event_name: event, permission_mode: 'default', ...payload,
    },
  };
  try {
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
    fs.appendFileSync(path.join(HOOKS_DIR, `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify(rec) + '\n');
  } catch { /* a recording failure must never break the replay */ }
}

/**
 * Wrap one local tool execution in the hook events a real session would emit.
 * `ms` is the delay this step already had in the replay — it is split across the permission
 * wait and the execution rather than added to, so the API-layer timeline is untouched while
 * the gap between two requests now has a measured explanation.
 */
async function runTool(ms, name, tuid, input, response, opts) {
  const o = opts || {};
  let exec = ms;
  if (o.permission) {
    const wait = Math.min(Math.round(ms / 2), 200);
    emit('Notification', { message: `Claude needs your permission to use ${name}` });
    emit('PermissionRequest', { tool_name: name, tool_use_id: tuid, tool_input: input });
    await sleep(wait);
    exec = ms - wait;
  }
  emit('PreToolUse', { tool_name: name, tool_use_id: tuid, tool_input: input });
  await sleep(exec);
  emit(o.fail ? 'PostToolUseFailure' : 'PostToolUse',
    { tool_name: name, tool_use_id: tuid, tool_input: input, tool_response: response });
}

// ---------------------------------------------------------------- Transcript layer
// Records are appended as the replay reaches them (so timestamps are real wall clock) and the
// files are written once at the end. Shapes follow real Claude Code transcripts: parentUuid
// chains every record to the previous one, a user turn carrying tool results uses an array of
// tool_result blocks instead of a string, and a subagent lives in its own agent-<id>.jsonl
// with isSidechain:true plus a sibling .meta.json describing the agent.

const THINK_SIG = 'EqQBCkYIBRgCKkBkZW1vLXNpZ25hdHVyZS1ub3QtYS1yZWFsLW9uZQ';
const hex = n => randomUUID().replace(/-/g, '').slice(0, n);
const CHAINS = [];

function chain(file, isSidechain, sessionKind) {
  const recs = [];
  const base = () => ({
    isSidechain, sessionKind, userType: 'external', entrypoint: 'cli',
    cwd: CWD, sessionId: SESSION, version: VERSION, gitBranch: 'main',
  });
  const c = {
    file, recs, parent: null, promptId: 'p_' + hex(12),
    meta(rec) { recs.push({ ...rec, sessionId: SESSION }); },
    newPrompt() { c.promptId = 'p_' + hex(12); },
    user(content, extra) {
      const uuid = randomUUID();
      recs.push({
        type: 'user', parentUuid: c.parent, promptId: c.promptId,
        message: { role: 'user', content }, isMeta: false, uuid,
        timestamp: new Date().toISOString(), ...base(), ...extra,
      });
      c.parent = uuid;
    },
    assistant(content, usage, stopReason) {
      const uuid = randomUUID();
      recs.push({
        type: 'assistant', parentUuid: c.parent,
        message: {
          model: MODEL, id: 'msg_' + hex(24), type: 'message', role: 'assistant',
          // Real thinking blocks carry a signature; the streamed mock response does not send one
          content: content.map(b => (b.type === 'thinking' && !b.signature ? { ...b, signature: THINK_SIG } : b)),
          stop_reason: stopReason, stop_sequence: null,
          usage: { ...usage, service_tier: 'standard' },
        },
        requestId: 'req_' + hex(24), uuid, timestamp: new Date().toISOString(), ...base(),
      });
      c.parent = uuid;
    },
  };
  CHAINS.push(c);
  return c;
}

const MAIN = chain(`${SESSION}.jsonl`, false, 'main');
const SUB = chain(`agent-${TASK_AGENT_ID}.jsonl`, true, 'subagent');

function writeTranscripts() {
  if (!TRANSCRIPTS_DIR) return false;
  const dir = path.join(TRANSCRIPTS_DIR, PROJECT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const c of CHAINS) {
    fs.writeFileSync(path.join(dir, c.file), c.recs.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  // A subagent transcript carries no agent-name record; the sibling meta.json is where the index reads its type and task
  fs.writeFileSync(path.join(dir, `agent-${TASK_AGENT_ID}.meta.json`),
    JSON.stringify({ agentType: 'general-purpose', description: 'Run auth tests' }, null, 2) + '\n');
  return true;
}

// ---------------------------------------------------------------- Request orchestration

function mainBody(messages, extra) {
  // Put cache_control on the last message (mirrors what Claude Code does — the breakpoint moves with each turn)
  const msgs = JSON.parse(JSON.stringify(messages));
  const last = msgs[msgs.length - 1];
  if (Array.isArray(last.content) && last.content.length) {
    last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
  }
  return {
    model: MODEL, max_tokens: 32000, stream: true,
    system: SYSTEM, tools: TOOLS, messages: msgs, metadata: METADATA,
    thinking: { type: 'adaptive' },
    ...extra,
  };
}

const asst = content => ({ role: 'assistant', content });

async function main() {
  console.log('[simulate] target proxy:', PROXY);

  emit('SessionStart', { source: 'startup' });
  MAIN.meta({ type: 'mode', mode: 'default' });
  emit('UserPromptSubmit', { prompt: u1.content });
  MAIN.user(u1.content);

  // 0) count_tokens preflight
  await call('/v1/messages/count_tokens', {
    model: MODEL, system: SYSTEM, tools: TOOLS, messages: [u1], metadata: METADATA,
  }, { input_tokens: 14520, ttfbMs: 140 });
  await sleep(250);

  // 1) Turn 1 + parallel haiku title generation
  await Promise.all([
    call('/v1/messages', mainBody([u1]), {
      content: a1, stop_reason: 'tool_use', ttfbMs: 620, usage: USAGE.a1,
    }),
    (async () => {
      await sleep(180);
      await call('/v1/messages', {
        model: 'claude-haiku-4-5', max_tokens: 64, stream: false,
        system: 'Summarize this conversation in a short title (5 words max).',
        messages: [u1], metadata: METADATA,
      }, { content: [{ type: 'text', text: 'Fix auth token refresh 401' }], ttfbMs: 340, usage: { input_tokens: 184, output_tokens: 12 } });
    })(),
  ]);
  MAIN.assistant(a1, USAGE.a1, 'tool_use');
  MAIN.meta({ type: 'ai-title', aiTitle: 'Fix auth token refresh 401' }); // must equal the haiku response above — that call is what produces the title
  // Grep executes locally in the gap the replay already had here
  await runTool(400, 'Grep', 'toolu_grep01', a1[1].input, {
    mode: 'content', numFiles: 2, numLines: 4,
    filenames: ['src/auth/refresh.ts', 'src/auth/client.ts'],
  });
  MAIN.user(u2.content);

  // 2) Turn 2: tool_result fed back
  await call('/v1/messages', mainBody([u1, asst(a1), u2]), {
    content: a2, stop_reason: 'tool_use', ttfbMs: 410, usage: USAGE.a2,
  });
  MAIN.assistant(a2, USAGE.a2, 'tool_use');
  await runTool(350, 'Read', 'toolu_read01', a2[0].input, {
    type: 'text', file: { filePath: '/Users/dev/example-project/src/auth/refresh.ts', numLines: 50, startLine: 1, totalLines: 230 },
  });
  MAIN.user(u3.content);

  // 3) Turn 3: analysis after reading the file + edit
  await call('/v1/messages', mainBody([u1, asst(a1), u2, asst(a2), u3]), {
    content: a3, stop_reason: 'tool_use', ttfbMs: 780, usage: USAGE.a3,
  });
  MAIN.assistant(a3, USAGE.a3, 'tool_use');
  // The Edit needs approval first: the same 300ms gap now splits into permission wait + execution
  await runTool(300, 'Edit', 'toolu_edit01', a3[2].input, {
    filePath: '/Users/dev/example-project/src/auth/refresh.ts', userModified: false, replaceAll: false,
  }, { permission: true });
  MAIN.user(u4.content);

  // 4) Turn 4: eat a 529 first, then retry the identical body successfully
  const round4 = mainBody([u1, asst(a1), u2, asst(a2), u3, asst(a3), u4]);
  await call('/v1/messages', round4, { status: 529, error: { type: 'overloaded_error', message: 'Overloaded' }, ttfbMs: 190 });
  await sleep(900); // SDK backoff
  await call('/v1/messages', round4, {
    content: a4, stop_reason: 'tool_use', ttfbMs: 560, usage: USAGE.a4,
  });
  MAIN.assistant(a4, USAGE.a4, 'tool_use');

  // 5) Foreground subagent (Task): same session, fresh context; system carries cc_is_subagent, spawn point located by prompt matching
  //    The Task tool stays "in flight" for as long as the subagent runs, so its Pre/Post pair brackets both subagent requests
  emit('PreToolUse', { tool_name: 'Task', tool_use_id: 'toolu_task01', tool_input: a4[1].input });
  emit('SubagentStart', { agent_type: 'general-purpose', agent_id: TASK_AGENT_ID });
  SUB.user(su1.content);
  await sleep(250);
  await call('/v1/messages', {
    model: MODEL, max_tokens: 16000, stream: true,
    system: SUB_SYSTEM, tools: TOOLS.slice(0, 6), messages: [su1], metadata: METADATA,
  }, {
    content: sa1, stop_reason: 'tool_use', ttfbMs: 380, usage: USAGE.sa1,
  });
  SUB.assistant(sa1, USAGE.sa1, 'tool_use');
  await runTool(500, 'Bash', 'toolu_bash01', sa1[0].input, {
    stdout: 'PASS src/auth/refresh.test.ts (18 tests, 3.2s)\nPASS src/auth/token-refresh.race.test.ts\n',
    stderr: '', interrupted: false,
  });
  SUB.user(su2.content);
  await call('/v1/messages', {
    model: MODEL, max_tokens: 16000, stream: true,
    system: SUB_SYSTEM, tools: TOOLS.slice(0, 6), messages: [su1, asst(sa1), su2], metadata: METADATA,
  }, {
    content: sa2, stop_reason: 'end_turn', ttfbMs: 300, usage: USAGE.sa2,
  });
  SUB.assistant(sa2, USAGE.sa2, 'end_turn');
  SUB.meta({ type: 'summary', summary: 'Run auth tests: 18 passed incl. the race regression' });
  emit('SubagentStop', { agent_type: 'general-purpose', agent_id: TASK_AGENT_ID });
  emit('PostToolUse', {
    tool_name: 'Task', tool_use_id: 'toolu_task01', tool_input: a4[1].input,
    tool_response: { content: [{ type: 'text', text: sa2[0].text }], totalTokens: 8970 },
  });
  MAIN.user(u5.content);
  await sleep(400);

  // 6) Main chain spawns a background agent (Agent, run_in_background) — tool_result carries agentId, a hard link
  const histAfterTask = [u1, asst(a1), u2, asst(a2), u3, asst(a3), u4, asst(a4), u5];
  await call('/v1/messages', mainBody(histAfterTask), {
    content: aSpawnBg, stop_reason: 'tool_use', ttfbMs: 490, usage: USAGE.spawnBg,
  });
  MAIN.assistant(aSpawnBg, USAGE.spawnBg, 'tool_use');
  // A background Agent returns as soon as it is launched, so its Pre/Post pair is tight while SubagentStop lands much later
  emit('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_agent01', tool_input: aSpawnBg[1].input });
  emit('SubagentStart', { agent_type: 'general-purpose', agent_id: BG_AGENT_ID });
  emit('PostToolUse', {
    tool_name: 'Agent', tool_use_id: 'toolu_agent01', tool_input: aSpawnBg[1].input,
    tool_response: { agentId: BG_AGENT_ID, status: 'launched', background: true },
  });
  MAIN.user(uBgLaunched.content);
  await sleep(300);

  // 7) The background agent's three calls (with the x-claude-code-agent-id header, incl. the model call inside the WebSearch tool) run in parallel with the main chain's wrap-up
  const agentHdr = { 'x-claude-code-agent-id': BG_AGENT_ID };
  await Promise.all([
    (async () => {
      await call('/v1/messages', {
        model: MODEL, max_tokens: 16000, stream: true,
        system: SUB_SYSTEM, tools: TOOLS.slice(0, 6), messages: [bgU1], metadata: METADATA,
      }, {
        content: bgA1, stop_reason: 'tool_use', ttfbMs: 420,
        usage: { input_tokens: 240, cache_creation_input_tokens: 8300, cache_read_input_tokens: 0, output_tokens: 72 },
      }, agentHdr);
      // The WebSearch tool execution wraps the server-tool model call below — hence one long Pre/Post span
      emit('PreToolUse', { tool_name: 'WebSearch', tool_use_id: 'toolu_ws01', tool_input: bgA1[1].input });
      await sleep(350);
      // WebSearch internal call: separate small request (server tool), shares the agent-id
      await call('/v1/messages', {
        model: MODEL, max_tokens: 8000, stream: true,
        system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.202.demo; cc_entrypoint=cli; cc_is_subagent=true;\nYou perform web searches for the user.' }],
        tools: WS_TOOLS, messages: [wsU1], metadata: METADATA,
      }, {
        content: [{ type: 'text', text: '(web_search server tool executed... returned 3 results)' }],
        stop_reason: 'end_turn', ttfbMs: 900,
        usage: { input_tokens: 2100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 610 },
      }, agentHdr);
      await sleep(300);
      emit('PostToolUse', {
        tool_name: 'WebSearch', tool_use_id: 'toolu_ws01', tool_input: bgA1[1].input,
        tool_response: { query: bgA1[1].input.query, durationSeconds: 1.6, results: 3 },
      });
      await call('/v1/messages', {
        model: MODEL, max_tokens: 16000, stream: true,
        system: SUB_SYSTEM, tools: TOOLS.slice(0, 6), messages: [bgU1, asst(bgA1), bgU2], metadata: METADATA,
      }, {
        content: bgA2, stop_reason: 'end_turn', ttfbMs: 330,
        usage: { input_tokens: 150, cache_creation_input_tokens: 210, cache_read_input_tokens: 8540, output_tokens: 96 },
      }, agentHdr);
      emit('SubagentStop', { agent_type: 'general-purpose', agent_id: BG_AGENT_ID });
    })(),
    (async () => {
      await sleep(500);
      // Main chain wrap-up (background agent still running)
      await call('/v1/messages', mainBody([...histAfterTask, asst(aSpawnBg), uBgLaunched]), {
        content: a5, stop_reason: 'end_turn', ttfbMs: 520, usage: USAGE.a5,
      });
      MAIN.assistant(a5, USAGE.a5, 'end_turn');
      emit('Stop', { stop_hook_active: false });
    })(),
  ]);

  // 7) Context compaction: history rewritten as a summary (first message kept, the rest collapsed into a summary)
  const compactSummary = {
    role: 'user',
    content: 'This session is being continued from a previous conversation that ran out of context. Summary: The user asked to fix intermittent 401s in src/auth. Located the concurrent-refresh race in refresh.ts and switched to a shared refresh Promise; all 18 auth tests pass.',
  };
  const u6 = { role: 'user', content: 'Continue: also take care of that TODO concurrency issue in client.ts' };
  const a6 = [
    { type: 'text', text: 'OK, moving on to the concurrency TODO at client.ts:91.' },
    { type: 'tool_use', id: 'toolu_read02', name: 'Read', input: { file_path: '/Users/dev/example-project/src/auth/client.ts' } },
  ];
  // Compaction itself runs in the 600ms gap the replay already had here, so the rewritten
  // history lands before the next prompt instead of sharing its timestamp
  emit('PreCompact', { trigger: 'auto' });
  MAIN.newPrompt();
  MAIN.user(compactSummary.content, { isCompactSummary: true });
  await sleep(600);
  emit('UserPromptSubmit', { prompt: u6.content });
  MAIN.user(u6.content);
  await call('/v1/messages', mainBody([u1, compactSummary, u6]), {
    content: a6,
    stop_reason: 'tool_use', ttfbMs: 450, usage: USAGE.a6,
  });
  MAIN.assistant(a6, USAGE.a6, 'tool_use');
  await runTool(650, 'Read', 'toolu_read02', a6[1].input, {
    type: 'text', file: { filePath: '/Users/dev/example-project/src/auth/client.ts', numLines: 3, startLine: 86, totalLines: 206 },
  });

  // 8) Adding an MCP tool changes tools — the entire prefix cache is busted (the dashboard should flag it as busted, cause: tools)
  const TOOLS_MCP = [...TOOLS, {
    name: 'mcp__github__search_issues',
    description: 'Search issues and pull requests in GitHub repositories via the connected MCP server.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  }];
  const uReadClient = {
    role: 'user',
    content: [{
      type: 'tool_result', tool_use_id: 'toolu_read02',
      content: '    86→export function authHeaders(token: Token) {\n    88→  headers.Authorization = `Bearer ${token.value}`;\n    91→  // TODO: race condition when parallel requests trigger refresh\n(remaining 120 lines omitted...)',
    }],
  };
  const a7 = [{
    type: 'text',
    text: 'All of client.ts\'s callers already go through `ensureFresh`, so the leftover TODO comment can simply be removed. This turn\'s tools change (an MCP tool was added) rewrote the entire prefix cache — an expected cost.',
  }];
  MAIN.user(uReadClient.content);
  await call('/v1/messages', mainBody([u1, compactSummary, u6, asst(a6), uReadClient], { tools: TOOLS_MCP }), {
    content: a7,
    stop_reason: 'end_turn', ttfbMs: 640, usage: USAGE.a7,
  });
  MAIN.assistant(a7, USAGE.a7, 'end_turn');
  emit('Stop', { stop_hook_active: false });
  await sleep(500);

  // 9) /goal-driven traffic: slash command (a first-class identity) → permission review → Stop-hook goal evaluation (advisor
  //    judges goal completion against the full history) → user hits Esc, rewords and resends (a resend — history rollback, not compaction)
  const uGoal = {
    role: 'user',
    content: [
      { type: 'text', text: '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>Make sure every concurrency issue in the auth module is fixed; do not stop until they all are</command-args>\n' },
      { type: 'text', text: '<local-command-stdout>Goal set: Make sure every concurrency issue in the auth module is fixed; do not stop until they all are</local-command-stdout>\n' },
    ],
  };
  const aGoal = [{ type: 'text', text: 'Goal received. First I will do a full sweep of the auth module\'s concurrency surface.' }];
  const goalHist = [u1, compactSummary, u6, asst(a6), uReadClient, asst(a7), uGoal];
  MAIN.newPrompt();
  emit('UserPromptSubmit', { prompt: '/goal Make sure every concurrency issue in the auth module is fixed; do not stop until they all are' });
  MAIN.user(uGoal.content);
  await call('/v1/messages', mainBody(goalHist, { tools: TOOLS_MCP }), {
    content: aGoal, stop_reason: 'end_turn', ttfbMs: 480, usage: USAGE.goal,
  });
  MAIN.assistant(aGoal, USAGE.goal, 'end_turn');
  await sleep(400);
  // Permission review side-channel (conversation digest + blocking policy, no tool set)
  await call('/v1/messages', {
    model: MODEL, max_tokens: 64, stream: false,
    messages: [{ role: 'user', content: '<transcript>\n{"user":"Make sure every concurrency issue in the auth module is fixed"}\n{"Bash":"npm test -- auth"}\n</transcript>\n\nErr on the side of blocking. Stage 1 does NOT apply user intent or ALLOW exceptions. Block if ANY rule could apply. <block> immediately.' }],
    metadata: METADATA,
  }, {
    content: [{ type: 'text', text: '<allow/>' }], stop_reason: 'end_turn', ttfbMs: 300,
    usage: { input_tokens: 820, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 6 },
  });
  // The reviewed Bash starts, then the user hits Esc — the only tool of the session that never
  // finishes, so its tool_result never reaches the API layer and the turn is rolled back below
  await runTool(400, 'Bash', 'toolu_bash02', {
    command: 'npm test -- auth --runInBand', description: 'Concurrency sweep of the auth module',
  }, { stdout: '> jest src/auth --runInBand\n', stderr: 'Interrupted by user', interrupted: true }, { fail: true });
  emit('Stop', { stop_hook_active: false });
  // Stop-hook goal evaluation (advisor: full conversation history + the verdict question)
  await call('/v1/messages', {
    model: MODEL, max_tokens: 512, stream: false,
    messages: [...goalHist, asst(aGoal), {
      role: 'user',
      content: 'Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.\n\nCondition: Make sure every concurrency issue in the auth module is fixed; do not stop until they all are',
    }],
    metadata: METADATA,
  }, {
    content: [{ type: 'text', text: 'Not satisfied: the client.ts TODO has been removed, but the shared-Promise approach in refresh.ts has not yet been validated for its concurrency ceiling. Recommend continuing.' }],
    stop_reason: 'end_turn', ttfbMs: 900,
    usage: { input_tokens: 380, cache_creation_input_tokens: 0, cache_read_input_tokens: 30100, output_tokens: 64 },
  });
  await sleep(400);
  // User hits Esc, rewords and resends: back to the history before uGoal + new input (should be labeled a resend, not compaction)
  const uResend = { role: 'user', content: 'Forget the goal for now — measure refresh.ts\'s concurrency ceiling' };
  const aResend = [{ type: 'text', text: 'OK, going straight to load-testing refresh.ts\'s concurrent refresh.' }];
  MAIN.newPrompt();
  emit('UserPromptSubmit', { prompt: uResend.content });
  MAIN.user(uResend.content);
  await call('/v1/messages', mainBody([u1, compactSummary, u6, asst(a6), uReadClient, asst(a7), uResend], { tools: TOOLS_MCP }), {
    content: aResend,
    stop_reason: 'end_turn', ttfbMs: 420, usage: USAGE.resend,
  });
  MAIN.assistant(aResend, USAGE.resend, 'end_turn');
  emit('Stop', { stop_hook_active: false });
  emit('SessionEnd', { reason: 'prompt_input_exit' });

  const wroteTranscripts = writeTranscripts();
  const hookTotal = Object.values(hookCounts).reduce((a, b) => a + b, 0);
  if (HOOKS_DIR) console.log(`[simulate] hook events: ${hookTotal} across ${Object.keys(hookCounts).length} event types → ${HOOKS_DIR}`);
  if (wroteTranscripts) {
    console.log(`[simulate] transcripts: ${CHAINS.map(c => `${c.file} (${c.recs.length} records)`).join(', ')} → ${path.join(TRANSCRIPTS_DIR, PROJECT_DIR)}`);
  }
  console.log('[simulate] done — open the dashboard: ' + PROXY);
}

main().catch(e => { console.error('[simulate] failed:', e); process.exit(1); });
