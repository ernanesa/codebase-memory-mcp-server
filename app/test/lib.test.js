import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSafeSegment, createMutex, cronMatches, decryptWorkspaceToken, describeCron, encryptWorkspaceToken, ensureMcpGatewayGuardrail, generateMcpToken, gitAuthEnvironment, indexRepositoryArguments, loadCredentials, loadMcpUserStore, loadSecret, mcpTokenFingerprint, nextCronOccurrence, parseCronExpression, parseLastJsonLine, publicMcpUser, publicWorkspace, reconcileRepositoryProjects, removeMcpGatewayUserKey, safeChild, saveCredentials, saveMcpUserStore, saveSecret, setMcpGatewayUserKey, slugify, validateTimezone } from '../src/lib.js';

test('slugify normaliza nomes de workspaces', () => {
  assert.equal(slugify('Pagamentos & Cobrança'), 'pagamentos-cobranca');
});

test('safeChild mantém caminhos dentro da raiz', () => {
  assert.equal(safeChild('/repos', 'time', 'api'), '/repos/time/api');
  assert.throws(() => safeChild('/repos', '..', 'etc'), /fora da raiz/);
});

test('identificadores recusam path traversal', () => {
  assert.throws(() => assertSafeSegment('../etc'));
  assert.equal(assertSafeSegment('meu-workspace'), 'meu-workspace');
});

test('cron padrão executa no minuto zero de cada hora', () => {
  assert.equal(parseCronExpression('0 * * * *').expression, '0 * * * *');
  assert.equal(cronMatches('0 * * * *', new Date('2026-07-15T14:00:00Z'), 'UTC'), true);
  assert.equal(cronMatches('0 * * * *', new Date('2026-07-15T14:01:00Z'), 'UTC'), false);
  assert.equal(nextCronOccurrence('0 * * * *', 'UTC', new Date('2026-07-15T14:20:00Z')).toISOString(), '2026-07-15T15:00:00.000Z');
});

test('nextCronOccurrence itera com performance e reutiliza formatadores de fuso horário', () => {
  const start = Date.now();
  const next = nextCronOccurrence('0 0 31 12 *', 'America/Maceio', new Date('2026-01-01T00:00:00Z'));
  const duration = Date.now() - start;
  assert.equal(next.toISOString(), '2026-12-31T03:00:00.000Z');
  assert.ok(duration < 8000, `nextCronOccurrence demorou ${duration}ms, esperado menos de 8000ms`);
});

test('descreve semanticamente os crons mais comuns sem ocultar combinações', () => {
  assert.equal(describeCron('0 * * * *'), 'Atualiza a cada hora');
  assert.equal(describeCron('*/15 * * * *'), 'Atualiza a cada 15 minutos');
  assert.equal(describeCron('0 2,4 * * *'), 'Atualiza diariamente às 2h e às 4h');
  assert.equal(describeCron('0,30 2,4 * * *'), 'Atualiza diariamente às 2h, às 2h30, às 4h e às 4h30');
  assert.equal(describeCron('0 2 * * 1-5'), 'Atualiza de segunda a sexta às 2h');
});

test('cron valida campos, passos e fuso horário', () => {
  assert.equal(cronMatches('*/15 9-17 * * 1-5', new Date('2026-07-15T15:30:00Z'), 'UTC'), true);
  assert.equal(cronMatches('5/10 * * * *', new Date('2026-07-15T15:25:00Z'), 'UTC'), true);
  assert.throws(() => parseCronExpression('* * *'), /cinco campos/);
  assert.throws(() => parseCronExpression('60 * * * *'), /fora do intervalo/);
  assert.equal(validateTimezone('America/Maceio'), 'America/Maceio');
  assert.throws(() => validateTimezone('Brasil/FusoInexistente'), /Fuso horário inválido/);
});

