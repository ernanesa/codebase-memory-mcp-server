#!/usr/bin/env node

// Export the plugin-facing contract directly from the definitions consumed by
// tools/list. This is intentionally offline and never reads credentials.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MCP_PLUGIN_CONTRACT } from '../app/src/mcp-guardrail.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = path.join(root, 'contracts', 'mcp-plugin-contract.json');
const output = `${JSON.stringify(MCP_PLUGIN_CONTRACT, null, 2)}\n`;

if (process.argv.includes('--write-snapshot')) {
  await writeFile(snapshotPath, output, 'utf8');
  process.stdout.write(`Updated ${path.relative(root, snapshotPath)}\n`);
} else if (process.argv.includes('--check-snapshot')) {
  const existing = await readFile(snapshotPath, 'utf8');
  if (existing !== output) {
    process.stderr.write(`Contract snapshot is stale: ${path.relative(root, snapshotPath)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(output);
  }
} else {
  process.stdout.write(output);
}
