/**
 * Policies that must stay deterministic at the MCP boundary. They deliberately
 * contain no model SDK or prompt payload: model invocation remains owned by
 * the caller, while this module makes its security and cost decision auditable.
 */
export const CHUNK_ACL_POLICY_VERSION = '1';
export const MODEL_ROUTING_POLICY_VERSION = '2';

export const MODEL_ROUTES = Object.freeze([
  'local_fast',
  'hosted_general',
  'hosted_reasoning',
  'hosted_long_context'
]);

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const SECRET_LIKE_NAME = /^(?:sk-|bearer|eyJ[A-Za-z0-9_-]{10,}\.)/i;
const CONFIG_FIELDS = new Set([
  'provider',
  'model',
  'contextWindowTokens',
  'inputUsdPerMillionTokens',
  'cachedInputUsdPerMillionTokens',
  'outputUsdPerMillionTokens'
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function projectList(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(raw.map(text).filter(Boolean))];
}

/**
 * Reads only project ACL aliases. A backend may emit any of these while it is
 * migrated; new indexers should write `aclProjects`.
 */
export function chunkAclProjects(chunk) {
  if (!chunk || typeof chunk !== 'object') return [];
  return projectList(
    chunk.aclProjects ?? chunk.acl_projects ?? chunk.allowedProjects ?? chunk.allowed_projects
      ?? chunk.acl?.projects ?? chunk.acl?.allowedProjects
  );
}

/**
 * Fail closed for explicit cross-project or chunk ACL metadata. Legacy chunks
 * without ACL metadata remain compatible only when the request itself was
 * already bound to one authorized project by the guardrail.
 */
export function authorizeChunk(chunk, { access, project } = {}) {
  const requestedProject = text(project);
  const chunkProject = text(chunk?.project) || text(chunk?.projectName) || text(chunk?.repository);
  if (!requestedProject) return { allowed: false, reason: 'missing_project' };
  if (chunkProject && chunkProject !== requestedProject) return { allowed: false, reason: 'cross_project' };
  if (access?.system !== true && !(access?.allowedProjects instanceof Set && access.allowedProjects.has(requestedProject))) {
    return { allowed: false, reason: 'project_not_authorized' };
  }
  const aclProjects = chunkAclProjects(chunk);
  if (aclProjects.length && !aclProjects.includes(requestedProject)) return { allowed: false, reason: 'chunk_acl_denied' };
  return { allowed: true, legacyProjectBinding: aclProjects.length === 0 };
}

export function filterAuthorizedChunks(chunks, context = {}) {
  const accepted = [];
  const rejected = { cross_project: 0, chunk_acl_denied: 0, project_not_authorized: 0, missing_project: 0 };
  let legacyProjectBindings = 0;
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const decision = authorizeChunk(chunk, context);
    if (!decision.allowed) {
      rejected[decision.reason] = (rejected[decision.reason] || 0) + 1;
      continue;
    }
    if (decision.legacyProjectBinding) legacyProjectBindings += 1;
    accepted.push(chunk);
  }
  return {
    chunks: accepted,
    denied: Object.values(rejected).reduce((sum, value) => sum + value, 0),
    rejected,
    legacyProjectBindings,
    policyVersion: CHUNK_ACL_POLICY_VERSION
  };
}

/**
 * Parse a deployment supplied route map. It contains identifiers and prices,
 * never credentials or provider endpoints. An absent setting disables mapping.
 */
