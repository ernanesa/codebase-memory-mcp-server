import test from 'node:test';
import assert from 'node:assert/strict';
import { increment, observe, metricsText } from '../src/observability.js';

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
