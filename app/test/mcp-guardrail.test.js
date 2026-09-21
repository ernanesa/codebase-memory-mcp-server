import test from 'node:test';
import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import {
  authorizeToolCall,
  filterListProjectsResult,
  filterToolsListResult,
  startMcpGuardrailServer,
  mapFacadeRequest,
  pruneTracePayload,
  pruneArchitecturePayload,
  pruneSnippetPayload,
  applyPayloadPruning,
  FACADE_TOOLS
} from '../src/mcp-guardrail.js';

const scopedAccess = {
  system: false,
  allowedProjects: new Set(['api-pedidos', 'portal-web']),
  knownProjects: new Set(['api-pedidos', 'portal-web', 'api-financeiro'])
};

test('guardrail permite análise somente nos projetos autorizados', () => {
  assert.equal(authorizeToolCall({ name: 'search_graph', arguments: { project: 'api-pedidos' } }, scopedAccess).allowed, true);
  assert.match(authorizeToolCall({ name: 'search_graph', arguments: { project: 'api-financeiro' } }, scopedAccess).reason, /não possui acesso/);
  assert.match(authorizeToolCall({ name: 'search_graph', arguments: { project: 'projeto-inexistente' } }, scopedAccess).reason, /não existe ou ainda não foi indexado/);
  assert.match(authorizeToolCall({ name: 'search_graph', arguments: {} }, scopedAccess).reason, /exige o projeto/);
});

test('guardrail bloqueia mutações, ferramentas desconhecidas e travessia cross-service', () => {
  for (const name of ['index_repository', 'delete_project', 'manage_adr', 'ingest_traces', 'future_tool']) {
    assert.equal(authorizeToolCall({ name, arguments: { project: 'api-pedidos' } }, scopedAccess).allowed, false);
  }
  assert.equal(authorizeToolCall({ name: 'trace_path', arguments: { project: 'api-pedidos', mode: 'cross_service' } }, scopedAccess).allowed, false);
  assert.equal(authorizeToolCall({ name: 'trace_path', arguments: { project: 'api-pedidos', mode: 'calls' } }, scopedAccess).allowed, true);
});

test('credencial de sistema permanece irrestrita', () => {
  assert.equal(authorizeToolCall({ name: 'delete_project', arguments: { project: 'qualquer' } }, { system: true }).allowed, true);
});

test('list_projects é filtrado no conteúdo textual e estruturado', () => {
  const payload = {
    content: [{ type: 'text', text: JSON.stringify({ projects: [{ name: 'api-pedidos' }, { name: 'api-financeiro' }] }) }],
    structuredContent: { projects: [{ name: 'api-pedidos' }, { name: 'api-financeiro' }] },
    isError: false
  };
  const filtered = filterListProjectsResult(payload, scopedAccess.allowedProjects);
  assert.deepEqual(filtered.structuredContent.projects.map(item => item.name), ['api-pedidos']);
  assert.deepEqual(JSON.parse(filtered.content[0].text).projects.map(item => item.name), ['api-pedidos']);
  const malformed = filterListProjectsResult({ content: [{ type: 'text', text: 'api-financeiro' }] }, scopedAccess.allowedProjects);
  assert.deepEqual(JSON.parse(malformed.content[0].text), { projects: [] });
});

test('tools/list não anuncia ferramentas administrativas para tokens individuais', () => {
  const filtered = filterToolsListResult({ tools: [
    { name: 'search_graph' },
    { name: 'index_repository' },
    { name: 'manage_adr' }
  ] });
  assert.deepEqual(filtered.tools.map(tool => tool.name), ['search_graph']);
});

test('servidor gRPC implementa o protocolo ExtMcp esperado pelo AgentGateway', async t => {
  const server = await startMcpGuardrailServer(userId => userId === 'user-1' ? scopedAccess : null, '127.0.0.1:0');
  t.after(() => new Promise(resolve => server.tryShutdown(resolve)));
  const protoRoot = path.resolve(import.meta.dirname, '..', 'proto');
  const definition = protoLoader.loadSync(path.join(protoRoot, 'ext_mcp.proto'), {
    includeDirs: [protoRoot],
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true
  });
  const descriptor = grpc.loadPackageDefinition(definition);
  const Client = descriptor.agentgateway.dev.ext_mcp.ExtMcp;
  const client = new Client(`127.0.0.1:${server.boundPort}`, grpc.credentials.createInsecure());
  t.after(() => client.close());

  const result = await new Promise((resolve, reject) => client.CheckRequest({
    method: 'tools/call',
    metadataContext: { fields: { userId: { stringValue: 'user-1' } } },
    mcpRequest: Buffer.from(JSON.stringify({ name: 'search_graph', arguments: { project: 'api-pedidos' } }))
  }, (error, response) => error ? reject(error) : resolve(response)));

  assert.ok(result.pass);
  assert.equal(result.metadata.fields.toolName.stringValue, 'search_graph');

  const denied = await new Promise((resolve, reject) => client.CheckRequest({
    method: 'tools/call',
    metadataContext: { fields: { userId: { stringValue: 'user-1' } } },
    mcpRequest: Buffer.from(JSON.stringify({ name: 'search_graph', arguments: { project: 'api-financeiro' } }))
  }, (error, response) => error ? reject(error) : resolve(response)));
  assert.equal(denied.error.code, 'PERMISSION_DENIED');

  const upstream = {
    content: [{ type: 'text', text: JSON.stringify({ projects: [{ name: 'api-pedidos' }, { name: 'api-financeiro' }] }) }],
    structuredContent: { projects: [{ name: 'api-pedidos' }, { name: 'api-financeiro' }] }
  };
  const filtered = await new Promise((resolve, reject) => client.CheckResponse({
    method: 'tools/call',
    metadataContext: {
      fields: {
        userId: { stringValue: 'user-1' },
        toolName: { stringValue: 'list_projects' }
      }
    },
    mcpResponse: Buffer.from(JSON.stringify(upstream))
  }, (error, response) => error ? reject(error) : resolve(response)));
  assert.deepEqual(JSON.parse(filtered.mutated).structuredContent.projects.map(item => item.name), ['api-pedidos']);
});

