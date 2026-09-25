import { json, body, requestOriginAllowed, clientAddress, secureRequest } from '../http.js';

/**
 * Verifica se o endereço IP do cliente pode realizar novas tentativas de login.
 * @param {Map<string, { failures: number, resetAt: number }>} loginAttempts
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
function loginAllowed(loginAttempts, request) {
  const key = clientAddress(request);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) return true;
  return current.failures < 5;
}

/**
 * Registra uma tentativa falha de login para o endereço IP do cliente (janela de 5 minutos).
 * @param {Map<string, { failures: number, resetAt: number }>} loginAttempts
 * @param {import('node:http').IncomingMessage} request
 */
function registerLoginFailure(loginAttempts, request) {
  const key = clientAddress(request);
  const now = Date.now();
  const current = loginAttempts.get(key);
  loginAttempts.set(key, !current || current.resetAt <= now
    ? { failures: 1, resetAt: now + 5 * 60_000 }
    : { ...current, failures: current.failures + 1 });
}

/**
 * Registra as rotas de autenticação no roteador.
 * @param {object} router
 * @param {object} ctx
 * @param {object} ctx.adminAuth
 * @param {Map<string, { failures: number, resetAt: number }>} ctx.loginAttempts
 * @param {{ ADMIN_COOKIE_SECURE?: boolean }} [ctx.config]
 */
export function register(router, ctx) {
  router.add('POST', '/api/auth/login', async (request, response, url, params) => {
    if (!requestOriginAllowed(request)) return json(response, 403, { error: 'Origem não permitida.' });
    if (!loginAllowed(ctx.loginAttempts, request)) return json(response, 429, { error: 'Muitas tentativas. Aguarde alguns minutos.' });
    const payload = await body(request);
    if (!await ctx.adminAuth.verifyCredentials(payload.username, payload.password)) {
      registerLoginFailure(ctx.loginAttempts, request);
      return json(response, 401, { error: 'Usuário ou senha inválidos.' });
    }
    ctx.loginAttempts.delete(clientAddress(request));
    const token = ctx.adminAuth.issueToken();
    const secure = secureRequest(request, Boolean(ctx.config?.ADMIN_COOKIE_SECURE));
    response.setHeader('set-cookie', ctx.adminAuth.sessionCookie(token, secure));
    return json(response, 200, { user: { username: ctx.adminAuth.username, role: 'admin' } });
  });

  router.add('GET', '/api/auth/session', async (request, response, url, params) => {
    const session = ctx.adminAuth.session(request);
    return session
      ? json(response, 200, { user: { username: session.sub, role: session.role } })
      : json(response, 401, { error: 'Autenticação necessária.' });
  });

  router.add('POST', '/api/auth/logout', async (request, response, url, params) => {
    if (!requestOriginAllowed(request)) return json(response, 403, { error: 'Origem não permitida.' });
    ctx.adminAuth.revoke(ctx.adminAuth.tokenFromRequest(request));
    const secure = secureRequest(request, Boolean(ctx.config?.ADMIN_COOKIE_SECURE));
    response.setHeader('set-cookie', ctx.adminAuth.clearCookie(secure));
    return json(response, 200, { ok: true });
  });
}
