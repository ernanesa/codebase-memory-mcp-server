import http from 'node:http';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { changesAffectTarget, createServiceAccountAssertion, fileChecksum, folderRoot, fullReconciliationDue, GOOGLE_FOLDER_MIME, isTargetDue, MANAGED_ROOT, migrateTargetSchedule, migrateTargetSources, nextRunAt, normalizeTargetInput, publicTarget, sanitizeDriveName, scheduledSlot } from './lib.js';
import { gauge, increment, log, metricsText, observe, timed } from './observability.js';
import { buildLinkDocument, DEFAULT_LINK_MAX_BYTES, DEFAULT_LINK_MAX_REDIRECTS, DEFAULT_LINK_TIMEOUT_MS, fetchWebLink, validateWebLinkDestination, WEB_LINK_ROOT, webLinkSourceKey } from './web-links.js';

const PORT = Number(process.env.PORT || 3002);
const DATA_DIR = process.env.SYNC_DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const GOOGLE_CREDENTIALS_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/run/secrets/google-drive-service-account.json';
const API_TOKEN_FILE = process.env.KNOWLEDGE_SYNC_TOKEN_FILE || '/run/secrets/knowledge-sync-token';
const OPENWEBUI_URL = String(process.env.OPENWEBUI_URL || 'http://open-webui:8080').replace(/\/+$/, '');
const GOOGLE_API_URL = String(process.env.GOOGLE_API_URL || 'https://www.googleapis.com').replace(/\/+$/, '');
const OPENWEBUI_EMAIL = process.env.WEBUI_ADMIN_EMAIL || '';
const OPENWEBUI_PASSWORD = process.env.WEBUI_ADMIN_PASSWORD || '';
const DEFAULT_SYNC_TIMEZONE = process.env.KNOWLEDGE_SYNC_TIMEZONE || 'America/Maceio';
const HISTORY_LIMIT = 200;
const FULL_RECONCILIATION_HOURS = Math.max(1, Number.parseInt(process.env.KNOWLEDGE_SYNC_FULL_RECONCILIATION_HOURS || '168', 10) || 168);
const HTTP_RETRY_ATTEMPTS = Math.max(1, Math.min(6, Number.parseInt(process.env.KNOWLEDGE_SYNC_HTTP_RETRY_ATTEMPTS || '3', 10) || 3));
const CITATION_METADATA_VERSION = 1;
const LINK_TIMEOUT_MS = Math.max(1_000, Number.parseInt(process.env.KNOWLEDGE_SYNC_LINK_TIMEOUT_MS || String(DEFAULT_LINK_TIMEOUT_MS), 10) || DEFAULT_LINK_TIMEOUT_MS);
const LINK_MAX_BYTES = Math.max(1_024, Number.parseInt(process.env.KNOWLEDGE_SYNC_LINK_MAX_BYTES || String(DEFAULT_LINK_MAX_BYTES), 10) || DEFAULT_LINK_MAX_BYTES);
const LINK_MAX_REDIRECTS = Math.max(0, Math.min(10, Number.parseInt(process.env.KNOWLEDGE_SYNC_LINK_MAX_REDIRECTS || String(DEFAULT_LINK_MAX_REDIRECTS), 10) || DEFAULT_LINK_MAX_REDIRECTS));

await mkdir(DATA_DIR, { recursive: true });
const apiToken = (await readFile(API_TOKEN_FILE, 'utf8')).trim();
if (!apiToken) throw new Error('Token interno do knowledge-sync não configurado.');
if (!OPENWEBUI_EMAIL || !OPENWEBUI_PASSWORD) throw new Error('Credencial administrativa do Open WebUI não configurada.');

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return { version: parsed.version || 1, targets: parsed.targets || [], history: parsed.history || [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, targets: [], history: [] };
    throw error;
  }
}

let state = await loadState();
let mutation = Promise.resolve();
let persistence = Promise.resolve();
const running = new Set();
const queued = new Set();
let executionQueue = Promise.resolve();
let googleCredentials = null;
let googleCredentialsRaw = '';
let googleCredentialsError = null;
let googleToken = null;
let openwebuiToken = null;

async function refreshGoogleCredentials(required = false) {
  try {
    const raw = await readFile(GOOGLE_CREDENTIALS_FILE, 'utf8');
    if (raw !== googleCredentialsRaw) {
      const parsed = JSON.parse(raw);
      if (parsed?.type !== 'service_account' || !parsed.client_email || !parsed.private_key) {
        throw new Error('O JSON não representa uma Service Account válida.');
      }
      googleCredentials = parsed;
      googleCredentialsRaw = raw;
      googleCredentialsError = null;
      googleToken = null;
    }
    return googleCredentials;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      googleCredentials = null;
      googleCredentialsRaw = '';
      googleCredentialsError = null;
      googleToken = null;
      if (!required) return null;
      throw new Error('Configure a Service Account do Google Drive no painel administrativo.');
    }
    googleCredentials = null;
    googleCredentialsRaw = '';
    googleCredentialsError = error.message;
    googleToken = null;
    if (!required) return null;
    throw new Error(`Credencial do Google Drive inválida: ${error.message}`);
  }
}

await refreshGoogleCredentials(false);

function withMutation(operation) {
  const next = mutation.then(operation, operation);
  mutation = next.catch(() => {});
  return next;
}

