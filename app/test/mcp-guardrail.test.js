import test from 'node:test';
import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { metricsText } from '../src/observability.js';
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
  FACADE_TOOLS,
  resolveProjectAlias,
  DUPLICATE_RAW_TOOLS,
  sliceCodeSnippet,
  formatSearchResultMarkdown,
  pruneSearchResultPayload,
  clearSemanticCache,
  createMcpGuardrailHandlers,
  semanticCacheKey
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

test('credencial de serviço opcional falha fechado quando habilitada e userId é validado', async () => {
  const handlers = createMcpGuardrailHandlers(() => scopedAccess, { sharedSecret: 's'.repeat(40) });
  const invoke = metadataContext => new Promise((resolve, reject) => handlers.checkRequest({
    request: { method: 'tools/call', metadataContext, mcpRequest: Buffer.from(JSON.stringify({ name: 'search_graph', arguments: { project: 'api-pedidos' } })) }
  }, (error, result) => error ? reject(error) : resolve(result)));
  const missingCredential = await invoke({ userId: 'user-1' });
  assert.equal(missingCredential.error.code, 'PERMISSION_DENIED');
  const malformedIdentity = await invoke({ userId: 'user-1/../system-playground', guardrailCredential: 's'.repeat(40) });
  assert.equal(malformedIdentity.error.code, 'PERMISSION_DENIED');
  const allowed = await invoke({ userId: 'user-1', guardrailCredential: 's'.repeat(40) });
  assert.ok(allowed.pass);
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

test('tools/list mantém ordem estável quando a resposta do backend muda de ordem', () => {
  const first = filterToolsListResult({ tools: [{ name: 'trace_path' }, { name: 'search_graph' }] }, { includeFacade: true, pruneDuplicates: true });
  const second = filterToolsListResult({ tools: [{ name: 'search_graph' }, { name: 'trace_path' }] }, { includeFacade: true, pruneDuplicates: true });
  assert.deepEqual(first.tools.map(tool => tool.name), second.tools.map(tool => tool.name));
  assert.deepEqual(first.tools.map(tool => tool.name), [...first.tools.map(tool => tool.name)].sort());
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
        toolName: { stringValue: 'list_projects' },
        originalTool: { stringValue: 'list_projects' },
        callArgs: { stringValue: '{}' }
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
  const traceWithTests = mapFacadeRequest({ name: 'trace_symbol', arguments: { project: 'api-pedidos', symbol: 'CriarPedido', include_tests: true } });
  assert.equal(traceWithTests.params.arguments.include_tests, true);

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
        facadeTool: { stringValue: 'trace_symbol' },
        originalTool: { stringValue: 'trace_symbol' },
        callArgs: { stringValue: JSON.stringify({ project: 'api-pedidos', symbol: 'HandleOrder' }) }
      }
    },
    mcpResponse: Buffer.from(JSON.stringify(rawResponse))
  }, (error, response) => error ? reject(error) : resolve(response)));

  assert.ok(respResult.mutated);
  const mutatedResponse = JSON.parse(respResult.mutated);
  const parsedContent = JSON.parse(mutatedResponse.content[0].text);
  assert.deepEqual(parsedContent.callers.map(c => c.name), ['ApiGateway']);
});

test('resolveProjectAlias resolve apelidos e nomes curtos para o ID canônico', () => {
  const known = new Set([
    'data-repositories-claps-clapsapi-gestor',
    'data-repositories-claps-clapsapi-autorizador',
    'data-repositories-pagueon-pagueonapi-recorrente',
    'data-repositories-pagueon-front-pagueon-front'
  ]);

  // Correspondência exata
  assert.equal(resolveProjectAlias('data-repositories-claps-clapsapi-gestor', known), 'data-repositories-claps-clapsapi-gestor');

  // Case-insensitive
  assert.equal(resolveProjectAlias('DATA-REPOSITORIES-CLAPS-CLAPSAPI-GESTOR', known), 'data-repositories-claps-clapsapi-gestor');

  // Nome curto com sufixo
  assert.equal(resolveProjectAlias('clapsapi-gestor', known), 'data-repositories-claps-clapsapi-gestor');
  assert.equal(resolveProjectAlias('pagueonapi-recorrente', known), 'data-repositories-pagueon-pagueonapi-recorrente');

  // Notação com barra
  assert.equal(resolveProjectAlias('claps/clapsapi-gestor', known), 'data-repositories-claps-clapsapi-gestor');
  assert.equal(resolveProjectAlias('pagueon/front', known), 'data-repositories-pagueon-front-pagueon-front');

  // Inexistente
  assert.equal(resolveProjectAlias('projeto-desconhecido', known), null);
  assert.equal(resolveProjectAlias('', known), null);
  assert.equal(resolveProjectAlias(null, known), null);
});

