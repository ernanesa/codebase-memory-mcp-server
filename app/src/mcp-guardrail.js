import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { increment as incrementMetric, observe as observeMetric } from './observability.js';
import { buildProvenance, diversifyCandidates, planRetrieval } from './retrieval-policy.js';

const listProjectsCache = new Map();
const LIST_PROJECTS_CACHE_TTL_MS = 30_000;
const MAX_LIST_PROJECTS_CACHE_ENTRIES = 128;
const MAX_LIST_PROJECTS_CACHE_BYTES = 512 * 1024;
const MAX_CACHED_RESPONSE_BYTES = 64 * 1024;
let listProjectsCacheBytes = 0;

// LRU Semantic Response Cache para tools determinísticas (snippets, architecture, traces, searches)
const MAX_SEMANTIC_CACHE_ENTRIES = 512;
const MAX_SEMANTIC_CACHE_BYTES = 4 * 1024 * 1024;
const SEMANTIC_CACHE_TTL_MS = 1_800_000; // 30 minutos (invalidado por clearSemanticCache na reindexação)
const semanticResponseCache = new Map();
let semanticResponseCacheBytes = 0;

function deleteListProjectsCacheEntry(key) {
  const entry = listProjectsCache.get(key);
  if (!entry) return false;
  listProjectsCache.delete(key);
  listProjectsCacheBytes = Math.max(0, listProjectsCacheBytes - entry.buffer.length);
  return true;
}

function deleteSemanticCacheEntry(key) {
  const entry = semanticResponseCache.get(key);
  if (!entry) return false;
  semanticResponseCache.delete(key);
  semanticResponseCacheBytes = Math.max(0, semanticResponseCacheBytes - entry.buffer.length);
  return true;
}

export function clearSemanticCache() {
  semanticResponseCache.clear();
  listProjectsCache.clear();
  semanticResponseCacheBytes = 0;
  listProjectsCacheBytes = 0;
}

function getCachedSemanticResponse(key, rawHash) {
  if (!key) return null;
  const entry = semanticResponseCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now() || entry.rawHash !== rawHash) {
    deleteSemanticCacheEntry(key);
    incrementMetric('mcp_guardrail_cache_events_total', { cache: 'semantic', result: 'miss' });
    return null;
  }
  // Refresh LRU order
  semanticResponseCache.delete(key);
  semanticResponseCache.set(key, entry);
  incrementMetric('mcp_guardrail_cache_events_total', { cache: 'semantic', result: 'hit' });
  return entry.buffer;
}

function setCachedSemanticResponse(key, buffer, rawHash) {
  if (!key || !buffer || !rawHash || buffer.length > MAX_CACHED_RESPONSE_BYTES) return;
  deleteSemanticCacheEntry(key);
  while (semanticResponseCache.size >= MAX_SEMANTIC_CACHE_ENTRIES || semanticResponseCacheBytes + buffer.length > MAX_SEMANTIC_CACHE_BYTES) {
    const oldestKey = semanticResponseCache.keys().next().value;
    if (oldestKey === undefined) return;
    deleteSemanticCacheEntry(oldestKey);
    incrementMetric('mcp_guardrail_cache_events_total', { cache: 'semantic', result: 'eviction' });
  }
  semanticResponseCache.set(key, {
    buffer,
    rawHash,
    expiresAt: Date.now() + SEMANTIC_CACHE_TTL_MS
  });
  semanticResponseCacheBytes += buffer.length;
}

function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

function accessScopeCacheKey(access) {
  if (!access) return null;
  if (access.system === true) return 'system';
  if (!(access.allowedProjects instanceof Set)) return null;
  return `projects:${[...access.allowedProjects].sort().map(project => JSON.stringify(project)).join(',')}`;
}

function responseHash(response) {
  return createHash('sha256').update(Buffer.from(response || [])).digest('hex');
}

export function semanticCacheKey(toolName, args, access, evidence = null) {
  if (!toolName || !args || typeof args !== 'object') return null;
  const scope = accessScopeCacheKey(access);
  if (!scope) return null;
  return `${toolName}:${scope}:${stableSerialize(args)}:${stableSerialize(evidence)}`;
}

function evidenceForProject(access, project) {
  if (!project || typeof project !== 'string') return null;
  const raw = access?.projectEvidence instanceof Map ? access.projectEvidence.get(project) : null;
  return {
    project,
    status: typeof raw?.status === 'string' ? raw.status : 'unknown',
    ...(typeof raw?.indexedCommit === 'string' ? { indexedCommit: raw.indexedCommit } : {}),
    ...(typeof raw?.indexedAt === 'string' ? { indexedAt: raw.indexedAt } : {})
  };
}

function retrievalMetadata(args) {
  const mode = typeof args?.retrieval_mode === 'string' ? args.retrieval_mode.trim().toLowerCase() : '';
  const diversityPerPath = Number.isInteger(args?.diversity_per_path) && args.diversity_per_path > 0
    ? String(args.diversity_per_path)
    : '';
  return { retrievalMode: ['fast', 'balanced', 'thorough'].includes(mode) ? mode : '', diversityPerPath, includeTests: args?.include_tests === true ? 'true' : 'false' };
}

function cacheArguments(callArgs, metadata) {
  if (!callArgs || typeof callArgs !== 'object') return callArgs;
  const mode = String(metadata.retrievalMode || '');
  const diversity = String(metadata.diversityPerPath || '');
  const includeTests = metadata.includeTests === 'true';
  return mode || diversity || includeTests
    ? { ...callArgs, retrieval_mode: mode, diversity_per_path: diversity, include_tests: includeTests }
    : callArgs;
}

