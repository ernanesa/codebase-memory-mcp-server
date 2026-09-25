import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { createRouter } from '../src/router.js';
import { register as registerWorkspaces } from '../src/routes/workspaces.js';
import { register as registerMcpUsers } from '../src/routes/mcp-users.js';
import {
  generateMcpToken,
  mcpTokenFingerprint,
  encryptWorkspaceToken,
  decryptWorkspaceToken,
  publicWorkspace,
  publicMcpUser,
  setMcpGatewayUserKey,
  removeMcpGatewayUserKey
} from '../src/lib.js';

function createMockRequest({ method = 'GET', url = '/', headers = {}, body = null }) {
  const req = Readable.from(body !== null ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:8080', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    end(chunk = '') {
      this.body += chunk;
    }
  };
}

async function dispatch(router, method, pathStr, { body = null, headers = {} } = {}) {
  const match = router.match(method, pathStr);
  if (!match) throw new Error(`Rota não encontrada: ${method} ${pathStr}`);
  const req = createMockRequest({ method, url: pathStr, headers, body });
  const res = createMockResponse();
  const url = new URL(pathStr, 'http://localhost');
  await match.handler(req, res, url, match.params);
  let payload = null;
  try {
    payload = JSON.parse(res.body);
  } catch {}
  return { status: res.statusCode, headers: res.headers, body: res.body, json: payload };
}

async function setupTestEnvironment(t, overrides = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbm-routes-test-'));
  if (t && typeof t.after === 'function') {
    t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  }

  const repositoriesDir = path.join(tmpDir, 'repositories');
  await fs.mkdir(repositoriesDir, { recursive: true });

  const encryptionKey = crypto.randomBytes(32);

  const gatewayConfig = {
    mcp: {
      targets: [{ name: 'codebase-memory' }],
      policies: { apiKey: { keys: [] } }
    }
  };

  const state = {
    workspaces: overrides.workspaces ? structuredClone(overrides.workspaces) : [],
    repositories: overrides.repositories ? structuredClone(overrides.repositories) : []
  };

  const userStore = {
    managed: true,
    users: overrides.users ? structuredClone(overrides.users) : []
  };

  if (overrides.users) {
    for (const u of overrides.users) {
      if (u.status === 'active') {
        const token = overrides.userTokens?.[u.id] || `tok-${u.id}`;
        setMcpGatewayUserKey(gatewayConfig, u, token);
      }
    }
  }

  function getGatewayKey(id) {
    return gatewayConfig.mcp.policies.apiKey.keys.find(k => k.metadata.userId === id)?.key;
  }

  function hasGatewayKey(id) {
    return Boolean(getGatewayKey(id));
  }

  const config = {
    REPOSITORIES_DIR: repositoriesDir,
    REPOSITORY_SYNC_CONCURRENCY: 2,
    MCP_SYSTEM_USER: {
      id: 'system-playground',
      name: 'Sistema / Playground',
      identity: 'system@local'
    },
    ...overrides.config
  };

  const ctx = {
    config,
    state,
    gatewayConfig,
    persisted: false,
    refreshProjectsCalled: false,
    locks: new Set(),
    mcp: {
      workspaceEncryptionKey: encryptionKey,
      systemToken: 'system-secret-token-initial',
      userStore
    },
    defaultUpdateSchedule() {
      return {
        enabled: false,
        cron: '0 3 * * *',
        timezone: 'UTC'
      };
    },
    issueWorkspaceMcpCredential(selectedWorkspace) {
      const token = generateMcpToken();
      const now = new Date().toISOString();
      return {
        token,
        credential: {
          status: 'active',
          keyPrefix: `${token.slice(0, 16)}…`,
          tokenHash: mcpTokenFingerprint(token),
          encryptedToken: encryptWorkspaceToken(token, encryptionKey),
          tokenCreatedAt: now,
          updatedAt: now,
          revokedAt: null
        }
      };
    },
    workspacePrincipal(selectedWorkspace) {
      return {
        id: `workspace:${selectedWorkspace.id}`,
        workspaceId: selectedWorkspace.id,
        name: selectedWorkspace.name,
        identity: `workspace:${selectedWorkspace.id}`
      };
    },
    async commitWorkspaceChange(nextState, changeGatewayConfig) {
      if (overrides.failWorkspaceCommit) {
        throw new Error('Falha simulada no commit do workspace');
      }
      if (changeGatewayConfig) {
        changeGatewayConfig(gatewayConfig);
      }
      ctx.state = nextState;
      ctx.persisted = true;
    },
    setMcpGatewayUserKey(cfg, principalOrUser, token) {
      setMcpGatewayUserKey(gatewayConfig, principalOrUser, token);
    },
    removeMcpGatewayUserKey(cfg, principalId) {
      removeMcpGatewayUserKey(gatewayConfig, principalId);
    },
    workspace(id) {
      const found = ctx.state.workspaces.find(w => w.id === id);
      if (!found) throw new Error('Workspace não encontrado.');
      return found;
    },
    repository(workspaceId, repositoryId) {
      const found = ctx.state.repositories.find(r => r.workspaceId === workspaceId && r.id === repositoryId);
      if (!found) throw new Error('Repositório não encontrado.');
      return found;
    },
    async persist() {
      ctx.persisted = true;
    },
    async runWorkspaceSync(selectedWorkspace, source) {
      return {
        id: 'job-sync-1',
        type: 'sync',
        status: 'queued',
        workspaceId: selectedWorkspace.id,
        source
      };
    },
    runWorkspaceIndex(selectedWorkspace) {
      return {
        id: 'job-index-1',
        type: 'index',
        status: 'queued',
        workspaceId: selectedWorkspace.id
      };
    },
    createJob(type, title, target, fn) {
      return {
        id: `job-${type}-1`,
        type,
        title,
        target,
        status: 'queued'
      };
    },
    enqueueRepositorySync(repository) {
      return {
        job: {
          id: 'job-repo-sync-1',
          type: 'sync',
          target: `${repository.workspaceId}/${repository.id}`,
          status: 'queued'
        }
      };
    },
    async rotateMcpSystemToken() {
      const newToken = generateMcpToken();
      ctx.mcp.systemToken = newToken;
      return newToken;
    },
    async issueMcpToken(user) {
      const token = generateMcpToken();
      const now = new Date().toISOString();
      return {
        token,
        user: {
          ...user,
          status: 'active',
          keyPrefix: `${token.slice(0, 16)}…`,
          tokenHash: mcpTokenFingerprint(token),
          tokenCreatedAt: now,
          updatedAt: now,
          revokedAt: null
        }
      };
    },
    async commitMcpUserChange(nextStore, changeGatewayConfig) {
      if (overrides.failMcpCommit) {
        throw new Error('Falha simulada no commit do usuário MCP');
      }
      if (changeGatewayConfig) {
        await changeGatewayConfig(gatewayConfig);
      }
      ctx.mcp.userStore = nextStore;
      ctx.persisted = true;
    },
    async commitMcpUserStoreOnly(nextStore) {
      ctx.mcp.userStore = nextStore;
      ctx.persisted = true;
    },
    async refreshRepositoryProjects() {
      ctx.refreshProjectsCalled = true;
    }
  };

  const router = createRouter();
  registerWorkspaces(router, ctx);
  registerMcpUsers(router, ctx);

  return { router, ctx, tmpDir, repositoriesDir, encryptionKey, gatewayConfig, getGatewayKey, hasGatewayKey };
}

