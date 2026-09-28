import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCK_PATH = '.codex/workflow-lock.json';

function fail(message) {
  throw new Error('Workflow lock inválido: ' + message);
}

function relativePath(value, field) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.includes('\\')) {
    fail(field + ' deve ser um caminho relativo POSIX.');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) fail(field + ' aponta para fora do repositório.');
  return normalized;
}

async function noSymlinkPath(root, relative, expectedFile) {
  const parts = relative.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let info;
    try {
      info = await lstat(current);
    } catch {
      fail('recurso ausente: ' + relative);
    }
    if (info.isSymbolicLink()) fail('links simbólicos não são permitidos: ' + relative);
    if (index < parts.length - 1 && !info.isDirectory()) fail('diretório inválido em: ' + relative);
    if (index === parts.length - 1 && expectedFile && !info.isFile()) fail('recurso não é arquivo regular: ' + relative);
  }
  return current;
}

function parseLock(source) {
  let lock;
  try {
    lock = JSON.parse(source);
  } catch {
    fail('JSON malformado.');
  }
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) fail('objeto raiz esperado.');
  const keys = Object.keys(lock).sort();
  if (keys.length !== 2 || keys[0] !== 'resources' || keys[1] !== 'version') fail('campos raiz devem ser resources e version.');
  if (lock.version !== 1 || !Array.isArray(lock.resources) || lock.resources.length === 0) fail('version 1 e resources não vazio são obrigatórios.');
  return lock;
}

export async function verifyWorkflowLock({ repoRoot = PROJECT_ROOT, lockPath = DEFAULT_LOCK_PATH } = {}) {
  const root = await realpath(repoRoot).catch(() => fail('raiz do repositório ausente.'));
  const lockRelative = relativePath(lockPath, 'lockPath');
  const lockFile = await noSymlinkPath(root, lockRelative, true);
  const lock = parseLock(await readFile(lockFile, 'utf8'));
  const seen = new Set();

  for (const resource of lock.resources) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) fail('recurso deve ser objeto.');
    const keys = Object.keys(resource).sort();
    if (keys.length !== 2 || keys[0] !== 'path' || keys[1] !== 'sha256') fail('recurso deve conter somente path e sha256.');
    const resourcePath = relativePath(resource.path, 'resource.path');
    if (resourcePath === lockRelative) fail('o lock não pode fixar a si próprio.');
    if (!/^[a-f0-9]{64}$/.test(resource.sha256)) fail('sha256 inválido: ' + resourcePath);
    if (seen.has(resourcePath)) fail('recurso duplicado: ' + resourcePath);
    seen.add(resourcePath);
    const resourceFile = await noSymlinkPath(root, resourcePath, true);
    const actual = createHash('sha256').update(await readFile(resourceFile)).digest('hex');
    if (actual !== resource.sha256) fail('hash divergente: ' + resourcePath);
  }

  return { resources: lock.resources.length, lockPath: lockRelative };
}

async function main() {
  const requested = process.argv.slice(2);
  if (requested.length > 1 || (requested.length === 1 && requested[0] !== '--help')) {
    throw new Error('Uso: node scripts/verify-workflow-lock.mjs [--help]');
  }
  if (requested[0] === '--help') {
    console.log('Uso: node scripts/verify-workflow-lock.mjs');
    return;
  }
  const result = await verifyWorkflowLock();
  console.log('Workflow lock verificado: ' + result.resources + ' recursos.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
