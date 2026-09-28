import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

export const SEMANTIC_GRAPH_SCHEMA_VERSION = '1.0';
export const DEFAULT_MAX_RELATIONS = 10_000;

const SECRET_PATH = /(^|\/)(?:\.env(?:\..*)?|secrets?|credentials?|id_rsa|\.npmrc|\.pypirc)(?:\/|$)/i;
const SECRET_LITERAL = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^\s]+|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/i;
const RELATIONS = new Set(['CALLS', 'IMPORTS', 'INHERITS', 'IMPLEMENTS', 'REFERENCES', 'USES']);
const SOURCE_FILE = /\.(?:cs|tsx?|jsx?)$/i;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function text(value, name) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${name} é obrigatório.`);
  return result;
}

function safeSourcePath(file, workspace) {
  const value = String(file ?? '').trim().replaceAll('\\', '/');
  if (!value || value.includes('\0') || !SOURCE_FILE.test(value) || SECRET_PATH.test(value)) return null;
  const resolved = path.resolve(workspace, value);
  const relative = path.relative(workspace, resolved).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || SECRET_PATH.test(relative)) return null;
  return relative;
}

function normalizeRelation(item, context) {
  const source = String(item?.source ?? '').trim();
  const target = String(item?.target ?? '').trim();
  const relation = String(item?.relation ?? '').trim().toUpperCase();
  if (!source || !target || !RELATIONS.has(relation) || SECRET_LITERAL.test(source) || SECRET_LITERAL.test(target)) return null;
  const confidence = Number(item.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  const filePath = safeSourcePath(item.file ?? item.sourceRef ?? item.filePath ?? context.file, context.workspace);
  if (!filePath) return null;
  const evidence = String(item.evidence ?? context.parser ?? 'unknown').trim().slice(0, 160) || 'unknown';
  if (SECRET_LITERAL.test(evidence)) return null;
  const identity = [context.project, filePath, source, relation, target, evidence, context.sourceHash, context.commit].join('\n');
  return Object.freeze({
    id: digest(identity), project: context.project, filePath, source, relation, target,
    confidence, evidence, parser: context.parser, sourceHash: context.sourceHash, commit: context.commit
  });
}

/**
 * Normalizes JSON emitted by Codex's Roslyn analyzer or typescript-graph.mjs.
 * This creates an offline artifact only; it does not submit data to the MCP backend.
 */
export function normalizeSemanticGraph(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('O resultado do analisador deve ser um objeto JSON.');
  const workspace = path.resolve(text(options.workspace, 'workspace'));
  const context = {
    workspace,
    project: text(options.project, 'project'),
    sourceHash: text(options.sourceHash, 'sourceHash'),
    commit: text(options.commit, 'commit'),
    parser: String(input.parser ?? (Array.isArray(input.relations) ? 'typescript-compiler-api' : 'unknown')).trim() || 'unknown',
    file: input.file
  };
  const relations = Array.isArray(input.relations) ? input.relations : [];
  const maxRelations = Number.isSafeInteger(options.maxRelations) && options.maxRelations > 0 ? options.maxRelations : DEFAULT_MAX_RELATIONS;
  if (relations.length > maxRelations) throw new Error(`O resultado contém mais de ${maxRelations} relações.`);
  const defaultFileIsSource = safeSourcePath(context.file, context.workspace) !== null;
  const hasRelationFile = relations.some(item => safeSourcePath(item?.file ?? item?.sourceRef ?? item?.filePath, context.workspace) !== null);
  if (relations.length && !defaultFileIsSource && !hasRelationFile) {
    throw new Error('O resultado agregado exige file, filePath ou sourceRef por relação; .sln e .csproj não representam arquivo de código.');
  }

  const byId = new Map();
  for (const relation of relations) {
    const normalized = normalizeRelation(relation, context);
    if (normalized) byId.set(normalized.id, normalized);
  }
  const edges = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  const chunks = Object.values(Object.groupBy(edges, edge => edge.filePath)).map(group => {
    const edgeIds = group.map(edge => edge.id).sort();
    const filePath = group[0].filePath;
    return Object.freeze({ id: digest([context.project, filePath, context.sourceHash, context.commit].join('\n')), filePath, edgeIds });
  }).sort((left, right) => left.id.localeCompare(right.id));

  return Object.freeze({
    schemaVersion: SEMANTIC_GRAPH_SCHEMA_VERSION,
    artifactType: 'semantic-graph',
    project: context.project,
    provenance: Object.freeze({ workspace, parser: context.parser, sourceHash: context.sourceHash, commit: context.commit }),
    edges,
    chunks,
    statistics: Object.freeze({ receivedRelations: relations.length, acceptedRelations: edges.length, rejectedRelations: relations.length - edges.length })
  });
}

/** Resolves an input path without following a symlink outside the chosen workspace. */
export async function assertContainedInput(file, workspace) {
  const requestedRoot = path.resolve(workspace);
  const requested = path.resolve(file);
  const lexicalRelative = path.relative(requestedRoot, requested);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw new Error('A entrada precisa estar dentro do workspace e fora de caminhos sensíveis.');
  }
  const rootInfo = await lstat(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('O workspace deve ser um diretório real, sem link simbólico.');
  for (let current = requested; current !== requestedRoot; current = path.dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('A entrada não pode possuir link simbólico em seus diretórios ancestrais.');
  }
  const info = await lstat(requested);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('A entrada deve ser um arquivo regular, não um link simbólico.');
  const root = await realpath(requestedRoot);
  const actual = await realpath(requested);
  const relative = path.relative(root, actual);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || SECRET_PATH.test(relative.replaceAll('\\', '/'))) {
    throw new Error('A entrada precisa estar dentro do workspace e fora de caminhos sensíveis.');
  }
  return { root, file: actual };
}
