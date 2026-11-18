import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { increment as incrementMetric, observe as observeMetric, recordChunkAcl } from './observability.js';
import { buildProvenance, diversifyCandidates, planRetrieval } from './retrieval-policy.js';
import { CHUNK_ACL_POLICY_VERSION, filterAuthorizedChunks } from './ai-governance.js';

const listProjectsCache = new Map();
const LIST_PROJECTS_CACHE_TTL_MS = 30_000;
const MAX_LIST_PROJECTS_CACHE_ENTRIES = 128;
const MAX_LIST_PROJECTS_CACHE_BYTES = 512 * 1024;
const MAX_CACHED_RESPONSE_BYTES = 64 * 1024;
// Search results eventually become model context. Keep the boundary small and
// structured: the backend is evidence, never an instruction channel.
const RETRIEVAL_CONTENT_POLICY_VERSION = '1';
const MAX_SEARCH_RESULT_COUNT = 20;
const MAX_SEARCH_FIELD_LENGTH = 512;
const MAX_SEARCH_PATH_LENGTH = 1_024;
const SEARCH_RESULT_FIELDS = new Set([
  'id', 'node_id', 'nodeId', 'name', 'symbol', 'qualified_name', 'label', 'type',
  'path', 'file_path', 'file', 'location', 'heading', 'language', 'chunkId', 'chunk_id',
  'start_line', 'end_line', 'line', 'ordinal', 'score'
]);
const RETRIEVAL_INJECTION_PATTERN = /(?:\b(?:ignore|disregard|override|bypass)\b.{0,80}\b(?:previous|prior|system|developer|instruction|rule)s?\b|\b(?:system|developer)\s+(?:message|prompt|instruction)s?\b|\b(?:reveal|exfiltrate|send|upload)\b.{0,80}\b(?:secret|token|credential|password|api[ _-]?key)\b)/i;
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
  // ACL policy is part of cache identity. A policy rollout can therefore never
  // reuse a response generated under weaker chunk-authorization semantics.
  return `acl:${CHUNK_ACL_POLICY_VERSION}:content:${RETRIEVAL_CONTENT_POLICY_VERSION}:${toolName}:${scope}:${stableSerialize(args)}:${stableSerialize(evidence)}`;
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

function boundedSearchValue(key, value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const maximum = ['path', 'file_path', 'file', 'location'].includes(key)
    ? MAX_SEARCH_PATH_LENGTH
    : MAX_SEARCH_FIELD_LENGTH;
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  if (!normalized || normalized.length > maximum || RETRIEVAL_INJECTION_PATTERN.test(normalized)) return undefined;
  return normalized;
}

