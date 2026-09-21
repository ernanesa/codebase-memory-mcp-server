import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  'get_symbol_snippet'
]);

export const FACADE_TOOLS = new Set([
  'code_search_surgical',
  'trace_symbol',
  'get_symbol_snippet'
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
        limit: { type: 'number', description: 'Limite máximo de resultados (padrão 200).' }
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
  const filtered = structuredClone(result);
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

export function filterToolsListResult(result, { includeFacade = false } = {}) {
  if (!Array.isArray(result?.tools)) return result;
  const filtered = result.tools.filter(tool => MCP_ANALYSIS_TOOLS.has(tool?.name));
  if (!includeFacade) return { ...result, tools: filtered };

  const existingNames = new Set(filtered.map(t => t?.name));
  const toAdd = FACADE_TOOL_DEFINITIONS.filter(t => !existingNames.has(t.name));
  return { ...result, tools: [...filtered, ...toAdd] };
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

export function pruneSnippetObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    if (UNUSED_AST_FIELDS.has(k)) continue;
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

export function applyPayloadPruning(result, pruner) {
  if (!result || typeof result !== 'object') return result;
  const pruned = structuredClone(result);

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
    const mappedArgs = {
      project: args.project,
      query: args.query || args.pattern || args.term || args.symbol || '',
      ...(args.label ? { label: args.label } : {}),
      ...(args.file_pattern ? { file_pattern: args.file_pattern } : {}),
      ...(args.limit != null ? { limit: args.limit } : {}),
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

  return { mapped: false, facadeTool: null, backendTool: toolName, params };
}

export function authorizeToolCall(params, access) {
  if (access?.system === true) return { allowed: true, toolName: params?.name };
  if (!access) return { allowed: false, reason: 'Credencial sem cadastro de acesso MCP.' };

  const toolName = String(params?.name || '');
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  if (!MCP_ANALYSIS_TOOLS.has(toolName)) {
    return { allowed: false, reason: `A ferramenta ${toolName || 'informada'} não está disponível para tokens individuais.` };
  }
  if (toolName === 'list_projects') return { allowed: true, toolName };
  if ((toolName === 'trace_path' || toolName === 'trace_symbol') && args.mode === 'cross_service') {
    return { allowed: false, reason: `${toolName} em modo cross_service pode atravessar repositórios e exige a credencial de sistema.` };
  }
  const project = typeof args.project === 'string' ? args.project : '';
  if (!project) return { allowed: false, reason: `A ferramenta ${toolName} exige o projeto do repositório.` };
  const knownProjects = access.knownProjects || access.allowedProjects;
  if (!knownProjects.has(project)) {
    return { allowed: false, reason: `O repositório do projeto ${project} não existe ou ainda não foi indexado.` };
  }
  if (!access.allowedProjects.has(project)) {
    return { allowed: false, reason: `O usuário não possui acesso ao repositório do projeto ${project}.` };
  }
  return { allowed: true, toolName };
}

export function createMcpGuardrailHandlers(resolveAccess) {
  return {
    checkRequest(call, callback) {
      try {
        const metadata = structFromProto(call.request.metadataContext || call.request.metadata_context);
        const userId = String(metadata.userId || '');
        if (call.request.method !== 'tools/call') return callback(null, { pass: {} });
        const params = parseJsonBuffer(call.request.mcpRequest || call.request.mcp_request, 'A chamada MCP');
        const decision = authorizeToolCall(params, resolveAccess(userId));
        if (!decision.allowed) return callback(null, permissionDenied(decision.reason));

        const mapResult = mapFacadeRequest(params);
        if (mapResult.mapped) {
          return callback(null, {
            mutated: Buffer.from(JSON.stringify(mapResult.params)),
            metadata: structToProto({
              toolName: mapResult.backendTool,
              facadeTool: mapResult.facadeTool,
              originalTool: params.name || ''
            })
          });
        }

        callback(null, {
          pass: {},
          metadata: structToProto({
            toolName: decision.toolName || '',
            originalTool: params.name || ''
          })
        });
      } catch (error) {
        callback(null, invalidRequest(error.message));
      }
    },

    checkResponse(call, callback) {
      try {
        const metadata = structFromProto(call.request.metadataContext || call.request.metadata_context);
        const access = resolveAccess(String(metadata.userId || ''));
        if (!access && !metadata.userId) return callback(null, permissionDenied('Credencial sem cadastro de acesso MCP.'));

        const result = parseJsonBuffer(call.request.mcpResponse || call.request.mcp_response, 'A resposta MCP');
        if (call.request.method === 'tools/list') {
          return callback(null, { mutated: Buffer.from(JSON.stringify(filterToolsListResult(result, { includeFacade: true }))) });
        }

        const toolName = String(metadata.toolName || '');
        const facadeTool = String(metadata.facadeTool || '');
        const effectiveTool = facadeTool || toolName;

        let modified = false;
        let payload = result;

        if (effectiveTool === 'trace_path' || effectiveTool === 'trace_symbol') {
          payload = applyPayloadPruning(payload, pruneTracePayload);
          modified = true;
        } else if (effectiveTool === 'get_architecture') {
          payload = applyPayloadPruning(payload, pruneArchitecturePayload);
          modified = true;
        } else if (effectiveTool === 'get_code_snippet' || effectiveTool === 'get_symbol_snippet') {
          payload = applyPayloadPruning(payload, pruneSnippetPayload);
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

        if (modified) {
          return callback(null, { mutated: Buffer.from(JSON.stringify(payload)) });
        }

        callback(null, { pass: {} });
      } catch (error) {
        callback(null, invalidRequest(error.message));
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