test('filterToolsListResult com pruneDuplicates expõe apenas facade e ferramentas essenciais', () => {
  const allTools = {
    tools: [
      { name: 'search_graph' },
      { name: 'search_code' },
      { name: 'trace_path' },
      { name: 'get_code_snippet' },
      { name: 'get_graph_schema' },
      { name: 'detect_changes' },
      { name: 'query_graph' },
      { name: 'get_architecture' },
      { name: 'list_projects' },
      { name: 'index_status' }
    ]
  };

  const pruned = filterToolsListResult(allTools, { includeFacade: true, pruneDuplicates: true });
  const names = pruned.tools.map(t => t.name);

  // Deve conter as ferramentas facade
  assert.ok(names.includes('code_search_surgical'));
  assert.ok(names.includes('trace_symbol'));
  assert.ok(names.includes('get_symbol_snippet'));

  // Deve conter as essenciais
  assert.ok(names.includes('get_architecture'));
  assert.ok(names.includes('list_projects'));
  assert.ok(names.includes('index_status'));

  // NÃO deve conter as duplicadas brutas
  for (const raw of DUPLICATE_RAW_TOOLS) {
    assert.equal(names.includes(raw), false, `Ferramenta bruta duplicada ${raw} deveria ter sido podada`);
  }
});

test('authorizeToolCall resolve apelido de projeto e autoriza com sucesso', () => {
  const accessWithAliases = {
    system: false,
    allowedProjects: new Set(['data-repositories-claps-clapsapi-gestor']),
    knownProjects: new Set([
      'data-repositories-claps-clapsapi-gestor',
      'data-repositories-pagueon-pagueonapi-recorrente'
    ])
  };

  const res = authorizeToolCall({
    name: 'code_search_surgical',
    arguments: { project: 'clapsapi-gestor', query: 'Processar' }
  }, accessWithAliases);

  assert.equal(res.allowed, true);
  assert.equal(res.resolvedProject, 'data-repositories-claps-clapsapi-gestor');

  // Projeto não autorizado
  const deniedRes = authorizeToolCall({
    name: 'code_search_surgical',
    arguments: { project: 'pagueonapi-recorrente', query: 'Processar' }
  }, accessWithAliases);
  assert.equal(deniedRes.allowed, false);
  assert.match(deniedRes.reason, /não possui acesso/);
});

test('guardrail rejeita aliases ambíguos sem escolher um projeto arbitrariamente', () => {
  const access = {
    system: false,
    allowedProjects: new Set([
      'data-repositories-claps-api-pedidos',
      'data-repositories-pagueon-api-pedidos'
    ]),
    knownProjects: new Set([
      'data-repositories-claps-api-pedidos',
      'data-repositories-pagueon-api-pedidos'
    ])
  };

  const result = authorizeToolCall({
    name: 'search_graph',
    arguments: { project: 'api-pedidos', query: 'CriarPedido' }
  }, access);

  assert.equal(result.allowed, false);
  assert.match(result.reason, /ambíguo/);
});

test('servidor gRPC resolve apelido em CheckRequest e muta project para canônico', async t => {
  const aliasAccess = {
    system: false,
    allowedProjects: new Set(['data-repositories-claps-clapsapi-gestor']),
    knownProjects: new Set(['data-repositories-claps-clapsapi-gestor'])
  };

  const server = await startMcpGuardrailServer(userId => userId === 'user-alias' ? aliasAccess : null, '127.0.0.1:0');
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

  const reqResult = await new Promise((resolve, reject) => client.CheckRequest({
    method: 'tools/call',
    metadataContext: { fields: { userId: { stringValue: 'user-alias' } } },
    mcpRequest: Buffer.from(JSON.stringify({
      name: 'code_search_surgical',
      arguments: { project: 'claps/clapsapi-gestor', query: 'ProcessarContrato' }
    }))
  }, (error, response) => error ? reject(error) : resolve(response)));

  assert.ok(reqResult.mutated);
  const mutated = JSON.parse(reqResult.mutated);
  assert.equal(mutated.name, 'search_graph');
  assert.equal(mutated.arguments.project, 'data-repositories-claps-clapsapi-gestor');
  assert.equal(mutated.arguments.query, 'ProcessarContrato');
  assert.equal(reqResult.metadata.fields.resolvedProject.stringValue, 'data-repositories-claps-clapsapi-gestor');
});