function safeSearchCandidate(candidate, evidence) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  // A result can contain source, content, comments, documentation and arbitrary
  // backend fields. Do not forward them as model context. Symbol metadata and
  // provenance provide enough evidence for a deliberate follow-up snippet call.
  for (const [key, value] of Object.entries(candidate)) {
    if (SEARCH_RESULT_FIELDS.has(key)) continue;
    if (typeof value === 'string' && RETRIEVAL_INJECTION_PATTERN.test(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '))) return null;
  }
  const safe = {};
  for (const key of SEARCH_RESULT_FIELDS) {
    const value = boundedSearchValue(key, candidate[key]);
    if (candidate[key] !== undefined && value === undefined && typeof candidate[key] === 'string' && RETRIEVAL_INJECTION_PATTERN.test(candidate[key].replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '))) {
      return null;
    }
    if (value !== undefined) safe[key] = value;
  }
  const symbol = candidate.id ?? candidate.node_id ?? candidate.nodeId ?? candidate.qualified_name ?? candidate.name;
  const line = candidate.start_line ?? candidate.line ?? candidate.ordinal;
  const provenance = buildProvenance({
    ...candidate,
    path: typeof candidate.path === 'string' ? candidate.path : candidate.file_path,
    chunkId: candidate.chunkId ?? candidate.chunk_id ?? (symbol ? `node:${symbol}:${line ?? ''}` : undefined)
  }, evidence || {});
  if (!provenance.project || !provenance.chunkId) return null;
  return { ...safe, provenance };
}

function safeSearchEnvelope(target, results, metadata) {
  const envelope = { results, chunk_acl: metadata };
  if (typeof target.search_mode === 'string') envelope.search_mode = boundedSearchValue('search_mode', target.search_mode) || 'unknown';
  if (Number.isInteger(target.offset) && target.offset >= 0) envelope.offset = target.offset;
  if (Number.isInteger(target.total) && target.total >= 0) envelope.total = Math.min(target.total, MAX_SEARCH_RESULT_COUNT);
  return envelope;
}

function applySearchResultPolicy(target, { includeTests = false, policy = null, diversityPerPath = 2, evidence = null, access = null, project = '' } = {}) {
  if (!target || typeof target !== 'object' || !Array.isArray(target.results)) return target;
  const pruned = pruneSearchResultPayload(target, { includeTests });
  // The upstream index can return candidates from a broad retrieval pool. Bind
  // every emitted chunk to the already-authorized request project before any
  // result is serialized or cached. Legacy chunks are accepted only through
  // that project binding; explicit ACL metadata is fail-closed.
  const authorization = filterAuthorizedChunks(pruned.results, { access, project });
  const safeCandidates = authorization.chunks
    .map(item => safeSearchCandidate(item, evidence))
    .filter(Boolean)
    .slice(0, MAX_SEARCH_RESULT_COUNT);
  const rejectedUnsafeContent = authorization.chunks.length - safeCandidates.length;
  recordChunkAcl({ allowed: safeCandidates.length, denied: authorization.denied + rejectedUnsafeContent });
  const aclMetadata = {
    version: authorization.policyVersion,
    denied: authorization.denied,
    legacy_project_bindings: authorization.legacyProjectBindings,
    content_policy_version: RETRIEVAL_CONTENT_POLICY_VERSION,
    unsafe_content_rejected: rejectedUnsafeContent
  };
  if (!policy) return safeSearchEnvelope(pruned, safeCandidates, aclMetadata);
  const candidates = safeCandidates.map((item, index) => {
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
      const {
        __syntheticPath: syntheticPath,
        __syntheticScore: syntheticScore,
        __syntheticChunkId: syntheticChunkId,
        ...item
      } = candidate;
      if (syntheticPath) delete item.path;
      if (syntheticScore) delete item.score;
      if (syntheticChunkId) delete item.chunkId;
      return item;
    });
  return {
    ...safeSearchEnvelope(pruned, selected, aclMetadata),
    retrieval_policy: { mode: policy.mode, diversity_per_path: diversityPerPath }
  };
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

// Increment this version when plugin-facing tool names, facade schemas, or
// evidence metadata change incompatibly. Keep the contract derived from the
// same definitions used by tools/list so consumers cannot silently drift.
export const MCP_PLUGIN_CONTRACT_VERSION = '1.1.0';
export const MCP_EVIDENCE_META_KEY = 'codebase-memory/evidence';
const MCP_PLUGIN_PASSTHROUGH_TOOLS = new Set([
  'get_architecture',
  'index_status',
  'list_projects'
]);
export const MCP_PLUGIN_CONTRACT = Object.freeze({
  version: MCP_PLUGIN_CONTRACT_VERSION,
  tools: Object.freeze({
    allowedNames: Object.freeze([
      ...new Set([
        ...MCP_PLUGIN_PASSTHROUGH_TOOLS,
        ...FACADE_TOOL_DEFINITIONS.map(tool => tool.name)
      ])
    ].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)),
    facades: FACADE_TOOL_DEFINITIONS
  }),
  evidence: Object.freeze({
    metaKey: MCP_EVIDENCE_META_KEY,
    fields: Object.freeze({
      project: 'string',
      status: Object.freeze(['fresh', 'stale', 'unknown']),
      indexedCommit: 'string|null',
      indexedAt: 'string|null'
    })
  }),
  retrieval: Object.freeze({
    chunkAcl: Object.freeze({
      policyVersion: CHUNK_ACL_POLICY_VERSION,
      fields: Object.freeze({
        version: 'string',
        denied: 'number',
        legacy_project_bindings: 'number',
        content_policy_version: 'string',
        unsafe_content_rejected: 'number'
      })
    })
  })
});

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

const TEST_PATH_PATTERN = /(?:\.(?:spec|test)\.[a-z0-9]+$|[._-]test\.[a-z0-9]+$|[^/\\]+_?test\.py$|test_[^/\\]+\.py$|[^/\\]+Tests?\.cs$|(?:^|[/\\])(?:__tests__|tests?)(?:[/\\]|$))/i;
const TEST_QN_PATTERN = /(?:(?:^|[._])tests?(?:[._]|$)|\.Tests?\.|Tests?(?:\.|$)|Test\.[^.]*Tests)/i;
const TEST_NAME_PATTERN = /(?:^test_|_test$|Tests?$)/i;

export function isTestFileOrSymbol(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.is_test === true) return true;

  const rawPaths = [item.file_path, item.filePath, item.file, item.path, item.location];
  let lastPath = '';
  for (let i = 0; i < rawPaths.length; i++) {
    const p = rawPaths[i];
    if (typeof p !== 'string' || p.length === 0 || p === lastPath) continue;
    lastPath = p;
    if (TEST_PATH_PATTERN.test(p)) return true;
  }

  const qn = typeof item.qualified_name === 'string' ? item.qualified_name : (typeof item.qn === 'string' ? item.qn : '');
  if (qn && TEST_QN_PATTERN.test(qn)) return true;

  const name = typeof item.name === 'string' ? item.name : '';
  if (name && TEST_NAME_PATTERN.test(name)) return true;

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

const LICENSE_HEADER_KEYWORDS = /\b(?:license|copyright|all rights reserved|apache|mit|spdx-license-identifier)\b/i;

function stripLeadingLicenseComments(source) {
  let offset = 0;
  const length = source.length;
  while (offset < length) {
    let cursor = offset;
    while (cursor < length && (source[cursor] === ' ' || source[cursor] === '\t' || source[cursor] === '\r' || source[cursor] === '\n')) {
      cursor += 1;
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2);
      if (end === -1) break;
      const block = source.slice(cursor, end + 2);
      if (!LICENSE_HEADER_KEYWORDS.test(block)) break;
      offset = end + 2;
      continue;
    }
    if (source.startsWith('//', cursor)) {
      let blockEnd = cursor;
      let hasKeyword = false;
      while (blockEnd < length && source.startsWith('//', blockEnd)) {
        const lineEnd = source.indexOf('\n', blockEnd);
        const nextEnd = lineEnd === -1 ? length : lineEnd + 1;
        const line = source.slice(blockEnd, nextEnd);
        if (LICENSE_HEADER_KEYWORDS.test(line)) hasKeyword = true;
        blockEnd = nextEnd;
        while (blockEnd < length && (source[blockEnd] === ' ' || source[blockEnd] === '\t' || source[blockEnd] === '\r')) {
          blockEnd += 1;
        }
      }
      if (!hasKeyword) break;
      offset = blockEnd;
      continue;
    }
    break;
  }
  return offset > 0 ? source.slice(offset) : source;
}

export function collapseMethodBodies(source) {
  if (typeof source !== 'string' || !source) return source;
  const lines = source.split('\n');
  const out = [];
  let depth = 0;
  let collapsedAtDepth = 0;
  for (const line of lines) {
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    if (collapsedAtDepth > 0) {
      depth += opens - closes;
      if (depth < collapsedAtDepth) {
        collapsedAtDepth = 0;
        out.push(line.replace(/^\s*/, match => `${match}/* ... */ `));
      }
      continue;
    }
    out.push(line);
    const nextDepth = depth + opens - closes;
    if (opens > closes && depth >= 1 && !/\b(?:class|interface|struct|namespace|enum|record)\b/.test(line)) {
      collapsedAtDepth = nextDepth;
    }
    depth = nextDepth;
  }
  return out.join('\n');
}

export function sliceCodeSnippet(source, { maxLines = 0, skeletonOnly = false } = {}) {
  if (typeof source !== 'string' || !source) return source;

  // 1. Remove license/boilerplate headers at the top of snippet (linear scan without backtracking)
  let cleaned = stripLeadingLicenseComments(source);

  // 2. Opcionalmente colapsa corpos de métodos no modo skeleton
  if (skeletonOnly) {
    cleaned = collapseMethodBodies(cleaned);
  }

  // 3. Colapsa múltiplas linhas vazias consecutivas (máximo 1 linha em branco)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // 4. Remove trailing whitespace por linha
  cleaned = cleaned.replace(/[ \t]+$/gm, '').trim();

  // 5. Aplica teto opcional de linhas
  if (Number.isInteger(maxLines) && maxLines > 0) {
    const lines = cleaned.split('\n');
    if (lines.length > maxLines) {
      cleaned = `${lines.slice(0, maxLines).join('\n')}\n// ... [${lines.length - maxLines} linhas omitidas]`;
    }
  }

  return cleaned;
}

export function pruneSnippetObject(obj, options = {}) {
  if (!obj || typeof obj !== 'object') return obj;
  const cleaned = {};
  const includeTests = options.includeTests === true;
  for (const [k, v] of Object.entries(obj)) {
    if (UNUSED_AST_FIELDS.has(k)) continue;
    if (k === 'source' && typeof v === 'string') {
      cleaned[k] = sliceCodeSnippet(v, options);
      continue;
    }
    if ((k === 'neighbors' || k === 'callers' || k === 'callees') && Array.isArray(v)) {
      cleaned[k] = v
        .filter(item => includeTests || !isTestFileOrSymbol(item))
        .map(item => pruneSnippetObject(item, options));
      continue;
    }
    cleaned[k] = v;
  }
  return cleaned;
}

export function pruneSnippetPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) {
    return payload.map(item => pruneSnippetObject(item, options));
  }
  const result = pruneSnippetObject(payload, options);
  if (Array.isArray(result.results)) {
    result.results = result.results.map(item => pruneSnippetObject(item, options));
  }
  if (Array.isArray(result.suggestions)) {
    result.suggestions = result.suggestions.map(item => pruneSnippetObject(item, options));
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
    // Se retrieval_mode foi informado sem limit explícito, dimensiona o lote do backend de acordo com o modo.
    const requestedLimit = Number(args.limit);
    const retrievalMode = typeof args.retrieval_mode === 'string' ? args.retrieval_mode.trim().toLowerCase() : '';
    let limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(50, requestedLimit) : 30;
    if (args.limit == null) {
      if (retrievalMode === 'thorough') {
        limit = 50;
      } else if (retrievalMode === 'fast') {
        limit = 16;
      } else if (rawQuery.length <= 3 || !label && !args.file_pattern) {
        limit = 15;
      }
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
  const pendingCallsByUser = new Map();

  function recordPendingCall(userId, data) {
    if (!userId) return;
    const now = Date.now();
    let queue = pendingCallsByUser.get(userId);
    if (!queue) {
      queue = [];
      pendingCallsByUser.set(userId, queue);
    }
    while (queue.length > 0 && now - queue[0].createdAt > 60_000) {
      queue.shift();
    }
    queue.push({ ...data, createdAt: now });
  }

  function resolvePendingCall(userId, toolName, requestId = '') {
    if (!userId) return null;
    const queue = pendingCallsByUser.get(userId);
    if (!queue || queue.length === 0) return null;
    const now = Date.now();
    while (queue.length > 0 && now - queue[0].createdAt > 60_000) {
      queue.shift();
    }
    if (queue.length === 0) return null;
    if (requestId) {
      const idIndex = queue.findIndex(item => item.requestId === requestId);
      if (idIndex !== -1) return queue.splice(idIndex, 1)[0];
    }
    if (toolName) {
      const matchIndex = queue.findIndex(item => item.toolName === toolName || item.originalTool === toolName || item.facadeTool === toolName);
      return matchIndex !== -1 ? queue.splice(matchIndex, 1)[0] : null;
    }
    return queue.shift() || null;
  }

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

        const projectMutated = Boolean(decision.resolvedProject && decision.resolvedProject !== params?.arguments?.project);
        const requestParams = projectMutated && params.arguments && typeof params.arguments === 'object'
          ? { ...params, arguments: { ...params.arguments, project: decision.resolvedProject } }
          : params;

        const mapResult = mapFacadeRequest(requestParams);
        const shouldMutate = mapResult.mapped || projectMutated;
        const requestId = randomUUID();
        const extraMeta = retrievalMetadata(params.arguments);

        if (shouldMutate) {
          const finalParams = mapResult.mapped ? mapResult.params : requestParams;
          const serializedArgs = JSON.stringify(finalParams.arguments || {});
          const pendingMeta = {
            requestId,
            toolName: mapResult.backendTool,
            facadeTool: mapResult.facadeTool || '',
            originalTool: params.name || '',
            resolvedProject: decision.resolvedProject || '',
            callArgs: serializedArgs,
            ...extraMeta
          };
          recordPendingCall(userId, pendingMeta);
          return callback(null, {
            mutated: Buffer.from(JSON.stringify(finalParams)),
            metadata: structToProto(pendingMeta)
          });
        }

        const serializedArgs = JSON.stringify(requestParams.arguments || {});
        const pendingMeta = {
          requestId,
          toolName: decision.toolName || '',
          facadeTool: '',
          originalTool: params.name || '',
          resolvedProject: decision.resolvedProject || '',
          callArgs: serializedArgs,
          ...extraMeta
        };
        recordPendingCall(userId, pendingMeta);

        callback(null, {
          pass: {},
          metadata: structToProto({
            requestId,
            toolName: decision.toolName || '',
            originalTool: params.name || '',
            resolvedProject: decision.resolvedProject || '',
            callArgs: serializedArgs,
            ...extraMeta
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

        if (method === 'tools/call') {
          const pending = resolvePendingCall(metadata.userId, metadata.toolName, metadata.requestId);
          if (pending) {
            if (!metadata.toolName) metadata.toolName = pending.toolName;
            if (!metadata.originalTool) metadata.originalTool = pending.originalTool;
            if (!metadata.facadeTool) metadata.facadeTool = pending.facadeTool;
            if (!metadata.callArgs) metadata.callArgs = pending.callArgs;
            if (!metadata.resolvedProject) metadata.resolvedProject = pending.resolvedProject;
            if (!metadata.retrievalMode && pending.retrievalMode) metadata.retrievalMode = pending.retrievalMode;
            if (metadata.diversityPerPath == null && pending.diversityPerPath != null) metadata.diversityPerPath = pending.diversityPerPath;
            if (metadata.includeTests == null && pending.includeTests != null) metadata.includeTests = pending.includeTests;
          }
        }

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
        const semKey = callArgs && !isError
          ? semanticCacheKey(effectiveTool, cacheArguments(callArgs, metadata), access, evidence)
          : null;
        if (semKey) {
          const cachedBuffer = getCachedSemanticResponse(semKey, rawHash);
          if (cachedBuffer) {
            return callback(null, { mutated: cachedBuffer });
          }
        }

        let modified = false;
        let payload = result;

        const knownTrace = effectiveTool === 'trace_path' || effectiveTool === 'trace_symbol';
        const knownArch = effectiveTool === 'get_architecture';
        const knownSnippet = effectiveTool === 'get_code_snippet' || effectiveTool === 'get_symbol_snippet' || effectiveTool === 'inspect_symbol';
        const knownSearch = effectiveTool === 'code_search_surgical' || effectiveTool === 'search_graph';
        const detectedKind = (knownTrace || knownArch || knownSnippet || knownSearch) ? null : detectMcpPayloadKind(result);
        const isTrace = knownTrace || detectedKind === 'trace';
        const isArch = knownArch || detectedKind === 'architecture';
        const isSnippet = knownSnippet || detectedKind === 'snippet';
        const isSearch = knownSearch || detectedKind === 'search';

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
          const snippetOptions = {
            includeTests: metadata.includeTests === 'true',
            skeletonOnly: callArgs?.skeleton_only === true,
            maxLines: Number.isInteger(callArgs?.max_lines) && callArgs.max_lines > 0 ? callArgs.max_lines : 0
          };
          payload = applyPayloadPruning(payload, value => pruneSnippetPayload(value, snippetOptions));
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
              evidence,
              access,
              project: resolvedProject
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
              [MCP_EVIDENCE_META_KEY]: evidence
            }
          };
          modified = true;
        }

        if (modified) {
          const mutatedBuffer = Buffer.from(JSON.stringify(payload));
          if (cacheKey && !isError) setCachedListProjectsResponse(cacheKey, mutatedBuffer, rawHash);
          if (semKey && !isError && ['code_search_surgical', 'search_graph', 'get_code_snippet', 'get_symbol_snippet', 'inspect_symbol', 'trace_symbol', 'trace_path', 'get_architecture'].includes(effectiveTool)) {
            setCachedSemanticResponse(semKey, mutatedBuffer, rawHash);
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
  if (typeof address === 'string' && address.startsWith('unix:')) {
    const socketPath = address.slice(5);
    if (socketPath) {
      try { rmSync(socketPath, { force: true }); } catch {}
    }
  }
  server.boundPort = await new Promise((resolve, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) reject(error);
      else if (!port && !String(address).startsWith('unix:')) reject(new Error(`Não foi possível abrir o guardrail MCP em ${address}.`));
      else resolve(port || address);
    });
  });
  return server;
}
