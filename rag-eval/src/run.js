import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { estimateCostUsd, evaluateCase, extractChatResult, summarize, validateDataset } from './lib.js';

const datasetPath = path.resolve(process.argv[2] || 'datasets/example.json');
const outputPath = path.resolve(process.argv[3] || 'reports/latest.json');
const dataset = validateDataset(JSON.parse(await readFile(datasetPath, 'utf8')));
const responsesFile = process.env.RAG_EVAL_RESPONSES_FILE;
const fixtureResponses = responsesFile ? JSON.parse(await readFile(path.resolve(responsesFile), 'utf8')) : null;
const baseUrl = String(process.env.OPENWEBUI_URL || 'http://localhost:3000').replace(/\/+$/, '');
const model = process.env.RAG_EVAL_MODEL || '';
const chatPath = process.env.RAG_EVAL_CHAT_PATH || '/api/chat/completions';
const pricing = dataset.pricing || {
  inputPerMillion: Number(process.env.RAG_EVAL_INPUT_USD_PER_MILLION || 0),
  cachedInputPerMillion: Number(process.env.RAG_EVAL_CACHED_INPUT_USD_PER_MILLION || 0),
  outputPerMillion: Number(process.env.RAG_EVAL_OUTPUT_USD_PER_MILLION || 0)
};
let token = process.env.OPENWEBUI_API_KEY || '';

async function authenticate() {
  if (token) return token;
  const email = process.env.WEBUI_ADMIN_EMAIL || '';
  const password = process.env.WEBUI_ADMIN_PASSWORD || '';
  if (!email || !password) throw new Error('Configure OPENWEBUI_API_KEY ou WEBUI_ADMIN_EMAIL/WEBUI_ADMIN_PASSWORD.');
  const response = await fetch(`${baseUrl}/api/v1/auths/signin`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(30_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.token) throw new Error(`Falha ao autenticar no Open WebUI: ${payload.detail || response.status}.`);
  token = payload.token;
  return token;
}

async function query(testCase) {
  if (fixtureResponses) {
    const result = fixtureResponses[testCase.id];
    if (!result) throw new Error(`Resposta ausente para ${testCase.id}.`);
    return result;
  }
  if (!model) throw new Error('Configure RAG_EVAL_MODEL para executar consultas reais.');
  await authenticate();
  const started = performance.now();
  const knowledgeIds = testCase.knowledgeBaseIds || dataset.knowledgeBaseIds || [];
  const response = await fetch(`${baseUrl}${chatPath}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'user', content: testCase.question }],
      files: knowledgeIds.map(id => ({ type: 'collection', id }))
    }),
    signal: AbortSignal.timeout(Number(process.env.RAG_EVAL_TIMEOUT_MS || 180_000))
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Open WebUI respondeu HTTP ${response.status}: ${payload.detail || payload.error || 'erro'}.`);
  const result = extractChatResult(payload, Math.round(performance.now() - started));
  return { ...result, costUsd: estimateCostUsd(result, pricing) };
}

const results = [];
for (const testCase of dataset.cases) {
  try {
    const result = await query(testCase);
    results.push(evaluateCase(testCase, { ...result, costUsd: Number.isFinite(result.costUsd) ? result.costUsd : estimateCostUsd(result, pricing) }));
  }
  catch (error) { results.push(evaluateCase(testCase, { answer: '', citations: [], latencyMs: null, error: error.message })); results.at(-1).error = error.message; }
}
const summary = summarize(results);
const report = { generatedAt: new Date().toISOString(), dataset: dataset.name || path.basename(datasetPath), model: fixtureResponses ? 'fixtures' : model, summary, results };
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`Relatório: ${outputPath}`);
const minimumPassRate = Number(process.env.RAG_EVAL_MIN_PASS_RATE || dataset.minimumPassRate || 0.8);
if (summary.passRate < minimumPassRate || summary.securityFailures > 0) process.exitCode = 1;