function persist() {
  const operation = async () => {
    const temporary = `${STATE_FILE}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, STATE_FILE);
  };
  persistence = persistence.then(operation, operation);
  return persistence;
}

let scheduleMigrationNeeded = state.version < 4;
state.targets = state.targets.map(target => {
  const migration = migrateTargetSchedule(target, DEFAULT_SYNC_TIMEZONE);
  scheduleMigrationNeeded ||= migration.changed;
  const sourceMigration = migrateTargetSources(migration.target);
  scheduleMigrationNeeded ||= sourceMigration.changed;
  const migrated = sourceMigration.target;
  migrated.directories ||= {};
  migrated.scannedFolderIds ||= (migrated.folders || []).map(folder => folder.id);
  for (const file of Object.values(migrated.files)) {
    file.status ||= 'indexed';
    file.lastSuccessAt ||= migrated.lastRunAt || null;
    file.lastAttemptAt ||= file.lastSuccessAt;
    file.error ||= null;
  }
  return migrated;
});
state.version = 4;
if (scheduleMigrationNeeded) await persist();

function isBusy(knowledgeBaseId) {
  return running.has(knowledgeBaseId) || queued.has(knowledgeBaseId);
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function textResponse(response, status, payload, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(payload);
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fetchWithRetry(url, options, provider) {
  let response;
  let lastError;
  for (let attempt = 1; attempt <= HTTP_RETRY_ATTEMPTS; attempt += 1) {
    try {
      response = await fetch(url, options);
      increment('knowledge_sync_http_requests_total', { provider, status: response.status });
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new Error(`${provider} respondeu HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
      increment('knowledge_sync_http_requests_total', { provider, status: 'network_error' });
    }
    if (attempt < HTTP_RETRY_ATTEMPTS) await wait(250 * (2 ** (attempt - 1)));
  }
  if (response) return response;
  throw lastError;
}

async function requestBody(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Corpo da requisição muito grande.');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('JSON inválido.'); }
}

async function getGoogleToken() {
  await refreshGoogleCredentials(true);
  if (googleToken && googleToken.expiresAt > Date.now() + 60_000) return googleToken.value;
  const assertion = createServiceAccountAssertion(googleCredentials);
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });
  const response = await fetchWithRetry(googleCredentials.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(30_000)
  }, 'google_oauth');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error(`Falha ao autenticar no Google Drive: ${payload.error_description || payload.error || response.status}.`);
  googleToken = { value: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000 };
  return googleToken.value;
}

async function google(pathname, options = {}, retry = true) {
  const token = await getGoogleToken();
  const response = await fetchWithRetry(`${GOOGLE_API_URL}${pathname}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...options.headers },
    signal: options.signal || AbortSignal.timeout(60_000)
  }, 'google_drive');
  if (response.status === 401 && retry) {
    googleToken = null;
    return google(pathname, options, false);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`Google Drive respondeu HTTP ${response.status}: ${payload.error?.message || 'requisição rejeitada'}.`);
  }
  return response;
}

async function listDriveFiles(query, orderBy = 'name') {
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: query,
      pageSize: '1000',
      orderBy,
      spaces: 'drive',
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,md5Checksum,parents,trashed,webViewLink)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await google(`/drive/v3/files?${params}`);
    const payload = await response.json();
    files.push(...(payload.files || []));
    pageToken = payload.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function getDriveFile(id) {
  const params = new URLSearchParams({ fields: 'id,name,mimeType,modifiedTime,size,md5Checksum,parents,trashed,webViewLink', supportsAllDrives: 'true' });
  const response = await google(`/drive/v3/files/${encodeURIComponent(id)}?${params}`);
  return response.json();
}

async function assertNoOverlappingFolders(folders) {
  const selected = new Set(folders.map(folder => folder.id));
  const metadata = new Map(folders.map(folder => [folder.id, folder]));
  for (const folder of folders) {
    const pending = [...(folder.parents || [])];
    const visited = new Set();
    while (pending.length) {
      const parentId = pending.shift();
      if (!parentId || visited.has(parentId)) continue;
      visited.add(parentId);
      if (selected.has(parentId)) throw new Error('Não selecione ao mesmo tempo uma pasta e uma subpasta dela.');
      try {
        const parent = metadata.get(parentId) || await getDriveFile(parentId);
        metadata.set(parentId, parent);
        pending.push(...(parent.parents || []));
      } catch {
        // Uma pasta compartilhada diretamente pode ocultar seus ancestrais.
      }
    }
  }
}

const GOOGLE_EXPORTS = new Map([
  ['application/vnd.google-apps.document', { mime: 'text/plain', extension: '.txt' }],
  ['application/vnd.google-apps.spreadsheet', { mime: 'text/csv', extension: '.csv' }],
  ['application/vnd.google-apps.presentation', { mime: 'text/plain', extension: '.txt' }],
  ['application/vnd.google-apps.drawing', { mime: 'application/pdf', extension: '.pdf' }]
]);

function downloadableFile(file, relativePath, rootFolder) {
  const googleExport = GOOGLE_EXPORTS.get(file.mimeType);
  if (file.mimeType.startsWith('application/vnd.google-apps.') && !googleExport) return null;
  const originalName = sanitizeDriveName(file.name, file.id);
  let filename = originalName;
  if (googleExport?.extension && !filename.toLowerCase().endsWith(googleExport.extension)) filename += googleExport.extension;
  return {
    sourceKey: `${rootFolder.id}:${file.id}`,
    driveFileId: file.id,
    folderId: rootFolder.id,
    path: relativePath,
    filename,
    originalName,
    canonicalUrl: typeof file.webViewLink === 'string' ? file.webViewLink : null,
    mimeType: file.mimeType,
    exportMime: googleExport?.mime || null,
    checksum: fileChecksum(file),
    modifiedTime: file.modifiedTime || null,
    size: file.size || null
  };
}

async function scanFolder(rootFolder, currentFolderId = rootFolder.id, relativePath = '', seen = new Set(), scannedFolderIds = new Set()) {
  if (seen.has(currentFolderId)) return [];
  seen.add(currentFolderId);
  scannedFolderIds.add(currentFolderId);
  const children = await listDriveFiles(`'${currentFolderId.replaceAll("'", "\\'")}' in parents and trashed = false`);
  const entries = [];
  for (const child of children) {
    if (child.mimeType === GOOGLE_FOLDER_MIME) {
      const childPath = [relativePath, sanitizeDriveName(child.name, child.id)].filter(Boolean).join('/');
      entries.push(...await scanFolder(rootFolder, child.id, childPath, seen, scannedFolderIds));
      continue;
    }
    const entry = downloadableFile(child, relativePath, rootFolder);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function getStartPageToken() {
  const params = new URLSearchParams({ supportsAllDrives: 'true' });
  const response = await google(`/drive/v3/changes/startPageToken?${params}`);
  const payload = await response.json();
  if (!payload.startPageToken) throw new Error('Google Drive não retornou o token inicial de alterações.');
  return payload.startPageToken;
}

async function listDriveChanges(pageToken) {
  const changes = [];
  let token = pageToken;
  let newStartPageToken = null;
  do {
    const params = new URLSearchParams({
      pageToken: token,
      pageSize: '1000',
      spaces: 'drive',
      includeRemoved: 'true',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,size,md5Checksum,parents,trashed,webViewLink))'
    });
    const response = await google(`/drive/v3/changes?${params}`);
    const payload = await response.json();
    changes.push(...(payload.changes || []));
    token = payload.nextPageToken || '';
    newStartPageToken = payload.newStartPageToken || newStartPageToken;
  } while (token);
  return { changes, newStartPageToken: newStartPageToken || pageToken };
}

async function downloadDriveFile(entry) {
  const suffix = entry.exportMime
    ? `/drive/v3/files/${encodeURIComponent(entry.driveFileId)}/export?mimeType=${encodeURIComponent(entry.exportMime)}`
    : `/drive/v3/files/${encodeURIComponent(entry.driveFileId)}?alt=media&supportsAllDrives=true`;
  const response = await google(suffix, { signal: AbortSignal.timeout(120_000) });
  return Buffer.from(await response.arrayBuffer());
}

async function signInOpenWebui() {
  const response = await fetchWithRetry(`${OPENWEBUI_URL}/api/v1/auths/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPENWEBUI_EMAIL, password: OPENWEBUI_PASSWORD }),
    signal: AbortSignal.timeout(30_000)
  }, 'openwebui');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.token) throw new Error(`Falha ao autenticar no Open WebUI: ${payload.detail || response.status}.`);
  openwebuiToken = payload.token;
  return openwebuiToken;
}