function applySearchResultPolicy(target, { includeTests = false, policy = null, diversityPerPath = 2, evidence = null } = {}) {
  if (!target || typeof target !== 'object' || !Array.isArray(target.results)) return target;
  const pruned = pruneSearchResultPayload(target, { includeTests });
  if (!policy) return pruned;
  const candidates = pruned.results.map((item, index) => {
    const hasPath = typeof item.path === 'string' && item.path.length > 0;
    const hasScore = Number.isFinite(item.score);
    const explicitChunkId = item.chunkId ?? item.chunk_id ?? item.id;
    const hasChunkId = String(explicitChunkId ?? '').trim().length > 0;
    const symbol = item.id || item.node_id || item.nodeId || item.qualified_name || item.name || `result-${index}`;
    const line = item.start_line ?? item.line ?? index;
    return {
      ...item,
      path: hasPath ? item.path : item.file_path,
      chunkId: hasChunkId ? String(explicitChunkId) : `node:${symbol}:${line}`,
      score: hasScore ? item.score : pruned.results.length - index,
      __syntheticPath: !hasPath,
      __syntheticScore: !hasScore,
      __syntheticChunkId: !hasChunkId
    };
  });
  const selected = diversifyCandidates(candidates, Math.min(candidates.length, policy.limit), diversityPerPath)
    .map(candidate => {
      const provenance = buildProvenance(candidate, evidence || {});
      const {
        __syntheticPath: syntheticPath,
        __syntheticScore: syntheticScore,
        __syntheticChunkId: syntheticChunkId,
        ...item
      } = candidate;
      if (syntheticPath) delete item.path;
      if (syntheticScore) delete item.score;
      if (syntheticChunkId) delete item.chunkId;
      return { ...item, provenance };
    });
  return { ...pruned, results: selected, retrieval_policy: { mode: policy.mode, diversity_per_path: diversityPerPath } };
}

function applySearchResponsePolicy(payload, options) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const updated = { ...payload };
  if (updated.structuredContent && typeof updated.structuredContent === 'object') {
    updated.structuredContent = applySearchResultPolicy(updated.structuredContent, options);
    if (Array.isArray(updated.results)) {
      updated.results = applySearchResultPolicy({ results: updated.results }, options).results;
    }
  } else {
    Object.assign(updated, applySearchResultPolicy(updated, options));
  }
  if (Array.isArray(updated.content)) {
    const hasStructuredResults = Array.isArray(updated.structuredContent?.results);
    const hasTopLevelResults = !hasStructuredResults && Array.isArray(updated.results);
    const canonical = hasStructuredResults
      ? updated.structuredContent
      : hasTopLevelResults
        ? Object.fromEntries(Object.entries(updated).filter(([key]) => !['content', 'structuredContent'].includes(key)))
        : null;
    updated.content = updated.content.map(item => {
      if (item?.type !== 'text' || typeof item.text !== 'string') return item;
      if (canonical) return { ...item, text: JSON.stringify(canonical) };
      try {
        const parsed = JSON.parse(item.text);
        return { ...item, text: JSON.stringify(applySearchResultPolicy(parsed, options)) };
      } catch { return item; }
    });
  }
  return updated;
}

function hasStructuredSearchResults(payload) {
  if (payload?.structuredContent && typeof payload.structuredContent === 'object') {
    if (Array.isArray(payload.structuredContent.results)) return true;
    return false;
  }
  if (Array.isArray(payload?.results)) return true;
  const textItems = (Array.isArray(payload?.content) ? payload.content : []).filter(item => item?.type === 'text' && typeof item.text === 'string');
  if (textItems.length === 0) return false;
  return textItems.every(item => {
    try {
      return Array.isArray(JSON.parse(item.text)?.results);
    } catch { return false; }
  });
}

function hasStructuredTraceResults(payload) {
  const hasTraceCollections = value => ['callers', 'callees', 'paths'].some(key => Array.isArray(value?.[key]));
  if (payload?.structuredContent && typeof payload.structuredContent === 'object') {
    if (hasTraceCollections(payload.structuredContent)) return true;
    return false;
  }
  if (hasTraceCollections(payload)) return true;
  const textItems = (Array.isArray(payload?.content) ? payload.content : []).filter(item => item?.type === 'text' && typeof item.text === 'string');
  if (textItems.length === 0) return false;
  return textItems.every(item => {
    try {
      return hasTraceCollections(JSON.parse(item.text));
    } catch { return false; }
  });
}

function applyTraceResponsePolicy(payload) {
  const updated = { ...payload };
  const hasTraceCollections = value => ['callers', 'callees', 'paths'].some(key => Array.isArray(value?.[key]));
  if (hasTraceCollections(updated.structuredContent)) {
    updated.structuredContent = pruneTracePayload(updated.structuredContent);
    if (hasTraceCollections(updated)) {
      const topLevel = pruneTracePayload(Object.fromEntries(Object.entries(updated).filter(([key]) => !['content', 'structuredContent'].includes(key))));
      for (const key of ['callers', 'callees', 'paths']) if (Array.isArray(topLevel[key])) updated[key] = topLevel[key];
    }
    if (Array.isArray(updated.content)) {
      updated.content = updated.content.map(item => item?.type === 'text' && typeof item.text === 'string'
        ? { ...item, text: JSON.stringify(updated.structuredContent) }
        : item);
    }
    return updated;
  }
  if (hasTraceCollections(updated)) {
    const canonical = pruneTracePayload(Object.fromEntries(Object.entries(updated).filter(([key]) => !['content', 'structuredContent'].includes(key))));
    Object.assign(updated, canonical);
    if (Array.isArray(updated.content)) {
      updated.content = updated.content.map(item => item?.type === 'text' && typeof item.text === 'string'
        ? { ...item, text: JSON.stringify(canonical) }
        : item);
    }
    return updated;
  }
  if (Array.isArray(updated.content)) {
    updated.content = updated.content.map(item => {
      if (item?.type !== 'text' || typeof item.text !== 'string') return item;
      return { ...item, text: JSON.stringify(pruneTracePayload(JSON.parse(item.text))) };
    });
  }
  return updated;
}

function compareToolNames(left, right) {
  const leftName = String(left?.name || '');
  const rightName = String(right?.name || '');
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
}

function listProjectsCacheKey(access) {
  if (!access) return null;
  if (access.system) return '__system__';
  return [...access.allowedProjects].sort().join('\0');
}

