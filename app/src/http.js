/**
 * Funções auxiliares HTTP compartilhadas entre os módulos de rota.
 * Sem dependências externas — usa apenas APIs nativas do Node 22.
 */

/**
 * Envia uma resposta JSON.
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} payload
 */
export function json(response, status, payload) {
  let statusCode = status;
  let body = payload;
  if (payload === undefined && typeof status !== 'number') {
    body = status;
    statusCode = response.statusCode && response.statusCode !== 200 ? response.statusCode : 200;
  }
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/**
 * Envia uma resposta de texto.
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {string} payload
 * @param {string} [contentType]
 */
export function textResponse(response, status, payload, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(payload);
}

/**
 * Redireciona para a localização indicada.
 * @param {import('node:http').ServerResponse} response
 * @param {string} location
 */
export function redirect(response, location) {
  response.writeHead(302, { location, 'cache-control': 'no-store' });
  response.end();
}

/**
 * Lê e parseia o corpo da requisição como JSON, com limite de tamanho.
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<object>}
 */
export async function body(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Corpo da requisição muito grande.');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('JSON inválido.'); }
}

/**
 * Verifica se a origem da requisição corresponde ao host (proteção CSRF).
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
export function requestOriginAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();
    return new URL(origin).host === host;
  } catch { return false; }
}

/**
 * Retorna o endereço IP real do cliente.
 * @param {import('node:http').IncomingMessage} request
 * @returns {string}
 */
export function clientAddress(request) {
  return String(request.headers['x-real-ip'] || request.socket.remoteAddress || 'unknown');
}

/**
 * Indica se a requisição chega via HTTPS (direta ou via proxy).
 * @param {import('node:http').IncomingMessage} request
 * @param {boolean} forceSecure
 * @returns {boolean}
 */
export function secureRequest(request, forceSecure = false) {
  return forceSecure || String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