async function openwebui(pathname, options = {}, retry = true) {
  const token = openwebuiToken || await signInOpenWebui();
  const response = await fetchWithRetry(`${OPENWEBUI_URL}/api/v1${pathname}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...options.headers },
    signal: options.signal || AbortSignal.timeout(180_000)
  }, 'openwebui');
  if (response.status === 401 && retry) {
    openwebuiToken = null;
    return openwebui(pathname, options, false);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`Open WebUI respondeu HTTP ${response.status}: ${payload.detail || payload.error || 'requisição rejeitada'}.`);
  }
  return response;
}

async function getOpenWebuiPublicConfig(retry = true) {
  const token = openwebuiToken || await signInOpenWebui();
  const response = await fetchWithRetry(`${OPENWEBUI_URL}/api/config`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000)
  }, 'openwebui');
  if (response.status === 401 && retry) {
    openwebuiToken = null;
    return getOpenWebuiPublicConfig(false);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Open WebUI respondeu HTTP ${response.status} ao consultar a integração do Drive.`);
  return payload;
}

function publicPickerConfig(config) {
  const clientId = String(config?.google_drive?.client_id || '');
  const apiKey = String(config?.google_drive?.api_key || '');
  const enabled = config?.features?.enable_google_drive_integration === true;
  return {
    enabled,
    configured: enabled && Boolean(clientId) && Boolean(apiKey),
    clientId: clientId || null,
    apiKeyConfigured: Boolean(apiKey),
    apiKeySuffix: apiKey ? apiKey.slice(-4) : null
  };
}

async function setPickerConfig(clientId, apiKey, enabled) {
  await openwebui('/configs/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      config: {
        'google_drive.enable': enabled,
        'google_drive.client_id': clientId,
        'google_drive.api_key': apiKey
      }
    })
  });
  return publicPickerConfig(await getOpenWebuiPublicConfig());
}

function validatePickerConfig(input) {
  const clientId = String(input.clientId || '').trim();
  const apiKey = String(input.apiKey || '').trim();
  if (!/^[^\s=]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('Informe um OAuth Client ID válido, terminado em .apps.googleusercontent.com.');
  }
  if (apiKey.length < 20 || /[\s=]/.test(apiKey)) {
    throw new Error('Informe uma API Key válida do Google Picker, sem espaços.');
  }
  return { clientId, apiKey };
}

async function listKnowledgeBases() {
  const items = [];
  let page = 1;
  let total = Infinity;
  while (items.length < total) {
    const response = await openwebui(`/knowledge/?page=${page}`);
    const payload = await response.json();
    const current = payload.items || (Array.isArray(payload) ? payload : []);
    items.push(...current);
    total = Number(payload.total ?? items.length);
    if (!current.length) break;
    page += 1;
  }
  return items.map(item => ({ id: item.id, name: item.name, description: item.description || '', writeAccess: item.write_access !== false }));
}

async function createDirectory(knowledgeBaseId, name, parentId = null) {
  const response = await openwebui(`/knowledge/${knowledgeBaseId}/dirs/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, parent_id: parentId })
  });
  return response.json();
}

async function ensureDirectory(target, logicalPath) {
  const segments = logicalPath.split('/').filter(Boolean);
  let accumulated = '';
  let parentId = null;
  for (const segment of segments) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    if (!target.directories[accumulated]) {
      const created = await createDirectory(target.knowledgeBaseId, segment, parentId);
      target.directories[accumulated] = created.id;
      await persist();
    }
    parentId = target.directories[accumulated];
  }
  return parentId;
}

async function uploadFile(target, entry, content, directoryId) {
  const form = new FormData();
  form.append('file', new Blob([content]), entry.filename);
  form.append('metadata', JSON.stringify({
    knowledge_id: target.knowledgeBaseId,
    file_hash: entry.checksum,
    directory_id: directoryId,
    source: entry.sourceType || 'google-drive',
    drive_file_id: entry.driveFileId || null,
    drive_folder_id: entry.folderId || null,
    source_url: entry.canonicalUrl,
    final_url: entry.finalUrl || null,
    source_description: entry.description || null,
    content_type: entry.mimeType || null,
    etag: entry.etag || null,
    last_modified: entry.lastModified || null,
    original_name: entry.originalName,
    managed_path: entry.managedPath,
    modified_time: entry.modifiedTime,
    fetched_at: entry.fetchedAt || null,
    ingested_at: new Date().toISOString()
  }));
  const response = await openwebui('/files/', { method: 'POST', body: form });
  const payload = await response.json();
  if (!payload.id) throw new Error(`Open WebUI não retornou o ID de ${entry.filename}.`);
  return payload.id;
}

async function cleanupFiles(knowledgeBaseId, fileIds) {
  if (!fileIds.length) return;
  await openwebui(`/knowledge/${knowledgeBaseId}/sync/cleanup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_ids: fileIds, dir_ids: [] })
  });
}

