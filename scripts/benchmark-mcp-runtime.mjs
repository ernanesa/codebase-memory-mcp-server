import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mcpCall } from '../code-eval/mcp-http.mjs';

const ENDPOINT_ENV = 'CBM_BENCHMARK_MCP_ENDPOINT';
const TOKEN_ENV = 'CBM_BENCHMARK_MCP_TOKEN';
const MAX_OPERATIONS = 10_000;

function fail(message) { throw new Error(message); }

function parsePositiveInteger(value, name, { minimum = 1, maximum = MAX_OPERATIONS } = {}) {
  if (!/^(?:0|[1-9]\d*)$/.test(value ?? '')) fail(`${name} deve ser um inteiro entre ${minimum} e ${maximum}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail(`${name} deve ser um inteiro entre ${minimum} e ${maximum}.`);
  return parsed;
}

function parseOptions(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) fail(`Argumento inválido: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Valor ausente para ${key}.`);
    if (args.has(key)) fail(`Argumento repetido: ${key}.`);
    args.set(key, value);
    index += 1;
  }
  for (const key of args.keys()) if (!['--cases', '--warmup', '--repeats', '--concurrency', '--phase', '--engine', '--compare'].includes(key)) fail(`Argumento não suportado: ${key}.`);
  if (!args.has('--cases')) fail('Informe --cases com um arquivo JSON de casos fixos.');
  const phase = args.get('--phase') ?? 'warm';
  if (!['cold', 'warm'].includes(phase)) fail('--phase deve ser cold ou warm.');
  const warmup = parsePositiveInteger(args.get('--warmup') ?? (phase === 'warm' ? '1' : '0'), '--warmup', { minimum: 0 });
  const repeats = parsePositiveInteger(args.get('--repeats') ?? '10', '--repeats');
  const concurrency = parsePositiveInteger(args.get('--concurrency') ?? '1', '--concurrency', { maximum: 100 });
  return { casesPath: resolve(args.get('--cases')), warmup, repeats, concurrency, phase, engine: args.get('--engine') ?? process.env.CBM_BENCHMARK_ENGINE ?? 'unspecified', comparePath: args.has('--compare') ? resolve(args.get('--compare')) : null };
}

function assertSafeText(value, field, id) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 20_000) fail(`${field} inválido no caso ${id}.`);
  return value;
}

function assertSafeId(value, index) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) fail(`id inválido no caso ${index}.`);
  return value;
}

function validateArguments(value, id, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object' || Array.isArray(value)) fail(`arguments inválido no caso ${id}.`);
  for (const [key, nested] of Object.entries(value)) {
    if (/token|secret|password|authorization|cookie|api[_-]?key/i.test(key)) fail(`arguments contém chave sensível no caso ${id}.`);
    if (nested === null || ['string', 'number', 'boolean'].includes(typeof nested)) continue;
    if (Array.isArray(nested) && nested.every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item))) continue;
    validateArguments(nested, id, depth + 1);
  }
}

function validateCases(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) fail('O arquivo de casos deve conter entre 1 e 100 casos.');
  const ids = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`Caso ${index} inválido.`);
    const allowed = new Set(['id', 'tool', 'arguments']);
    for (const key of Object.keys(item)) if (!allowed.has(key)) fail(`Campo não permitido no caso ${index}.`);
    const id = assertSafeId(item.id, index);
    if (ids.has(id)) fail(`id duplicado no caso ${index}.`);
    ids.add(id);
    const tool = assertSafeText(item.tool, 'tool', id);
    validateArguments(item.arguments, id);
    return { id, tool, arguments: item.arguments };
  });
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)];
}

function round(value) { return value === null ? null : Math.round(value * 100) / 100; }

function summarize(samples, elapsedMs) {
  const successful = samples.filter(sample => sample.ok);
  const latencies = successful.map(sample => sample.latencyMs);
  const bytes = successful.map(sample => sample.responseBytes);
  return {
    attempted: samples.length,
    successful: successful.length,
    errors: samples.length - successful.length,
    elapsedMs: round(elapsedMs),
    operationsPerSecond: elapsedMs > 0 ? round(samples.length / (elapsedMs / 1_000)) : null,
    latencyMs: { p50: round(percentile(latencies, 0.5)), p95: round(percentile(latencies, 0.95)), p99: round(percentile(latencies, 0.99)), mean: latencies.length ? round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null },
    responseBytes: { p50: round(percentile(bytes, 0.5)), p95: round(percentile(bytes, 0.95)), p99: round(percentile(bytes, 0.99)), mean: bytes.length ? round(bytes.reduce((sum, value) => sum + value, 0) / bytes.length) : null }
  };
}

async function runBatch(operations, concurrency, invoke) {
  const results = new Array(operations.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const current = next;
      next += 1;
      if (current >= operations.length) return;
      results[current] = await invoke(operations[current]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, operations.length) }, worker));
  return results;
}

function endpointMetadata(endpoint) {
  let parsed;
  try { parsed = new URL(endpoint); } catch { fail(`Defina ${ENDPOINT_ENV} com uma URL HTTP(S) válida.`); }
  return {
    protocol: parsed.protocol.replace(':', ''),
    targetFingerprint: createHash('sha256').update(endpoint).digest('hex').slice(0, 16)
  };
}

async function invoke(endpoint, token, operation) {
  const started = performance.now();
  try {
    const response = await mcpCall(endpoint, token, operation.tool, operation.arguments);
    if (response.result?.isError === true) return { ok: false };
    return { ok: true, latencyMs: performance.now() - started, responseBytes: response.bytes };
  } catch {
    // Error messages and MCP responses can contain user input. Keep reports aggregate-only.
    return { ok: false };
  }
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv);
  const endpoint = env[ENDPOINT_ENV];
  const token = env[TOKEN_ENV];
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) fail(`Defina ${ENDPOINT_ENV} com uma URL HTTP(S).`);
  if (typeof token !== 'string' || token.length === 0) fail(`Defina ${TOKEN_ENV}; nunca o informe pela linha de comando.`);
  const cases = validateCases(JSON.parse(await readFile(options.casesPath, 'utf8')));
  const measurementOperations = cases.flatMap(item => Array.from({ length: options.repeats }, () => item));
  const warmupOperations = cases.flatMap(item => Array.from({ length: options.warmup }, () => item));
  if (measurementOperations.length > MAX_OPERATIONS) fail(`A combinação de casos e --repeats excede ${MAX_OPERATIONS} operações.`);
  if (warmupOperations.length > MAX_OPERATIONS) fail(`A combinação de casos e --warmup excede ${MAX_OPERATIONS} operações.`);

  const warmupSamples = await runBatch(warmupOperations, options.concurrency, operation => invoke(endpoint, token, operation));
  const started = performance.now();
  const samples = await runBatch(measurementOperations, options.concurrency, operation => invoke(endpoint, token, operation));
  const elapsedMs = performance.now() - started;
  const casesFingerprint = createHash('sha256').update(JSON.stringify(cases)).digest('hex');
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      availableParallelism: os.availableParallelism(),
      engine: options.engine,
      casesFingerprint,
      cases: cases.length,
      processId: process.pid,
      ...endpointMetadata(endpoint)
    },
    configuration: { phase: options.phase, cases: cases.length, warmupPerCase: options.warmup, repeatsPerCase: options.repeats, concurrency: options.concurrency },
    warmup: { attempted: warmupSamples.length, successful: warmupSamples.filter(sample => sample.ok).length, errors: warmupSamples.filter(sample => !sample.ok).length },
    summary: summarize(samples, elapsedMs)
  };
  if (options.comparePath) {
    const baseline = JSON.parse(await readFile(options.comparePath, 'utf8'));
    const compatible = baseline.schemaVersion === output.schemaVersion
      && baseline.environment?.casesFingerprint === casesFingerprint
      && baseline.configuration?.phase === options.phase
      && baseline.configuration?.concurrency === options.concurrency
      && baseline.configuration?.repeatsPerCase === options.repeats;
    output.comparison = {
      compatible,
      reason: compatible ? null : 'Baseline incompatível: schema, fingerprint dos casos, fase, concorrência ou repetições diferem.',
      baselineEngine: baseline.environment?.engine ?? null,
      currentEngine: options.engine,
      delta: compatible ? {
        p95LatencyMs: round(output.summary.latencyMs.p95 - baseline.summary.latencyMs.p95),
        p50LatencyMs: round(output.summary.latencyMs.p50 - baseline.summary.latencyMs.p50),
        operationsPerSecond: round(output.summary.operationsPerSecond - baseline.summary.operationsPerSecond),
        errors: output.summary.errors - baseline.summary.errors,
        p95ResponseBytes: round(output.summary.responseBytes.p95 - baseline.summary.responseBytes.p95)
      } : null
    };
  }
  return output;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(await run(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`benchmark-mcp-runtime: ${error.message}\n`);
    process.exitCode = 1;
  }
}
