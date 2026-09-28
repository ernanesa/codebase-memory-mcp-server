#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const usage = 'Usage: node scripts/task-scope-guard.mjs <snapshot|verify> --task-id <id> --envelope <file>';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitBuffer(args) {
  return execFileSync('git', args, { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    return { help: true };
  }

  if (command !== 'snapshot' && command !== 'verify') {
    throw new Error(usage);
  }

  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if ((flag !== '--task-id' && flag !== '--envelope') || !value || options[flag]) {
      throw new Error(usage);
    }
    options[flag] = value;
  }

  if (!options['--task-id'] || !options['--envelope']) {
    throw new Error(usage);
  }

  return { command, taskId: options['--task-id'], envelope: options['--envelope'] };
}

function normalizeTaskId(taskId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) {
    throw new Error('Invalid task id.');
  }
  return taskId;
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) {
    throw new Error('Invalid envelope path.');
  }

  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error('Invalid envelope path.');
  }

  if (value.split('/').some((component) => component === '.' || component === '..')) {
    throw new Error('Invalid envelope path.');
  }

  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Invalid envelope path.');
  }
  return normalized;
}

async function readJsonRegularFile(filePath, description) {
  const fileStatus = await lstat(filePath);
  if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) {
    throw new Error(`Invalid ${description}.`);
  }

  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error(`Invalid ${description}.`);
  }
}

async function readTaskEnvelope(envelopePath) {
  const worktree = git(['rev-parse', '--show-toplevel']);
  const resolvedEnvelope = path.resolve(envelopePath);
  const relativeEnvelope = path.relative(worktree, resolvedEnvelope);
  if (relativeEnvelope === '' || relativeEnvelope === '..' || relativeEnvelope.startsWith(`..${path.sep}`) || path.isAbsolute(relativeEnvelope)) {
    throw new Error('Invalid task envelope.');
  }

  let currentPath = worktree;
  for (const component of relativeEnvelope.split(path.sep)) {
    currentPath = path.join(currentPath, component);
    const componentStatus = await lstat(currentPath);
    if (componentStatus.isSymbolicLink()) {
      throw new Error('Invalid task envelope.');
    }
  }

  return readJsonRegularFile(resolvedEnvelope, 'task envelope');
}

async function allowedPathsFromEnvelope(envelopePath, taskId) {
  const envelope = await readTaskEnvelope(envelopePath);
  if (envelope?.taskId !== taskId || !Array.isArray(envelope.files)) {
    throw new Error('Invalid task envelope.');
  }

  const allowedPaths = new Set();
  for (const entry of envelope.files) {
    const normalized = normalizeRelativePath(entry?.path);
    if (allowedPaths.has(normalized)) {
      throw new Error('Duplicate envelope path.');
    }
    allowedPaths.add(normalized);
  }

  return allowedPaths;
}

function statusPaths() {
  const fields = gitBuffer(['status', '--porcelain=v1', '-z']).toString('utf8').split('\0');
  const paths = new Set();

  for (let index = 0; index < fields.length - 1; index += 1) {
    const entry = fields[index];
    if (entry.length < 4) {
      throw new Error('Unable to read Git status.');
    }
    const status = entry.slice(0, 2);
    paths.add(normalizeRelativePath(entry.slice(3)));
    if (status.includes('R') || status.includes('C')) {
      index += 1;
      if (!fields[index]) {
        throw new Error('Unable to read Git status.');
      }
      paths.add(normalizeRelativePath(fields[index]));
    }
  }

  return [...paths].sort();
}

async function manifestPath(taskId) {
  const gitPath = git(['rev-parse', '--git-path', `task-scope-guard/${taskId}.json`]);
  const manifestStatus = await lstat(path.dirname(gitPath)).catch(() => null);
  if (manifestStatus?.isSymbolicLink()) {
    throw new Error('Invalid Git manifest directory.');
  }
  return gitPath;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  const taskId = normalizeTaskId(options.taskId);
  await allowedPathsFromEnvelope(options.envelope, taskId);
  const targetManifest = await manifestPath(taskId);

  if (options.command === 'snapshot') {
    const existing = await lstat(targetManifest).catch(() => null);
    if (existing) {
      throw new Error('Snapshot already exists for this task id.');
    }

    await mkdir(path.dirname(targetManifest), { recursive: true });

    const snapshot = {
      version: 1,
      taskId,
      head: git(['rev-parse', 'HEAD']),
      branch: git(['branch', '--show-current']) || 'HEAD',
      statusPaths: statusPaths(),
    };
    await writeFile(targetManifest, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    process.stdout.write(`snapshot_created task_id=${taskId} dirty_paths=${snapshot.statusPaths.length}\n`);
    return;
  }

  const snapshot = await readJsonRegularFile(targetManifest, 'task snapshot');
  if (snapshot?.version !== 1 || snapshot.taskId !== taskId || !Array.isArray(snapshot.statusPaths)) {
    throw new Error('Invalid task snapshot.');
  }

  const currentHead = git(['rev-parse', 'HEAD']);
  const currentBranch = git(['branch', '--show-current']) || 'HEAD';
  if (snapshot.head !== currentHead || snapshot.branch !== currentBranch) {
    throw new Error('Stale task baseline.');
  }

  const initialPaths = new Set();
  for (const snapshotPath of snapshot.statusPaths) {
    const normalized = normalizeRelativePath(snapshotPath);
    if (initialPaths.has(normalized)) {
      throw new Error('Invalid task snapshot.');
    }
    initialPaths.add(normalized);
  }
  const allowedPaths = await allowedPathsFromEnvelope(options.envelope, taskId);
  const newPaths = statusPaths().filter((entry) => !initialPaths.has(entry));
  const violations = newPaths.filter((entry) => !allowedPaths.has(entry));

  if (violations.length > 0) {
    process.stderr.write(`scope_violation task_id=${taskId} paths=${violations.length}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`scope_verified task_id=${taskId} new_paths=${newPaths.length}\n`);
}

run().catch((error) => fail(error instanceof Error ? error.message : 'Task scope guard failed.'));
