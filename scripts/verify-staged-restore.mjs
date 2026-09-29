#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const ALLOWED_SECTIONS = new Set(['data', 'cache', 'repositories', 'openwebui-data', 'ollama-data']);

function usage() {
  process.stdout.write('Usage: node scripts/verify-staged-restore.mjs --snapshot-root DIR --restored-root DIR [--sections data,cache,openwebui-data,ollama-data]\nCompares a frozen snapshot with an isolated restored copy. Reads files only; prints aggregate counts, never paths or contents.\n');
}

function parseArguments(args) {
  if (args.includes('--help')) return { help: true };
  if (args.length % 2) throw new Error('Every option requires a value');
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const [key, value] = args.slice(index, index + 2);
    if (!['--snapshot-root', '--restored-root', '--sections'].includes(key) || options.has(key)) throw new Error('Unknown or duplicate option');
    options.set(key, value);
  }
  if (!options.get('--snapshot-root') || !options.get('--restored-root')) throw new Error('Both roots are required');
  const sections = (options.get('--sections') || 'data,cache,openwebui-data,ollama-data').split(',');
  if (!sections.length || new Set(sections).size !== sections.length || sections.some(section => !ALLOWED_SECTIONS.has(section))) throw new Error('Invalid section list');
  const snapshotRoot = path.resolve(options.get('--snapshot-root'));
  const restoredRoot = path.resolve(options.get('--restored-root'));
  if (snapshotRoot === restoredRoot) throw new Error('Snapshot and restored roots must differ');
  return { snapshotRoot, restoredRoot, sections };
}

async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function inventory(root, section) {
  const entries = new Map();
  const visit = async (relative) => {
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symlink in ${section}; staged restore cannot be verified safely`);
    if (stat.isDirectory()) {
      entries.set(relative, { type: 'directory' });
      for (const name of await readdir(absolute)) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      entries.set(relative, { type: 'file', bytes: stat.size, sha256: await fileDigest(absolute) });
    } else {
      throw new Error(`Unsupported entry in ${section}`);
    }
  };
  await visit(section);
  return entries;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return usage();
  const summary = [];
  for (const section of options.sections) {
    const source = await inventory(options.snapshotRoot, section);
    const restored = await inventory(options.restoredRoot, section);
    let mismatches = 0;
    for (const [relative, entry] of source) {
      if (JSON.stringify(entry) !== JSON.stringify(restored.get(relative))) mismatches += 1;
    }
    for (const relative of restored.keys()) if (!source.has(relative)) mismatches += 1;
    summary.push({ section, files: [...source.values()].filter(entry => entry.type === 'file').length, mismatches });
  }
  const verified = summary.every(section => section.mismatches === 0);
  process.stdout.write(`${JSON.stringify({ schema: 1, verified, sections: summary })}\n`);
  if (!verified) process.exitCode = 1;
}

main().catch(error => {
  const message = error instanceof Error && error.code === 'ENOENT' ? 'Required staged section or file is missing' : error instanceof Error && error.message.startsWith('Symlink in ') ? error.message : 'Staged verification failed on unsupported or unreadable content';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
