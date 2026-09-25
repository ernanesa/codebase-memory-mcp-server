import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeSegment, createMutex, DEFAULT_TIMEZONE, DEFAULT_WORKSPACE_CRON, cronMatches, decryptWorkspaceToken, describeCron, encryptWorkspaceToken, generateMcpToken, gitAuthEnvironment, indexRepositoryArguments, loadCredentials, loadMcpUserStore, loadSecret, loadState, mcpTokenFingerprint, nextCronOccurrence, parseCronExpression, parseLastJsonLine, publicMcpUser, publicWorkspace, reconcileRepositoryProjects, removeMcpGatewayUserKey, run, safeChild, saveCredentials, saveMcpUserStore, saveSecret, saveState, setMcpGatewayUserKey, slugify, validateTimezone } from './lib.js';
import { clearSemanticCache, startMcpGuardrailServer } from './mcp-guardrail.js';
import { gauge, increment, log as structuredLog, metricsText, observe } from './observability.js';
import { createAdminAuth } from './auth.js';
import { JOB_HISTORY_RETENTION_DAYS, JOB_LOG_MAX_CHARACTERS, loadJobHistory, paginateJobs, pruneJobHistory, recoverInterruptedJobs, saveJobHistory } from './job-history.js';
import { createRouter } from './router.js';
import { json, textResponse, redirect, requestOriginAllowed, clientAddress, secureRequest } from './http.js';
import { register as registerAuth } from './routes/auth.js';
import { register as registerHealth } from './routes/health.js';
import { register as registerGithub } from './routes/github.js';
import { register as registerJobs } from './routes/jobs.js';
import { register as registerKnowledgeSync } from './routes/knowledge-sync.js';
import { register as registerMcpUsers } from './routes/mcp-users.js';
import { register as registerWorkspaces } from './routes/workspaces.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.APP_DATA_DIR || '/data/app';
const REPOSITORIES_DIR = process.env.CBM_ALLOWED_ROOT || '/data/repositories';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const JOB_HISTORY_FILE = path.join(DATA_DIR, 'jobs.json');
const GITHUB_CREDENTIALS_FILE = path.join(DATA_DIR, 'secrets', 'github-credentials.json');
const MCP_USERS_FILE = path.join(DATA_DIR, 'secrets', 'mcp-users.json');
const MCP_SYSTEM_TOKEN_FILE = path.join(DATA_DIR, 'secrets', 'mcp-system-token');
const MCP_WORKSPACE_KEY_FILE = path.join(DATA_DIR, 'secrets', 'mcp-workspace-encryption-key');
const KNOWLEDGE_SYNC_TOKEN_FILE = process.env.KNOWLEDGE_SYNC_TOKEN_FILE || path.join(DATA_DIR, 'secrets', 'knowledge-sync', 'knowledge-sync-token');
const GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE = path.join(DATA_DIR, 'secrets', 'knowledge-sync', 'google-drive-service-account.json');
const CBM_BIN = process.env.CBM_BIN || 'codebase-memory-mcp';
const PORT = Number(process.env.PORT || 3000);
const UI_PORT = Number(process.env.UI_PORT);
const AGENTGATEWAY_ADMIN_URL = String(process.env.AGENTGATEWAY_ADMIN_URL || 'http://agentgateway:15000').replace(/\/+$/, '');
const MCP_GUARDRAIL_ADDR = process.env.MCP_GUARDRAIL_ADDR || '0.0.0.0:3001';
const CBM_PROJECT_RECONCILE = process.env.CBM_PROJECT_RECONCILE !== 'false';
const WORKSPACE_TIMEZONE = process.env.WORKSPACE_TIMEZONE || DEFAULT_TIMEZONE;
const REPOSITORY_SYNC_CONCURRENCY = Math.max(1, Math.min(20, Number.parseInt(process.env.REPOSITORY_SYNC_CONCURRENCY || '3', 10) || 3));
const KNOWLEDGE_SYNC_ENABLED = process.env.KNOWLEDGE_SYNC_ENABLED !== 'false';
const KNOWLEDGE_SYNC_URL = String(process.env.KNOWLEDGE_SYNC_URL || 'http://knowledge-sync:3002').replace(/\/+$/, '');
const ADMIN_AUTH_USERNAME = process.env.ADMIN_AUTH_USERNAME || '';
const ADMIN_AUTH_PASSWORD = process.env.ADMIN_AUTH_PASSWORD || '';
const ADMIN_JWT_SECRET_FILE = process.env.ADMIN_JWT_SECRET_FILE || path.join(DATA_DIR, 'secrets', 'admin-jwt-secret');
const ADMIN_COOKIE_SECURE = process.env.ADMIN_COOKIE_SECURE === 'true';
const GRAFANA_PUBLIC_URL = String(process.env.GRAFANA_PUBLIC_URL || 'http://grafana.localhost:8080').replace(/\/+$/, '');
const MCP_PUBLIC_URL = String(process.env.MCP_PUBLIC_URL || 'http://mcp.localhost:8080').replace(/\/+$/, '');

await Promise.all([mkdir(DATA_DIR, { recursive: true }), mkdir(REPOSITORIES_DIR, { recursive: true })]);