function recordHistory(target, run) {
  state.history.unshift({
    id: crypto.randomUUID(),
    knowledgeBaseId: target.knowledgeBaseId,
    knowledgeBaseName: target.knowledgeBaseName,
    ...run
  });
  state.history = state.history.slice(0, HISTORY_LIMIT);
}

async function processManifestEntry(target, entry, counters, operationId, force = false) {
  const previous = target.files[entry.sourceKey];
  const sourceMetric = entry.sourceType === 'web-link' ? 'knowledge_sync_links_total' : 'drive_sync_files_total';
  if (!force
    && previous?.fileId
    && previous.status !== 'failed'
    && previous.checksum === entry.checksum
    && previous.managedPath === entry.managedPath
    && previous.filename === entry.filename
    && previous.originalName === entry.originalName
    && previous.canonicalUrl === entry.canonicalUrl
    && (previous.description || '') === (entry.description || '')
    && previous.citationMetadataVersion === CITATION_METADATA_VERSION) {
    previous.modifiedTime = entry.modifiedTime;
    previous.size = entry.size;
    previous.finalUrl = entry.finalUrl || previous.finalUrl || null;
    previous.etag = entry.etag || null;
    previous.lastModified = entry.lastModified || null;
    previous.fetchedAt = entry.fetchedAt || previous.fetchedAt || null;
    previous.lastAttemptAt = new Date().toISOString();
    counters.unchanged += 1;
    increment(sourceMetric, { operation: 'unchanged', status: 'completed' });
    return;
  }

  const attemptedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const content = entry.content || await timed('drive_download_duration_seconds', {}, () => downloadDriveFile(entry));
    const directoryId = await ensureDirectory(target, entry.managedPath || MANAGED_ROOT);
    const newFileId = await timed('openwebui_ingestion_duration_seconds', { status: 'attempt' }, () => uploadFile(target, entry, content, directoryId));
    target.files[entry.sourceKey] = {
      fileId: newFileId,
      sourceType: entry.sourceType || 'google-drive',
      driveFileId: entry.driveFileId,
      folderId: entry.folderId,
      checksum: entry.checksum,
      managedPath: entry.managedPath,
      filename: entry.filename,
      originalName: entry.originalName,
      canonicalUrl: entry.canonicalUrl,
      finalUrl: entry.finalUrl || null,
      description: entry.description || '',
      etag: entry.etag || null,
      lastModified: entry.lastModified || null,
      fetchedAt: entry.fetchedAt || null,
      citationMetadataVersion: CITATION_METADATA_VERSION,
      mimeType: entry.mimeType,
      exportMime: entry.exportMime,
      modifiedTime: entry.modifiedTime,
      size: entry.size,
      status: 'indexed',
      error: null,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started)
    };
    await persist();
    if (previous?.fileId && previous.fileId !== newFileId) {
      try {
        await cleanupFiles(target.knowledgeBaseId, [previous.fileId]);
        target.files[entry.sourceKey].cleanupError = null;
      } catch (error) {
        target.files[entry.sourceKey].cleanupError = error.message;
        increment(sourceMetric, { operation: 'cleanup', status: 'failed' });
        log('warn', 'previous_file_cleanup_failed', { operationId, knowledgeBaseId: target.knowledgeBaseId, sourceKey: entry.sourceKey, error: error.message });
      }
      counters.modified += 1;
      increment(sourceMetric, { operation: 'modified', status: 'completed' });
    } else {
      counters.added += 1;
      increment(sourceMetric, { operation: 'added', status: 'completed' });
    }
    await persist();
    log('info', 'file_processed', { operationId, knowledgeBaseId: target.knowledgeBaseId, sourceKey: entry.sourceKey, durationMs: Math.round(performance.now() - started) });
  } catch (error) {
    target.files[entry.sourceKey] = {
      ...(previous || {}),
      sourceType: entry.sourceType || previous?.sourceType || 'google-drive',
      driveFileId: entry.driveFileId,
      folderId: entry.folderId,
      checksum: entry.checksum,
      managedPath: entry.managedPath,
      filename: entry.filename,
      originalName: entry.originalName,
      canonicalUrl: entry.canonicalUrl,
      finalUrl: entry.finalUrl || previous?.finalUrl || null,
      description: entry.description || '',
      etag: entry.etag || previous?.etag || null,
      lastModified: entry.lastModified || previous?.lastModified || null,
      fetchedAt: entry.fetchedAt || previous?.fetchedAt || null,
      mimeType: entry.mimeType,
      exportMime: entry.exportMime,
      modifiedTime: entry.modifiedTime,
      size: entry.size,
      status: 'failed',
      error: error.message,
      lastAttemptAt: attemptedAt,
      durationMs: Math.round(performance.now() - started)
    };
    counters.failed += 1;
    increment(sourceMetric, { operation: previous?.fileId ? 'modified' : 'added', status: 'failed' });
    log('error', 'file_processing_failed', { operationId, knowledgeBaseId: target.knowledgeBaseId, sourceKey: entry.sourceKey, error: error.message });
    await persist();
  }
}