test('ferramentas facade são reconhecidas e autorizadas pelo guardrail', () => {
  for (const name of FACADE_TOOLS) {
    assert.equal(authorizeToolCall({ name, arguments: { project: 'api-pedidos' } }, scopedAccess).allowed, true);
    assert.match(authorizeToolCall({ name, arguments: { project: 'api-financeiro' } }, scopedAccess).reason, /não possui acesso/);
    assert.match(authorizeToolCall({ name, arguments: {} }, scopedAccess).reason, /exige o projeto/);
  }
  assert.equal(authorizeToolCall({ name: 'trace_symbol', arguments: { project: 'api-pedidos', mode: 'cross_service' } }, scopedAccess).allowed, false);
});

test('mapeamento transparente de ferramentas facade em mapFacadeRequest', () => {
  const surgical = mapFacadeRequest({
    name: 'code_search_surgical',
    arguments: { project: 'api-pedidos', query: 'ProcessarPedido', label: 'Method' }
  });
  assert.equal(surgical.mapped, true);
  assert.equal(surgical.backendTool, 'search_graph');
  assert.equal(surgical.params.name, 'search_graph');
  assert.equal(surgical.params.arguments.query, 'ProcessarPedido');
  assert.equal(surgical.params.arguments.label, 'Method');

  const trace = mapFacadeRequest({
    name: 'trace_symbol',
    arguments: { project: 'api-pedidos', symbol: 'CriarPedido', direction: 'callers' }
  });
  assert.equal(trace.mapped, true);
  assert.equal(trace.backendTool, 'trace_path');
  assert.equal(trace.params.name, 'trace_path');
  assert.equal(trace.params.arguments.function_name, 'CriarPedido');
  assert.equal(trace.params.arguments.direction, 'callers');
  assert.equal(trace.params.arguments.include_tests, false);

  const snippet = mapFacadeRequest({
    name: 'get_symbol_snippet',
    arguments: { project: 'api-pedidos', symbol: 'api-pedidos.Services.OrderService.Create' }
  });
  assert.equal(snippet.mapped, true);
  assert.equal(snippet.backendTool, 'get_code_snippet');
  assert.equal(snippet.params.name, 'get_code_snippet');
  assert.equal(snippet.params.arguments.qualified_name, 'api-pedidos.Services.OrderService.Create');

  const native = mapFacadeRequest({ name: 'list_projects', arguments: {} });
  assert.equal(native.mapped, false);
});

test('poda de trace_path / trace_symbol filtra callers e callees de arquivos de teste', () => {
  const rawTrace = {
    function: 'Processar',
    callers: [
      { name: 'WorkerService', file_path: 'src/services/worker.ts', qualified_name: 'App.WorkerService' },
      { name: 'TestProcessar', file_path: 'test/worker.spec.ts', qualified_name: 'App.Test.WorkerSpec' },
      { name: 'OrderServiceTest', file_path: 'tests/OrderTest.cs', qualified_name: 'App.Tests.OrderServiceTest' },
      { name: 'test_worker', file_path: 'tests/test_worker.py', qualified_name: 'test_worker' },
      { name: 'AppTests', file_path: 'src/__tests__/app.test.js', qualified_name: 'App.Tests.AppTests' }
    ],
    callees: [
      { name: 'RepoSave', file_path: 'src/repo.ts', qualified_name: 'App.Repo.Save' },
      { name: 'MockSave', file_path: 'test/mocks.spec.ts', qualified_name: 'App.Test.MockSave' }
    ]
  };
  const pruned = pruneTracePayload(rawTrace);
  assert.deepEqual(pruned.callers.map(c => c.name), ['WorkerService']);
  assert.deepEqual(pruned.callees.map(c => c.name), ['RepoSave']);
});

