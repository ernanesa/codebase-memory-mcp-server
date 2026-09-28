import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyWorkflowLock } from '../verify-workflow-lock.mjs';

async function fixture(t, resource = 'workflow.md') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await writeFile(path.join(root, resource), 'verified workflow\n');
  const sha256 = createHash('sha256').update('verified workflow\n').digest('hex');
  const lock = { version: 1, resources: [{ path: resource, sha256 }] };
  await writeFile(path.join(root, '.codex', 'workflow-lock.json'), JSON.stringify(lock));
  return { root, lock };
}

test('aceita recursos regulares com hash correspondente', async t => {
  const { root } = await fixture(t);
  const result = await verifyWorkflowLock({ repoRoot: root });
  assert.deepEqual(result, { resources: 1, lockPath: '.codex/workflow-lock.json' });
});

test('rejeita hash divergente e caminhos que escapam do repositório', async t => {
  const { root, lock } = await fixture(t);
  lock.resources[0].sha256 = '0'.repeat(64);
  await writeFile(path.join(root, '.codex', 'workflow-lock.json'), JSON.stringify(lock));
  await assert.rejects(() => verifyWorkflowLock({ repoRoot: root }), /hash divergente/);

  lock.resources[0] = { path: '../outside.md', sha256: '0'.repeat(64) };
  await writeFile(path.join(root, '.codex', 'workflow-lock.json'), JSON.stringify(lock));
  await assert.rejects(() => verifyWorkflowLock({ repoRoot: root }), /fora do repositório/);
});

test('rejeita links simbólicos em recursos fixados', async t => {
  const { root, lock } = await fixture(t);
  await writeFile(path.join(root, 'target.md'), 'target\n');
  await symlink('target.md', path.join(root, 'linked.md'));
  lock.resources[0] = {
    path: 'linked.md',
    sha256: createHash('sha256').update('target\n').digest('hex')
  };
  await writeFile(path.join(root, '.codex', 'workflow-lock.json'), JSON.stringify(lock));
  await assert.rejects(() => verifyWorkflowLock({ repoRoot: root }), /links simbólicos/);
});
