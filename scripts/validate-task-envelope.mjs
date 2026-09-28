import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STATUSES = new Set(['pending', 'passed', 'failed', 'not-verified']);
const CHECK_STATUSES = new Set([...STATUSES, 'not-applicable']);
const ROLES = new Set(['implementation', 'test', 'contract', 'documentation', 'configuration']);
const COMMIT = /^[0-9a-f]{7,64}$/;

function diagnostic(errors, location, message) { errors.push(`${location}: ${message}`); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === 'string' && value.length > 0; }
function hasOnlyKeys(value, allowed, errors, location) { for (const key of Object.keys(value)) if (!allowed.has(key)) diagnostic(errors, location, `campo não permitido: ${key}`); }
function required(value, keys, errors, location) { for (const key of keys) if (!(key in value)) diagnostic(errors, location, `campo obrigatório ausente: ${key}`); }
function stringArray(value, errors, location) { if (!Array.isArray(value)) return diagnostic(errors, location, 'array esperado'); value.forEach((item, index) => { if (!nonEmpty(item)) diagnostic(errors, `${location}[${index}]`, 'texto não vazio esperado'); }); }
function uniqueIds(items, errors, location) { const ids = new Set(); items.forEach((item, index) => { if (!nonEmpty(item?.id)) return; if (ids.has(item.id)) diagnostic(errors, `${location}[${index}].id`, 'id duplicado'); ids.add(item.id); }); }
function commit(value, errors, location) { if (typeof value !== 'string' || !COMMIT.test(value)) diagnostic(errors, location, 'commit hexadecimal de 7 a 64 caracteres esperado'); }

function validateCriterion(value, errors, location, provenanceIds) {
  if (!object(value)) return diagnostic(errors, location, 'objeto esperado');
  hasOnlyKeys(value, new Set(['id', 'text', 'status', 'evidence']), errors, location); required(value, ['id', 'text', 'status'], errors, location);
  if (!nonEmpty(value.id)) diagnostic(errors, `${location}.id`, 'texto não vazio esperado');
  if (!nonEmpty(value.text)) diagnostic(errors, `${location}.text`, 'texto não vazio esperado');
  if (!STATUSES.has(value.status)) diagnostic(errors, `${location}.status`, 'status inválido');
  if (value.evidence !== undefined) { stringArray(value.evidence, errors, `${location}.evidence`); for (const reference of value.evidence) if (!provenanceIds.has(reference)) diagnostic(errors, `${location}.evidence`, `proveniência inexistente: ${reference}`); }
}

