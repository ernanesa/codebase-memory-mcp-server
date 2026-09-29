import { json, body } from '../http.js';
import { CHUNK_ACL_POLICY_VERSION, MODEL_ROUTING_POLICY_VERSION, MODEL_ROUTES, estimateAiCost, modelRouteConfiguration, routeModel } from '../ai-governance.js';
import { recordAiUsage } from '../observability.js';

function requireAdmin(request, response, ctx) {
  if (ctx?.adminAuth?.session(request)) return true;
  json(response, 401, { error: 'Autenticação administrativa necessária.' });
  return false;
}

function routingInput(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (Object.keys(source).some(key => !['risk', 'contextTokens', 'retrievalConfidence', 'budget'].includes(key))) {
    throw new Error('A solicitação contém campos não suportados. Envie apenas os parâmetros de roteamento.');
  }
  if (source.risk !== undefined && !['low', 'medium', 'high'].includes(source.risk)) throw new Error('risk deve ser low, medium ou high.');
  for (const field of ['contextTokens', 'retrievalConfidence']) {
    if (source[field] !== undefined && (!Number.isFinite(source[field]) || source[field] < 0)) throw new Error(`${field} deve ser um número não negativo.`);
  }
  if (source.contextTokens !== undefined && !Number.isSafeInteger(source.contextTokens)) throw new Error('contextTokens deve ser um inteiro seguro.');
  if (source.retrievalConfidence !== undefined && source.retrievalConfidence > 1) throw new Error('retrievalConfidence deve ser no máximo 1.');
  if (source.budget !== undefined && !['economy', 'standard', 'priority'].includes(source.budget)) throw new Error('budget deve ser economy, standard ou priority.');
  return source;
}

function usageInput(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fields = ['route', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'latencyMs', 'outcome', 'cacheHit'];
  if (Object.keys(source).some(key => !fields.includes(key))) throw new Error('A medição contém campos não suportados. Envie somente métricas agregadas.');
  if (!MODEL_ROUTES.includes(source.route)) throw new Error('route deve ser uma rota conhecida.');
  for (const field of ['inputTokens', 'outputTokens']) {
    if (!Number.isSafeInteger(source[field]) || source[field] < 0 || source[field] > 1_000_000_000) throw new Error(`${field} deve ser um inteiro não negativo válido.`);
  }
  if (source.cachedInputTokens !== undefined
    && (!Number.isSafeInteger(source.cachedInputTokens) || source.cachedInputTokens < 0 || source.cachedInputTokens > source.inputTokens)) {
    throw new Error('cachedInputTokens deve ser um inteiro entre zero e inputTokens.');
  }
  if (source.latencyMs !== undefined && (!Number.isFinite(source.latencyMs) || source.latencyMs < 0 || source.latencyMs > 3_600_000)) {
    throw new Error('latencyMs deve estar entre zero e uma hora.');
  }
  if (source.outcome !== undefined && !['success', 'error', 'cancelled', 'unknown'].includes(source.outcome)) {
    throw new Error('outcome deve ser success, error, cancelled ou unknown.');
  }
  if (source.cacheHit !== undefined && typeof source.cacheHit !== 'boolean') throw new Error('cacheHit deve ser booleano.');
  return source;
}

async function safeBody(request) {
  try { return await body(request); }
  catch { throw new Error('JSON inválido ou corpo excede o limite permitido.'); }
}

export function register(router, ctx) {
  router.add('GET', '/api/ai-policy', async (request, response) => {
    if (!requireAdmin(request, response, ctx)) return;
    return json(response, 200, {
      chunkAclPolicyVersion: CHUNK_ACL_POLICY_VERSION,
      modelRoutingPolicyVersion: MODEL_ROUTING_POLICY_VERSION,
      routing: { advisory: true, ...modelRouteConfiguration() },
      cache: { invalidatedBy: ['index_revision', 'access_change', 'chunk_acl_policy_change'] }
    });
  });

  router.add('POST', '/api/ai-policy/route', async (request, response) => {
    if (!requireAdmin(request, response, ctx)) return;
    try {
      const input = routingInput(await safeBody(request));
      return json(response, 200, routeModel(input));
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  });

  router.add('POST', '/api/ai-policy/usage', async (request, response) => {
    if (!requireAdmin(request, response, ctx)) return;
    try {
      const input = usageInput(await safeBody(request));
      const usage = {
        route: input.route,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedInputTokens: input.cachedInputTokens ?? 0,
        latencyMs: input.latencyMs,
        outcome: input.outcome ?? 'unknown',
        cacheHit: input.cacheHit
      };
      const estimatedCostUsd = estimateAiCost(usage);
      recordAiUsage({ ...usage, estimatedCostUsd });
      return json(response, 202, { recorded: true, costEstimated: estimatedCostUsd !== null, ...(estimatedCostUsd === null ? {} : { estimatedCostUsd }) });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  });
}