// ---------------------------------------------------------------------------
// 1. ROTAS DE WORKSPACES (/api/workspaces)
// ---------------------------------------------------------------------------

test('GET /api/workspaces retorna lista vazia quando não há workspaces', async t => {
  const { router } = await setupTestEnvironment(t);
  const res = await dispatch(router, 'GET', '/api/workspaces');

  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { workspaces: [] });
});

test('GET /api/workspaces retorna workspaces com contagem de repositórios e schedule calculado', async t => {
  const ws1 = {
    id: 'backend',
    name: 'Backend API',
    description: 'Serviços backend',
    updateSchedule: { enabled: true, cron: '0 3 * * *', timezone: 'UTC' },
    createdAt: new Date().toISOString()
  };
  const ws2 = {
    id: 'frontend',
    name: 'Frontend Web',
    description: 'Interface web',
    updateSchedule: { enabled: false, cron: '0 4 * * *', timezone: 'UTC' },
    createdAt: new Date().toISOString()
  };

  const repo1 = { id: 'repo-1', workspaceId: 'backend', name: 'api', fullName: 'org/api' };
  const repo2 = { id: 'repo-2', workspaceId: 'backend', name: 'auth', fullName: 'org/auth' };
  const repo3 = { id: 'repo-3', workspaceId: 'frontend', name: 'ui', fullName: 'org/ui' };

  const { router } = await setupTestEnvironment(t, {
    workspaces: [ws1, ws2],
    repositories: [repo1, repo2, repo3]
  });

  const res = await dispatch(router, 'GET', '/api/workspaces');
  assert.equal(res.status, 200);
  assert.equal(res.json.workspaces.length, 2);

  const backendWs = res.json.workspaces.find(w => w.id === 'backend');
  assert.ok(backendWs);
  assert.equal(backendWs.repositoryCount, 2);
  assert.equal(backendWs.updateSchedule.enabled, true);
  assert.ok(backendWs.updateSchedule.nextRunAt);
  assert.ok(backendWs.updateSchedule.description);

  const frontendWs = res.json.workspaces.find(w => w.id === 'frontend');
  assert.ok(frontendWs);
  assert.equal(frontendWs.repositoryCount, 1);
  assert.equal(frontendWs.updateSchedule.enabled, false);
  assert.equal(frontendWs.updateSchedule.nextRunAt, null);
});

test('POST /api/workspaces cria workspace com credencial MCP e pasta no disco', async t => {
  const { router, ctx, repositoriesDir, getGatewayKey } = await setupTestEnvironment(t);

  const res = await dispatch(router, 'POST', '/api/workspaces', {
    body: { name: 'Core Platform', description: 'Plataforma central' }
  });

  assert.equal(res.status, 201);
  assert.equal(res.json.workspace.id, 'core-platform');
  assert.equal(res.json.workspace.name, 'Core Platform');
  assert.equal(res.json.workspace.description, 'Plataforma central');
  assert.ok(res.json.token);
  assert.ok(res.json.workspace.mcpAccess);
  assert.equal(res.json.workspace.mcpAccess.status, 'active');

  // Verifica persistência no estado
  assert.equal(ctx.state.workspaces.length, 1);
  assert.equal(ctx.state.workspaces[0].id, 'core-platform');

  // Verifica criação de diretório físico
  const wsDir = path.join(repositoriesDir, 'core-platform');
  const stat = await fs.stat(wsDir);
  assert.ok(stat.isDirectory());

  // Verifica registro de chave no MCP gateway
  assert.equal(getGatewayKey('workspace:core-platform'), res.json.token);
});

