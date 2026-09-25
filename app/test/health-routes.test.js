import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../src/routes/health.js';
import * as healthModule from '../src/routes/health.js';
import { createRouter } from '../src/router.js';

function createMockResponse() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(data = '') {
      this.body = data;
    }
  };
}

test('exporta apenas a função register', () => {
  const exports = Object.keys(healthModule);
  assert.deepEqual(exports, ['register']);
  assert.equal(typeof healthModule.register, 'function');
});

test('valida parâmetros obrigatórios com mensagens em português', () => {
  assert.throws(
    () => register(null, {}),
    { message: 'Roteador inválido fornecido para registro de rotas.' }
  );
  assert.throws(
    () => register({ add: () => {} }, null),
    { message: 'Contexto com configuração é obrigatório.' }
  );
  assert.throws(
    () => register({ add: () => {} }, {}),
    { message: 'Contexto com configuração é obrigatório.' }
  );
});

test('GET /api/health e /api/health/live retornam status ok', async () => {
  const router = createRouter();
  const ctx = {
    config: {
      AGENTGATEWAY_ADMIN_URL: 'http://agentgateway:8080',
      KNOWLEDGE_SYNC_ENABLED: false,
      KNOWLEDGE_SYNC_URL: 'http://knowledge-sync:3002',
      UI_PORT: 3000,
      GRAFANA_PUBLIC_URL: 'http://grafana:3000',
      MCP_PUBLIC_URL: 'http://mcp:8080'
    }
  };
  register(router, ctx);

  for (const path of ['/api/health', '/api/health/live']) {
    const match = router.match('GET', path);
    assert.ok(match, `Rota ${path} deve estar registrada`);
    const res = createMockResponse();
    await match.handler({}, res, new URL(`http://localhost${path}`), match.params);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
  }
});

test('GET /api/health/ready e /api/health/detail retornam 200 quando dependências estão saudáveis', async (t) => {
  const router = createRouter();
  const ctx = {
    config: {
      AGENTGATEWAY_ADMIN_URL: 'http://agentgateway.test',
      KNOWLEDGE_SYNC_ENABLED: true,
      KNOWLEDGE_SYNC_URL: 'http://knowledge-sync.test',
      UI_PORT: 3000,
      GRAFANA_PUBLIC_URL: 'http://grafana.test',
      MCP_PUBLIC_URL: 'http://mcp.test'
    }
  };
  register(router, ctx);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(String(url));
    return {
      status: 200,
      ok: true,
      text: async () => 'ok'
    };
  };

  for (const path of ['/api/health/ready', '/api/health/detail']) {
    fetchedUrls.length = 0;
    const match = router.match('GET', path);
    assert.ok(match, `Rota ${path} deve estar registrada`);
    const res = createMockResponse();
    await match.handler({}, res, new URL(`http://localhost${path}`), match.params);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.status, 'ready');
    assert.equal(data.checks.length, 2);
    assert.equal(data.checks[0].name, 'agentgateway');
    assert.equal(data.checks[0].ok, true);
    assert.equal(data.checks[1].name, 'knowledge-sync');
    assert.equal(data.checks[1].ok, true);
    assert.deepEqual(fetchedUrls, [
      'http://agentgateway.test/',
      'http://knowledge-sync.test/health/ready'
    ]);
  }
});

test('GET /api/health/ready retorna 503 quando uma dependência falha', async (t) => {
  const router = createRouter();
  const ctx = {
    config: {
      AGENTGATEWAY_ADMIN_URL: 'http://agentgateway.test',
      KNOWLEDGE_SYNC_ENABLED: true,
      KNOWLEDGE_SYNC_URL: 'http://knowledge-sync.test',
      UI_PORT: 3000,
      GRAFANA_PUBLIC_URL: 'http://grafana.test',
      MCP_PUBLIC_URL: 'http://mcp.test'
    }
  };
  register(router, ctx);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url) => {
    if (String(url).includes('knowledge-sync')) {
      throw new Error('Conexão recusada');
    }
    return {
      status: 200,
      ok: true,
      text: async () => 'ok'
    };
  };

  const match = router.match('GET', '/api/health/ready');
  const res = createMockResponse();
  await match.handler({}, res, new URL('http://localhost/api/health/ready'), match.params);
  assert.equal(res.statusCode, 503);
  const data = JSON.parse(res.body);
  assert.equal(data.status, 'not_ready');
  assert.equal(data.checks.find(c => c.name === 'knowledge-sync').ok, false);
  assert.equal(data.checks.find(c => c.name === 'knowledge-sync').error, 'Conexão recusada');
});