export function parseModelRouteConfig(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let source;
  try { source = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { throw new Error('AI_MODEL_ROUTES_JSON deve conter JSON válido.'); }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('AI_MODEL_ROUTES_JSON deve ser um objeto de rotas.');
  }
  const configuredRoutes = Object.keys(source);
  const unknown = configuredRoutes.filter(route => !MODEL_ROUTES.includes(route));
  if (!configuredRoutes.length || unknown.length) {
    throw new Error(`AI_MODEL_ROUTES_JSON deve configurar ao menos uma rota suportada (desconhecidas: ${unknown.join(', ') || 'nenhuma'}).`);
  }

  const config = {};
  for (const route of configuredRoutes) {
    const entry = source[route];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Configuração inválida para a rota ${route}.`);
    }
    const extraFields = Object.keys(entry).filter(field => !CONFIG_FIELDS.has(field));
    if (extraFields.length) throw new Error(`Campos não suportados para a rota ${route}: ${extraFields.join(', ')}.`);
    const { provider, model, contextWindowTokens, inputUsdPerMillionTokens, cachedInputUsdPerMillionTokens, outputUsdPerMillionTokens } = entry;
    if (typeof provider !== 'string' || !MODEL_NAME.test(provider) || SECRET_LIKE_NAME.test(provider)) throw new Error(`provider inválido para a rota ${route}.`);
    if (typeof model !== 'string' || !MODEL_NAME.test(model) || SECRET_LIKE_NAME.test(model)) throw new Error(`model inválido para a rota ${route}.`);
    if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0 || contextWindowTokens > 2_000_000) {
      throw new Error(`contextWindowTokens inválido para a rota ${route}.`);
    }
    for (const [field, value] of Object.entries({ inputUsdPerMillionTokens, cachedInputUsdPerMillionTokens, outputUsdPerMillionTokens })) {
      if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new Error(`${field} inválido para a rota ${route}.`);
    }
    config[route] = Object.freeze({ provider, model, contextWindowTokens, inputUsdPerMillionTokens, cachedInputUsdPerMillionTokens, outputUsdPerMillionTokens });
  }
  return Object.freeze(config);
}

// Invalid deployment configuration fails during startup instead of silently
// routing to an unintended model or producing misleading cost estimates.
const MODEL_ROUTE_CONFIG = parseModelRouteConfig(process.env.AI_MODEL_ROUTES_JSON);

export function modelRouteConfiguration(config = MODEL_ROUTE_CONFIG) {
  if (!config) return Object.freeze({
    configured: false,
    routes: Object.freeze(MODEL_ROUTES.map(route => Object.freeze({ route, configured: false })))
  });
  return Object.freeze({
    configured: Object.keys(config).length > 0,
    routes: Object.freeze(MODEL_ROUTES.map(route => Object.freeze({ route, configured: Boolean(config[route]), ...(config[route] || {}) })))
  });
}

export function estimateAiCost({ route, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0 } = {}, config = MODEL_ROUTE_CONFIG) {
  const model = config?.[route];
  if (!model) return null;
  if (![inputTokens, outputTokens, cachedInputTokens].every(Number.isSafeInteger)
    || inputTokens < 0 || outputTokens < 0 || cachedInputTokens < 0 || cachedInputTokens > inputTokens) return null;
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const cost = (uncachedInputTokens * model.inputUsdPerMillionTokens
    + cachedInputTokens * model.cachedInputUsdPerMillionTokens
    + outputTokens * model.outputUsdPerMillionTokens) / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}

/**
 * Advisory only: this service does not call a provider directly. Callers can
 * map the stable route names to local or hosted models in deployment config.
 */
export function routeModel({ risk = 'low', contextTokens = 0, retrievalConfidence = null, budget = 'standard' } = {}, config = MODEL_ROUTE_CONFIG) {
  const normalizedRisk = ['low', 'medium', 'high'].includes(risk) ? risk : 'medium';
  const tokens = Number.isFinite(contextTokens) && contextTokens >= 0 ? contextTokens : 0;
  const confidence = Number.isFinite(retrievalConfidence) ? retrievalConfidence : null;
  const normalizedBudget = ['economy', 'standard', 'priority'].includes(budget) ? budget : 'standard';
  let route = 'local_fast';
  let reason = 'low_risk';
  if (normalizedRisk === 'high') {
    route = 'hosted_reasoning';
    reason = 'high_risk';
  } else if (confidence !== null && confidence < 0.55) {
    route = 'hosted_reasoning';
    reason = 'low_retrieval_confidence';
  } else if (tokens > 24_000) {
    route = 'hosted_long_context';
    reason = 'context_window';
  } else if (normalizedBudget === 'priority' || normalizedRisk === 'medium') {
    route = 'hosted_general';
    reason = normalizedBudget === 'priority' ? 'priority' : 'medium_risk';
  }
  const model = config?.[route] || null;
  const eligible = Boolean(model && tokens <= model.contextWindowTokens);
  return Object.freeze({
    policyVersion: MODEL_ROUTING_POLICY_VERSION,
    route,
    reason,
    advisory: true,
    configured: Boolean(model),
    eligible,
    ...(model ? {
      provider: model.provider,
      model: model.model,
      contextWindowTokens: model.contextWindowTokens,
      ...(eligible ? {} : { eligibilityReason: 'model_context_window_exceeded' })
    } : { eligibilityReason: 'model_route_unconfigured' })
  });
}
