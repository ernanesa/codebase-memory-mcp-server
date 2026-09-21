import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const root = path.resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);

test('Compose inclui Ollama, Docling, Open WebUI, bootstrap e worker permanente', async () => {
  const compose = await readFile(path.join(root, 'compose.yaml'), 'utf8');
  for (const service of ['ollama:', 'docling:', 'open-webui:', 'openwebui-bootstrap:']) {
    assert.match(compose, new RegExp(`^  ${service}`, 'm'));
  }
  assert.match(compose, /CONTENT_EXTRACTION_ENGINE: docling/);
  assert.match(compose, /RAG_EMBEDDING_MODEL: bge-m3/);
  assert.match(compose, /DOCLING_SERVER_URL: http:\/\/docling:5001/);
  assert.match(compose, /docling-serve-cpu:\$\{DOCLING_VERSION:-v1\.26\.0\}/);
  assert.match(compose, /DOCLING_DEVICE: cpu/);
  assert.match(compose, /DOCLING_SERVE_ENG_LOC_NUM_WORKERS: "1"/);
  assert.match(compose, /DOCLING_SERVE_ENG_LOC_SHARE_MODELS: "true"/);
  assert.match(compose, /DOCLING_NUM_THREADS: "\$\{DOCLING_CPU_THREADS:-6\}"/);
  assert.match(compose, /condition: service_healthy/);
  assert.doesNotMatch(compose, /docling-data/);
  assert.match(compose, /RAG_RERANKING_MODEL: "\$\{RAG_RERANKING_MODEL-BAAI\/bge-reranker-v2-m3\}"/);
  assert.match(compose, /RAG_TOP_K: "\$\{RAG_TOP_K:-20\}"/);
  assert.match(compose, /RAG_TOP_K_RERANKER: "\$\{RAG_TOP_K_RERANKER:-8\}"/);
  assert.match(compose, /MCP_ADMIN_URL: "http:\/\/agentgateway:\$\{UI_PORT:-8080\}\/mcp"/);
  assert.match(compose, /\.\/data\/secrets:\/run\/cbm-secrets:ro/);
  assert.match(compose, /ollama-data:/);
  assert.match(compose, /openwebui-data:/);
  assert.match(compose, /context: \.\/openwebui/);
  assert.match(compose, /image: codebase-memory-open-webui:0\.11\.0-google-drive-config/);
  assert.match(compose, /profiles: \["ollama-docker"\]/);
  assert.match(compose, /OLLAMA_BASE_URL: "\$\{OLLAMA_BASE_URL:-http:\/\/ollama:11434\}"/);
  assert.match(compose, /OLLAMA_URL: "\$\{OLLAMA_BASE_URL:-http:\/\/ollama:11434\}"/);
  assert.doesNotMatch(compose, /ollama:\s*\n\s*condition: service_healthy/);
  assert.match(compose, /^  knowledge-sync:/m);
  assert.doesNotMatch(compose, /profiles: \["google-drive"\]/);
  assert.match(compose, /KNOWLEDGE_SYNC_ENABLED: "true"/);
  assert.match(compose, /GOOGLE_APPLICATION_CREDENTIALS: \/run\/secrets\/google-drive-service-account.json/);
  assert.match(compose, /KNOWLEDGE_SYNC_URL: http:\/\/knowledge-sync:3002/);
  assert.match(compose, /^  prometheus:/m);
  assert.match(compose, /^  grafana:/m);
  assert.match(compose, /profiles: \["monitoring"\]/);
  assert.match(compose, /data\/secrets\/monitoring\.env/);
});

test('Grafana provisiona dashboard operacional e Prometheus como datasource padrão', async () => {
  const dashboard = JSON.parse(await readFile(path.join(root, 'monitoring/grafana/dashboards/codebase-memory-operation.json'), 'utf8'));
  const datasource = await readFile(path.join(root, 'monitoring/grafana/provisioning/datasources/prometheus.yaml'), 'utf8');
  const provider = await readFile(path.join(root, 'monitoring/grafana/provisioning/dashboards/codebase-memory.yaml'), 'utf8');
  assert.equal(dashboard.uid, 'codebase-memory-operation');
  assert.equal(dashboard.title, 'Codebase Memory — Operação');
  assert.equal(dashboard.editable, false);
  assert.ok(dashboard.panels.length >= 10);
  const expressions = dashboard.panels.flatMap(panel => panel.targets || []).map(target => target.expr).join('\n');
  for (const metric of ['up', 'drive_sync_runs_total', 'drive_sync_duration_seconds', 'drive_sync_files_total', 'cbm_jobs_total', 'cbm_job_duration_seconds', 'process_resident_memory_bytes']) {
    assert.match(expressions, new RegExp(metric));
  }
  assert.match(datasource, /uid: prometheus/);
  assert.match(datasource, /isDefault: true/);
  assert.match(provider, /path: \/var\/lib\/grafana\/dashboards/);
});

test('painel incorpora o dashboard do hostname público do Grafana', async () => {
  const [compose, nginx, html, browser, styles] = await Promise.all([
    readFile(path.join(root, 'compose.yaml'), 'utf8'),
    readFile(path.join(root, 'nginx/nginx.conf'), 'utf8'),
    readFile(path.join(root, 'app/public/index.html'), 'utf8'),
    readFile(path.join(root, 'app/public/app.js'), 'utf8'),
    readFile(path.join(root, 'app/public/styles.css'), 'utf8')
  ]);
  assert.match(compose, /GF_SECURITY_ALLOW_EMBEDDING: "true"/);
  assert.match(nginx, /server_name \$\{GRAFANA_PUBLIC_HOST\}[\s\S]*Content-Security-Policy "frame-ancestors \$\{ADMIN_PUBLIC_URL\}"/);
  assert.match(html, /data-view="observability"/);
  assert.match(browser, /function renderObservability\(\)/);
  assert.match(browser, /publicConfig\.grafanaUrl.*\/d\/codebase-memory-operation\/codebase-memory-operacao\?orgId=1/);
  assert.match(browser, /title="Dashboard de operação do Codebase Memory"/);
  assert.match(browser, /O Grafana mantém uma sessão própria/);
  assert.match(styles, /\.observability-frame iframe \{[^}]*width:100%/);
});

