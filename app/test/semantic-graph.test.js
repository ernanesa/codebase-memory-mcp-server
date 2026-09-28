import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { assertContainedInput, normalizeSemanticGraph } from '../src/semantic-graph.js';

const options = { workspace: '/repo', project: 'orders', sourceHash: 'a'.repeat(64), commit: 'f'.repeat(40) };
const execFile = promisify(execFileCallback);

test('normaliza a saída Roslyn, deduplica relações e produz ids estáveis', () => {
  const result = { file: 'src/OrderService.cs', parser: 'roslyn-5.9.0-semantic', relations: [
    { source: 'Orders.Create', relation: 'CALLS', target: 'Repository.Save', confidence: 1, evidence: 'roslyn-semantic-symbol' },
    { source: 'Orders.Create', relation: 'CALLS', target: 'Repository.Save', confidence: 1, evidence: 'roslyn-semantic-symbol' },
    { source: 'Orders.Create', relation: 'CALLS', target: 'Repository.Save', confidence: 2, evidence: 'invalid' }
  ] };
  const normalized = normalizeSemanticGraph(result, options);
  assert.equal(normalized.edges.length, 1);
  assert.equal(normalized.chunks.length, 1);
  assert.equal(normalized.edges[0].filePath, 'src/OrderService.cs');
  assert.deepEqual(normalized, normalizeSemanticGraph(result, options));
});

test('normaliza formato TypeScript e descarta segredo e caminhos fora do workspace', () => {
  const normalized = normalizeSemanticGraph({ file: 'src/worker.ts', relations: [
    { source: 'run', relation: 'CALLS', target: 'save', confidence: 1, evidence: 'typescript-compiler-api' },
    { file: '.env', source: 'run', relation: 'CALLS', target: 'leak', confidence: 1 },
    { file: '../outside.ts', source: 'run', relation: 'CALLS', target: 'escape', confidence: 1 },
    { source: 'run', relation: 'CALLS', target: 'save', confidence: 1, evidence: 'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890' }
  ] }, options);
  assert.equal(normalized.edges.length, 1);
  assert.equal(normalized.statistics.rejectedRelations, 3);
});

test('recusa saída Roslyn agregada sem referência de arquivo por relação', () => {
  assert.throws(() => normalizeSemanticGraph({
    file: '/repo/Orders.sln', parser: 'roslyn-5.9.0-semantic',
    relations: [{ source: 'Orders.Create', relation: 'CALLS', target: 'Store.Save', confidence: 1, evidence: 'roslyn-semantic-symbol' }]
  }, options), /exige file, filePath ou sourceRef/);
});

test('rejeita entrada simbólica, fora do workspace e arquivo sensível', async t => {
  const workspace = path.join(os.tmpdir(), `semantic-graph-workspace-${process.pid}-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const input = path.join(workspace, 'result.json');
  await writeFile(input, '{}');
  assert.equal((await assertContainedInput(input, workspace)).file, input);
  const link = path.join(workspace, 'link.json');
  await symlink(input, link);
  await assert.rejects(assertContainedInput(link, workspace), /link simbólico/);
  const linkedDirectory = path.join(workspace, 'linked');
  const directory = path.join(workspace, 'directory');
  await mkdir(directory);
  await writeFile(path.join(directory, 'nested.json'), '{}');
  await symlink(directory, linkedDirectory);
  await assert.rejects(assertContainedInput(path.join(linkedDirectory, 'nested.json'), workspace), /diretórios ancestrais/);
  const secret = path.join(workspace, '.env');
  await writeFile(secret, '{}');
  await assert.rejects(assertContainedInput(secret, workspace), /caminhos sensíveis/);
});

test('CLI transforma um fixture JSON em artefato normalizado sem executar analisador', async t => {
  const workspace = path.join(os.tmpdir(), `semantic-graph-cli-${process.pid}-${Date.now()}`);
  const analysis = path.join(workspace, 'analysis');
  const input = path.join(analysis, 'roslyn.json');
  const output = path.join(analysis, 'artifact.json');
  await mkdir(analysis, { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(input, JSON.stringify({
    file: 'src/Orders.cs', parser: 'roslyn-5.9.0-semantic',
    relations: [{ source: 'Orders.Create', relation: 'CALLS', target: 'Store.Save', confidence: 1, evidence: 'roslyn-semantic-symbol' }]
  }));
  const script = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'import-semantic-graph.mjs');
  await execFile(process.execPath, [script, '--input', input, '--workspace', workspace, '--project', 'orders', '--source-hash', 'a'.repeat(64), '--commit', 'f'.repeat(40), '--output', output]);
  const artifact = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(artifact.edges[0].relation, 'CALLS');
  assert.equal(artifact.provenance.parser, 'roslyn-5.9.0-semantic');
});
