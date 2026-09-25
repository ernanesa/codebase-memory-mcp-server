import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRouter } from '../src/router.js';
import { register } from '../src/routes/knowledge-sync.js';

function createMockRequest({ method = 'GET', url = '/', headers = {}, body = null }) {
  const req = Readable.from(body !== null && body !== undefined ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))] : []);
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

function setupTestContext(overrides = {}) {
  const router = createRouter();
  const calls = [];

  const ctx = {
    async knowledgeSyncRequest(pathname, options = {}) {
      calls.push({ type: 'knowledgeSyncRequest', pathname, options });
      if (overrides.knowledgeSyncRequest) {
        return overrides.knowledgeSyncRequest(pathname, options);
      }
      return { status: 200, result: { ok: true, pathname, options } };
    },
    validateGoogleServiceAccount(value) {
      calls.push({ type: 'validateGoogleServiceAccount', value });
      if (overrides.validateGoogleServiceAccount) {
        return overrides.validateGoogleServiceAccount(value);
      }
      if (!value || typeof value !== 'object' || value.type !== 'service_account') {
        throw new Error('Informe o JSON da Service Account.');
      }
      return { ...value, client_email: 'test@example.iam.gserviceaccount.com' };
    },
    async saveGoogleServiceAccount(credentials) {
      calls.push({ type: 'saveGoogleServiceAccount', credentials });
      if (overrides.saveGoogleServiceAccount) {
        return overrides.saveGoogleServiceAccount(credentials);
      }
    },
    async removeGoogleServiceAccount() {
      calls.push({ type: 'removeGoogleServiceAccount' });
      if (overrides.removeGoogleServiceAccount) {
        return overrides.removeGoogleServiceAccount();
      }
    },
    ...overrides
  };

  register(router, ctx);
  return { router, ctx, calls };
}

test('registra as rotas na ordem correta (credenciais antes do prefixo catch-all)', () => {
  const { router } = setupTestContext();

  const getCreds = router.match('GET', '/api/knowledge-sync/credentials');
  assert.ok(getCreds, 'GET credentials deve ser registrado');

  const putCreds = router.match('PUT', '/api/knowledge-sync/credentials');
  assert.ok(putCreds, 'PUT credentials deve ser registrado');

  const delCreds = router.match('DELETE', '/api/knowledge-sync/credentials');
  assert.ok(delCreds, 'DELETE credentials deve ser registrado');

  const prefixMatch = router.match('GET', '/api/knowledge-sync/targets');
  assert.ok(prefixMatch, 'Prefixo catch-all deve corresponder a outras rotas');
});

test('GET /api/knowledge-sync/credentials retorna status do worker', async () => {
  const { router, calls } = setupTestContext({
    async knowledgeSyncRequest(pathname, options) {
      calls.push({ type: 'knowledgeSyncRequest', pathname, options });
      return { status: 200, result: { configured: true, email: 'sa@example.com' } };
    }
  });

  const match = router.match('GET', '/api/knowledge-sync/credentials');
  const req = createMockRequest({ method: 'GET', url: '/api/knowledge-sync/credentials' });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/knowledge-sync/credentials'), match.params);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { configured: true, email: 'sa@example.com' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/api/status');
});

test('PUT /api/knowledge-sync/credentials valida, salva credenciais e retorna status', async () => {
  const { router, calls } = setupTestContext({
    async knowledgeSyncRequest(pathname, options) {
      calls.push({ type: 'knowledgeSyncRequest', pathname, options });
      return { status: 200, result: { configured: true, status: 'ready' } };
    }
  });

  const match = router.match('PUT', '/api/knowledge-sync/credentials');
  const saData = { type: 'service_account', project_id: 'test-proj' };
  const req = createMockRequest({
    method: 'PUT',
    url: '/api/knowledge-sync/credentials',
    body: { credentials: saData }
  });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/knowledge-sync/credentials'), match.params);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { configured: true, status: 'ready' });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].type, 'validateGoogleServiceAccount');
  assert.deepEqual(calls[0].value, saData);
  assert.equal(calls[1].type, 'saveGoogleServiceAccount');
  assert.equal(calls[2].type, 'knowledgeSyncRequest');
  assert.equal(calls[2].pathname, '/api/status');
});

