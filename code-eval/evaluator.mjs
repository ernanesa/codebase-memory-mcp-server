import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_KS = Object.freeze([1, 3, 5, 10]);

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)];
}

function normalizedRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) throw new Error('Caminhos de avaliação devem ser relativos e não vazios.');
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`Caminho fora do source root: ${value}`);
  if (/(^|\/)(?:\.env(?:\..*)?|secrets?|credentials?)(?:\/|$)/i.test(normalized)) throw new Error(`Caminho sensível não permitido: ${value}`);
  return normalized;
}

function idealGains(evaluationCase, k) {
  if (k < 1) return [];
  const symbols = evaluationCase.expectedSymbols.length;
  const paths = evaluationCase.relevantPaths.length;
  if (symbols === 0) return Array.from({ length: Math.min(paths, k) }, () => 1);
  return [symbols + Math.min(paths, 1), ...Array.from({ length: Math.max(0, paths - 1) }, () => 1)].slice(0, k);
}

function validateToolArguments(value, caseId, depth = 0) {
  if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`toolArguments inválido em ${caseId}.`);
  for (const [key, nested] of Object.entries(value)) {
    if (/token|secret|password|authorization|cookie|api[_-]?key/i.test(key) || key === 'project' || key === 'query') throw new Error(`toolArguments não pode conter ${key} em ${caseId}.`);
    if (nested === null || ['string', 'number', 'boolean'].includes(typeof nested)) continue;
    if (Array.isArray(nested) && nested.every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item))) continue;
    validateToolArguments(nested, caseId, depth + 1);
  }
}