test('painel persiste operações por sete dias e navega pelo histórico paginado', async () => {
  const [browser, styles, server, history] = await Promise.all([
    readFile(path.join(root, 'app/public/app.js'), 'utf8'),
    readFile(path.join(root, 'app/public/styles.css'), 'utf8'),
    readFile(path.join(root, 'app/src/server.js'), 'utf8'),
    readFile(path.join(root, 'app/src/job-history.js'), 'utf8')
  ]);
  assert.match(server, /JOB_HISTORY_FILE = path\.join\(DATA_DIR, 'jobs\.json'\)/);
  assert.match(server, /paginateJobs\(jobs/);
  assert.match(server, /activeCount/);
  assert.match(history, /JOB_HISTORY_RETENTION_DAYS = 7/);
  assert.match(history, /Operação interrompida pela reinicialização do serviço/);
  assert.match(browser, /\/api\/jobs\?page=\$\{encodeURIComponent\(page\)\}&pageSize=/);
  assert.match(browser, /data-action="jobs-page"/);
  assert.match(browser, /Página \$\{jobsPagination\.page\} de \$\{jobsPagination\.totalPages\}/);
  assert.match(styles, /\.jobs-pagination \{/);
});

test('sincronização Git reindexa alterações sem depender de watcher', async () => {
  const [server, browser, install] = await Promise.all([
    readFile(path.join(root, 'app/src/server.js'), 'utf8'),
    readFile(path.join(root, 'app/public/app.js'), 'utf8'),
    readFile(path.join(root, 'install.sh'), 'utf8')
  ]);
  assert.match(server, /if \(job\.changed\) item\.indexPending = true/);
  assert.match(server, /if \(item\.indexPending\) \{[\s\S]*await indexRepository\(item, log\)[\s\S]*delete item\.indexPending/);
  assert.match(server, /\$\{indexed\} reindexado\(s\)/);
  assert.doesNotMatch(server, /watcher processará as alterações/);
  assert.match(browser, /reindexa automaticamente os repositórios que receberem alterações/);
  assert.doesNotMatch(install, /config set auto_watch/);
});

test('proxy é o único ponto de entrada e publica Open WebUI, admin, Grafana e MCP', async () => {
  const [compose, nginx, install] = await Promise.all([
    readFile(path.join(root, 'compose.yaml'), 'utf8'),
    readFile(path.join(root, 'nginx/nginx.conf'), 'utf8'),
    readFile(path.join(root, 'install.sh'), 'utf8')
  ]);
  assert.match(compose, /ports:\n\s+- "127\.0\.0\.1:\$\{UI_PORT:-8080\}:8080"/);
  assert.doesNotMatch(compose, /OPENWEBUI_PORT|PROMETHEUS_PORT|GRAFANA_PORT|AGENTGATEWAY_UI_PORT/);
  assert.doesNotMatch(compose, /^  graph-ui:/m);
  assert.match(compose, /open-webui:[\s\S]*?expose:\n\s+- "8080"/);
  assert.match(compose, /ADMIN_JWT_SECRET_FILE: \/data\/app\/secrets\/admin-jwt-secret/);
  assert.match(compose, /WEBUI_URL: "\$\{OPENWEBUI_PUBLIC_URL:-http:\/\/openwebui\.localhost:8080\}"/);
  assert.match(compose, /GF_SERVER_ROOT_URL: "\$\{GRAFANA_PUBLIC_URL:-http:\/\/grafana\.localhost:8080\}\/"/);
  assert.match(compose, /GF_SERVER_SERVE_FROM_SUB_PATH: "false"/);
  assert.match(compose, /GF_SECURITY_ALLOW_EMBEDDING: "true"/);
  for (const hostname of ['OPENWEBUI', 'ADMIN', 'GRAFANA', 'MCP']) {
    assert.ok(nginx.includes(`server_name \${${hostname}_PUBLIC_HOST};`));
  }
  assert.match(nginx, /set \$grafana_upstream http:\/\/grafana:3000/);
  assert.match(nginx, /proxy_pass \$grafana_upstream/);
  assert.doesNotMatch(nginx, /proxy_pass http:\/\/prometheus/);
  assert.match(nginx, /server_name \$\{OPENWEBUI_PUBLIC_HOST\}[\s\S]*proxy_pass http:\/\/open-webui:8080/);
  assert.match(nginx, /server_name \$\{ADMIN_PUBLIC_HOST\}[\s\S]*proxy_pass http:\/\/admin:3000/);
  assert.match(nginx, /server_name \$\{MCP_PUBLIC_HOST\}[\s\S]*location = \/ \{[\s\S]*proxy_pass http:\/\/agentgateway:\$\{UI_PORT\}\/mcp/);
  assert.match(nginx, /location = \/api\/auth\/login \{[\s\S]*proxy_set_header X-Forwarded-Host \$http_host/);
  assert.match(nginx, /map \$uri \$public_rate_limit_key \{/);
  assert.match(nginx, /~\^\/\(\?:_app\|static\)\/ "";/);
  assert.match(nginx, /limit_req_zone \$public_rate_limit_key zone=public_per_ip/);
  assert.doesNotMatch(nginx, /limit_req_zone \$binary_remote_addr zone=public_per_ip/);
  assert.doesNotMatch(nginx, /proxy_set_header (?:Host|X-Forwarded-Host) \$host;/);
  assert.doesNotMatch(nginx, /auth_basic|mcp-panel|listen 8081/);
  assert.match(install, /OPENWEBUI_PUBLIC_URL=%s/);
  assert.match(install, /ADMIN_PUBLIC_URL=%s/);
  assert.match(install, /GRAFANA_PUBLIC_URL=%s/);
  assert.match(install, /MCP_PUBLIC_URL=%s/);
  assert.match(install, /ask_public_urls/);
  assert.match(install, /http\.request\(mcpEndpoint,[\s\S]*headers: \{ \.\.\.options\.headers, host: publicHost \}/);
});

test('imagem derivada lê as credenciais persistentes do Picker em tempo de execução', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-openwebui-patch-'));
  try {
    const mainFile = path.join(temporaryRoot, 'main.py');
    await writeFile(mainFile, `keys = (
        'google_drive.enable',
        'onedrive.enable',
)
response = {
                'google_drive': {
                    'client_id': GOOGLE_DRIVE_CLIENT_ID,
                    'api_key': GOOGLE_DRIVE_API_KEY,
                },
}
`);
    await execFileAsync('python3', [path.join(root, 'openwebui/patch-google-drive-runtime.py'), mainFile]);
    const patched = await readFile(mainFile, 'utf8');
    assert.match(patched, /'google_drive\.client_id'/);
    assert.match(patched, /'google_drive\.api_key'/);
    assert.match(patched, /config\.get\('google_drive\.client_id'\)/);
    assert.match(patched, /config\.get\('google_drive\.api_key'\)/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('imagem derivada publica citações do Drive como links diretos e seguros', async () => {
  const [dockerfile, frontendPatch, backendPatch, knowledgeFsPatch] = await Promise.all([
    readFile(path.join(root, 'openwebui/Dockerfile'), 'utf8'),
    readFile(path.join(root, 'openwebui/patch-openwebui-citations.mjs'), 'utf8'),
    readFile(path.join(root, 'openwebui/patch-google-drive-citations.py'), 'utf8'),
    readFile(path.join(root, 'openwebui/patch-knowledge-fs.py'), 'utf8')
  ]);
  assert.match(dockerfile, /OPENWEBUI_COMMIT=f9590b8017199e56d5e953657e6498e3cef1d246/);
  assert.match(dockerfile, /FROM ghcr\.io\/open-webui\/open-webui:v0\.11\.0/);
  assert.match(dockerfile, /NODE_OPTIONS=--max-old-space-size=4096/);
  assert.match(dockerfile, /npm run build/);
  assert.doesNotMatch(dockerfile, /node_modules\/\.bin\/vite build/);
  assert.match(dockerfile, /COPY --from=citation-frontend \/src\/build \/app\/build/);
  assert.match(dockerfile, /google_drive_citations\.py/);
  assert.match(frontendPatch, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/);
  assert.match(frontendPatch, /WEBUI_API_BASE_URL/);
  assert.match(frontendPatch, /metadata\?\.name \?\? _source\?\.name \?\? id/);
  assert.match(frontendPatch, /renderização do modal/);
  assert.match(backendPatch, /get_file_citation_metadata/);
  assert.match(backendPatch, /metadata final salvo no banco vetorial/);
  assert.match(backendPatch, /get_chunk_citation_metadata/);
  assert.match(backendPatch, /display_name = chunk\.get\('name'\) or source_name/);
  assert.match(backendPatch, /tool_function_name == 'kb_exec'/);
  assert.match(backendPatch, /await get_kb_exec_citation_sources/);
  assert.match(dockerfile, /python \/tmp\/patch-knowledge-fs\.py/);
  assert.match(dockerfile, /python \/tmp\/test-knowledge-fs-patch\.py/);
  assert.match(knowledgeFsPatch, /candidate\['id'\] in ref_parts/);
  assert.match(knowledgeFsPatch, /path=.*file_id=/);
  assert.match(knowledgeFsPatch, /get_kb_exec_citation_sources/);
  assert.match(knowledgeFsPatch, /ID e caminho canônico no tree -a/);
  assert.match(knowledgeFsPatch, /unicodedata\.normalize\('NFC'/);

  const helper = path.join(root, 'openwebui/google_drive_citations.py');
  const python = `
import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('google_drive_citations', ${JSON.stringify(helper)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class File:
    def __init__(self, filename, meta):
        self.filename = filename
        self.meta = meta
cases = [
    File('Documento.txt', {'data': {'source': 'google-drive', 'original_name': 'Documento', 'source_url': 'https://docs.google.com/document/d/abc/edit'}}),
    File('Legado.txt', {'data': {'source': 'google-drive', 'source_name': 'Documento legado', 'source_url': 'https://drive.google.com/open?id=abc'}}),
    File('manual.pdf', {'data': {'source': 'manual', 'original_name': 'Falso', 'source_url': 'https://docs.google.com/document/d/abc/edit'}}),
    File('Documento.txt', {'data': {'source': 'google-drive', 'original_name': 'Documento', 'source_url': 'https://example.com/phishing'}}),
    File('API X.txt', {'data': {'source': 'web-link', 'original_name': 'API X', 'source_url': 'https://api.example.com/openapi.json'}}),
    File('Inseguro.txt', {'data': {'source': 'web-link', 'original_name': 'Inseguro', 'source_url': 'http://example.com'}}),
]
print(json.dumps([module.get_file_citation_metadata(item) for item in cases]))
`;
  const { stdout } = await execFileAsync('python3', ['-c', python]);
  assert.deepEqual(JSON.parse(stdout), [
    { name: 'Documento', source: 'https://docs.google.com/document/d/abc/edit' },
    { name: 'Documento legado', source: 'https://drive.google.com/open?id=abc' },
    { name: 'manual.pdf', source: 'manual.pdf' },
    { name: 'Documento', source: 'Documento.txt' },
    { name: 'API X', source: 'https://api.example.com/openapi.json' },
    { name: 'Inseguro', source: 'Inseguro.txt' }
  ]);
});

test('presets de exemplo selecionam o padrão e carregam parâmetros e integrações esperados', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'openwebui/bootstrap/models.json'), 'utf8'));
  assert.deepEqual(manifest.models.map(model => model.id), ['business-model-sample', 'code-model-sample']);
  assert.equal(manifest.models[0].base_model_id, 'ornith15-9b-ad:latest');
  assert.equal(manifest.models[1].base_model_id, 'qwen2.5-coder:14b-instruct-q4_0');
  for (const model of manifest.models) {
    assert.equal(model.params.num_ctx, 64000);
    assert.equal(model.params.function_calling, 'native');
  }
  assert.equal(manifest.models[0].params.temperature, 0.3);
  assert.deepEqual(manifest.models[1].meta.toolIds, ['server:mcp:mcp-admin']);
  assert.match(manifest.models[0].params.system, /fontes divergirem/);
  assert.match(manifest.models[0].params.system, /filesystem virtual e isolado/);
  assert.match(manifest.models[0].params.system, /PROTOCOLO OBRIGATÓRIO PARA LOCALIZAR ARQUIVOS/);
  assert.match(manifest.models[0].params.system, /Nunca execute grep com `\*` como primeira busca/);
  assert.match(manifest.models[0].params.system, /execute `tree -a` na raiz da KB/);
  assert.match(manifest.models[0].params.system, /não percorre subpastas/);
  assert.match(manifest.models[0].params.system, /REGRA OBRIGATÓRIA PARA CAMINHOS/);
  assert.match(manifest.models[0].params.system, /Nunca envie um caminho sem aspas/);
  assert.match(manifest.models[0].params.system, /query_knowledge_files/);
  assert.match(manifest.models[0].params.system, /Google Drive \(gerenciado\)/);
  assert.match(manifest.models[1].params.system, /acesso administrativo total/);
});

test('painel administra vínculos entre fontes e Knowledge Bases pelo BFF interno', async () => {
  const [html, browser, styles, server] = await Promise.all([
    readFile(path.join(root, 'app/public/index.html'), 'utf8'),
    readFile(path.join(root, 'app/public/app.js'), 'utf8'),
    readFile(path.join(root, 'app/public/styles.css'), 'utf8'),
    readFile(path.join(root, 'app/src/server.js'), 'utf8')
  ]);
  assert.match(html, /data-view="knowledge-sync"/);
  assert.match(browser, /Vincular fontes/);
  assert.match(browser, /data-link-url/);
  assert.match(browser, /data-link-description/);
  assert.match(browser, /add-knowledge-link/);
  assert.match(browser, /links:currentKnowledgeLinks\(\)/);
  assert.match(browser, /run-knowledge-sync/);
  assert.match(browser, /delete-knowledge-sync/);
  assert.match(browser, /drive-credentials-file/);
  assert.match(browser, /save-drive-credentials/);
  assert.match(browser, /test-drive-credentials/);
  assert.match(browser, /drive-picker-client-id/);
  assert.match(browser, /drive-picker-api-key/);
  assert.match(browser, /save-drive-picker/);
  assert.match(browser, /remove-drive-picker/);
  assert.match(browser, /\/api\/knowledge-sync\/picker-config/);
  for (const field of ['minute', 'hour', 'day', 'month', 'weekday']) assert.match(browser, new RegExp(`knowledge-sync-cron-${field}`));
  assert.match(browser, /knowledge-sync-timezone/);
  assert.doesNotMatch(browser, /knowledge-sync-interval/);
  assert.match(browser, /refreshKnowledgeSyncRows/);
  assert.doesNotMatch(browser, /setInterval\(\(\) => \{ if \(currentView === 'knowledge-sync'\) renderKnowledgeSync/);
  assert.match(styles, /knowledge-sync-identity \.workspace-icon \{[^}]*border-radius:50%/);
  assert.match(styles, /knowledge-sync-identity > div \{[^}]*min-width:0/);
  assert.match(styles, /knowledge-sync-identity small \{[^}]*overflow-wrap:anywhere/);
  assert.match(styles, /knowledge-sync-actions \{[^}]*grid-column:1 \/ -1/);
  assert.match(server, /url\.pathname\.startsWith\('\/api\/knowledge-sync'\)/);
  assert.match(server, /KNOWLEDGE_SYNC_TOKEN_FILE/);
  assert.match(server, /GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE/);
  assert.match(server, /validateGoogleServiceAccount/);
});

test('painel confirma workspace com Enter e permite indexar o workspace aberto', async () => {
  const [browser, server] = await Promise.all([
    readFile(path.join(root, 'app/public/app.js'), 'utf8'),
    readFile(path.join(root, 'app/src/server.js'), 'utf8')
  ]);
  assert.match(browser, /modal\.querySelector\('form'\)\.addEventListener\('submit'/);
  assert.match(browser, /event\.submitter\?\.value === 'cancel'/);
  assert.match(browser, /closeModal\(\);/);
  assert.match(browser, /newWorkspaceModal[\s\S]*'save-workspace'/);
  for (const action of ['save-schedule', 'save-drive-picker', 'save-drive-credentials', 'save-knowledge-sync', 'save-mcp-user', 'save-mcp-access', 'save-github', 'clone-selected']) {
    assert.match(browser, new RegExp(`openModal\\([^;]+, '${action}'\\)`), `Enter deve acionar ${action}`);
  }
  assert.match(browser, /data-enter-action="add-drive-folder-id"/);
  assert.match(browser, /data-action="index-workspace"/);
  assert.match(browser, /\/api\/workspaces\/\$\{currentWorkspace\}\/index/);
  assert.match(server, /function runWorkspaceIndex/);
  assert.match(server, /parts\[2\] === 'index'.*request\.method === 'POST'/);
});

test('instalador sugere Gemma 4, fixa Ollama 0.32.1 e bootstrap usa o contrato atual', async () => {
  const install = await readFile(path.join(root, 'install.sh'), 'utf8');
  const compose = await readFile(path.join(root, 'compose.yaml'), 'utf8');
  assert.match(install, /OLLAMA_VERSION='0\.32\.1'/);
  assert.match(install, /OLLAMA_CHAT_MODEL='gemma4:e2b'/);
  assert.match(install, /OLLAMA_CONTEXT_LENGTH='64000'/);
  assert.match(install, /DOCLING_VERSION='v1\.26\.0'/);
  assert.match(install, /DOCLING_CPU_THREADS='6'/);
  assert.match(install, /RAG_RERANKING_MODEL='BAAI\/bge-reranker-v2-m3'/);
  assert.match(install, /gemma4:e4b \(Gemma 4 Effective 4B\)/);
  assert.match(compose, /OLLAMA_VERSION:-0\.32\.1/);
  assert.match(compose, /OLLAMA_CHAT_MODEL:-gemma4:e2b/);
  assert.match(compose, /OLLAMA_CONTEXT_LENGTH:-64000/);
  assert.match(install, /ask_ollama_model/);
  assert.match(install, /ask_ollama_context_length/);
  assert.match(install, /ask_ollama_quantization/);
  assert.match(install, /ask_ollama_keep_alive/);
  assert.match(install, /ask_ollama_runtime/);
  assert.match(install, /brew" install ollama|BREW_BIN" install ollama/);
  assert.match(install, /host\.docker\.internal:11434/);
  assert.match(install, /com\.codebase-memory\.ollama\.plist/);
  assert.match(install, /codebase-memory-mcp-ui-linux-\$\{docker_arch\}-portable\.tar\.gz/);
  assert.match(install, /ask_ollama_gpu/);
  assert.match(install, /nvidia-smi --query-gpu=index,uuid,name,memory\.total/);
  assert.match(install, /nvidia-ctk runtime configure --runtime=docker/);
  assert.match(install, /native\.cgroupdriver=cgroupfs/);
  assert.match(install, /dockerd --validate --config-file=/);
  assert.match(install, /CgroupDriver/);
  assert.match(install, /CgroupVersion/);
  assert.match(install, /write_ollama_gpu_compose_override/);
  assert.match(install, /write_ollama_quantization_compose_override/);
  assert.match(install, /validate_ollama_gpu_command/);
  assert.doesNotMatch(install, /ask_google_drive_integration/);
  assert.doesNotMatch(install, /Deseja habilitar o Google Drive/);
  assert.doesNotMatch(install, /OAuth Client ID do Google/);
  assert.doesNotMatch(install, /API Key do Google Picker/);
  assert.doesNotMatch(install, /JSON da Service Account para sincronização/);
  assert.match(install, /COMPOSE_PROFILES/);
  assert.match(install, /compose_profiles='monitoring'/);
  assert.match(install, /validate_monitoring_command/);
  const gatewayDockerfile = await readFile(path.join(root, 'agentgateway/Dockerfile'), 'utf8');
  assert.match(gatewayDockerfile, /cgr\.dev\/chainguard\/git:latest@sha256:[a-f0-9]{64}/);
  assert.match(install, /restart_and_validate_knowledge_sync_command/);
  assert.match(install, /E-mail administrativo/);
  assert.match(install, /mínimo de 6 caracteres/);
  assert.match(install, /OPENWEBUI_ADMIN_NAME='Admin'/);
  assert.match(install, /OPENWEBUI_PREVIOUS_NAME.*OPENWEBUI_ADMIN_NAME/);
  assert.match(install, /docker_compose wait openwebui-bootstrap/);
  assert.match(install, /migrate_openwebui_admin_command/);
  assert.match(install, /api\/v1\/users\/\$\{user_id\}\/update/);
  assert.match(install, /Sincronizando a credencial administrativa do Open WebUI/);
  const bootstrap = await readFile(path.join(root, 'openwebui/bootstrap/bootstrap.sh'), 'utf8');
  assert.match(bootstrap, /\{model:\$model,stream:false\}/);
  assert.doesNotMatch(bootstrap, /\{name:\$model,stream:false\}/);
  assert.match(bootstrap, /configs\/tool_servers\/verify/);
  assert.match(bootstrap, /retrieval\/config\/update/);
  assert.match(bootstrap, /RAG_RERANKING_MODEL/);
  assert.match(bootstrap, /config:\{enable:true\}/);
  assert.match(bootstrap, /\.base_model_id = \$chat_model/);
  if (process.platform !== 'win32') {
    const mode = (await stat(path.join(root, 'openwebui/bootstrap/bootstrap.sh'))).mode & 0o777;
    assert.ok(mode & 0o100, 'bootstrap.sh deve ser executável');
  }
});

test('seletor do runtime usa host no macOS e Docker no Linux', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-runtime-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    const selectionFile = path.join(temporaryRoot, 'selection');
    await execFileAsync('bash', ['-c', `
      source "$1"
      SYSTEM_PLATFORM=macos
      ask_ollama_runtime <<< $'\\n'
      printf '%s\\n%s\\n%s\\n' "$OLLAMA_RUNTIME" "$OLLAMA_BASE_URL" "$OLLAMA_COMPOSE_PROFILES" >"$2"
      SYSTEM_PLATFORM=linux
      OLLAMA_RUNTIME=docker
      ask_ollama_runtime <<< $'\\n'
      printf '%s\\n%s\\n%s\\n' "$OLLAMA_RUNTIME" "$OLLAMA_BASE_URL" "$OLLAMA_COMPOSE_PROFILES" >>"$2"
    `, 'test', path.join(temporaryRoot, 'install.sh'), selectionFile]);
    assert.equal(
      await readFile(selectionFile, 'utf8'),
      'host\nhttp://host.docker.internal:11434\n\ndocker\nhttp://ollama:11434\nollama-docker\n'
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('Enter preserva o modelo Ollama já configurado na reinstalação', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-model-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await writeFile(path.join(temporaryRoot, '.env'), 'OLLAMA_CHAT_MODEL=gemma3:12b\n');
    const selectionFile = path.join(temporaryRoot, 'selection');
    await execFileAsync('bash', ['-c', `
      source "$1"
      ask_ollama_model <<< $'\\n'
      printf '%s\\n' "$OLLAMA_CHAT_MODEL" >"$2"
    `, 'test', path.join(temporaryRoot, 'install.sh'), selectionFile]);
    assert.equal(await readFile(selectionFile, 'utf8'), 'gemma3:12b\n');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('seletor do Ollama oferece Gemma 4 Effective 4B e modelo personalizado', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-model-options-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    const selectionFile = path.join(temporaryRoot, 'selection');
    await execFileAsync('bash', ['-c', `
      source "$1"
      ask_ollama_model <<< $'2\n'
      printf '%s\n' "$OLLAMA_CHAT_MODEL" >"$2"
      ask_ollama_model <<< $'3\ngemma4:12b\n'
      printf '%s\n' "$OLLAMA_CHAT_MODEL" >>"$2"
    `, 'test', path.join(temporaryRoot, 'install.sh'), selectionFile]);
    assert.equal(await readFile(selectionFile, 'utf8'), 'gemma4:e4b\ngemma4:12b\n');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('seletor de quantização usa fp16 por padrão e preserva q8_0 na reinstalação', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-quantization-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    const selectionFile = path.join(temporaryRoot, 'selection');
    await execFileAsync('bash', ['-c', `
      source "$1"
      ask_ollama_quantization <<< $'\\n'
      printf '%s\\n' "$OLLAMA_KV_CACHE_QUANTIZATION" >"$2"
      printf 'OLLAMA_KV_CACHE_QUANTIZATION=q8_0\\n' >"$(dirname "$1")/.env"
      ask_ollama_quantization <<< $'\\n'
      printf '%s\\n' "$OLLAMA_KV_CACHE_QUANTIZATION" >>"$2"
    `, 'test', path.join(temporaryRoot, 'install.sh'), selectionFile]);
    assert.equal(await readFile(selectionFile, 'utf8'), 'fp16\nq8_0\n');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('seletor de contexto usa 64000 por padrão e preserva o valor na reinstalação', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-context-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    const selectionFile = path.join(temporaryRoot, 'selection');
    await execFileAsync('bash', ['-c', `
      source "$1"
      ask_ollama_context_length <<< $'\\n'
      printf '%s\\n' "$OLLAMA_CONTEXT_LENGTH" >"$2"
      printf 'OLLAMA_CONTEXT_LENGTH=128000\\n' >"$(dirname "$1")/.env"
      ask_ollama_context_length <<< $'\\n'
      printf '%s\\n' "$OLLAMA_CONTEXT_LENGTH" >>"$2"
    `, 'test', path.join(temporaryRoot, 'install.sh'), selectionFile]);
    assert.equal(await readFile(selectionFile, 'utf8'), '64000\n128000\n');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('override persiste residência dos modelos e adiciona quantização somente em q8_0', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-quantization-compose-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await execFileAsync('bash', ['-c', `
      source "$1"
      OLLAMA_RUNTIME=docker
      OLLAMA_KV_CACHE_QUANTIZATION=q8_0
      OLLAMA_KEEP_ALIVE=-1
      write_ollama_quantization_compose_override
    `, 'test', path.join(temporaryRoot, 'install.sh')]);
    const override = await readFile(path.join(temporaryRoot, 'compose.ollama.yaml'), 'utf8');
    assert.match(override, /^services:\n  ollama:\n    environment:/);
    assert.match(override, /OLLAMA_FLASH_ATTENTION: "1"/);
    assert.match(override, /OLLAMA_KV_CACHE_TYPE: q8_0/);
    assert.match(override, /OLLAMA_KEEP_ALIVE: "-1"/);
    assert.match(override, /OLLAMA_CONTEXT_LENGTH: "64000"/);
    assert.match(override, /OLLAMA_MAX_LOADED_MODELS: "2"/);

    await execFileAsync('bash', ['-c', `
      source "$1"
      OLLAMA_RUNTIME=docker
      OLLAMA_KV_CACHE_QUANTIZATION=fp16
      OLLAMA_KEEP_ALIVE=30m
      write_ollama_quantization_compose_override
    `, 'test', path.join(temporaryRoot, 'install.sh')]);
    const fp16Override = await readFile(path.join(temporaryRoot, 'compose.ollama.yaml'), 'utf8');
    assert.match(fp16Override, /OLLAMA_KEEP_ALIVE: "30m"/);
    assert.doesNotMatch(fp16Override, /OLLAMA_MAX_LOADED_MODELS|OLLAMA_FLASH_ATTENTION|OLLAMA_KV_CACHE_TYPE/);

    const compose = await readFile(path.join(root, 'compose.yaml'), 'utf8');
    assert.doesNotMatch(compose, /OLLAMA_FLASH_ATTENTION|OLLAMA_KV_CACHE_TYPE/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('seletor de residência preserva a escolha e oferece modo dedicado', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-keep-alive-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    const selectionFile = path.join(temporaryRoot, 'selection');
    await execFileAsync('bash', ['-c', `
      source "$1"
      ask_ollama_keep_alive <<< $'1\n'
      printf '%s\n' "$OLLAMA_KEEP_ALIVE" >"$2"
      printf 'OLLAMA_KEEP_ALIVE=30m\n' >"$(dirname "$1")/.env"
      ask_ollama_keep_alive <<< $'\n'
      printf '%s\n' "$OLLAMA_KEEP_ALIVE" >>"$2"
    `, 'test', path.join(temporaryRoot, 'install.sh'), selectionFile]);
    assert.equal(await readFile(selectionFile, 'utf8'), '-1\n30m\n');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('reinstalação grava e preserva OLLAMA_VERSION no ambiente', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-version-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await writeFile(path.join(temporaryRoot, '.env'), 'OLLAMA_VERSION=0.31.2\n');
    await execFileAsync('bash', ['-c', `
      source "$1"
      CBM_MEM_BUDGET_MB=8192
      ADMIN_EMAIL=admin@example.com
      ADMIN_USERNAME=admin
      create_environment_file
    `, 'test', path.join(temporaryRoot, 'install.sh')]);
    const environment = await readFile(path.join(temporaryRoot, '.env'), 'utf8');
    assert.match(environment, /^OLLAMA_VERSION=0\.31\.2$/m);
    assert.match(environment, /^OLLAMA_CHAT_MODEL=gemma4:e2b$/m);
    assert.match(environment, /^OLLAMA_CONTEXT_LENGTH=64000$/m);
    assert.match(environment, /^OLLAMA_KV_CACHE_QUANTIZATION=fp16$/m);
    assert.match(environment, /^OLLAMA_KEEP_ALIVE=5m$/m);
    assert.match(environment, /^OLLAMA_RUNTIME=docker$/m);
    assert.match(environment, /^OLLAMA_BASE_URL=http:\/\/ollama:11434$/m);
    assert.deepEqual(
      environment.match(/^COMPOSE_FILE=(.*)$/m)[1].split(':').map((file) => path.basename(file)),
      ['compose.yaml']
    );
    assert.match(environment, /^COMPOSE_PROFILES=ollama-docker,monitoring$/m);
    assert.match(environment, /^OPENWEBUI_PUBLIC_URL=http:\/\/openwebui\.localhost:8080$/m);
    assert.match(environment, /^OPENWEBUI_PUBLIC_HOST=openwebui\.localhost$/m);
    assert.match(environment, /^ADMIN_PUBLIC_URL=http:\/\/admin\.localhost:8080$/m);
    assert.match(environment, /^GRAFANA_PUBLIC_URL=http:\/\/grafana\.localhost:8080$/m);
    assert.match(environment, /^MCP_PUBLIC_URL=http:\/\/mcp\.localhost:8080$/m);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('instalador separa as origens públicas e migra configurações legadas', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-public-url-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await writeFile(path.join(temporaryRoot, '.env'), [
      'PUBLIC_BASE_URL=https://webui.example.com',
      'GRAFANA_ROOT_URL=https://monitoring.example.com/grafana/',
      ''
    ].join('\n'));
    await execFileAsync('bash', ['-c', `
      source "$1"
      CBM_MEM_BUDGET_MB=8192
      ADMIN_EMAIL=admin@example.com
      ADMIN_USERNAME=admin@example.com
      create_environment_file
    `, 'test', path.join(temporaryRoot, 'install.sh')]);
    const environment = await readFile(path.join(temporaryRoot, '.env'), 'utf8');
    assert.match(environment, /^OPENWEBUI_PUBLIC_URL=https:\/\/webui\.example\.com$/m);
    assert.match(environment, /^OPENWEBUI_PUBLIC_HOST=webui\.example\.com$/m);
    assert.match(environment, /^GRAFANA_PUBLIC_URL=https:\/\/monitoring\.example\.com$/m);
    assert.match(environment, /^GRAFANA_PUBLIC_HOST=monitoring\.example\.com$/m);
    assert.match(environment, /^ADMIN_PUBLIC_URL=http:\/\/admin\.localhost:8080$/m);
    assert.match(environment, /^MCP_PUBLIC_URL=http:\/\/mcp\.localhost:8080$/m);
    assert.doesNotMatch(environment, /PUBLIC_BASE_URL/);
    assert.doesNotMatch(environment, /GRAFANA_ROOT_URL/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('instalador seleciona múltiplas GPUs por índice e persiste os UUIDs no override', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-gpu-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    const binaryDirectory = path.join(temporaryRoot, 'bin');
    await mkdir(binaryDirectory);
    const nvidiaSmi = path.join(binaryDirectory, 'nvidia-smi');
    await writeFile(nvidiaSmi, `#!/usr/bin/env bash
if [[ "$*" == *"--query-gpu=index,uuid,name,memory.total"* ]]; then
  printf '0, GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa, NVIDIA RTX 4090, 24564\\n'
  printf '1, GPU-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb, NVIDIA RTX 3090, 24576\\n'
else
  printf 'GPU 0: NVIDIA RTX 4090 (UUID: GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa)\\n'
fi
`);
    await chmod(nvidiaSmi, 0o755);
    const selectionFile = path.join(temporaryRoot, 'selection');
    await execFileAsync('bash', ['-c', `
      export PATH="$2:$PATH"
      source "$1"
      ask_ollama_gpu <<< $'2\\n1,0\\n'
      printf '%s\\n%s\\n' "$OLLAMA_GPU_MODE" "$OLLAMA_GPU_DEVICE_IDS" >"$3"
      write_ollama_gpu_compose_override
    `, 'test', path.join(temporaryRoot, 'install.sh'), binaryDirectory, selectionFile]);

    assert.equal(
      await readFile(selectionFile, 'utf8'),
      'selected\nGPU-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb,GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n'
    );
    const override = await readFile(path.join(temporaryRoot, 'compose.gpu.yaml'), 'utf8');
    assert.match(override, /driver: nvidia/);
    assert.match(override, /GPU-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/);
    assert.match(override, /GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/);
    assert.match(override, /capabilities: \[gpu\]/);
    assert.doesNotMatch(override, /count: all/);

    await writeFile(
      path.join(temporaryRoot, '.env'),
      'OLLAMA_GPU_MODE=selected\nOLLAMA_GPU_DEVICE_IDS=GPU-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb,GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n'
    );
    const preservedSelectionFile = path.join(temporaryRoot, 'preserved-selection');
    await execFileAsync('bash', ['-c', `
      export PATH="$2:$PATH"
      source "$1"
      ask_ollama_gpu <<< $'\\n\\n'
      printf '%s\\n%s\\n' "$OLLAMA_GPU_MODE" "$OLLAMA_GPU_DEVICE_IDS" >"$3"
    `, 'test', path.join(temporaryRoot, 'install.sh'), binaryDirectory, preservedSelectionFile]);
    assert.equal(
      await readFile(preservedSelectionFile, 'utf8'),
      'selected\nGPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,GPU-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\n'
    );

    await execFileAsync('bash', ['-c', `
      source "$1"
      OLLAMA_GPU_MODE=all
      write_ollama_gpu_compose_override
    `, 'test', path.join(temporaryRoot, 'install.sh')]);
    const allGpusOverride = await readFile(path.join(temporaryRoot, 'compose.gpu.yaml'), 'utf8');
    assert.match(allGpusOverride, /count: all/);
    assert.doesNotMatch(allGpusOverride, /device_ids:/);
    assert.match(allGpusOverride, /nvidia-smi >\/dev\/null 2>&1 && ollama list >\/dev\/null 2>&1/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('ambiente persiste os overrides do Compose usados para GPU e quantização após reinícios', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-compose-files-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await writeFile(path.join(temporaryRoot, 'compose.yaml'), 'services:\n  ollama:\n    image: ollama/ollama\n');
    await execFileAsync('bash', ['-c', `
      source "$1"
      OLLAMA_RUNTIME=docker
      OLLAMA_KV_CACHE_QUANTIZATION=q8_0
      OLLAMA_KEEP_ALIVE=-1
      OLLAMA_GPU_MODE=all
      CBM_MEM_BUDGET_MB=8192
      ADMIN_EMAIL=admin@example.com
      ADMIN_USERNAME=admin
      write_ollama_quantization_compose_override
      write_ollama_gpu_compose_override
      create_environment_file
    `, 'test', path.join(temporaryRoot, 'install.sh')]);

    const environment = await readFile(path.join(temporaryRoot, '.env'), 'utf8');
    assert.deepEqual(
      environment.match(/^COMPOSE_FILE=(.*)$/m)[1].split(':').map((file) => path.basename(file)),
      ['compose.yaml', 'compose.ollama.yaml', 'compose.gpu.yaml']
    );
    assert.match(environment, /^OLLAMA_KEEP_ALIVE=-1$/m);
    const ollamaOverride = await readFile(path.join(temporaryRoot, 'compose.ollama.yaml'), 'utf8');
    assert.match(ollamaOverride, /OLLAMA_KEEP_ALIVE: "-1"/);
    assert.match(ollamaOverride, /OLLAMA_MAX_LOADED_MODELS: "2"/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('modo CPU remove o override de GPU do Ollama', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-cpu-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await writeFile(path.join(temporaryRoot, 'compose.gpu.yaml'), 'configuração anterior');
    await execFileAsync('bash', ['-c', `
      source "$1"
      OLLAMA_GPU_MODE=cpu
      write_ollama_gpu_compose_override
    `, 'test', path.join(temporaryRoot, 'install.sh')]);
    await assert.rejects(readFile(path.join(temporaryRoot, 'compose.gpu.yaml')), { code: 'ENOENT' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('modo host usa Metal, remove override NVIDIA e persiste a URL do macOS', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-host-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await writeFile(path.join(temporaryRoot, 'compose.gpu.yaml'), 'configuração anterior');
    await execFileAsync('bash', ['-c', `
      source "$1"
      SYSTEM_PLATFORM=macos
      SYSTEM_ARCHITECTURE=arm64
      OLLAMA_RUNTIME=host
      OLLAMA_BASE_URL=http://host.docker.internal:11434
      OLLAMA_COMPOSE_PROFILES=
      CBM_CONTAINER_BIN="$2"
      CBM_MEM_BUDGET_MB=8192
      ADMIN_EMAIL=admin@example.com
      ADMIN_USERNAME=admin@example.com
      ask_ollama_gpu
      write_ollama_gpu_compose_override
      create_environment_file
    `, 'test', path.join(temporaryRoot, 'install.sh'), path.join(temporaryRoot, 'data/bin/codebase-memory-mcp')]);

    await assert.rejects(readFile(path.join(temporaryRoot, 'compose.gpu.yaml')), { code: 'ENOENT' });
    const environment = await readFile(path.join(temporaryRoot, '.env'), 'utf8');
    assert.match(environment, /^CBM_HOST_BIN=.*\/data\/bin\/codebase-memory-mcp$/m);
    assert.match(environment, /^OLLAMA_RUNTIME=host$/m);
    assert.match(environment, /^OLLAMA_BASE_URL=http:\/\/host\.docker\.internal:11434$/m);
    assert.match(environment, /^COMPOSE_PROFILES=monitoring$/m);
    assert.match(environment, /^OLLAMA_GPU_MODE=metal$/m);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('modo host registra um LaunchAgent persistente para o Ollama', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-ollama-launch-agent-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    const binaryDirectory = path.join(temporaryRoot, 'bin');
    await mkdir(binaryDirectory);
    for (const command of ['launchctl', 'osascript', 'plutil']) {
      const executable = path.join(binaryDirectory, command);
      await writeFile(executable, '#!/usr/bin/env bash\nexit 0\n');
      await chmod(executable, 0o755);
    }

    await execFileAsync('bash', ['-c', `
      export HOME="$2"
      export PATH="$3:$PATH"
      source "$1"
      OLLAMA_BIN=/usr/bin/true
      OLLAMA_KV_CACHE_QUANTIZATION=q8_0
      OLLAMA_KEEP_ALIVE=-1
      configure_host_ollama_command
    `, 'test', path.join(temporaryRoot, 'install.sh'), temporaryRoot, binaryDirectory]);

    const launchAgent = await readFile(
      path.join(temporaryRoot, 'Library/LaunchAgents/com.codebase-memory.ollama.plist'),
      'utf8'
    );
    assert.match(launchAgent, /<string>com\.codebase-memory\.ollama<\/string>/);
    assert.match(launchAgent, /<string>\/usr\/bin\/true<\/string>/);
    assert.match(launchAgent, /<key>OLLAMA_HOST<\/key>\s*<string>0\.0\.0\.0:11434<\/string>/);
    assert.match(launchAgent, /<key>OLLAMA_FLASH_ATTENTION<\/key>\s*<string>1<\/string>/);
    assert.match(launchAgent, /<key>OLLAMA_KV_CACHE_TYPE<\/key>\s*<string>q8_0<\/string>/);
    assert.match(launchAgent, /<key>OLLAMA_KEEP_ALIVE<\/key>\s*<string>-1<\/string>/);
    assert.match(launchAgent, /<key>OLLAMA_CONTEXT_LENGTH<\/key>\s*<string>64000<\/string>/);
    assert.match(launchAgent, /<key>OLLAMA_MAX_LOADED_MODELS<\/key>\s*<string>2<\/string>/);
    assert.match(launchAgent, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(launchAgent, /<key>KeepAlive<\/key>\s*<true\/>/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('instalador cria e protege somente o token interno do worker', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-knowledge-sync-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await execFileAsync('bash', ['-c', `
      source "$1"
      create_local_structure
      configure_google_drive_sync
    `, 'test', path.join(temporaryRoot, 'install.sh')]);

    const token = path.join(temporaryRoot, 'data/secrets/knowledge-sync/knowledge-sync-token');
    assert.match(await readFile(token, 'utf8'), /^[a-f0-9]{64}\n$/);
    if (process.platform !== 'win32') {
      assert.equal((await stat(token)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('instalador protege a credencial do Grafana e reutiliza o acesso administrativo', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-monitoring-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await execFileAsync('bash', ['-c', `
      source "$1"
      create_local_structure
      ADMIN_USERNAME=admin
      ADMIN_EMAIL=admin@example.com
      ADMIN_PASSWORD=senha-monitoramento
      OPENWEBUI_DESIRED_PASSWORD=senha-monitoramento
      create_proxy_credentials
    `, 'test', path.join(temporaryRoot, 'install.sh')]);

    const monitoringEnv = path.join(temporaryRoot, 'data/secrets/monitoring.env');
    assert.equal(
      await readFile(monitoringEnv, 'utf8'),
      'GF_SECURITY_ADMIN_USER=admin@example.com\nGF_SECURITY_ADMIN_PASSWORD=senha-monitoramento\nGF_SECURITY_ADMIN_EMAIL=admin@example.com\n'
    );
    if (process.platform !== 'win32') assert.equal((await stat(monitoringEnv)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(path.join(temporaryRoot, 'data/secrets/admin.env'), 'utf8'),
      'ADMIN_AUTH_USERNAME=admin@example.com\nADMIN_AUTH_PASSWORD=senha-monitoramento\n'
    );
    const firstJwtSecret = await readFile(path.join(temporaryRoot, 'data/secrets/admin-jwt-secret'), 'utf8');
    assert.match(firstJwtSecret, /^[a-f0-9]{64}\n$/);
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(temporaryRoot, 'data/secrets/admin.env'))).mode & 0o777, 0o600);
      assert.equal((await stat(path.join(temporaryRoot, 'data/secrets/admin-jwt-secret'))).mode & 0o777, 0o600);
    }
    await execFileAsync('bash', ['-c', `
      source "$1"
      ADMIN_USERNAME=outro-admin
      ADMIN_EMAIL=outro@example.com
      ADMIN_PASSWORD=senha-nova
      OPENWEBUI_DESIRED_PASSWORD=senha-nova
      create_proxy_credentials
    `, 'test', path.join(temporaryRoot, 'install.sh')]);
    assert.equal(
      await readFile(monitoringEnv, 'utf8'),
      'GF_SECURITY_ADMIN_USER=admin@example.com\nGF_SECURITY_ADMIN_PASSWORD=senha-monitoramento\nGF_SECURITY_ADMIN_EMAIL=admin@example.com\n'
    );
    assert.notEqual(await readFile(path.join(temporaryRoot, 'data/secrets/admin-jwt-secret'), 'utf8'), firstJwtSecret);
    assert.equal(
      await readFile(path.join(temporaryRoot, 'data/secrets/admin.env'), 'utf8'),
      'ADMIN_AUTH_USERNAME=outro@example.com\nADMIN_AUTH_PASSWORD=senha-nova\n'
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('reinstalação migra segredos legados do worker para o subdiretório isolado', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-knowledge-sync-migration-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await mkdir(path.join(temporaryRoot, 'data/secrets'), { recursive: true });
    const legacyToken = `${'a'.repeat(64)}\n`;
    const legacyCredentials = JSON.stringify({
      type: 'service_account',
      client_email: 'sync@example.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n'
    });
    await writeFile(path.join(temporaryRoot, 'data/secrets/knowledge-sync-token'), legacyToken);
    await writeFile(path.join(temporaryRoot, 'data/secrets/google-drive-service-account.json'), legacyCredentials);

    await execFileAsync('bash', ['-c', `
      source "$1"
      create_local_structure
      configure_google_drive_sync
    `, 'test', path.join(temporaryRoot, 'install.sh')]);

    const isolated = path.join(temporaryRoot, 'data/secrets/knowledge-sync');
    assert.equal(await readFile(path.join(isolated, 'knowledge-sync-token'), 'utf8'), legacyToken);
    assert.equal(await readFile(path.join(isolated, 'google-drive-service-account.json'), 'utf8'), legacyCredentials);
    await assert.rejects(readFile(path.join(temporaryRoot, 'data/secrets/knowledge-sync-token')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(temporaryRoot, 'data/secrets/google-drive-service-account.json')), { code: 'ENOENT' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('reinstalação migra o administrador existente do Open WebUI sem recriar o volume', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = raw ? JSON.parse(raw) : {};
    requests.push({ url: request.url, authorization: request.headers.authorization, payload });

    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v1/auths/signin') {
      response.end(JSON.stringify({ id: 'admin-id', token: 'session-token' }));
      return;
    }
    if (request.url === '/api/v1/users/admin-id/update') {
      response.end(JSON.stringify({ email: 'novo@example.com', name: 'Admin', role: 'admin' }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-openwebui-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await mkdir(path.join(temporaryRoot, 'data/secrets'), { recursive: true });
    await writeFile(path.join(temporaryRoot, '.env'), `UI_PORT=${server.address().port}\n`);
    await writeFile(
      path.join(temporaryRoot, 'data/secrets/openwebui.env'),
      'CUSTOM_OPENWEBUI_SETTING=preservar\nWEBUI_ADMIN_EMAIL=joao@exemplo.com\nWEBUI_ADMIN_PASSWORD=senha-antiga\nWEBUI_ADMIN_NAME=joao@exemplo.com\nWEBUI_SECRET_KEY=segredo-preservado\nENABLE_GOOGLE_DRIVE_INTEGRATION=true\nGOOGLE_DRIVE_CLIENT_ID=cliente.apps.googleusercontent.com\nGOOGLE_DRIVE_API_KEY=api-key-preservada\n'
    );

    await execFileAsync('bash', ['-c', `
      source "$1"
      ADMIN_EMAIL="$TEST_NEW_EMAIL"
      OPENWEBUI_PREVIOUS_EMAIL="$TEST_OLD_EMAIL"
      OPENWEBUI_PREVIOUS_PASSWORD="$TEST_OLD_PASSWORD"
      OPENWEBUI_DESIRED_PASSWORD="$TEST_NEW_PASSWORD"
      ENABLE_GOOGLE_DRIVE_INTEGRATION=true
      GOOGLE_DRIVE_CLIENT_ID=cliente.apps.googleusercontent.com
      GOOGLE_DRIVE_API_KEY=api-key-preservada
      migrate_openwebui_admin_command
    `, 'test', path.join(temporaryRoot, 'install.sh')], {
      env: {
        ...process.env,
        TEST_NEW_EMAIL: 'novo@example.com',
        TEST_OLD_EMAIL: 'joao@exemplo.com',
        TEST_OLD_PASSWORD: 'senha-antiga',
        TEST_NEW_PASSWORD: 'senha-nova'
      }
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], {
      url: '/api/v1/auths/signin',
      authorization: undefined,
      payload: { email: 'joao@exemplo.com', password: 'senha-antiga' }
    });
    assert.deepEqual(requests[1], {
      url: '/api/v1/users/admin-id/update',
      authorization: 'Bearer session-token',
      payload: {
        email: 'novo@example.com',
        name: 'Admin',
        password: 'senha-nova'
      }
    });
    assert.equal(
      await readFile(path.join(temporaryRoot, 'data/secrets/openwebui.env'), 'utf8'),
      'CUSTOM_OPENWEBUI_SETTING=preservar\nENABLE_GOOGLE_DRIVE_INTEGRATION=true\nGOOGLE_DRIVE_CLIENT_ID=cliente.apps.googleusercontent.com\nGOOGLE_DRIVE_API_KEY=api-key-preservada\nWEBUI_ADMIN_EMAIL=novo@example.com\nWEBUI_ADMIN_PASSWORD=senha-nova\nWEBUI_ADMIN_NAME=Admin\nWEBUI_SECRET_KEY=segredo-preservado\n'
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('reinstalação sincroniza usuário e senha do administrador persistido no Grafana', async () => {
  const requests = [];
  let currentUser = {
    id: 1,
    email: 'admin@localhost',
    name: 'Admin',
    login: 'admin',
    theme: 'dark',
    isGrafanaAdmin: true
  };
  let currentPassword = 'senha-antiga';
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = raw ? JSON.parse(raw) : {};
    const authorization = request.headers.authorization;
    requests.push({ method: request.method, url: request.url, host: request.headers.host, authorization, payload });
    response.setHeader('content-type', 'application/json');

    const expectedAuthorization = `Basic ${Buffer.from(`${currentUser.login}:${currentPassword}`).toString('base64')}`;
    if (authorization !== expectedAuthorization) {
      response.statusCode = 401;
      response.end('{"message":"Unauthorized"}');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/user') {
      response.end(JSON.stringify(currentUser));
      return;
    }
    if (request.method === 'PUT' && request.url === '/api/admin/users/1/password') {
      currentPassword = payload.password;
      response.end('{"message":"User password updated"}');
      return;
    }
    if (request.method === 'PUT' && request.url === '/api/users/1') {
      currentUser = { ...currentUser, ...payload };
      response.end('{"message":"User updated"}');
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-grafana-install-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await mkdir(path.join(temporaryRoot, 'data/secrets'), { recursive: true });
    await writeFile(
      path.join(temporaryRoot, '.env'),
      `UI_PORT=${server.address().port}\nGRAFANA_PUBLIC_HOST=grafana.example.com\n`
    );
    await writeFile(
      path.join(temporaryRoot, 'data/secrets/monitoring.env'),
      'GF_SECURITY_ADMIN_USER=admin\nGF_SECURITY_ADMIN_PASSWORD=senha-antiga\n'
    );

    await execFileAsync('bash', ['-c', `
      source "$1"
      ADMIN_EMAIL="$TEST_NEW_EMAIL"
      OPENWEBUI_DESIRED_PASSWORD="$TEST_NEW_PASSWORD"
      sync_grafana_admin_command
    `, 'test', path.join(temporaryRoot, 'install.sh')], {
      env: {
        ...process.env,
        TEST_NEW_EMAIL: 'novo@example.com',
        TEST_NEW_PASSWORD: 'senha-nova'
      }
    });

    assert.deepEqual(requests.map(({ method, url, host }) => ({ method, url, host })), [
      { method: 'GET', url: '/api/user', host: 'grafana.example.com' },
      { method: 'PUT', url: '/api/admin/users/1/password', host: 'grafana.example.com' },
      { method: 'PUT', url: '/api/users/1', host: 'grafana.example.com' },
      { method: 'GET', url: '/api/user', host: 'grafana.example.com' }
    ]);
    assert.deepEqual(requests[1].payload, { password: 'senha-nova' });
    assert.deepEqual(requests[2].payload, {
      email: 'novo@example.com',
      name: 'Admin',
      login: 'novo@example.com',
      theme: 'dark'
    });
    assert.equal(
      await readFile(path.join(temporaryRoot, 'data/secrets/monitoring.env'), 'utf8'),
      'GF_SECURITY_ADMIN_USER=novo@example.com\nGF_SECURITY_ADMIN_PASSWORD=senha-nova\nGF_SECURITY_ADMIN_EMAIL=novo@example.com\n'
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('reinstalação preserva configuração legada do Picker sem gerenciá-la no instalador', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cbm-openwebui-gdrive-'));
  try {
    await copyFile(path.join(root, 'install.sh'), path.join(temporaryRoot, 'install.sh'));
    await mkdir(path.join(temporaryRoot, 'data/secrets'), { recursive: true });
    await writeFile(
      path.join(temporaryRoot, 'data/secrets/openwebui.env'),
      'CUSTOM_OPENWEBUI_SETTING=preservar\nENABLE_GOOGLE_DRIVE_INTEGRATION=true\nGOOGLE_DRIVE_CLIENT_ID=cliente-antigo.apps.googleusercontent.com\nGOOGLE_DRIVE_API_KEY=api-key-antiga\n'
    );

    await execFileAsync('bash', ['-c', `
      source "$1"
      write_openwebui_environment admin@example.com senha-secreta Admin webui-secret
    `, 'test', path.join(temporaryRoot, 'install.sh')]);

    assert.equal(
      await readFile(path.join(temporaryRoot, 'data/secrets/openwebui.env'), 'utf8'),
      'CUSTOM_OPENWEBUI_SETTING=preservar\nENABLE_GOOGLE_DRIVE_INTEGRATION=true\nGOOGLE_DRIVE_CLIENT_ID=cliente-antigo.apps.googleusercontent.com\nGOOGLE_DRIVE_API_KEY=api-key-antiga\nWEBUI_ADMIN_EMAIL=admin@example.com\nWEBUI_ADMIN_PASSWORD=senha-secreta\nWEBUI_ADMIN_NAME=Admin\nWEBUI_SECRET_KEY=webui-secret\n'
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