test('poda de get_architecture resume a árvore de arquivos e remove clusters vazios', () => {
  const rawArch = {
    project: 'api-pedidos',
    total_nodes: 50,
    clusters: [
      { id: 1, label: 'Core', members: 10, top_nodes: ['Processar'] },
      { id: 2, label: 'Empty', members: 0, top_nodes: [] }
    ],
    file_tree: [
      { path: 'src', type: 'dir', children: 2 },
      { path: 'src/index.ts', type: 'file', children: 0 },
      { path: 'src/deep/nested/file.ts', type: 'file', children: 0 }
    ]
  };
  const pruned = pruneArchitecturePayload(rawArch);
  assert.equal(pruned.file_tree, undefined);
  assert.ok(pruned.file_summary);
  assert.equal(pruned.file_summary.total_files, 2);
  assert.equal(pruned.file_summary.total_directories, 1);
  assert.equal(pruned.clusters.length, 1);
  assert.equal(pruned.clusters[0].label, 'Core');

  const emptyClustersArch = pruneArchitecturePayload({ project: 'test', clusters: [] });
  assert.equal(emptyClustersArch.clusters, undefined);
});

test('poda de get_code_snippet / get_symbol_snippet remove propriedades de AST redundantes', () => {
  const rawSnippet = {
    name: 'CreateOrder',
    qualified_name: 'App.Orders.CreateOrder',
    label: 'Method',
    file_path: 'src/orders.ts',
    start_line: 10,
    end_line: 25,
    source: 'function CreateOrder() {}',
    signature: '() => void',
    complexity: 3,
    cognitive: 2,
    loop_count: 0,
    loop_depth: 0,
    self_recursive: false,
    param_count: 2,
    max_access_depth: 1,
    linear_scan_in_loop: 0,
    alloc_in_loop: 0,
    recursion_in_loop: false,
    unguarded_recursion: false,
    lines: 15,
    is_exported: true,
    is_test: false,
    is_entry_point: false,
    transitive_loop_depth: 0,
    recursive: false
  };
  const pruned = pruneSnippetPayload(rawSnippet);
  assert.equal(pruned.name, 'CreateOrder');
  assert.equal(pruned.source, 'function CreateOrder() {}');
  assert.equal(pruned.complexity, undefined);
  assert.equal(pruned.loop_count, undefined);
  assert.equal(pruned.transitive_loop_depth, undefined);
  assert.equal(pruned.recursion_in_loop, undefined);
});

test('servidor gRPC executa mapeamento facade em CheckRequest e poda em CheckResponse', async t => {
  const server = await startMcpGuardrailServer(userId => userId === 'user-1' ? scopedAccess : null, '127.0.0.1:0');
  t.after(() => new Promise(resolve => server.tryShutdown(resolve)));
  const protoRoot = path.resolve(import.meta.dirname, '..', 'proto');
  const definition = protoLoader.loadSync(path.join(protoRoot, 'ext_mcp.proto'), {
    includeDirs: [protoRoot],
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true
  });
  const descriptor = grpc.loadPackageDefinition(definition);
  const Client = descriptor.agentgateway.dev.ext_mcp.ExtMcp;
  const client = new Client(`127.0.0.1:${server.boundPort}`, grpc.credentials.createInsecure());
  t.after(() => client.close());

  // Facade CheckRequest mapping: trace_symbol -> trace_path
  const reqResult = await new Promise((resolve, reject) => client.CheckRequest({
    method: 'tools/call',
    metadataContext: { fields: { userId: { stringValue: 'user-1' } } },
    mcpRequest: Buffer.from(JSON.stringify({ name: 'trace_symbol', arguments: { project: 'api-pedidos', symbol: 'HandleOrder' } }))
  }, (error, response) => error ? reject(error) : resolve(response)));

  assert.ok(reqResult.mutated);
  const mutatedRequest = JSON.parse(reqResult.mutated);
  assert.equal(mutatedRequest.name, 'trace_path');
  assert.equal(mutatedRequest.arguments.function_name, 'HandleOrder');
  assert.equal(reqResult.metadata.fields.facadeTool.stringValue, 'trace_symbol');
  assert.equal(reqResult.metadata.fields.toolName.stringValue, 'trace_path');

  // CheckResponse pruning: trace_symbol response
  const rawResponse = {
    content: [{
      type: 'text',
      text: JSON.stringify({
        function: 'HandleOrder',
        callers: [
          { name: 'ApiGateway', file_path: 'src/api.ts' },
          { name: 'TestOrder', file_path: 'tests/order.spec.ts' }
        ]
      })
    }]
  };
  const respResult = await new Promise((resolve, reject) => client.CheckResponse({
    method: 'tools/call',
    metadataContext: {
      fields: {
        userId: { stringValue: 'user-1' },
        toolName: { stringValue: 'trace_path' },
        facadeTool: { stringValue: 'trace_symbol' }
      }
    },
    mcpResponse: Buffer.from(JSON.stringify(rawResponse))
  }, (error, response) => error ? reject(error) : resolve(response)));

  assert.ok(respResult.mutated);
  const mutatedResponse = JSON.parse(respResult.mutated);
  const parsedContent = JSON.parse(mutatedResponse.content[0].text);
  assert.deepEqual(parsedContent.callers.map(c => c.name), ['ApiGateway']);
});