test('poda semântica de snippet remove headers de licença e linhas em branco repetidas', () => {
  const codeWithLicense = `/*
 * Copyright (c) 2024 Acme Corp. All rights reserved.
 * Licensed under the Apache License 2.0.
 */

function calcularTotal(items) {


  const total = items.reduce((a, b) => a + b, 0);   

  return total;
}`;
  const sliced = sliceCodeSnippet(codeWithLicense);
  assert.ok(!sliced.includes('Copyright'));
  assert.ok(!sliced.includes('Apache'));
  assert.ok(!sliced.includes('\n\n\n'));
  assert.ok(sliced.startsWith('function calcularTotal(items)'));
});

test('busca facade não infere label para identificadores que podem ser métodos', () => {
  const classReq = mapFacadeRequest({
    name: 'code_search_surgical',
    arguments: { project: 'api-pedidos', query: 'OrderManager' }
  });
  assert.equal(classReq.params.arguments.label, undefined);

  const funcReq = mapFacadeRequest({
    name: 'code_search_surgical',
    arguments: { project: 'api-pedidos', query: 'processPayment' }
  });
  assert.equal(funcReq.params.arguments.label, undefined);

  const snakeReq = mapFacadeRequest({
    name: 'code_search_surgical',
    arguments: { project: 'api-pedidos', query: 'handle_webhook' }
  });
  assert.equal(snakeReq.params.arguments.label, undefined);

  // Query curta ou genérica aplica limite adaptativo mais restritivo (15 nós)
  const shortReq = mapFacadeRequest({
    name: 'code_search_surgical',
    arguments: { project: 'api-pedidos', query: 'app' }
  });
  assert.equal(shortReq.params.arguments.limit, 15);
});

test('chave de cache canônica inclui todos os argumentos, escopo e evidência', () => {
  const accessA = { allowedProjects: new Set(['api-pedidos']) };
  const accessB = { allowedProjects: new Set(['api-financeiro']) };
  const args = { project: 'api-pedidos', query: 'CriarPedido', limit: 30, offset: 0, filters: { language: 'csharp' } };
  const evidence = { project: 'api-pedidos', status: 'fresh', indexedCommit: 'abc' };

  const original = semanticCacheKey('search_graph', args, accessA, evidence);
  assert.equal(original, semanticCacheKey('search_graph', { filters: { language: 'csharp' }, offset: 0, limit: 30, query: 'CriarPedido', project: 'api-pedidos' }, accessA, evidence));
  assert.notEqual(original, semanticCacheKey('search_graph', { ...args, offset: 1 }, accessA, evidence));
  assert.notEqual(original, semanticCacheKey('search_graph', args, accessB, evidence));
  assert.notEqual(original, semanticCacheKey('search_graph', args, accessA, { ...evidence, indexedCommit: 'def' }));
});

test('CheckResponse reautoriza a chamada e anexa evidência de índice sem alterar o conteúdo JSON', async () => {
  const activeAccess = {
    system: false,
    allowedProjects: new Set(['api-pedidos']),
    knownProjects: new Set(['api-pedidos']),
    projectEvidence: new Map([['api-pedidos', { status: 'fresh', indexedCommit: 'abc123', indexedAt: '2026-09-28T12:00:00.000Z' }]])
  };
  const handlers = createMcpGuardrailHandlers(userId => userId === 'active' ? activeAccess : {
    system: false,
    allowedProjects: new Set(),
    knownProjects: new Set(['api-pedidos'])
  });
  const response = {
    content: [{ type: 'text', text: JSON.stringify({ search_mode: 'bm25', results: [{ name: 'CriarPedido', label: 'Method' }] }) }],
    structuredContent: { search_mode: 'bm25', results: [{ name: 'CriarPedido', label: 'Method' }] }
  };
  const request = {
    method: 'tools/call',
    metadataContext: {
      userId: 'active',
      toolName: 'search_graph',
      originalTool: 'code_search_surgical',
      resolvedProject: 'api-pedidos',
      callArgs: JSON.stringify({ project: 'api-pedidos', query: 'CriarPedido', offset: 0 })
    },
    mcpResponse: Buffer.from(JSON.stringify(response))
  };
  const result = await new Promise((resolve, reject) => handlers.checkResponse({ request }, (error, value) => error ? reject(error) : resolve(value)));
  const payload = JSON.parse(result.mutated);

  assert.deepEqual(JSON.parse(payload.content[0].text).results.map(item => item.name), ['CriarPedido']);
  assert.deepEqual(payload._meta['codebase-memory/evidence'], {
    project: 'api-pedidos', status: 'fresh', indexedCommit: 'abc123', indexedAt: '2026-09-28T12:00:00.000Z'
  });

  const revoked = await new Promise((resolve, reject) => handlers.checkResponse({
    request: { ...request, metadataContext: { ...request.metadataContext, userId: 'revoked' } }
  }, (error, value) => error ? reject(error) : resolve(value)));
  assert.equal(revoked.error.code, 'PERMISSION_DENIED');
});