test('POST /api/workspaces rejeita nome vazio ou inválido', async t => {
  const { router } = await setupTestEnvironment(t);

  await assert.rejects(
    () => dispatch(router, 'POST', '/api/workspaces', { body: { name: '' } }),
    { message: 'Informe um nome válido para o workspace.' }
  );

  await assert.rejects(
    () => dispatch(router, 'POST', '/api/workspaces', { body: { name: '   ' } }),
    { message: 'Informe um nome válido para o workspace.' }
  );

  await assert.rejects(
    () => dispatch(router, 'POST', '/api/workspaces', { body: {} }),
    { message: 'Informe um nome válido para o workspace.' }
  );
});

test('POST /api/workspaces rejeita nome duplicado', async t => {
  const { router } = await setupTestEnvironment(t);

  await dispatch(router, 'POST', '/api/workspaces', { body: { name: 'Payments Service' } });

  await assert.rejects(
    () => dispatch(router, 'POST', '/api/workspaces', { body: { name: 'Payments Service' } }),
    { message: 'Já existe um workspace com esse nome.' }
  );

  // Variação de caso e acentos que resulta no mesmo slug
  await assert.rejects(
    () => dispatch(router, 'POST', '/api/workspaces', { body: { name: 'payments-service' } }),
    { message: 'Já existe um workspace com esse nome.' }
  );
});

test('POST /api/workspaces limpa pasta no disco se o commit falhar', async t => {
  const { router, repositoriesDir } = await setupTestEnvironment(t, {
    failWorkspaceCommit: true
  });

  await assert.rejects(
    () => dispatch(router, 'POST', '/api/workspaces', { body: { name: 'Failing WS' } }),
    { message: 'Falha simulada no commit do workspace' }
  );

  const wsDir = path.join(repositoriesDir, 'failing-ws');
  await assert.rejects(() => fs.stat(wsDir), { code: 'ENOENT' });
});

test('GET /api/workspaces/:id retorna detalhes do workspace e repositórios vinculados', async t => {
  const ws = {
    id: 'analytics',
    name: 'Analytics Suite',
    description: 'Métricas e relatórios',
    updateSchedule: { enabled: true, cron: '0 2 * * *', timezone: 'UTC' },
    createdAt: new Date().toISOString()
  };
  const repo = {
    id: 'bi-engine',
    accessId: 'bi-access-1',
    workspaceId: 'analytics',
    name: 'bi-engine',
    fullName: 'org/bi-engine',
    path: '/path/to/bi-engine'
  };

  const { router } = await setupTestEnvironment(t, {
    workspaces: [ws],
    repositories: [repo]
  });

  const res = await dispatch(router, 'GET', '/api/workspaces/analytics');
  assert.equal(res.status, 200);
  assert.equal(res.json.workspace.id, 'analytics');
  assert.equal(res.json.workspace.name, 'Analytics Suite');
  assert.equal(res.json.repositories.length, 1);
  assert.equal(res.json.repositories[0].id, 'bi-engine');
  assert.equal(res.json.repositories[0].path, undefined, 'O caminho local (path) deve ser ocultado na resposta pública');
});

test('GET /api/workspaces/:id falha para workspace inexistente', async t => {
  const { router } = await setupTestEnvironment(t);

  await assert.rejects(
    () => dispatch(router, 'GET', '/api/workspaces/nao-existe'),
    { message: 'Workspace não encontrado.' }
  );
});

test('GET e PUT /api/workspaces/:id/schedule recuperam e alteram rotina de atualização', async t => {
  const ws = {
    id: 'crm',
    name: 'CRM',
    updateSchedule: { enabled: false, cron: '0 3 * * *', timezone: 'UTC' }
  };

  const { router, ctx } = await setupTestEnvironment(t, { workspaces: [ws] });

  // GET schedule
  const resGet = await dispatch(router, 'GET', '/api/workspaces/crm/schedule');
  assert.equal(resGet.status, 200);
  assert.equal(resGet.json.schedule.cron, '0 3 * * *');
  assert.equal(resGet.json.schedule.enabled, false);
  assert.equal(resGet.json.concurrency, 2);

  // PUT schedule válido
  const resPut = await dispatch(router, 'PUT', '/api/workspaces/crm/schedule', {
    body: {
      cron: '30 4 * * 1-5',
      timezone: 'America/Sao_Paulo',
      enabled: true
    }
  });

  assert.equal(resPut.status, 200);
  assert.equal(resPut.json.schedule.cron, '30 4 * * 1-5');
  assert.equal(resPut.json.schedule.timezone, 'America/Sao_Paulo');
  assert.equal(resPut.json.schedule.enabled, true);
  assert.ok(resPut.json.schedule.nextRunAt);
  assert.equal(ctx.persisted, true);

  // PUT schedule com cron inválido
  await assert.rejects(
    () => dispatch(router, 'PUT', '/api/workspaces/crm/schedule', {
      body: { cron: 'invalid-cron', timezone: 'UTC', enabled: true }
    })
  );

  // PUT schedule com timezone inválido
  await assert.rejects(
    () => dispatch(router, 'PUT', '/api/workspaces/crm/schedule', {
      body: { cron: '0 3 * * *', timezone: 'Planeta/Marte', enabled: true }
    }),
    { message: 'Fuso horário inválido. Use um identificador como America/Maceio.' }
  );

  // PUT schedule com enabled não booleano
  await assert.rejects(
    () => dispatch(router, 'PUT', '/api/workspaces/crm/schedule', {
      body: { cron: '0 3 * * *', timezone: 'UTC', enabled: 'sim' }
    }),
    { message: 'O estado da rotina deve ser verdadeiro ou falso.' }
  );
});

