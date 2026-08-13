import { createSign, createHash } from 'node:crypto';
import { normalizeLinkInput } from './web-links.js';

export const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const MANAGED_ROOT = 'Google Drive (gerenciado)';
export const DEFAULT_KNOWLEDGE_CRON = '30 * * * *';
export const DEFAULT_TIMEZONE = 'America/Maceio';

function cronField(value, minimum, maximum, label) {
  const values = new Set();
  const source = String(value ?? '').trim();
  if (!source) throw new Error(`Campo ${label} do cron está vazio.`);
  for (const part of source.split(',')) {
    const pieces = part.split('/');
    if (pieces.length > 2) throw new Error(`Campo ${label} do cron é inválido.`);
    const [rangeSource, stepSource] = pieces;
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

export function validateTimezone(timezone) {
  const value = String(timezone ?? '').trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); }
  catch { throw new Error('Fuso horário inválido. Use um identificador como America/Maceio.'); }
  return value;
}

function zonedDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    minute: 'numeric', hour: 'numeric', hourCycle: 'h23',
    day: 'numeric', month: 'numeric', weekday: 'short'
  }).formatToParts(date);
  const value = type => parts.find(item => item.type === type)?.value;
  return {
    minute: Number(value('minute')),
    hour: Number(value('hour')),
    day: Number(value('day')),
    month: Number(value('month')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'))
  };
}

export function cronMatches(expression, date, timezone) {
  const cron = typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const local = zonedDateParts(date, validateTimezone(timezone));
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

function seekCronOccurrence(expression, timezone, from, direction, includeCurrent) {
  const cron = parseCronExpression(expression);
  const zone = validateTimezone(timezone);
  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  if (!includeCurrent) cursor.setUTCMinutes(cursor.getUTCMinutes() + direction);
  const limit = 366 * 24 * 60;
  for (let index = 0; index < limit; index += 1) {
    if (cronMatches(cron, cursor, zone)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + direction);
  }
  throw new Error('O cron não possui uma ocorrência no período de um ano.');
}

export function nextCronOccurrence(expression, timezone, after = new Date()) {
  return seekCronOccurrence(expression, timezone, after, 1, false);
}

export function previousCronOccurrence(expression, timezone, at = new Date()) {
  return seekCronOccurrence(expression, timezone, at, -1, true);
}

export function describeCron(expression) {
  const cron = parseCronExpression(expression);
  const [minute, hour, day, month, weekday] = cron.expression.split(' ');
  if (hour === '*' && day === '*' && month === '*' && weekday === '*' && /^\d+$/.test(minute)) {
    return Number(minute) === 0 ? 'A cada hora' : `A cada hora, no minuto ${Number(minute)}`;
  }
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && hour === '*' && day === '*' && month === '*' && weekday === '*') return `A cada ${Number(step[1])} minutos`;
  return `Cron ${cron.expression}`;
}

export function legacyIntervalToCron(intervalMinutes) {
  const interval = Number.parseInt(intervalMinutes, 10);
  if (interval === 60) return DEFAULT_KNOWLEDGE_CRON;
  if (interval > 0 && interval < 60 && 60 % interval === 0) return `*/${interval} * * * *`;
  if (interval > 60 && interval < 1440 && interval % 60 === 0 && 24 % (interval / 60) === 0) return `30 */${interval / 60} * * *`;
  if (interval === 1440) return '30 0 * * *';
  if (interval === 10_080) return '30 0 * * 0';
  return DEFAULT_KNOWLEDGE_CRON;
}

export function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