test('CheckResponse falha fechado sem metadados e alinha resposta textual com resultados seletivos', async () => {
  const access = { system: false, allowedProjects: new Set(['api-pedidos']), knownProjects: new Set(['api-pedidos']) };
  const handlers = createMcpGuardrailHandlers(() => access);
  const denied = await new Promise((resolve, reject) => handlers.checkResponse({
    request: { method: 'tools/call', metadataContext: { userId: 'user-1' }, mcpResponse: Buffer.from('{}') }
  }, (error, value) => error ? reject(error) : resolve(value)));
  assert.equal(denied.error.code, 'PERMISSION_DENIED');

  const response = {
    structuredContent: {
      search_mode: 'bm25',
      results: [
        { name: 'ProductionResult', file_path: 'src/orders.js' },
        { name: 'TestResult', file_path: 'tests/orders.test.js' }
      ]
    },
    content: [{ type: 'text', text: 'unstructured backend output' }]
  };
  const result = await new Promise((resolve, reject) => handlers.checkResponse({
    request: {
      method: 'tools/call',
      metadataContext: {
        userId: 'user-1', toolName: 'search_graph', facadeTool: 'code_search_surgical',
        originalTool: 'code_search_surgical', resolvedProject: 'api-pedidos',
        callArgs: JSON.stringify({ project: 'api-pedidos', query: 'Order' }), includeTests: 'false'
      },
      mcpResponse: Buffer.from(JSON.stringify(response))
    }
  }, (error, value) => error ? reject(error) : resolve(value)));
  const payload = JSON.parse(result.mutated);
  assert.deepEqual(payload.structuredContent.results.map(item => item.name), ['ProductionResult']);
  assert.equal(payload.content[0].text, JSON.stringify(payload.structuredContent));

  const withTests = await new Promise((resolve, reject) => handlers.checkResponse({
    request: {
      method: 'tools/call',
      metadataContext: {
        userId: 'user-1', toolName: 'search_graph', facadeTool: 'code_search_surgical',
        originalTool: 'code_search_surgical', resolvedProject: 'api-pedidos',
        callArgs: JSON.stringify({ project: 'api-pedidos', query: 'Order' }), includeTests: 'true'
      },
      mcpResponse: Buffer.from(JSON.stringify(response))
    }
  }, (error, value) => error ? reject(error) : resolve(value)));
  assert.deepEqual(JSON.parse(withTests.mutated).structuredContent.results.map(item => item.name), ['ProductionResult', 'TestResult']);
});

test('busca em texto não estruturado falha fechado quando não pode filtrar arquivos de teste', async () => {
  const access = { system: false, allowedProjects: new Set(['api-pedidos']), knownProjects: new Set(['api-pedidos']) };
  const handlers = createMcpGuardrailHandlers(() => access);
  const metadataContext = {
    userId: 'user-1', toolName: 'search_graph', facadeTool: 'code_search_surgical',
    originalTool: 'code_search_surgical', resolvedProject: 'api-pedidos',
    callArgs: JSON.stringify({ project: 'api-pedidos', query: 'Order' }), includeTests: 'false'
  };
  const run = includeTests => new Promise((resolve, reject) => handlers.checkResponse({
    request: {
      method: 'tools/call',
      metadataContext: { ...metadataContext, includeTests },
      mcpResponse: Buffer.from(JSON.stringify({ content: [{ type: 'text', text: 'src/orders.js\ntests/orders.test.js' }] }))
    }
  }, (error, value) => error ? reject(error) : resolve(value)));

  const filtered = JSON.parse((await run('false')).mutated);
  assert.equal(filtered.isError, true);
  assert.match(filtered.content[0].text, /não retornou resultados estruturados/);

  const explicitlyIncluded = JSON.parse((await run('true')).mutated);
  assert.equal(explicitlyIncluded.isError, undefined);
  assert.equal(explicitlyIncluded.content[0].text, 'src/orders.js\ntests/orders.test.js');
});