function getCachedListProjectsResponse(key, rawHash) {
  if (!key) return null;
  const entry = listProjectsCache.get(key);
  if (!entry) {
    incrementMetric('mcp_guardrail_cache_events_total', { cache: 'projects', result: 'miss' });
    return null;
  }
  if (entry.expiresAt <= Date.now() || entry.rawHash !== rawHash) {
    deleteListProjectsCacheEntry(key);
    incrementMetric('mcp_guardrail_cache_events_total', { cache: 'projects', result: 'miss' });
    return null;
  }
  listProjectsCache.delete(key);
  listProjectsCache.set(key, entry);
  incrementMetric('mcp_guardrail_cache_events_total', { cache: 'projects', result: 'hit' });
  return entry.buffer;
}

function setCachedListProjectsResponse(key, buffer, rawHash) {
  if (!key || !buffer || !rawHash || buffer.length > MAX_CACHED_RESPONSE_BYTES) return;
  deleteListProjectsCacheEntry(key);
  while (listProjectsCache.size >= MAX_LIST_PROJECTS_CACHE_ENTRIES || listProjectsCacheBytes + buffer.length > MAX_LIST_PROJECTS_CACHE_BYTES) {
    const oldestKey = listProjectsCache.keys().next().value;
    if (oldestKey === undefined) return;
    deleteListProjectsCacheEntry(oldestKey);
    incrementMetric('mcp_guardrail_cache_events_total', { cache: 'projects', result: 'eviction' });
  }
  listProjectsCache.set(key, { buffer, rawHash, expiresAt: Date.now() + LIST_PROJECTS_CACHE_TTL_MS });
  listProjectsCacheBytes += buffer.length;
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROTO_FILE = path.join(ROOT, 'proto', 'ext_mcp.proto');

export const MCP_ANALYSIS_TOOLS = new Set([
  'search_graph',
  'query_graph',
  'trace_path',
  'get_code_snippet',
  'get_graph_schema',
  'get_architecture',
  'search_code',
  'list_projects',
  'index_status',
  'detect_changes',
  'code_search_surgical',
  'trace_symbol',
  'get_symbol_snippet',
  'inspect_symbol'
]);

export const FACADE_TOOLS = new Set([
  'code_search_surgical',
  'trace_symbol',
  'get_symbol_snippet',
  'inspect_symbol'
]);

export const FACADE_TOOL_DEFINITIONS = [
  {
    name: 'code_search_surgical',
    description: 'Busca cirúrgica FTS5 no grafo de conhecimento do código (definições, métodos, funções, rotas e símbolos) com ranking BM25.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Nome do projeto/repositório indexado.' },
        query: { type: 'string', description: 'Termo de busca cirúrgica ou símbolo a localizar via FTS5/BM25.' },
        label: { type: 'string', description: 'Filtro opcional por tipo de nó (Function, Method, Class, Route, etc).' },
        file_pattern: { type: 'string', description: 'Filtro opcional por padrão de caminho de arquivo.' },
        limit: { type: 'number', minimum: 1, maximum: 50, description: 'Limite máximo de resultados (padrão adaptativo, máximo 50).' },
        include_tests: { type: 'boolean', description: 'Inclui arquivos de teste na resposta; padrão false para manter a busca de produção concisa.' },
        retrieval_mode: { type: 'string', enum: ['fast', 'balanced', 'thorough'], description: 'Política opcional de recuperação aplicada somente à apresentação dos resultados.' },
        diversity_per_path: { type: 'number', description: 'Máximo opcional de evidências por arquivo quando retrieval_mode estiver definido.' }
      },
      required: ['project', 'query']
    }
  },
  {
    name: 'trace_symbol',
    description: 'Rastreamento cirúrgico de callers e callees de um símbolo no grafo, com supressão automática de arquivos e fixtures de teste.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Nome do projeto/repositório indexado.' },
        symbol: { type: 'string', description: 'Nome do símbolo ou função a ser rastreado.' },
        direction: { type: 'string', enum: ['both', 'callers', 'callees'], description: 'Direção do rastreamento (padrão: both).' },
        depth: { type: 'number', description: 'Profundidade máxima de saltos (padrão: 2).' },
        include_tests: { type: 'boolean', description: 'Inclui referências a testes; padrão false.' }
      },
      required: ['project', 'symbol']
    }
  },
  {
    name: 'get_symbol_snippet',
    description: 'Recupera o código fonte e metadados essenciais de um símbolo, higienizado sem propriedades de AST redundantes ou vazias.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Nome do projeto/repositório indexado.' },
        symbol: { type: 'string', description: 'Nome do símbolo ou qualified_name.' },
        include_neighbors: { type: 'boolean', description: 'Se deve incluir nós vizinhos no grafo.' }
      },
      required: ['project', 'symbol']
    }
  },
  {
    name: 'inspect_symbol',
    description: 'Inspeção cirúrgica completa em 1 único passo: recupera o snippet de código-fonte, assinatura e callers/callees de produção.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Nome do projeto/repositório indexado.' },
        symbol: { type: 'string', description: 'Nome do símbolo, método ou função a inspecionar.' },
        include_neighbors: { type: 'boolean', description: 'Se deve incluir referências vizinhas no grafo (padrão: true).' }
      },
      required: ['project', 'symbol']
    }
  }
];

export const UNUSED_AST_FIELDS = new Set([
  'complexity',
  'cognitive',
  'loop_count',
  'loop_depth',
  'self_recursive',
  'param_count',
  'max_access_depth',
  'linear_scan_in_loop',
  'alloc_in_loop',
  'recursion_in_loop',
  'unguarded_recursion',
  'lines',
  'is_exported',
  'is_test',
  'is_entry_point',
  'transitive_loop_depth',
  'recursive'
]);

