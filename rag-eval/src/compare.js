import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compareReports } from './lib.js';

const [baselinePath, candidatePath, policyPath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  console.error('Uso: npm run compare -- <baseline-report.json> <candidate-report.json> [policy.json]');
  process.exit(2);
}

const readJson = async file => JSON.parse(await readFile(path.resolve(file), 'utf8'));
const baseline = await readJson(baselinePath);
const candidate = await readJson(candidatePath);
const policy = policyPath ? await readJson(policyPath) : {};
const comparison = compareReports(baseline, candidate, policy);
console.log(JSON.stringify(comparison, null, 2));
if (!comparison.passed) process.exitCode = 1;
