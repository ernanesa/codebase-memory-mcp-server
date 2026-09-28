const MAX_WORKTREE_OBSERVATION_AGE_MS = 5 * 60 * 1000;

// Only recent metadata captured during a successful index is evidence of its revision.
export function uniqueProjectNames(repositories) {
  const counts = new Map();
  for (const item of repositories) {
    if (!item.project) continue;
    counts.set(item.project, (counts.get(item.project) || 0) + 1);
  }
  return new Set([...counts].flatMap(([project, count]) => count === 1 ? [project] : []));
}

export function projectEvidence(repositories, { now = Date.now(), maxObservationAgeMs = MAX_WORKTREE_OBSERVATION_AGE_MS } = {}) {
  const evidence = new Map();
  for (const item of repositories) {
    if (!item.project) continue;
    const indexedCommit = /^[a-f0-9]{40,64}$/i.test(item.indexedCommit || '') ? item.indexedCommit : null;
    const currentCommit = item.currentCommit || null;
    const indexedWorktreeStatus = item.indexedWorktreeStatus || null;
    const currentWorktreeStatus = item.currentWorktreeStatus || null;
    const worktreeObservedAt = Date.parse(item.worktreeObservedAt || '');
    const observationIsRecent = Number.isFinite(worktreeObservedAt)
      && worktreeObservedAt <= now
      && now - worktreeObservedAt <= maxObservationAgeMs;
    const value = {
      indexedCommit,
      indexedAt: item.lastIndexedAt || null,
      status: !indexedCommit || !currentCommit || !indexedWorktreeStatus || !currentWorktreeStatus || !observationIsRecent ? 'unknown'
        : indexedCommit === currentCommit
          && indexedWorktreeStatus === 'clean'
          && currentWorktreeStatus === 'clean'
          && item.status === 'indexed' ? 'fresh' : 'stale'
    };
    const previous = evidence.get(item.project);
    // A name shared by distinct repositories cannot carry unambiguous provenance.
    evidence.set(item.project, previous ? { indexedCommit: null, indexedAt: null, status: 'unknown' } : value);
  }
  return evidence;
}