async function processWebLink(target, link, counters, operationId, force = false) {
  const sourceKey = webLinkSourceKey(link.url);
  const previous = target.files[sourceKey];
  const descriptionChanged = previous?.description !== link.description;
  const attemptedAt = new Date().toISOString();
  try {
    const fetched = await timed('web_link_fetch_duration_seconds', {}, () => fetchWebLink(link.url, {
      timeoutMs: LINK_TIMEOUT_MS,
      maxBytes: LINK_MAX_BYTES,
      maxRedirects: LINK_MAX_REDIRECTS,
      etag: !force && !descriptionChanged && previous?.status !== 'failed' ? previous?.etag : null,
      lastModified: !force && !descriptionChanged && previous?.status !== 'failed' ? previous?.lastModified : null
    }));
    if (fetched.notModified && previous?.fileId) {
      Object.assign(previous, {
        status: 'indexed',
        error: null,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        finalUrl: fetched.finalUrl,
        lastAttemptAt: attemptedAt
      });
      counters.unchanged += 1;
      increment('knowledge_sync_links_total', { operation: 'unchanged', status: 'completed' });
      await persist();
      return;
    }
    const document = buildLinkDocument(link, fetched);
    const entry = {
      sourceKey,
      sourceType: 'web-link',
      canonicalUrl: link.url,
      finalUrl: fetched.finalUrl,
      description: link.description,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      fetchedAt: new Date().toISOString(),
      checksum: document.checksum,
      content: document.content,
      filename: document.filename,
      originalName: document.originalName,
      managedPath: `${WEB_LINK_ROOT}/${sanitizeDriveName(new URL(link.url).hostname, 'site')}`,
      mimeType: fetched.mimeType,
      modifiedTime: fetched.lastModified || null,
      size: fetched.size
    };
    await processManifestEntry(target, entry, counters, operationId, force || descriptionChanged);
  } catch (error) {
    target.files[sourceKey] = {
      ...(previous || {}),
      sourceType: 'web-link',
      canonicalUrl: link.url,
      description: link.description,
      filename: previous?.filename || `${new URL(link.url).hostname}.txt`,
      originalName: previous?.originalName || new URL(link.url).hostname,
      managedPath: previous?.managedPath || `${WEB_LINK_ROOT}/${sanitizeDriveName(new URL(link.url).hostname, 'site')}`,
      status: 'failed',
      error: error.message,
      lastAttemptAt: attemptedAt
    };
    counters.failed += 1;
    increment('knowledge_sync_links_total', { operation: previous?.fileId ? 'modified' : 'added', status: 'failed' });
    log('error', 'web_link_processing_failed', { operationId, knowledgeBaseId: target.knowledgeBaseId, sourceKey, url: link.url, error: error.message });
    await persist();
  }
}

function completeRun(target, trigger, status, startedAt, counters, extra = {}) {
  const finishedAt = new Date().toISOString();
  target.lastRunAt = finishedAt;
  target.lastRunStatus = status;
  target.lastRunSummary = counters;
  target.lastError = status === 'completed' ? null : `${counters.failed} conteúdo(s) falharam.`;
  recordHistory(target, { trigger, status, startedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt), ...counters, ...extra });
  return finishedAt;
}

async function executeTarget(target, trigger) {
  const startedAt = new Date().toISOString();
  const operationId = crypto.randomUUID();
  const counters = { added: 0, modified: 0, deleted: 0, unchanged: 0, failed: 0 };
  gauge('drive_sync_queue_size', queued.size);
  gauge('knowledge_sync_queue_size', queued.size);
  log('info', 'sync_started', { operationId, knowledgeBaseId: target.knowledgeBaseId, trigger });
  try {
    const bases = await listKnowledgeBases();
    const knowledge = bases.find(item => item.id === target.knowledgeBaseId);
    if (!knowledge) throw new Error('Knowledge Base não encontrada ou sem acesso de escrita.');
    target.knowledgeBaseName = knowledge.name;

    const stageErrors = [];
    const currentLinkKeys = new Set((target.links || []).map(link => webLinkSourceKey(link.url)));
    for (const link of target.links || []) await processWebLink(target, link, counters, operationId);
    const removedLinks = Object.entries(target.files).filter(([sourceKey, file]) => file.sourceType === 'web-link' && !currentLinkKeys.has(sourceKey));
    for (const [sourceKey, previous] of removedLinks) {
      if (previous.fileId) await cleanupFiles(target.knowledgeBaseId, [previous.fileId]);
      delete target.files[sourceKey];
      counters.deleted += 1;
      increment('knowledge_sync_links_total', { operation: 'deleted', status: 'completed' });
      await persist();
    }

    const configuredFolders = target.folders || [];
    if (configuredFolders.length) {
      try {
        const managedDriveFiles = Object.values(target.files || {}).filter(file => (file.sourceType || 'google-drive') === 'google-drive');
        const hasFailedFiles = managedDriveFiles.some(file => file.status === 'failed');
        const hasOutdatedCitationMetadata = managedDriveFiles.some(file => file.citationMetadataVersion !== CITATION_METADATA_VERSION);
        let skipFullDriveScan = false;
        if (target.changePageToken && !hasFailedFiles && !hasOutdatedCitationMetadata && !fullReconciliationDue(target, new Date(), FULL_RECONCILIATION_HOURS)) {
          try {
            const changeSet = await timed('drive_changes_scan_duration_seconds', {}, () => listDriveChanges(target.changePageToken));
            if (!changesAffectTarget(target, changeSet.changes)) {
              target.changePageToken = changeSet.newStartPageToken;
              skipFullDriveScan = true;
            }
          } catch (error) {
            log('warn', 'changes_fast_path_failed', { operationId, knowledgeBaseId: target.knowledgeBaseId, error: error.message });
          }
        }
        if (!skipFullDriveScan) {
          let reconciliationPageToken = null;
          try { reconciliationPageToken = await getStartPageToken(); }
          catch (error) { log('warn', 'changes_token_unavailable', { operationId, knowledgeBaseId: target.knowledgeBaseId, error: error.message }); }
          const manifest = [];
          const scannedFolderIds = new Set();
          for (const configuredFolder of configuredFolders) {
            const metadata = await getDriveFile(configuredFolder.id);
            if (metadata.trashed || metadata.mimeType !== GOOGLE_FOLDER_MIME) throw new Error(`A pasta ${configuredFolder.name} não está disponível.`);
            configuredFolder.name = sanitizeDriveName(metadata.name, configuredFolder.name);
            const scanned = await scanFolder(configuredFolder, configuredFolder.id, '', new Set(), scannedFolderIds);
            const basePath = folderRoot(configuredFolder);
            manifest.push(...scanned.map(entry => ({ ...entry, sourceType: 'google-drive', managedPath: [basePath, entry.path].filter(Boolean).join('/') })));
          }
          if (manifest.length === 0 && managedDriveFiles.length > 0) throw new Error('O Drive retornou uma origem vazia. Os arquivos existentes foram preservados por segurança.');
          const currentDriveKeys = new Set(manifest.map(entry => entry.sourceKey));
          for (const entry of manifest) await processManifestEntry(target, entry, counters, operationId);
          const removedDriveFiles = Object.entries(target.files).filter(([sourceKey, file]) => (file.sourceType || 'google-drive') === 'google-drive' && !currentDriveKeys.has(sourceKey));
          for (const [sourceKey, previous] of removedDriveFiles) {
            if (previous.fileId) await cleanupFiles(target.knowledgeBaseId, [previous.fileId]);
            delete target.files[sourceKey];
            counters.deleted += 1;
            increment('drive_sync_files_total', { operation: 'deleted', status: 'completed' });
            await persist();
          }
          target.scannedFolderIds = [...scannedFolderIds];
          target.lastFullScanAt = new Date().toISOString();
          if (reconciliationPageToken) target.changePageToken = reconciliationPageToken;
        }
      } catch (error) {
        counters.failed += 1;
        stageErrors.push(`Google Drive: ${error.message}`);
        log('error', 'drive_stage_failed', { operationId, knowledgeBaseId: target.knowledgeBaseId, error: error.message });
      }
    } else {
      const removedDriveFiles = Object.entries(target.files).filter(([, file]) => (file.sourceType || 'google-drive') === 'google-drive');
      for (const [sourceKey, previous] of removedDriveFiles) {
        if (previous.fileId) await cleanupFiles(target.knowledgeBaseId, [previous.fileId]);
        delete target.files[sourceKey];
        counters.deleted += 1;
        await persist();
      }
      target.changePageToken = null;
      target.scannedFolderIds = [];
    }

    const status = counters.failed ? 'partial' : 'completed';
    completeRun(target, trigger, status, startedAt, counters, { mode: configuredFolders.length ? (target.links?.length ? 'mixed' : 'drive') : 'links' });
    if (stageErrors.length) target.lastError = stageErrors.join(' · ');
    await persist();
    const mode = configuredFolders.length ? (target.links?.length ? 'mixed' : 'drive') : 'links';
    increment('drive_sync_runs_total', { status, mode });
    increment('knowledge_sync_runs_total', { status, mode });
    observe('drive_sync_duration_seconds', (Date.now() - Date.parse(startedAt)) / 1000, { status, mode });
    observe('knowledge_sync_duration_seconds', (Date.now() - Date.parse(startedAt)) / 1000, { status, mode });
    log('info', 'sync_completed', { operationId, knowledgeBaseId: target.knowledgeBaseId, status, ...counters });
    return counters;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    target.lastRunAt = finishedAt;
    target.lastRunStatus = 'failed';
    target.lastError = error.message;
    recordHistory(target, { trigger, status: 'failed', startedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt), error: error.message, ...counters });
    await persist();
    increment('drive_sync_runs_total', { status: 'failed', mode: 'full' });
    increment('knowledge_sync_runs_total', { status: 'failed', mode: 'full' });
    observe('drive_sync_duration_seconds', (Date.now() - Date.parse(startedAt)) / 1000, { status: 'failed', mode: 'full' });
    observe('knowledge_sync_duration_seconds', (Date.now() - Date.parse(startedAt)) / 1000, { status: 'failed', mode: 'full' });
    log('error', 'sync_failed', { operationId, knowledgeBaseId: target.knowledgeBaseId, error: error.message });
    throw error;
  }
}

