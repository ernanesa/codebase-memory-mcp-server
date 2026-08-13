import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeSegment, DEFAULT_TIMEZONE, DEFAULT_WORKSPACE_CRON, cronMatches, decryptWorkspaceToken, describeCron, encryptWorkspaceToken, generateMcpToken, gitAuthEnvironment, indexRepositoryArguments, loadCredentials, loadMcpUserStore, loadSecret, loadState, mcpTokenFingerprint, nextCronOccurrence, parseCronExpression, parseLastJsonLine, publicMcpUser, publicWorkspace, reconcileRepositoryProjects, removeMcpGatewayUserKey, run, safeChild, saveCredentials, saveMcpUserStore, saveSecret, saveState, setMcpGatewayUserKey, slugify, validateTimezone } from './lib.js';
import { startMcpGuardrailServer } from './mcp-guardrail.js';
import { gauge, increment, log as structuredLog, metricsText, observe } from './observability.js';
import { createAdminAuth } from './auth.js';
import { JOB_HISTORY_RETENTION_DAYS, JOB_LOG_MAX_CHARACTERS, loadJobHistory, paginateJobs, pruneJobHistory, recoverInterruptedJobs, saveJobHistory } from './job-history.js';

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
let mcpUserMutation = false;
let projectReconciliation = null;
let lastProjectReconciliationAt = 0;
const MCP_SYSTEM_USER = {
  id: 'system-playground',
  name: 'Sistema / Playground',
  identity: 'system@local'
};

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function errorResponse(response, error, status = error.status || 400) {
  structuredLog('error', 'request_failed', { status, error: error.message });
  json(response, status, { error: error.message || 'Erro inesperado.' });
}

function textResponse(response, status, payload, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(payload);
}

function redirect(response, location) {
  response.writeHead(302, { location, 'cache-control': 'no-store' });
  response.end();
}

function secureRequest(request) {
  return ADMIN_COOKIE_SECURE || String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function requestOriginAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();
    return new URL(origin).host === host;
  } catch { return false; }
}

function clientAddress(request) {
  return String(request.headers['x-real-ip'] || request.socket.remoteAddress || 'unknown');
}

function loginAllowed(request) {
  const key = clientAddress(request);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) return true;
  return current.failures < 5;
}

function registerLoginFailure(request) {
  const key = clientAddress(request);
  const now = Date.now();
  const current = loginAttempts.get(key);
  loginAttempts.set(key, !current || current.resetAt <= now
    ? { failures: 1, resetAt: now + 5 * 60_000 }
    : { ...current, failures: current.failures + 1 });
}

async function routeAuth(request, response, url) {
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    if (!requestOriginAllowed(request)) return json(response, 403, { error: 'Origem não permitida.' });
    if (!loginAllowed(request)) return json(response, 429, { error: 'Muitas tentativas. Aguarde alguns minutos.' });
    const payload = await body(request);
    if (!await adminAuth.verifyCredentials(payload.username, payload.password)) {
      registerLoginFailure(request);
      return json(response, 401, { error: 'Usuário ou senha inválidos.' });
    }
    loginAttempts.delete(clientAddress(request));
    const token = adminAuth.issueToken();
    response.setHeader('set-cookie', adminAuth.sessionCookie(token, secureRequest(request)));
    return json(response, 200, { user: { username: adminAuth.username, role: 'admin' } });
  }
  if (url.pathname === '/api/auth/session' && request.method === 'GET') {
    const session = adminAuth.session(request);
    return session
      ? json(response, 200, { user: { username: session.sub, role: session.role } })
      : json(response, 401, { error: 'Autenticação necessária.' });
  }
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    if (!requestOriginAllowed(request)) return json(response, 403, { error: 'Origem não permitida.' });
    adminAuth.revoke(adminAuth.tokenFromRequest(request));
    response.setHeader('set-cookie', adminAuth.clearCookie(secureRequest(request)));
    return json(response, 200, { ok: true });
  }
  return json(response, 404, { error: 'Rota não encontrada.' });
}