test('DELETE /api/workspaces/:id exclui workspace vazio, pasta no disco e remove chave do gateway', async t => {
  const { router, ctx, repositoriesDir, hasGatewayKey } = await setupTestEnvironment(t);

  // Cria workspace via rota
  const createRes = await dispatch(router, 'POST', '/api/workspaces', { body: { name: 'Ephemeral' } });
  const wsId = createRes.json.workspace.id;
  const wsDir = path.join(repositoriesDir, wsId);

  assert.ok(await fs.stat(wsDir).then(() => true, () => false));
  assert.equal(hasGatewayKey(`workspace:${wsId}`), true);

  // Exclui
  const deleteRes = await dispatch(router, 'DELETE', `/api/workspaces/${wsId}`);
  assert.equal(deleteRes.status, 200);
  assert.deepEqual(deleteRes.json, { deleted: true });

  // Verifica que pasta foi removida e chave removida do gateway
  await assert.rejects(() => fs.stat(wsDir), { code: 'ENOENT' });
  assert.equal(hasGatewayKey(`workspace:${wsId}`), false);
  assert.equal(ctx.state.workspaces.length, 0);
});

test('DELETE /api/workspaces/:id impede exclusão se houver repositórios vinculados', async t => {
  const ws = { id: 'has-repos', name: 'Has Repos' };
  const repo = { id: 'r1', workspaceId: 'has-repos', name: 'r1', fullName: 'org/r1' };

  const { router } = await setupTestEnvironment(t, {
    workspaces: [ws],
    repositories: [repo]
  });

  await assert.rejects(
    () => dispatch(router, 'DELETE', '/api/workspaces/has-repos'),
    { message: 'Remova os repositórios antes de excluir o workspace.' }
  );
});

test('DELETE /api/workspaces/:id impede exclusão se a pasta contiver arquivos não gerenciados', async t => {
  const { router, repositoriesDir } = await setupTestEnvironment(t);

  await dispatch(router, 'POST', '/api/workspaces', { body: { name: 'Dirty WS' } });
  const wsDir = path.join(repositoriesDir, 'dirty-ws');

  // Cria arquivo manual não gerenciado
  await fs.writeFile(path.join(wsDir, 'random-file.txt'), 'conteudo nao gerenciado');

  await assert.rejects(
    () => dispatch(router, 'DELETE', '/api/workspaces/dirty-ws'),
    { message: 'A pasta do workspace contém arquivos não gerenciados e não pode ser excluída.' }
  );
});

test('DELETE /api/workspaces/:id restaura pasta física caso o commit falhe', async t => {
  const { router, ctx, repositoriesDir } = await setupTestEnvironment(t);

  await dispatch(router, 'POST', '/api/workspaces', { body: { name: 'Rollback WS' } });
  const wsDir = path.join(repositoriesDir, 'rollback-ws');
  assert.ok(await fs.stat(wsDir).then(() => true, () => false));

  // Simula falha no commit durante o delete
  ctx.commitWorkspaceChange = async () => {
    throw new Error('Falha no commit de exclusão');
  };

  await assert.rejects(
    () => dispatch(router, 'DELETE', '/api/workspaces/rollback-ws'),
    { message: 'Falha no commit de exclusão' }
  );

  // Pasta deve ter sido recriada no rollback
  const stat = await fs.stat(wsDir);
  assert.ok(stat.isDirectory());
});

// ---------------------------------------------------------------------------
// 1.1 OPERAÇÕES DE TOKEN MCP DO WORKSPACE
// ---------------------------------------------------------------------------

