#!/usr/bin/env node
import { createHash } from 'node:crypto';

const PROMPT = 'Return exactly the word OK. Do not add punctuation or explanation.';

function usage() {
  process.stdout.write('Usage: node scripts/benchmark-ollama-runtime.mjs --model MODEL [--url http://127.0.0.1:11434] [--warmup 1] [--repeats 5] [--concurrency 1] [--context 8192]\nSynthetic input only; output contains aggregate timing and token counts, never model text.\n');
}

function integer(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

function parseArguments(args) {
  if (args.includes('--help')) return { help: true };
  if (args.length % 2) throw new Error('Every option requires a value');
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const [key, value] = args.slice(index, index + 2);
    if (!['--model', '--url', '--warmup', '--repeats', '--concurrency', '--context'].includes(key) || options.has(key)) throw new Error('Unknown or duplicate option');
    options.set(key, value);
  }
  const model = options.get('--model');
  if (!model || model.length > 160 || /[\r\n]/.test(model)) throw new Error('--model is required');
  const url = new URL(options.get('--url') || 'http://127.0.0.1:11434');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('--url must be an HTTP(S) origin without credentials');
  return {
    model,
    url,
    warmup: integer(options.get('--warmup') ?? '1', '--warmup', 0, 5),
    repeats: integer(options.get('--repeats') ?? '5', '--repeats', 1, 30),
    concurrency: integer(options.get('--concurrency') ?? '1', '--concurrency', 1, 4),
    context: integer(options.get('--context') ?? '8192', '--context', 512, 32768)
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 10) / 10;
}

async function sample(options) {
  const started = performance.now();
  const response = await fetch(new URL('/api/generate', options.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: options.model, prompt: PROMPT, stream: false, options: { num_ctx: options.context, num_predict: 16 } }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error('Ollama returned an inference error');
  return {
    wallMs: performance.now() - started,
    loadMs: Number(result.load_duration || 0) / 1_000_000,
    promptTokens: Number(result.prompt_eval_count || 0),
    outputTokens: Number(result.eval_count || 0),
    outputTokensPerSecond: result.eval_duration > 0 ? Number(result.eval_count || 0) * 1_000_000_000 / Number(result.eval_duration) : 0
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return usage();
  for (let index = 0; index < options.warmup; index += 1) await sample(options);
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency, options.repeats) }, async () => {
    while (next < options.repeats) {
      next += 1;
      results.push(await sample(options));
    }
  }));
  process.stdout.write(`${JSON.stringify({
    schema: 1,
    modelFingerprint: createHash('sha256').update(options.model).digest('hex').slice(0, 16),
    endpointFingerprint: createHash('sha256').update(options.url.origin).digest('hex').slice(0, 16),
    context: options.context,
    concurrency: options.concurrency,
    samples: results.length,
    wallMs: { p50: percentile(results.map(result => result.wallMs), 0.5), p95: percentile(results.map(result => result.wallMs), 0.95) },
    loadMs: { p50: percentile(results.map(result => result.loadMs), 0.5), p95: percentile(results.map(result => result.loadMs), 0.95) },
    outputTokensPerSecond: { p50: percentile(results.map(result => result.outputTokensPerSecond), 0.5) },
    totalPromptTokens: results.reduce((total, result) => total + result.promptTokens, 0),
    totalOutputTokens: results.reduce((total, result) => total + result.outputTokens, 0)
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Benchmark failed'}\n`);
  process.exitCode = 1;
});
