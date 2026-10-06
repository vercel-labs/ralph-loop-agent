import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { search, searchTransport } from './search';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};
const tool = {
  name: 'web_search',
  description: 'Search the web',
  inputSchema: {
    type: 'object',
    properties: { objective: { type: 'string' }, search_queries: { type: 'array', items: { type: 'string' } } },
    required: ['objective', 'search_queries'],
  },
};

function model() {
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt, tools }) => {
      assert.ok(tools?.some(t => t.type === 'function' && t.name === 'web_search'));
      calls++;
      if (calls === 1) {
        return {
          content: [{ type: 'tool-call' as const, toolCallId: 'search-1', toolName: 'web_search', input: JSON.stringify({ objective: 'Find what RalphLoopAgent does, using its official repository', search_queries: ['vercel ralph-loop-agent continuous autonomy'] }) }],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage, warnings: [],
        };
      }
      const message = prompt.find(m => m.role === 'tool');
      assert.ok(message && message.role === 'tool');
      const output = JSON.stringify(message.content);
      assert.match(output, /https?:/);
      // Derive the answer from the received tool output, not a fixed success string.
      return {
        content: [{ type: 'text' as const, text: `Search evidence for RalphLoopAgent: ${output}` }],
        finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [],
      };
    },
  });
}

test('HTTP discovery feeds RalphLoopAgent tools and produces a sourced answer; client closes', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { method: string; rpc?: string }[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), searchTransport.url);
    const headers = new Headers(init?.headers);
    assert.ok(headers.get('User-Agent')?.startsWith('ralph-loop-agent/search-example'));
    assert.equal(headers.get('Authorization'), null);
    const method = init?.method ?? 'GET';
    const rpc = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, rpc: rpc?.method });
    if (method === 'DELETE') return new Response(null, { status: 200 });
    if (method === 'GET') return new Response(null, { status: 405 });
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const result = rpc.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : rpc.method === 'tools/list' ? { tools: [tool] }
      : { content: [{ type: 'text', text: 'RalphLoopAgent adds continuous autonomy to AI SDK: https://github.com/vercel-labs/ralph-loop-agent' }] };
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result }, { headers: { 'mcp-session-id': 'fixture-session' } });
  };
  try {
    const result = await search({ prompt: 'What does RalphLoopAgent do?', model: model() });
    assert.equal(result.completionReason, 'verified');
    assert.equal(result.iterations, 1);
    assert.match(result.text, /continuous autonomy/);
    assert.match(result.text, /https:\/\/github.com/);
    assert.ok(requests.some(r => r.rpc === 'tools/list'));
    assert.ok(requests.some(r => r.rpc === 'tools/call'));
    assert.equal(requests.at(-1)?.method, 'DELETE');
  } finally { globalThis.fetch = originalFetch; }
});

test('discovery errors propagate and still close the session', async () => {
  const originalFetch = globalThis.fetch;
  let closed = false;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'DELETE') { closed = true; return new Response(null, { status: 200 }); }
    const rpc = JSON.parse(String(init?.body));
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    return Response.json(rpc.method === 'initialize'
      ? { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }
      : { jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'Discovery failed' } },
      { headers: { 'mcp-session-id': 'fixture-session' } });
  };
  try {
    await assert.rejects(search({ prompt: 'Question', model: model() }), /Discovery failed/);
    assert.ok(closed);
  } finally { globalThis.fetch = originalFetch; }
});

test('live keyless HTTP search through the same agent path', { skip: process.env.TEST_SEARCH_LIVE !== '1' }, async () => {
  const originalFetch = globalThis.fetch;
  const requests: { method: string; rpc?: string; url: string; authorization: boolean; userAgent: string | null }[] = [];
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const rpc = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init?.method ?? 'GET', rpc: rpc?.method, url: String(input), authorization: headers.has('Authorization'), userAgent: headers.get('User-Agent') });
    return originalFetch(input, init);
  };
  try {
    const result = await search({ prompt: 'What does RalphLoopAgent do?', model: model(), abortSignal: AbortSignal.timeout(60_000) });
    assert.equal(result.completionReason, 'verified');
    assert.match(result.text, /ralph-loop-agent/);
    assert.match(result.text, /https?:/);
    assert.ok(requests.some(r => r.rpc === 'tools/call'));
    assert.ok(requests.every(r => !r.authorization && r.userAgent?.startsWith(searchTransport.headers['User-Agent'])));
    console.log(JSON.stringify({ finalAnswer: result.text, requests, iterations: result.iterations, completionReason: result.completionReason }));
  } finally { globalThis.fetch = originalFetch; }
});
