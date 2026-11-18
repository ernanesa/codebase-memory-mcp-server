import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

const DEFAULT_EXTRACTOR_VERSION = 'v1';
const MAX_CACHE_ENTRIES = Math.max(100, Number.parseInt(process.env.KNOWLEDGE_SYNC_DOC_CACHE_MAX_ENTRIES || '5000', 10) || 5000);
const BROTLI_OPTIONS = {
  params: {
    [zlibConstants.BROTLI_PARAM_QUALITY]: 4
  }
};

const dbPools = new Map();

export function computeContentHash(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function computeExtractorVersion(params = DEFAULT_EXTRACTOR_VERSION) {
  if (typeof params === 'string' && params.length <= 64 && !params.includes('{')) {
    return params || DEFAULT_EXTRACTOR_VERSION;
  }
  const serialized = typeof params === 'string' ? params : JSON.stringify(params ?? DEFAULT_EXTRACTOR_VERSION);
  return `v1:${createHash('sha256').update(serialized).digest('hex').slice(0, 16)}`;
}

export function openDocCacheDb(dataDir) {
  const resolvedDir = path.resolve(dataDir || '/data');
  const dbPath = path.join(resolvedDir, 'knowledge-cache.sqlite');
  let db = dbPools.get(dbPath);
  if (db) return db;
  try {
    mkdirSync(resolvedDir, { recursive: true });
    db = new DatabaseSync(dbPath);
    try { chmodSync(dbPath, 0o600); } catch {}
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA journal_mode = WAL;');
    try { chmodSync(`${dbPath}-wal`, 0o600); chmodSync(`${dbPath}-shm`, 0o600); } catch {}
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA cache_size = -32000;');
    db.exec('PRAGMA temp_store = MEMORY;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS document_extraction_cache (
        content_hash TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        compressed_content BLOB NOT NULL,
        uncompressed_bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (content_hash, extractor_version)
      );
      CREATE INDEX IF NOT EXISTS idx_doc_cache_updated_at
        ON document_extraction_cache (updated_at);
      CREATE TABLE IF NOT EXISTS sync_state_kv (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    dbPools.set(dbPath, db);
    return db;
  } catch {
    return null;
  }
}

export function getCachedDocument(dataDir, contentHash, extractorVersion = DEFAULT_EXTRACTOR_VERSION) {
  if (!contentHash) return null;
  const db = openDocCacheDb(dataDir);
  if (!db) return null;
  const versionKey = computeExtractorVersion(extractorVersion);
  try {
    const row = db.prepare(`
      SELECT filename, mime_type, compressed_content, uncompressed_bytes, updated_at
      FROM document_extraction_cache
      WHERE content_hash = ? AND extractor_version = ?
    `).get(String(contentHash), versionKey);
    if (!row || !row.compressed_content) return null;
    const content = brotliDecompressSync(Buffer.from(row.compressed_content));
    return {
      content,
      filename: row.filename,
      mimeType: row.mime_type,
      uncompressedBytes: row.uncompressed_bytes,
      updatedAt: row.updated_at
    };
  } catch {
    return null;
  }
}

export function setCachedDocument(dataDir, {
  contentHash,
  extractorVersion = DEFAULT_EXTRACTOR_VERSION,
  filename = 'document.md',
  mimeType = 'text/markdown',
  content
}) {
  if (!contentHash || content == null) return false;
  const db = openDocCacheDb(dataDir);
  if (!db) return false;
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (bytes.length === 0) return false;
  const versionKey = computeExtractorVersion(extractorVersion);
  try {
    const compressed = brotliCompressSync(bytes, BROTLI_OPTIONS);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO document_extraction_cache (
        content_hash, extractor_version, filename, mime_type,
        compressed_content, uncompressed_bytes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash, extractor_version) DO UPDATE SET
        filename = excluded.filename,
        mime_type = excluded.mime_type,
        compressed_content = excluded.compressed_content,
        uncompressed_bytes = excluded.uncompressed_bytes,
        updated_at = excluded.updated_at
    `).run(
      String(contentHash),
      versionKey,
      String(filename || 'document.md'),
      String(mimeType || 'text/markdown'),
      compressed,
      bytes.length,
      now
    );

    const countRow = db.prepare('SELECT COUNT(*) AS total FROM document_extraction_cache').get();
    if (Number(countRow?.total || 0) > MAX_CACHE_ENTRIES) {
      const excess = Number(countRow.total) - MAX_CACHE_ENTRIES;
      db.prepare(`
        DELETE FROM document_extraction_cache
        WHERE rowid IN (
          SELECT rowid FROM document_extraction_cache
          ORDER BY updated_at ASC
          LIMIT ?
        )
      `).run(excess);
    }
    return true;
  } catch {
    return false;
  }
}

export function writeSyncStateSqlite(dataDir, key, serializedJson) {
  const db = openDocCacheDb(dataDir);
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO sync_state_kv (key, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run(String(key), String(serializedJson), new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

export function readSyncStateSqlite(dataDir, key) {
  const db = openDocCacheDb(dataDir);
  if (!db) return null;
  try {
    const row = db.prepare('SELECT payload FROM sync_state_kv WHERE key = ?').get(String(key));
    return typeof row?.payload === 'string' ? row.payload : null;
  } catch {
    return null;
  }
}

export function getDocCacheStats(dataDir) {
  const db = openDocCacheDb(dataDir);
  if (!db) return { entries: 0, compressedBytes: 0, uncompressedBytes: 0 };
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS entries,
        COALESCE(SUM(LENGTH(compressed_content)), 0) AS compressed_bytes,
        COALESCE(SUM(uncompressed_bytes), 0) AS uncompressed_bytes
      FROM document_extraction_cache
    `).get();
    return {
      entries: Number(row?.entries || 0),
      compressedBytes: Number(row?.compressed_bytes || 0),
      uncompressedBytes: Number(row?.uncompressed_bytes || 0)
    };
  } catch {
    return { entries: 0, compressedBytes: 0, uncompressedBytes: 0 };
  }
}

export async function extractWithDoclingCache(dataDir, {
  content,
  contentHash,
  filename = 'document.pdf',
  mimeType = 'application/pdf',
  doclingUrl = process.env.DOCLING_SERVER_URL || 'http://docling:5001',
  doclingParams = process.env.DOCLING_PARAMS || '{}',
  fetchImpl = globalThis.fetch
} = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '');
  const hash = contentHash || computeContentHash(bytes);
  const extractorVersion = `docling:${computeExtractorVersion(doclingParams)}`;

  const cached = getCachedDocument(dataDir, hash, extractorVersion);
  if (cached?.content) {
    return {
      hit: true,
      content: cached.content,
      markdown: cached.content.toString('utf8'),
      filename: cached.filename,
      mimeType: cached.mimeType
    };
  }

  const baseUrl = String(doclingUrl || '').replace(/\/+$/, '');
  if (!baseUrl || typeof fetchImpl !== 'function') {
    throw new Error('URL do servidor Docling não configurada.');
  }

  const form = new FormData();
  form.append('files', new Blob([bytes], { type: mimeType }), filename);
  const response = await fetchImpl(`${baseUrl}/v1/convert/file`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(300_000)
  });
  if (!response.ok) {
    throw new Error(`Docling respondeu HTTP ${response.status}.`);
  }
  const payload = await response.json();
  const markdown = String(
    payload?.document?.md_content
    ?? payload?.md_content
    ?? payload?.markdown
    ?? payload?.text
    ?? ''
  ).trim();
  if (!markdown) {
    throw new Error('Docling não retornou conteúdo Markdown útil.');
  }

  const markdownBuffer = Buffer.from(markdown, 'utf8');
  const mdFilename = filename.replace(/\.[^.]+$/, '') + '.md';
  setCachedDocument(dataDir, {
    contentHash: hash,
    extractorVersion,
    filename: mdFilename,
    mimeType: 'text/markdown',
    content: markdownBuffer
  });

  return {
    hit: false,
    content: markdownBuffer,
    markdown,
    filename: mdFilename,
    mimeType: 'text/markdown'
  };
}