test('busca mista substitui texto original pela representação estruturada filtrada', async () => {
  const access = { system: false, allowedProjects: new Set(['api-pedidos']), knownProjects: new Set(['api-pedidos']) };
  const handlers = createMcpGuardrailHandlers(() => access);
  const result = await new Promise((resolve, reject) => handlers.checkResponse({
    request: {
      method: 'tools/call',
      metadataContext: {
        userId: 'user-1', toolName: 'search_graph', facadeTool: 'code_search_surgical',
        originalTool: 'code_search_surgical', resolvedProject: 'api-pedidos',
        callArgs: JSON.stringify({ project: 'api-pedidos', query: 'Order' }), includeTests: 'false'
      },
      mcpResponse: Buffer.from(JSON.stringify({
        results: [{ name: 'ProductionResult', file_path: 'src/orders.js' }, { name: 'TestResult', file_path: 'tests/orders.test.js' }],
        content: [{ type: 'text', text: 'raw mixed output includes tests/orders.test.js' }]
      }))
    }
  }, (error, value) => error ? reject(error) : resolve(value)));
  const payload = JSON.parse(result.mutated);
  assert.deepEqual(payload.results.map(item => item.name), ['ProductionResult']);
  assert.equal(payload.content[0].text.includes('tests/orders.test.js'), false);
  assert.deepEqual(JSON.parse(payload.content[0].text).results.map(item => item.name), ['ProductionResult']);
});

test('busca filtra coleções equivalentes no structuredContent e no nível superior', async () => {
  const access = { system: false, allowedProjects: new Set(['api-pedidos']), knownProjects: new Set(['api-pedidos']) };
  const handlers = createMcpGuardrailHandlers(() => access);
  const result = await new Promise((resolve, reject) => handlers.checkResponse({
    request: {
      method: 'tools/call',
      metadataContext: {
        userId: 'user-1', toolName: 'search_graph', facadeTool: 'code_search_surgical',
        originalTool: 'code_search_surgical', resolvedProject: 'api-pedidos',
        callArgs: JSON.stringify({ project: 'api-pedidos', query: 'Order' }), includeTests: 'false'
      },
      mcpResponse: Buffer.from(JSON.stringify({
        results: [{ name: 'TestTopLevel', file_path: 'tests/top.test.js' }],
        structuredContent: { results: [{ name: 'TestStructured', file_path: 'tests/structured.test.js' }] }
      }))
    }
  }, (error, value) => error ? reject(error) : resolve(value)));
  const payload = JSON.parse(result.mutated);
  assert.deepEqual(payload.results, []);
  assert.deepEqual(payload.structuredContent.results, []);
});

test('trace em texto não estruturado falha fechado quando não pode filtrar referências a testes', async () => {
  const access = { system: false, allowedProjects: new Set(['api-pedidos']), knownProjects: new Set(['api-pedidos']) };
  const handlers = createMcpGuardrailHandlers(() => access);
  const result = await new Promise((resolve, reject) => handlers.checkResponse({
    request: {
      method: 'tools/call',
      metadataContext: {
        userId: 'user-1', toolName: 'trace_symbol', originalTool: 'trace_symbol',
        resolvedProject: 'api-pedidos', callArgs: JSON.stringify({ project: 'api-pedidos', symbol: 'Order' }), includeTests: 'false'
      },
      mcpResponse: Buffer.from(JSON.stringify({ content: [{ type: 'text', text: 'tests/orders.test.js -> src/orders.js' }] }))
    }
  }, (error, value) => error ? reject(error) : resolve(value)));
  const payload = JSON.parse(result.mutated);
  assert.equal(payload.isError, true);
  assert.match(payload.content[0].text, /Rastreamento bloqueado/);
});

