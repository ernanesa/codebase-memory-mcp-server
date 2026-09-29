const SOURCE_KEYS = new Set(['id', 'sourceid', 'documentid', 'filename', 'name', 'title', 'uri', 'url', 'path', 'file', 'source']);

function normalized(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim();
}

function includesFact(answer, fact) {
  if (typeof fact === 'string' && fact.trim()) return normalized(answer).includes(normalized(fact));
  if (Array.isArray(fact) && fact.length) return fact.some(candidate => includesFact(answer, candidate));
  throw new Error('Cada fato deve ser uma string não vazia ou uma lista de alternativas.');
}

function validateStringList(value, field, id) {
  if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()))) {
    throw new Error(`${field} deve ser uma lista de strings não vazias no caso ${id}.`);
  }
}

function validateSourceIds(value, field, id) {
  validateStringList(value, field, id);
  if (value && new Set(value.map(normalized)).size !== value.length) throw new Error(`${field} contém identificadores duplicados no caso ${id}.`);
}

export function validateDataset(dataset) {
  if (dataset?.schemaVersion !== undefined && dataset.schemaVersion !== 1) throw new Error('schemaVersion não suportada; versão aceita: 1.');
  if (!dataset || !Array.isArray(dataset.cases) || !dataset.cases.length) throw new Error('O dataset deve conter ao menos um caso em cases.');
  const ids = new Set();
  for (const item of dataset.cases) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || typeof item.question !== 'string' || !item.question.trim()) throw new Error('Cada caso precisa de id e question não vazios.');
    if (ids.has(item.id)) throw new Error(`ID duplicado no dataset: ${item.id}.`);
    ids.add(item.id);
    for (const field of ['requiredFacts', 'forbiddenFacts', 'expectedDocuments', 'forbiddenDocuments', 'mustNotReveal']) validateStringList(item[field], field, item.id);
    if (item.expectAbstention !== undefined && typeof item.expectAbstention !== 'boolean') throw new Error(`expectAbstention deve ser boolean no caso ${item.id}.`);
    const access = item.access;
    if (access !== undefined) {
      if (!access || typeof access !== 'object' || Array.isArray(access)) throw new Error(`access deve ser um objeto no caso ${item.id}.`);
      for (const field of ['allowedSourceIds', 'deniedSourceIds', 'revokedSourceIds']) validateSourceIds(access[field], `access.${field}`, item.id);
      const denied = new Set([...(access.deniedSourceIds || []), ...(access.revokedSourceIds || [])].map(normalized));
      if ((access.allowedSourceIds || []).some(source => denied.has(normalized(source)))) throw new Error(`Uma fonte não pode ser permitida e negada/revogada no caso ${item.id}.`);
    }
    if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string' || !tag.trim()))) throw new Error(`tags deve ser uma lista de strings no caso ${item.id}.`);
    for (const field of ['maxLatencyMs', 'maxCostUsd']) {
      if (item[field] !== undefined && (!Number.isFinite(item[field]) || item[field] < 0)) throw new Error(`${field} deve ser um número não negativo no caso ${item.id}.`);
    }
  }
  if (dataset.minimumPassRate !== undefined && (!Number.isFinite(dataset.minimumPassRate) || dataset.minimumPassRate < 0 || dataset.minimumPassRate > 1)) throw new Error('minimumPassRate deve estar entre 0 e 1.');
  if (dataset.pricing !== undefined) {
    if (!dataset.pricing || typeof dataset.pricing !== 'object' || Array.isArray(dataset.pricing)) throw new Error('pricing deve ser um objeto.');
    for (const field of ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion']) {
      if (dataset.pricing[field] !== undefined && (!Number.isFinite(dataset.pricing[field]) || dataset.pricing[field] < 0)) throw new Error(`pricing.${field} deve ser um número não negativo.`);
    }
  }
  return dataset;
}

function citationSourceIds(citations) {
  const ids = new Set();
  const visited = new WeakSet();
  const visitMetadata = value => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach(item => {
        if (item && typeof item === 'object') visitMetadata(item);
      });
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      const keyName = key.toLowerCase().replace(/[_-]/g, '');
      if (SOURCE_KEYS.has(keyName) && typeof nested === 'string' && nested.trim()) ids.add(normalized(nested));
      if (nested && typeof nested === 'object') visitMetadata(nested);
    }
  };
  for (const citation of citations) {
    if (typeof citation === 'string' && citation.trim()) ids.add(normalized(citation));
    else if (citation && typeof citation === 'object') visitMetadata(citation);
  }
  return [...ids];
}