test('Operações de token MCP do workspace (reveal, rotate, revoke, reactivate)', async t => {
  const { router, getGatewayKey, hasGatewayKey } = await setupTestEnvironment(t);

  // 1. Cria workspace
  const createRes = await dispatch(router, 'POST', '/api/workspaces', { body: { name: 'Token Lifecycle' } });
  const wsId = createRes.json.workspace.id;
  const initialToken = createRes.json.token;

  // 2. Reveal
  const revealRes = await dispatch(router, 'POST', `/api/workspaces/${wsId}/mcp-token/reveal`);
  assert.equal(revealRes.status, 200);
  assert.equal(revealRes.json.token, initialToken);
  assert.equal(revealRes.json.name, 'Token Lifecycle');

  // 3. Rotate
  const rotateRes = await dispatch(router, 'POST', `/api/workspaces/${wsId}/mcp-token/rotate`);
  assert.equal(rotateRes.status, 200);
  assert.notEqual(rotateRes.json.token, initialToken);
  const rotatedToken = rotateRes.json.token;
  assert.equal(getGatewayKey(`workspace:${wsId}`), rotatedToken);

  // 4. Revoke
  const revokeRes = await dispatch(router, 'POST', `/api/workspaces/${wsId}/mcp-token/revoke`);
  assert.equal(revokeRes.status, 200);
  assert.equal(revokeRes.json.workspace.mcpAccess.status, 'revoked');
  assert.equal(hasGatewayKey(`workspace:${wsId}`), false);

  // Não pode rotacionar token revogado
  await assert.rejects(
    () => dispatch(router, 'POST', `/api/workspaces/${wsId}/mcp-token/rotate`),
    { message: 'Reative o token antes de rotacioná-lo.' }
  );

  // Não pode revogar token já revogado
  await assert.rejects(
    () => dispatch(router, 'POST', `/api/workspaces/${wsId}/mcp-token/revoke`),
    { message: 'O token deste workspace já está revogado.' }
  );

  // 5. Reactivate
  const reactivateRes = await dispatch(router, 'POST', `/api/workspaces/${wsId}/mcp-token/reactivate`);
  assert.equal(reactivateRes.status, 200);
  assert.equal(reactivateRes.json.workspace.mcpAccess.status, 'active');
  assert.ok(reactivateRes.json.token);
  assert.equal(getGatewayKey(`workspace:${wsId}`), reactivateRes.json.token);

  // Não pode reativar token já ativo
  await assert.rejects(
    () => dispatch(router, 'POST', `/api/workspaces/${wsId}/mcp-token/reactivate`),
    { message: 'O token deste workspace já está ativo.' }
  );
});

// ---------------------------------------------------------------------------
// 1.2 OPERAÇÕES AUXILIARES DE WORKSPACE (jobs, sync, index)
// ---------------------------------------------------------------------------

test('Operações de execução e jobs em workspaces e repositórios', async t => {
  const ws = { id: 'job-ws', name: 'Job WS' };
  const repo = {
    id: 'repo-sub',
    accessId: 'acc-sub',
    workspaceId: 'job-ws',
    name: 'repo-sub',
    fullName: 'org/repo-sub',
    path: path.join(os.tmpdir(), 'cbm-sub-repo')
  };
  await fs.mkdir(repo.path, { recursive: true });
  t.after(() => fs.rm(repo.path, { recursive: true, force: true }));

  const { router, ctx } = await setupTestEnvironment(t, {
    workspaces: [ws],
    repositories: [repo]
  });

  // Schedule run
  const resScheduleRun = await dispatch(router, 'POST', '/api/workspaces/job-ws/schedule/run');
  assert.equal(resScheduleRun.status, 202);
  assert.equal(resScheduleRun.json.id, 'job-sync-1');

  // Workspace index
  const resIndex = await dispatch(router, 'POST', '/api/workspaces/job-ws/index');
  assert.equal(resIndex.status, 202);
  assert.equal(resIndex.json.id, 'job-index-1');

  // Repo sync
  const resRepoSync = await dispatch(router, 'POST', '/api/workspaces/job-ws/repositories/repo-sub/sync');
  assert.equal(resRepoSync.status, 202);
  assert.equal(resRepoSync.json.id, 'job-repo-sync-1');

  // Repo index
  const resRepoIndex = await dispatch(router, 'POST', '/api/workspaces/job-ws/repositories/repo-sub/index');
  assert.equal(resRepoIndex.status, 202);
  assert.equal(resRepoIndex.json.id, 'job-index-1');

  // Delete repository com lock ativo deve falhar
  ctx.locks.add('job-ws/repo-sub');
  await assert.rejects(
    () => dispatch(router, 'DELETE', '/api/workspaces/job-ws/repositories/repo-sub'),
    { message: 'Aguarde a operação atual terminar.' }
  );
  ctx.locks.delete('job-ws/repo-sub');

  // Delete repository com sucesso
  const resDelRepo = await dispatch(router, 'DELETE', '/api/workspaces/job-ws/repositories/repo-sub');
  assert.equal(resDelRepo.status, 200);
  assert.deepEqual(resDelRepo.json, { deleted: true });
  assert.equal(ctx.state.repositories.length, 0);
});

// ---------------------------------------------------------------------------
// 2. ROTAS DE MCP USERS (/api/mcp-users)
// ---------------------------------------------------------------------------

test('GET /api/mcp-users retorna lista de usuários cadastrados e parâmetros de segurança', async t => {
  const existingUser = {
    id: 'user-001',
    name: 'Carlos Oliveira',
    identity: 'carlos@empresa.com',
    description: 'Dev Backend',
    repositoryIds: ['repo-acc-1'],
    status: 'active',
    keyPrefix: 'cbm_mcp_test…',
    createdAt: new Date().toISOString()
  };

  const { router } = await setupTestEnvironment(t, { users: [existingUser] });
  const res = await dispatch(router, 'GET', '/api/mcp-users');

  assert.equal(res.status, 200);
  assert.equal(res.json.accessMode, 'strict');
  assert.equal(res.json.systemAccess, true);
  assert.equal(res.json.users.length, 1);
  assert.equal(res.json.users[0].id, 'user-001');
  assert.equal(res.json.users[0].name, 'Carlos Oliveira');
  assert.deepEqual(res.json.users[0].repositoryIds, ['repo-acc-1']);
});

