import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpCall, parseSseMessages } from '../mcp-http.mjs';

test('parser SSE aceita CRLF, comentários, event e múltiplas linhas data', () => {
  const messages = parseSseMessages(': ping\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":{}}\r\n\r\n');
  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 1, result: {} }]);
});

test('cliente negocia sessão, envia initialized e header de versão, e escolhe a resposta SSE correta', async () => {
  const requests = [];
  const fetchImpl = async (_url, request) => {
    const message = JSON.parse(request.body);
    requests.push({ headers: new Headers(request.headers), message });
    if (message.method === 'initialize') {
      return new Response(': connected\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{}}}\r\n\r\n', { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'mcp-session-id': 'session-1' } });
    }
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response(': progress\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":50}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"results":[]}}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const result = await mcpCall('https://mcp.example.test/mcp', 'test-token', 'code_search_surgical', { project: 'demo', query: 'FindOrder' }, { fetchImpl });
  assert.deepEqual(result.result, { structuredContent: { results: [] } });
  assert.equal(requests.length, 3);
  assert.equal(requests[1].message.method, 'notifications/initialized');
  assert.equal(requests[1].headers.get('mcp-session-id'), 'session-1');
  assert.equal(requests[1].headers.get('mcp-protocol-version'), '2025-06-18');
  assert.equal(requests[2].headers.get('mcp-protocol-version'), '2025-06-18');
  assert.equal(requests[2].headers.get('authorization'), 'Bearer test-token');
});
