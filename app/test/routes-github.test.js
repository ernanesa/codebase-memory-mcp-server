import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRouter } from '../src/router.js';
import { register, github, listGithubRepositories } from '../src/routes/github.js';

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(content = '') {
      this.body = content;
    }
  };
}

function createMockRequest(bodyData, headers = {}) {
  const req = Readable.from(bodyData ? [JSON.stringify(bodyData)] : []);
  req.headers = headers;
  req.url = '/';
  return req;
}

test('github helper valida token obrigatório', async () => {
  await assert.rejects(
    async () => github('/user', ''),
    { message: 'Conecte o GitHub primeiro.' }
  );
  await assert.rejects(
    async () => github('/user', null),
    { message: 'Conecte o GitHub primeiro.' }
  );
});

test('github helper executa chamada autenticada com headers corretos', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedHeaders = {};

  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    return new Response(JSON.stringify({ login: 'octocat' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const result = await github('/user', 'test-token-123');
    assert.equal(capturedUrl, 'https://api.github.com/user');
    assert.equal(capturedHeaders.authorization, 'Bearer test-token-123');
    assert.equal(capturedHeaders.accept, 'application/vnd.github+json');
    assert.equal(capturedHeaders['user-agent'], 'codebase-memory-admin');
    assert.equal(capturedHeaders['x-github-api-version'], '2022-11-28');
    assert.deepEqual(result, { login: 'octocat' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('github helper trata erros 401, 403 de rate limit e genéricos', async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    await assert.rejects(
      async () => github('/user', 'invalid-token'),
      { message: 'Token do GitHub inválido ou expirado.' }
    );

    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' }
    });
    await assert.rejects(
      async () => github('/user', 'rate-limited-token'),
      { message: 'O limite de requisições do GitHub foi atingido. Tente novamente mais tarde.' }
    );

    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Resource not accessible' }), { status: 403 });
    await assert.rejects(
      async () => github('/user', 'forbidden-token'),
      { message: 'GitHub: Resource not accessible' }
    );

    globalThis.fetch = async () => new Response('Internal error', { status: 500 });
    await assert.rejects(
      async () => github('/user', 'server-error-token'),
      { message: 'GitHub respondeu com HTTP 500.' }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listGithubRepositories pagina, mapeia campos, ordena e utiliza cache', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  const rawReposPage1 = [
    {
      id: 2,
      name: 'beta-repo',
      full_name: 'org/beta-repo',
      description: 'Second repo',
      private: false,
      archived: false,
      language: 'JavaScript',
      default_branch: 'main',
      updated_at: '2026-09-01T00:00:00Z',
      clone_url: 'https://github.com/org/beta-repo.git'
    },
    {
      id: 1,
      name: 'alpha-repo',
      full_name: 'org/alpha-repo',
      description: 'First repo',
      private: true,
      archived: false,
      language: 'TypeScript',
      default_branch: 'master',
      updated_at: '2026-09-02T00:00:00Z',
      clone_url: 'https://github.com/org/alpha-repo.git'
    }
  ];

  globalThis.fetch = async (url) => {
    requests.push(url);
    // Page 1 returns 2 items (< 100, stops immediately)
    return new Response(JSON.stringify(rawReposPage1), { status: 200 });
  };

  const ctx = {
    github: {
      token: 'gh-token-abc',
      cache: { at: 0, repositories: [] }
    }
  };

  try {
    const repos = await listGithubRepositories(ctx);
    assert.equal(requests.length, 1);
    assert.equal(repos.length, 2);
    // Order by fullName ascending
    assert.equal(repos[0].fullName, 'org/alpha-repo');
    assert.equal(repos[1].fullName, 'org/beta-repo');
    assert.equal(repos[0].defaultBranch, 'master');
    assert.equal(repos[0].cloneUrl, 'https://github.com/org/alpha-repo.git');
    assert.equal(repos[0].private, true);

    // Cache is populated
    assert.ok(ctx.github.cache.at > 0);
    assert.equal(ctx.github.cache.repositories.length, 2);

    // Subsequent call within 2 minutes uses cache
    const cachedRepos = await listGithubRepositories(ctx);
    assert.equal(requests.length, 1); // no new request made
    assert.deepEqual(cachedRepos, repos);

    // Cache expired fetches again
    ctx.github.cache.at = Date.now() - 130_000;
    await listGithubRepositories(ctx);
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rotas do GitHub: GET, POST, DELETE connection e GET repositories', async () => {
  const originalFetch = globalThis.fetch;
  const router = createRouter();

  let savedFile = null;
  let savedCredentials = null;
  let removedFile = null;

  const ctx = {
    config: {
      GITHUB_CREDENTIALS_FILE: '/data/secrets/github-credentials.json'
    },
    github: {
      token: '',
      user: null,
      cache: { at: 0, repositories: [] }
    },
    saveCredentials: async (file, creds) => {
      savedFile = file;
      savedCredentials = creds;
    },
    removeFile: async (file) => {
      removedFile = file;
    }
  };

  register(router, ctx);

  // 1. GET /api/github/connection (desconectado)
  {
    const match = router.match('GET', '/api/github/connection');
    assert.ok(match);
    const req = createMockRequest();
    const res = createMockResponse();
    await match.handler(req, res, new URL('http://localhost/api/github/connection'), match.params);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { connected: false, user: null });
  }

  // 2. POST /api/github/connection
  {
    globalThis.fetch = async (url) => {
      if (url.includes('/user')) {
        return new Response(JSON.stringify({
          login: 'octocat',
          name: 'The Octocat',
          avatar_url: 'https://github.com/images/error/octocat_happy.gif'
        }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const match = router.match('POST', '/api/github/connection');
    assert.ok(match);
    const req = createMockRequest({ token: 'gho_secret123' });
    const res = createMockResponse();
    await match.handler(req, res, new URL('http://localhost/api/github/connection'), match.params);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.connected, true);
    assert.equal(parsed.user.login, 'octocat');
    assert.equal(parsed.user.name, 'The Octocat');
    assert.equal(parsed.user.avatarUrl, 'https://github.com/images/error/octocat_happy.gif');

    assert.equal(savedFile, '/data/secrets/github-credentials.json');
    assert.equal(savedCredentials.token, 'gho_secret123');
    assert.equal(ctx.github.token, 'gho_secret123');
    assert.equal(ctx.github.user.login, 'octocat');
  }

  // 3. GET /api/github/connection (agora conectado)
  {
    const match = router.match('GET', '/api/github/connection');
    const req = createMockRequest();
    const res = createMockResponse();
    await match.handler(req, res, new URL('http://localhost/api/github/connection'), match.params);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.connected, true);
    assert.equal(parsed.user.login, 'octocat');
  }

  // 4. GET /api/github/repositories com e sem busca
  {
    ctx.github.cache = {
      at: Date.now(),
      repositories: [
        { fullName: 'org/backend-api', description: 'API backend principal' },
        { fullName: 'org/frontend-ui', description: 'Interface do usuário' },
        { fullName: 'org/docs', description: 'Documentação' }
      ]
    };

    const match = router.match('GET', '/api/github/repositories');
    assert.ok(match);

    // Sem filtro
    {
      const req = createMockRequest();
      req.url = '/api/github/repositories';
      const res = createMockResponse();
      await match.handler(req, res, new URL('http://localhost/api/github/repositories'), match.params);
      assert.equal(res.statusCode, 200);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.repositories.length, 3);
    }

    // Com filtro ?search=backend
    {
      const req = createMockRequest();
      req.url = '/api/github/repositories?search=backend';
      const res = createMockResponse();
      await match.handler(req, res, new URL('http://localhost/api/github/repositories?search=backend'), match.params);
      assert.equal(res.statusCode, 200);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.repositories.length, 1);
      assert.equal(parsed.repositories[0].fullName, 'org/backend-api');
    }
  }

  // 5. DELETE /api/github/connection
  {
    const match = router.match('DELETE', '/api/github/connection');
    assert.ok(match);
    const req = createMockRequest();
    const res = createMockResponse();
    await match.handler(req, res, new URL('http://localhost/api/github/connection'), match.params);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { connected: false });
    assert.equal(removedFile, '/data/secrets/github-credentials.json');
    assert.equal(ctx.github.token, '');
    assert.equal(ctx.github.user, null);
    assert.deepEqual(ctx.github.cache, { at: 0, repositories: [] });
  }

  globalThis.fetch = originalFetch;
});
