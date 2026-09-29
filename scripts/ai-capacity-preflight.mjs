#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

function usage() {
  process.stdout.write('Usage: node scripts/ai-capacity-preflight.mjs [--live]\nRead-only Compose validation and GPU summary. --live also queries Ollama on 127.0.0.1:11434; no model names or response contents are printed.\n');
}

async function command(file, args) {
  try {
    return await run(file, args, { timeout: 10_000, maxBuffer: 256 * 1024 });
  } catch (error) {
    return { failed: true, code: typeof error?.code === 'number' ? error.code : null };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) return usage();
  if (args.length > 1 || (args.length === 1 && args[0] !== '--live')) throw new Error('Unknown option');
  const compose = await command('docker', ['compose', '-f', 'compose.yaml', 'config', '--quiet']);
  const gpu = await command('nvidia-smi', ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits']);
  const gpuMemory = gpu.failed ? [] : gpu.stdout.trim().split('\n').filter(Boolean).map(line => line.split(',').map(value => Number(value.trim())));
  const result = {
    schema: 1,
    composeConfig: compose.failed ? 'not_verified' : 'valid',
    gpu: gpuMemory.length && gpuMemory.every(values => values.length === 2 && values.every(Number.isFinite))
      ? { devices: gpuMemory.length, totalMiB: gpuMemory.reduce((sum, values) => sum + values[0], 0), usedMiB: gpuMemory.reduce((sum, values) => sum + values[1], 0) }
      : 'not_verified'
  };
  if (args[0] === '--live') {
    try {
      const response = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error();
      const loaded = (await response.json()).models;
      if (!Array.isArray(loaded)) throw new Error();
      result.ollama = {
        loadedModels: loaded.length,
        reportedVramMiB: Math.round(loaded.reduce((sum, model) => sum + Math.max(0, Number(model.size_vram) || 0), 0) / 1048576)
      };
    } catch {
      result.ollama = 'not_verified';
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.composeConfig !== 'valid') process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write('Preflight failed before validation\n');
  process.exitCode = 1;
});
