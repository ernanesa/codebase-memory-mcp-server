export const INITIAL_PROTOCOL_VERSION = '2025-06-18';

function parseJson(value, context) {
  try { return JSON.parse(value); } catch { throw new Error(`${context} não contém JSON-RPC válido.`); }
}

export function parseSseMessages(body) {
  const messages = [];
  let data = [];
  const dispatch = () => {
    if (data.length > 0) messages.push(parseJson(data.join('\n'), 'Evento SSE'));
    data = [];
  };
  for (const line of String(body).replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    if (line === '') { dispatch(); continue; }
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
  }
  dispatch();
  return messages;
}

function selectResponse(messages, id) {
  const response = messages.find(message => message?.jsonrpc === '2.0' && message.id === id);
  if (!response) throw new Error(`MCP não retornou resposta para a requisição ${id}.`);
  if (response.error) throw new Error(`MCP retornou erro: ${response.error.message || response.error.code}.`);
  if (!('result' in response)) throw new Error(`Resposta MCP ${id} não contém result.`);
  return response.result;
}

async function send(endpoint, token, body, headers, { notification = false, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: JSON.stringify(body)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP retornou HTTP ${response.status}.`);
  if (notification) {
    if (response.status !== 202 || raw.length > 0) throw new Error('Notificação MCP deve retornar HTTP 202 sem corpo.');
    return { sessionId: response.headers.get('mcp-session-id') };
  }
  const contentType = response.headers.get('content-type') || '';
  const messages = contentType.toLowerCase().startsWith('text/event-stream') ? parseSseMessages(raw) : [parseJson(raw, 'Resposta MCP')];
  return { result: selectResponse(messages, body.id), bytes: Buffer.byteLength(raw), sessionId: response.headers.get('mcp-session-id') };
}

export async function mcpCall(endpoint, token, tool, argumentsValue, { fetchImpl = fetch } = {}) {
  const initialized = await send(endpoint, token, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: INITIAL_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'code-eval', version: '1.0.0' } }
  }, {}, { fetchImpl });
  const protocolVersion = initialized.result?.protocolVersion;
  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) throw new Error('InitializeResult não informou protocolVersion.');
  const headers = { 'mcp-protocol-version': protocolVersion, ...(initialized.sessionId ? { 'mcp-session-id': initialized.sessionId } : {}) };
  await send(endpoint, token, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, headers, { notification: true, fetchImpl });
  return send(endpoint, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: argumentsValue } }, headers, { fetchImpl });
}
