import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  computeContentHash,
  extractWithDoclingCache,
  getCachedDocument,
  getDocCacheStats,
  readSyncStateSqlite,
  setCachedDocument,
  writeSyncStateSqlite
} from '../src/doc-cache.js';

test('cache SQLite de documentos comprime com Brotli e recupera por hash sem perda', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cbm-doc-cache-'));
  try {
    const markdown = '# Arquitetura Corporativa\n\n| Serviço | Porta |\n| --- | --- |\n| Admin | 3000 |\n'.repeat(20);
    const hash = computeContentHash(markdown);

    assert.equal(getCachedDocument(tempDir, hash), null);
    const saved = setCachedDocument(tempDir, {
      contentHash: hash,
      filename: 'arquitetura.md',
      mimeType: 'text/markdown',
      content: Buffer.from(markdown, 'utf8')
    });
    assert.equal(saved, true);

    const hit = getCachedDocument(tempDir, hash);
    assert.ok(hit);
    assert.equal(hit.filename, 'arquitetura.md');
    assert.equal(hit.mimeType, 'text/markdown');
    assert.equal(hit.content.toString('utf8'), markdown);

    const stats = getDocCacheStats(tempDir);
    assert.equal(stats.entries, 1);
    assert.ok(stats.compressedBytes < stats.uncompressedBytes);

    assert.equal(writeSyncStateSqlite(tempDir, 'state.json', '{"version":4}'), true);
    assert.equal(readSyncStateSqlite(tempDir, 'state.json'), '{"version":4}');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('extractWithDoclingCache chama Docling apenas no miss e serve do SQLite no hit', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cbm-docling-cache-'));
  try {
    let doclingCalls = 0;
    const fakeFetch = async () => {
      doclingCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          document: { md_content: '# Manual Extraído\n\nConteúdo processado uma única vez.' }
        })
      };
    };

    const pdfBytes = Buffer.from('%PDF-1.7 fake content');
    const first = await extractWithDoclingCache(tempDir, {
      content: pdfBytes,
      filename: 'manual.pdf',
      mimeType: 'application/pdf',
      doclingUrl: 'http://docling:5001',
      doclingParams: '{"do_ocr":true}',
      fetchImpl: fakeFetch
    });
    assert.equal(first.hit, false);
    assert.equal(first.filename, 'manual.md');
    assert.equal(doclingCalls, 1);

    const second = await extractWithDoclingCache(tempDir, {
      content: pdfBytes,
      filename: 'manual.pdf',
      mimeType: 'application/pdf',
      doclingUrl: 'http://docling:5001',
      doclingParams: '{"do_ocr":true}',
      fetchImpl: fakeFetch
    });
    assert.equal(second.hit, true);
    assert.equal(second.markdown, '# Manual Extraído\n\nConteúdo processado uma única vez.');
    assert.equal(doclingCalls, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