let state = await loadState(STATE_FILE);
const storedJobs = await loadJobHistory(JOB_HISTORY_FILE);
const retainedJobs = pruneJobHistory(storedJobs);
const recoveredJobs = recoverInterruptedJobs(retainedJobs);
const jobs = recoveredJobs.jobs;
const jobHistoryMigrated = retainedJobs.length !== storedJobs.length || recoveredJobs.changed;
function defaultUpdateSchedule() {
  return { enabled: true, cron: DEFAULT_WORKSPACE_CRON, timezone: WORKSPACE_TIMEZONE, lastRunAt: null, lastRunStatus: null, lastScheduledMinute: null };
}
let schedulesMigrated = false;
state.workspaces = state.workspaces.map(item => {
  if (item.updateSchedule) return item;
  schedulesMigrated = true;
  return { ...item, updateSchedule: defaultUpdateSchedule() };
});
let mcpUserStore = await loadMcpUserStore(MCP_USERS_FILE);
let stateMigrated = false;
state.repositories = state.repositories.map(item => {
  if (item.accessId) return item;
  stateMigrated = true;
  return { ...item, accessId: randomUUID() };
});
state.repositories = state.repositories.map(item => {
  if (!item.activeJobId && item.syncStatus !== 'syncing' && !['cloning', 'indexing'].includes(item.status)) return item;
  stateMigrated = true;
  const updated = { ...item };
  delete updated.activeJobId;
  if (updated.syncStatus === 'syncing') {
    updated.syncStatus = 'error';
    updated.syncError = 'Operação interrompida pela reinicialização do serviço.';
  }
  if (['cloning', 'indexing'].includes(updated.status)) updated.status = 'error';
  return updated;
});
let mcpUsersMigrated = false;
mcpUserStore.users = mcpUserStore.users.map(item => {
  if (Array.isArray(item.repositoryIds)) return item;
  mcpUsersMigrated = true;
  return { ...item, repositoryIds: [] };
});
if (stateMigrated || schedulesMigrated) await saveState(STATE_FILE, state);
if (jobHistoryMigrated) await saveJobHistory(JOB_HISTORY_FILE, jobs);
if (mcpUsersMigrated) await saveMcpUserStore(MCP_USERS_FILE, mcpUserStore);
let mcpSystemToken = await loadSecret(MCP_SYSTEM_TOKEN_FILE);
let knowledgeSyncToken = KNOWLEDGE_SYNC_ENABLED ? await loadSecret(KNOWLEDGE_SYNC_TOKEN_FILE) : '';
const adminJwtSecret = await loadSecret(ADMIN_JWT_SECRET_FILE);
const adminAuth = await createAdminAuth({ username: ADMIN_AUTH_USERNAME, password: ADMIN_AUTH_PASSWORD, secret: adminJwtSecret });
const loginAttempts = new Map();
let mcpWorkspaceEncryptionKey = await loadSecret(MCP_WORKSPACE_KEY_FILE);
if (!mcpWorkspaceEncryptionKey) {
  mcpWorkspaceEncryptionKey = generateMcpToken();
  await saveSecret(MCP_WORKSPACE_KEY_FILE, mcpWorkspaceEncryptionKey);
}
const storedGithubCredentials = await loadCredentials(GITHUB_CREDENTIALS_FILE);
let githubToken = storedGithubCredentials?.token ?? '';
let githubUser = storedGithubCredentials?.user ?? null;
let githubCache = { at: 0, repositories: [] };
const locks = new Set();
const syncQueues = new Map();
const syncWorkspaceOrder = [];
const activeWorkspaceSyncs = new Set();
let activeRepositorySyncs = 0;
const stateMutex = createMutex();
let mcpUserMutation = false;
let projectReconciliation = null;
let lastProjectReconciliationAt = 0;
const MCP_SYSTEM_USER = {
  id: 'system-playground',
  name: 'Sistema / Playground',
  identity: 'system@local'
};

function errorResponse(response, error, status = error.status || 400) {
  structuredLog('error', 'request_failed', { status, error: error.message });
  json(response, status, { error: error.message || 'Erro inesperado.' });
}