function validateEnvelope(value) {
  const errors = [];
  if (!object(value)) return { valid: false, errors: ['$: objeto raiz esperado'], warnings: [] };
  const allowed = new Set(['taskId', 'objective', 'acceptanceCriteria', 'explicitExclusions', 'baseline', 'requirements', 'dependencies', 'unknowns', 'stopConditions', 'evidenceProvenance', 'files', 'checks', 'review', 'residualRisks']);
  hasOnlyKeys(value, allowed, errors, '$'); required(value, ['taskId', 'objective', 'acceptanceCriteria', 'explicitExclusions', 'baseline', 'requirements', 'files', 'checks', 'review'], errors, '$');
  if (!nonEmpty(value.taskId)) diagnostic(errors, '$.taskId', 'texto não vazio esperado'); if (!nonEmpty(value.objective)) diagnostic(errors, '$.objective', 'texto não vazio esperado');
  stringArray(value.explicitExclusions, errors, '$.explicitExclusions'); if (value.residualRisks !== undefined) stringArray(value.residualRisks, errors, '$.residualRisks'); if (value.stopConditions !== undefined) stringArray(value.stopConditions, errors, '$.stopConditions');
  const provenanceIds = new Set();
  if (value.evidenceProvenance !== undefined) {
    if (!Array.isArray(value.evidenceProvenance)) diagnostic(errors, '$.evidenceProvenance', 'array esperado');
    else value.evidenceProvenance.forEach((item, index) => {
      const location = `$.evidenceProvenance[${index}]`; if (!object(item)) return diagnostic(errors, location, 'objeto esperado');
      hasOnlyKeys(item, new Set(['id', 'source', 'kind', 'baselineCommit', 'recordedAt', 'detail']), errors, location); required(item, ['id', 'source', 'kind'], errors, location);
      if (!nonEmpty(item.id)) diagnostic(errors, `${location}.id`, 'texto não vazio esperado'); else if (provenanceIds.has(item.id)) diagnostic(errors, `${location}.id`, 'id duplicado'); else provenanceIds.add(item.id);
      if (!nonEmpty(item.source)) diagnostic(errors, `${location}.source`, 'texto não vazio esperado'); if (!['command', 'diff', 'metric', 'review', 'trace', 'document', 'other'].includes(item.kind)) diagnostic(errors, `${location}.kind`, 'tipo inválido');
      if (item.baselineCommit !== undefined) commit(item.baselineCommit, errors, `${location}.baselineCommit`); if (item.recordedAt !== undefined && Number.isNaN(Date.parse(item.recordedAt))) diagnostic(errors, `${location}.recordedAt`, 'data ISO válida esperada'); if (item.detail !== undefined && !nonEmpty(item.detail)) diagnostic(errors, `${location}.detail`, 'texto não vazio esperado');
    });
  }
  if (!object(value.baseline)) diagnostic(errors, '$.baseline', 'objeto esperado'); else {
    hasOnlyKeys(value.baseline, new Set(['commit', 'branch', 'workingTree', 'dirtyAuthorization']), errors, '$.baseline'); required(value.baseline, ['commit', 'branch', 'workingTree'], errors, '$.baseline'); commit(value.baseline.commit, errors, '$.baseline.commit'); if (!nonEmpty(value.baseline.branch)) diagnostic(errors, '$.baseline.branch', 'texto não vazio esperado'); if (!['clean', 'dirty'].includes(value.baseline.workingTree)) diagnostic(errors, '$.baseline.workingTree', 'clean ou dirty esperado');
    if (value.baseline.dirtyAuthorization !== undefined) { const authorization = value.baseline.dirtyAuthorization; if (!object(authorization)) diagnostic(errors, '$.baseline.dirtyAuthorization', 'objeto esperado'); else { hasOnlyKeys(authorization, new Set(['authorizedBy', 'reason', 'recordedAt']), errors, '$.baseline.dirtyAuthorization'); required(authorization, ['authorizedBy', 'reason'], errors, '$.baseline.dirtyAuthorization'); if (!nonEmpty(authorization.authorizedBy)) diagnostic(errors, '$.baseline.dirtyAuthorization.authorizedBy', 'texto não vazio esperado'); if (!nonEmpty(authorization.reason)) diagnostic(errors, '$.baseline.dirtyAuthorization.reason', 'texto não vazio esperado'); } }
  }
  if (!Array.isArray(value.acceptanceCriteria) || value.acceptanceCriteria.length === 0) diagnostic(errors, '$.acceptanceCriteria', 'array não vazio esperado'); else { value.acceptanceCriteria.forEach((item, index) => validateCriterion(item, errors, `$.acceptanceCriteria[${index}]`, provenanceIds)); uniqueIds(value.acceptanceCriteria, errors, '$.acceptanceCriteria'); }
  if (!Array.isArray(value.requirements) || value.requirements.length === 0) diagnostic(errors, '$.requirements', 'array não vazio esperado'); else value.requirements.forEach((item, index) => { const location = `$.requirements[${index}]`; if (!object(item)) return diagnostic(errors, location, 'objeto esperado'); hasOnlyKeys(item, new Set(['id', 'text', 'files', 'checks', 'dependencies']), errors, location); required(item, ['id', 'text', 'files', 'checks'], errors, location); if (!nonEmpty(item.id) || !nonEmpty(item.text)) diagnostic(errors, location, 'id e text não vazios esperados'); stringArray(item.files, errors, `${location}.files`); stringArray(item.checks, errors, `${location}.checks`); if (item.dependencies !== undefined) stringArray(item.dependencies, errors, `${location}.dependencies`); });
  if (Array.isArray(value.requirements)) uniqueIds(value.requirements, errors, '$.requirements');
  if (value.dependencies !== undefined) { if (!Array.isArray(value.dependencies)) diagnostic(errors, '$.dependencies', 'array esperado'); else value.dependencies.forEach((item, index) => { const location = `$.dependencies[${index}]`; if (!object(item)) return diagnostic(errors, location, 'objeto esperado'); hasOnlyKeys(item, new Set(['id', 'text', 'status', 'owner', 'invalidationCondition']), errors, location); required(item, ['id', 'text', 'status'], errors, location); if (!nonEmpty(item.id) || !nonEmpty(item.text)) diagnostic(errors, location, 'id e text não vazios esperados'); if (!['pending', 'satisfied', 'blocked', 'invalidated'].includes(item.status)) diagnostic(errors, `${location}.status`, 'status inválido'); }); if (Array.isArray(value.dependencies)) uniqueIds(value.dependencies, errors, '$.dependencies'); }
  if (value.unknowns !== undefined) { if (!Array.isArray(value.unknowns)) diagnostic(errors, '$.unknowns', 'array esperado'); else value.unknowns.forEach((item, index) => { const location = `$.unknowns[${index}]`; if (!object(item)) return diagnostic(errors, location, 'objeto esperado'); hasOnlyKeys(item, new Set(['id', 'text', 'status', 'impact']), errors, location); required(item, ['id', 'text', 'status'], errors, location); if (!nonEmpty(item.id) || !nonEmpty(item.text)) diagnostic(errors, location, 'id e text não vazios esperados'); if (!['open', 'resolved', 'accepted'].includes(item.status)) diagnostic(errors, `${location}.status`, 'status inválido'); if (item.impact !== undefined && !['low', 'medium', 'high'].includes(item.impact)) diagnostic(errors, `${location}.impact`, 'impacto inválido'); }); if (Array.isArray(value.unknowns)) uniqueIds(value.unknowns, errors, '$.unknowns'); }
  if (!Array.isArray(value.files)) diagnostic(errors, '$.files', 'array esperado'); else value.files.forEach((item, index) => { const location = `$.files[${index}]`; if (!object(item)) return diagnostic(errors, location, 'objeto esperado'); hasOnlyKeys(item, new Set(['path', 'owner', 'role']), errors, location); required(item, ['path', 'owner', 'role'], errors, location); if (!nonEmpty(item.path) || !nonEmpty(item.owner)) diagnostic(errors, location, 'path e owner não vazios esperados'); if (!ROLES.has(item.role)) diagnostic(errors, `${location}.role`, 'role inválido'); });
  if (!Array.isArray(value.checks)) diagnostic(errors, '$.checks', 'array esperado'); else value.checks.forEach((item, index) => { const location = `$.checks[${index}]`; if (!object(item)) return diagnostic(errors, location, 'objeto esperado'); hasOnlyKeys(item, new Set(['id', 'command', 'status', 'baselineCommit', 'evidence', 'evidenceRefs']), errors, location); required(item, ['id', 'command', 'status', 'baselineCommit'], errors, location); if (!nonEmpty(item.id) || !nonEmpty(item.command)) diagnostic(errors, location, 'id e command não vazios esperados'); if (!CHECK_STATUSES.has(item.status)) diagnostic(errors, `${location}.status`, 'status inválido'); commit(item.baselineCommit, errors, `${location}.baselineCommit`); if (item.evidence !== undefined && !nonEmpty(item.evidence)) diagnostic(errors, `${location}.evidence`, 'texto não vazio esperado'); if (item.evidenceRefs !== undefined) { stringArray(item.evidenceRefs, errors, `${location}.evidenceRefs`); for (const reference of item.evidenceRefs) if (!provenanceIds.has(reference)) diagnostic(errors, `${location}.evidenceRefs`, `proveniência inexistente: ${reference}`); } });
  if (Array.isArray(value.checks)) uniqueIds(value.checks, errors, '$.checks');
  if (!object(value.review)) diagnostic(errors, '$.review', 'objeto esperado'); else { hasOnlyKeys(value.review, new Set(['status', 'baselineCommit', 'findings', 'evidenceRefs']), errors, '$.review'); required(value.review, ['status', 'baselineCommit', 'findings'], errors, '$.review'); if (!STATUSES.has(value.review.status)) diagnostic(errors, '$.review.status', 'status inválido'); commit(value.review.baselineCommit, errors, '$.review.baselineCommit'); stringArray(value.review.findings, errors, '$.review.findings'); if (value.review.evidenceRefs !== undefined) { stringArray(value.review.evidenceRefs, errors, '$.review.evidenceRefs'); for (const reference of value.review.evidenceRefs) if (!provenanceIds.has(reference)) diagnostic(errors, '$.review.evidenceRefs', `proveniência inexistente: ${reference}`); } }
  const warnings = value.baseline?.workingTree === 'dirty' && value.baseline?.dirtyAuthorization === undefined ? ['$.baseline: baseline dirty sem dirtyAuthorization explícita; permitido para envelopes legados, mas registre a autorização antes de usar como evidência de entrega.'] : [];
  return { valid: errors.length === 0, errors, warnings };
}

export async function validateTaskEnvelope(file) {
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { return { valid: false, errors: ['$: JSON malformado'], warnings: [] }; }
  return validateEnvelope(parsed);
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') return console.log('Uso: node scripts/validate-task-envelope.mjs <task-envelope.json>');
  if (argv.length !== 1 || argv[0].startsWith('-')) throw new Error('Uso: node scripts/validate-task-envelope.mjs <task-envelope.json>');
  const result = await validateTaskEnvelope(path.resolve(argv[0])); result.warnings.forEach(warning => console.warn(`AVISO ${warning}`));
  if (!result.valid) { result.errors.forEach(error => console.error(`ERRO ${error}`)); process.exitCode = 1; return; }
  console.log('Task envelope válido.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(`ERRO ${error.message}`); process.exitCode = 1; });
