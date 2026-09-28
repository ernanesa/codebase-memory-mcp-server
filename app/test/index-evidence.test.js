import test from 'node:test';
import assert from 'node:assert/strict';
import { projectEvidence, uniqueProjectNames } from '../src/index-evidence.js';

const commit = 'a'.repeat(40);
test('legacy indexes have unknown provenance; current commits are not fabricated', () => {
  assert.equal(projectEvidence([{ project: 'api', commit: 'abcdef0', lastIndexedAt: 'yesterday' }]).get('api').status, 'unknown');
});
test('index revision detects stale, fresh and ambiguous repositories', () => {
  const item = { project: 'api', status: 'indexed', indexedCommit: commit, currentCommit: commit, indexedWorktreeStatus: 'clean', currentWorktreeStatus: 'clean', worktreeObservedAt: '2026-09-28T12:00:00.000Z' };
  const now = Date.parse('2026-09-28T12:01:00.000Z');
  assert.equal(projectEvidence([item], { now }).get('api').status, 'fresh');
  assert.equal(projectEvidence([{ ...item, currentCommit: 'b'.repeat(40) }], { now }).get('api').status, 'stale');
  assert.equal(projectEvidence([{ ...item, currentWorktreeStatus: 'dirty' }], { now }).get('api').status, 'stale');
  assert.equal(projectEvidence([item], { now: now + 5 * 60 * 1000 + 1 }).get('api').status, 'unknown');
  assert.equal(projectEvidence([item, item], { now }).get('api').status, 'unknown');
});

test('duplicate project names are excluded from access-facing project names', () => {
  const repositories = [
    { project: 'shared-project', accessId: 'repo-a' },
    { project: 'shared-project', accessId: 'repo-b' },
    { project: 'unique-project', accessId: 'repo-c' }
  ];

  assert.deepEqual(uniqueProjectNames(repositories), new Set(['unique-project']));
});