function runTarget(knowledgeBaseId, trigger = 'manual', scheduledFor = null) {
  if (!state.targets.some(item => item.knowledgeBaseId === knowledgeBaseId)) throw new Error('Vínculo não encontrado.');
  if (isBusy(knowledgeBaseId)) throw new Error('Esta Knowledge Base já está na fila de sincronização.');
  queued.add(knowledgeBaseId);
  const operation = async () => {
    queued.delete(knowledgeBaseId);
    const target = state.targets.find(item => item.knowledgeBaseId === knowledgeBaseId);
    if (!target) return;
    running.add(knowledgeBaseId);
    try {
      if (scheduledFor) {
        target.lastScheduledAt = scheduledFor;
        await persist();
      }
      await executeTarget(target, trigger);
    } catch (error) {
      log('error', 'queued_sync_failed', { knowledgeBaseId, error: error.message });
    } finally {
      running.delete(knowledgeBaseId);
    }
  };
  executionQueue = executionQueue.then(operation, operation);
  gauge('drive_sync_queue_size', queued.size);
  gauge('knowledge_sync_queue_size', queued.size);
}

function publicManagedFile(sourceKey, file) {
  return {
    sourceKey,
    sourceType: file.sourceType || 'google-drive',
    sourceUrl: file.canonicalUrl || null,
    description: file.description || '',
    driveFileId: file.driveFileId,
    folderId: file.folderId,
    filename: file.filename,
    managedPath: file.managedPath,
    mimeType: file.mimeType || null,
    modifiedTime: file.modifiedTime || null,
    size: file.size || null,
    status: file.status || 'indexed',
    error: file.error || file.cleanupError || null,
    lastAttemptAt: file.lastAttemptAt || null,
    lastSuccessAt: file.lastSuccessAt || null,
    durationMs: file.durationMs || null
  };
}

