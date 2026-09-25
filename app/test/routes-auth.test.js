import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRouter } from '../src/router.js';
import { register } from '../src/routes/auth.js';

function createMockRequest({ method = 'GET', url = '/', headers = {}, body = null }) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:8080', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    end(chunk = '') {
      this.body += chunk;
    }
  };
}

function setupTestContext(configOverrides = {}) {
  const loginAttempts = new Map();
  const tokens = new Set();
  const adminAuth = {
    username: 'admin',
    async verifyCredentials(username, password) {
      return username === 'admin' && password === 'secret123';
    },
    issueToken() {
      const token = 'valid-jwt-token';
      tokens.add(token);
      return token;
    },
    session(req) {
      const auth = req.headers.authorization;
      const cookie = req.headers.cookie;
      if (auth === 'Bearer valid-jwt-token' || (cookie && cookie.includes('cbm_admin_session=valid-jwt-token'))) {
        return { sub: 'admin', role: 'admin' };
      }
      return null;
    },
    tokenFromRequest(req) {
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
      const match = (req.headers.cookie || '').match(/cbm_admin_session=([^;]+)/);
      return match ? match[1] : '';
    },
    revoke(token) {
      tokens.delete(token);
    },
    sessionCookie(token, secure) {
      return `cbm_admin_session=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
    },
    clearCookie(secure) {
      return `cbm_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
    }
  };

  const router = createRouter();
  const ctx = {
    adminAuth,
    loginAttempts,
    config: {
      ADMIN_COOKIE_SECURE: false,
      ...configOverrides
    }
  };

  register(router, ctx);
  return { router, ctx, tokens };
}

test('POST /api/auth/login valida credenciais e define cookie de sessão', async () => {
  const { router, ctx } = setupTestContext();
  const match = router.match('POST', '/api/auth/login');
  assert.ok(match);

  const req = createMockRequest({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'http://localhost:8080' },
    body: { username: 'admin', password: 'secret123' }
  });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/auth/login'), match.params);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { user: { username: 'admin', role: 'admin' } });
  assert.equal(res.getHeader('set-cookie'), 'cbm_admin_session=valid-jwt-token; Path=/; HttpOnly; SameSite=Strict');
  assert.equal(ctx.loginAttempts.has('127.0.0.1'), false);
});

test('POST /api/auth/login bloqueia requisições com origem não permitida (403)', async () => {
  const { router } = setupTestContext();
  const match = router.match('POST', '/api/auth/login');

  const req = createMockRequest({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'http://malicious.example.com' },
    body: { username: 'admin', password: 'secret123' }
  });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/auth/login'), match.params);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'Origem não permitida.' });
});

test('POST /api/auth/login rejeita credenciais inválidas e incrementa falhas (401)', async () => {
  const { router, ctx } = setupTestContext();
  const match = router.match('POST', '/api/auth/login');

  const req = createMockRequest({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'http://localhost:8080' },
    body: { username: 'admin', password: 'wrongpassword' }
  });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/auth/login'), match.params);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'Usuário ou senha inválidos.' });

  const record = ctx.loginAttempts.get('127.0.0.1');
  assert.ok(record);
  assert.equal(record.failures, 1);
  assert.ok(record.resetAt > Date.now());
});

test('POST /api/auth/login bloqueia após 5 falhas consecutivas (rate limit 429)', async () => {
  const { router, ctx } = setupTestContext();
  const match = router.match('POST', '/api/auth/login');

  ctx.loginAttempts.set('127.0.0.1', { failures: 5, resetAt: Date.now() + 60_000 });

  const req = createMockRequest({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'http://localhost:8080' },
    body: { username: 'admin', password: 'secret123' }
  });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/auth/login'), match.params);

  assert.equal(res.statusCode, 429);
  assert.deepEqual(JSON.parse(res.body), { error: 'Muitas tentativas. Aguarde alguns minutos.' });
});

test('POST /api/auth/login aplica flag Secure se ADMIN_COOKIE_SECURE estiver ativo', async () => {
  const { router } = setupTestContext({ ADMIN_COOKIE_SECURE: true });
  const match = router.match('POST', '/api/auth/login');

  const req = createMockRequest({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'http://localhost:8080' },
    body: { username: 'admin', password: 'secret123' }
  });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/auth/login'), match.params);

  assert.equal(res.statusCode, 200);
  assert.ok(res.getHeader('set-cookie').includes('Secure'));
});

test('GET /api/auth/session retorna a sessão atual quando autenticado', async () => {
  const { router } = setupTestContext();
  const match = router.match('GET', '/api/auth/session');
  assert.ok(match);

  const req = createMockRequest({
    method: 'GET',
    url: '/api/auth/session',
    headers: { authorization: 'Bearer valid-jwt-token' }
  });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/auth/session'), match.params);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { user: { username: 'admin', role: 'admin' } });
});

test('GET /api/auth/session retorna 401 quando não autenticado', async () => {
  const { router } = setupTestContext();
  const match = router.match('GET', '/api/auth/session');

  const req = createMockRequest({
    method: 'GET',
    url: '/api/auth/session',
    headers: {}
  });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/auth/session'), match.params);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { error: 'Autenticação necessária.' });
});

test('POST /api/auth/logout revoga token e limpa cookie de sessão', async () => {
  const { router, tokens } = setupTestContext();
  const match = router.match('POST', '/api/auth/logout');
  assert.ok(match);

  tokens.add('valid-jwt-token');

  const req = createMockRequest({
    method: 'POST',
    url: '/api/auth/logout',
    headers: {
      origin: 'http://localhost:8080',
      authorization: 'Bearer valid-jwt-token'
    }
  });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/auth/logout'), match.params);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.ok(res.getHeader('set-cookie').includes('Max-Age=0'));
  assert.equal(tokens.has('valid-jwt-token'), false);
});

test('POST /api/auth/logout rejeita origem não permitida (403)', async () => {
  const { router } = setupTestContext();
  const match = router.match('POST', '/api/auth/logout');

  const req = createMockRequest({
    method: 'POST',
    url: '/api/auth/logout',
    headers: {
      origin: 'http://attacker.example.com',
      authorization: 'Bearer valid-jwt-token'
    }
  });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/auth/logout'), match.params);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'Origem não permitida.' });
});
