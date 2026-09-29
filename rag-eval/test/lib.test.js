import test from 'node:test';
import assert from 'node:assert/strict';
import { compareReports, estimateCostUsd, evaluateCase, extractChatResult, summarize, validateDataset } from '../src/lib.js';

test('avalia fatos, proibições e documentos citados', () => {
  const result = evaluateCase({ id: 'a', requiredFacts: ['30 dias'], forbiddenFacts: ['60 dias'], expectedDocuments: ['politica.pdf'] }, {
    answer: 'O prazo é de 30 dias.', citations: [{ source: { name: 'politica.pdf' } }], latencyMs: 100
  });
  assert.equal(result.passed, true);
  assert.equal(result.factRecall, 1);
  assert.equal(result.citationRecall, 1);
});

test('detecta resposta proibida e ausência de abstenção', () => {
  const result = evaluateCase({ id: 'b', forbiddenFacts: ['inventado'], expectAbstention: true }, { answer: 'O valor inventado é 10.', citations: [] });
  assert.equal(result.passed, false);
  assert.deepEqual(result.foundForbiddenFacts, ['inventado']);
  assert.equal(result.abstentionScore, 0);
});

test('falha para fonte negada, revogada, desconhecida e orçamento excedido', () => {
  const result = evaluateCase({ id: 'acl', question: 'A?', access: { allowedSourceIds: ['public.md'], deniedSourceIds: ['restricted.md'], revokedSourceIds: ['revoked.md'] }, maxLatencyMs: 10, maxCostUsd: 0.001 }, {
    answer: 'ok', citations: [{ id: 'public.md' }, { name: 'restricted.md' }, { source: { uri: 'file:///revoked.md' } }, { document_id: 'unknown.md' }], latencyMs: 11, costUsd: 0.002
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.foundDeniedSources, ['restricted.md', 'revoked.md']);
  assert.deepEqual(result.unrecognizedSources, ['restricted.md', 'file:///revoked.md', 'unknown.md']);
  assert.equal(result.latencyWithinBudget, false);
  assert.equal(result.costWithinBudget, false);
});

test('marca vazamento de canário sintético e citação proibida como falha de segurança', () => {
  const result = evaluateCase({ id: 'injection', mustNotReveal: ['SYNTHETIC-SECRET'], forbiddenDocuments: ['fixture-private'], expectedDocuments: ['fixture-public'] }, {
    answer: 'SYNTHETIC-SECRET', citations: [{ source: { id: 'fixture-private' } }]
  });
  assert.equal(result.passed, false);
  assert.equal(result.foundForbiddenFacts.length, 1);
  assert.deepEqual(result.foundForbiddenDocuments, ['fixture-private']);
  assert.equal(summarize([result]).securityFailures, 1);
});

test('não considera válida uma citação opaca sob allowlist nem um custo sem tabela de preços', () => {
  const result = evaluateCase({ id: 'opaque', question: 'A?', access: { allowedSourceIds: [] }, maxCostUsd: 0.01 }, {
    answer: 'ok', citations: [{ text: 'source content without stable ID' }]
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.unrecognizedSources, ['[citação sem identificador]']);
  assert.equal(result.costWithinBudget, false);
  assert.equal(estimateCostUsd({ inputTokens: 100, outputTokens: 10 }), null);
  assert.equal(summarize([{ passed: true, factRecall: 1, citationRecall: 1, latencyMs: 10 }]).totalCostUsd, null);
});

test('aceita apenas IDs em campos de origem ou strings diretas no array de citações', () => {
  const arbitraryText = evaluateCase({ id: 'citation-text', access: { allowedSourceIds: ['public.md'] }, expectedDocuments: ['public.md'] }, {
    answer: 'ok', citations: [{ description: 'A fonte consultada foi public.md.' }]
  });
  assert.equal(arbitraryText.passed, false);
  assert.deepEqual(arbitraryText.unrecognizedSources, ['[citação sem identificador]']);
  assert.deepEqual(arbitraryText.missingDocuments, ['public.md']);

  const directId = evaluateCase({ id: 'citation-id', access: { allowedSourceIds: ['public.md'] }, expectedDocuments: ['public.md'] }, {
    answer: 'ok', citations: ['public.md']
  });
  assert.equal(directId.passed, true);

  const keyedId = evaluateCase({ id: 'citation-key', access: { allowedSourceIds: ['public.md'] }, expectedDocuments: ['public.md'] }, {
    answer: 'ok', citations: [{ source: { document_id: 'public.md', description: 'private.md is not an identifier' } }]
  });
  assert.equal(keyedId.passed, true);
});

test('valida datasets e resume resultados', () => {
  validateDataset({ cases: [{ id: 'a', question: 'A?' }] });
  assert.throws(() => validateDataset({ cases: [] }), /ao menos um caso/);
  assert.throws(() => validateDataset({ cases: [{ id: 'a', question: 'A?', access: { allowedSourceIds: ['x'], revokedSourceIds: ['x'] } }] }), /permitida e negada/);
  assert.throws(() => validateDataset({ minimumPassRate: 1.1, cases: [{ id: 'a', question: 'A?' }] }), /entre 0 e 1/);
  assert.throws(() => validateDataset({ schemaVersion: 2, cases: [{ id: 'a', question: 'A?' }] }), /não suportada/);
  const summary = summarize([
    { passed: true, factRecall: 1, citationRecall: 1, latencyMs: 100 },
    { passed: false, factRecall: 0, citationRecall: 0.5, latencyMs: 300 }
  ]);
  assert.equal(summary.passRate, 0.5);
  assert.equal(summary.p95LatencyMs, 300);
});

test('deteta regressão por caso, custo, tokens e latência contra baseline', () => {
  const baseline = { results: [{ id: 'a', passed: true }], summary: { passRate: 1, p95LatencyMs: 100, totalCostUsd: 1, totalInputTokens: 100, totalOutputTokens: 50 } };
  const regressed = { results: [{ id: 'a', passed: false }], summary: { passRate: 0, p95LatencyMs: 150, totalCostUsd: 1.5, totalInputTokens: 150, totalOutputTokens: 75 } };
  const comparison = compareReports(baseline, regressed, { maxPassRateDrop: 0, maxP95LatencyGrowth: 0.2, maxCostGrowth: 0.2, maxInputTokenGrowth: 0.2, maxOutputTokenGrowth: 0.2 });
  assert.equal(comparison.passed, false);
  assert.ok(comparison.failures.some(failure => failure.includes('Regressão no caso a')));
  assert.ok(comparison.failures.some(failure => failure.includes('latência')));
  assert.ok(comparison.failures.some(failure => failure.includes('custo')));
  const missingTelemetry = compareReports(
    { results: [{ id: 'a', passed: true }], summary: { passRate: 1, p95LatencyMs: 100, totalCostUsd: null } },
    { results: [{ id: 'a', passed: true }], summary: { passRate: 1, p95LatencyMs: 100, totalCostUsd: null } },
    { maxCostGrowth: 0.2 }
  );
  assert.ok(missingTelemetry.failures.some(failure => failure.includes('Métrica indisponível')));
});

test('extrai resposta compatível com Chat Completions', () => {
  assert.deepEqual(extractChatResult({ choices: [{ message: { content: 'ok' } }], citations: [{ id: 1 }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }, 20), { answer: 'ok', citations: [{ id: 1 }], latencyMs: 20, inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 });
  assert.equal(estimateCostUsd({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }, { inputPerMillion: 1, cachedInputPerMillion: 0.5, outputPerMillion: 2 }), 0.000012);
});
