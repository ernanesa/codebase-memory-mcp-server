import { createHash } from 'node:crypto';

export const RRF_K = 60;

export const RETRIEVAL_MODES = Object.freeze({
  fast: Object.freeze({ limit: 8, candidateLimit: 24, useVector: false, useGraph: false, useRerank: false }),
  balanced: Object.freeze({ limit: 12, candidateLimit: 48, useVector: true, useGraph: true, useRerank: false }),
  thorough: Object.freeze({ limit: 20, candidateLimit: 80, useVector: true, useGraph: true, useRerank: true })
});

const BACKEND_UNCONTROLLED = 'backend_uncontrolled';

/**
 * The guardrail currently enforces only the final result limit and diversity.
 * The legacy use* fields above describe the intended pipeline, but do not
 * configure the external retrieval backend. Keep that distinction explicit so
 * a caller never treats a mode label as proof of vector, graph, or rerank use.
 */
export const RETRIEVAL_MODE_EFFECTS = Object.freeze({
  fast: Object.freeze({
    resultLimit: 8,
    candidateLimit: BACKEND_UNCONTROLLED,
    vector: BACKEND_UNCONTROLLED,
    graph: BACKEND_UNCONTROLLED,
    rerank: BACKEND_UNCONTROLLED
  }),
  balanced: Object.freeze({
    resultLimit: 12,
    candidateLimit: BACKEND_UNCONTROLLED,
    vector: BACKEND_UNCONTROLLED,
    graph: BACKEND_UNCONTROLLED,
    rerank: BACKEND_UNCONTROLLED
  }),
  thorough: Object.freeze({
    resultLimit: 20,
    candidateLimit: BACKEND_UNCONTROLLED,
    vector: BACKEND_UNCONTROLLED,
    graph: BACKEND_UNCONTROLLED,
    rerank: BACKEND_UNCONTROLLED
  })
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

/**
 * Produces a chunk-level identity. Path and heading are deliberately only
 * fallback inputs, because a document can contain repeated headings.
 */
export function stableChunkIdentity(candidate) {
  const explicitId = text(candidate?.chunkId) || text(candidate?.chunk_id) || text(candidate?.id);
  const contentHash = text(candidate?.contentHash) || text(candidate?.content_hash) || text(candidate?.chunkHash) || text(candidate?.chunk_hash);
  const content = typeof candidate?.content === 'string' ? candidate.content : '';
  const scope = [text(candidate?.project), text(candidate?.workspace)].filter(Boolean).join('/') || 'global';
  const bodyDigest = contentHash || (content
    ? createHash('sha256').update(content).digest('hex')
    : 'unknown');
  // Local chunk ids are only unique inside a project/workspace. Bind a supplied
  // content hash (or body digest) too: reused ids with different content must
  // remain separate retrieval evidence.
  if (explicitId) return `chunk:${scope}:${explicitId}:${bodyDigest}`;

  // sha256 commonly identifies the whole document. Include the chunk body and
  // ordinal with it so sibling chunks from one document never collapse.
  const digest = contentHash || createHash('sha256').update(stableJson({
    documentHash: text(candidate?.sha256),
    path: text(candidate?.path),
    heading: text(candidate?.heading),
    ordinal: Number.isInteger(candidate?.ordinal) ? candidate.ordinal : null,
    content
  })).digest('hex');
  return `hash:${digest}:${Number.isInteger(candidate?.ordinal) ? candidate.ordinal : ''}`;
}

export function planRetrieval(query, mode = 'auto') {
  const requested = text(mode).toLowerCase();
  const selected = requested === 'auto'
    ? /\b(reuse|existing|already|impact|where|test|dependency|caller|callee)\b/i.test(String(query || ''))
      ? 'balanced'
      : 'fast'
    : requested;
  const policy = RETRIEVAL_MODES[selected] || RETRIEVAL_MODES.balanced;
  return Object.freeze({ mode: RETRIEVAL_MODES[selected] ? selected : 'balanced', ...policy });
}

/** Return the enforced and backend-uncontrolled effects for an accepted mode. */
export function describeRetrievalMode(query, mode = 'auto') {
  const { mode: selectedMode } = planRetrieval(query, mode);
  return Object.freeze({ mode: selectedMode, ...RETRIEVAL_MODE_EFFECTS[selectedMode] });
}

/** Fuse independently ranked stages using RRF without relying on path/heading. */
export function fuseRankedCandidates(stages, { rrfK = RRF_K, sourceWeights = {} } = {}) {
  if (!Array.isArray(stages) || !Number.isFinite(rrfK) || rrfK <= 0) return [];
  const fused = new Map();
  for (const stage of stages) {
    const source = text(stage?.source) || 'unknown';
    const weight = Number.isFinite(sourceWeights[source]) && sourceWeights[source] >= 0 ? sourceWeights[source] : 1;
    const seen = new Set();
    let rank = 0;
    for (const candidate of Array.isArray(stage?.candidates) ? stage.candidates : []) {
      if (!candidate || typeof candidate !== 'object') continue;
      const key = stableChunkIdentity(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      rank += 1;
      const prior = fused.get(key);
      const sources = unique([...(prior?.sources || []), ...(candidate.sources || []), source]);
      const evidence = unique([...(prior?.evidence || []), ...(candidate.evidence || [])]);
      const score = (prior?.score || 0) + (weight / (rrfK + rank));
      fused.set(key, {
        ...(prior || candidate),
        ...candidate,
        identity: key,
        score,
        sources,
        evidence
      });
    }
  }
  return [...fused.values()].sort(compareCandidates);
}

function compareCandidates(left, right) {
  return right.score - left.score
    || text(left.path).localeCompare(text(right.path))
    || text(left.heading).localeCompare(text(right.heading))
    || (text(left.identity) || stableChunkIdentity(left)).localeCompare(text(right.identity) || stableChunkIdentity(right));
}

/** Return broadly distributed evidence before admitting a second chunk per file. */
export function diversifyCandidates(candidates, limit, perPath = 2) {
  const boundedLimit = Math.max(0, Number.isInteger(limit) ? limit : 0);
  const pathLimit = Math.max(1, Number.isInteger(perPath) ? perPath : 1);
  const ordered = Array.isArray(candidates) ? [...candidates].sort(compareCandidates) : [];
  const selected = [];
  const selectedIds = new Set();
  const counts = new Map();
  for (let allowed = 1; allowed <= pathLimit && selected.length < boundedLimit; allowed += 1) {
    for (const item of ordered) {
      const identity = item.identity || stableChunkIdentity(item);
      const path = text(item.path) || identity;
      if (selectedIds.has(identity) || (counts.get(path) || 0) !== allowed - 1) continue;
      selected.push({ ...item, identity });
      selectedIds.add(identity);
      counts.set(path, allowed);
      if (selected.length === boundedLimit) return selected;
    }
  }
  return selected;
}

/** Returns validated positional scores or null, allowing a deterministic fallback. */
export function validateRerankScores(scores, expectedCount) {
  if (!Array.isArray(scores) || scores.length !== expectedCount) return null;
  const normalized = scores.map(item => typeof item === 'object' && item !== null ? item.score : item);
  return normalized.every(score => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1)
    ? normalized
    : null;
}

export function applyRerankScores(candidates, scores, { model = '' } = {}) {
  const items = Array.isArray(candidates) ? candidates : [];
  const valid = validateRerankScores(scores, items.length);
  if (!valid) return { candidates: items, applied: false, reason: 'invalid_rerank_scores' };
  return {
    candidates: items.map((item, index) => ({
      ...item,
      score: valid[index],
      sources: unique([...(item.sources || []), 'rerank']),
      evidence: unique([...(item.evidence || []), model ? `rerank:${model}` : 'rerank'])
    })).sort(compareCandidates),
    applied: true
  };
}

export function getFreshness({ indexedAt, sourceUpdatedAt, indexedHash, sourceHash, indexedCommit, sourceCommit, now = Date.now(), staleAfterMs } = {}) {
  if (text(indexedHash) && text(sourceHash) && indexedHash !== sourceHash) return 'stale';
  if (text(indexedCommit) && text(sourceCommit) && indexedCommit !== sourceCommit) return 'stale';
  const indexedTime = Date.parse(indexedAt);
  const sourceTime = Date.parse(sourceUpdatedAt);
  if (Number.isFinite(indexedTime) && Number.isFinite(sourceTime) && sourceTime > indexedTime) return 'stale';
  if (Number.isFinite(indexedTime) && Number.isFinite(staleAfterMs) && staleAfterMs >= 0 && now - indexedTime > staleAfterMs) return 'stale';
  // Indexed state alone only says what was observed historically. Freshness
  // needs a current source version, or a current timestamp supplied by caller.
  if (text(indexedHash) && text(sourceHash)) return 'fresh';
  if (text(indexedCommit) && text(sourceCommit)) return 'fresh';
  if (Number.isFinite(indexedTime) && Number.isFinite(sourceTime) && sourceTime <= indexedTime) return 'fresh';
  return 'unknown';
}

export function buildProvenance(candidate, context = {}) {
  const indexedAt = candidate?.indexedAt || candidate?.indexed_at || context.indexedAt;
  const sourceHash = candidate?.sourceHash || candidate?.source_hash || context.sourceHash;
  const indexedHash = candidate?.indexedHash || candidate?.indexed_hash || candidate?.sha256 || context.indexedHash;
  const sourceCommit = candidate?.sourceCommit || candidate?.source_commit || context.sourceCommit;
  const indexedCommit = candidate?.indexedCommit || candidate?.indexed_commit || context.indexedCommit;
  return Object.freeze({
    project: text(candidate?.project) || text(context.project),
    path: text(candidate?.path),
    chunkId: stableChunkIdentity(candidate),
    indexedAt: text(indexedAt),
    indexedHash: text(indexedHash),
    indexedCommit: text(indexedCommit),
    sourceHash: text(sourceHash),
    sourceCommit: text(sourceCommit),
    freshness: getFreshness({ indexedAt, sourceUpdatedAt: candidate?.sourceUpdatedAt || candidate?.source_updated_at || context.sourceUpdatedAt, indexedHash, sourceHash, indexedCommit, sourceCommit, now: context.now, staleAfterMs: context.staleAfterMs })
  });
}