function valueFromProto(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'stringValue')) return value.stringValue;
  if (Object.hasOwn(value, 'string_value')) return value.string_value;
  if (Object.hasOwn(value, 'numberValue')) return value.numberValue;
  if (Object.hasOwn(value, 'number_value')) return value.number_value;
  if (Object.hasOwn(value, 'boolValue')) return value.boolValue;
  if (Object.hasOwn(value, 'bool_value')) return value.bool_value;
  if (value.structValue || value.struct_value) return structFromProto(value.structValue || value.struct_value);
  const list = value.listValue || value.list_value;
  if (list) return (list.values || []).map(valueFromProto);
  return null;
}

function structFromProto(struct) {
  if (!struct) return {};
  if (!struct.fields) return struct;
  return Object.fromEntries(Object.entries(struct.fields).map(([key, value]) => [key, valueFromProto(value)]));
}

function structToProto(values) {
  return {
    fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { stringValue: String(value) }]))
  };
}

function parseJsonBuffer(buffer, label) {
  try { return JSON.parse(Buffer.from(buffer || []).toString('utf8')); }
  catch { throw new Error(`${label} não contém JSON válido.`); }
}

function permissionDenied(reason) {
  return { error: { code: 'PERMISSION_DENIED', reason } };
}

function invalidRequest(reason) {
  return { error: { code: 'INVALID', reason } };
}

function projectEntries(result) {
  return Array.isArray(result?.projects) ? result.projects : null;
}

function filterProjectPayload(payload, allowedProjects) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.projects)) return payload;
  return {
    ...payload,
    projects: payload.projects.filter(item => {
      const name = typeof item === 'string' ? item : item?.name || item?.project;
      return allowedProjects.has(name);
    })
  };
}

export function filterListProjectsResult(result, allowedProjects) {
  const filtered = result;
  if (filtered.structuredContent) {
    filtered.structuredContent = projectEntries(filtered.structuredContent)
      ? filterProjectPayload(filtered.structuredContent, allowedProjects)
      : { projects: [] };
  }
  if (Array.isArray(filtered.content)) {
    filtered.content = filtered.content.map(item => {
      if (item?.type !== 'text' || typeof item.text !== 'string') return item;
      try {
        const parsed = JSON.parse(item.text);
        if (!projectEntries(parsed)) return { ...item, text: JSON.stringify({ projects: [] }) };
        return { ...item, text: JSON.stringify(filterProjectPayload(parsed, allowedProjects)) };
      } catch { return { ...item, text: JSON.stringify({ projects: [] }) }; }
    });
  }
  return filterProjectPayload(filtered, allowedProjects);
}

export const DUPLICATE_RAW_TOOLS = new Set([
  'search_graph',
  'search_code',
  'trace_path',
  'get_code_snippet',
  'get_graph_schema',
  'detect_changes',
  'query_graph'
]);

export function filterToolsListResult(result, { includeFacade = false, pruneDuplicates = false } = {}) {
  if (!Array.isArray(result?.tools)) return result;
  let filtered = result.tools.filter(tool => MCP_ANALYSIS_TOOLS.has(tool?.name));
  if (pruneDuplicates) {
    filtered = filtered.filter(tool => !DUPLICATE_RAW_TOOLS.has(tool?.name));
  }
  if (!includeFacade) return { ...result, tools: filtered.sort(compareToolNames) };

  const existingNames = new Set(filtered.map(t => t?.name));
  const toAdd = FACADE_TOOL_DEFINITIONS.filter(t => !existingNames.has(t.name));
  return { ...result, tools: [...filtered, ...toAdd].sort(compareToolNames) };
}

export function resolveProjectAlias(requestedProject, knownProjects) {
  return resolveProjectAliasMatch(requestedProject, knownProjects).project;
}

function resolveProjectAliasMatch(requestedProject, knownProjects) {
  if (!requestedProject || typeof requestedProject !== 'string') return { project: null, ambiguous: false };
  if (!knownProjects) return { project: null, ambiguous: false };

  const trimmed = requestedProject.trim();
  if (!trimmed) return { project: null, ambiguous: false };

  const knownList = knownProjects instanceof Set
    ? Array.from(knownProjects)
    : (Array.isArray(knownProjects) ? knownProjects : []);

  if (knownList.length === 0) return { project: null, ambiguous: false };

  if (knownProjects instanceof Set && knownProjects.has(trimmed)) return { project: trimmed, ambiguous: false };
  if (Array.isArray(knownProjects) && knownProjects.includes(trimmed)) return { project: trimmed, ambiguous: false };

  const lowerTrimmed = trimmed.toLowerCase();
  for (const kp of knownList) {
    if (typeof kp === 'string' && kp.toLowerCase() === lowerTrimmed) {
      return { project: kp, ambiguous: false };
    }
  }

  const clean = str => String(str).toLowerCase().replace(/[/\\_.:\s]+/g, '-').replace(/^-+|-+$/g, '');
  const target = clean(lowerTrimmed);
  if (!target) return null;

  const candidates = [];
  for (const kp of knownList) {
    if (typeof kp !== 'string') continue;
    const normKp = clean(kp);
    const strippedKp = normKp.replace(/^data-repositories-/, '');

    if (normKp === target || strippedKp === target) {
      return { project: kp, ambiguous: false };
    }

    if (strippedKp.endsWith(`-${target}`) || normKp.endsWith(`-${target}`)) {
      candidates.push(kp);
    }
  }

  if (candidates.length === 1) {
    return { project: candidates[0], ambiguous: false };
  }
  if (candidates.length > 1) {
    return { project: null, ambiguous: true };
  }

  const loose = [];
  for (const kp of knownList) {
    if (typeof kp !== 'string') continue;
    const normKp = clean(kp);
    const strippedKp = normKp.replace(/^data-repositories-/, '');
    if (strippedKp.includes(target) || normKp.includes(target)) {
      loose.push(kp);
    }
  }

  if (loose.length === 1) {
    return { project: loose[0], ambiguous: false };
  }
  if (loose.length > 1) {
    return { project: null, ambiguous: true };
  }

  return { project: null, ambiguous: false };
}

