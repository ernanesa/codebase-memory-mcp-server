import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { evaluateCase, extractCandidates, summarize, validateDataset } from './evaluator.mjs';
import { mcpCall } from './mcp-http.mjs';

function options(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Argumento inválido: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Valor ausente para ${key}`);
    parsed.set(key.slice(2), value); index += 1;
  }
  if (parsed.has('fixtures') === parsed.has('endpoint')) throw new Error('Informe exatamente um de --fixtures ou --endpoint.');
  if (parsed.has('endpoint') && !/^https?:\/\//.test(parsed.get('endpoint'))) throw new Error('--endpoint deve usar HTTP(S).');
  for (const key of parsed.keys()) if (!['fixtures', 'endpoint', 'queries', 'token-env', 'source-root', 'output', 'repeats', 'compare'].includes(key)) throw new Error(`Argumento não suportado: --${key}`);
  return parsed;
}

export function assertSuccessfulResponse(response, caseId) {
  if (response?.isError === true) throw new Error(`MCP retornou isError para ${caseId}.`);
}

export async function run(argv = process.argv.slice(2)) {
  const args = options(argv);
  const sourceRoot = args.has('source-root') ? resolve(args.get('source-root')) : undefined;
  let dataset;
  let fixtureResults = {};
  if (args.has('fixtures')) {
    const fixture = JSON.parse(await readFile(args.get('fixtures'), 'utf8'));
    dataset = validateDataset(fixture.cases);
    fixtureResults = fixture.results;
    if (!fixtureResults || typeof fixtureResults !== 'object' || Array.isArray(fixtureResults)) throw new Error('fixtures.results deve ser um objeto.');
  } else dataset = validateDataset(JSON.parse(await readFile(args.get('queries'), 'utf8')));
  const token = args.has('token-env') ? process.env[args.get('token-env')] : process.env.CODE_EVAL_MCP_TOKEN;
  if (args.has('endpoint') && !token) throw new Error(`Defina o token em ${args.get('token-env') || 'CODE_EVAL_MCP_TOKEN'}; nunca o inclua no arquivo de configuração.`);
  const repeats = Number(args.get('repeats') ?? 1);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100) throw new Error('--repeats deve ser um inteiro entre 1 e 100.');
  const cases = [];
  for (let repetition = 0; repetition < repeats; repetition += 1) {
    for (const item of dataset) {
      const started = performance.now();
      let response;
      let bytes = 0;
      if (args.has('fixtures')) {
        response = fixtureResults[item.id];
        if (!response) throw new Error(`Fixture sem resultado para ${item.id}.`);
        bytes = Buffer.byteLength(JSON.stringify(response));
      } else {
        const call = await mcpCall(args.get('endpoint'), token, item.tool || 'code_search_surgical', { project: item.project, query: item.query, ...(item.toolArguments ?? {}) });
        response = call.result; bytes = call.bytes;
      }
      assertSuccessfulResponse(response, item.id);
      const evaluated = await evaluateCase(item, extractCandidates(response), { elapsedMs: performance.now() - started, responseBytes: bytes, sourceRoot });
      cases.push({ ...evaluated, repetition: repetition + 1 });
    }
  }
  const datasetFingerprint = createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
  let sourceRevision = null;
  if (sourceRoot) {
    try { sourceRevision = createHash('sha256').update((await readFile(resolve(sourceRoot, '.git/HEAD'))).toString()).digest('hex').slice(0, 16); } catch { sourceRevision = null; }
  }
  const grouped = dataset.map(item => ({ id: item.id, summary: { attempted: cases.filter(result => result.id === item.id).length, ...summarize(cases.filter(result => result.id === item.id)) } }));
  const output = {
    schemaVersion: 2, generatedAt: new Date().toISOString(), source: args.has('fixtures') ? 'fixture' : 'mcp-http',
    identity: { datasetFingerprint, datasetCases: dataset.length, sourceRevision, node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, availableParallelism: os.availableParallelism(), sourceRootProvided: Boolean(sourceRoot) },
    configuration: { repetitions: repeats }, cases, summary: summarize(cases), byCase: grouped
  };
  if (args.has('compare')) {
    const baseline = JSON.parse(await readFile(args.get('compare'), 'utf8'));
    const compatible = baseline.schemaVersion === output.schemaVersion
      && baseline.identity?.datasetFingerprint === datasetFingerprint
      && baseline.configuration?.repetitions === repeats
      && baseline.source === output.source;
    output.comparison = {
      compatible,
      reason: compatible ? null : 'Baseline incompatível: schema, fingerprint do dataset, fonte ou repetições diferem.',
      delta: compatible ? Object.fromEntries(['recallAt1', 'recallAt3', 'recallAt5', 'recallAt10', 'evidencePathRecall', 'citationFreshness', 'p95LatencyMs'].map(key => [key, output.summary[key] === null || baseline.summary[key] === null ? null : Math.round((output.summary[key] - baseline.summary[key]) * 100) / 100])) : null
    };
  }
  return output;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const report = await run();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const args = options(process.argv.slice(2));
  if (args.has('output')) await writeFile(args.get('output'), serialized, { mode: 0o600 });
  else process.stdout.write(serialized);
}