export function createServiceAccountAssertion(credentials, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!credentials?.client_email || !credentials?.private_key) throw new Error('Service Account do Google inválida.');
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: credentials.token_uri || 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(credentials.private_key, 'base64url')}`;
}

export function sanitizeDriveName(value, fallback = 'sem-nome') {
  const sanitized = String(value || '').replace(/[\x00-\x1f/\\]+/g, '-').replace(/\s+/g, ' ').trim();
  return (sanitized || fallback).slice(0, 180);
}

export function folderRoot(folder) {
  return `${MANAGED_ROOT}/${sanitizeDriveName(folder.name, 'pasta')}--${folder.id.slice(0, 8)}`;
}

export function fileChecksum(file) {
  if (file.md5Checksum) return `md5:${file.md5Checksum}`;
  return `meta:${createHash('sha256').update([
    file.id,
    file.modifiedTime || '',
    file.size || '',
    file.mimeType || ''
  ].join('|')).digest('hex')}`;
}

export function normalizeTargetInput(payload) {
  const knowledgeBaseId = String(payload?.knowledgeBaseId || '').trim();
  const knowledgeBaseName = String(payload?.knowledgeBaseName || '').trim().slice(0, 200);
  const enabled = payload?.enabled !== false;
  const cron = parseCronExpression(payload?.cron || legacyIntervalToCron(payload?.intervalMinutes ?? 60)).expression;
  const timezone = validateTimezone(payload?.timezone || DEFAULT_TIMEZONE);
  if (!knowledgeBaseId || !/^[A-Za-z0-9_-]+$/.test(knowledgeBaseId)) throw new Error('Knowledge Base inválida.');
  if (payload?.folders !== undefined && !Array.isArray(payload.folders)) throw new Error('A lista de pastas do Google Drive é inválida.');
  if (payload?.links !== undefined && !Array.isArray(payload.links)) throw new Error('A lista de links é inválida.');
  const seen = new Set();
  const folders = (payload.folders || []).map(folder => {
    const id = String(folder?.id || '').trim();
    const name = sanitizeDriveName(folder?.name, 'Pasta do Drive');
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Uma das pastas selecionadas possui ID inválido.');
    if (seen.has(id)) throw new Error('A mesma pasta foi selecionada mais de uma vez.');
    seen.add(id);
    return { id, name };
  });
  const seenLinks = new Set();
  const links = (payload.links || []).map(link => {
    const normalized = normalizeLinkInput(link);
    if (seenLinks.has(normalized.url)) throw new Error('O mesmo link foi informado mais de uma vez.');
    seenLinks.add(normalized.url);
    return normalized;
  });
  if (!folders.length && !links.length) throw new Error('Selecione pelo menos uma pasta do Google Drive ou adicione um link.');
  return { knowledgeBaseId, knowledgeBaseName, folders, links, enabled, cron, timezone };
}

export function nextRunAt(target, from = new Date()) {
  if (!target?.enabled) return null;
  return nextCronOccurrence(target.cron, target.timezone, from).toISOString();
}

export function isTargetDue(target, now = new Date()) {
  if (!target?.enabled) return false;
  const slot = previousCronOccurrence(target.cron, target.timezone, now);
  const notBefore = new Date(target.lastScheduledAt || target.lastRunAt || target.createdAt || target.updatedAt || 0);
  return slot.getTime() > notBefore.getTime();
}

export function scheduledSlot(target, now = new Date()) {
  return previousCronOccurrence(target.cron, target.timezone, now).toISOString();
}

export function migrateTargetSchedule(target, defaultTimezone = DEFAULT_TIMEZONE) {
  const migrated = { ...target };
  let changed = false;
  if (!migrated.cron) {
    migrated.cron = legacyIntervalToCron(migrated.intervalMinutes ?? 60);
    changed = true;
  }
  migrated.cron = parseCronExpression(migrated.cron).expression;
  if (!migrated.timezone) {
    migrated.timezone = validateTimezone(defaultTimezone);
    changed = true;
  } else migrated.timezone = validateTimezone(migrated.timezone);
  if ('intervalMinutes' in migrated) {
    delete migrated.intervalMinutes;
    changed = true;
  }
  return { target: migrated, changed };
}

export function migrateTargetSources(target) {
  let changed = false;
  const migrated = { ...target };
  if (!Array.isArray(migrated.folders)) { migrated.folders = []; changed = true; }
  if (!Array.isArray(migrated.links)) { migrated.links = []; changed = true; }
  if (!migrated.files || typeof migrated.files !== 'object') { migrated.files = {}; changed = true; }
  migrated.files = Object.fromEntries(Object.entries(migrated.files).map(([sourceKey, file]) => {
    if (file.sourceType) return [sourceKey, file];
    changed = true;
    return [sourceKey, { ...file, sourceType: 'google-drive' }];
  }));
  return { target: migrated, changed };
}

export function publicTarget(target, running = false) {
  const { files: _files, directories: _directories, changePageToken: _changePageToken, scannedFolderIds: _scannedFolderIds, ...visible } = target;
  const files = Object.values(target.files || {});
  return {
    ...visible,
    managedFileCount: files.length,
    managedDriveFileCount: files.filter(file => (file.sourceType || 'google-drive') === 'google-drive').length,
    managedLinkCount: files.filter(file => file.sourceType === 'web-link').length,
    failedFileCount: files.filter(file => file.status === 'failed').length,
    running,
    scheduleDescription: describeCron(target.cron),
    nextRunAt: running ? null : nextRunAt(target)
  };
}

export function changesAffectTarget(target, changes) {
  const knownFiles = new Set(Object.values(target.files || {}).map(file => file.driveFileId).filter(Boolean));
  const knownFolders = new Set([...(target.scannedFolderIds || []), ...(target.folders || []).map(folder => folder.id)]);
  return changes.some(change => {
    if (knownFiles.has(change.fileId)) return true;
    const file = change.file;
    if (!file) return false;
    if (knownFiles.has(file.id)) return true;
    return (file.parents || []).some(parent => knownFolders.has(parent));
  });
}

export function fullReconciliationDue(target, now = new Date(), intervalHours = 168) {
  if (!target.lastFullScanAt) return true;
  const elapsed = now.getTime() - new Date(target.lastFullScanAt).getTime();
  return !Number.isFinite(elapsed) || elapsed >= intervalHours * 60 * 60 * 1000;
}