async function probe(name, url, options = {}) {
  const started = performance.now();
  try {
    const result = await fetch(url, { ...options, signal: AbortSignal.timeout(3_000) });
    return { name, ok: result.status < 500, status: result.status, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { name, ok: false, error: error.message, durationMs: Math.round(performance.now() - started) };
  }
}

async function dependencyHealth() {
  const checks = await Promise.all([
    probe('agentgateway', `${AGENTGATEWAY_ADMIN_URL}/`),
    ...(KNOWLEDGE_SYNC_ENABLED ? [probe('knowledge-sync', `${KNOWLEDGE_SYNC_URL}/health/ready`)] : [])
  ]);
  return { status: checks.every(check => check.ok) ? 'ready' : 'not_ready', checks };
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
  const temporary = `${GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE}.tmp`;
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
  await Promise.all([saveState(STATE_FILE, state), enqueueJobPersistence()]);
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
    activeWorkspaceSyncs.delete(selectedWorkspace.id);
    await persist().catch(console.error);
  })();
  return parent;
}

async function routeApi(request, response, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);

  if (request.method === 'GET' && url.pathname === '/api/health') {
    return json(response, 200, { status: 'ok' });
  }
  if (request.method === 'GET' && url.pathname === '/api/health/live') return json(response, 200, { status: 'ok' });
  if (request.method === 'GET' && ['/api/health/ready', '/api/health/detail'].includes(url.pathname)) {
    const health = await dependencyHealth();
    return json(response, health.status === 'ready' ? 200 : 503, health);
  }
  if (request.method === 'GET' && url.pathname === '/api/metrics') {
    let combined = metricsText();
    if (KNOWLEDGE_SYNC_ENABLED) {
      try {
        const worker = await fetch(`${KNOWLEDGE_SYNC_URL}/metrics`, { signal: AbortSignal.timeout(3_000) });
        if (worker.ok) combined += await worker.text();
      } catch (error) {
        structuredLog('warn', 'worker_metrics_unavailable', { error: error.message });
      }
    }
    return textResponse(response, 200, combined, 'text/plain; version=0.0.4; charset=utf-8');
  }
  if (request.method === 'GET' && url.pathname === '/api/config') {
    return json(response, 200, {
      uiPort: UI_PORT,
      knowledgeSyncEnabled: KNOWLEDGE_SYNC_ENABLED,
      grafanaUrl: GRAFANA_PUBLIC_URL,
      mcpUrl: MCP_PUBLIC_URL
    });
  }
  if (url.pathname === '/api/knowledge-sync/credentials') {
    if (request.method === 'GET') {
      const result = await knowledgeSyncRequest('/api/status');
      return json(response, result.status, result.result);
    }
    if (request.method === 'PUT') {
      const payload = await body(request);
      const credentials = validateGoogleServiceAccount(payload.credentials ?? payload);
      await saveGoogleServiceAccount(credentials);
      const result = await knowledgeSyncRequest('/api/status');
      return json(response, 200, result.result);
    }
    if (request.method === 'DELETE') {
      await knowledgeSyncRequest('/api/targets/drive-credentials-removed', { method: 'POST', payload: {} });
      await removeGoogleServiceAccount();
      const status = await knowledgeSyncRequest('/api/status');
      return json(response, 200, status.result);
    }
    return json(response, 405, { error: 'Método não permitido.' });
  }
  if (url.pathname.startsWith('/api/knowledge-sync')) {
    const workerPath = `/api${url.pathname.slice('/api/knowledge-sync'.length)}${url.search}`;
    const payload = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await body(request) : undefined;
    const result = await knowledgeSyncRequest(workerPath, { method: request.method, payload });
    return json(response, result.status, result.result);
  }
  if (url.pathname === '/api/mcp-system-token/reveal' && request.method === 'POST') {
    return json(response, 200, { token: mcpSystemToken, name: MCP_SYSTEM_USER.name });
  }
  if (url.pathname === '/api/mcp-system-token/rotate' && request.method === 'POST') {
    const token = await rotateMcpSystemToken();
    return json(response, 200, { token, name: MCP_SYSTEM_USER.name });
  }
  if (url.pathname === '/api/mcp-users') {
    if (request.method === 'GET') {
      return json(response, 200, {
        users: mcpUserStore.users.map(publicMcpUser),
        accessMode: 'strict',
        systemAccess: true
      });
    }
    if (request.method === 'POST') {
      const payload = await body(request);
      const input = mcpUserInput(payload);
      const repositoryIds = mcpRepositoryIds(payload.repositoryIds);
      if (mcpUserStore.users.some(item => item.identity.toLowerCase() === input.identity.toLowerCase())) {
        throw new Error('Já existe um usuário MCP com esse e-mail ou login.');
      }
      const now = new Date().toISOString();
      const issued = issueMcpToken({ id: randomUUID(), ...input, repositoryIds, createdAt: now });
      const nextStore = { managed: true, users: [...mcpUserStore.users, issued.user] };
      await commitMcpUserChange(nextStore, config => setMcpGatewayUserKey(config, issued.user, issued.token));
      return json(response, 201, { user: publicMcpUser(issued.user), token: issued.token });
    }
  }
  if (url.pathname === '/api/mcp-access-options' && request.method === 'GET') {
    await refreshRepositoryProjects().catch(error => console.warn('Não foi possível atualizar os IDs MCP dos repositórios:', error.message));
    return json(response, 200, {
      workspaces: state.workspaces.map(item => ({
        id: item.id,
        name: item.name,
        repositories: state.repositories
          .filter(repository => repository.workspaceId === item.id)
          .map(repository => ({
            id: repository.accessId,
            name: repository.name,
            fullName: repository.fullName,
            indexed: Boolean(repository.project),
            project: repository.project || null
          }))
          .sort((a, b) => a.fullName.localeCompare(b.fullName))
      }))
    });
  }
  if (parts[0] === 'mcp-users' && parts[1]) {
    const selected = mcpUser(parts[1]);
    if (parts.length === 3 && parts[2] === 'repositories' && request.method === 'PUT') {
      const payload = await body(request);
      const repositoryIds = mcpRepositoryIds(payload.repositoryIds);
      const updated = { ...selected, repositoryIds, updatedAt: new Date().toISOString() };
      const nextStore = { managed: true, users: mcpUserStore.users.map(item => item.id === selected.id ? updated : item) };
      await commitMcpUserStoreOnly(nextStore);
      return json(response, 200, { user: publicMcpUser(updated) });
    }
    if (parts.length === 2 && request.method === 'DELETE') {
      const nextStore = { managed: true, users: mcpUserStore.users.filter(item => item.id !== selected.id) };
      await commitMcpUserChange(nextStore, config => removeMcpGatewayUserKey(config, selected.id));
      return json(response, 200, { deleted: true });
    }
    if (parts.length === 3 && parts[2] === 'revoke' && request.method === 'POST') {
      if (selected.status === 'revoked') throw new Error('O token deste usuário já está revogado.');
      const now = new Date().toISOString();
      const updated = { ...selected, status: 'revoked', updatedAt: now, revokedAt: now };
      const nextStore = { managed: true, users: mcpUserStore.users.map(item => item.id === selected.id ? updated : item) };
      await commitMcpUserChange(nextStore, config => removeMcpGatewayUserKey(config, selected.id));
      return json(response, 200, { user: publicMcpUser(updated) });
    }
    if (parts.length === 3 && (parts[2] === 'rotate' || parts[2] === 'reactivate') && request.method === 'POST') {
      if (parts[2] === 'rotate' && selected.status !== 'active') throw new Error('Reative o usuário antes de rotacionar seu token.');
      if (parts[2] === 'reactivate' && selected.status !== 'revoked') throw new Error('Este usuário já está ativo.');
      const issued = issueMcpToken(selected);
      const nextStore = { managed: true, users: mcpUserStore.users.map(item => item.id === selected.id ? issued.user : item) };
      await commitMcpUserChange(nextStore, config => setMcpGatewayUserKey(config, issued.user, issued.token));
      return json(response, 200, { user: publicMcpUser(issued.user), token: issued.token });
    }
  }
  if (url.pathname === '/api/github/connection') {
    if (request.method === 'GET') return json(response, 200, { connected: Boolean(githubToken), user: githubUser });
    if (request.method === 'POST') {
      const input = await body(request);
      const token = String(input.token ?? '').trim();
      const user = await github('/user', token);
      const persistedUser = { login: user.login, name: user.name, avatarUrl: user.avatar_url };
      await saveCredentials(GITHUB_CREDENTIALS_FILE, { token, user: persistedUser });
      githubToken = token;
      githubUser = persistedUser;
      githubCache = { at: 0, repositories: [] };
      return json(response, 200, { connected: true, user: githubUser });
    }
    if (request.method === 'DELETE') {
      await rm(GITHUB_CREDENTIALS_FILE, { force: true });
      githubToken = ''; githubUser = null; githubCache = { at: 0, repositories: [] };
      return json(response, 200, { connected: false });
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/github/repositories') {
    const search = (url.searchParams.get('search') || '').toLowerCase();
    const repositories = (await listGithubRepositories()).filter(item => !search || `${item.fullName} ${item.description || ''}`.toLowerCase().includes(search));
    return json(response, 200, { repositories });
  }
  if (url.pathname === '/api/workspaces' && request.method === 'GET') {
    return json(response, 200, { workspaces: state.workspaces.map(item => ({ ...publicWorkspace(item), updateSchedule: publicUpdateSchedule(item), repositoryCount: state.repositories.filter(repo => repo.workspaceId === item.id).length })) });
  }
  if (url.pathname === '/api/workspaces' && request.method === 'POST') {
    const input = await body(request);
    const name = String(input.name ?? '').trim();
    const id = slugify(name);
    if (!name || !id) throw new Error('Informe um nome válido para o workspace.');
    if (state.workspaces.some(item => item.id === id)) throw new Error('Já existe um workspace com esse nome.');
    const item = { id, name: name.slice(0, 80), description: String(input.description ?? '').trim().slice(0, 240), updateSchedule: defaultUpdateSchedule(), createdAt: new Date().toISOString() };
    const issued = issueWorkspaceMcpCredential(item);
    item.mcpCredential = issued.credential;
    await mkdir(safeChild(REPOSITORIES_DIR, id), { recursive: true });
    const nextState = { ...state, workspaces: [...state.workspaces, item] };
    try {
      await commitWorkspaceChange(nextState, config => setMcpGatewayUserKey(config, workspacePrincipal(item), issued.token));
    } catch (error) {
      await rmdir(safeChild(REPOSITORIES_DIR, id)).catch(() => {});
      throw error;
    }
    return json(response, 201, { workspace: publicWorkspace(item), token: issued.token });
  }

  if (parts[0] === 'workspaces' && parts[1]) {
    const workspaceId = parts[1];
    const selectedWorkspace = workspace(workspaceId);
    if (parts.length === 2 && request.method === 'GET') {
      return json(response, 200, { workspace: { ...publicWorkspace(selectedWorkspace), updateSchedule: publicUpdateSchedule(selectedWorkspace) }, repositories: state.repositories.filter(item => item.workspaceId === workspaceId).map(publicRepository) });
    }
    if (parts.length === 2 && request.method === 'DELETE') {
      if (state.repositories.some(item => item.workspaceId === workspaceId)) throw new Error('Remova os repositórios antes de excluir o workspace.');
      const directory = safeChild(REPOSITORIES_DIR, workspaceId);
      const remainingFiles = await readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      if (remainingFiles.length) throw new Error('A pasta do workspace contém arquivos não gerenciados e não pode ser excluída.');
      const nextState = { ...state, workspaces: state.workspaces.filter(item => item.id !== workspaceId) };
      await rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
      try {
        await commitWorkspaceChange(nextState, config => removeMcpGatewayUserKey(config, workspacePrincipal(selectedWorkspace).id));
      } catch (error) {
        await mkdir(directory, { recursive: true }).catch(() => {});
        throw error;
      }
      return json(response, 200, { deleted: true });
    }
    if (parts[2] === 'mcp-token' && parts.length === 4) {
      if (parts[3] === 'reveal' && request.method === 'POST') {
        if (!selectedWorkspace.mcpCredential) throw new Error('O workspace ainda não possui credencial MCP.');
        const token = decryptWorkspaceToken(selectedWorkspace.mcpCredential.encryptedToken, mcpWorkspaceEncryptionKey);
        return json(response, 200, { name: selectedWorkspace.name, token });
      }
      if ((parts[3] === 'rotate' || parts[3] === 'reactivate') && request.method === 'POST') {
        if (parts[3] === 'rotate' && selectedWorkspace.mcpCredential?.status !== 'active') throw new Error('Reative o token antes de rotacioná-lo.');
        if (parts[3] === 'reactivate' && selectedWorkspace.mcpCredential?.status === 'active') throw new Error('O token deste workspace já está ativo.');
        const nextState = structuredClone(state);
        const nextWorkspace = nextState.workspaces.find(item => item.id === workspaceId);
        const issued = issueWorkspaceMcpCredential(nextWorkspace);
        nextWorkspace.mcpCredential = issued.credential;
        await commitWorkspaceChange(nextState, config => setMcpGatewayUserKey(config, workspacePrincipal(nextWorkspace), issued.token));
        return json(response, 200, { workspace: publicWorkspace(nextWorkspace), token: issued.token });
      }
      if (parts[3] === 'revoke' && request.method === 'POST') {
        if (selectedWorkspace.mcpCredential?.status !== 'active') throw new Error('O token deste workspace já está revogado.');
        const nextState = structuredClone(state);
        const nextWorkspace = nextState.workspaces.find(item => item.id === workspaceId);
        const now = new Date().toISOString();
        nextWorkspace.mcpCredential = { ...nextWorkspace.mcpCredential, status: 'revoked', revokedAt: now, updatedAt: now };
        await commitWorkspaceChange(nextState, config => removeMcpGatewayUserKey(config, workspacePrincipal(nextWorkspace).id));
        return json(response, 200, { workspace: publicWorkspace(nextWorkspace) });
      }
    }
    if (parts[2] === 'schedule' && parts.length === 3) {
      if (request.method === 'GET') return json(response, 200, { schedule: publicUpdateSchedule(selectedWorkspace), concurrency: REPOSITORY_SYNC_CONCURRENCY });
      if (request.method === 'PUT') {
        const input = await body(request);
        const cron = parseCronExpression(input.cron).expression;
        const timezone = validateTimezone(input.timezone);
        const enabled = input.enabled === undefined ? selectedWorkspace.updateSchedule.enabled : input.enabled;
        if (typeof enabled !== 'boolean') throw new Error('O estado da rotina deve ser verdadeiro ou falso.');
        selectedWorkspace.updateSchedule = { ...selectedWorkspace.updateSchedule, cron, timezone, enabled, updatedAt: new Date().toISOString(), lastScheduledMinute: null };
        await persist();
        return json(response, 200, { schedule: publicUpdateSchedule(selectedWorkspace), concurrency: REPOSITORY_SYNC_CONCURRENCY });
      }
    }
    if (parts[2] === 'schedule' && parts[3] === 'run' && request.method === 'POST') {
      const job = await runWorkspaceSync(selectedWorkspace, 'manual');
      await persist();
      return json(response, 202, job);
    }
    if (parts[2] === 'index' && parts.length === 3 && request.method === 'POST') {
      const job = runWorkspaceIndex(selectedWorkspace);
      await persist();
      return json(response, 202, job);
    }
    if (parts[2] === 'repositories' && parts.length === 3 && request.method === 'POST') {
      const input = await body(request);
      if (!Array.isArray(input.repositories) || !input.repositories.length) throw new Error('Selecione pelo menos um repositório.');
      const available = await listGithubRepositories();
      const selected = input.repositories.map(fullName => available.find(item => item.fullName === fullName));
      if (selected.some(item => !item)) throw new Error('Um dos repositórios selecionados não está disponível.');
      const requestedIds = new Map();
      for (const remote of selected) {
        const repositoryId = slugify(remote.name);
        const collision = requestedIds.get(repositoryId) || state.repositories.find(item => item.workspaceId === workspaceId && item.id === repositoryId && item.fullName !== remote.fullName)?.fullName;
        if (collision) throw new Error(`Os repositórios ${collision} e ${remote.fullName} usam o mesmo nome de pasta. Adicione-os em workspaces diferentes.`);
        requestedIds.set(repositoryId, remote.fullName);
      }
      const created = [];
      for (const remote of selected) {
        const id = slugify(remote.name);
        if (state.repositories.some(item => item.workspaceId === workspaceId && item.id === id)) continue;
        const target = safeChild(REPOSITORIES_DIR, workspaceId, id);
        const item = { id, accessId: randomUUID(), workspaceId, name: remote.name, fullName: remote.fullName, description: remote.description, private: remote.private, language: remote.language, defaultBranch: remote.defaultBranch, status: 'cloning', path: target, createdAt: new Date().toISOString() };
        state.repositories.push(item);
        const job = createJob('clone', `Clonando ${remote.fullName}`, `${workspaceId}/${id}`, async (currentJob, log) => {
          await run('git', ['clone', remote.cloneUrl, target], { env: gitAuthEnvironment(githubToken), onOutput: log });
          const commit = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: target })).stdout.trim();
          item.status = 'ready'; item.commit = commit; item.lastSyncAt = new Date().toISOString(); currentJob.progress = 100;
        });
        item.activeJobId = job.id;
        created.push(publicRepository(item));
      }
      await persist();
      return json(response, 202, { repositories: created });
    }
    if (parts[2] === 'repositories' && parts[3]) {
      const item = repository(workspaceId, parts[3]);
      if (parts.length === 4 && request.method === 'DELETE') {
        if (locks.has(`${workspaceId}/${item.id}`)) throw new Error('Aguarde a operação atual terminar.');
        await rm(item.path, { recursive: true, force: true });
        state.repositories = state.repositories.filter(repo => repo !== item);
        await persist();
        return json(response, 200, { deleted: true });
      }
      if (parts[4] === 'sync' && request.method === 'POST') {
        const { job } = enqueueRepositorySync(item);
        await persist();
        return json(response, 202, job);
      }
      if (parts[4] === 'index' && request.method === 'POST') {
        const job = createJob('index', `Indexando ${item.fullName}`, `${workspaceId}/${item.id}`, async (_job, log) => {
          await indexRepository(item, log);
        });
        item.activeJobId = job.id; await persist(); return json(response, 202, job);
      }
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/jobs') {
    if (retainRecentJobs()) scheduleJobHistoryPersistence();
    const result = paginateJobs(jobs, { page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize') });
    const activeCount = jobs.filter(job => ['queued', 'running'].includes(job.status)).length;
    return json(response, 200, { ...result, activeCount, retentionDays: JOB_HISTORY_RETENTION_DAYS });
  }
  return json(response, 404, { error: 'Rota não encontrada.' });
}

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

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.startsWith('/api/auth/')) return await routeAuth(request, response, url);
      if (['/api/health', '/api/health/live', '/api/health/ready', '/api/health/detail', '/api/metrics'].includes(url.pathname)) {
        return await routeApi(request, response, url);
      }
      if (!adminAuth.session(request)) return json(response, 401, { error: 'Autenticação necessária.' });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !requestOriginAllowed(request)) {
        return json(response, 403, { error: 'Origem não permitida.' });
      }
      return await routeApi(request, response, url);
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
}).listen(PORT, '0.0.0.0', () => console.log(`Codebase Memory Admin em http://0.0.0.0:${PORT}`));
