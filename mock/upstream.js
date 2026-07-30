#!/usr/bin/env node
/**
 * Mock upstream — simulates the Anthropic API for local cclens demos/tests.
 * The x-mock request header (base64url JSON) specifies what to return:
 *   { content: [...], usage: {...}, stop_reason, ttfbMs, status, error }
 * Streaming requests are returned chunk by chunk following the real SSE event sequence.
 */
'use strict';

const http = require('http');
const PORT = Number(process.env.PORT || 8378);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function decodeMock(req) {
  const h = req.headers['x-mock'];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); }
  catch { return null; }
}

function json(res, status, obj, extraHeaders) {
  res.writeHead(status, { 'content-type': 'application/json', ...(extraHeaders || {}) });
  res.end(JSON.stringify(obj));
}

// Simulate account-level rate-limit headers (the real API attaches anthropic-ratelimit-* to every response)
let rlRequests = 3996;
function rateLimitHeaders() {
  rlRequests = Math.max(rlRequests - 1, 3900);
  return {
    'anthropic-ratelimit-requests-limit': '4000',
    'anthropic-ratelimit-requests-remaining': String(rlRequests),
    'anthropic-ratelimit-requests-reset': new Date(Date.now() + 47000).toISOString(),
    'anthropic-ratelimit-input-tokens-limit': '400000',
    'anthropic-ratelimit-input-tokens-remaining': String(400000 - (4000 - rlRequests) * 1800),
    'anthropic-ratelimit-input-tokens-reset': new Date(Date.now() + 47000).toISOString(),
  };
}

function chunkString(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

async function streamMessage(res, body, spec) {
  const usage = spec.usage || {};
  const content = spec.content || [{ type: 'text', text: 'ok' }];
  const msgId = 'msg_' + Math.random().toString(36).slice(2, 14);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'request-id': 'req_' + Math.random().toString(36).slice(2, 12),
    ...rateLimitHeaders(),
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  await sleep(spec.ttfbMs || 300);

  send('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: {
        input_tokens: usage.input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        output_tokens: 1,
      },
    },
  });

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      for (const c of chunkString(block.text || '', 18)) {
        send('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: c } });
        await sleep(6);
      }
    } else if (block.type === 'thinking') {
      send('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } });
      for (const c of chunkString(block.thinking || '', 24)) {
        send('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: c } });
        await sleep(5);
      }
      send('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: 'sig_' + msgId } });
    } else if (block.type === 'tool_use') {
      send('content_block_start', {
        type: 'content_block_start', index: i,
        content_block: { type: 'tool_use', id: block.id || 'toolu_' + Math.random().toString(36).slice(2, 10), name: block.name, input: {} },
      });
      for (const c of chunkString(JSON.stringify(block.input || {}), 20)) {
        send('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: c } });
        await sleep(6);
      }
    }
    send('content_block_stop', { type: 'content_block_stop', index: i });
  }

  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: spec.stop_reason || 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage.output_tokens || 10 },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

function fullMessage(body, spec) {
  const usage = spec.usage || {};
  return {
    id: 'msg_' + Math.random().toString(36).slice(2, 14),
    type: 'message', role: 'assistant', model: body.model,
    content: spec.content || [{ type: 'text', text: 'ok' }],
    stop_reason: spec.stop_reason || 'end_turn', stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      output_tokens: usage.output_tokens || 10,
    },
  };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    const spec = decodeMock(req) || {};
    const path = (req.url || '').split('?')[0];

    if (path === '/__mock/health') return json(res, 200, { ok: true });

    if (path === '/v1/messages/count_tokens') {
      await sleep(spec.ttfbMs || 120);
      return json(res, 200, { input_tokens: spec.input_tokens || Math.round(JSON.stringify(body).length / 3.4) });
    }

    if (path === '/v1/messages') {
      if (spec.status && spec.status >= 400) {
        await sleep(spec.ttfbMs || 150);
        return json(res, spec.status, { type: 'error', error: spec.error || { type: 'api_error', message: 'simulated error' } }, rateLimitHeaders());
      }
      if (body.stream) return streamMessage(res, body, spec).catch(() => { try { res.end(); } catch {} });
      await sleep(spec.ttfbMs || 250);
      return json(res, 200, fullMessage(body, spec), rateLimitHeaders());
    }

    json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'mock: unknown path ' + path } });
  });
});

server.listen(PORT, () => console.log(`[mock-upstream] http://localhost:${PORT}`));