test('trace misto filtra coleções top-level e substitui texto original', async () => {
  const access = { system: false, allowedProjects: new Set(['api-pedidos']), knownProjects: new Set(['api-pedidos']) };
  const handlers = createMcpGuardrailHandlers(() => access);
  const result = await new Promise((resolve, reject) => handlers.checkResponse({
    request: {
      method: 'tools/call',
      metadataContext: {
        userId: 'user-1', toolName: 'trace_symbol', originalTool: 'trace_symbol',
        resolvedProject: 'api-pedidos', callArgs: JSON.stringify({ project: 'api-pedidos', symbol: 'Order' }), includeTests: 'false'
      },
      mcpResponse: Buffer.from(JSON.stringify({
        paths: [{ file_path: 'src/orders.js' }, { file_path: 'tests/orders.test.js' }],
        content: [{ type: 'text', text: 'raw mixed trace includes tests/orders.test.js' }]
      }))
    }
  }, (error, value) => error ? reject(error) : resolve(value)));
  const payload = JSON.parse(result.mutated);
  assert.deepEqual(payload.paths.map(item => item.file_path), ['src/orders.js']);
  assert.equal(payload.content[0].text.includes('tests/orders.test.js'), false);
  assert.deepEqual(JSON.parse(payload.content[0].text).paths.map(item => item.file_path), ['src/orders.js']);
});

test('trace filtra coleções equivalentes no structuredContent e no nível superior', async () => {
  const access = { system: false, allowedProjects: new Set(['api-pedidos']), knownProjects: new Set(['api-pedidos']) };
  const handlers = createMcpGuardrailHandlers(() => access);
  const result = await new Promise((resolve, reject) => handlers.checkResponse({
    request: {
      method: 'tools/call',
      metadataContext: {
        userId: 'user-1', toolName: 'trace_symbol', originalTool: 'trace_symbol',
        resolvedProject: 'api-pedidos', callArgs: JSON.stringify({ project: 'api-pedidos', symbol: 'Order' }), includeTests: 'false'
      },
      mcpResponse: Buffer.from(JSON.stringify({
        paths: [{ file_path: 'tests/top.test.js' }],
        structuredContent: { paths: [{ file_path: 'tests/structured.test.js' }] }
      }))
    }
  }, (error, value) => error ? reject(error) : resolve(value)));
  const payload = JSON.parse(result.mutated);
  assert.deepEqual(payload.paths, []);
  assert.deepEqual(payload.structuredContent.paths, []);
});

test('cache local registra hits após revalidar chamada e resposta do backend', async () => {
  clearSemanticCache();
  const handlers = createMcpGuardrailHandlers(() => scopedAccess);
  const request = {
    method: 'tools/call',
    metadataContext: {
      userId: 'user-1', toolName: 'search_graph', facadeTool: 'code_search_surgical',
      originalTool: 'code_search_surgical', resolvedProject: 'api-pedidos',
      callArgs: JSON.stringify({ project: 'api-pedidos', query: 'Order' })
    },
    mcpResponse: Buffer.from(JSON.stringify({ structuredContent: { search_mode: 'bm25', results: [{ name: 'OrderHandler', file_path: 'src/orders.js' }] } }))
  };
  const invoke = () => new Promise((resolve, reject) => handlers.checkResponse({ request }, (error, value) => error ? reject(error) : resolve(value)));
  const before = metricsText();
  await invoke();
  const first = metricsText();
  await invoke();
  const second = metricsText();
  const metricValue = output => Number(output.match(/mcp_guardrail_cache_events_total\{cache="semantic",result="hit"\} (\d+)/)?.[1] || 0);
  assert.ok(metricValue(second) > metricValue(first));
  assert.ok(metricValue(first) >= metricValue(before));
});