test('POST /api/mcp-users cria novo usuário MCP com validações corretas e chave emitida', async t => {
  const repo = {
    id: 'api-repo',
    accessId: 'repo-acc-123',
    workspaceId: 'main-ws',
    name: 'api',
    fullName: 'org/api'
  };

  const { router, ctx, getGatewayKey } = await setupTestEnvironment(t, {
    repositories: [repo]
  });

  const res = await dispatch(router, 'POST', '/api/mcp-users', {
    body: {
      name: 'Maria Santos',
      identity: 'maria@empresa.com',
      description: 'Engenheira de dados',
      repositoryIds: ['repo-acc-123']
    }
  });

  assert.equal(res.status, 201);
  assert.ok(res.json.user.id);
  assert.equal(res.json.user.name, 'Maria Santos');
  assert.equal(res.json.user.identity, 'maria@empresa.com');
  assert.equal(res.json.user.status, 'active');
  assert.deepEqual(res.json.user.repositoryIds, ['repo-acc-123']);
  assert.ok(res.json.token);

  // Store atualizado
  assert.equal(ctx.mcp.userStore.users.length, 1);
  assert.equal(ctx.mcp.userStore.users[0].id, res.json.user.id);

  // Gateway key definida
  assert.equal(getGatewayKey(res.json.user.id), res.json.token);
});

test('POST /api/mcp-users valida campos obrigatórios e limites de caracteres', async t => {
  const repo = { accessId: 'acc-1', id: 'r1', workspaceId: 'w', name: 'r1', fullName: 'o/r' };
  const { router } = await setupTestEnvironment(t, { repositories: [repo] });

  // Sem nome
  await assert.rejects(
    () => dispatch(router, 'POST', '/api/mcp-users', {
      body: { name: '', identity: 'id@test.com', repositoryIds: ['acc-1'] }
    }),
    { message: 'Nome do usuário é obrigatório.' }
  );

  // Nome muito longo (> 100)
  await assert.rejects(
    () => dispatch(router, 'POST', '/api/mcp-users', {
      body: { name: 'A'.repeat(101), identity: 'id@test.com', repositoryIds: ['acc-1'] }
    }),
    { message: 'Nome do usuário é muito longo (máx. 100 caracteres).' }
  );

  // Sem identidade
  await assert.rejects(
    () => dispatch(router, 'POST', '/api/mcp-users', {
      body: { name: 'Nome', identity: '', repositoryIds: ['acc-1'] }
    }),
    { message: 'Identidade do usuário é obrigatória.' }
  );

  // Identidade muito longa (> 160)
  await assert.rejects(
    () => dispatch(router, 'POST', '/api/mcp-users', {
      body: { name: 'Nome', identity: 'A'.repeat(161), repositoryIds: ['acc-1'] }
    }),
    { message: 'Identidade do usuário é muito longa (máx. 160 caracteres).' }
  );

  // Descrição muito longa (> 240)
  await assert.rejects(
    () => dispatch(router, 'POST', '/api/mcp-users', {
      body: { name: 'Nome', identity: 'id@test.com', description: 'D'.repeat(241), repositoryIds: ['acc-1'] }
    }),
    { message: 'Descrição é muito longa (máx. 240 caracteres).' }
  );

  // Sem repositórios
  await assert.rejects(
    () => dispatch(router, 'POST', '/api/mcp-users', {
      body: { name: 'Nome', identity: 'id@test.com' }
    }),
    { message: 'Acesso a repositórios é obrigatório.' }
  );

  // Repositórios não array
  await assert.rejects(
    () => dispatch(router, 'POST', '/api/mcp-users', {
      body: { name: 'Nome', identity: 'id@test.com', repositoryIds: 'acc-1' }
    }),
    { message: 'Formato de repositórios inválido.' }
  );

  // Repositório inexistente
  await assert.rejects(
    () => dispatch(router, 'POST', '/api/mcp-users', {
      body: { name: 'Nome', identity: 'id@test.com', repositoryIds: ['acc-fantasma'] }
    }),
    { message: 'Repositório selecionado inválido ou não encontrado (acc-fantasma).' }
  );
});

test('POST /api/mcp-users rejeita identidade duplicada (case-insensitive)', async t => {
  const repo = { accessId: 'acc-1', id: 'r1', workspaceId: 'w', name: 'r1', fullName: 'o/r' };
  const existingUser = {
    id: 'user-existing',
    name: 'Ana',
    identity: 'ana@empresa.com',
    repositoryIds: ['acc-1'],
    status: 'active'
  };

  const { router } = await setupTestEnvironment(t, {
    repositories: [repo],
    users: [existingUser]
  });

  await assert.rejects(
    () => dispatch(router, 'POST', '/api/mcp-users', {
      body: { name: 'Outra Ana', identity: 'ANA@EMPRESA.COM', repositoryIds: ['acc-1'] }
    }),
    { message: 'Já existe um usuário com esta identidade.' }
  );
});

test('Tokens de sistema (/api/mcp-system-token/reveal e /rotate)', async t => {
  const { router, ctx } = await setupTestEnvironment(t);

  // Reveal
  const resReveal = await dispatch(router, 'POST', '/api/mcp-system-token/reveal');
  assert.equal(resReveal.status, 200);
  assert.equal(resReveal.json.token, 'system-secret-token-initial');
  assert.equal(resReveal.json.name, 'Sistema / Playground');

  // Rotate
  const resRotate = await dispatch(router, 'POST', '/api/mcp-system-token/rotate');
  assert.equal(resRotate.status, 200);
  assert.notEqual(resRotate.json.token, 'system-secret-token-initial');
  assert.equal(resRotate.json.token, ctx.mcp.systemToken);
  assert.equal(resRotate.json.name, 'Sistema / Playground');
});

