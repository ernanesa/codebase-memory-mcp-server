import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { increment as incrementMetric, observe as observeMetric } from './observability.js';

const listProjectsCache = new Map();
const LIST_PROJECTS_CACHE_TTL_MS = 30_000;

// LRU Semantic Response Cache para tools determinísticas (snippets, architecture, traces, searches)
const MAX_SEMANTIC_CACHE_ENTRIES = 5000;
const SEMANTIC_CACHE_TTL_MS = 1_800_000; // 30 minutos (invalidado por clearSemanticCache na reindexação)
const semanticResponseCache = new Map();

export function clearSemanticCache() {
  semanticResponseCache.clear();
  listProjectsCache.clear();
}

function getCachedSemanticResponse(key) {
  if (!key) return null;
  const entry = semanticResponseCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    semanticResponseCache.delete(key);
    return null;
  }
  // Refresh LRU order
  semanticResponseCache.delete(key);
  semanticResponseCache.set(key, entry);
  return entry.buffer;
}

function setCachedSemanticResponse(key, buffer) {
  if (!key || !buffer) return;
  if (semanticResponseCache.size >= MAX_SEMANTIC_CACHE_ENTRIES) {
    // Delete oldest entry (first item in Map iterator)
    const oldestKey = semanticResponseCache.keys().next().value;
    if (oldestKey) semanticResponseCache.delete(oldestKey);
  }
  semanticResponseCache.set(key, {
    buffer,
    expiresAt: Date.now() + SEMANTIC_CACHE_TTL_MS
  });
}

function semanticCacheKey(toolName, args) {
  if (!toolName || !args || typeof args !== 'object') return null;
  const project = String(args.project || '').trim();
  if (!project) return null;

  if (toolName === 'get_architecture') {
    return `arch:${project}`;
  }
  if (toolName === 'get_symbol_snippet' || toolName === 'get_code_snippet' || toolName === 'inspect_symbol') {
    const symbol = String(args.symbol || args.qualified_name || args.name || '').trim();
    if (!symbol) return null;
    return `snip:${project}:${symbol}:${args.include_neighbors ? '1' : '0'}`;
  }
  if (toolName === 'trace_symbol' || toolName === 'trace_path') {
    const sym = String(args.symbol || args.function_name || args.name || '').trim();
    if (!sym) return null;
    const depth = args.depth != null ? args.depth : 2;
    const direction = String(args.direction || 'both');
    return `trace:${project}:${sym}:${direction}:${depth}`;
  }
  if (toolName === 'code_search_surgical' || toolName === 'search_graph') {
    const q = String(args.query || args.pattern || args.term || '').trim().toLowerCase();
    if (!q) return null;
    const label = String(args.label || '').trim().toLowerCase();
    const fp = String(args.file_pattern || '').trim().toLowerCase();
    const limit = args.limit != null ? args.limit : 30;
    return `search:${project}:${q}:${label}:${fp}:${limit}`;
  }
  return null;
}

function listProjectsCacheKey(access) {
  if (!access) return null;
  if (access.system) return '__system__';
  return [...access.allowedProjects].sort().join('\0');
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
        limit: { type: 'number', description: 'Limite máximo de resultados (padrão 30, máximo 200).' }
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
        depth: { type: 'number', description: 'Profundidade máxima de saltos (padrão: 2).' }
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
  if (!includeFacade) return { ...result, tools: filtered };

  const existingNames = new Set(filtered.map(t => t?.name));
  const toAdd = FACADE_TOOL_DEFINITIONS.filter(t => !existingNames.has(t.name));
  return { ...result, tools: [...filtered, ...toAdd] };
}

