#!/usr/bin/env node
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { assertContainedInput, normalizeSemanticGraph } from '../app/src/semantic-graph.js';

const MAX_INPUT_BYTES = 10 * 1024 * 1024;

function usage() {
  return 'Uso: node scripts/import-semantic-graph.mjs --input <analyzer.json> --workspace <repo> --project <id> --source-hash <sha256> --commit <sha> --output <artifact.json> [--max-relations <n>]';
}

function argumentsFrom(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith('--') || values[index + 1] === undefined) throw new Error(usage());
    parsed[key.slice(2)] = values[index + 1];
  }
  for (const key of ['input', 'workspace', 'project', 'source-hash', 'commit', 'output']) if (!parsed[key]) throw new Error(usage());
  return parsed;
}

try {
  const args = argumentsFrom(process.argv.slice(2));
  const contained = await assertContainedInput(args.input, args.workspace);
  const raw = await readFile(contained.file, 'utf8');
  if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) throw new Error(`A entrada excede ${MAX_INPUT_BYTES} bytes.`);
  const artifact = normalizeSemanticGraph(JSON.parse(raw), {
    workspace: contained.root, project: args.project, sourceHash: args['source-hash'], commit: args.commit,
    maxRelations: args['max-relations'] ? Number(args['max-relations']) : undefined
  });
  const output = path.resolve(args.output);
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, output);
  process.stdout.write(`${JSON.stringify({ output, edges: artifact.edges.length, chunks: artifact.chunks.length })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