export function isTestFileOrSymbol(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.is_test === true) return true;

  const paths = [
    item.file_path,
    item.filePath,
    item.file,
    item.path,
    item.location
  ].filter(s => typeof s === 'string' && s.length > 0);

  for (const p of paths) {
    if (
      /\.spec\.[a-z0-9]+$/i.test(p) ||
      /\.test\.[a-z0-9]+$/i.test(p) ||
      /[._-]test\.[a-z0-9]+$/i.test(p) ||
      /[^/\\]+test\.py$/i.test(p) ||
      /[^/\\]+_test\.py$/i.test(p) ||
      /test_[^/\\]+\.py$/i.test(p) ||
      /[^/\\]+Tests?\.cs$/i.test(p) ||
      /(^|[/\\])__tests__([/\\]|$)/i.test(p) ||
      /(^|[/\\])tests?([/\\]|$)/i.test(p)
    ) {
      return true;
    }
  }

  const qn = typeof item.qualified_name === 'string' ? item.qualified_name : (typeof item.qn === 'string' ? item.qn : '');
  if (qn) {
    if (
      /(^|[._])tests?([._]|$)/i.test(qn) ||
      /\.Test\./i.test(qn) ||
      /\.Tests\./i.test(qn) ||
      /Tests?(\.|$)/i.test(qn) ||
      /Test\.[^.]*Tests/i.test(qn)
    ) {
      return true;
    }
  }

  const name = typeof item.name === 'string' ? item.name : '';
  if (name && /(^test_|_test$|Tests?$)/i.test(name)) {
    return true;
  }

  return false;
}

export function pruneTracePayload(payload, { includeTests = false } = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const pruned = { ...payload };
  if (Array.isArray(pruned.callers)) {
    pruned.callers = includeTests ? pruned.callers : pruned.callers.filter(c => !isTestFileOrSymbol(c));
  }
  if (Array.isArray(pruned.callees)) {
    pruned.callees = includeTests ? pruned.callees : pruned.callees.filter(c => !isTestFileOrSymbol(c));
  }
  if (Array.isArray(pruned.paths)) {
    pruned.paths = includeTests ? pruned.paths : pruned.paths.filter(p => !isTestFileOrSymbol(p));
  }
  return pruned;
}

export function pruneArchitecturePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const pruned = { ...payload };

  if (Array.isArray(pruned.file_tree)) {
    const fileTree = pruned.file_tree;
    const totalFiles = fileTree.filter(f => f.type === 'file' || f.children === 0).length;
    const totalDirs = fileTree.filter(f => f.type === 'dir' || f.children > 0).length;
    const topLevel = fileTree.filter(f => {
      const parts = String(f.path || '').split('/').filter(Boolean);
      return parts.length <= 1;
    }).slice(0, 25);

    delete pruned.file_tree;
    pruned.file_summary = {
      total_files: totalFiles,
      total_directories: totalDirs,
      root_structure: topLevel
    };
  }

  if (Array.isArray(pruned.clusters)) {
    const validClusters = pruned.clusters.filter(c => {
      if (!c || typeof c !== 'object') return false;
      const members = typeof c.members === 'number' ? c.members : (Array.isArray(c.members) ? c.members.length : 0);
      const topNodes = Array.isArray(c.top_nodes) ? c.top_nodes.length : 0;
      return members > 0 || topNodes > 0;
    });
    if (validClusters.length > 0) {
      pruned.clusters = validClusters;
    } else {
      delete pruned.clusters;
    }
  }

  return pruned;
}

export function sliceCodeSnippet(source) {
  if (typeof source !== 'string' || !source) return source;

  // 1. Remove license/boilerplate headers at the top of snippet (e.g. /* ... License ... */ or lines of //)
  let cleaned = source.replace(/^\s*(?:\/\*[\s\S]*?(?:license|copyright|all rights reserved|apache|mit)[\s\S]*?\*\/\s*|\/\/[^\n]*(?:license|copyright)[\s\S]*?\n\s*)+/i, '');

  // 2. Colapsa múltiplas linhas vazias consecutivas (máximo 1 linha em branco)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // 3. Remove trailing whitespace por linha
  cleaned = cleaned.replace(/[ \t]+$/gm, '');

  return cleaned.trim();
}

export function pruneSnippetObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    if (UNUSED_AST_FIELDS.has(k)) continue;
    if (k === 'source' && typeof v === 'string') {
      cleaned[k] = sliceCodeSnippet(v);
      continue;
    }
    cleaned[k] = v;
  }
  return cleaned;
}

export function pruneSnippetPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) {
    return payload.map(pruneSnippetObject);
  }
  const result = pruneSnippetObject(payload);
  if (Array.isArray(result.results)) {
    result.results = result.results.map(pruneSnippetObject);
  }
  if (Array.isArray(result.suggestions)) {
    result.suggestions = result.suggestions.map(pruneSnippetObject);
  }
  return result;
}
export function formatSearchResultMarkdown(items) {
  if (!Array.isArray(items) || !items.length) return '';
  const rows = ['| Símbolo | Tipo | Arquivo | Linha |', '| :--- | :--- | :--- | :--- |'];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const name = item.name || item.symbol || item.qualified_name || '-';
    const label = item.label || item.type || '-';
    const file = item.file_path || item.file || item.location || '-';
    const line = item.start_line != null ? item.start_line : '-';
    rows.push(`| \`${name}\` | ${label} | \`${file}\` | ${line} |`);
  }
  return rows.join('\n');
}

export function pruneSearchResultPayload(payload, { includeTests = false } = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const pruned = { ...payload };
  const items = Array.isArray(pruned.results) ? pruned.results : (Array.isArray(pruned) ? pruned : null);
  if (items) {
    const cleaned = items.filter(item => includeTests || !isTestFileOrSymbol(item)).map(item => {
      if (!item || typeof item !== 'object') return item;
      const copy = { ...item };
      for (const f of UNUSED_AST_FIELDS) delete copy[f];
      delete copy.rank;
      return copy;
    });
    if (Array.isArray(pruned.results)) pruned.results = cleaned;
    else return cleaned;
  }
  return pruned;
}