test('retrieval opt-in preserva argumentos aceitos pelo backend e diversifica a resposta', async () => {
  const access = {
    system: false,
    allowedProjects: new Set(['api-pedidos']),
    knownProjects: new Set(['api-pedidos']),
    projectEvidence: new Map([['api-pedidos', { status: 'fresh', indexedCommit: 'abc123' }]])
  };
  const handlers = createMcpGuardrailHandlers(() => access);
  const requestParams = {
    name: 'code_search_surgical',
    arguments: {
      project: 'api-pedidos', query: 'CriarPedido', retrieval_mode: 'fast', diversity_per_path: 2
    }
  };
  const checkedRequest = await new Promise((resolve, reject) => handlers.checkRequest({
    request: { method: 'tools/call', metadataContext: { userId: 'user-1' }, mcpRequest: Buffer.from(JSON.stringify(requestParams)) }
  }, (error, value) => error ? reject(error) : resolve(value)));
  const forwarded = JSON.parse(checkedRequest.mutated);
  assert.equal(forwarded.name, 'search_graph');
  assert.equal(forwarded.arguments.retrieval_mode, undefined);
  assert.equal(forwarded.arguments.diversity_per_path, undefined);
  assert.equal(checkedRequest.metadata.fields.retrievalMode.stringValue, 'fast');

  const response = {
    structuredContent: {
      search_mode: 'bm25',
      results: [
        { name: 'TopRanked', label: 'Method', file_path: 'src/orders.cs', start_line: 10, rank: -50 },
        { name: 'SecondRanked', label: 'Method', file_path: 'src/orders.cs', start_line: 20, rank: -40 },
        { name: 'ThirdRanked', label: 'Method', file_path: 'src/orders.cs', start_line: 30, rank: -30 }
      ]
    }
  };
  const checkedResponse = await new Promise((resolve, reject) => handlers.checkResponse({
    request: {
      method: 'tools/call',
      metadataContext: {
        userId: 'user-1', toolName: 'search_graph', facadeTool: 'code_search_surgical', originalTool: 'code_search_surgical',
        resolvedProject: 'api-pedidos', callArgs: JSON.stringify(forwarded.arguments), retrievalMode: 'fast', diversityPerPath: '2'
      },
      mcpResponse: Buffer.from(JSON.stringify(response))
    }
  }, (error, value) => error ? reject(error) : resolve(value)));
  const payload = JSON.parse(checkedResponse.mutated);
  assert.equal(payload.structuredContent.retrieval_policy.mode, 'fast');
  assert.equal(payload.structuredContent.results.length, 2);
  assert.deepEqual(payload.structuredContent.results.map(item => item.name), ['TopRanked', 'SecondRanked']);
  assert.deepEqual(payload.structuredContent.results.map(item => item.provenance.path), ['src/orders.cs', 'src/orders.cs']);
  assert.notEqual(payload.structuredContent.results[0].provenance.chunkId, payload.structuredContent.results[1].provenance.chunkId);
  assert.ok(payload.structuredContent.results.every(item => item.provenance.indexedCommit === 'abc123'));
});

test('formatSearchResultMarkdown formata lista de itens em tabela Markdown', () => {
  const items = [
    { name: 'processarPedido', label: 'Function', file_path: 'src/order.ts', start_line: 45 },
    { name: 'Pedido', label: 'Class', file_path: 'src/types.ts', start_line: 12 }
  ];
  const md = formatSearchResultMarkdown(items);
  assert.ok(md.includes('| Símbolo | Tipo | Arquivo | Linha |'));
  assert.ok(md.includes('`processarPedido`'));
  assert.ok(md.includes('`Pedido`'));
  assert.ok(md.includes('src/order.ts'));
});

test('clearSemanticCache esvazia o cache sem lançar exceções', () => {
  assert.doesNotThrow(() => clearSemanticCache());
});

test('mapeamento de inspect_symbol para get_code_snippet com include_neighbors', () => {
  const req = mapFacadeRequest({
    name: 'inspect_symbol',
    arguments: { project: 'api-pedidos', symbol: 'ProcessarPedido' }
  });
  assert.equal(req.mapped, true);
  assert.equal(req.backendTool, 'get_code_snippet');
  assert.equal(req.facadeTool, 'inspect_symbol');
  assert.equal(req.params.arguments.qualified_name, 'ProcessarPedido');
  assert.equal(req.params.arguments.include_neighbors, true);
});

test('pruneSearchResultPayload remove rank e campos inúteis de AST de buscas', () => {
  const rawSearch = {
    total: 1,
    search_mode: 'bm25',
    results: [
      {
        name: 'Contrato',
        qualified_name: 'Claps.Contrato',
        label: 'Class',
        file_path: 'Contrato.cs',
        start_line: 10,
        end_line: 50,
        rank: -10.5,
        complexity: 12,
        cognitive: 8,
        lines: 40
      }
    ]
  };
  const pruned = pruneSearchResultPayload(rawSearch);
  assert.equal(pruned.results[0].name, 'Contrato');
  assert.equal(pruned.results[0].rank, undefined);
  assert.equal(pruned.results[0].complexity, undefined);
  assert.equal(pruned.results[0].cognitive, undefined);
  assert.equal(pruned.results[0].lines, undefined);
  assert.equal(pruned.results[0].start_line, 10);
});
