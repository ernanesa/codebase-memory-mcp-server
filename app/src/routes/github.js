/**
 * Rotas e integração com a API do GitHub.
 * Sem dependências externas — usa apenas APIs nativas do Node 22.
 */

import { json, body } from '../http.js';

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'codebase-memory-admin';
const CACHE_TTL_MS = 120_000; // 2 minutos

/**
 * Faz uma requisição autenticada à API do GitHub.
 * @param {string} endpoint
 * @param {string} token
 * @returns {Promise<any>}
 */
export async function github(endpoint, token) {
  const authToken = (typeof token === 'object' && token !== null ? token.token : token) || '';
  if (!authToken) throw new Error('Conecte o GitHub primeiro.');

  const url = endpoint.startsWith('http')
    ? endpoint
    : `${GITHUB_API_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${authToken}`,
      'user-agent': USER_AGENT,
      'x-github-api-version': GITHUB_API_VERSION
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Token do GitHub inválido ou expirado.');
    }
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('O limite de requisições do GitHub foi atingido. Tente novamente mais tarde.');
    }
    throw new Error(payload.message ? `GitHub: ${payload.message}` : `GitHub respondeu com HTTP ${response.status}.`);
  }

  return payload;
}

/**
 * Lista repositórios do usuário no GitHub com paginação (até 20 páginas) e cache de 2 minutos.
 * @param {object|string} ctx
 * @returns {Promise<Array<object>>}
 */
export async function listGithubRepositories(ctx) {
  const cache = typeof ctx === 'object' && ctx !== null ? ctx.github?.cache : null;
  if (cache?.at && Date.now() - cache.at < CACHE_TTL_MS && Array.isArray(cache.repositories)) {
    return cache.repositories;
  }

  const token = typeof ctx === 'string' ? ctx : ctx?.github?.token;
  const all = [];

  for (let page = 1; page <= 20; page += 1) {
    const items = await github(
      `/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&per_page=100&page=${page}`,
      token
    );
    if (!Array.isArray(items)) break;
    all.push(...items);
    if (items.length < 100) break;
  }

  const repositories = all.map(item => ({
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
  })).sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));

  if (typeof ctx === 'object' && ctx !== null) {
    if (!ctx.github) ctx.github = {};
    if (ctx.github.cache && typeof ctx.github.cache === 'object') {
      ctx.github.cache.at = Date.now();
      ctx.github.cache.repositories = repositories;
    } else {
      ctx.github.cache = {
        at: Date.now(),
        repositories
      };
    }
  }

  return repositories;
}

/**
 * Registra as rotas de integração com GitHub.
 * @param {object} router
 * @param {object} ctx
 */
export function register(router, ctx) {
  router.add('GET', '/api/github/connection', async (request, response, url, params) => {
    return json(response, 200, {
      connected: Boolean(ctx?.github?.token),
      user: ctx?.github?.user ?? null
    });
  });

  router.add('POST', '/api/github/connection', async (request, response, url, params) => {
    const input = await body(request);
    const token = String(input?.token ?? '').trim();
    const user = await github('/user', token);
    const persistedUser = {
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url
    };

    await ctx.saveCredentials(ctx.config.GITHUB_CREDENTIALS_FILE, { token, user: persistedUser });
    if (!ctx.github) ctx.github = {};
    ctx.github.token = token;
    ctx.github.user = persistedUser;
    if (ctx.github.cache && typeof ctx.github.cache === 'object') {
      ctx.github.cache.at = 0;
      ctx.github.cache.repositories = [];
    } else {
      ctx.github.cache = { at: 0, repositories: [] };
    }

    return json(response, 200, { connected: true, user: persistedUser });
  });

  router.add('DELETE', '/api/github/connection', async (request, response, url, params) => {
    await ctx.removeFile(ctx.config.GITHUB_CREDENTIALS_FILE);
    if (!ctx.github) ctx.github = {};
    ctx.github.token = '';
    ctx.github.user = null;
    if (ctx.github.cache && typeof ctx.github.cache === 'object') {
      ctx.github.cache.at = 0;
      ctx.github.cache.repositories = [];
    } else {
      ctx.github.cache = { at: 0, repositories: [] };
    }

    return json(response, 200, { connected: false });
  });

  router.add('GET', '/api/github/repositories', async (request, response, url, params) => {
    const searchParams = url?.searchParams
      || (typeof url === 'string' ? new URL(url, 'http://localhost').searchParams : null)
      || (request?.url ? new URL(request.url, 'http://localhost').searchParams : new URLSearchParams());
    const search = (searchParams.get('search') || '').toLowerCase();
    const all = await listGithubRepositories(ctx);
    const repositories = all.filter(
      item => !search || `${item.fullName} ${item.description || ''}`.toLowerCase().includes(search)
    );
    return json(response, 200, { repositories });
  });
}

export default register;
