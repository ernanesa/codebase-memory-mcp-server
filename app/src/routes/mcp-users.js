import { randomUUID } from 'node:crypto';
import { json, body } from '../http.js';
import { assertSafeSegment, publicMcpUser, setMcpGatewayUserKey, removeMcpGatewayUserKey } from '../lib.js';

function mcpUser(ctx, id) {
  assertSafeSegment(id);
  const user = ctx.mcp.userStore.users.find(u => u.id === id);
  if (!user) {
    throw new Error('Usuário MCP não encontrado.');
  }
  return user;
}

function mcpUserInput(input) {
  const name = String(input.name || '').trim();
  const identity = String(input.identity || '').trim();
  const description = String(input.description || '').trim();

  if (!name) throw new Error('Nome do usuário é obrigatório.');
  if (name.length > 100) throw new Error('Nome do usuário é muito longo (máx. 100 caracteres).');
  
  if (!identity) throw new Error('Identidade do usuário é obrigatória.');
  if (identity.length > 160) throw new Error('Identidade do usuário é muito longa (máx. 160 caracteres).');

  if (description.length > 240) throw new Error('Descrição é muito longa (máx. 240 caracteres).');

  return { name, identity, description };
}

function mcpRepositoryIds(ctx, input, { required = true } = {}) {
  let ids = input.repositoryIds;
  if (!ids) {
    if (required) throw new Error('Acesso a repositórios é obrigatório.');
    return undefined;
  }
  if (!Array.isArray(ids)) {
    throw new Error('Formato de repositórios inválido.');
  }
  if (ids.length > 500) {
    throw new Error('Muitos repositórios selecionados.');
  }

  const uniqueIds = Array.from(new Set(ids));
  
  const validIds = [];
  for (const id of uniqueIds) {
    const repo = ctx.state.repositories.find(r => r.accessId === id);
    if (!repo) {
      throw new Error(`Repositório selecionado inválido ou não encontrado (${id}).`);
    }
    validIds.push(id);
  }

  return validIds;
}

