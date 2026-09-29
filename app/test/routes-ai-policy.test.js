import test from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../src/router.js';
import { register } from '../src/routes/ai-policy.js';

function response() {
  return {
    status: null,
    body: '',
    writeHead(status) { this.status = status; },
    end(value) { this.body = value || ''; }
  };
}

function adminContext(authenticated = true) {
  return { adminAuth: { session: () => authenticated ? { role: 'admin' } : null } };
}

async function invoke(router, method, path, payload, ctx = adminContext()) {
  const route = router.match(method, path);
  const request = { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); } };
  const res = response();
  await route.handler(request, res, new URL(`http://localhost${path}`), {}, ctx);
  return res;
}

test('rota de política exige sessão administrativa', async () => {
  const router = createRouter();
  register(router, adminContext(false));
  const res = await invoke(router, 'POST', '/api/ai-policy/route', { risk: 'high', contextTokens: 20 }, adminContext(false));
  assert.equal(res.status, 401);
});

test('rota administrativa calcula modelo sem aceitar texto de prompt', async () => {
  const router = createRouter();
  register(router, adminContext());
  const res = await invoke(router, 'POST', '/api/ai-policy/route', { risk: 'high', contextTokens: 20 });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).route, 'hosted_reasoning');
  const rejected = await invoke(router, 'POST', '/api/ai-policy/route', { risk: 'high', prompt: 'private prompt' });
  assert.equal(rejected.status, 400);
  assert.doesNotMatch(rejected.body, /private prompt/);
});

test('telemetria aceita somente métricas agregadas e não identidade nem conteúdo', async () => {
  const router = createRouter();
  register(router, adminContext());
  const accepted = await invoke(router, 'POST', '/api/ai-policy/usage', {
    route: 'hosted_general', inputTokens: 12, outputTokens: 4, cachedInputTokens: 3,
    latencyMs: 25, outcome: 'success', cacheHit: true
  });
  assert.equal(accepted.status, 202);
  assert.equal(JSON.parse(accepted.body).recorded, true);
  const rejected = await invoke(router, 'POST', '/api/ai-policy/usage', {
    route: 'hosted_general', inputTokens: 12, outputTokens: 4, prompt: 'sensitive', userId: 'employee'
  });
  assert.equal(rejected.status, 400);
  assert.doesNotMatch(rejected.body, /sensitive|employee/);
});