test('autenticação Git usa Basic sem expor o token no argumento do clone', () => {
  const environment = gitAuthEnvironment('github_pat_example');
  assert.equal(environment.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  const encoded = environment.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', '');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'x-access-token:github_pat_example');
});

test('indexação usa o argumento JSON aceito pelo Codebase Memory 0.8.1', () => {
  assert.deepEqual(indexRepositoryArguments('/data/repositories/time/api'), [
    'cli', 'index_repository', '{"repo_path":"/data/repositories/time/api"}'
  ]);
});

test('extrai o projeto da última linha JSON da indexação', () => {
  assert.deepEqual(parseLastJsonLine('level=info msg=start\n{"project":"workspace-api","status":"indexed"}\n'), {
    project: 'workspace-api', status: 'indexed'
  });
});

test('reconcilia o ID MCP pelo caminho real do repositório, não pelo nome do GitHub', () => {
  const repositories = [
    { accessId: 'repo-1', fullName: 'organizacao/api-contrato', path: '/data/repositories/plataforma/api-contrato' },
    { accessId: 'repo-2', fullName: 'organizacao/legado', path: '/data/repositories/plataforma/legado', project: 'id-antigo' }
  ];
  const result = reconcileRepositoryProjects(repositories, [{
    name: 'data-repositories-plataforma-api-contrato',
    root_path: '/data/repositories/plataforma/api-contrato'
  }]);

  assert.equal(result.changed, true);
  assert.equal(result.repositories[0].project, 'data-repositories-plataforma-api-contrato');
  assert.equal('project' in result.repositories[1], false);
  assert.equal(result.repositories[0].fullName, 'organizacao/api-contrato');
});

test('credencial do GitHub persiste com permissão restrita', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cbm-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'secrets', 'github-credentials.json');
  const credentials = { token: 'github_pat_example', user: { login: 'octocat' } };

  await saveCredentials(file, credentials);

  assert.deepEqual(await loadCredentials(file), credentials);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test('gera tokens MCP fortes e uma fingerprint estável', () => {
  const first = generateMcpToken();
  const second = generateMcpToken();
  assert.match(first, /^cbm_mcp_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(mcpTokenFingerprint(first).length, 64);
  assert.equal(mcpTokenFingerprint(first), mcpTokenFingerprint(first));
});

test('protege o token reversível do workspace com AES-GCM', () => {
  const token = generateMcpToken();
  const encrypted = encryptWorkspaceToken(token, 'segredo-de-teste-com-entropia');
  assert.equal(encrypted.algorithm, 'aes-256-gcm');
  assert.equal(decryptWorkspaceToken(encrypted, 'segredo-de-teste-com-entropia'), token);
  assert.throws(() => decryptWorkspaceToken(encrypted, 'chave-incorreta'), /descriptografar/);
  const exposed = publicWorkspace({ id: 'plataforma', name: 'Plataforma', mcpCredential: { ...encrypted, status: 'active', keyPrefix: 'cbm_mcp_abc…' } });
  assert.equal('mcpCredential' in exposed, false);
  assert.equal(exposed.mcpAccess.keyPrefix, 'cbm_mcp_abc…');
  assert.equal(JSON.stringify(exposed).includes(encrypted.ciphertext), false);
});

test('gerencia somente as chaves MCP pertencentes ao painel', () => {
  const config = {
    mcp: {
      port: 8080,
      targets: [{ name: 'codebase-memory', stdio: { cmd: '/bin/example' } }],
      policies: {
        cors: { allowOrigins: ['*'] },
        apiKey: { mode: 'optional', keys: [{ key: 'manual-key', metadata: { owner: 'manual' } }] }
      }
    }
  };
  const user = { id: 'user-1', name: 'Maria', identity: 'maria@empresa.com' };

  setMcpGatewayUserKey(config, user, 'first-token');
  setMcpGatewayUserKey(config, user, 'rotated-token');

  assert.equal(config.mcp.policies.apiKey.mode, 'strict');
  assert.deepEqual(config.mcp.policies.cors, { allowOrigins: ['*'] });
  assert.deepEqual(config.mcp.policies.apiKey.keys.map(item => item.key), ['manual-key', 'rotated-token']);
  assert.equal(config.mcp.policies.mcpGuardrails.processors[0].failureMode, 'failClosed');
  assert.equal(config.mcp.policies.mcpGuardrails.processors[0].metadata.userId, 'apiKey.userId');
  assert.equal(config.mcp.targets[0].policies, undefined);

  removeMcpGatewayUserKey(config, user.id);
  assert.deepEqual(config.mcp.policies.apiKey.keys.map(item => item.key), ['manual-key']);
  assert.equal(config.mcp.policies.apiKey.mode, 'strict');
});

test('mantém strict com zero chaves depois da última revogação', () => {
  const config = { mcp: { policies: {}, targets: [{ name: 'codebase-memory', stdio: { cmd: '/bin/example' } }] } };
  removeMcpGatewayUserKey(config, 'missing-user');
  assert.deepEqual(config.mcp.policies.apiKey, { keys: [], mode: 'strict' });
});

test('recusa configurar guardrail sem um target MCP', () => {
  assert.throws(() => ensureMcpGatewayGuardrail({ mcp: { targets: [] } }), /target MCP/);
});

test('cadastro MCP persiste protegido sem expor o hash na API', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cbm-mcp-users-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'secrets', 'mcp-users.json');
  const user = { id: 'user-1', name: 'Maria', repositoryIds: ['repo-1'], tokenHash: 'secret-hash', status: 'active' };
  const store = { managed: true, users: [user] };

  await saveMcpUserStore(file, store);

  assert.deepEqual(await loadMcpUserStore(file), store);
  assert.deepEqual(publicMcpUser(user), { id: 'user-1', name: 'Maria', repositoryIds: ['repo-1'], status: 'active' });
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test('token técnico persiste em arquivo protegido', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cbm-mcp-system-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'secrets', 'mcp-system-token');
  const token = generateMcpToken();

  await saveSecret(file, token);

  assert.equal(await loadSecret(file), token);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('createMutex serializa operações assíncronas concorrentes e trata erros', async () => {
  const mutex = createMutex();
  const executionOrder = [];

  const task1 = mutex(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    executionOrder.push('task1');
    return 'result1';
  });

  const task2 = mutex(async () => {
    executionOrder.push('task2-start');
    throw new Error('falha na task2');
  });

  const task3 = mutex(async () => {
    executionOrder.push('task3');
    return 'result3';
  });

  const r1 = await task1;
  assert.equal(r1, 'result1');

  await assert.rejects(task2, /falha na task2/);

  const r3 = await task3;
  assert.equal(r3, 'result3');

  assert.deepEqual(executionOrder, ['task1', 'task2-start', 'task3']);
});

