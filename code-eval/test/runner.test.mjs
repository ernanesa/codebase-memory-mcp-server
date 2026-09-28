import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSuccessfulResponse, run } from '../runner.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('recusa resultados MCP marcados como erro antes de avaliar evidências', () => {
  assert.throws(() => assertSuccessfulResponse({ isError: true }, 'broken-case'), /isError/);
  assert.doesNotThrow(() => assertSuccessfulResponse({ isError: false }, 'valid-case'));
});

test('runner fixture produz identidade reprodutível, repetições e resumo por caso', async () => {
  const report = await run(['--fixtures', new URL('../fixtures/offline-results.json', import.meta.url).pathname, '--source-root', new URL('../fixtures/source', import.meta.url).pathname, '--repeats', '3']);
  assert.equal(report.schemaVersion, 2);
  assert.match(report.identity.datasetFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(report.identity.datasetCases, 2);
  assert.equal(report.configuration.repetitions, 3);
  assert.equal(report.cases.length, 6);
    assert.deepEqual(report.byCase.map(item => item.summary.attempted), [3, 3]);
  assert.equal(report.summary.recallAt1, 1);
});

test('runner compara somente baseline com identidade e configuração compatíveis', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'code-eval-'));
  try {
    const fixturePath = new URL('../fixtures/offline-results.json', import.meta.url).pathname;
    const first = await run(['--fixtures', fixturePath, '--repeats', '2']);
    const baselinePath = path.join(directory, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(first));
    const compared = await run(['--fixtures', fixturePath, '--repeats', '2', '--compare', baselinePath]);
    assert.equal(compared.comparison.compatible, true);
    assert.equal(compared.comparison.delta.p95LatencyMs, 0);
    const incompatible = await run(['--fixtures', fixturePath, '--repeats', '1', '--compare', baselinePath]);
    assert.equal(incompatible.comparison.compatible, false);
    assert.equal(incompatible.comparison.delta, null);
    assert.equal((await readFile(baselinePath, 'utf8')).length > 0, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