export function detectMcpPayloadKind(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const target = payload.structuredContent || payload;
  let parsed = null;
  if (Array.isArray(payload.content) && payload.content[0]?.text) {
    try { parsed = JSON.parse(payload.content[0].text); } catch {}
  }
  const obj = (parsed && typeof parsed === 'object') ? parsed : target;
  if (!obj || typeof obj !== 'object') return null;

  if (obj.search_mode != null && Array.isArray(obj.results)) return 'search';
  if (Array.isArray(obj.callers) || Array.isArray(obj.callees) || Array.isArray(obj.paths)) return 'trace';
  if (Array.isArray(obj.file_tree) || Array.isArray(obj.clusters)) return 'architecture';
  if (obj.qualified_name && (obj.source != null || obj.signature != null || obj.parent_class != null || obj.start_line != null)) return 'snippet';
  if (Array.isArray(obj.projects)) return 'projects';
  return null;
}

export function applyPayloadPruning(result, pruner) {
  if (!result || typeof result !== 'object') return result;
  const pruned = result;

  if (pruned.structuredContent) {
    pruned.structuredContent = pruner(pruned.structuredContent);
  }

  if (Array.isArray(pruned.content)) {
    pruned.content = pruned.content.map(item => {
      if (item?.type !== 'text' || typeof item.text !== 'string') return item;
      try {
        const parsed = JSON.parse(item.text);
        return { ...item, text: JSON.stringify(pruner(parsed)) };
      } catch {
        return item;
      }
    });
  }

  if (!pruned.structuredContent && !Array.isArray(pruned.content)) {
    return pruner(pruned);
  }

  return pruned;
}

export function mapFacadeRequest(params) {
  if (!params || typeof params !== 'object') {
    return { mapped: false, facadeTool: null, backendTool: String(params?.name || ''), params };
  }
  const toolName = String(params.name || '');
  const args = params.arguments && typeof params.arguments === 'object' ? { ...params.arguments } : {};

  if (toolName === 'code_search_surgical') {
    const rawQuery = String(args.query || args.pattern || args.term || args.symbol || '').trim();
    let label = args.label;

    // Identificadores PascalCase e camelCase podem representar classes, métodos ou funções.
    // Só aplica o filtro quando o cliente o informou explicitamente.

    // Limites adaptativos:
    // Se a query for muito curta / ampla (<= 3 chars, ou sem filtros), limita para 10 para proteger a janela de contexto
    const requestedLimit = Number(args.limit);
    let limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(50, requestedLimit) : 30;
    if (args.limit == null && (rawQuery.length <= 3 || !label && !args.file_pattern)) {
      limit = 15;
    }

    const mappedArgs = {
      project: args.project,
      query: rawQuery,
      ...(label ? { label } : {}),
      ...(args.file_pattern ? { file_pattern: args.file_pattern } : {}),
      limit,
      ...(Number.isInteger(args.offset) && args.offset >= 0 ? { offset: args.offset } : {})
    };
    return {
      mapped: true,
      facadeTool: 'code_search_surgical',
      backendTool: 'search_graph',
      params: { ...params, name: 'search_graph', arguments: mappedArgs }
    };
  }

  if (toolName === 'trace_symbol') {
    const mappedArgs = {
      project: args.project,
      function_name: args.symbol || args.function_name || args.name || '',
      direction: args.direction || 'both',
      depth: args.depth != null ? args.depth : 2,
      mode: args.mode || 'calls',
      include_tests: args.include_tests === true
    };
    return {
      mapped: true,
      facadeTool: 'trace_symbol',
      backendTool: 'trace_path',
      params: { ...params, name: 'trace_path', arguments: mappedArgs }
    };
  }

  if (toolName === 'get_symbol_snippet') {
    const mappedArgs = {
      project: args.project,
      qualified_name: args.symbol || args.qualified_name || args.name || '',
      ...(args.include_neighbors != null ? { include_neighbors: args.include_neighbors } : {})
    };
    return {
      mapped: true,
      facadeTool: 'get_symbol_snippet',
      backendTool: 'get_code_snippet',
      params: { ...params, name: 'get_code_snippet', arguments: mappedArgs }
    };
  }

  if (toolName === 'inspect_symbol') {
    const mappedArgs = {
      project: args.project,
      qualified_name: args.symbol || args.qualified_name || args.name || '',
      include_neighbors: args.include_neighbors !== false
    };
    return {
      mapped: true,
      facadeTool: 'inspect_symbol',
      backendTool: 'get_code_snippet',
      params: { ...params, name: 'get_code_snippet', arguments: mappedArgs }
    };
  }

  return { mapped: false, facadeTool: null, backendTool: toolName, params };
}

export function authorizeToolCall(params, access) {
  const toolName = String(params?.name || '');
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  const rawProject = typeof args.project === 'string' ? args.project : '';
  const knownProjects = access?.knownProjects || access?.allowedProjects;

  let resolvedProject = rawProject;
  if (rawProject && knownProjects) {
    const alias = resolveProjectAliasMatch(rawProject, knownProjects);
    if (alias.ambiguous) return { allowed: false, reason: `O apelido de projeto ${rawProject} é ambíguo; informe o nome canônico.` };
    if (alias.project) resolvedProject = alias.project;
  }

  if (access?.system === true) return { allowed: true, toolName: params?.name, resolvedProject };
  if (!access) return { allowed: false, reason: 'Credencial sem cadastro de acesso MCP.' };

  if (!MCP_ANALYSIS_TOOLS.has(toolName)) {
    return { allowed: false, reason: `A ferramenta ${toolName || 'informada'} não está disponível para tokens individuais.` };
  }
  if (toolName === 'list_projects') return { allowed: true, toolName, resolvedProject };
  if ((toolName === 'trace_path' || toolName === 'trace_symbol') && args.mode === 'cross_service') {
    return { allowed: false, reason: `${toolName} em modo cross_service pode atravessar repositórios e exige a credencial de sistema.` };
  }
  if (!rawProject) return { allowed: false, reason: `A ferramenta ${toolName} exige o projeto do repositório.` };
  if (!knownProjects || !knownProjects.has(resolvedProject)) {
    return { allowed: false, reason: `O repositório do projeto ${rawProject} não existe ou ainda não foi indexado.` };
  }
  if (!access.allowedProjects.has(resolvedProject)) {
    return { allowed: false, reason: `O usuário não possui acesso ao repositório do projeto ${rawProject}.` };
  }
  return { allowed: true, toolName, resolvedProject };
}

