import test from 'node:test';
import assert from 'node:assert/strict';
import { increment, observe, metricsText, recordAiUsage, recordChunkAcl } from '../src/observability.js';

test('equivalent admin labels aggregate counters and histograms', () => {
  increment('admin_labels_test', { a: 'x', b: 'y' });
  increment('admin_labels_test', { b: 'y', a: 'x', absent: null });
  increment('admin_type_test', { n: 1 });
  increment('admin_type_test', { n: '1' });
  observe('admin_hist_test', 0.1, { a: 'x', b: 'y' });
  observe('admin_hist_test', 0.2, { b: 'y', a: 'x' });
  const output = metricsText();
  assert.equal(output.split('\n').filter(line => line.startsWith('admin_labels_test')).length, 1);
  assert.match(output, /admin_labels_test\{a="x",b="y"\} 2/);
  assert.match(output, /admin_type_test\{n="1"\} 2/);
  assert.match(output, /admin_hist_test_count\{a="x",b="y"\} 2/);
});
test('admin label newlines stay within a single exposition line', () => {
  increment('admin_escape_test', { value: 'one\ntwo\r"\\' });
  assert.ok(metricsText().includes('value="one\\ntwo\\n\\"\\\\"'));
});

test('telemetria de IA e ACL mantém somente rótulos agregados e valores numéricos', () => {
  recordAiUsage({ route: 'hosted_general', inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, estimatedCostUsd: 0.002, latencyMs: 20, outcome: 'success', cacheHit: true });
  recordChunkAcl({ allowed: 2, denied: 1 });
  const output = metricsText();
  assert.match(output, /cbm_ai_tokens_total\{kind="input",outcome="success",route="hosted_general"\} 10/);
  assert.match(output, /cbm_ai_cost_usd_estimated_total\{outcome="success",route="hosted_general"\} 0.002/);
  assert.match(output, /cbm_ai_cache_events_total\{result="hit",route="hosted_general"\} 1/);
  assert.match(output, /cbm_rag_chunk_acl_total\{result="denied"\} 1/);
});

test('telemetria de IA restringe labels e limites de tokens', () => {
  recordAiUsage({ route: 'employee prompt text', inputTokens: 8, cachedInputTokens: 40, outputTokens: -2, outcome: 'customer-123' });
  const output = metricsText();
  assert.match(output, /cbm_ai_tokens_total\{kind="cached_input",outcome="unknown",route="unknown"\} 8/);
  assert.match(output, /cbm_ai_tokens_total\{kind="output",outcome="unknown",route="unknown"\} 0/);
  assert.doesNotMatch(output, /employee prompt text|customer-123/);
});
