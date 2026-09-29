#!/usr/bin/env node
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const usage = 'Usage: node scripts/migrate-legacy-source-approvals.mjs --state-file FILE --approval-file FILE [--apply]';

function parseArguments(args) {
  const apply = args.includes('--apply');
  const values = args.filter(value => value !== '--apply');
  if (values.length !== 4 || values[0] !== '--state-file' || values[2] !== '--approval-file') throw new Error(usage);
  return { stateFile: path.resolve(values[1]), approvalFile: path.resolve(values[3]), apply };
}

async function regularFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Approval migration accepts regular files only.');
}

function actor(value) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length < 2 || result.length > 120) throw new Error('approvedBy must contain 2 to 120 characters.');
  return result;
}

function approvalKey(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid approval entry.');
  const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId.trim() : '';
  const repositoryId = typeof value.repositoryId === 'string' ? value.repositoryId.trim() : '';
  const githubRepositoryId = String(value.githubRepositoryId ?? '').trim();
  if (!workspaceId || !repositoryId || !/^\d+$/.test(githubRepositoryId)) throw new Error('Approval entries require workspaceId, repositoryId and numeric githubRepositoryId.');
  return { workspaceId, repositoryId, githubRepositoryId };
}

function migrate(state, manifest, now) {
  if (!state || !Array.isArray(state.workspaces) || !Array.isArray(state.repositories)) throw new Error('State file has an invalid shape.');
  const approvedBy = actor(manifest?.approvedBy);
  if (!Array.isArray(manifest?.approvals)) throw new Error('Approval file must contain an approvals array.');
  const approvals = new Map();
  for (const item of manifest.approvals) {
    const normalized = approvalKey(item);
    const key = `${normalized.workspaceId}/${normalized.repositoryId}`;
    if (approvals.has(key)) throw new Error('Approval file contains duplicate repository entries.');
    approvals.set(key, normalized);
  }
  const pending = state.repositories.filter(repository => !repository.sourceApproval);
  if (!pending.length) return { state, migrated: 0, alreadyCompliant: state.repositories.length };
  if (approvals.size !== pending.length || pending.some(repository => !approvals.has(`${repository.workspaceId}/${repository.id}`))) {
    throw new Error('Approval file must cover every legacy repository exactly once.');
  }
  if (state.repositories.some(repository => repository.sourceApproval && repository.sourceApproval.status !== 'approved')) {
    throw new Error('State contains a non-approved source; resolve revocations before migration.');
  }
  const workspaces = new Map(state.workspaces.map(workspace => [workspace.id, { ...workspace, repositorySourceApprovals: [...(workspace.repositorySourceApprovals || [])] }]));
  const repositories = state.repositories.map(repository => {
    if (repository.sourceApproval) return repository;
    const selected = approvals.get(`${repository.workspaceId}/${repository.id}`);
    const workspace = workspaces.get(repository.workspaceId);
    if (!workspace || !repository.fullName) throw new Error('Legacy state has a repository without a workspace or fullName.');
    const sourceApproval = { status: 'approved', workspaceId: repository.workspaceId, githubRepositoryId: selected.githubRepositoryId, approvedFullName: repository.fullName, approvedBy, approvedAt: now };
    workspace.repositorySourceApprovals = [
      ...workspace.repositorySourceApprovals.filter(item => String(item.githubRepositoryId) !== selected.githubRepositoryId),
      sourceApproval
    ];
    return { ...repository, githubRepositoryId: selected.githubRepositoryId, sourceApproval };
  });
  return { state: { ...state, workspaces: [...workspaces.values()], repositories }, migrated: pending.length, alreadyCompliant: state.repositories.length - pending.length };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await Promise.all([regularFile(options.stateFile), regularFile(options.approvalFile)]);
  const [state, manifest] = await Promise.all([readFile(options.stateFile, 'utf8').then(JSON.parse), readFile(options.approvalFile, 'utf8').then(JSON.parse)]);
  const result = migrate(state, manifest, new Date().toISOString());
  if (options.apply && result.migrated) {
    const temporary = `${options.stateFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(result.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, options.stateFile);
  }
  process.stdout.write(`${JSON.stringify({ schema: 1, mode: options.apply ? 'applied' : 'dry_run', migrated: result.migrated, alreadyCompliant: result.alreadyCompliant })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Approval migration failed'}\n`);
  process.exitCode = 1;
});