// Optional until AgentGateway has a verified outgoing metadata transport. When enabled,
// it expects metadataContext.guardrailCredential to equal this value.
const SERVICE_CREDENTIAL = String(process.env.MCP_GUARDRAIL_SHARED_SECRET || '');

function validServiceCredential(metadata, expected) {
  const supplied = typeof metadata.guardrailCredential === 'string' ? metadata.guardrailCredential : '';
  if (!expected || !supplied || supplied.length > 512) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validUserId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && /^[a-zA-Z0-9:_-]+$/.test(value);
}

export function createMcpGuardrailHandlers(resolveAccess, { sharedSecret = SERVICE_CREDENTIAL } = {}) {
  return {
    checkRequest(call, callback) {
      const started = performance.now();
      try {
        const metadata = structFromProto(call.request.metadataContext || call.request.metadata_context);
        const userId = String(metadata.userId || '');
        if (sharedSecret && !validServiceCredential(metadata, sharedSecret)) return callback(null, permissionDenied('Credencial de serviço inválida.'));
        if (call.request.method === 'tools/call' && !validUserId(userId)) return callback(null, permissionDenied('Identidade MCP ausente ou inválida.'));
        if (call.request.method !== 'tools/call') return callback(null, { pass: {} });
        const params = parseJsonBuffer(call.request.mcpRequest || call.request.mcp_request, 'A chamada MCP');
        const decision = authorizeToolCall(params, resolveAccess(userId));
        if (!decision.allowed) return callback(null, permissionDenied(decision.reason));

        const requestParams = structuredClone(params);
        if (decision.resolvedProject && requestParams.arguments && typeof requestParams.arguments === 'object') {
          requestParams.arguments.project = decision.resolvedProject;
        }

        const mapResult = mapFacadeRequest(requestParams);
        const shouldMutate = mapResult.mapped || (decision.resolvedProject && decision.resolvedProject !== params?.arguments?.project);

        if (shouldMutate) {
          const finalParams = mapResult.mapped ? mapResult.params : requestParams;
          return callback(null, {
            mutated: Buffer.from(JSON.stringify(finalParams)),
            metadata: structToProto({
              toolName: mapResult.backendTool,
              facadeTool: mapResult.facadeTool || '',
              originalTool: params.name || '',
              resolvedProject: decision.resolvedProject || '',
              callArgs: JSON.stringify(finalParams.arguments || {}),
              ...retrievalMetadata(params.arguments)
            })
          });
        }

        callback(null, {
          pass: {},
          metadata: structToProto({
            toolName: decision.toolName || '',
            originalTool: params.name || '',
            resolvedProject: decision.resolvedProject || '',
            callArgs: JSON.stringify(requestParams.arguments || {}),
            ...retrievalMetadata(params.arguments)
          })
        });
      } catch (error) {
        callback(null, invalidRequest(error.message));
      } finally {
        incrementMetric('mcp_guardrail_calls_total', { phase: 'request' });
        observeMetric('mcp_guardrail_duration_seconds', (performance.now() - started) / 1000, { phase: 'request' });
      }
    },

    checkResponse(call, callback) {
      const started = performance.now();
      try {
        const metadata = structFromProto(call.request.metadataContext || call.request.metadata_context);
        if (sharedSecret && !validServiceCredential(metadata, sharedSecret)) return callback(null, permissionDenied('Credencial de serviço inválida.'));
        if (call.request.method === 'tools/call' && !validUserId(metadata.userId)) return callback(null, permissionDenied('Identidade MCP ausente ou inválida.'));
        const access = resolveAccess(String(metadata.userId || ''));
        const method = String(call.request.method || '');
        if (method === 'tools/call' && !access) return callback(null, permissionDenied('Credencial sem cadastro de acesso MCP.'));
        if (method === 'tools/call' && (!metadata.callArgs || !metadata.originalTool || !metadata.toolName)) {
          return callback(null, permissionDenied('Metadados de autorização incompletos para a resposta MCP.'));
        }

        const result = parseJsonBuffer(call.request.mcpResponse || call.request.mcp_response, 'A resposta MCP');
        if (method === 'tools/list') {
          return callback(null, { mutated: Buffer.from(JSON.stringify(filterToolsListResult(result, { includeFacade: true, pruneDuplicates: true }))) });
        }

        const toolName = String(metadata.toolName || '');
        const facadeTool = String(metadata.facadeTool || '');
        const effectiveTool = facadeTool || toolName;
        let callArgs = null;
        let authorization = null;
        if (metadata.callArgs) {
          try {
            callArgs = JSON.parse(metadata.callArgs);
            authorization = authorizeToolCall({
              name: String(metadata.originalTool || facadeTool || toolName),
              arguments: callArgs
            }, access);
          } catch {
            return callback(null, invalidRequest('Os argumentos da chamada MCP não contêm JSON válido.'));
          }
          if (!authorization.allowed) return callback(null, permissionDenied(authorization.reason));
        }

        const resolvedProject = authorization?.resolvedProject || String(metadata.resolvedProject || '');
        const evidence = resolvedProject && (access?.system === true || access?.allowedProjects?.has(resolvedProject))
          ? evidenceForProject(access, resolvedProject)
          : null;

        const rawResponse = call.request.mcpResponse || call.request.mcp_response || [];
        const rawHash = responseHash(rawResponse);
        const isError = result?.isError === true || result?.error != null;
        const cacheKey = effectiveTool === 'list_projects' ? listProjectsCacheKey(access) : null;
        if (cacheKey && !isError) {
          const cached = getCachedListProjectsResponse(cacheKey, rawHash);
          if (cached) return callback(null, { mutated: cached });
        }

        // Semantic LRU cache check for deterministic read operations
        if (callArgs && !isError) {
          const semKey = semanticCacheKey(effectiveTool, cacheArguments(callArgs, metadata), access, evidence);
          const cachedBuffer = getCachedSemanticResponse(semKey, rawHash);
          if (cachedBuffer) {
            return callback(null, { mutated: cachedBuffer });
          }
        }

        let modified = false;
        let payload = result;

        const detectedKind = detectMcpPayloadKind(result);
        const isTrace = effectiveTool === 'trace_path' || effectiveTool === 'trace_symbol' || detectedKind === 'trace';
        const isArch = effectiveTool === 'get_architecture' || detectedKind === 'architecture';
        const isSnippet = effectiveTool === 'get_code_snippet' || effectiveTool === 'get_symbol_snippet' || effectiveTool === 'inspect_symbol' || detectedKind === 'snippet';
        const isSearch = effectiveTool === 'code_search_surgical' || effectiveTool === 'search_graph' || detectedKind === 'search';

        if (isTrace) {
          const includeTests = metadata.includeTests === 'true';
          if (!includeTests && !hasStructuredTraceResults(payload)) {
            payload = {
              isError: true,
              content: [{ type: 'text', text: 'Rastreamento bloqueado: o backend não retornou referências estruturadas e o filtro de arquivos de teste não pode ser aplicado com segurança. Reexecute com include_tests=true ou configure callers/callees/paths estruturados.' }]
            };
          } else {
            payload = includeTests
              ? applyPayloadPruning(payload, value => pruneTracePayload(value, { includeTests: true }))
              : applyTraceResponsePolicy(payload);
          }
          modified = true;
        } else if (isArch) {
          payload = applyPayloadPruning(payload, pruneArchitecturePayload);
          modified = true;
        } else if (isSnippet) {
          payload = applyPayloadPruning(payload, pruneSnippetPayload);
          modified = true;
        } else if (isSearch) {
          const includeTests = metadata.includeTests === 'true';
          if (!includeTests && !hasStructuredSearchResults(payload)) {
            payload = {
              isError: true,
              content: [{ type: 'text', text: 'Busca bloqueada: o backend não retornou resultados estruturados e o filtro de arquivos de teste não pode ser aplicado com segurança. Reexecute com include_tests=true ou configure structuredContent.results.' }]
            };
          } else {
            const retrievalMode = String(metadata.retrievalMode || '').toLowerCase();
            const policy = retrievalMode && effectiveTool === 'code_search_surgical'
              ? planRetrieval(callArgs?.query, retrievalMode)
              : null;
            const configuredDiversity = Number(metadata.diversityPerPath);
            payload = applySearchResponsePolicy(payload, {
              includeTests,
              policy,
              diversityPerPath: Number.isInteger(configuredDiversity) && configuredDiversity > 0 ? configuredDiversity : 2,
              evidence
            });
          }
          modified = true;
        }

        const hasProjects = projectEntries(result?.structuredContent)
          || result?.content?.some(item => {
            if (item?.type !== 'text' || typeof item.text !== 'string') return false;
            try { return Boolean(projectEntries(JSON.parse(item.text))); } catch { return false; }
          });

        if ((effectiveTool === 'list_projects' || hasProjects) && access?.system !== true) {
          payload = filterListProjectsResult(payload, access ? access.allowedProjects : new Set());
          modified = true;
        }

        if (evidence && payload && typeof payload === 'object' && !Array.isArray(payload)) {
          payload = {
            ...payload,
            _meta: {
              ...(payload._meta && typeof payload._meta === 'object' && !Array.isArray(payload._meta) ? payload._meta : {}),
              'codebase-memory/evidence': evidence
            }
          };
          modified = true;
        }

        if (modified) {
          const mutatedBuffer = Buffer.from(JSON.stringify(payload));
          if (cacheKey && !isError) setCachedListProjectsResponse(cacheKey, mutatedBuffer, rawHash);
          if (callArgs && ['code_search_surgical', 'search_graph', 'get_code_snippet', 'get_symbol_snippet', 'inspect_symbol', 'trace_symbol', 'trace_path', 'get_architecture'].includes(effectiveTool)) {
            const semKey = semanticCacheKey(effectiveTool, cacheArguments(callArgs, metadata), access, evidence);
            if (semKey && !isError) {
              setCachedSemanticResponse(semKey, mutatedBuffer, rawHash);
            }
          }
          return callback(null, { mutated: mutatedBuffer });
        }

        callback(null, { pass: {} });
      } catch (error) {
        callback(null, invalidRequest(error.message));
      } finally {
        incrementMetric('mcp_guardrail_calls_total', { phase: 'response' });
        observeMetric('mcp_guardrail_duration_seconds', (performance.now() - started) / 1000, { phase: 'response' });
      }
    }
  };
}

export async function startMcpGuardrailServer(resolveAccess, address = '0.0.0.0:3001') {
  const definition = protoLoader.loadSync(PROTO_FILE, {
    includeDirs: [path.join(ROOT, 'proto')],
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true
  });
  const descriptor = grpc.loadPackageDefinition(definition);
  const service = descriptor.agentgateway.dev.ext_mcp.ExtMcp.service;
  const handlers = createMcpGuardrailHandlers(resolveAccess);
  const server = new grpc.Server();
  server.addService(service, {
    CheckRequest: handlers.checkRequest,
    CheckResponse: handlers.checkResponse
  });
  server.boundPort = await new Promise((resolve, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) reject(error);
      else if (!port) reject(new Error(`Não foi possível abrir o guardrail MCP em ${address}.`));
      else resolve(port);
    });
  });
  return server;
}
