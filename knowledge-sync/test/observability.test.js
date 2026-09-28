import test from 'node:test';
import assert from 'node:assert/strict';
import { increment, gauge, observe, metricsText, configureBuckets } from '../src/observability.js';

test('observability exporta metricas com formato prometheus correto e lida com caracteres especiais nos labels', () => {
  increment('sync_test_counter', { target: 'kb=1,part=2', status: 'ok' }, 3);
  gauge('sync_test_gauge', 42, { environment: 'test"quotes"', path: '/api/v1?a=1&b=2' });
  configureBuckets('sync_test_duration', [0.1, 0.5, 1]);
  observe('sync_test_duration', 0.25, { op: 'fetch,parse' });
  observe('sync_test_duration', 0.8, { op: 'fetch,parse' });

  const text = metricsText();

  // Contador
  assert.match(text, /sync_test_counter\{status="ok",target="kb=1,part=2"\} 3/);

  // Gauge com escape de aspas
  assert.match(text, /sync_test_gauge\{environment="test\\"quotes\\"",path="\/api\/v1\?a=1&b=2"\} 42/);

  // Histograma
  assert.match(text, /sync_test_duration_bucket\{le="0.1",op="fetch,parse"\} 0/);
  assert.match(text, /sync_test_duration_bucket\{le="0.5",op="fetch,parse"\} 1/);
  assert.match(text, /sync_test_duration_bucket\{le="1",op="fetch,parse"\} 2/);
  assert.match(text, /sync_test_duration_bucket\{le="\+Inf",op="fetch,parse"\} 2/);
  assert.match(text, /sync_test_duration_count\{op="fetch,parse"\} 2/);
  assert.match(text, /sync_test_duration_sum\{op="fetch,parse"\} 1\.05/);
});

test('observability agrega séries equivalentes com labels em ordens distintas e escapa quebras de linha', () => {
  increment('sync_canonical_counter', { workspace: 'payments', operation: 'index' });
  increment('sync_canonical_counter', { operation: 'index', workspace: 'payments' });
  configureBuckets('sync_canonical_duration', [0.5, 1]);
  observe('sync_canonical_duration', 0.25, { workspace: 'payments', operation: 'index' });
  observe('sync_canonical_duration', 0.75, { operation: 'index', workspace: 'payments' });
  gauge('sync_multiline_gauge', 1, { detail: 'first\nsecond\rthird' });

  const text = metricsText();

  assert.match(text, /sync_canonical_counter\{operation="index",workspace="payments"\} 2/);
  assert.equal((text.match(/sync_canonical_counter\{/g) || []).length, 1);
  assert.match(text, /sync_canonical_duration_bucket\{le="0.5",operation="index",workspace="payments"\} 1/);
  assert.match(text, /sync_canonical_duration_bucket\{le="1",operation="index",workspace="payments"\} 2/);
  assert.match(text, /sync_canonical_duration_count\{operation="index",workspace="payments"\} 2/);
  assert.match(text, /sync_canonical_duration_sum\{operation="index",workspace="payments"\} 1/);
  assert.match(text, /sync_multiline_gauge\{detail="first\\nsecond\\nthird"\} 1/);
});