async function knowledgeSyncRequest(pathname, { method = 'GET', payload } = {}) {
  if (!KNOWLEDGE_SYNC_ENABLED) {
    const error = new Error('O serviço de sincronização com Google Drive está desabilitado.');
    error.status = 503;
    throw error;
  }
  if (!knowledgeSyncToken) {
    knowledgeSyncToken = await loadSecret(KNOWLEDGE_SYNC_TOKEN_FILE);
    if (!knowledgeSyncToken) {
      const error = new Error('O token interno do worker de sincronização não foi encontrado.');
      error.status = 503;
      throw error;
    }
  }
  let response;
  try {
    response = await fetch(`${KNOWLEDGE_SYNC_URL}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${knowledgeSyncToken}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000)
    });
  } catch (cause) {
    const error = new Error('O worker de sincronização do Google Drive não está disponível.');
    error.status = 503;
    error.cause = cause;
    throw error;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'O worker rejeitou a operação.');
    error.status = response.status;
    throw error;
  }
  return { status: response.status, result };
}

async function body(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Corpo da requisição muito grande.');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('JSON inválido.'); }
}

function validateGoogleServiceAccount(value) {
  const credentials = typeof value === 'string' ? JSON.parse(value) : value;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new Error('Informe o JSON da Service Account.');
  }
  if (credentials.type !== 'service_account') throw new Error('O JSON não representa uma Service Account.');
  if (typeof credentials.client_email !== 'string' || !credentials.client_email.endsWith('.gserviceaccount.com')) {
    throw new Error('O JSON não contém um e-mail de Service Account válido.');
  }
  if (typeof credentials.private_key !== 'string' || !credentials.private_key.includes('BEGIN PRIVATE KEY')) {
    throw new Error('O JSON não contém uma chave privada válida.');
  }
  return credentials;
}

async function saveGoogleServiceAccount(credentials) {
  const temporary = `${GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE);
}

async function removeGoogleServiceAccount() {
  try {
    await unlink(GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function workspace(id) {
  assertSafeSegment(id, 'Workspace');
  const found = state.workspaces.find(item => item.id === id);
  if (!found) throw new Error('Workspace não encontrado.');
  return found;
}

function repository(workspaceId, repositoryId) {
  workspace(workspaceId);
  assertSafeSegment(repositoryId, 'Repositório');
  const found = state.repositories.find(item => item.workspaceId === workspaceId && item.id === repositoryId);
  if (!found) throw new Error('Repositório não encontrado.');
  return found;
}

let jobPersistence = Promise.resolve();
let jobHistoryTimer = null;

function retainRecentJobs() {
  const retained = pruneJobHistory(jobs);
  if (retained.length === jobs.length) return false;
  jobs.splice(0, jobs.length, ...retained);
  return true;
}

function enqueueJobPersistence() {
  retainRecentJobs();
  const jobsSnapshot = structuredClone(jobs);
  const write = jobPersistence.then(() => saveJobHistory(JOB_HISTORY_FILE, jobsSnapshot));
  jobPersistence = write.catch(() => {});
  return write;
}

function persistJobHistory() {
  if (jobHistoryTimer) clearTimeout(jobHistoryTimer);
  jobHistoryTimer = null;
  return enqueueJobPersistence();
}

function scheduleJobHistoryPersistence() {
  if (jobHistoryTimer) return;
  jobHistoryTimer = setTimeout(() => {
    jobHistoryTimer = null;
    void enqueueJobPersistence().catch(error => structuredLog('error', 'job_history_persist_failed', { error: error.message }));
  }, 500);
  jobHistoryTimer.unref();
}

async function persist() {
  if (jobHistoryTimer) clearTimeout(jobHistoryTimer);
  jobHistoryTimer = null;
  return stateMutex(async () => {
    await Promise.all([saveState(STATE_FILE, state), enqueueJobPersistence()]);
  });
}

async function refreshRepositoryProjects({ force = false } = {}) {
  if (!CBM_PROJECT_RECONCILE) return;
  if (projectReconciliation) return projectReconciliation;
  if (!force && Date.now() - lastProjectReconciliationAt < 30_000) return;
  lastProjectReconciliationAt = Date.now();
  projectReconciliation = (async () => {
    const result = await run(CBM_BIN, ['cli', 'list_projects']);
    let payload;
    try { payload = JSON.parse(result.stdout.trim()); }
    catch { payload = parseLastJsonLine(result.stdout); }
    if (!Array.isArray(payload?.projects)) throw new Error('list_projects retornou um formato inválido.');
    const reconciled = reconcileRepositoryProjects(state.repositories, payload.projects);
    if (reconciled.changed) {
      state.repositories = reconciled.repositories;
      await persist();
    }
  })();
  try { await projectReconciliation; }
  finally { projectReconciliation = null; }
}

function mcpUser(id) {
  assertSafeSegment(id, 'Usuário MCP');
  const found = mcpUserStore.users.find(item => item.id === id);
  if (!found) throw new Error('Usuário MCP não encontrado.');
  return found;
}

function mcpUserInput(input) {
  const name = String(input.name ?? '').trim().slice(0, 100);
  const identity = String(input.identity ?? '').trim().slice(0, 160);
  const description = String(input.description ?? '').trim().slice(0, 240);
  if (!name) throw new Error('Informe o nome do usuário MCP.');
  if (!identity) throw new Error('Informe o e-mail ou login do usuário MCP.');
  return { name, identity, description };
}

function mcpRepositoryIds(input, { required = true } = {}) {
  if (!Array.isArray(input)) throw new Error('A seleção de repositórios possui formato inválido.');
  const repositoryIds = [...new Set(input.map(value => String(value ?? '').trim()).filter(Boolean))];
  if (required && !repositoryIds.length) throw new Error('Selecione pelo menos um repositório para o usuário MCP.');
  if (repositoryIds.length > 500) throw new Error('A seleção excede o limite de 500 repositórios.');
  for (const repositoryId of repositoryIds) {
    if (!state.repositories.some(item => item.accessId === repositoryId)) {
      throw new Error('Um dos repositórios selecionados não existe mais. Atualize a seleção.');
    }
  }
  return repositoryIds;
}

function mcpAccess(userId) {
  const knownProjects = new Set(state.repositories.filter(item => item.project).map(item => item.project));
  if (userId === MCP_SYSTEM_USER.id) return { system: true, allowedProjects: new Set(), knownProjects };
  if (userId.startsWith('workspace:')) {
    const workspaceId = userId.slice('workspace:'.length);
    const selectedWorkspace = state.workspaces.find(item => item.id === workspaceId && item.mcpCredential?.status === 'active');
    if (!selectedWorkspace) return null;
    const allowedProjects = new Set(state.repositories
      .filter(item => item.workspaceId === workspaceId && item.project)
      .map(item => item.project));
    return { system: false, allowedProjects, knownProjects };
  }
  const user = mcpUserStore.users.find(item => item.id === userId && item.status === 'active');
  if (!user) return null;
  const allowedRepositoryIds = new Set(user.repositoryIds || []);
  const allowedProjects = new Set(state.repositories
    .filter(item => allowedRepositoryIds.has(item.accessId) && item.project)
    .map(item => item.project));
  return { system: false, allowedProjects, knownProjects };
}

async function commitMcpUserStoreOnly(nextStore) {
  if (mcpUserMutation) throw new Error('Outra alteração de usuários MCP está em andamento. Tente novamente.');
  mcpUserMutation = true;
  try {
    await saveMcpUserStore(MCP_USERS_FILE, nextStore);
    mcpUserStore = nextStore;
  } finally {
    mcpUserMutation = false;
  }
}

async function agentGatewayConfig(config) {
  const response = await fetch(`${AGENTGATEWAY_ADMIN_URL}/api/config`, config === undefined ? {
    signal: AbortSignal.timeout(5000)
  } : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
    signal: AbortSignal.timeout(10_000)
  });
  const raw = await response.text();
  if (!response.ok) {
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      detail = typeof parsed === 'string' ? parsed : parsed.error || parsed.message || JSON.stringify(parsed);
    } catch { /* use response text */ }
    throw new Error(`AgentGateway recusou a configuração: ${detail || `HTTP ${response.status}`}`);
  }
  if (config !== undefined) return;
  try { return JSON.parse(raw); } catch { throw new Error('O AgentGateway retornou uma configuração inválida.'); }
}

async function commitMcpUserChange(nextStore, changeGatewayConfig) {
  if (mcpUserMutation) throw new Error('Outra alteração de usuários MCP está em andamento. Tente novamente.');
  mcpUserMutation = true;
  let previousConfig;
  try {
    previousConfig = await agentGatewayConfig();
    const nextConfig = structuredClone(previousConfig);
    changeGatewayConfig(nextConfig);
    await agentGatewayConfig(nextConfig);
    try {
      await saveMcpUserStore(MCP_USERS_FILE, nextStore);
    } catch (error) {
      await agentGatewayConfig(previousConfig).catch(rollbackError => console.error('Falha ao restaurar configuração do AgentGateway:', rollbackError));
      throw error;
    }
    mcpUserStore = nextStore;
  } finally {
    mcpUserMutation = false;
  }
}

async function provisionMcpSystemToken() {
  if (!mcpSystemToken) {
    mcpSystemToken = generateMcpToken();
    await saveSecret(MCP_SYSTEM_TOKEN_FILE, mcpSystemToken);
  }
  let lastError;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const previousConfig = await agentGatewayConfig();
      const nextConfig = structuredClone(previousConfig);
      setMcpGatewayUserKey(nextConfig, MCP_SYSTEM_USER, mcpSystemToken);
      if (JSON.stringify(nextConfig) !== JSON.stringify(previousConfig)) await agentGatewayConfig(nextConfig);
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Não foi possível proteger o MCP com o token do sistema: ${lastError?.message}`);
}

async function rotateMcpSystemToken() {
  if (mcpUserMutation) throw new Error('Outra alteração de usuários MCP está em andamento. Tente novamente.');
  mcpUserMutation = true;
  const nextToken = generateMcpToken();
  let previousConfig;
  try {
    previousConfig = await agentGatewayConfig();
    const nextConfig = structuredClone(previousConfig);
    setMcpGatewayUserKey(nextConfig, MCP_SYSTEM_USER, nextToken);
    await agentGatewayConfig(nextConfig);
    try {
      await saveSecret(MCP_SYSTEM_TOKEN_FILE, nextToken);
    } catch (error) {
      await agentGatewayConfig(previousConfig).catch(rollbackError => console.error('Falha ao restaurar configuração do AgentGateway:', rollbackError));
      throw error;
    }
    mcpSystemToken = nextToken;
    return nextToken;
  } finally {
    mcpUserMutation = false;
  }
}

function issueMcpToken(user) {
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
}

function workspacePrincipal(selectedWorkspace) {
  return {
    id: `workspace:${selectedWorkspace.id}`,
    workspaceId: selectedWorkspace.id,
    name: selectedWorkspace.name,
    identity: `workspace:${selectedWorkspace.id}`
  };
}

function issueWorkspaceMcpCredential(selectedWorkspace) {
  const token = generateMcpToken();
  const now = new Date().toISOString();
  return {
    token,
    credential: {
      status: 'active',
      keyPrefix: `${token.slice(0, 16)}…`,
      tokenHash: mcpTokenFingerprint(token),
      encryptedToken: encryptWorkspaceToken(token, mcpWorkspaceEncryptionKey),
      tokenCreatedAt: now,
      updatedAt: now,
      revokedAt: null
    }
  };
}

async function commitWorkspaceChange(nextState, changeGatewayConfig) {
  if (mcpUserMutation) throw new Error('Outra alteração de credenciais MCP está em andamento. Tente novamente.');
  mcpUserMutation = true;
  let previousConfig;
  try {
    previousConfig = await agentGatewayConfig();
    const nextConfig = structuredClone(previousConfig);
    changeGatewayConfig(nextConfig);
    await agentGatewayConfig(nextConfig);
    try {
      await saveState(STATE_FILE, nextState);
    } catch (error) {
      await agentGatewayConfig(previousConfig).catch(rollbackError => console.error('Falha ao restaurar configuração do AgentGateway:', rollbackError));
      throw error;
    }
    state = nextState;
  } finally {
    mcpUserMutation = false;
  }
}

async function provisionWorkspaceMcpTokens() {
  const nextState = structuredClone(state);
  const issuedTokens = new Map();
  for (const selectedWorkspace of nextState.workspaces) {
    if (!selectedWorkspace.mcpCredential) {
      const issued = issueWorkspaceMcpCredential(selectedWorkspace);
      selectedWorkspace.mcpCredential = issued.credential;
      issuedTokens.set(selectedWorkspace.id, issued.token);
    }
  }
  if (mcpUserMutation) throw new Error('Outra alteração de credenciais MCP está em andamento. Tente novamente.');
  mcpUserMutation = true;
  let previousConfig;
  try {
    previousConfig = await agentGatewayConfig();
    const nextConfig = structuredClone(previousConfig);
    for (const selectedWorkspace of nextState.workspaces) {
      if (selectedWorkspace.mcpCredential.status !== 'active') continue;
      const token = issuedTokens.get(selectedWorkspace.id)
        || decryptWorkspaceToken(selectedWorkspace.mcpCredential.encryptedToken, mcpWorkspaceEncryptionKey);
      setMcpGatewayUserKey(nextConfig, workspacePrincipal(selectedWorkspace), token);
    }
    if (JSON.stringify(nextConfig) !== JSON.stringify(previousConfig)) await agentGatewayConfig(nextConfig);
    if (issuedTokens.size) {
      try { await saveState(STATE_FILE, nextState); }
      catch (error) {
        await agentGatewayConfig(previousConfig).catch(rollbackError => console.error('Falha ao restaurar configuração do AgentGateway:', rollbackError));
        throw error;
      }
      state = nextState;
    }
  } finally {
    mcpUserMutation = false;
  }
}

function publicRepository(item) {
  return { ...item, path: undefined };
}

function publicUpdateSchedule(selectedWorkspace) {
  const schedule = selectedWorkspace.updateSchedule;
  let nextRunAt = null;
  let configurationError = null;
  if (schedule.enabled) {
    try { nextRunAt = nextCronOccurrence(schedule.cron, schedule.timezone).toISOString(); }
    catch (error) { configurationError = error.message; }
  }
  let description;
  try { description = describeCron(schedule.cron); }
  catch { description = `Cron inválido: ${schedule.cron}`; }
  return { ...schedule, description, nextRunAt, configurationError };
}

async function github(endpoint, token = githubToken) {
  if (!token) throw new Error('Conecte o GitHub primeiro.');
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'codebase-memory-admin',
      'x-github-api-version': '2022-11-28'
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) throw new Error('Token do GitHub inválido ou expirado.');
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') throw new Error('O limite de requisições do GitHub foi atingido. Tente novamente mais tarde.');
    throw new Error(payload.message ? `GitHub: ${payload.message}` : `GitHub respondeu com HTTP ${response.status}.`);
  }
  return payload;
}

async function listGithubRepositories() {
  if (Date.now() - githubCache.at < 120_000) return githubCache.repositories;
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const items = await github(`/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&per_page=100&page=${page}`);
    all.push(...items);
    if (items.length < 100) break;
  }
  githubCache = {
    at: Date.now(),
    repositories: all.map(item => ({
      id: item.id,
      name: item.name,
      fullName: item.full_name,
      description: item.description,
      private: item.private,
      archived: item.archived,
      language: item.language,
      defaultBranch: item.default_branch,
      updatedAt: item.updated_at,
      cloneUrl: item.clone_url
    })).sort((a, b) => a.fullName.localeCompare(b.fullName))
  };
  return githubCache.repositories;
}

function createJob(type, label, lockKey, operation) {
  if (locks.has(lockKey)) throw new Error('Já existe uma operação em andamento para este recurso.');
  const job = { id: randomUUID(), type, label, status: 'queued', progress: 0, log: '', createdAt: new Date().toISOString() };
  addJob(job);
  locks.add(lockKey);
  gauge('cbm_jobs_active', locks.size);

  setImmediate(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    scheduleJobHistoryPersistence();
    const log = text => {
      job.log = `${job.log}${text}`.slice(-JOB_LOG_MAX_CHARACTERS);
      scheduleJobHistoryPersistence();
    };
    try {
      await operation(job, log);
      job.progress = 100;
      job.status = 'completed';
      increment('cbm_jobs_total', { type, status: 'completed' });
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      increment('cbm_jobs_total', { type, status: 'failed' });
      const [workspaceId, repositoryId] = lockKey.split('/');
      const affectedRepository = state.repositories.find(item => item.workspaceId === workspaceId && item.id === repositoryId);
      if (affectedRepository) affectedRepository.status = 'error';
      log(`\n${error.message}\n`);
    } finally {
      job.finishedAt = new Date().toISOString();
      observe('cbm_job_duration_seconds', (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000, { type, status: job.status });
      for (const item of state.repositories) if (item.activeJobId === job.id) delete item.activeJobId;
      locks.delete(lockKey);
      gauge('cbm_jobs_active', locks.size);
      await persist().catch(console.error);
    }
  });
  return job;
}

function addJob(job) {
  jobs.unshift(job);
  retainRecentJobs();
  scheduleJobHistoryPersistence();
  return job;
}

function takeSyncTask() {
  while (syncWorkspaceOrder.length) {
    const workspaceId = syncWorkspaceOrder.shift();
    const queue = syncQueues.get(workspaceId);
    if (!queue?.length) { syncQueues.delete(workspaceId); continue; }
    const task = queue.shift();
    if (queue.length) syncWorkspaceOrder.push(workspaceId);
    else syncQueues.delete(workspaceId);
    return task;
  }
  return null;
}

function pumpSyncQueue() {
  while (activeRepositorySyncs < REPOSITORY_SYNC_CONCURRENCY) {
    const task = takeSyncTask();
    if (!task) return;
    activeRepositorySyncs += 1;
    const { item, job, lockKey, resolve } = task;
    setImmediate(async () => {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      item.syncStatus = 'syncing';
      delete item.syncError;
      scheduleJobHistoryPersistence();
      const log = text => {
        job.log = `${job.log}${text}`.slice(-JOB_LOG_MAX_CHARACTERS);
        scheduleJobHistoryPersistence();
      };
      try {
        const previousCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: item.path })).stdout.trim();
        await run('git', ['pull', '--ff-only'], { cwd: item.path, env: gitAuthEnvironment(githubToken), onOutput: log });
        const currentCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: item.path })).stdout.trim();
        item.commit = currentCommit.slice(0, 7);
        item.lastSyncAt = new Date().toISOString();
        job.changed = previousCommit !== currentCommit;
        if (job.changed) item.indexPending = true;
        if (item.indexPending) {
          log(job.changed
            ? '\nRepositório atualizado; iniciando reindexação...\n'
            : '\nTentando novamente a reindexação pendente...\n');
          await indexRepository(item, log);
          delete item.indexPending;
          job.indexed = true;
          log('\nReindexação concluída.\n');
        } else {
          log('\nRepositório sem alterações.\n');
        }
        item.syncStatus = 'idle';
        job.status = 'completed';
        job.progress = 100;
      } catch (error) {
        item.syncStatus = 'error';
        item.syncError = error.message;
        job.status = 'failed';
        job.error = error.message;
        log(`\n${error.message}\n`);
      } finally {
        job.finishedAt = new Date().toISOString();
        if (item.activeJobId === job.id) delete item.activeJobId;
        locks.delete(lockKey);
        activeRepositorySyncs -= 1;
        await persist().catch(console.error);
        resolve(job);
        pumpSyncQueue();
      }
    });
  }
}

function enqueueRepositorySync(item, { source = 'manual', parentJobId = null, deferPump = false } = {}) {
  const lockKey = `${item.workspaceId}/${item.id}`;
  if (locks.has(lockKey)) throw new Error('Já existe uma operação em andamento para este recurso.');
  locks.add(lockKey);
  const job = addJob({
    id: randomUUID(), type: 'sync', label: `Sincronizando ${item.fullName}`, status: 'queued', progress: 0, log: '',
    source, parentJobId, workspaceId: item.workspaceId, repositoryId: item.id, createdAt: new Date().toISOString()
  });
  let resolve;
  const completion = new Promise(done => { resolve = done; });
  const queue = syncQueues.get(item.workspaceId) || [];
  if (!syncQueues.has(item.workspaceId)) syncWorkspaceOrder.push(item.workspaceId);
  queue.push({ item, job, lockKey, resolve });
  syncQueues.set(item.workspaceId, queue);
  item.activeJobId = job.id;
  if (!deferPump) pumpSyncQueue();
  return { job, completion };
}

async function indexRepository(item, log) {
  item.status = 'indexing';
  const result = await run(CBM_BIN, indexRepositoryArguments(item.path), { onOutput: log });
  const indexed = parseLastJsonLine(result.stdout);
  if (indexed?.project) item.project = indexed.project;
  item.status = 'indexed';
  item.lastIndexedAt = new Date().toISOString();
  clearSemanticCache();
}

function runWorkspaceIndex(selectedWorkspace) {
  const repositories = state.repositories.filter(item => item.workspaceId === selectedWorkspace.id);
  if (!repositories.length) throw new Error('Este workspace não possui repositórios para indexar.');
  return createJob('workspace-index', `Indexando workspace ${selectedWorkspace.name}`, `workspace-index/${selectedWorkspace.id}`, async (job, log) => {
    job.totalRepositories = repositories.length;
    job.completedRepositories = 0;
    const failures = [];
    for (const item of repositories) {
      const repositoryLock = `${item.workspaceId}/${item.id}`;
      if (locks.has(repositoryLock)) {
        log(`${item.fullName}: ignorado porque já existe uma operação em andamento.\n`);
      } else {
        locks.add(repositoryLock);
        item.activeJobId = job.id;
        log(`\nIndexando ${item.fullName}...\n`);
        try {
          await indexRepository(item, log);
        } catch (error) {
          item.status = 'error';
          failures.push(`${item.fullName}: ${error.message}`);
          log(`${item.fullName}: ${error.message}\n`);
        } finally {
          locks.delete(repositoryLock);
        }
      }
      job.completedRepositories += 1;
      job.progress = Math.round(job.completedRepositories / repositories.length * 100);
      await persist();
    }
    if (failures.length) throw new Error(`${failures.length} repositório(s) falharam durante a indexação.`);
  });
}

async function runWorkspaceSync(selectedWorkspace, source = 'schedule') {
  if (activeWorkspaceSyncs.has(selectedWorkspace.id)) throw new Error('Já existe uma sincronização do workspace em andamento.');
  activeWorkspaceSyncs.add(selectedWorkspace.id);
  const repositories = state.repositories.filter(item => item.workspaceId === selectedWorkspace.id);
  const parent = addJob({
    id: randomUUID(), type: 'workspace-sync', label: `Atualizando workspace ${selectedWorkspace.name}`, status: 'running',
    progress: repositories.length ? 0 : 100, log: '', source, workspaceId: selectedWorkspace.id,
    totalRepositories: repositories.length, completedRepositories: 0, createdAt: new Date().toISOString(), startedAt: new Date().toISOString()
  });
  const completions = [];
  let skipped = 0;
  for (const item of repositories) {
    try {
      const queued = enqueueRepositorySync(item, { source, parentJobId: parent.id, deferPump: true });
      completions.push(queued.completion.then(job => {
        parent.completedRepositories += 1;
        parent.progress = Math.round(parent.completedRepositories / Math.max(1, parent.totalRepositories) * 100);
        return job;
      }));
    } catch (error) {
      skipped += 1;
      parent.completedRepositories += 1;
      parent.progress = Math.round(parent.completedRepositories / Math.max(1, parent.totalRepositories) * 100);
      parent.log += `${item.fullName}: ignorado (${error.message})\n`;
    }
  }
  pumpSyncQueue();
  void (async () => {
    try {
      const results = await Promise.all(completions);
      const failed = results.filter(job => job.status === 'failed').length;
      const changed = results.filter(job => job.changed).length;
      const indexed = results.filter(job => job.indexed).length;
      const unchanged = results.filter(job => job.status === 'completed' && !job.changed).length;
      parent.status = failed ? 'failed' : 'completed';
      parent.progress = 100;
      parent.finishedAt = new Date().toISOString();
      parent.log += `${changed} atualizado(s), ${indexed} reindexado(s), ${unchanged} sem alterações, ${failed} falha(s), ${skipped} ignorado(s).`;
      const schedule = selectedWorkspace.updateSchedule;
      schedule.lastRunAt = parent.finishedAt;
      schedule.lastRunStatus = parent.status;
    } catch (error) {
      parent.status = 'failed';
      parent.error = error.message;
      parent.progress = 100;
      parent.finishedAt = new Date().toISOString();
      parent.log += `\nErro inesperado na conclusão da sincronização: ${error.message}\n`;
      structuredLog('error', 'workspace_sync_completion_failed', { workspaceId: selectedWorkspace.id, error: error.message });
    } finally {
      activeWorkspaceSyncs.delete(selectedWorkspace.id);
      await persist().catch(console.error);
    }
  })();
  return parent;
}

const router = createRouter();

const ctx = {
  get state() { return state; },
  set state(v) { state = v; },
  config: {
    REPOSITORIES_DIR,
    REPOSITORY_SYNC_CONCURRENCY,
    WORKSPACE_TIMEZONE,
    DEFAULT_WORKSPACE_CRON,
    GITHUB_CREDENTIALS_FILE,
    KNOWLEDGE_SYNC_ENABLED,
    KNOWLEDGE_SYNC_URL,
    AGENTGATEWAY_ADMIN_URL,
    UI_PORT,
    GRAFANA_PUBLIC_URL,
    MCP_PUBLIC_URL,
    MCP_SYSTEM_USER,
    ADMIN_COOKIE_SECURE
  },
  adminAuth,
  loginAttempts,
  github: {
    get token() { return githubToken; },
    set token(v) { githubToken = v; },
    get user() { return githubUser; },
    set user(v) { githubUser = v; },
    get cache() { return githubCache; },
    set cache(v) { githubCache = v; }
  },
  get githubToken() { return githubToken; },
  saveCredentials,
  removeFile: file => rm(file, { force: true }),
  jobs,
  retainRecentJobs,
  scheduleJobHistoryPersistence,
  knowledgeSyncRequest,
  validateGoogleServiceAccount,
  saveGoogleServiceAccount,
  removeGoogleServiceAccount,
  mcp: {
    get userStore() { return mcpUserStore; },
    set userStore(v) { mcpUserStore = v; },
    get systemToken() { return mcpSystemToken; },
    get workspaceEncryptionKey() { return mcpWorkspaceEncryptionKey; }
  },
  commitMcpUserChange,
  commitMcpUserStoreOnly,
  issueMcpToken,
  rotateMcpSystemToken,
  refreshRepositoryProjects,
  workspace,
  repository,
  persist,
  createJob,
  enqueueRepositorySync,
  runWorkspaceSync,
  runWorkspaceIndex,
  commitWorkspaceChange,
  issueWorkspaceMcpCredential,
  workspacePrincipal,
  listGithubRepositories,
  indexRepository,
  locks,
  activeWorkspaceSyncs,
  setMcpGatewayUserKey,
  removeMcpGatewayUserKey,
  defaultUpdateSchedule
};

registerAuth(router, ctx);
registerHealth(router, ctx);
registerGithub(router, ctx);
registerJobs(router, ctx);
registerKnowledgeSync(router, ctx);
registerMcpUsers(router, ctx);
registerWorkspaces(router, ctx);

function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname === '/login' ? 'login.html' : pathname.slice(1);
  const file = safeChild(PUBLIC_DIR, requested);
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  stat(file).then(info => {
    if (!info.isFile()) throw new Error('not found');
    response.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': path.extname(file) === '.html' ? 'no-store' : 'private, max-age=300'
    });
    createReadStream(file).pipe(response);
  }).catch(() => { response.writeHead(404); response.end('Not found'); });
}

if (CBM_PROJECT_RECONCILE) {
  await refreshRepositoryProjects({ force: true }).catch(error => console.warn('Não foi possível reconciliar os IDs MCP dos repositórios:', error.message));
  setInterval(() => refreshRepositoryProjects({ force: true }).catch(error => console.warn('Falha ao reconciliar IDs MCP:', error.message)), 300_000).unref();
}

async function checkWorkspaceSchedules(now = new Date()) {
  const scheduledMinute = now.toISOString().slice(0, 16);
  let changed = false;
  for (const selectedWorkspace of state.workspaces) {
    const schedule = selectedWorkspace.updateSchedule;
    if (!schedule?.enabled || schedule.lastScheduledMinute === scheduledMinute) continue;
    let matches = false;
    try { matches = cronMatches(schedule.cron, now, schedule.timezone); }
    catch (error) { console.warn(`Cron inválido no workspace ${selectedWorkspace.id}:`, error.message); }
    if (!matches) continue;
    schedule.lastScheduledMinute = scheduledMinute;
    changed = true;
    if (activeWorkspaceSyncs.has(selectedWorkspace.id)) {
      schedule.lastRunAt = now.toISOString();
      schedule.lastRunStatus = 'skipped';
      continue;
    }
    try { await runWorkspaceSync(selectedWorkspace, 'schedule'); }
    catch (error) {
      schedule.lastRunAt = now.toISOString();
      schedule.lastRunStatus = 'failed';
      console.warn(`Falha ao agendar workspace ${selectedWorkspace.id}:`, error.message);
    }
  }
  if (changed) await persist();
}

await checkWorkspaceSchedules().catch(error => console.warn('Falha ao verificar rotinas:', error.message));
setInterval(() => checkWorkspaceSchedules().catch(error => console.warn('Falha ao verificar rotinas:', error.message)), 15_000).unref();
setInterval(() => {
  if (retainRecentJobs()) void persistJobHistory().catch(error => structuredLog('error', 'job_history_cleanup_failed', { error: error.message }));
}, 60 * 60 * 1000).unref();
await startMcpGuardrailServer(mcpAccess, MCP_GUARDRAIL_ADDR);
await provisionMcpSystemToken();
await provisionWorkspaceMcpTokens();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const isPublic = url.pathname.startsWith('/api/auth/') ||
        ['/api/health', '/api/health/live', '/api/health/ready', '/api/health/detail', '/api/metrics'].includes(url.pathname);
      if (!isPublic) {
        if (!adminAuth.session(request)) return json(response, 401, { error: 'Autenticação necessária.' });
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !requestOriginAllowed(request)) {
          return json(response, 403, { error: 'Origem não permitida.' });
        }
      }
      const match = router.match(request.method, url.pathname);
      if (match) {
        return await match.handler(request, response, url, match.params);
      }
      return json(response, 404, { error: 'Rota não encontrada.' });
    }
    const publicAsset = ['/login', '/login.html', '/login.js', '/styles.css'].includes(url.pathname);
    const session = adminAuth.session(request);
    if (publicAsset) {
      if (session && ['/login', '/login.html'].includes(url.pathname)) return redirect(response, '/');
      return serveStatic(response, url.pathname);
    }
    if (!session) return redirect(response, '/login');
    serveStatic(response, url.pathname);
  } catch (error) { errorResponse(response, error); }
});

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  structuredLog('info', 'shutdown_started', { signal });
  server.close(() => structuredLog('info', 'http_server_closed'));
  try {
    await persist();
  } catch (error) {
    structuredLog('error', 'shutdown_persist_failed', { error: error.message });
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of loginAttempts.entries()) {
    if (value.resetAt <= now) loginAttempts.delete(key);
  }
}, 10 * 60_000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`Codebase Memory Admin em http://0.0.0.0:${PORT}`));