export function register(router, ctx) {
  router.add('POST', '/api/mcp-system-token/reveal', async (request, response) => {
    return json(response, 200, { token: ctx.mcp.systemToken, name: ctx.config.MCP_SYSTEM_USER.name });
  });

  router.add('POST', '/api/mcp-system-token/rotate', async (request, response) => {
    const token = await ctx.rotateMcpSystemToken();
    return json(response, 200, { token, name: ctx.config.MCP_SYSTEM_USER.name });
  });

  router.add('GET', '/api/mcp-users', async (request, response) => {
    return json(response, 200, {
      users: ctx.mcp.userStore.users.map(publicMcpUser),
      accessMode: 'strict',
      systemAccess: true
    });
  });

  router.add('POST', '/api/mcp-users', async (request, response) => {
    const input = await body(request);
    const { name, identity, description } = mcpUserInput(input);
    const repositoryIds = mcpRepositoryIds(ctx, input);

    const identityLower = identity.toLowerCase();
    if (ctx.mcp.userStore.users.some(u => u.identity.toLowerCase() === identityLower)) {
      throw new Error('Já existe um usuário com esta identidade.');
    }

    const newUser = {
      id: randomUUID(),
      status: 'active',
      name,
      identity,
      description,
      repositoryIds,
      repositories: repositoryIds,
      createdAt: new Date().toISOString()
    };

    const { token, user: activeUser } = await ctx.issueMcpToken(newUser);

    const nextStore = {
      ...ctx.mcp.userStore,
      users: [...ctx.mcp.userStore.users, activeUser]
    };

    await ctx.commitMcpUserChange(nextStore, async (mcpConfig) => {
      setMcpGatewayUserKey(mcpConfig, activeUser, token);
    });

    return json(response, 201, { user: publicMcpUser(activeUser), token });
  });

  router.add('GET', '/api/mcp-access-options', async (request, response) => {
    try {
      await ctx.refreshRepositoryProjects();
    } catch (err) {
      console.warn('Falha ao atualizar projetos no gateway MCP:', err);
    }

    const { workspaces, repositories } = ctx.state;
    const workspacesResponse = workspaces.map(ws => {
      const wsRepos = repositories.filter(r => r.workspaceId === ws.id).map(r => ({
        id: r.accessId,
        name: r.name,
        fullName: r.fullName,
        indexed: Boolean(r.project),
        project: r.project
      })).sort((a, b) => a.fullName.localeCompare(b.fullName));

      return {
        id: ws.id,
        name: ws.name,
        repositories: wsRepos
      };
    });

    return json(response, 200, { workspaces: workspacesResponse });
  });

  router.add('PUT', '/api/mcp-users/:userId/repositories', async (request, response, url, params) => {
    const user = mcpUser(ctx, params.userId);
    const input = await body(request);
    const repositoryIds = mcpRepositoryIds(ctx, input, { required: false });

    const updatedUser = { ...user, repositoryIds: repositoryIds || [], repositories: repositoryIds || [] };
    const nextStore = {
      ...ctx.mcp.userStore,
      users: ctx.mcp.userStore.users.map(u => u.id === user.id ? updatedUser : u)
    };

    await ctx.commitMcpUserStoreOnly(nextStore);
    return json(response, 200, { user: publicMcpUser(updatedUser) });
  });

  router.add('DELETE', '/api/mcp-users/:userId', async (request, response, url, params) => {
    const user = mcpUser(ctx, params.userId);

    const nextStore = {
      ...ctx.mcp.userStore,
      users: ctx.mcp.userStore.users.filter(u => u.id !== user.id)
    };

    await ctx.commitMcpUserChange(nextStore, async (mcpConfig) => {
      removeMcpGatewayUserKey(mcpConfig, user.id);
    });

    return json(response, 200, { deleted: true });
  });

  router.add('POST', '/api/mcp-users/:userId/revoke', async (request, response, url, params) => {
    const user = mcpUser(ctx, params.userId);
    if (user.status === 'revoked') {
      throw new Error('O token deste usuário já está revogado.');
    }

    const now = new Date().toISOString();
    const updatedUser = {
      ...user,
      status: 'revoked',
      updatedAt: now,
      revokedAt: now
    };

    const nextStore = {
      ...ctx.mcp.userStore,
      users: ctx.mcp.userStore.users.map(u => u.id === user.id ? updatedUser : u)
    };

    await ctx.commitMcpUserChange(nextStore, async (mcpConfig) => {
      removeMcpGatewayUserKey(mcpConfig, user.id);
    });

    return json(response, 200, { user: publicMcpUser(updatedUser) });
  });

  router.add('POST', '/api/mcp-users/:userId/rotate', async (request, response, url, params) => {
    const user = mcpUser(ctx, params.userId);
    if (user.status !== 'active') {
      throw new Error('Reative o usuário antes de rotacionar seu token.');
    }

    const { token, user: updatedUser } = await ctx.issueMcpToken(user);

    const nextStore = {
      ...ctx.mcp.userStore,
      users: ctx.mcp.userStore.users.map(u => u.id === user.id ? updatedUser : u)
    };

    await ctx.commitMcpUserChange(nextStore, async (mcpConfig) => {
      setMcpGatewayUserKey(mcpConfig, updatedUser, token);
    });

    return json(response, 200, { user: publicMcpUser(updatedUser), token });
  });

  router.add('POST', '/api/mcp-users/:userId/reactivate', async (request, response, url, params) => {
    const user = mcpUser(ctx, params.userId);
    if (user.status !== 'revoked') {
      throw new Error('Este usuário já está ativo.');
    }

    const { token, user: activeUser } = await ctx.issueMcpToken(user);

    const nextStore = {
      ...ctx.mcp.userStore,
      users: ctx.mcp.userStore.users.map(u => u.id === user.id ? activeUser : u)
    };

    await ctx.commitMcpUserChange(nextStore, async (mcpConfig) => {
      setMcpGatewayUserKey(mcpConfig, activeUser, token);
    });

    return json(response, 200, { user: publicMcpUser(activeUser), token });
  });
}