test('Ciclo de vida do usuário MCP (revoke, rotate, reactivate)', async t => {
  const repo = { accessId: 'acc-life', id: 'rl', workspaceId: 'wl', name: 'rl', fullName: 'o/rl' };
  const activeUser = {
    id: 'u-lifecycle-1',
    name: 'Pedro Ramos',
    identity: 'pedro@empresa.com',
    description: 'Dev',
    repositoryIds: ['acc-life'],
    status: 'active',
    keyPrefix: 'prefix-1…',
    createdAt: new Date().toISOString()
  };

  const { router, ctx, getGatewayKey, hasGatewayKey } = await setupTestEnvironment(t, {
    repositories: [repo],
    users: [activeUser],
    userTokens: { [activeUser.id]: 'old-token' }
  });

  // Verifica token inicial registrado
  assert.equal(getGatewayKey(activeUser.id), 'old-token');

  // 1. Rotate em usuário ativo
  const resRotate = await dispatch(router, 'POST', `/api/mcp-users/${activeUser.id}/rotate`);
  assert.equal(resRotate.status, 200);
  assert.equal(resRotate.json.user.id, activeUser.id);
  assert.ok(resRotate.json.token);
  assert.notEqual(resRotate.json.token, 'old-token');
  assert.equal(getGatewayKey(activeUser.id), resRotate.json.token);

  // 2. Revoke em usuário ativo
  const resRevoke = await dispatch(router, 'POST', `/api/mcp-users/${activeUser.id}/revoke`);
  assert.equal(resRevoke.status, 200);
  assert.equal(resRevoke.json.user.status, 'revoked');
  assert.ok(resRevoke.json.user.revokedAt);
  assert.equal(hasGatewayKey(activeUser.id), false);

  // Rejeita revoke em usuário já revogado
  await assert.rejects(
    () => dispatch(router, 'POST', `/api/mcp-users/${activeUser.id}/revoke`),
    { message: 'O token deste usuário já está revogado.' }
  );

  // Rejeita rotate em usuário revogado
  await assert.rejects(
    () => dispatch(router, 'POST', `/api/mcp-users/${activeUser.id}/rotate`),
    { message: 'Reative o usuário antes de rotacionar seu token.' }
  );

  // 3. Reactivate em usuário revogado
  const resReactivate = await dispatch(router, 'POST', `/api/mcp-users/${activeUser.id}/reactivate`);
  assert.equal(resReactivate.status, 200);
  assert.equal(resReactivate.json.user.status, 'active');
  assert.ok(!resReactivate.json.user.revokedAt);
  assert.ok(resReactivate.json.token);
  assert.equal(getGatewayKey(activeUser.id), resReactivate.json.token);

  // Rejeita reactivate em usuário já ativo
  await assert.rejects(
    () => dispatch(router, 'POST', `/api/mcp-users/${activeUser.id}/reactivate`),
    { message: 'Este usuário já está ativo.' }
  );
});

test('GET /api/mcp-access-options agrupa repositórios por workspace ordenados por fullName', async t => {
  const ws1 = { id: 'ws-alpha', name: 'Alpha Suite' };
  const ws2 = { id: 'ws-beta', name: 'Beta Suite' };

  const repoZ = {
    id: 'repo-z',
    accessId: 'acc-z',
    workspaceId: 'ws-alpha',
    name: 'zebra',
    fullName: 'org/zebra',
    project: 'proj-zebra'
  };
  const repoA = {
    id: 'repo-a',
    accessId: 'acc-a',
    workspaceId: 'ws-alpha',
    name: 'apple',
    fullName: 'org/apple',
    project: null
  };
  const repoB = {
    id: 'repo-b',
    accessId: 'acc-b',
    workspaceId: 'ws-beta',
    name: 'banana',
    fullName: 'org/banana',
    project: 'proj-banana'
  };

  const { router, ctx } = await setupTestEnvironment(t, {
    workspaces: [ws1, ws2],
    repositories: [repoZ, repoA, repoB]
  });

  const res = await dispatch(router, 'GET', '/api/mcp-access-options');
  assert.equal(res.status, 200);
  assert.equal(ctx.refreshProjectsCalled, true);

  assert.equal(res.json.workspaces.length, 2);

  const alpha = res.json.workspaces.find(w => w.id === 'ws-alpha');
  assert.ok(alpha);
  assert.equal(alpha.repositories.length, 2);
  // Ordenado por fullName: org/apple antes de org/zebra
  assert.equal(alpha.repositories[0].fullName, 'org/apple');
  assert.equal(alpha.repositories[0].indexed, false);
  assert.equal(alpha.repositories[1].fullName, 'org/zebra');
  assert.equal(alpha.repositories[1].indexed, true);

  const beta = res.json.workspaces.find(w => w.id === 'ws-beta');
  assert.ok(beta);
  assert.equal(beta.repositories.length, 1);
  assert.equal(beta.repositories[0].fullName, 'org/banana');
  assert.equal(beta.repositories[0].indexed, true);
});

