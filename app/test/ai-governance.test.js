import test from 'node:test';
import assert from 'node:assert/strict';

import { authorizeChunk, estimateAiCost, filterAuthorizedChunks, modelRouteConfiguration, parseModelRouteConfig, routeModel } from '../src/ai-governance.js';

const access = { system: false, allowedProjects: new Set(['api-pedidos']) };

test('ACL de chunk aceita o projeto autorizado e bloqueia projeto ou ACL divergente', () => {
  assert.equal(authorizeChunk({ project: 'api-pedidos', aclProjects: ['api-pedidos'] }, { access, project: 'api-pedidos' }).allowed, true);
  assert.equal(authorizeChunk({ project: 'api-financeiro' }, { access, project: 'api-pedidos' }).reason, 'cross_project');
  assert.equal(authorizeChunk({ project: 'api-pedidos', acl_projects: ['api-financeiro'] }, { access, project: 'api-pedidos' }).reason, 'chunk_acl_denied');
  assert.equal(authorizeChunk({ project: 'api-pedidos' }, { access, project: 'api-pedidos' }).legacyProjectBinding, true);
});

test('ACL de chunk não devolve candidatos não autorizados e informa apenas contadores', () => {
  const result = filterAuthorizedChunks([
    { chunkId: 'ok', project: 'api-pedidos', aclProjects: ['api-pedidos'] },
    { chunkId: 'wrong-project', project: 'api-financeiro' },
    { chunkId: 'wrong-acl', project: 'api-pedidos', aclProjects: ['api-financeiro'] }
  ], { access, project: 'api-pedidos' });
  assert.deepEqual(result.chunks.map(chunk => chunk.chunkId), ['ok']);
  assert.deepEqual(result.rejected, { cross_project: 1, chunk_acl_denied: 1, project_not_authorized: 0, missing_project: 0 });
});

test('roteamento preserva escalonamento por risco, confiança e contexto', () => {
  assert.equal(routeModel().route, 'local_fast');
  assert.equal(routeModel({ risk: 'high' }).route, 'hosted_reasoning');
  assert.equal(routeModel({ retrievalConfidence: 0.3 }).reason, 'low_retrieval_confidence');
  assert.equal(routeModel({ contextTokens: 25_000 }).route, 'hosted_long_context');
});

const routeConfig = Object.fromEntries(['local_fast', 'hosted_general', 'hosted_reasoning', 'hosted_long_context'].map(route => [route, {
  provider: route.startsWith('local') ? 'ollama' : 'openai',
  model: route === 'local_fast' ? 'qwen3.5:9b' : 'gpt-example',
  contextWindowTokens: 64_000,
  inputUsdPerMillionTokens: 2,
  cachedInputUsdPerMillionTokens: 0.2,
  outputUsdPerMillionTokens: 8
}]));

test('configuração de modelos valida rotas, nomes, janela e preços', () => {
  const parsed = parseModelRouteConfig(JSON.stringify(routeConfig));
  assert.equal(routeModel({ risk: 'high' }, parsed).model, 'gpt-example');
  assert.equal(routeModel({ risk: 'high', contextTokens: 65_000 }, parsed).eligible, false);
  assert.equal(Object.isFrozen(parsed.hosted_reasoning), true);
  assert.throws(() => parseModelRouteConfig(JSON.stringify({ ...routeConfig, extra: routeConfig.local_fast })), /desconhecidas/);
  assert.throws(() => parseModelRouteConfig(JSON.stringify({ ...routeConfig, hosted_general: { ...routeConfig.hosted_general, apiKey: 'forbidden' } })), /Campos não suportados/);
  assert.throws(() => parseModelRouteConfig(JSON.stringify({ ...routeConfig, hosted_general: { ...routeConfig.hosted_general, model: 'sk-proj-not-a-model' } })), /model inválido/);
  assert.throws(() => parseModelRouteConfig('{bad json'), /JSON válido/);
});

test('custo considera preços distintos para entrada, entrada em cache e saída', () => {
  const parsed = parseModelRouteConfig(routeConfig);
  assert.equal(estimateAiCost({ route: 'hosted_general', inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 }, parsed), 2.08);
  assert.equal(estimateAiCost({ route: 'hosted_general', inputTokens: 10, cachedInputTokens: 11 }, parsed), null);
  const unconfigured = modelRouteConfiguration(null);
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.routes[0].configured, false);
  assert.equal('model' in unconfigured.routes[0], false);
  assert.equal('provider' in unconfigured.routes[0], false);
  const partial = modelRouteConfiguration(parseModelRouteConfig({ local_fast: routeConfig.local_fast }));
  assert.equal(partial.configured, true);
  assert.equal(partial.routes[0].model, 'qwen3.5:9b');
  assert.equal(partial.routes[1].configured, false);
  assert.equal('model' in partial.routes[1], false);
});