test('GET /api/health/ready ignora knowledge-sync quando KNOWLEDGE_SYNC_ENABLED for falso', async (t) => {
  const router = createRouter();
  const ctx = {
    config: {
      AGENTGATEWAY_ADMIN_URL: 'http://agentgateway.test',
      KNOWLEDGE_SYNC_ENABLED: false,
      KNOWLEDGE_SYNC_URL: 'http://knowledge-sync.test',
      UI_PORT: 3000,
      GRAFANA_PUBLIC_URL: 'http://grafana.test',
      MCP_PUBLIC_URL: 'http://mcp.test'
    }
  };
  register(router, ctx);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(String(url));
    return { status: 200, ok: true };
  };

  const match = router.match('GET', '/api/health/ready');
  const res = createMockResponse();
  await match.handler({}, res, new URL('http://localhost/api/health/ready'), match.params);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.status, 'ready');
  assert.equal(data.checks.length, 1);
  assert.equal(data.checks[0].name, 'agentgateway');
  assert.deepEqual(fetchedUrls, ['http://agentgateway.test/']);
});

test('GET /api/metrics retorna métricas combinadas com worker quando habilitado', async (t) => {
  const router = createRouter();
  const ctx = {
    config: {
      AGENTGATEWAY_ADMIN_URL: 'http://agentgateway.test',
      KNOWLEDGE_SYNC_ENABLED: true,
      KNOWLEDGE_SYNC_URL: 'http://knowledge-sync.test',
      UI_PORT: 3000,
      GRAFANA_PUBLIC_URL: 'http://grafana.test',
      MCP_PUBLIC_URL: 'http://mcp.test'
    }
  };
  register(router, ctx);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'http://knowledge-sync.test/metrics');
    return {
      ok: true,
      status: 200,
      text: async () => 'knowledge_sync_jobs_total 42\n'
    };
  };

  const match = router.match('GET', '/api/metrics');
  const res = createMockResponse();
  await match.handler({}, res, new URL('http://localhost/api/metrics'), match.params);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/plain; version=0.0.4; charset=utf-8');
  assert.ok(res.body.includes('cbm_admin_process_uptime_seconds'));
  assert.ok(res.body.includes('knowledge_sync_jobs_total 42'));
});

test('GET /api/metrics retorna métricas apenas do admin quando worker falha', async (t) => {
  const router = createRouter();
  const ctx = {
    config: {
      AGENTGATEWAY_ADMIN_URL: 'http://agentgateway.test',
      KNOWLEDGE_SYNC_ENABLED: true,
      KNOWLEDGE_SYNC_URL: 'http://knowledge-sync.test',
      UI_PORT: 3000,
      GRAFANA_PUBLIC_URL: 'http://grafana.test',
      MCP_PUBLIC_URL: 'http://mcp.test'
    }
  };
  register(router, ctx);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => {
    throw new Error('Falha de rede');
  };

  const match = router.match('GET', '/api/metrics');
  const res = createMockResponse();
  await match.handler({}, res, new URL('http://localhost/api/metrics'), match.params);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/plain; version=0.0.4; charset=utf-8');
  assert.ok(res.body.includes('cbm_admin_process_uptime_seconds'));
  assert.ok(!res.body.includes('knowledge_sync_jobs_total'));
});

test('GET /api/config retorna a configuração esperada', async () => {
  const router = createRouter();
  const ctx = {
    config: {
      AGENTGATEWAY_ADMIN_URL: 'http://agentgateway.test:8080',
      KNOWLEDGE_SYNC_ENABLED: true,
      KNOWLEDGE_SYNC_URL: 'http://knowledge-sync:3002',
      UI_PORT: 3000,
      GRAFANA_PUBLIC_URL: 'http://localhost:3001',
      MCP_PUBLIC_URL: 'http://localhost:8080'
    }
  };
  register(router, ctx);

  const match = router.match('GET', '/api/config');
  const res = createMockResponse();
  await match.handler({}, res, new URL('http://localhost/api/config'), match.params);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    uiPort: 3000,
    knowledgeSyncEnabled: true,
    grafanaUrl: 'http://localhost:3001',
    mcpUrl: 'http://localhost:8080'
  });
});
