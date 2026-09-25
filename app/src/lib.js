import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MCP_USER_MANAGER = 'codebase-memory-admin';
const MCP_GUARDRAIL_HOST = process.env.MCP_GUARDRAIL_HOST || 'admin:3001';
export const DEFAULT_WORKSPACE_CRON = '0 * * * *';
export const DEFAULT_TIMEZONE = 'America/Maceio';

function cronField(value, minimum, maximum, label) {
  const values = new Set();
  const source = String(value ?? '').trim();
  if (!source) throw new Error(`Campo ${label} do cron está vazio.`);
  for (const part of source.split(',')) {
    const [rangeSource, stepSource] = part.split('/');
    if (part.split('/').length > 2) throw new Error(`Campo ${label} do cron é inválido.`);
    const step = stepSource === undefined ? 1 : Number(stepSource);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Passo inválido no campo ${label} do cron.`);
    let start;
    let end;
    if (rangeSource === '*') {
      start = minimum;
      end = maximum;
    } else if (/^\d+$/.test(rangeSource)) {
      start = Number(rangeSource);
      end = stepSource === undefined ? start : maximum;
    } else {
      const match = /^(\d+)-(\d+)$/.exec(rangeSource);
      if (!match) throw new Error(`Campo ${label} do cron é inválido.`);
      start = Number(match[1]);
      end = Number(match[2]);
    }
    if (start < minimum || end > maximum || start > end) throw new Error(`Valor fora do intervalo no campo ${label} do cron.`);
    for (let current = start; current <= end; current += step) values.add(current === 7 && maximum === 7 ? 0 : current);
  }
  const expectedSize = maximum === 7 && minimum === 0 ? 7 : maximum - minimum + 1;
  return { values, unrestricted: values.size === expectedSize };
}

export function parseCronExpression(expression) {
  const normalized = String(expression ?? '').trim().replace(/\s+/g, ' ');
  const parts = normalized.split(' ');
  if (parts.length !== 5) throw new Error('Use uma expressão cron com cinco campos: minuto, hora, dia, mês e dia da semana.');
  return {
    expression: normalized,
    minute: cronField(parts[0], 0, 59, 'minuto'),
    hour: cronField(parts[1], 0, 23, 'hora'),
    day: cronField(parts[2], 1, 31, 'dia do mês'),
    month: cronField(parts[3], 1, 12, 'mês'),
    weekday: cronField(parts[4], 0, 7, 'dia da semana')
  };
}

function joinPortuguese(items) {
  if (items.length < 2) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`;
}

function simpleCronNumbers(source, minimum, maximum) {
  if (!/^(?:\d+)(?:,\d+)*$/.test(source)) return null;
  const values = [...new Set(source.split(',').map(Number))].sort((a, b) => a - b);
  return values.every(value => value >= minimum && value <= maximum) ? values : null;
}

export function describeCron(expression) {
  const cron = parseCronExpression(expression);
  const [minuteSource, hourSource, daySource, monthSource, weekdaySource] = cron.expression.split(' ');
  const calendarIsDaily = daySource === '*' && monthSource === '*' && weekdaySource === '*';
  if (cron.expression === '* * * * *') return 'Atualiza a cada minuto';
  const minuteStep = /^\*\/(\d+)$/.exec(minuteSource);
  if (minuteStep && hourSource === '*' && calendarIsDaily) return `Atualiza a cada ${Number(minuteStep[1])} minutos`;
  if (hourSource === '*' && calendarIsDaily) {
    const minutes = simpleCronNumbers(minuteSource, 0, 59);
    if (minutes?.length === 1) return minutes[0] === 0 ? 'Atualiza a cada hora' : `Atualiza a cada hora, no minuto ${minutes[0]}`;
  }
  const hours = simpleCronNumbers(hourSource, 0, 23);
  const minutes = simpleCronNumbers(minuteSource, 0, 59);
  if (hours && minutes && hours.length * minutes.length <= 12 && monthSource === '*') {
    const times = hours.flatMap(hour => minutes.map(minute => minute === 0 ? `${hour}h` : `${hour}h${String(minute).padStart(2, '0')}`));
    let frequency = 'diariamente';
    if (daySource === '*' && weekdaySource === '1-5') frequency = 'de segunda a sexta';
    else if (!calendarIsDaily) frequency = null;
    if (frequency) return `Atualiza ${frequency} ${joinPortuguese(times.map(time => `às ${time}`))}`;
  }
  return `Atualiza conforme o cron ${cron.expression}`;
}

const formatterCache = new Map();
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getFormatter(timezone) {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      minute: 'numeric', hour: 'numeric', hourCycle: 'h23',
      day: 'numeric', month: 'numeric', weekday: 'short'
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

export function validateTimezone(timezone) {
  const value = String(timezone ?? '').trim();
  try { getFormatter(value); }
  catch { throw new Error('Fuso horário inválido. Use um identificador como America/Maceio.'); }
  return value;
}

function zonedDateParts(date, timezone) {
  const parts = getFormatter(timezone).formatToParts(date);
  let minute;
  let hour;
  let day;
  let month;
  let weekday;
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    switch (item.type) {
      case 'minute': minute = Number(item.value); break;
      case 'hour': hour = Number(item.value); break;
      case 'day': day = Number(item.value); break;
      case 'month': month = Number(item.value); break;
      case 'weekday': weekday = WEEKDAYS[item.value] ?? -1; break;
    }
  }
  return { minute, hour, day, month, weekday };
}

export function cronMatches(expression, date, timezone) {
  const cron = typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const zone = validateTimezone(timezone);
  const local = zonedDateParts(date, zone);
  const dayMatches = cron.day.values.has(local.day);
  const weekdayMatches = cron.weekday.values.has(local.weekday);
  const calendarMatches = cron.day.unrestricted && cron.weekday.unrestricted
    ? true
    : cron.day.unrestricted ? weekdayMatches
      : cron.weekday.unrestricted ? dayMatches
        : dayMatches || weekdayMatches;
  return cron.minute.values.has(local.minute)
    && cron.hour.values.has(local.hour)
    && cron.month.values.has(local.month)
    && calendarMatches;
}

export function nextCronOccurrence(expression, timezone, after = new Date()) {
  const cron = parseCronExpression(expression);
  const zone = validateTimezone(timezone);
  const cursor = new Date(after);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let index = 0; index < limit; index += 1) {
    if (cronMatches(cron, cursor, zone)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error('O cron não possui uma próxima execução no período de um ano.');
}

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

export function assertSafeSegment(value, label = 'identificador') {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error(`${label} inválido.`);
  }
  return value;
}

export function safeChild(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const result = path.resolve(resolvedRoot, ...segments);
  if (result !== resolvedRoot && !result.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Caminho fora da raiz permitida.');
  }
  return result;
}

export function gitAuthEnvironment(token) {
  if (!token) return { GIT_TERMINAL_PROMPT: '0' };
  const credentials = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`,
    GIT_TERMINAL_PROMPT: '0'
  };
}

export function indexRepositoryArguments(repositoryPath) {
  return ['cli', 'index_repository', JSON.stringify({ repo_path: repositoryPath })];
}

export function parseLastJsonLine(output) {
  const lines = String(output ?? '').trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch { /* continue */ }
  }
  return null;
}

export function reconcileRepositoryProjects(repositories, projects) {
  const projectsByRoot = new Map((Array.isArray(projects) ? projects : [])
    .filter(item => typeof item?.name === 'string' && item.name && typeof item?.root_path === 'string' && item.root_path)
    .map(item => [path.resolve(item.root_path), item.name]));
  let changed = false;
  const reconciled = repositories.map(repository => {
    if (typeof repository?.path !== 'string' || !repository.path) return repository;
    const project = projectsByRoot.get(path.resolve(repository.path));
    if ((repository.project || undefined) === project) return repository;
    changed = true;
    const updated = { ...repository };
    if (project) updated.project = project;
    else delete updated.project;
    return updated;
  });
  return { repositories: reconciled, changed };
}

export async function loadState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return { workspaces: parsed.workspaces ?? [], repositories: parsed.repositories ?? [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { workspaces: [], repositories: [] };
    throw error;
  }
}

export async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export async function loadCredentials(file) {
  try {
    const credentials = JSON.parse(await readFile(file, 'utf8'));
    if (typeof credentials.token !== 'string' || !credentials.token || !credentials.user?.login) return null;
    return credentials;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveCredentials(file, credentials) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function generateMcpToken() {
  return `cbm_mcp_${randomBytes(32).toString('base64url')}`;
}

export function mcpTokenFingerprint(token) {
  return createHash('sha256').update(token).digest('hex');
}

function workspaceTokenKey(secret) {
  const value = String(secret || '').trim();
  if (!value) throw new Error('A chave de criptografia dos tokens MCP não foi configurada.');
  return createHash('sha256').update(value).digest();
}

export function encryptWorkspaceToken(token, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', workspaceTokenKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url')
  };
}

export function decryptWorkspaceToken(encrypted, secret) {
  if (encrypted?.algorithm !== 'aes-256-gcm') throw new Error('Formato do token criptografado não suportado.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', workspaceTokenKey(secret), Buffer.from(encrypted.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    throw new Error('Não foi possível descriptografar o token MCP do workspace. Verifique a chave de criptografia.');
  }
}

export function publicWorkspace(item) {
  const { mcpCredential, ...visible } = item;
  if (mcpCredential) {
    visible.mcpAccess = {
      status: mcpCredential.status,
      keyPrefix: mcpCredential.keyPrefix,
      tokenCreatedAt: mcpCredential.tokenCreatedAt,
      updatedAt: mcpCredential.updatedAt,
      revokedAt: mcpCredential.revokedAt
    };
  }
  return visible;
}

export function publicMcpUser(user) {
  const visible = {};
  for (const key of ['id', 'name', 'identity', 'description', 'repositoryIds', 'status', 'keyPrefix', 'createdAt', 'updatedAt', 'tokenCreatedAt', 'revokedAt']) {
    if (Object.hasOwn(user, key)) visible[key] = user[key];
  }
  return visible;
}

export async function loadMcpUserStore(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return {
      managed: parsed.managed === true,
      users: Array.isArray(parsed.users) ? parsed.users : []
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { managed: false, users: [] };
    throw error;
  }
}

export async function saveMcpUserStore(file, store) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export async function loadSecret(file) {
  try {
    const value = (await readFile(file, 'utf8')).trim();
    return value || null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveSecret(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${value}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function ensureMcpApiKeyPolicy(config) {
  config.mcp ??= {};
  config.mcp.policies ??= {};
  config.mcp.policies.apiKey ??= { keys: [] };
  const policy = config.mcp.policies.apiKey;
  if (!Array.isArray(policy.keys)) throw new Error('A política apiKey do AgentGateway possui um formato inválido.');
  policy.mode = 'strict';
  return policy;
}

function isManagedMcpKey(entry, userId) {
  return entry?.metadata?.managedBy === MCP_USER_MANAGER && entry.metadata.userId === userId;
}

export function ensureMcpGatewayGuardrail(config) {
  const targets = config?.mcp?.targets;
  if (!Array.isArray(targets) || !targets.length) {
    throw new Error('O AgentGateway não possui um target MCP para proteger.');
  }
  config.mcp.policies ??= {};
  config.mcp.policies.mcpGuardrails = {
    processors: [{
      kind: 'remote',
      methods: { 'tools/call': 'full', 'tools/list': 'response' },
      host: MCP_GUARDRAIL_HOST,
      failureMode: 'failClosed',
      metadata: {
        userId: 'apiKey.userId',
        toolName: 'mcp.tool.name'
      },
      requestHeaders: { allowed: [] }
    }]
  };
  return config;
}

export function setMcpGatewayUserKey(config, user, token) {
  ensureMcpGatewayGuardrail(config);
  const policy = ensureMcpApiKeyPolicy(config);
  policy.keys = policy.keys.filter(entry => !isManagedMcpKey(entry, user.id));
  policy.keys.push({
    key: token,
    metadata: {
      managedBy: MCP_USER_MANAGER,
      userId: user.id,
      user: user.name,
      identity: user.identity,
      access: user.id === 'system-playground' ? 'system' : user.workspaceId ? 'workspace-scoped' : 'repository-scoped',
      ...(user.workspaceId ? { workspaceId: user.workspaceId } : {})
    }
  });
  return config;
}

export function removeMcpGatewayUserKey(config, userId) {
  ensureMcpGatewayGuardrail(config);
  const policy = ensureMcpApiKeyPolicy(config);
  policy.keys = policy.keys.filter(entry => !isManagedMcpKey(entry, userId));
  return config;
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const limit = options.outputLimit ?? 200_000;
    child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-limit); options.onOutput?.(chunk.toString()); });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-limit); options.onOutput?.(chunk.toString()); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `${command} terminou com código ${code}.`), { code, stdout, stderr }));
    });
  });
}

/**
 * Cria um mutex assíncrono para serializar operações concorrentes.
 * Garante ordem FIFO e resiliência contra rejeições.
 *
 * @returns {<T>(fn: () => Promise<T> | T) => Promise<T>}
 */
export function createMutex() {
  let current = Promise.resolve();
  return function acquire(fn) {
    const next = current.then(() => fn());
    current = next.catch(() => {});
    return next;
  };
}