test('PUT /api/knowledge-sync/credentials aceita payload direto sem chave credentials aninhada', async () => {
  const { router, calls } = setupTestContext();

  const match = router.match('PUT', '/api/knowledge-sync/credentials');
  const saData = { type: 'service_account', project_id: 'direct-sa' };
  const req = createMockRequest({
    method: 'PUT',
    url: '/api/knowledge-sync/credentials',
    body: saData
  });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/knowledge-sync/credentials'), match.params);

  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].type, 'validateGoogleServiceAccount');
  assert.deepEqual(calls[0].value, saData);
});

test('DELETE /api/knowledge-sync/credentials notifica worker, remove credencial e retorna status', async () => {
  const { router, calls } = setupTestContext({
    async knowledgeSyncRequest(pathname, options) {
      calls.push({ type: 'knowledgeSyncRequest', pathname, options });
      if (pathname === '/api/status') {
        return { status: 200, result: { configured: false } };
      }
      return { status: 200, result: { ok: true } };
    }
  });

  const match = router.match('DELETE', '/api/knowledge-sync/credentials');
  const req = createMockRequest({ method: 'DELETE', url: '/api/knowledge-sync/credentials' });
  const res = createMockResponse();

  await match.handler(req, res, new URL('http://localhost:8080/api/knowledge-sync/credentials'), match.params);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { configured: false });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].type, 'knowledgeSyncRequest');
  assert.equal(calls[0].pathname, '/api/targets/drive-credentials-removed');
  assert.deepEqual(calls[0].options, { method: 'POST', payload: {} });

  assert.equal(calls[1].type, 'removeGoogleServiceAccount');

  assert.equal(calls[2].type, 'knowledgeSyncRequest');
  assert.equal(calls[2].pathname, '/api/status');
});

test('prefixo catch-all repassa GET removendo prefixo e mantendo query params', async () => {
  const { router, calls } = setupTestContext();

  const match = router.match('GET', '/api/knowledge-sync/targets');
  assert.ok(match);

  const req = createMockRequest({ method: 'GET', url: '/api/knowledge-sync/targets?page=1&limit=10' });
  const res = createMockResponse();
  const url = new URL('http://localhost:8080/api/knowledge-sync/targets?page=1&limit=10');

  await match.handler(req, res, url, match.params);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'knowledgeSyncRequest');
  assert.equal(calls[0].pathname, '/api/targets?page=1&limit=10');
  assert.deepEqual(calls[0].options, { method: 'GET', payload: undefined });
});

test('prefixo catch-all lê body como JSON para POST, PUT e PATCH', async () => {
  const { router, calls } = setupTestContext();

  for (const method of ['POST', 'PUT', 'PATCH']) {
    calls.length = 0;
    const match = router.match(method, '/api/knowledge-sync/targets/pause-all');
    assert.ok(match, `Deve corresponder ao método ${method}`);

    const payload = { action: 'pause', timestamp: 12345 };
    const req = createMockRequest({
      method,
      url: '/api/knowledge-sync/targets/pause-all',
      body: payload
    });
    const res = createMockResponse();
    const url = new URL('http://localhost:8080/api/knowledge-sync/targets/pause-all');

    await match.handler(req, res, url, match.params);

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'knowledgeSyncRequest');
    assert.equal(calls[0].pathname, '/api/targets/pause-all');
    assert.deepEqual(calls[0].options, { method, payload });
  }
});

test('prefixo catch-all não lê body para DELETE e repassa payload undefined', async () => {
  const { router, calls } = setupTestContext();

  const match = router.match('DELETE', '/api/knowledge-sync/targets/target-123');
  assert.ok(match);

  const req = createMockRequest({ method: 'DELETE', url: '/api/knowledge-sync/targets/target-123' });
  const res = createMockResponse();
  const url = new URL('http://localhost:8080/api/knowledge-sync/targets/target-123');

  await match.handler(req, res, url, match.params);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'knowledgeSyncRequest');
  assert.equal(calls[0].pathname, '/api/targets/target-123');
  assert.deepEqual(calls[0].options, { method: 'DELETE', payload: undefined });
});