function runFileReprocess(knowledgeBaseId, sourceKey) {
  const target = state.targets.find(item => item.knowledgeBaseId === knowledgeBaseId);
  if (!target) throw new Error('Vínculo não encontrado.');
  if (isBusy(knowledgeBaseId)) throw new Error('Esta Knowledge Base já está na fila de sincronização.');
  const stored = target.files[sourceKey];
  if (!stored) throw new Error('Conteúdo gerenciado não encontrado.');
  queued.add(knowledgeBaseId);
  gauge('drive_sync_queue_size', queued.size);
  gauge('knowledge_sync_queue_size', queued.size);
  const operation = async () => {
    queued.delete(knowledgeBaseId);
    running.add(knowledgeBaseId);
    gauge('drive_sync_queue_size', queued.size);
    gauge('knowledge_sync_queue_size', queued.size);
    const operationId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const counters = { added: 0, modified: 0, deleted: 0, unchanged: 0, failed: 0 };
    try {
      if (stored.sourceType === 'web-link') {
        const link = (target.links || []).find(item => webLinkSourceKey(item.url) === sourceKey);
        if (!link) throw new Error('O link não está mais vinculado a esta base.');
        await processWebLink(target, link, counters, operationId, true);
      } else {
        const metadata = await getDriveFile(stored.driveFileId);
        if (metadata.trashed || metadata.mimeType === GOOGLE_FOLDER_MIME) throw new Error('O arquivo não está mais disponível no Google Drive.');
        const configuredFolder = target.folders.find(folder => folder.id === stored.folderId) || { id: stored.folderId, name: stored.folderId };
        const entry = downloadableFile(metadata, '', configuredFolder);
        if (!entry) throw new Error('Este tipo de arquivo do Google Drive não pode ser exportado.');
        entry.sourceKey = sourceKey;
        entry.sourceType = 'google-drive';
        entry.managedPath = stored.managedPath;
        await processManifestEntry(target, entry, counters, operationId, true);
      }
      const status = counters.failed ? 'partial' : 'completed';
      completeRun(target, 'file-reprocess', status, startedAt, counters, { mode: 'single-file', sourceKey });
      await persist();
      increment('drive_sync_runs_total', { status, mode: 'single-file' });
      increment('knowledge_sync_runs_total', { status, mode: 'single-file' });
    } catch (error) {
      const file = target.files[sourceKey];
      if (file) Object.assign(file, { status: 'failed', error: error.message, lastAttemptAt: new Date().toISOString() });
      target.lastRunAt = new Date().toISOString();
      target.lastRunStatus = 'failed';
      target.lastError = error.message;
      recordHistory(target, { trigger: 'file-reprocess', status: 'failed', startedAt, finishedAt: target.lastRunAt, sourceKey, error: error.message, ...counters });
      await persist();
      log('error', 'file_reprocess_failed', { operationId, knowledgeBaseId, sourceKey, error: error.message });
    } finally {
      running.delete(knowledgeBaseId);
    }
  };
  executionQueue = executionQueue.then(operation, operation);
}

async function authorize(request) {
  const authorization = request.headers.authorization || '';
  return authorization === `Bearer ${apiToken}`;
}

