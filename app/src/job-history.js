import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const JOB_HISTORY_RETENTION_DAYS = 7;
export const JOB_HISTORY_RETENTION_MS = JOB_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const JOB_LOG_MAX_CHARACTERS = 50_000;
export const JOBS_PAGE_SIZE = 10;
const ACTIVE_STATUSES = new Set(['queued', 'running']);

function jobTimestamp(job) {
  const value = job.finishedAt || job.startedAt || job.createdAt;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function pruneJobHistory(jobs, { now = Date.now(), retentionMs = JOB_HISTORY_RETENTION_MS } = {}) {
  const cutoff = now - retentionMs;
  return (Array.isArray(jobs) ? jobs : []).filter(job => job && typeof job === 'object'
    && (ACTIVE_STATUSES.has(job.status) || jobTimestamp(job) >= cutoff));
}

export function recoverInterruptedJobs(jobs, { now = new Date() } = {}) {
  const finishedAt = now.toISOString();
  let changed = false;
  const recovered = (Array.isArray(jobs) ? jobs : []).map(job => {
    if (!ACTIVE_STATUSES.has(job.status)) return job;
    changed = true;
    const message = 'Operação interrompida pela reinicialização do serviço.';
    return {
      ...job,
      status: 'interrupted',
      error: message,
      log: `${job.log || ''}${job.log ? '\n' : ''}${message}\n`.slice(-JOB_LOG_MAX_CHARACTERS),
      finishedAt
    };
  });
  return { jobs: recovered, changed };
}

export function paginateJobs(jobs, { page = 1, pageSize = JOBS_PAGE_SIZE, maxPageSize = 50 } = {}) {
  const normalizedPageSize = Math.max(1, Math.min(maxPageSize, Number.parseInt(pageSize, 10) || JOBS_PAGE_SIZE));
  const total = Array.isArray(jobs) ? jobs.length : 0;
  const totalPages = Math.max(1, Math.ceil(total / normalizedPageSize));
  const normalizedPage = Math.max(1, Math.min(totalPages, Number.parseInt(page, 10) || 1));
  const offset = (normalizedPage - 1) * normalizedPageSize;
  return {
    jobs: (Array.isArray(jobs) ? jobs : []).slice(offset, offset + normalizedPageSize),
    pagination: { page: normalizedPage, pageSize: normalizedPageSize, total, totalPages }
  };
}

export async function loadJobHistory(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function saveJobHistory(file, jobs) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}