export function resolveProjectAlias(requestedProject, knownProjects) {
  if (!requestedProject || typeof requestedProject !== 'string') return null;
  if (!knownProjects) return null;

  const trimmed = requestedProject.trim();
  if (!trimmed) return null;

  const knownList = knownProjects instanceof Set
    ? Array.from(knownProjects)
    : (Array.isArray(knownProjects) ? knownProjects : []);

  if (knownList.length === 0) return null;

  if (knownProjects instanceof Set && knownProjects.has(trimmed)) return trimmed;
  if (Array.isArray(knownProjects) && knownProjects.includes(trimmed)) return trimmed;

  const lowerTrimmed = trimmed.toLowerCase();
  for (const kp of knownList) {
    if (typeof kp === 'string' && kp.toLowerCase() === lowerTrimmed) {
      return kp;
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
      return kp;
    }

    if (strippedKp.endsWith(`-${target}`) || normKp.endsWith(`-${target}`)) {
      candidates.push(kp);
    }
  }

  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 1) {
    candidates.sort((a, b) => a.length - b.length);
    return candidates[0];
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
    return loose[0];
  }
  if (loose.length > 1) {
    loose.sort((a, b) => a.length - b.length);
    return loose[0];
  }

  return null;
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

export function pruneTracePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const pruned = { ...payload };
  if (Array.isArray(pruned.callers)) {
    pruned.callers = pruned.callers.filter(c => !isTestFileOrSymbol(c));
  }
  if (Array.isArray(pruned.callees)) {
    pruned.callees = pruned.callees.filter(c => !isTestFileOrSymbol(c));
  }
  if (Array.isArray(pruned.paths)) {
    pruned.paths = pruned.paths.filter(p => !isTestFileOrSymbol(p));
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

export function pruneSearchResultPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const pruned = { ...payload };
  const items = Array.isArray(pruned.results) ? pruned.results : (Array.isArray(pruned) ? pruned : null);
  if (items) {
    const cleaned = items.map(item => {
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

    // Roteamento inteligente de queries: se não houver label explícito e o termo parecer um identificador de símbolo
    // (ex: camelCase, PascalCase, snake_case), foca a busca em nós estruturais de definição
    if (!label && /^[A-Z][a-zA-Z0-9_]+$/.test(rawQuery)) {
      // PascalCase -> Class / Type / Interface / Struct
      label = 'Class';
    } else if (!label && /^[a-z][a-zA-Z0-9_]+$/.test(rawQuery) && (rawQuery.includes('_') || /[A-Z]/.test(rawQuery))) {
      // camelCase / snake_case -> Function / Method
      label = 'Function';
    }

    // Limites adaptativos:
    // Se a query for muito curta / ampla (<= 3 chars, ou sem filtros), limita para 10 para proteger a janela de contexto
    let limit = args.limit != null ? args.limit : 30;
    if (args.limit == null && (rawQuery.length <= 3 || !label && !args.file_pattern)) {
      limit = 15;
    }

    const mappedArgs = {
      project: args.project,
      query: rawQuery,
      ...(label ? { label } : {}),
      ...(args.file_pattern ? { file_pattern: args.file_pattern } : {}),
      limit,
      ...(args.offset != null ? { offset: args.offset } : {})
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
      include_tests: false
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
    const alias = resolveProjectAlias(rawProject, knownProjects);
    if (alias) {
      resolvedProject = alias;
    }
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

export function createMcpGuardrailHandlers(resolveAccess) {
  return {
    checkRequest(call, callback) {
      const started = performance.now();
      try {
        const metadata = structFromProto(call.request.metadataContext || call.request.metadata_context);
        const userId = String(metadata.userId || '');
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
              callArgs: JSON.stringify(finalParams.arguments || {})
            })
          });
        }

        callback(null, {
          pass: {},
          metadata: structToProto({
            toolName: decision.toolName || '',
            originalTool: params.name || '',
            resolvedProject: decision.resolvedProject || '',
            callArgs: JSON.stringify(requestParams.arguments || {})
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
        const access = resolveAccess(String(metadata.userId || ''));
        if (!access && !metadata.userId) return callback(null, permissionDenied('Credencial sem cadastro de acesso MCP.'));

        const result = parseJsonBuffer(call.request.mcpResponse || call.request.mcp_response, 'A resposta MCP');
        if (call.request.method === 'tools/list') {
          return callback(null, { mutated: Buffer.from(JSON.stringify(filterToolsListResult(result, { includeFacade: true, pruneDuplicates: true }))) });
        }

        const toolName = String(metadata.toolName || '');
        const facadeTool = String(metadata.facadeTool || '');
        const effectiveTool = facadeTool || toolName;

        const cacheKey = effectiveTool === 'list_projects' ? listProjectsCacheKey(access) : null;
        if (cacheKey) {
          const rawHash = Buffer.from(call.request.mcpResponse || call.request.mcp_response || []).length;
          const cached = listProjectsCache.get(cacheKey);
          if (cached && cached.rawSize === rawHash && cached.expiresAt > Date.now()) {
            return callback(null, { mutated: cached.buffer });
          }
        }

        // Semantic LRU cache check for deterministic read operations
        if (metadata.callArgs) {
          try {
            const callArgs = JSON.parse(metadata.callArgs);
            const semKey = semanticCacheKey(effectiveTool, callArgs);
            const cachedBuffer = getCachedSemanticResponse(semKey);
            if (cachedBuffer) {
              return callback(null, { mutated: cachedBuffer });
            }
          } catch { /* ignore parse error */ }
        }

        let modified = false;
        let payload = result;

        const detectedKind = detectMcpPayloadKind(result);
        const isTrace = effectiveTool === 'trace_path' || effectiveTool === 'trace_symbol' || detectedKind === 'trace';
        const isArch = effectiveTool === 'get_architecture' || detectedKind === 'architecture';
        const isSnippet = effectiveTool === 'get_code_snippet' || effectiveTool === 'get_symbol_snippet' || effectiveTool === 'inspect_symbol' || detectedKind === 'snippet';
        const isSearch = effectiveTool === 'code_search_surgical' || effectiveTool === 'search_graph' || detectedKind === 'search';

        if (isTrace) {
          payload = applyPayloadPruning(payload, pruneTracePayload);
          modified = true;
        } else if (isArch) {
          payload = applyPayloadPruning(payload, pruneArchitecturePayload);
          modified = true;
        } else if (isSnippet) {
          payload = applyPayloadPruning(payload, pruneSnippetPayload);
          modified = true;
        } else if (isSearch) {
          payload = applyPayloadPruning(payload, pruneSearchResultPayload);
          modified = true;
          if (Array.isArray(payload?.content)) {
            let searchItems = null;
            try {
              const parsed = JSON.parse(payload.content[0]?.text || '{}');
              if (Array.isArray(parsed.results)) searchItems = parsed.results;
            } catch {}
            if (!searchItems && Array.isArray(payload?.structuredContent?.results)) {
              searchItems = payload.structuredContent.results;
            }
            if (Array.isArray(searchItems) && searchItems.length > 0) {
              const tableMd = formatSearchResultMarkdown(searchItems);
              if (tableMd) {
                payload.content = [{ type: 'text', text: tableMd }];
              }
            }
          }
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

        if (modified) {
          const mutatedBuffer = Buffer.from(JSON.stringify(payload));
          if (cacheKey) {
            listProjectsCache.set(cacheKey, {
              buffer: mutatedBuffer,
              rawSize: Buffer.from(call.request.mcpResponse || call.request.mcp_response || []).length,
              expiresAt: Date.now() + LIST_PROJECTS_CACHE_TTL_MS
            });
          }
          if (metadata.callArgs) {
            try {
              const callArgs = JSON.parse(metadata.callArgs);
              const semKey = semanticCacheKey(effectiveTool, callArgs);
              if (semKey) {
                setCachedSemanticResponse(semKey, mutatedBuffer);
              }
            } catch { /* ignore */ }
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