async function route(request, response, url) {
  if (request.method === 'GET' && ['/health', '/health/live'].includes(url.pathname)) return json(response, 200, { status: 'ok' });
  if (request.method === 'GET' && url.pathname === '/health/ready') {
    try {
      const upstream = await fetch(`${OPENWEBUI_URL}/health`, { signal: AbortSignal.timeout(3_000) });
      if (!upstream.ok) throw new Error(`Open WebUI HTTP ${upstream.status}`);
      return json(response, 200, { status: 'ready' });
    } catch (error) {
      return json(response, 503, { status: 'not_ready', dependency: 'openwebui', error: error.message });
    }
  }
  if (request.method === 'GET' && url.pathname === '/metrics') return textResponse(response, 200, metricsText(), 'text/plain; version=0.0.4; charset=utf-8');
  if (!await authorize(request)) return json(response, 401, { error: 'Não autorizado.' });

  if (request.method === 'GET' && url.pathname === '/api/status') {
    await refreshGoogleCredentials(false);
    return json(response, 200, {
      configured: Boolean(googleCredentials),
      serviceAccountEmail: googleCredentials?.client_email || null,
      projectId: googleCredentials?.project_id || null,
      credentialsError: googleCredentialsError,
      defaultTimezone: DEFAULT_SYNC_TIMEZONE,
      running: [...running],
      queued: [...queued],
      targetCount: state.targets.length
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/credentials/test') {
    const credentials = await refreshGoogleCredentials(true);
    await google('/drive/v3/files?pageSize=1&fields=files(id)&q=trashed%20%3D%20false');
    return json(response, 200, {
      configured: true,
      serviceAccountEmail: credentials.client_email,
      projectId: credentials.project_id || null,
      testedAt: new Date().toISOString()
    });
  }
  if (url.pathname === '/api/picker-config') {
    if (request.method === 'GET') {
      return json(response, 200, publicPickerConfig(await getOpenWebuiPublicConfig()));
    }
    if (request.method === 'PUT') {
      const { clientId, apiKey } = validatePickerConfig(await requestBody(request));
      const picker = await setPickerConfig(clientId, apiKey, true);
      if (!picker.configured) throw new Error('O Open WebUI não confirmou a ativação do Google Drive.');
      return json(response, 200, picker);
    }
    if (request.method === 'DELETE') {
      const picker = await setPickerConfig('', '', false);
      if (picker.enabled) throw new Error('O Open WebUI não confirmou a desativação do Google Drive.');
      return json(response, 200, picker);
    }
    return json(response, 405, { error: 'Método não permitido.' });
  }
  if (request.method === 'GET' && url.pathname === '/api/knowledge-bases') {
    return json(response, 200, { knowledgeBases: await listKnowledgeBases() });
  }
  if (request.method === 'GET' && url.pathname === '/api/folders') {
    const credentials = await refreshGoogleCredentials(false);
    if (!credentials) return json(response, 200, { folders: [], serviceAccountEmail: null, configured: false });
    const search = String(url.searchParams.get('search') || '').trim().toLocaleLowerCase('pt-BR');
    const folders = await listDriveFiles(`mimeType = '${GOOGLE_FOLDER_MIME}' and trashed = false`);
    const visible = folders
      .filter(folder => !search || folder.name.toLocaleLowerCase('pt-BR').includes(search) || folder.id.toLowerCase().includes(search))
      .map(folder => ({ id: folder.id, name: folder.name, parents: folder.parents || [] }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return json(response, 200, { folders: visible, serviceAccountEmail: googleCredentials.client_email, configured: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/targets') {
    return json(response, 200, { targets: state.targets.map(item => publicTarget(item, isBusy(item.knowledgeBaseId))) });
  }
  if (request.method === 'GET' && url.pathname === '/api/history') {
    const knowledgeBaseId = url.searchParams.get('knowledgeBaseId');
    const history = knowledgeBaseId ? state.history.filter(item => item.knowledgeBaseId === knowledgeBaseId) : state.history;
    return json(response, 200, { history: history.slice(0, 100) });
  }
  if (request.method === 'POST' && url.pathname === '/api/targets/pause-all') {
    await withMutation(async () => {
      const now = new Date().toISOString();
      for (const target of state.targets) {
        target.enabled = false;
        target.updatedAt = now;
      }
      await persist();
    });
    return json(response, 200, { paused: state.targets.length });
  }
  if (request.method === 'POST' && url.pathname === '/api/targets/drive-credentials-removed') {
    let paused = 0;
    await withMutation(async () => {
      const now = new Date().toISOString();
      for (const target of state.targets) {
        if ((target.folders || []).length && !(target.links || []).length) {
          target.enabled = false;
          target.updatedAt = now;
          paused += 1;
        }
      }
      await persist();
    });
    return json(response, 200, { paused });
  }

  const filesMatch = url.pathname.match(/^\/api\/targets\/([A-Za-z0-9_-]+)\/files(?:\/(.+)\/(reprocess|retry))?$/);
  if (filesMatch && request.method === 'GET' && !filesMatch[2]) {
    const target = state.targets.find(item => item.knowledgeBaseId === filesMatch[1]);
    if (!target) throw new Error('Vínculo não encontrado.');
    const files = Object.entries(target.files || {}).map(([sourceKey, file]) => publicManagedFile(sourceKey, file)).sort((a, b) => a.filename.localeCompare(b.filename, 'pt-BR'));
    return json(response, 200, { files });
  }
  if (filesMatch && request.method === 'POST' && filesMatch[2]) {
    const sourceKey = decodeURIComponent(filesMatch[2]);
    runFileReprocess(filesMatch[1], sourceKey);
    return json(response, 202, { accepted: true, sourceKey });
  }

  const match = url.pathname.match(/^\/api\/targets\/([A-Za-z0-9_-]+)(?:\/(run))?$/);
  if (match && request.method === 'PUT' && !match[2]) {
    if (isBusy(match[1])) throw new Error('Aguarde a sincronização atual terminar antes de alterar o vínculo.');
    const input = normalizeTargetInput({ ...(await requestBody(request)), knowledgeBaseId: match[1] });
    const bases = await listKnowledgeBases();
    const knowledge = bases.find(item => item.id === input.knowledgeBaseId);
    if (!knowledge || !knowledge.writeAccess) throw new Error('Knowledge Base não encontrada ou sem permissão de escrita.');
    for (const link of input.links) await validateWebLinkDestination(link.url);
    const validatedFolders = [];
    const validatedMetadata = [];
    for (const folder of input.folders) {
      const metadata = await getDriveFile(folder.id);
      if (metadata.trashed || metadata.mimeType !== GOOGLE_FOLDER_MIME) throw new Error(`${folder.name} não é uma pasta disponível no Google Drive.`);
      validatedFolders.push({ id: metadata.id, name: sanitizeDriveName(metadata.name, folder.name) });
      validatedMetadata.push(metadata);
    }
    await assertNoOverlappingFolders(validatedMetadata);
    await withMutation(async () => {
      const existing = state.targets.find(item => item.knowledgeBaseId === input.knowledgeBaseId);
      const now = new Date().toISOString();
      if (existing) Object.assign(existing, input, { folders: validatedFolders, links: input.links, knowledgeBaseName: knowledge.name, updatedAt: now, lastError: null });
      else state.targets.push({ ...input, folders: validatedFolders, links: input.links, knowledgeBaseName: knowledge.name, files: {}, directories: {}, createdAt: now, updatedAt: now, lastRunAt: null, lastRunStatus: null, lastRunSummary: null, lastError: null });
      await persist();
    });
    const target = state.targets.find(item => item.knowledgeBaseId === input.knowledgeBaseId);
    return json(response, 200, { target: publicTarget(target, isBusy(target.knowledgeBaseId)) });
  }
  if (match && request.method === 'POST' && match[2] === 'run') {
    runTarget(match[1], 'manual');
    return json(response, 202, { accepted: true });
  }
  if (match && request.method === 'DELETE' && !match[2]) {
    if (isBusy(match[1])) throw new Error('Aguarde a sincronização atual terminar antes de desvincular a base.');
    const target = state.targets.find(item => item.knowledgeBaseId === match[1]);
    if (!target) throw new Error('Vínculo não encontrado.');
    if (url.searchParams.get('deleteFiles') === 'true') {
      const fileIds = Object.values(target.files || {}).map(file => file.fileId).filter(Boolean);
      for (let index = 0; index < fileIds.length; index += 100) {
        await cleanupFiles(target.knowledgeBaseId, fileIds.slice(index, index + 100));
      }
    }
    state.targets = state.targets.filter(item => item !== target);
    await persist();
    return json(response, 200, { deleted: true });
  }
  return json(response, 404, { error: 'Rota não encontrada.' });
}

async function checkSchedules() {
  const credentials = await refreshGoogleCredentials(false);
  for (const target of state.targets) {
    if (!credentials && (target.folders || []).length && !(target.links || []).length) continue;
    if (isTargetDue(target) && !isBusy(target.knowledgeBaseId)) {
      try { runTarget(target.knowledgeBaseId, 'schedule', scheduledSlot(target)); }
      catch (error) { log('error', 'schedule_enqueue_failed', { knowledgeBaseId: target.knowledgeBaseId, error: error.message }); }
    }
  }
}

await checkSchedules();
setInterval(() => checkSchedules().catch(error => log('error', 'schedule_check_failed', { error: error.message })), 30_000).unref();

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try { await route(request, response, url); }
  catch (error) {
    log('error', 'request_failed', { method: request.method, path: url.pathname, error: error.message });
    json(response, 400, { error: error.message || 'Erro inesperado.' });
  }
}).listen(PORT, '0.0.0.0', () => {
  log('info', 'server_started', { port: PORT, nextRunAt: state.targets.map(nextRunAt).filter(Boolean).sort()[0] || null });
});
