import test from 'node:test';
import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function availablePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitFor(url) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error(`Servidor não ficou disponível: ${url}`);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(request.adminCookie ? { cookie: request.adminCookie } : {}), ...options.headers }
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

function guardrailClient(port) {
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
  return new descriptor.agentgateway.dev.ext_mcp.ExtMcp(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}

function checkTool(client, userId, name, args) {
  return new Promise((resolve, reject) => client.CheckRequest({
    method: 'tools/call',
    metadataContext: { fields: { userId: { stringValue: userId } } },
    mcpRequest: Buffer.from(JSON.stringify({ name, arguments: args }))
  }, (error, response) => error ? reject(error) : resolve(response)));
}

test('API cria, revoga, reativa e exclui usuários no AgentGateway', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cbm-mcp-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let gatewayConfig = {
    config: { adminAddr: '0.0.0.0:15000' },
    mcp: {
      port: 8080,
      policies: { cors: { allowOrigins: ['*'] } },
      targets: [{ name: 'codebase-memory', stdio: { cmd: '/bin/example' } }]
    }
  };
  const gateway = http.createServer(async (req, res) => {
    if (req.url !== '/api/config') { res.writeHead(404).end(); return; }
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      gatewayConfig = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"success"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(gatewayConfig));
  });
  const gatewayPort = await listen(gateway);
  t.after(() => close(gateway));

  const appPort = await availablePort();
  const guardrailPort = await availablePort();
  const appDataDirectory = path.join(directory, 'data');
  await mkdir(path.join(appDataDirectory, 'secrets'), { recursive: true });
  await writeFile(path.join(appDataDirectory, 'secrets', 'admin-jwt-secret'), `${'a'.repeat(64)}\n`);
  await writeFile(path.join(appDataDirectory, 'state.json'), JSON.stringify({
    workspaces: [{
      id: 'plataforma',
      name: 'Plataforma',
      updateSchedule: { enabled: false, cron: '0 * * * *', timezone: 'America/Maceio', lastRunAt: null, lastRunStatus: null },
      repositorySourceApprovals: [
        { status: 'approved', workspaceId: 'plataforma', githubRepositoryId: '101', approvedBy: 'admin@empresa.test', approvedAt: '2026-01-01T00:00:00.000Z' },
        { status: 'approved', workspaceId: 'plataforma', githubRepositoryId: '102', approvedBy: 'admin@empresa.test', approvedAt: '2026-01-01T00:00:00.000Z' }
      ],
      createdAt: '2026-01-01T00:00:00.000Z'
    }],
    repositories: [
      {
        id: 'api',
        accessId: 'repository-access-1',
        workspaceId: 'plataforma',
        githubRepositoryId: '101',
        sourceApproval: { status: 'approved', workspaceId: 'plataforma', githubRepositoryId: '101', approvedBy: 'admin@empresa.test', approvedAt: '2026-01-01T00:00:00.000Z' },
        name: 'api',
        fullName: 'empresa/api',
        path: path.join(directory, 'repositories', 'plataforma', 'api'),
        project: 'plataforma-api',
        status: 'indexed'
      },
      {
        id: 'worker',
        accessId: 'repository-access-2',
        workspaceId: 'plataforma',
        githubRepositoryId: '102',
        sourceApproval: { status: 'approved', workspaceId: 'plataforma', githubRepositoryId: '102', approvedBy: 'admin@empresa.test', approvedAt: '2026-01-01T00:00:00.000Z' },
        name: 'worker',
        fullName: 'empresa/worker',
        path: path.join(directory, 'repositories', 'plataforma', 'worker'),
        project: 'plataforma-worker',
        status: 'indexed'
      }
    ]
  }));
  const jobHistoryNow = Date.now();
  const recentJobs = Array.from({ length: 23 }, (_, index) => ({
    id: `job-${index + 1}`,
    type: 'index',
    label: `Operação ${index + 1}`,
    status: 'completed',
    progress: 100,
    log: `log ${index + 1}`,
    createdAt: new Date(jobHistoryNow - index * 60_000).toISOString(),
    finishedAt: new Date(jobHistoryNow - index * 60_000 + 1_000).toISOString()
  }));
  await writeFile(path.join(appDataDirectory, 'jobs.json'), JSON.stringify({
    version: 1,
    jobs: [
      { id: 'job-running', type: 'sync', label: 'Operação em andamento', status: 'running', progress: 40, log: 'executando', createdAt: new Date(jobHistoryNow).toISOString() },
      ...recentJobs,
      { id: 'job-expired', type: 'index', label: 'Operação expirada', status: 'failed', progress: 10, log: 'antigo', createdAt: new Date(jobHistoryNow - 8 * 86_400_000).toISOString(), finishedAt: new Date(jobHistoryNow - 8 * 86_400_000).toISOString() }
    ]
  }));
  const app = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(appPort),
      UI_PORT: '8080',
      ADMIN_AUTH_USERNAME: 'admin@example.com',
      ADMIN_AUTH_PASSWORD: 'senha-segura',
      APP_DATA_DIR: appDataDirectory,
      CBM_ALLOWED_ROOT: path.join(directory, 'repositories'),
      AGENTGATEWAY_ADMIN_URL: `http://127.0.0.1:${gatewayPort}`,
      MCP_GUARDRAIL_ADDR: `127.0.0.1:${guardrailPort}`,
      MCP_GUARDRAIL_HOST: `admin:${guardrailPort}`,
      CBM_PROJECT_RECONCILE: 'false'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  app.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (app.exitCode === null) {
      app.kill('SIGTERM');
      await once(app, 'exit');
    }
  });
  await waitFor(`http://127.0.0.1:${appPort}/api/health`);
  const unauthorizedApi = await fetch(`http://127.0.0.1:${appPort}/api/workspaces`);
  assert.equal(unauthorizedApi.status, 401);
  const unauthorizedPage = await fetch(`http://127.0.0.1:${appPort}/`, { redirect: 'manual' });
  assert.equal(unauthorizedPage.status, 302);
  assert.equal(unauthorizedPage.headers.get('location'), '/login');
  const rejectedLogin = await fetch(`http://127.0.0.1:${appPort}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin@example.com', password: 'incorreta' })
  });
  assert.equal(rejectedLogin.status, 401);
  const login = await fetch(`http://127.0.0.1:${appPort}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin@example.com', password: 'senha-segura' })
  });
  assert.equal(login.status, 200);
  request.adminCookie = login.headers.get('set-cookie').split(';')[0];
  t.after(() => { request.adminCookie = ''; });
  const firstJobsPage = await request(`http://127.0.0.1:${appPort}/api/jobs?page=1&pageSize=10`);
  assert.equal(firstJobsPage.jobs.length, 10);
  assert.deepEqual(firstJobsPage.pagination, { page: 1, pageSize: 10, total: 24, totalPages: 3 });
  assert.equal(firstJobsPage.jobs[0].id, 'job-running');
  assert.equal(firstJobsPage.jobs[0].status, 'interrupted');
  assert.equal(firstJobsPage.activeCount, 0);
  assert.equal(firstJobsPage.retentionDays, 7);
  const lastJobsPage = await request(`http://127.0.0.1:${appPort}/api/jobs?page=3&pageSize=10`);
  assert.equal(lastJobsPage.jobs.length, 4);
  const persistedJobs = JSON.parse(await readFile(path.join(appDataDirectory, 'jobs.json'), 'utf8')).jobs;
  assert.equal(persistedJobs.some(job => job.id === 'job-expired'), false);
  assert.equal(persistedJobs.find(job => job.id === 'job-running').status, 'interrupted');
  const guardrail = guardrailClient(guardrailPort);
  t.after(() => guardrail.close());

  assert.equal(gatewayConfig.mcp.policies.apiKey.mode, 'strict');
  assert.equal(gatewayConfig.mcp.policies.apiKey.keys.length, 2);
  assert.ok(gatewayConfig.mcp.policies.apiKey.keys.some(item => item.metadata.userId === 'system-playground'));
  assert.ok(gatewayConfig.mcp.policies.apiKey.keys.some(item => item.metadata.userId === 'workspace:plataforma'));
  assert.equal(gatewayConfig.mcp.policies.mcpGuardrails.processors[0].host, `admin:${guardrailPort}`);
  const schedule = await request(`http://127.0.0.1:${appPort}/api/workspaces/plataforma/schedule`);
  assert.equal(schedule.schedule.cron, '0 * * * *');
  assert.equal(schedule.schedule.description, 'Atualiza a cada hora');
  assert.equal(schedule.schedule.enabled, false);
  assert.equal(schedule.concurrency, 3);
  const updatedSchedule = await request(`http://127.0.0.1:${appPort}/api/workspaces/plataforma/schedule`, {
    method: 'PUT',
    body: JSON.stringify({ cron: '*/15 * * * *', timezone: 'UTC', enabled: false })
  });
  assert.equal(updatedSchedule.schedule.cron, '*/15 * * * *');
  assert.equal(updatedSchedule.schedule.timezone, 'UTC');
  const system = await request(`http://127.0.0.1:${appPort}/api/mcp-system-token/reveal`, { method: 'POST' });
  assert.equal(system.token, gatewayConfig.mcp.policies.apiKey.keys.find(item => item.metadata.userId === 'system-playground').key);
  const workspaceToken = await request(`http://127.0.0.1:${appPort}/api/workspaces/plataforma/mcp-token/reveal`, { method: 'POST' });
  assert.equal(workspaceToken.token, gatewayConfig.mcp.policies.apiKey.keys.find(item => item.metadata.userId === 'workspace:plataforma').key);
  const persistedState = await readFile(path.join(appDataDirectory, 'state.json'), 'utf8');
  assert.equal(persistedState.includes(workspaceToken.token), false);
  assert.match(persistedState, /"algorithm": "aes-256-gcm"/);
  const workspaceApi = await checkTool(guardrail, 'workspace:plataforma', 'search_graph', { project: 'plataforma-api' });
  const workspaceWorker = await checkTool(guardrail, 'workspace:plataforma', 'search_graph', { project: 'plataforma-worker' });
  assert.ok(workspaceApi.pass);
  assert.ok(workspaceWorker.pass);
  const workspaceData = await request(`http://127.0.0.1:${appPort}/api/workspaces/plataforma`);
  assert.equal('mcpCredential' in workspaceData.workspace, false);
  assert.equal(workspaceData.workspace.mcpAccess.status, 'active');
  const createdWorkspace = await request(`http://127.0.0.1:${appPort}/api/workspaces`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Financeiro', description: 'Serviços financeiros' })
  });
  assert.match(createdWorkspace.token, /^cbm_mcp_/);
  assert.equal(createdWorkspace.workspace.mcpAccess.status, 'active');
  assert.equal(gatewayConfig.mcp.policies.apiKey.keys.find(item => item.metadata.userId === 'workspace:financeiro').key, createdWorkspace.token);
  const rotatedWorkspace = await request(`http://127.0.0.1:${appPort}/api/workspaces/financeiro/mcp-token/rotate`, { method: 'POST' });
  assert.notEqual(rotatedWorkspace.token, createdWorkspace.token);
  await request(`http://127.0.0.1:${appPort}/api/workspaces/financeiro/mcp-token/revoke`, { method: 'POST' });
  assert.equal(gatewayConfig.mcp.policies.apiKey.keys.some(item => item.metadata.userId === 'workspace:financeiro'), false);
  const reactivatedWorkspace = await request(`http://127.0.0.1:${appPort}/api/workspaces/financeiro/mcp-token/reactivate`, { method: 'POST' });
  assert.notEqual(reactivatedWorkspace.token, rotatedWorkspace.token);
  await request(`http://127.0.0.1:${appPort}/api/workspaces/financeiro`, { method: 'DELETE' });
  assert.equal(gatewayConfig.mcp.policies.apiKey.keys.some(item => item.metadata.userId === 'workspace:financeiro'), false);

  const created = await request(`http://127.0.0.1:${appPort}/api/mcp-users`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Maria Silva', identity: 'maria@empresa.com', description: 'Plataforma', repositoryIds: ['repository-access-1'] })
  });
  assert.match(created.token, /^cbm_mcp_/);
  assert.equal(gatewayConfig.mcp.policies.apiKey.mode, 'strict');
  const createdKey = gatewayConfig.mcp.policies.apiKey.keys.find(item => item.metadata.userId === created.user.id);
  assert.equal(createdKey.key, created.token);
  assert.deepEqual(gatewayConfig.mcp.policies.cors, { allowOrigins: ['*'] });

  const listed = await request(`http://127.0.0.1:${appPort}/api/mcp-users`);
  assert.equal(listed.accessMode, 'strict');
  assert.equal(listed.users.length, 1);
  assert.equal('tokenHash' in listed.users[0], false);
  assert.equal(JSON.stringify(listed).includes(created.token), false);
  assert.deepEqual(listed.users[0].repositoryIds, ['repository-access-1']);

  const options = await request(`http://127.0.0.1:${appPort}/api/mcp-access-options`);
  assert.equal(options.workspaces[0].repositories[0].id, 'repository-access-1');
  assert.equal(options.workspaces[0].repositories[0].project, 'plataforma-api');

  const allowedBeforeUpdate = await checkTool(guardrail, created.user.id, 'search_graph', { project: 'plataforma-api' });
  const deniedBeforeUpdate = await checkTool(guardrail, created.user.id, 'search_graph', { project: 'plataforma-worker' });
  const missingProject = await checkTool(guardrail, created.user.id, 'search_graph', { project: 'financeiro' });
  assert.ok(allowedBeforeUpdate.pass);
  assert.equal(deniedBeforeUpdate.error.code, 'PERMISSION_DENIED');
  assert.match(missingProject.error.reason, /não existe ou ainda não foi indexado/);

  const updatedAccess = await request(`http://127.0.0.1:${appPort}/api/mcp-users/${created.user.id}/repositories`, {
    method: 'PUT',
    body: JSON.stringify({ repositoryIds: ['repository-access-2'] })
  });
  assert.deepEqual(updatedAccess.user.repositoryIds, ['repository-access-2']);
  const deniedAfterUpdate = await checkTool(guardrail, created.user.id, 'search_graph', { project: 'plataforma-api' });
  const allowedAfterUpdate = await checkTool(guardrail, created.user.id, 'search_graph', { project: 'plataforma-worker' });
  assert.equal(deniedAfterUpdate.error.code, 'PERMISSION_DENIED');
  assert.ok(allowedAfterUpdate.pass);

  await request(`http://127.0.0.1:${appPort}/api/mcp-users/${created.user.id}/revoke`, { method: 'POST' });
  assert.deepEqual(new Set(gatewayConfig.mcp.policies.apiKey.keys.map(item => item.metadata.userId)), new Set(['system-playground', 'workspace:plataforma']));
  assert.equal(gatewayConfig.mcp.policies.apiKey.mode, 'strict');

  const reactivated = await request(`http://127.0.0.1:${appPort}/api/mcp-users/${created.user.id}/reactivate`, { method: 'POST' });
  assert.notEqual(reactivated.token, created.token);
  assert.equal(gatewayConfig.mcp.policies.apiKey.keys.find(item => item.metadata.userId === created.user.id).key, reactivated.token);

  await request(`http://127.0.0.1:${appPort}/api/mcp-users/${created.user.id}`, { method: 'DELETE' });
  assert.deepEqual(new Set(gatewayConfig.mcp.policies.apiKey.keys.map(item => item.metadata.userId)), new Set(['system-playground', 'workspace:plataforma']));
  assert.equal(gatewayConfig.mcp.policies.apiKey.mode, 'strict');
  const rotatedSystem = await request(`http://127.0.0.1:${appPort}/api/mcp-system-token/rotate`, { method: 'POST' });
  assert.notEqual(rotatedSystem.token, system.token);
  assert.equal(gatewayConfig.mcp.policies.apiKey.keys.find(item => item.metadata.userId === 'system-playground').key, rotatedSystem.token);
  assert.equal(stderr, '');
});