test('PUT /api/mcp-users/:id/repositories e DELETE /api/mcp-users/:id', async t => {
  const repo1 = { accessId: 'acc-1', id: 'r1', workspaceId: 'w', name: 'r1', fullName: 'o/r1' };
  const repo2 = { accessId: 'acc-2', id: 'r2', workspaceId: 'w', name: 'r2', fullName: 'o/r2' };

  const user = {
    id: 'user-crud-1',
    name: 'Lucas Ferreira',
    identity: 'lucas@empresa.com',
    repositoryIds: ['acc-1'],
    status: 'active'
  };

  const { router, ctx, hasGatewayKey } = await setupTestEnvironment(t, {
    repositories: [repo1, repo2],
    users: [user],
    userTokens: { [user.id]: 'tok-lucas' }
  });

  assert.equal(hasGatewayKey(user.id), true);

  // PUT atualiza repositórios
  const resPut = await dispatch(router, 'PUT', `/api/mcp-users/${user.id}/repositories`, {
    body: { repositoryIds: ['acc-1', 'acc-2'] }
  });
  assert.equal(resPut.status, 200);
  assert.deepEqual(resPut.json.user.repositoryIds, ['acc-1', 'acc-2']);
  assert.deepEqual(ctx.mcp.userStore.users[0].repositoryIds, ['acc-1', 'acc-2']);

  // PUT com repositório inexistente deve falhar
  await assert.rejects(
    () => dispatch(router, 'PUT', `/api/mcp-users/${user.id}/repositories`, {
      body: { repositoryIds: ['acc-inexistente'] }
    }),
    { message: 'Repositório selecionado inválido ou não encontrado (acc-inexistente).' }
  );

  // DELETE exclui usuário
  const resDel = await dispatch(router, 'DELETE', `/api/mcp-users/${user.id}`);
  assert.equal(resDel.status, 200);
  assert.deepEqual(resDel.json, { deleted: true });
  assert.equal(ctx.mcp.userStore.users.length, 0);
  assert.equal(hasGatewayKey(user.id), false);

  // Operação em usuário inexistente deve falhar
  await assert.rejects(
    () => dispatch(router, 'DELETE', `/api/mcp-users/${user.id}`),
    { message: 'Usuário MCP não encontrado.' }
  );
});

// ---------------------------------------------------------------------------
// 3. FLUXO DE INTEGRAÇÃO COMPLETO (WORKSPACE + MCP USER)
// ---------------------------------------------------------------------------

test('Fluxo completo: criar workspace, adicionar repositório, criar usuário MCP com acesso restrito e alternar status', async t => {
  const { router, ctx } = await setupTestEnvironment(t);

  // 1. Cria workspace
  const wsRes = await dispatch(router, 'POST', '/api/workspaces', {
    body: { name: 'E-Commerce Platform', description: 'Sistema de compras' }
  });
  assert.equal(wsRes.status, 201);
  const wsId = wsRes.json.workspace.id;

  // 2. Adiciona repositório simulado ao workspace criado
  const accessId = crypto.randomUUID();
  const simulatedRepo = {
    id: 'payment-service',
    accessId,
    workspaceId: wsId,
    name: 'payment-service',
    fullName: 'store/payment-service',
    project: 'proj-payment',
    status: 'ready'
  };
  ctx.state.repositories.push(simulatedRepo);

  // 3. Consulta opções de acesso MCP
  const optionsRes = await dispatch(router, 'GET', '/api/mcp-access-options');
  assert.equal(optionsRes.status, 200);
  const matchedWs = optionsRes.json.workspaces.find(w => w.id === wsId);
  assert.ok(matchedWs);
  assert.equal(matchedWs.repositories.length, 1);
  assert.equal(matchedWs.repositories[0].id, accessId);

  // 4. Cria usuário MCP apontando para o repositório deste workspace
  const userRes = await dispatch(router, 'POST', '/api/mcp-users', {
    body: {
      name: 'Auditor Externo',
      identity: 'auditor@consultoria.com',
      description: 'Auditoria de código financeiro',
      repositoryIds: [accessId]
    }
  });
  assert.equal(userRes.status, 201);
  const userId = userRes.json.user.id;
  const userToken = userRes.json.token;

  // 5. Lista usuários e valida permissões
  const listUsersRes = await dispatch(router, 'GET', '/api/mcp-users');
  assert.equal(listUsersRes.status, 200);
  const createdUser = listUsersRes.json.users.find(u => u.id === userId);
  assert.ok(createdUser);
  assert.deepEqual(createdUser.repositoryIds, [accessId]);

  // 6. Rotaciona credencial do usuário
  const rotateUserRes = await dispatch(router, 'POST', `/api/mcp-users/${userId}/rotate`);
  assert.equal(rotateUserRes.status, 200);
  assert.notEqual(rotateUserRes.json.token, userToken);

  // 7. Revoga credencial
  const revokeUserRes = await dispatch(router, 'POST', `/api/mcp-users/${userId}/revoke`);
  assert.equal(revokeUserRes.status, 200);
  assert.equal(revokeUserRes.json.user.status, 'revoked');

  // 8. Reativa credencial
  const reactivateUserRes = await dispatch(router, 'POST', `/api/mcp-users/${userId}/reactivate`);
  assert.equal(reactivateUserRes.status, 200);
  assert.equal(reactivateUserRes.json.user.status, 'active');

  // 9. Exclui usuário
  const delUserRes = await dispatch(router, 'DELETE', `/api/mcp-users/${userId}`);
  assert.equal(delUserRes.status, 200);
  assert.deepEqual(delUserRes.json, { deleted: true });
});