function matchesSource(sourceIds, expected) {
  const normalizedExpected = normalized(expected);
  return sourceIds.some(source => source === normalizedExpected || source.endsWith(`/${normalizedExpected}`) || source.endsWith(`\\${normalizedExpected}`));
}

export function evaluateCase(testCase, result) {
  const answer = String(result.answer || '');
  const citations = Array.isArray(result.citations) ? result.citations : result.citations ? [result.citations] : [];
  const sourceIds = citationSourceIds(citations);
  const requiredFacts = testCase.requiredFacts || [];
  const forbiddenFacts = [...(testCase.forbiddenFacts || []), ...(testCase.mustNotReveal || [])];
  const expectedDocuments = testCase.expectedDocuments || [];
  const forbiddenDocuments = testCase.forbiddenDocuments || [];
  const foundRequired = requiredFacts.filter(fact => includesFact(answer, fact));
  const foundForbidden = forbiddenFacts.filter(fact => includesFact(answer, fact));
  const foundDocuments = expectedDocuments.filter(document => matchesSource(sourceIds, document));
  const foundForbiddenDocuments = forbiddenDocuments.filter(document => matchesSource(sourceIds, document));
  const access = testCase.access || {};
  const deniedSources = [...(access.deniedSourceIds || []), ...(access.revokedSourceIds || [])];
  const foundDeniedSources = deniedSources.filter(source => matchesSource(sourceIds, source));
  const allowedSources = access.allowedSourceIds || [];
  const enforceAllowlist = Array.isArray(access.allowedSourceIds);
  const unrecognizedSources = enforceAllowlist ? sourceIds.filter(source => !allowedSources.some(allowed => matchesSource([source], allowed))) : [];
  if (enforceAllowlist && citations.length && !sourceIds.length) unrecognizedSources.push('[citação sem identificador]');
  const requiresAbstention = testCase.expectAbstention === true;
  const abstained = /(nao (encontrei|ha|possuo)|sem informacao|nao consta|nao e possivel responder|nao tenho acesso)/.test(normalized(answer));
  const factRecall = requiredFacts.length ? foundRequired.length / requiredFacts.length : 1;
  const citationRecall = expectedDocuments.length ? foundDocuments.length / expectedDocuments.length : 1;
  const abstentionScore = requiresAbstention ? Number(abstained) : 1;
  const latencyWithinBudget = testCase.maxLatencyMs === undefined || (Number.isFinite(result.latencyMs) && result.latencyMs <= testCase.maxLatencyMs);
  const costWithinBudget = testCase.maxCostUsd === undefined || (Number.isFinite(result.costUsd) && result.costUsd <= testCase.maxCostUsd);
  const passed = !result.error && factRecall === 1 && foundForbidden.length === 0 && foundForbiddenDocuments.length === 0 && foundDeniedSources.length === 0 && unrecognizedSources.length === 0 && citationRecall === 1 && abstentionScore === 1 && latencyWithinBudget && costWithinBudget;
  return {
    id: testCase.id,
    tags: testCase.tags || [],
    passed,
    factRecall,
    citationRecall,
    abstentionScore,
    latencyMs: result.latencyMs ?? null,
    costUsd: result.costUsd ?? null,
    inputTokens: result.inputTokens ?? null,
    outputTokens: result.outputTokens ?? null,
    cachedInputTokens: result.cachedInputTokens ?? null,
    latencyWithinBudget,
    costWithinBudget,
    missingRequiredFacts: requiredFacts.filter(fact => !foundRequired.includes(fact)),
    foundForbiddenFacts: foundForbidden,
    missingDocuments: expectedDocuments.filter(document => !foundDocuments.includes(document)),
    foundForbiddenDocuments,
    foundDeniedSources,
    unrecognizedSources,
    answer,
    citations,
    ...(result.error ? { error: String(result.error) } : {})
  };
}

export function summarize(results) {
  const average = field => results.reduce((sum, item) => sum + item[field], 0) / Math.max(1, results.length);
  const latencies = results.map(item => item.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = value => latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1)] : null;
  return {
    cases: results.length,
    passed: results.filter(item => item.passed).length,
    passRate: results.filter(item => item.passed).length / Math.max(1, results.length),
    averageFactRecall: average('factRecall'),
    averageCitationRecall: average('citationRecall'),
    totalCostUsd: results.every(item => Number.isFinite(item.costUsd)) ? results.reduce((sum, item) => sum + item.costUsd, 0) : null,
    totalInputTokens: results.every(item => Number.isFinite(item.inputTokens)) ? results.reduce((sum, item) => sum + item.inputTokens, 0) : null,
    totalOutputTokens: results.every(item => Number.isFinite(item.outputTokens)) ? results.reduce((sum, item) => sum + item.outputTokens, 0) : null,
    securityFailures: results.filter(item => item.foundForbiddenFacts?.length || item.foundForbiddenDocuments?.length || item.foundDeniedSources?.length || item.unrecognizedSources?.length).length,
    budgetFailures: results.filter(item => item.latencyWithinBudget === false || item.costWithinBudget === false).length,
    p50LatencyMs: percentile(0.5),
    p95LatencyMs: percentile(0.95)
  };
}

