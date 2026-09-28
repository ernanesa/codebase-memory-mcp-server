import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateCase, extractCandidates, summarize, validateDataset } from '../evaluator.mjs';

const dataset = validateDataset([{ id: 'symbol', query: 'CreateOrder', relevantPaths: ['src/orders.js'], requiredEvidencePaths: ['src/orders.js'], expectedSymbols: ['createOrder'] }]);

test('mede recall, nDCG, MRR, bytes e frescor por candidato', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-eval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'orders.js'), 'export function createOrder() {}\n');
  const sha256 = createHash('sha256').update('export function createOrder() {}\n').digest('hex');
  const report = await evaluateCase(dataset[0], [{ path: 'src/orders.js', symbol: 'createOrder', content: '', sha256 }], { elapsedMs: 12.345, responseBytes: 128, sourceRoot: root });
  assert.equal(report.metrics.recallAt1, 1);
  assert.equal(report.metrics.ndcgAt1, 1);
  assert.equal(report.metrics.mrr, 1);
  assert.equal(report.metrics.citationFreshness, 1);
  assert.equal(report.metrics.responseBytes, 128);
});

test('não mistura chunk fora da consulta nem aceita caminhos fora do root', async () => {
  assert.throws(() => validateDataset([{ id: 'bad', query: 'x', relevantPaths: ['../secret'], expectedSymbols: [] }]));
  assert.throws(() => validateDataset([{ id: 'environment', query: 'x', relevantPaths: ['.env.production'], expectedSymbols: [] }]));
  assert.throws(() => validateDataset([{ id: 'credential-path', query: 'x', relevantPaths: ['credentials/token.json'], expectedSymbols: [] }]));
  assert.throws(() => validateDataset([{ id: 'credential', query: 'x', relevantPaths: ['src/x.js'], toolArguments: { apiToken: 'never' } }]));
  const report = await evaluateCase(dataset[0], [{ path: 'src/other.js', symbol: 'other', content: '', sha256: null }], { elapsedMs: 1 });
  assert.equal(report.metrics.recallAt10, 0);
  assert.equal(report.metrics.mrr, 0);
});

test('não calcula frescor por symlink que sai do source root', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-eval-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'code-eval-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(outside, 'outside.js'), 'outside\n');
  await symlink(path.join(outside, 'outside.js'), path.join(root, 'src', 'outside.js'));
  const sha256 = createHash('sha256').update('outside\n').digest('hex');
  const report = await evaluateCase(dataset[0], [{ path: 'src/outside.js', symbol: '', content: '', sha256 }], { elapsedMs: 1, sourceRoot: root });
  assert.equal(report.returned[0].freshness, 'unavailable');
  assert.deepEqual(Object.keys(report.returned[0]).sort(), ['freshness', 'path', 'sha256', 'symbol']);
});

test('considera a cobertura de caminhos completa quando o caso só exige símbolo', async () => {
  const symbolsOnly = validateDataset([{ id: 'symbols-only', query: 'CreateOrder', expectedSymbols: ['createOrder'] }]);
  const report = await evaluateCase(symbolsOnly[0], [{ path: 'src/orders.js', symbol: 'createOrder', content: '', sha256: null }], { elapsedMs: 1 });
  assert.equal(report.metrics.evidencePathRecall, 1);
});

test('extrai resultados MCP estruturados e preserva frescor desconhecido no resumo', () => {
  const candidates = extractCandidates({ structuredContent: { results: [{ file_path: 'src/orders.js', qualified_name: 'createOrder', source_hash: 'abc' }] } });
  assert.deepEqual(candidates.map(item => item.path), ['src/orders.js']);
  const report = summarize([{ metrics: { recallAt1: 1, recallAt3: 1, recallAt5: 1, recallAt10: 1, ndcgAt1: 1, ndcgAt3: 1, ndcgAt5: 1, ndcgAt10: 1, mrr: 1, evidencePathRecall: 1, citationFreshness: null, latencyMs: 10, responseBytes: 42 } }]);
  assert.equal(report.citationFreshness, null);
  assert.equal(report.p95LatencyMs, 10);
  assert.equal(report.p95ResponseBytes, 42);
});
