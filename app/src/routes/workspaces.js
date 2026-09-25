import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { json, body } from '../http.js';
import {
  assertSafeSegment,
  slugify,
  safeChild,
  publicWorkspace,
  parseCronExpression,
  validateTimezone,
  describeCron,
  nextCronOccurrence,
  decryptWorkspaceToken,
  gitAuthEnvironment,
  run
} from '../lib.js';

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

export function register(router, ctx) {
  router.get('/api/workspaces', async (request, response, url, params) => {
    return json(response, 200, { workspaces: ctx.state.workspaces.map(item => ({ ...publicWorkspace(item), updateSchedule: publicUpdateSchedule(item), repositoryCount: ctx.state.repositories.filter(repo => repo.workspaceId === item.id).length })) });
  });

  router.post('/api/workspaces', async (request, response, url, params) => {
    const input = await body(request);
    const name = String(input.name ?? '').trim();
    const id = slugify(name);
    if (!name || !id) throw new Error('Informe um nome válido para o workspace.');
    if (ctx.state.workspaces.some(item => item.id === id)) throw new Error('Já existe um workspace com esse nome.');
    const item = { id, name: name.slice(0, 80), description: String(input.description ?? '').trim().slice(0, 240), updateSchedule: ctx.defaultUpdateSchedule(), createdAt: new Date().toISOString() };
    const issued = ctx.issueWorkspaceMcpCredential(item);
    item.mcpCredential = issued.credential;
    await mkdir(safeChild(ctx.config.REPOSITORIES_DIR, id), { recursive: true });
    const nextState = { ...ctx.state, workspaces: [...ctx.state.workspaces, item] };
    try {
      await ctx.commitWorkspaceChange(nextState, config => ctx.setMcpGatewayUserKey(config, ctx.workspacePrincipal(item), issued.token));
    } catch (error) {
      await rmdir(safeChild(ctx.config.REPOSITORIES_DIR, id)).catch(() => {});
      throw error;
    }
    return json(response, 201, { workspace: publicWorkspace(item), token: issued.token });
  });

  router.get('/api/workspaces/:workspaceId', async (request, response, url, params) => {
    const workspaceId = params.workspaceId;
    const selectedWorkspace = ctx.workspace(workspaceId);
    return json(response, 200, { workspace: { ...publicWorkspace(selectedWorkspace), updateSchedule: publicUpdateSchedule(selectedWorkspace) }, repositories: ctx.state.repositories.filter(item => item.workspaceId === workspaceId).map(publicRepository) });
  });

  router.delete('/api/workspaces/:workspaceId', async (request, response, url, params) => {
    const workspaceId = params.workspaceId;
    const selectedWorkspace = ctx.workspace(workspaceId);
    if (ctx.state.repositories.some(item => item.workspaceId === workspaceId)) throw new Error('Remova os repositórios antes de excluir o workspace.');
    const directory = safeChild(ctx.config.REPOSITORIES_DIR, workspaceId);
    const remainingFiles = await readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    if (remainingFiles.length) throw new Error('A pasta do workspace contém arquivos não gerenciados e não pode ser excluída.');
    const nextState = { ...ctx.state, workspaces: ctx.state.workspaces.filter(item => item.id !== workspaceId) };
    await rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
    try {
      await ctx.commitWorkspaceChange(nextState, config => ctx.removeMcpGatewayUserKey(config, ctx.workspacePrincipal(selectedWorkspace).id));
    } catch (error) {
      await mkdir(directory, { recursive: true }).catch(() => {});
      throw error;
    }
    return json(response, 200, { deleted: true });
  });

  router.post('/api/workspaces/:workspaceId/mcp-token/reveal', async (request, response, url, params) => {
    const workspaceId = params.workspaceId;
    const selectedWorkspace = ctx.workspace(workspaceId);
    if (!selectedWorkspace.mcpCredential) throw new Error('O workspace ainda não possui credencial MCP.');
    const token = decryptWorkspaceToken(selectedWorkspace.mcpCredential.encryptedToken, ctx.mcp.workspaceEncryptionKey);
    return json(response, 200, { name: selectedWorkspace.name, token });
  });

  router.post('/api/workspaces/:workspaceId/mcp-token/rotate', async (request, response, url, params) => {
    const workspaceId = params.workspaceId;
    const selectedWorkspace = ctx.workspace(workspaceId);
    if (selectedWorkspace.mcpCredential?.status !== 'active') throw new Error('Reative o token antes de rotacioná-lo.');
    const nextState = structuredClone(ctx.state);
    const nextWorkspace = nextState.workspaces.find(item => item.id === workspaceId);
    const issued = ctx.issueWorkspaceMcpCredential(nextWorkspace);
    nextWorkspace.mcpCredential = issued.credential;
    await ctx.commitWorkspaceChange(nextState, config => ctx.setMcpGatewayUserKey(config, ctx.workspacePrincipal(nextWorkspace), issued.token));
    return json(response, 200, { workspace: publicWorkspace(nextWorkspace), token: issued.token });
  });

  router.post('/api/workspaces/:workspaceId/mcp-token/reactivate', async (request, response, url, params) => {
    const workspaceId = params.workspaceId;
    const selectedWorkspace = ctx.workspace(workspaceId);
    if (selectedWorkspace.mcpCredential?.status === 'active') throw new Error('O token deste workspace já está ativo.');
    const nextState = structuredClone(ctx.state);
    const nextWorkspace = nextState.workspaces.find(item => item.id === workspaceId);
    const issued = ctx.issueWorkspaceMcpCredential(nextWorkspace);
    nextWorkspace.mcpCredential = issued.credential;
    await ctx.commitWorkspaceChange(nextState, config => ctx.setMcpGatewayUserKey(config, ctx.workspacePrincipal(nextWorkspace), issued.token));
    return json(response, 200, { workspace: publicWorkspace(nextWorkspace), token: issued.token });
  });

  router.post('/api/workspaces/:workspaceId/mcp-token/revoke', async (request, response, url, params) => {
    const workspaceId = params.workspaceId;
    const selectedWorkspace = ctx.workspace(workspaceId);
    if (selectedWorkspace.mcpCredential?.status !== 'active') throw new Error('O token deste workspace já está revogado.');
    const nextState = structuredClone(ctx.state);
    const nextWorkspace = nextState.workspaces.find(item => item.id === workspaceId);
    const now = new Date().toISOString();
    nextWorkspace.mcpCredential = { ...nextWorkspace.mcpCredential, status: 'revoked', revokedAt: now, updatedAt: now };
    await ctx.commitWorkspaceChange(nextState, config => ctx.removeMcpGatewayUserKey(config, ctx.workspacePrincipal(nextWorkspace).id));
    return json(response, 200, { workspace: publicWorkspace(nextWorkspace) });
  });

  router.get('/api/workspaces/:workspaceId/schedule', async (request, response, url, params) => {
    const workspaceId = params.workspaceId;
    const selectedWorkspace = ctx.workspace(workspaceId);
    return json(response, 200, { schedule: publicUpdateSchedule(selectedWorkspace), concurrency: ctx.config.REPOSITORY_SYNC_CONCURRENCY });
  });

  router.put('/api/workspaces/:workspaceId/schedule', async (request, response, url, params) => {
    const workspaceId = params.workspaceId;
    const selectedWorkspace = ctx.workspace(workspaceId);
    const input = await body(request);
    const cron = parseCronExpression(input.cron).expression;
    const timezone = validateTimezone(input.timezone);
    const enabled = input.enabled === undefined ? selectedWorkspace.updateSchedule.enabled : input.enabled;
    if (typeof enabled !== 'boolean') throw new Error('O estado da rotina deve ser verdadeiro ou falso.');
    selectedWorkspace.updateSchedule = { ...selectedWorkspace.updateSchedule, cron, timezone, enabled, updatedAt: new Date().toISOString(), lastScheduledMinute: null };
    await ctx.persist();
    return json(response, 200, { schedule: publicUpdateSchedule(selectedWorkspace), concurrency: ctx.config.REPOSITORY_SYNC_CONCURRENCY });
  });

  router.post('/api/workspaces/:workspaceId/schedule/run', async (request, response, url, params) => {
    const workspaceId = params.workspaceId;
    const selectedWorkspace = ctx.workspace(workspaceId);
    const job = await ctx.runWorkspaceSync(selectedWorkspace, 'manual');
    await ctx.persist();
    return json(response, 202, job);
  });

  router.post('/api/workspaces/:workspaceId/index', async (request, response, url, params) => {
    const workspaceId = params.workspaceId;
    const selectedWorkspace = ctx.workspace(workspaceId);
    const job = ctx.runWorkspaceIndex(selectedWorkspace);
    await ctx.persist();
    return json(response, 202, job);
  });

  router.post('/api/workspaces/:workspaceId/repositories', async (request, response, url, params) => {
    const workspaceId = params.workspaceId;
    const input = await body(request);
    if (!Array.isArray(input.repositories) || !input.repositories.length) throw new Error('Selecione pelo menos um repositório.');
    const available = await ctx.listGithubRepositories();
    const selected = input.repositories.map(fullName => available.find(item => item.fullName === fullName));
    if (selected.some(item => !item)) throw new Error('Um dos repositórios selecionados não está disponível.');
    const requestedIds = new Map();
    for (const remote of selected) {
      const repositoryId = slugify(remote.name);
      const collision = requestedIds.get(repositoryId) || ctx.state.repositories.find(item => item.workspaceId === workspaceId && item.id === repositoryId && item.fullName !== remote.fullName)?.fullName;
      if (collision) throw new Error(`Os repositórios ${collision} e ${remote.fullName} usam o mesmo nome de pasta. Adicione-os em workspaces diferentes.`);
      requestedIds.set(repositoryId, remote.fullName);
    }
    const created = [];
    for (const remote of selected) {
      const id = slugify(remote.name);
      if (ctx.state.repositories.some(item => item.workspaceId === workspaceId && item.id === id)) continue;
      const target = safeChild(ctx.config.REPOSITORIES_DIR, workspaceId, id);
      const item = { id, accessId: randomUUID(), workspaceId, name: remote.name, fullName: remote.fullName, description: remote.description, private: remote.private, language: remote.language, defaultBranch: remote.defaultBranch, status: 'cloning', path: target, createdAt: new Date().toISOString() };
      ctx.state.repositories.push(item);
      const job = ctx.createJob('clone', `Clonando ${remote.fullName}`, `${workspaceId}/${id}`, async (currentJob, log) => {
        await run('git', ['clone', remote.cloneUrl, target], { env: gitAuthEnvironment(ctx.githubToken), onOutput: log });
        const commit = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: target })).stdout.trim();
        item.status = 'ready'; item.commit = commit; item.lastSyncAt = new Date().toISOString(); currentJob.progress = 100;
      });
      item.activeJobId = job.id;
      created.push(publicRepository(item));
    }
    await ctx.persist();
    return json(response, 202, { repositories: created });
  });

  router.delete('/api/workspaces/:workspaceId/repositories/:repositoryId', async (request, response, url, params) => {
    const { workspaceId, repositoryId } = params;
    const item = ctx.repository(workspaceId, repositoryId);
    if (ctx.locks.has(`${workspaceId}/${item.id}`)) throw new Error('Aguarde a operação atual terminar.');
    await rm(item.path, { recursive: true, force: true });
    ctx.state.repositories = ctx.state.repositories.filter(repo => repo !== item);
    await ctx.persist();
    return json(response, 200, { deleted: true });
  });

  router.post('/api/workspaces/:workspaceId/repositories/:repositoryId/sync', async (request, response, url, params) => {
    const { workspaceId, repositoryId } = params;
    const item = ctx.repository(workspaceId, repositoryId);
    const { job } = ctx.enqueueRepositorySync(item);
    await ctx.persist();
    return json(response, 202, job);
  });

  router.post('/api/workspaces/:workspaceId/repositories/:repositoryId/index', async (request, response, url, params) => {
    const { workspaceId, repositoryId } = params;
    const item = ctx.repository(workspaceId, repositoryId);
    const job = ctx.createJob('index', `Indexando ${item.fullName}`, `${workspaceId}/${item.id}`, async (_job, log) => {
      await ctx.indexRepository(item, log);
    });
    item.activeJobId = job.id;
    await ctx.persist();
    return json(response, 202, job);
  });
}