export function compareReports(baseline, candidate, policy = {}) {
  if (policy.maxPassRateDrop !== undefined && (!Number.isFinite(policy.maxPassRateDrop) || policy.maxPassRateDrop < 0 || policy.maxPassRateDrop > 1)) throw new Error('maxPassRateDrop deve estar entre 0 e 1.');
  for (const field of ['maxP95LatencyGrowth', 'maxCostGrowth', 'maxInputTokenGrowth', 'maxOutputTokenGrowth']) {
    if (policy[field] !== undefined && (!Number.isFinite(policy[field]) || policy[field] < 0)) throw new Error(`${field} deve ser um número não negativo.`);
  }
  const failures = [];
  const baseCases = new Map((baseline.results || []).map(result => [result.id, result]));
  const candidateCases = new Map((candidate.results || []).map(result => [result.id, result]));
  if (baseCases.size === 0 || candidateCases.size === 0) failures.push('Os relatórios precisam conter casos.');
  for (const [id, base] of baseCases) {
    const current = candidateCases.get(id);
    if (!current) failures.push(`Caso removido: ${id}.`);
    else if (base.passed && !current.passed) failures.push(`Regressão no caso ${id}.`);
  }
  const baseSummary = baseline.summary || summarize(baseline.results || []);
  const currentSummary = candidate.summary || summarize(candidate.results || []);
  const maxPassRateDrop = policy.maxPassRateDrop ?? 0;
  if (baseSummary.passRate - currentSummary.passRate > maxPassRateDrop) failures.push('Queda de passRate acima do limite.');
  const growthCheck = (field, maxGrowth, label) => {
    if (maxGrowth === undefined) return;
    const before = baseSummary[field];
    const after = currentSummary[field];
    if (!Number.isFinite(before) || !Number.isFinite(after)) {
      failures.push(`Métrica indisponível para comparar ${label}.`);
      return;
    }
    if (before === 0 && after > 0) failures.push(`Aumento de ${label} a partir de zero.`);
    else if (before > 0 && after / before - 1 > maxGrowth) failures.push(`Aumento de ${label} acima do limite.`);
  };
  growthCheck('p95LatencyMs', policy.maxP95LatencyGrowth, 'p95 de latência');
  growthCheck('totalCostUsd', policy.maxCostGrowth, 'custo total');
  growthCheck('totalInputTokens', policy.maxInputTokenGrowth, 'tokens de entrada');
  growthCheck('totalOutputTokens', policy.maxOutputTokenGrowth, 'tokens de saída');
  return { passed: failures.length === 0, failures, baseline: baseSummary, candidate: currentSummary };
}

export function estimateCostUsd({ inputTokens = 0, cachedInputTokens = 0, outputTokens = 0 } = {}, pricing = {}) {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)
    || !Number.isFinite(pricing?.inputPerMillion) || !Number.isFinite(pricing?.outputPerMillion)) return null;
  if (Number.isFinite(cachedInputTokens) && cachedInputTokens > 0 && !Number.isFinite(pricing?.cachedInputPerMillion)) return null;
  const input = Math.max(0, inputTokens);
  const cached = Math.min(input, Number.isFinite(cachedInputTokens) && cachedInputTokens > 0 ? cachedInputTokens : 0);
  const output = Math.max(0, outputTokens);
  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  return ((input - cached) * pricing.inputPerMillion + cached * cachedRate + output * pricing.outputPerMillion) / 1_000_000;
}

export function extractChatResult(payload, latencyMs) {
  const answer = payload?.choices?.[0]?.message?.content || payload?.message?.content || payload?.response || '';
  const rawCitations = payload?.citations || payload?.sources || payload?.choices?.[0]?.message?.citations || [];
  const citations = Array.isArray(rawCitations) ? rawCitations : [rawCitations];
  const usage = payload?.usage || {};
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? null;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? null;
  const cachedInputTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
  return { answer, citations, latencyMs, inputTokens, outputTokens, cachedInputTokens };
}
