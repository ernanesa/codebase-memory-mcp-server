import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRerankScores,
  buildProvenance,
  describeRetrievalMode,
  diversifyCandidates,
  fuseRankedCandidates,
  getFreshness,
  planRetrieval,
  stableChunkIdentity,
  validateRerankScores
} from '../src/retrieval-policy.js';

test('a identidade usa hash/conteúdo e não colide em path e heading repetidos', () => {
  const first = { path: 'src/a.cs', heading: 'Execute', content: 'first chunk' };
  const second = { path: 'src/a.cs', heading: 'Execute', content: 'second chunk' };
  assert.notEqual(stableChunkIdentity(first), stableChunkIdentity(second));
  assert.notEqual(
    stableChunkIdentity({ path: 'src/a.cs', heading: 'Execute', sha256: 'document-hash', content: 'first chunk' }),
    stableChunkIdentity({ path: 'src/a.cs', heading: 'Execute', sha256: 'document-hash', content: 'second chunk' })
  );
  assert.equal(stableChunkIdentity({ project: 'api', workspace: 'main', chunkId: '42', path: 'ignored' }), 'chunk:api/main:42:unknown');
  assert.notEqual(
    stableChunkIdentity({ project: 'api-a', chunkId: '42' }),
    stableChunkIdentity({ project: 'api-b', chunkId: '42' })
  );
});

test('RRF combina estágios por identidade estável e preserva fontes/evidências', () => {
  const result = fuseRankedCandidates([
    { source: 'lexical', candidates: [{ chunkId: 'a', path: 'a.cs', evidence: ['fts'] }, { chunkId: 'b', path: 'b.cs' }] },
    { source: 'graph', candidates: [{ chunkId: 'a', path: 'a.cs', evidence: ['calls:a'] }] }
  ], { sourceWeights: { graph: 0.35 } });
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].sources, ['lexical', 'graph']);
  assert.deepEqual(result[0].evidence, ['fts', 'calls:a']);
  assert.ok(result[0].score > result[1].score);
});

test('RRF não funde ids locais quando conteúdo ou escopo diverge', () => {
  const result = fuseRankedCandidates([
    { source: 'lexical', candidates: [{ project: 'api-a', chunkId: '1', contentHash: 'first', path: 'a.cs' }] },
    { source: 'vector', candidates: [{ project: 'api-a', chunkId: '1', contentHash: 'second', path: 'a.cs' }] },
    { source: 'graph', candidates: [{ project: 'api-b', chunkId: '1', contentHash: 'first', path: 'a.cs' }] }
  ]);
  assert.equal(result.length, 3);
});

test('diversidade distribui arquivos antes de incluir outro chunk do mesmo arquivo', () => {
  const selected = diversifyCandidates([
    { chunkId: 'a1', path: 'a.cs', score: 3 },
    { chunkId: 'a2', path: 'a.cs', score: 2 },
    { chunkId: 'b1', path: 'b.cs', score: 1 }
  ], 3, 2);
  assert.deepEqual(selected.map(item => item.chunkId), ['a1', 'b1', 'a2']);
});

test('modos têm orçamento determinístico e auto seleciona consulta de impacto', () => {
  assert.deepEqual(planRetrieval('find symbol', 'fast'), { mode: 'fast', limit: 8, candidateLimit: 24, useVector: false, useGraph: false, useRerank: false });
  assert.equal(planRetrieval('what is the impact of this change').mode, 'balanced');
  assert.equal(planRetrieval('anything', 'invalid').mode, 'balanced');
});

test('efeitos dos modos distinguem limite aplicado de estágios controlados pelo backend', () => {
  assert.deepEqual(describeRetrievalMode('find symbol', 'fast'), {
    mode: 'fast',
    resultLimit: 8,
    candidateLimit: 'backend_uncontrolled',
    vector: 'backend_uncontrolled',
    graph: 'backend_uncontrolled',
    rerank: 'backend_uncontrolled'
  });
  assert.equal(describeRetrievalMode('impact callers').mode, 'balanced');
  assert.equal(describeRetrievalMode('anything', 'thorough').resultLimit, 20);
});

test('reranker só altera o ranking com scores completos, finitos e no intervalo', () => {
  const candidates = [{ chunkId: 'a', score: 0.1 }, { chunkId: 'b', score: 0.2 }];
  assert.equal(validateRerankScores([0.2, 1], 2)?.length, 2);
  assert.equal(validateRerankScores([0.2, Number.NaN], 2), null);
  assert.equal(applyRerankScores(candidates, [0.3]).applied, false);
  const applied = applyRerankScores(candidates, [0.9, 0.1], { model: 'reranker' });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.candidates.map(item => item.chunkId), ['a', 'b']);
  assert.deepEqual(applied.candidates[0].sources, ['rerank']);
  assert.doesNotThrow(() => applyRerankScores([{ chunkId: 'b' }, { chunkId: 'a' }], [0.5, 0.5]));
});

test('proveniência marca divergência e idade como stale, e ausência como unknown', () => {
  assert.equal(getFreshness({ indexedHash: 'a', sourceHash: 'b' }), 'stale');
  assert.equal(getFreshness({ indexedHash: 'historical' }), 'unknown');
  assert.equal(getFreshness({ indexedAt: '2026-01-01T00:00:00Z', now: Date.parse('2026-01-02T00:00:00Z'), staleAfterMs: 1 }), 'stale');
  assert.equal(getFreshness({}), 'unknown');
  const provenance = buildProvenance({ project: 'api', path: 'src/a.cs', chunkId: '1', indexedHash: 'x', sourceHash: 'x', indexedCommit: 'c1' });
  assert.equal(provenance.freshness, 'fresh');
  assert.equal(provenance.chunkId, 'chunk:api:1:unknown');
});