export function validateDataset(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('O dataset precisa ser um array não vazio.');
  const ids = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Caso ${index} inválido.`);
    const allowed = new Set(['id', 'query', 'project', 'tool', 'toolArguments', 'relevantPaths', 'requiredEvidencePaths', 'expectedSymbols']);
    for (const key of Object.keys(item)) if (!allowed.has(key)) throw new Error(`Campo não permitido no caso ${index}: ${key}`);
    if (typeof item.id !== 'string' || item.id.length === 0 || ids.has(item.id)) throw new Error(`id inválido ou duplicado no caso ${index}.`);
    if (typeof item.query !== 'string' || item.query.length === 0) throw new Error(`query inválida em ${item.id}.`);
    if (item.project !== undefined && (typeof item.project !== 'string' || item.project.length === 0)) throw new Error(`project inválido em ${item.id}.`);
    if (item.tool !== undefined && !['code_search_surgical', 'get_symbol_snippet', 'search_graph'].includes(item.tool)) throw new Error(`tool não permitido em ${item.id}.`);
    if (item.toolArguments !== undefined) validateToolArguments(item.toolArguments, item.id);
    const relevantPaths = (item.relevantPaths ?? []).map(normalizedRelativePath);
    const requiredEvidencePaths = (item.requiredEvidencePaths ?? relevantPaths).map(normalizedRelativePath);
    const expectedSymbols = item.expectedSymbols ?? [];
    if (!Array.isArray(expectedSymbols) || expectedSymbols.some(symbol => typeof symbol !== 'string' || symbol.length === 0)) throw new Error(`expectedSymbols inválido em ${item.id}.`);
    if (relevantPaths.length + expectedSymbols.length === 0) throw new Error(`O caso ${item.id} precisa de uma evidência esperada.`);
    ids.add(item.id);
    return { id: item.id, query: item.query, ...(item.project ? { project: item.project } : {}), ...(item.tool ? { tool: item.tool } : {}), ...(item.toolArguments ? { toolArguments: item.toolArguments } : {}), relevantPaths, requiredEvidencePaths, expectedSymbols };
  });
}

export function normalizeCandidate(value) {
  if (!value || typeof value !== 'object') return null;
  const candidatePath = value.path ?? value.file_path ?? value.filePath ?? value.source_path;
  const content = value.content ?? value.source ?? value.snippet ?? value.text ?? '';
  const symbol = value.qualified_name ?? value.qualifiedName ?? value.symbol ?? value.name ?? '';
  if (typeof candidatePath !== 'string' || candidatePath.length === 0) return null;
  try {
    return {
      path: normalizedRelativePath(candidatePath),
      content: typeof content === 'string' ? content : '',
      symbol: typeof symbol === 'string' ? symbol : '',
      sha256: typeof (value.sha256 ?? value.hash ?? value.source_hash) === 'string' ? value.sha256 ?? value.hash ?? value.source_hash : null,
      source: typeof value.source === 'string' ? value.source : null
    };
  } catch { return null; }
}

export function extractCandidates(result) {
  const payloads = [result?.structuredContent, result];
  for (const content of result?.content ?? []) {
    if (content?.type !== 'text' || typeof content.text !== 'string') continue;
    try { payloads.push(JSON.parse(content.text)); } catch { /* text output may be Markdown */ }
  }
  const candidates = [];
  const walk = (value, depth = 0) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
    if (typeof value !== 'object') return;
    const normalized = normalizeCandidate(value);
    if (normalized) candidates.push(normalized);
    for (const key of ['results', 'items', 'matches', 'nodes', 'data']) walk(value[key], depth + 1);
  };
  payloads.forEach(payload => walk(payload));
  return candidates.filter((candidate, index, all) => all.findIndex(other => other.path === candidate.path && other.symbol === candidate.symbol) === index);
}

async function freshness(candidate, sourceRoot) {
  if (!candidate.sha256 || !sourceRoot) return 'unknown';
  try {
    const root = await realpath(sourceRoot);
    const file = await realpath(path.resolve(sourceRoot, candidate.path));
    if (!file.startsWith(`${root}${path.sep}`) || !(await stat(file)).isFile()) return 'unavailable';
    const actual = createHash('sha256').update(await readFile(file)).digest('hex');
    return actual === candidate.sha256.toLowerCase() ? 'fresh' : 'stale';
  } catch { return 'unavailable'; }
}

export async function evaluateCase(evaluationCase, candidates, { elapsedMs, responseBytes = 0, sourceRoot, ks = DEFAULT_KS } = {}) {
  const expected = new Set([...evaluationCase.relevantPaths.map(value => `path:${value}`), ...evaluationCase.expectedSymbols.map(value => `symbol:${value}`)]);
  const seen = new Set();
  const gains = [];
  const units = candidates.map(candidate => {
    const found = new Set();
    if (evaluationCase.relevantPaths.includes(candidate.path)) found.add(`path:${candidate.path}`);
    for (const symbol of evaluationCase.expectedSymbols) if (candidate.symbol.includes(symbol) || candidate.content.includes(symbol)) found.add(`symbol:${symbol}`);
    const novel = [...found].filter(unit => !seen.has(unit));
    novel.forEach(unit => seen.add(unit));
    gains.push(novel.length);
    return found;
  });
  const metrics = {};
  for (const k of ks) {
    const top = units.slice(0, k).flatMap(unit => [...unit]);
    const retrieved = new Set(top);
    const dcg = gains.slice(0, k).reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0);
    const ideal = idealGains(evaluationCase, k).reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0);
    metrics[`recallAt${k}`] = retrieved.size / expected.size;
    metrics[`ndcgAt${k}`] = ideal ? dcg / ideal : 0;
  }
  const firstHit = gains.findIndex(gain => gain > 0);
  const returnedPaths = new Set(candidates.map(candidate => candidate.path));
  const freshnessValues = await Promise.all(candidates.map(candidate => freshness(candidate, sourceRoot)));
  const checked = freshnessValues.filter(value => value === 'fresh' || value === 'stale');
  return {
    id: evaluationCase.id,
    metrics: {
      ...metrics,
      mrr: firstHit < 0 ? 0 : 1 / (firstHit + 1),
      evidencePathRecall: evaluationCase.requiredEvidencePaths.length
        ? evaluationCase.requiredEvidencePaths.filter(item => returnedPaths.has(item)).length / evaluationCase.requiredEvidencePaths.length
        : 1,
      citationFreshness: checked.length ? checked.filter(value => value === 'fresh').length / checked.length : null,
      latencyMs: Math.round(elapsedMs * 100) / 100,
      responseBytes
    },
    returned: candidates.map((candidate, index) => ({ path: candidate.path, symbol: candidate.symbol || null, sha256: candidate.sha256, freshness: freshnessValues[index] }))
  };
}

export function summarize(cases, ks = DEFAULT_KS) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('Não há casos para resumir.');
  const names = [...ks.flatMap(k => [`recallAt${k}`, `ndcgAt${k}`]), 'mrr', 'evidencePathRecall'];
  const summary = Object.fromEntries(names.map(name => [name, cases.reduce((total, item) => total + item.metrics[name], 0) / cases.length]));
  const fresh = cases.map(item => item.metrics.citationFreshness).filter(value => value !== null);
  const latencies = cases.map(item => item.metrics.latencyMs);
  const bytes = cases.map(item => item.metrics.responseBytes);
  return { ...summary, citationFreshness: fresh.length ? fresh.reduce((total, value) => total + value, 0) / fresh.length : null, meanLatencyMs: average(latencies), p50LatencyMs: percentile(latencies, 0.5), p95LatencyMs: percentile(latencies, 0.95), meanResponseBytes: average(bytes), p95ResponseBytes: percentile(bytes, 0.95) };
}

function average(values) { return Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100; }
