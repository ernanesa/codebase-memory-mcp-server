#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CACHE_DIR = process.env.CBM_CACHE_DIR || path.join(ROOT, 'cache');

export async function optimizeDatabases(cacheDir = DEFAULT_CACHE_DIR) {
  if (!fs.existsSync(cacheDir)) {
    throw new Error(`Diretório de cache não encontrado: ${cacheDir}`);
  }

  const entries = fs.readdirSync(cacheDir)
    .filter(file => file.endsWith('.db') && !file.startsWith('.'))
    .sort();

  console.log(`Iniciando otimização SQLite em: ${cacheDir}`);
  console.log(`Total de arquivos .db encontrados: ${entries.length}`);

  let updatedCount = 0;
  let walCount = 0;
  const results = [];

  for (const file of entries) {
    const dbPath = path.join(cacheDir, file);
    let db;
    try {
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA busy_timeout = 5000;');
      const journalModeRow = db.prepare('PRAGMA journal_mode = WAL;').get();
      db.exec('PRAGMA synchronous = NORMAL;');
      db.exec('PRAGMA optimize;');

      const journalMode = journalModeRow?.journal_mode || String(journalModeRow);
      const isWal = String(journalMode).toLowerCase() === 'wal';
      if (isWal) walCount++;
      updatedCount++;

      console.log(`✔ [WAL] ${file} -> journal_mode=${journalMode}, synchronous=NORMAL, busy_timeout=5000, optimize=OK`);
      results.push({ file, success: true, journalMode });
    } catch (err) {
      console.error(`✖ Erro ao otimizar ${file}:`, err.message);
      results.push({ file, success: false, error: err.message });
    } finally {
      if (db) {
        try { db.close(); } catch {}
      }
    }
  }

  console.log('\n--- Resumo da Otimização SQLite ---');
  console.log(`Bancos processados com sucesso: ${updatedCount}/${entries.length}`);
  console.log(`Bancos confirmados em WAL mode: ${walCount}/${entries.length}`);

  const repoDbs = entries.filter(f => f.startsWith('data-repositories-'));
  console.log(`Bancos de repositório indexados (data-repositories-*.db): ${repoDbs.length}`);

  if (walCount < entries.length) {
    throw new Error(`Apenas ${walCount} de ${entries.length} bancos estão em modo WAL.`);
  }

  return { total: entries.length, repoDbsCount: repoDbs.length, walCount, results };
}

if (process.argv[1] === __filename) {
  const targetDir = process.argv[2] || DEFAULT_CACHE_DIR;
  optimizeDatabases(targetDir)
    .then(summary => {
      console.log(`\nTodos os bancos de cache SQLite foram otimizados com sucesso para WAL mode.`);
      process.exit(0);
    })
    .catch(err => {
      console.error('\nFalha na otimização:', err.message);
      process.exit(1);
    });
}
