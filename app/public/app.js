const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const content = $('#content');
const modal = $('#modal');
let grafanaDashboardUrl = '';
let currentView = 'workspaces';
let currentWorkspace = null;
let jobs = [];
let jobsPagination = { page: 1, pageSize: 10, total: 0, totalPages: 1 };
let selectedRepositories = new Set();
let selectedMcpRepositories = new Set();
let mcpAccessOptions = [];
let currentMcpUsers = [];
let knowledgeSyncTargets = [];
let knowledgeSyncFolders = [];
let selectedDriveFolders = new Map();
let knowledgeSyncDriveConfigured = false;
let knowledgeSyncPickerConfig = null;
let knowledgeSyncRefreshInFlight = false;
let knowledgeSyncDefaultTimezone = 'America/Maceio';
let publicConfig = {};

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]);
const date = value => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle:'short', timeStyle:'short' }).format(new Date(value)) : '—';

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type':'application/json', ...options.headers } });
  if (response.status === 401) {
    location.assign('/login');
    throw new Error('Sua sessão expirou. Entre novamente.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Não foi possível concluir a operação.');
  return payload;
}

function toast(message, type = '') {
  const node = document.createElement('div'); node.className = `toast ${type}`; node.textContent = message; $('#toasts').append(node); setTimeout(() => node.remove(), 4500);
}

function openModal(html, submitAction = '') {
  $('#modal-content').innerHTML = html;
  modal.dataset.submitAction = submitAction;
  modal.showModal();
}
function closeModal() { modal.close(); }
function setHeader(title, breadcrumb = 'Administração', actions = '') { $('#page-title').textContent = title; $('#breadcrumb').textContent = breadcrumb; $('#header-actions').innerHTML = actions; }
function setNavigation(view) { $$('[data-view]').forEach(item => item.classList.toggle('active', item.dataset.view === view)); }
modal.addEventListener('close', () => {
  if (modal.open) return;
  delete modal.dataset.submitAction;
  $('#modal-content').replaceChildren();
});
modal.querySelector('form').addEventListener('submit', event => {
  if (event.submitter?.value === 'cancel') {
    event.preventDefault();
    closeModal();
    return;
  }
  const action = document.activeElement?.dataset.enterAction || modal.dataset.submitAction;
  if (!action) return;
  event.preventDefault();
  const submitButton = $(`[data-action="${action}"]`, modal);
  if (submitButton && !submitButton.disabled) submitButton.click();
});

async function renderGithub() {
  const connection = await api('/api/github/connection');
  $('#github-card').innerHTML = connection.connected ? `<div class="github-user"><img src="${escapeHtml(connection.user.avatarUrl)}" alt=""><div><strong>${escapeHtml(connection.user.name || connection.user.login)}</strong><small>@${escapeHtml(connection.user.login)}</small></div><button class="button small" data-action="disconnect-github">Sair</button></div>` : `<p>Conecte o GitHub para localizar e clonar seus repositórios.</p><button class="button small" data-action="connect-github">Conectar GitHub</button>`;
  return connection;
}

async function renderWorkspaces() {
  currentView = 'workspaces'; currentWorkspace = null;
  setNavigation('workspaces');
  setHeader('Workspaces', 'Administração', '<button class="button primary" data-action="new-workspace">＋ Novo workspace</button>');
  const { workspaces } = await api('/api/workspaces');
  content.innerHTML = workspaces.length ? `<div class="toolbar"><span class="subtle">${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} configurado${workspaces.length === 1 ? '' : 's'}</span></div><div class="grid">${workspaces.map(item => `<article class="card workspace-card" data-workspace="${item.id}"><div class="card-head"><span class="workspace-icon">⌘</span><span class="badge">${item.repositoryCount} repo${item.repositoryCount === 1 ? '' : 's'}</span></div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description || 'Sem descrição')}</p><div class="schedule-summary ${item.updateSchedule.enabled ? '' : 'disabled'}"><strong>${item.updateSchedule.enabled ? escapeHtml(item.updateSchedule.description) : 'Atualização automática desativada'}</strong>${item.updateSchedule.enabled && item.updateSchedule.nextRunAt ? `<small>Próxima: ${date(item.updateSchedule.nextRunAt)}</small>` : ''}</div><div class="card-meta"><span>Criado em ${date(item.createdAt)}</span><span>Ver →</span></div></article>`).join('')}</div>` : `<div class="empty"><div><div class="empty-icon">⌘</div><h2>Organize seus repositórios em workspaces</h2><p>Crie um workspace para agrupar projetos relacionados e iniciar clones e indexações.</p><button class="button primary" data-action="new-workspace">Criar primeiro workspace</button></div></div>`;
}

function repositoryRow(repo) {
  const visibleStatus = repo.syncStatus === 'syncing' ? 'syncing' : repo.syncStatus === 'error' ? 'sync-error' : repo.status;
  return `
    <article class="repo-row">
      <div class="repo-title">
        <span class="icon">◇</span>
        <div class="repo-identity">
          <strong>${escapeHtml(repo.fullName)}</strong>
          <small>${escapeHtml(repo.description || 'Sem descrição')}</small>
          ${repo.project ? `<span class="project-id" title="Identificador usado nas chamadas MCP">ID MCP: <code>${escapeHtml(repo.project)}</code></span>` : ''}
          ${repo.language ? `<span class="language-badge">${escapeHtml(repo.language)}</span>` : ''}
        </div>
      </div>

      <div class="git-reference" aria-label="Branch e commit">
        <small>Branch / commit</small>
        <div>
          <strong><span aria-hidden="true">⑂</span> ${escapeHtml(repo.defaultBranch || '—')}</strong>
          <span class="git-separator">·</span>
          <code>${escapeHtml(repo.commit || 'sem commit')}</code>
        </div>
      </div>

      <div class="repo-status">
        <small>Status</small>
        <span class="status ${escapeHtml(visibleStatus)}" ${repo.syncError ? `title="${escapeHtml(repo.syncError)}"` : ''}>${escapeHtml(visibleStatus)}</span>
      </div>

      <div class="repo-actions">
        <button class="button small" data-action="sync" data-repo="${repo.id}">Sincronizar</button>
        <button class="button small" data-action="index" data-repo="${repo.id}">Indexar</button>
        <button class="button small danger" data-action="delete-repo" data-repo="${repo.id}" data-name="${escapeHtml(repo.fullName)}">Excluir</button>
      </div>
    </article>`;
}

async function renderWorkspace(id) {
  currentView = 'workspace'; currentWorkspace = id;
  setNavigation('workspaces');
  const { workspace, repositories } = await api(`/api/workspaces/${id}`);
  setHeader(workspace.name, 'Workspaces / Detalhes', '<button class="button" data-action="delete-workspace">Excluir workspace</button> <button class="button" data-action="index-workspace">Indexar tudo</button> <button class="button primary" data-action="add-repositories">＋ Adicionar repositórios</button>');
  const schedule = workspace.updateSchedule;
  const mcpAccess = workspace.mcpAccess || {};
  const mcpActive = mcpAccess.status === 'active';
  const mcpCard = `<section class="card schedule-card"><div><div class="schedule-title"><h2>Token MCP do workspace</h2><span class="status ${mcpActive ? 'active' : 'revoked'}">${mcpActive ? 'Ativo' : 'Revogado'}</span></div><p>Esta credencial acompanha automaticamente todos os repositórios adicionados ou removidos deste workspace.</p><div class="schedule-details"><span><small>Token</small><code>${escapeHtml(mcpAccess.keyPrefix || 'não provisionado')}</code></span><span><small>Gerado em</small><strong>${date(mcpAccess.tokenCreatedAt)}</strong></span></div></div><div class="schedule-actions"><div class="repo-actions">${mcpActive ? `<button class="button small" data-action="reveal-workspace-token">Exibir token</button><button class="button small" data-action="rotate-workspace-token">Gerar novo token</button><button class="button small danger" data-action="revoke-workspace-token">Revogar</button>` : `<button class="button small primary" data-action="reactivate-workspace-token">Reativar</button>`}</div></div></section>`;
  const scheduleCard = `<section class="card schedule-card"><div><div class="schedule-title"><h2>Atualização automática</h2><span class="status ${schedule.enabled ? 'active' : 'revoked'}">${schedule.enabled ? 'Ativada' : 'Desativada'}</span></div><p class="schedule-description">${escapeHtml(schedule.description)}</p><p>Executa <code>git pull</code> e reindexa automaticamente os repositórios que receberem alterações.</p><div class="schedule-details"><span><small>Expressão cron</small><code>${escapeHtml(schedule.cron)}</code></span><span><small>Fuso</small><strong>${escapeHtml(schedule.timezone)}</strong></span><span><small>Próxima execução</small><strong>${date(schedule.nextRunAt)}</strong></span><span><small>Última execução</small><strong>${date(schedule.lastRunAt)}${schedule.lastRunStatus ? ` · ${escapeHtml(schedule.lastRunStatus)}` : ''}</strong></span></div></div><div class="schedule-actions"><label class="switch-control" data-action="toggle-schedule" data-enabled="${schedule.enabled}" title="${schedule.enabled ? 'Desativar rotina' : 'Ativar rotina'}"><input type="checkbox" ${schedule.enabled ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span><span>${schedule.enabled ? 'Ativada' : 'Desativada'}</span></label><div class="repo-actions"><button class="button small" data-action="run-workspace-sync">Executar agora</button><button class="button small" data-action="edit-schedule">Editar cron</button></div></div></section>`;
  content.innerHTML = `<div class="toolbar"><button class="button small" data-action="back">← Voltar</button><span class="subtle">${repositories.length} repositório${repositories.length === 1 ? '' : 's'}</span></div>${mcpCard}${scheduleCard}${repositories.length ? `<div class="repo-list">${repositories.map(repositoryRow).join('')}</div>` : `<div class="empty" style="margin-top:18px"><div><div class="empty-icon">◇</div><h2>Nenhum repositório neste workspace</h2><p>Selecione repositórios disponíveis na sua conta do GitHub e eles serão clonados automaticamente.</p><button class="button primary" data-action="add-repositories">Adicionar repositórios</button></div></div>`}`;
}

function editScheduleModal(schedule) {
  const [minute, hour, day, month, weekday] = schedule.cron.split(' ');
  openModal(`<h2 class="modal-title">Atualização automática</h2><p class="modal-copy">Configure os cinco campos do cron separadamente. Use <code>*</code> para qualquer valor, vírgula para listas e <code>*/n</code> para intervalos.</p><div class="cron-fields"><div class="field"><label for="schedule-minute">Minuto</label><input id="schedule-minute" value="${escapeHtml(minute)}" placeholder="0"><small>0–59</small></div><div class="field"><label for="schedule-hour">Hora</label><input id="schedule-hour" value="${escapeHtml(hour)}" placeholder="*"><small>0–23</small></div><div class="field"><label for="schedule-day">Dia do mês</label><input id="schedule-day" value="${escapeHtml(day)}" placeholder="*"><small>1–31</small></div><div class="field"><label for="schedule-month">Mês</label><input id="schedule-month" value="${escapeHtml(month)}" placeholder="*"><small>1–12</small></div><div class="field"><label for="schedule-weekday">Dia da semana</label><input id="schedule-weekday" value="${escapeHtml(weekday)}" placeholder="*"><small>0–7, domingo</small></div></div><div class="cron-preview"><small>Configuração atual</small><strong>${escapeHtml(schedule.description)}</strong><code>${escapeHtml(schedule.cron)}</code></div><div class="field"><label for="schedule-timezone">Fuso horário</label><input id="schedule-timezone" value="${escapeHtml(schedule.timezone)}" placeholder="America/Maceio"></div><label class="switch-control switch-modal"><input id="schedule-enabled" type="checkbox" ${schedule.enabled ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span><span>Rotina ativada</span></label><div class="modal-actions"><button class="button" value="cancel">Cancelar</button><button class="button primary" type="button" data-action="save-schedule">Salvar</button></div>`, 'save-schedule');
}

function syncStatusLabel(target) {
  if (target?.running) return 'Sincronizando';
  if (target?.lastRunStatus === 'failed') return 'Falhou';
  if (target?.lastRunStatus === 'partial') return 'Atenção';
  if (!target?.enabled) return 'Pausada';
  if (target?.lastRunStatus === 'completed') return 'Ativa';
  return target ? 'Aguardando' : 'Sem vínculo';
}

function knowledgeSyncStats(target) {
  const status = syncStatusLabel(target);
  const statusClass = target?.running ? 'running' : ['failed', 'partial'].includes(target?.lastRunStatus) ? 'failed' : target?.enabled ? 'active' : 'revoked';
  return `<small>Sincronização</small><span class="status ${statusClass}">${status}</span>${target ? `<span>${target.managedFileCount} arquivo${target.managedFileCount === 1 ? '' : 's'}${target.failedFileCount ? ` · ${target.failedFileCount} com falha` : ''} · ${escapeHtml(target.scheduleDescription)}</span><span>Próxima: ${date(target.nextRunAt)}</span><span>Última: ${date(target.lastRunAt)}</span>` : '<span>Configure para iniciar</span>'}${target?.lastError ? `<span class="sync-error" title="${escapeHtml(target.lastError)}">${escapeHtml(target.lastError)}</span>` : ''}`;
}

function knowledgeSyncActions(knowledgeBase, target, driveConfigured) {
  return `${target ? `<button class="button small" data-action="run-knowledge-sync" data-kb="${escapeHtml(knowledgeBase.id)}" ${target.running || !driveConfigured ? 'disabled' : ''}>Sincronizar agora</button><button class="button small" data-action="knowledge-sync-files" data-kb="${escapeHtml(knowledgeBase.id)}">Arquivos</button><button class="button small" data-action="toggle-knowledge-sync" data-kb="${escapeHtml(knowledgeBase.id)}" ${driveConfigured ? '' : 'disabled'}>${target.enabled ? 'Pausar' : 'Ativar'}</button><button class="button small" data-action="knowledge-sync-history" data-kb="${escapeHtml(knowledgeBase.id)}">Histórico</button><button class="button small danger" data-action="delete-knowledge-sync" data-kb="${escapeHtml(knowledgeBase.id)}" data-name="${escapeHtml(knowledgeBase.name)}">Desvincular</button>` : ''}
    <button class="button small ${target ? '' : 'primary'}" data-action="configure-knowledge-sync" data-kb="${escapeHtml(knowledgeBase.id)}" ${driveConfigured ? '' : 'disabled'}>${target ? 'Editar vínculo' : 'Vincular pastas'}</button>`;
}

const knowledgeSyncTargetSignature = target => JSON.stringify(target || null);

function knowledgeSyncFolderMarkup(target) {
  const folders = target?.folders || [];
  return `<small>Pastas do Drive</small>${folders.length ? `<div>${folders.map(folder => `<span class="folder-chip" title="${escapeHtml(folder.id)}">▣ ${escapeHtml(folder.name)}</span>`).join('')}</div>` : '<span class="subtle">Nenhuma pasta vinculada</span>'}`;
}

function knowledgeSyncRow(knowledgeBase, target, driveConfigured) {
  return `<article class="knowledge-sync-row" data-knowledge-base-id="${escapeHtml(knowledgeBase.id)}" data-knowledge-base-name="${escapeHtml(knowledgeBase.name)}">
    <div class="knowledge-sync-identity"><span class="workspace-icon">KB</span><div><strong>${escapeHtml(knowledgeBase.name)}</strong><small>${escapeHtml(knowledgeBase.description || `ID: ${knowledgeBase.id}`)}</small></div></div>
    <div class="knowledge-sync-folders">${knowledgeSyncFolderMarkup(target)}</div>
    <div class="knowledge-sync-stats">${knowledgeSyncStats(target)}</div>
    <div class="repo-actions knowledge-sync-actions">${knowledgeSyncActions(knowledgeBase, target, driveConfigured)}</div>
  </article>`;
}

async function renderKnowledgeSync() {
  currentView = 'knowledge-sync'; currentWorkspace = null;
  setNavigation('knowledge-sync');
  setHeader('Bases e Google Drive', 'Administração / Knowledge Bases');
  content.innerHTML = '<div class="loading"><i></i> Consultando bases e worker…</div>';
  const [status, picker, baseData, targetData] = await Promise.all([
    api('/api/knowledge-sync/status'),
    api('/api/knowledge-sync/picker-config'),
    api('/api/knowledge-sync/knowledge-bases'),
    api('/api/knowledge-sync/targets')
  ]);
  knowledgeSyncDriveConfigured = status.configured;
  knowledgeSyncDefaultTimezone = status.defaultTimezone || 'America/Maceio';
  knowledgeSyncPickerConfig = picker;
  knowledgeSyncTargets = targetData.targets;
  const linked = new Map(knowledgeSyncTargets.map(target => [target.knowledgeBaseId, target]));
  const credentialState = status.configured
    ? `<span class="status active">Configurada</span><p>Compartilhe as pastas com <code>${escapeHtml(status.serviceAccountEmail)}</code>.</p><div class="repo-actions"><button class="button small" data-action="copy-drive-email" data-email="${escapeHtml(status.serviceAccountEmail)}">Copiar e-mail</button><button class="button small" data-action="test-drive-credentials">Testar conexão</button><button class="button small" data-action="configure-drive-credentials">Substituir JSON</button><button class="button small danger" data-action="remove-drive-credentials">Remover</button></div>`
    : `<span class="status revoked">Não configurada</span><p>Envie o JSON da Service Account para habilitar a seleção de pastas e as sincronizações. Nenhuma credencial é solicitada durante a instalação.</p><button class="button small primary" data-action="configure-drive-credentials">Configurar Google Drive</button>`;
  const pickerState = picker.configured
    ? `<span class="status active">Ativado no Open WebUI</span><p>O Picker manual está disponível no menu de anexos. Recarregue abas do Open WebUI que já estavam abertas.</p><div class="repo-actions"><button class="button small" data-action="configure-drive-picker">Substituir credenciais</button><button class="button small danger" data-action="remove-drive-picker">Desativar</button></div>`
    : `<span class="status revoked">Desativado</span><p>Informe o OAuth Client ID e a API Key para ativar o Picker nativo do Google Drive no Open WebUI.</p><button class="button small primary" data-action="configure-drive-picker">Configurar Picker</button>`;
  content.innerHTML = `<article class="drive-config-card"><div><small>PICKER NATIVO</small><h2>Integração do Open WebUI</h2>${pickerState}</div><div class="drive-config-meta"><span><small>OAuth Client ID</small><strong title="${escapeHtml(picker.clientId || '')}">${escapeHtml(picker.clientId || '—')}</strong></span><span><small>API Key</small><strong>${picker.apiKeyConfigured ? `••••${escapeHtml(picker.apiKeySuffix)}` : '—'}</strong></span></div></article>
    <article class="drive-config-card"><div><small>CONTA DE SERVIÇO</small><h2>Sincronização automática</h2>${credentialState}${status.credentialsError ? `<p class="sync-error">${escapeHtml(status.credentialsError)}</p>` : ''}</div><div class="drive-config-meta"><span><small>Projeto</small><strong>${escapeHtml(status.projectId || '—')}</strong></span><span><small>Vínculos</small><strong data-knowledge-sync-count>${knowledgeSyncTargets.length}</strong></span></div></article>
    <div class="access-banner ${status.configured ? '' : 'open'}"><div><strong>${status.configured ? 'Sincronização automática disponível' : 'Worker instalado e aguardando configuração'}</strong><p>${status.configured ? 'Cada vínculo envia arquivos somente para a Knowledge Base selecionada.' : 'O serviço permanece ocioso até uma Service Account ser cadastrada e uma pasta ser vinculada.'}</p></div><code data-knowledge-sync-count-label>${knowledgeSyncTargets.length} vínculo${knowledgeSyncTargets.length === 1 ? '' : 's'}</code></div>
    <div class="toolbar"><span class="subtle">${baseData.knowledgeBases.length} Knowledge Base${baseData.knowledgeBases.length === 1 ? '' : 's'} encontrada${baseData.knowledgeBases.length === 1 ? '' : 's'}</span></div>
    ${baseData.knowledgeBases.length ? `<div class="knowledge-sync-list">${baseData.knowledgeBases.map(base => knowledgeSyncRow(base, linked.get(base.id), status.configured)).join('')}</div>` : '<div class="empty"><div><div class="empty-icon">KB</div><h2>Nenhuma Knowledge Base encontrada</h2><p>Crie uma base no Open WebUI antes de vincular pastas do Google Drive.</p></div></div>'}`;
  $$('[data-knowledge-base-id]', content).forEach(row => {
    row.dataset.targetSignature = knowledgeSyncTargetSignature(linked.get(row.dataset.knowledgeBaseId));
  });
}

function drivePickerModal() {
  const currentClientId = knowledgeSyncPickerConfig?.clientId || '';
  openModal(`<h2 class="modal-title">Configurar Picker do Google Drive</h2><p class="modal-copy">Ao salvar as duas credenciais, a integração será ativada imediatamente no Open WebUI. O Client Secret não é utilizado.</p><div class="field"><label for="drive-picker-client-id">OAuth Client ID</label><input id="drive-picker-client-id" value="${escapeHtml(currentClientId)}" autocomplete="off" placeholder="cliente.apps.googleusercontent.com"></div><div class="field"><label for="drive-picker-api-key">API Key do Google Picker</label><input id="drive-picker-api-key" type="password" autocomplete="new-password" placeholder="${knowledgeSyncPickerConfig?.apiKeyConfigured ? 'Informe novamente para substituir as credenciais' : 'AIza…'}"><p class="field-help">A chave é persistida no Open WebUI e não será exibida novamente pelo painel.</p></div><div class="modal-actions"><button class="button" value="cancel">Cancelar</button><button class="button primary" type="button" data-action="save-drive-picker">Salvar e ativar</button></div>`, 'save-drive-picker');
}

async function refreshKnowledgeSyncRows() {
  if (currentView !== 'knowledge-sync' || knowledgeSyncRefreshInFlight) return;
  knowledgeSyncRefreshInFlight = true;
  try {
    const { targets } = await api('/api/knowledge-sync/targets');
    knowledgeSyncTargets = targets;
    const linked = new Map(targets.map(target => [target.knowledgeBaseId, target]));
    $$('[data-knowledge-base-id]', content).forEach(row => {
      const target = linked.get(row.dataset.knowledgeBaseId);
      const folders = $('.knowledge-sync-folders', row);
      const stats = $('.knowledge-sync-stats', row);
      const actions = $('.knowledge-sync-actions', row);
      const base = { id: row.dataset.knowledgeBaseId, name: row.dataset.knowledgeBaseName };
      const signature = knowledgeSyncTargetSignature(target);
      if (row.dataset.targetSignature === signature) return;
      folders.innerHTML = knowledgeSyncFolderMarkup(target);
      stats.innerHTML = knowledgeSyncStats(target);
      actions.innerHTML = knowledgeSyncActions(base, target, knowledgeSyncDriveConfigured);
      row.dataset.targetSignature = signature;
    });
    const count = $('[data-knowledge-sync-count]', content);
    const label = $('[data-knowledge-sync-count-label]', content);
    if (count) count.textContent = String(targets.length);
    if (label) label.textContent = `${targets.length} vínculo${targets.length === 1 ? '' : 's'}`;
  } finally {
    knowledgeSyncRefreshInFlight = false;
  }
}

function driveCredentialsModal() {
  openModal(`<h2 class="modal-title">Configurar Google Drive</h2><p class="modal-copy">Selecione no seu computador o JSON baixado do Google Cloud. O navegador o envia diretamente ao servidor, onde será salvo com permissão restrita.</p><div class="field"><label for="drive-credentials-file">Arquivo da Service Account</label><input id="drive-credentials-file" type="file" accept="application/json,.json"><p class="field-help" id="drive-credentials-preview">Nenhum arquivo selecionado.</p></div><details class="credential-details"><summary>Ou cole o conteúdo do JSON</summary><div class="field"><label for="drive-credentials-json">JSON da Service Account</label><textarea id="drive-credentials-json" rows="10" spellcheck="false" placeholder='{"type":"service_account", ...}'></textarea></div></details><div class="modal-actions"><button class="button" value="cancel">Cancelar</button><button class="button primary" type="button" data-action="save-drive-credentials" disabled>Salvar credencial</button></div>`, 'save-drive-credentials');
  const textarea = $('#drive-credentials-json');
  const preview = $('#drive-credentials-preview');
  const save = $('[data-action="save-drive-credentials"]');
  const inspect = () => {
    try {
      const parsed = JSON.parse(textarea.value);
      preview.textContent = parsed.client_email ? `${parsed.client_email}${parsed.project_id ? ` · ${parsed.project_id}` : ''}` : 'O JSON não contém client_email.';
      save.disabled = parsed.type !== 'service_account' || !parsed.client_email || !parsed.private_key;
    } catch {
      preview.textContent = textarea.value.trim() ? 'JSON inválido.' : 'Nenhum arquivo selecionado.';
      save.disabled = true;
    }
  };
  textarea.addEventListener('input', inspect);
  $('#drive-credentials-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 1_000_000) {
      textarea.value = '';
      preview.textContent = 'O arquivo excede o limite de 1 MB.';
      save.disabled = true;
      return;
    }
    textarea.value = await file.text();
    inspect();
  });
}

function driveFolderRows(folders) {
  return folders.map(folder => `<label class="picker-row"><input type="checkbox" name="drive-folder" value="${escapeHtml(folder.id)}" ${selectedDriveFolders.has(folder.id) ? 'checked' : ''}><span><strong>${escapeHtml(folder.name)}</strong><small>${escapeHtml(folder.id)}</small></span><span class="badge">pasta</span></label>`).join('') || '<div class="empty" style="min-height:120px">Nenhuma pasta encontrada.</div>';
}

function updateDriveFolderSelection() {
  const node = $('#drive-folder-selection');
  if (node) node.textContent = `${selectedDriveFolders.size} selecionada${selectedDriveFolders.size === 1 ? '' : 's'}`;
  const save = $('[data-action="save-knowledge-sync"]');
  if (save) save.disabled = selectedDriveFolders.size === 0;
}

async function knowledgeSyncModal(knowledgeBaseId) {
  const [baseData, folderData] = await Promise.all([
    api('/api/knowledge-sync/knowledge-bases'),
    api('/api/knowledge-sync/folders')
  ]);
  const knowledgeBase = baseData.knowledgeBases.find(item => item.id === knowledgeBaseId);
  if (!knowledgeBase) throw new Error('Knowledge Base não encontrada.');
  const existing = knowledgeSyncTargets.find(item => item.knowledgeBaseId === knowledgeBaseId);
  knowledgeSyncFolders = folderData.folders;
  selectedDriveFolders = new Map((existing?.folders || []).map(folder => [folder.id, folder]));
  const [minute, hour, day, month, weekday] = (existing?.cron || '30 * * * *').split(' ');
  openModal(`<h2 class="modal-title">Vincular ${escapeHtml(knowledgeBase.name)}</h2><p class="modal-copy">Selecione uma ou mais pastas compartilhadas com <strong>${escapeHtml(folderData.serviceAccountEmail)}</strong>. O worker manterá os arquivos isolados nesta base.</p><input class="search" id="drive-folder-search" placeholder="Buscar pasta por nome ou ID…"><div class="picker-summary"><span>${knowledgeSyncFolders.length} acessíveis</span><strong id="drive-folder-selection">${selectedDriveFolders.size} selecionada${selectedDriveFolders.size === 1 ? '' : 's'}</strong></div><div class="picker" id="drive-folder-picker">${driveFolderRows(knowledgeSyncFolders)}</div><div class="field"><label for="drive-folder-id">Adicionar diretamente pelo folder ID</label><div class="inline-field"><input id="drive-folder-id" data-enter-action="add-drive-folder-id" placeholder="ID da pasta compartilhada"><button class="button" type="button" data-action="add-drive-folder-id">Adicionar</button></div></div><div class="field"><label>Agendamento</label><div class="cron-fields"><div class="field"><label for="knowledge-sync-cron-minute">Minuto</label><input id="knowledge-sync-cron-minute" value="${escapeHtml(minute)}" placeholder="30"><small>0–59</small></div><div class="field"><label for="knowledge-sync-cron-hour">Hora</label><input id="knowledge-sync-cron-hour" value="${escapeHtml(hour)}" placeholder="*"><small>0–23</small></div><div class="field"><label for="knowledge-sync-cron-day">Dia do mês</label><input id="knowledge-sync-cron-day" value="${escapeHtml(day)}" placeholder="*"><small>1–31</small></div><div class="field"><label for="knowledge-sync-cron-month">Mês</label><input id="knowledge-sync-cron-month" value="${escapeHtml(month)}" placeholder="*"><small>1–12</small></div><div class="field"><label for="knowledge-sync-cron-weekday">Dia da semana</label><input id="knowledge-sync-cron-weekday" value="${escapeHtml(weekday)}" placeholder="*"><small>0–7, domingo</small></div></div><p class="field-help">Use <code>*</code> para qualquer valor, vírgula para listas e <code>*/n</code> para intervalos. O padrão verifica mudanças no minuto 30 de cada hora.</p></div><div class="field"><label for="knowledge-sync-timezone">Fuso horário</label><input id="knowledge-sync-timezone" value="${escapeHtml(existing?.timezone || knowledgeSyncDefaultTimezone)}" placeholder="America/Maceio"></div><label class="switch-control switch-modal"><input id="knowledge-sync-enabled" type="checkbox" ${existing?.enabled === false ? '' : 'checked'}><span class="switch-track" aria-hidden="true"></span><span>Sincronização ativada</span></label><div class="modal-actions"><button class="button" value="cancel">Cancelar</button><button class="button primary" type="button" data-action="save-knowledge-sync" data-kb="${escapeHtml(knowledgeBase.id)}" data-name="${escapeHtml(knowledgeBase.name)}" ${selectedDriveFolders.size ? '' : 'disabled'}>Salvar vínculo</button></div>`, 'save-knowledge-sync');
  $('#drive-folder-search').addEventListener('input', event => {
    const query = normalizeSearch(event.target.value);
    const filtered = knowledgeSyncFolders.filter(folder => normalizeSearch(`${folder.name} ${folder.id}`).includes(query));
    $('#drive-folder-picker').innerHTML = driveFolderRows(filtered);
  });
}

async function knowledgeSyncHistoryModal(knowledgeBaseId) {
  const { history } = await api(`/api/knowledge-sync/history?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
  openModal(`<h2 class="modal-title">Histórico de sincronização</h2><p class="modal-copy">Execuções mais recentes desta Knowledge Base.</p>${history.length ? `<div class="sync-history">${history.map(run => `<article><div><strong>${date(run.startedAt)}</strong><span class="status ${run.status === 'completed' ? 'completed' : 'failed'}">${run.status === 'completed' ? 'Concluída' : run.status === 'partial' ? 'Parcial' : 'Falhou'}</span></div><small>+${run.added} adicionados · ~${run.modified} alterados · −${run.deleted} removidos · ${run.unchanged} sem mudança${run.failed ? ` · ${run.failed} falharam` : ''}${run.durationMs ? ` · ${Math.round(run.durationMs / 1000)}s` : ''}</small>${run.error ? `<p>${escapeHtml(run.error)}</p>` : ''}</article>`).join('')}</div>` : '<div class="empty" style="min-height:160px">Nenhuma execução registrada.</div>'}<div class="modal-actions"><button class="button" value="cancel">Fechar</button></div>`);
}

async function knowledgeSyncFilesModal(knowledgeBaseId) {
  const { files } = await api(`/api/knowledge-sync/targets/${encodeURIComponent(knowledgeBaseId)}/files`);
  const rows = files.map(file => `<article class="managed-file-row"><div><strong>${escapeHtml(file.filename)}</strong><small>${escapeHtml(file.managedPath || 'Google Drive')} · alterado ${date(file.modifiedTime)}</small>${file.error ? `<p>${escapeHtml(file.error)}</p>` : ''}</div><span class="status ${file.status === 'failed' ? 'failed' : 'completed'}">${file.status === 'failed' ? 'Falhou' : 'Indexado'}</span><button class="button small" type="button" data-action="reprocess-knowledge-file" data-kb="${escapeHtml(knowledgeBaseId)}" data-source-key="${escapeHtml(file.sourceKey)}">${file.status === 'failed' ? 'Tentar novamente' : 'Reprocessar'}</button></article>`).join('');
  openModal(`<h2 class="modal-title">Arquivos gerenciados</h2><p class="modal-copy">Reprocesse um documento sem varrer novamente todas as pastas vinculadas.</p><div class="managed-files">${rows || '<div class="empty" style="min-height:160px">Nenhum arquivo sincronizado.</div>'}</div><div class="modal-actions"><button class="button" value="cancel">Fechar</button></div>`);
}

const jobStatusLabels = { queued:'Na fila', running:'Executando', completed:'Concluída', failed:'Falhou', interrupted:'Interrompida' };

function renderJobs() {
  currentView = 'jobs'; currentWorkspace = null;
  setNavigation('jobs');
  setHeader('Operações', 'Administração');
  const pagination = `<div class="jobs-pagination"><span>${jobsPagination.total} operaç${jobsPagination.total === 1 ? 'ão' : 'ões'} nos últimos 7 dias</span><div><button class="button small" data-action="jobs-page" data-page="${jobsPagination.page - 1}" ${jobsPagination.page <= 1 ? 'disabled' : ''}>← Anterior</button><strong>Página ${jobsPagination.page} de ${jobsPagination.totalPages}</strong><button class="button small" data-action="jobs-page" data-page="${jobsPagination.page + 1}" ${jobsPagination.page >= jobsPagination.totalPages ? 'disabled' : ''}>Próxima →</button></div></div>`;
  content.innerHTML = jobs.length ? `<div class="jobs-list">${jobs.map(job => `<article class="card job"><div class="job-top"><div><h3>${escapeHtml(job.label)}</h3><span class="status ${escapeHtml(job.status)}">${escapeHtml(jobStatusLabels[job.status] || job.status)}</span></div><time>${date(job.createdAt)}</time></div>${job.log ? `<pre>${escapeHtml(job.log)}</pre>` : ''}${job.error ? `<p class="job-error">${escapeHtml(job.error)}</p>` : ''}<div class="progress ${['queued','running'].includes(job.status) ? 'indeterminate' : ''}"><i style="width:${job.progress}%"></i></div></article>`).join('')}</div>${pagination}` : `<div class="empty"><div><div class="empty-icon">↻</div><h2>Nenhuma operação recente</h2><p>Clones, sincronizações e indexações dos últimos sete dias aparecerão aqui.</p></div></div>${pagination}`;
}

async function openJobs(page = 1) {
  currentView = 'jobs'; currentWorkspace = null;
  setNavigation('jobs');
  setHeader('Operações', 'Administração');
  content.innerHTML = '<div class="loading"><i></i> Carregando operações…</div>';
  await refreshJobs(page);
}

function renderObservability() {
  currentView = 'observability'; currentWorkspace = null;
  setNavigation('observability');
  setHeader('Observabilidade', 'Administração / Monitoramento', `<a class="button observability-open" href="${grafanaDashboardUrl}" target="_blank" rel="noopener">Abrir no Grafana ↗</a>`);
  content.innerHTML = `<div class="observability-notice"><span>◉</span><p>O Grafana mantém uma sessão própria. Se a tela de login aparecer, use a credencial administrativa configurada na instalação.</p></div><div class="observability-frame"><iframe src="${grafanaDashboardUrl}&kiosk" title="Dashboard de operação do Codebase Memory" loading="eager"></iframe></div>`;
}

function mcpUserRow(user) {
  const active = user.status === 'active';
  const repositoryCount = user.repositoryIds?.length || 0;
  return `<article class="mcp-user-row">
    <div class="mcp-user-identity">
      <span class="user-avatar">${escapeHtml(user.name.slice(0, 2).toUpperCase())}</span>
      <div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.identity)}</small>${user.description ? `<p>${escapeHtml(user.description)}</p>` : ''}</div>
    </div>
    <div class="mcp-user-access"><small>Repositórios</small><strong>${repositoryCount}</strong><span>permitido${repositoryCount === 1 ? '' : 's'}</span></div>
    <div class="mcp-key-reference"><small>Token</small><code>${escapeHtml(user.keyPrefix || 'sem token')}</code></div>
    <div class="mcp-user-status"><small>Status</small><span class="status ${active ? 'active' : 'revoked'}">${active ? 'Ativo' : 'Revogado'}</span></div>
    <div class="mcp-user-dates"><small>${active ? 'Token gerado' : 'Revogado em'}</small><span>${date(active ? user.tokenCreatedAt : user.revokedAt)}</span></div>
    <div class="repo-actions">
      <button class="button small" data-action="edit-mcp-access" data-user="${user.id}">Editar acessos</button>
      ${active
        ? `<button class="button small" data-action="rotate-mcp-token" data-user="${user.id}" data-name="${escapeHtml(user.name)}">Gerar novo token</button><button class="button small danger" data-action="revoke-mcp-token" data-user="${user.id}" data-name="${escapeHtml(user.name)}">Revogar</button>`
        : `<button class="button small primary" data-action="reactivate-mcp-user" data-user="${user.id}" data-name="${escapeHtml(user.name)}">Reativar</button>`}
      <button class="button small danger" data-action="delete-mcp-user" data-user="${user.id}" data-name="${escapeHtml(user.name)}">Excluir</button>
    </div>
  </article>`;
}

async function renderMcpUsers() {
  currentView = 'mcp-users'; currentWorkspace = null;
  setNavigation('mcp-users');
  setHeader('Usuários MCP', 'Administração / Acesso MCP', '<button class="button primary" data-action="new-mcp-user">＋ Novo usuário</button>');
  const [{ users, accessMode, systemAccess }, accessOptions] = await Promise.all([
    api('/api/mcp-users'),
    api('/api/mcp-access-options')
  ]);
  currentMcpUsers = users;
  mcpAccessOptions = accessOptions.workspaces;
  const activeCount = users.filter(user => user.status === 'active').length;
  const totalActive = activeCount + (systemAccess ? 1 : 0);
  const modeCopy = `${totalActive} token${totalActive === 1 ? '' : 's'} ativo${totalActive === 1 ? '' : 's'}, incluindo a credencial técnica. Requisições sem uma chave válida são bloqueadas.`;
  content.innerHTML = `<div class="access-banner ${accessMode}"><div><strong>${accessMode === 'strict' ? 'Autenticação obrigatória' : 'Acesso inicial sem token'}</strong><p>${modeCopy}</p></div><code>${escapeHtml(publicConfig.mcpUrl)}</code></div>
    <article class="mcp-system-card"><div><span class="user-avatar">SYS</span><div><strong>Sistema / Playground</strong><p>Credencial técnica com acesso irrestrito, criada automaticamente para validações da instalação e uso manual no MCP Playground.</p></div></div><div class="repo-actions"><button class="button small" data-action="reveal-system-token">Exibir token</button><button class="button small danger" data-action="rotate-system-token">Gerar novo token</button></div></article>
    ${users.length
      ? `<div class="toolbar"><span class="subtle">${users.length} usuário${users.length === 1 ? '' : 's'} · ${activeCount} ativo${activeCount === 1 ? '' : 's'}</span></div><div class="mcp-user-list">${users.map(mcpUserRow).join('')}</div>`
      : `<div class="empty"><div><div class="empty-icon">♙</div><h2>Nenhum desenvolvedor cadastrado</h2><p>O endpoint já está protegido pela credencial técnica. Crie tokens individuais para os desenvolvedores que utilizarão o MCP.</p><button class="button primary" data-action="new-mcp-user">Criar primeiro usuário</button></div></div>`}`;
}

function mcpAccessPicker() {
  const repositories = mcpAccessOptions.flatMap(workspace => workspace.repositories);
  return `<div class="field"><label>Repositórios permitidos</label><p class="field-help">O workspace apenas seleciona seus repositórios atuais em conjunto. A permissão salva é individual por repositório.</p><div class="mcp-access-picker">${mcpAccessOptions.map(workspace => {
    const empty = workspace.repositories.length === 0;
    return `<section class="mcp-access-workspace" data-access-workspace="${escapeHtml(workspace.id)}"><label class="mcp-access-workspace-head"><input type="checkbox" name="mcp-workspace" ${empty ? 'disabled' : ''}><span><strong>${escapeHtml(workspace.name)}</strong><small>${workspace.repositories.length} repo${workspace.repositories.length === 1 ? '' : 's'}</small></span></label><div class="mcp-access-repositories">${workspace.repositories.map(repository => `<label class="mcp-access-repository"><input type="checkbox" name="mcp-repository" value="${escapeHtml(repository.id)}" ${selectedMcpRepositories.has(repository.id) ? 'checked' : ''}><span><strong>${escapeHtml(repository.fullName)}</strong><small>${repository.indexed ? `ID MCP: ${escapeHtml(repository.project)}` : 'Aguardando indexação'}</small></span><span class="badge ${repository.indexed ? '' : 'pending'}">${repository.indexed ? 'indexado' : 'não indexado'}</span></label>`).join('') || '<p class="mcp-access-empty">Nenhum repositório neste workspace.</p>'}</div></section>`;
  }).join('') || '<p class="mcp-access-empty">Crie um workspace e adicione repositórios antes de cadastrar usuários MCP.</p>'}</div><div class="picker-summary"><span>${repositories.length} ${repositories.length === 1 ? 'disponível' : 'disponíveis'}</span><strong id="mcp-access-selection">0 selecionados</strong></div></div>`;
}

function updateMcpAccessSelection() {
  $$('.mcp-access-workspace').forEach(section => {
    const workspaceInput = $('input[name=mcp-workspace]', section);
    const repositoryInputs = $$('input[name=mcp-repository]', section);
    const selected = repositoryInputs.filter(input => input.checked).length;
    if (workspaceInput) {
      workspaceInput.checked = repositoryInputs.length > 0 && selected === repositoryInputs.length;
      workspaceInput.indeterminate = selected > 0 && selected < repositoryInputs.length;
    }
  });
  selectedMcpRepositories = new Set($$('input[name=mcp-repository]:checked').map(input => input.value));
  const count = selectedMcpRepositories.size;
  const summary = $('#mcp-access-selection');
  if (summary) summary.textContent = `${count} selecionado${count === 1 ? '' : 's'}`;
  const save = $('[data-action="save-mcp-user"], [data-action="save-mcp-access"]');
  if (save) save.disabled = count === 0;
}

function newMcpUserModal() {
  selectedMcpRepositories = new Set();
  openModal(`<h2 class="modal-title">Novo usuário MCP</h2><p class="modal-copy">Um token individual será gerado e exibido uma única vez após o cadastro.</p><div class="field"><label for="mcp-user-name">Nome</label><input id="mcp-user-name" maxlength="100" autofocus placeholder="Ex.: Maria Silva"></div><div class="field"><label for="mcp-user-identity">E-mail ou login</label><input id="mcp-user-identity" maxlength="160" placeholder="maria@empresa.com"></div><div class="field"><label for="mcp-user-description">Descrição</label><textarea id="mcp-user-description" maxlength="240" placeholder="Time ou finalidade do acesso"></textarea></div>${mcpAccessPicker()}<div class="modal-actions"><button class="button" value="cancel">Cancelar</button><button class="button primary" type="button" data-action="save-mcp-user" disabled>Criar e gerar token</button></div>`, 'save-mcp-user');
  updateMcpAccessSelection();
}

function editMcpAccessModal(user) {
  selectedMcpRepositories = new Set(user.repositoryIds || []);
  openModal(`<h2 class="modal-title">Acessos de ${escapeHtml(user.name)}</h2><p class="modal-copy">Alterações entram em vigor nas próximas chamadas e não exigem gerar outro token.</p>${mcpAccessPicker()}<div class="modal-actions"><button class="button" value="cancel">Cancelar</button><button class="button primary" type="button" data-action="save-mcp-access" data-user="${escapeHtml(user.id)}">Salvar acessos</button></div>`, 'save-mcp-access');
  updateMcpAccessSelection();
}

function mcpTokenModal(name, token, revisable = false) {
  openModal(`<h2 class="modal-title">Token de ${escapeHtml(name)}</h2><p class="modal-copy token-warning">${revisable ? 'Este token pode ser consultado novamente no detalhe do workspace. Trate-o como um segredo.' : 'Copie este token agora. Por segurança, ele não será exibido novamente pelo painel.'}</p><div class="token-box"><code id="generated-mcp-token">${escapeHtml(token)}</code><button class="button small" type="button" data-action="copy-mcp-token">Copiar token</button></div><div class="client-example"><small>Cabeçalho de autenticação</small><code>Authorization: Bearer ${escapeHtml(token)}</code></div><div class="modal-actions"><button class="button primary" value="cancel">Concluir</button></div>`);
}

async function copyText(value) {
  if (!value) throw new Error('O conteúdo não está disponível para cópia.');
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return 'clipboard'; } catch { /* use fallback below */ }
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.readOnly = true;
  input.setAttribute('aria-hidden', 'true');
  input.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;padding:0;border:0;opacity:.01;z-index:9999';
  document.body.append(input);
  input.focus({ preventScroll:true });
  input.select();
  input.setSelectionRange(0, value.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* browser blocked legacy clipboard */ }
  input.remove();
  if (copied) return 'legacy';

  const tokenNode = $('#generated-mcp-token');
  if (tokenNode) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(tokenNode);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  window.prompt('A cópia automática foi bloqueada pelo navegador. Copie o conteúdo abaixo:', value);
  return 'manual';
}

function newWorkspaceModal() {
  openModal(`<h2 class="modal-title">Novo workspace</h2><p class="modal-copy">Use um nome que represente um produto, domínio ou conjunto de serviços.</p><div class="field"><label for="workspace-name">Nome</label><input id="workspace-name" maxlength="80" autofocus placeholder="Ex.: Plataforma de pagamentos"></div><div class="field"><label for="workspace-description">Descrição</label><textarea id="workspace-description" maxlength="240" placeholder="Contexto opcional do workspace"></textarea></div><div class="modal-actions"><button class="button" value="cancel">Cancelar</button><button class="button primary" type="button" data-action="save-workspace">Criar workspace</button></div>`, 'save-workspace');
}

function connectGithubModal() {
  openModal(`<h2 class="modal-title">Conectar ao GitHub</h2><p class="modal-copy">Use um token fine-grained com acesso de leitura a metadados e conteúdos. Ele será armazenado localmente, com acesso restrito, e preservado ao reiniciar ou atualizar o painel.</p><div class="field"><label for="github-token">Personal access token</label><input id="github-token" type="password" autocomplete="off" placeholder="github_pat_…"></div><div class="modal-actions"><button class="button" value="cancel">Cancelar</button><button class="button primary" type="button" data-action="save-github">Conectar e salvar</button></div>`, 'save-github');
}

async function repositoryPicker() {
  const connection = await renderGithub();
  if (!connection.connected) { connectGithubModal(); return; }
  openModal('<h2 class="modal-title">Adicionar repositórios</h2><p class="modal-copy">Carregando repositórios disponíveis…</p><div class="loading"><i></i> Consultando GitHub</div>', 'clone-selected');
  try {
    const [{ repositories }, workspaceData] = await Promise.all([
      api('/api/github/repositories'),
      api(`/api/workspaces/${currentWorkspace}`)
    ]);
    const existing = new Set(workspaceData.repositories.map(repo => repo.fullName));
    selectedRepositories = new Set();
    $('#modal-content').innerHTML = `<h2 class="modal-title">Adicionar repositórios</h2><p class="modal-copy">Selecione um ou mais repositórios. Os já adicionados e os arquivados ficam desabilitados.</p><input class="search" id="repo-search" placeholder="Buscar por nome ou descrição…"><div class="picker-summary"><span id="repository-results">${repositories.length} encontrados</span><strong id="repository-selection">0 selecionados</strong></div><div class="picker" id="repo-picker">${repositoryRows(repositories, existing)}</div><div class="modal-actions"><button class="button" value="cancel">Cancelar</button><button class="button primary" type="button" data-action="clone-selected" disabled>Adicionar selecionados</button></div>`;
    const redraw = query => {
      const normalizedQuery = normalizeSearch(query);
      const filtered = repositories.filter(repo => normalizeSearch(`${repo.fullName} ${repo.description || ''}`).includes(normalizedQuery));
      $('#repo-picker').innerHTML = repositoryRows(filtered, existing);
      $('#repository-results').textContent = `${filtered.length} encontrado${filtered.length === 1 ? '' : 's'}`;
      updateRepositorySelection();
    };
    $('#repo-search').addEventListener('input', event => redraw(event.target.value));
    $('#repo-picker').addEventListener('change', event => {
      if (!event.target.matches('input[name=repository]')) return;
      if (event.target.checked) selectedRepositories.add(event.target.value);
      else selectedRepositories.delete(event.target.value);
      updateRepositorySelection();
    });
  } catch (error) { closeModal(); toast(error.message, 'error'); }
}

function normalizeSearch(value) { return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }

function repositoryRows(repositories, existing = new Set()) {
  return repositories.map(repo => {
    const unavailable = repo.archived || existing.has(repo.fullName);
    const checked = selectedRepositories.has(repo.fullName) && !unavailable;
    const label = existing.has(repo.fullName) ? 'adicionado' : repo.archived ? 'arquivado' : repo.private ? 'privado' : 'público';
    return `<label class="picker-row ${unavailable ? 'disabled' : ''}"><input type="checkbox" name="repository" value="${escapeHtml(repo.fullName)}" ${checked ? 'checked' : ''} ${unavailable ? 'disabled' : ''}><span><strong>${escapeHtml(repo.fullName)}</strong><small>${escapeHtml(repo.description || 'Sem descrição')}</small></span><span class="badge">${label}</span></label>`;
  }).join('') || '<div class="empty" style="min-height:120px">Nenhum repositório encontrado.</div>';
}

function updateRepositorySelection() {
  const count = selectedRepositories.size;
  $('#repository-selection').textContent = `${count} selecionado${count === 1 ? '' : 's'}`;
  $('[data-action="clone-selected"]').disabled = count === 0;
}

document.addEventListener('change', event => {
  if (event.target.matches('input[name=mcp-workspace]')) {
    const section = event.target.closest('.mcp-access-workspace');
    $$('input[name=mcp-repository]', section).forEach(input => { input.checked = event.target.checked; });
    updateMcpAccessSelection();
  }
  if (event.target.matches('input[name=mcp-repository]')) updateMcpAccessSelection();
  if (event.target.matches('input[name=drive-folder]')) {
    const folder = knowledgeSyncFolders.find(item => item.id === event.target.value) || selectedDriveFolders.get(event.target.value);
    if (event.target.checked && folder) selectedDriveFolders.set(folder.id, folder);
    else selectedDriveFolders.delete(event.target.value);
    updateDriveFolderSelection();
  }
});

async function refreshJobs(page = jobsPagination.page) {
  try {
    const result = await api(`/api/jobs?page=${encodeURIComponent(page)}&pageSize=${jobsPagination.pageSize}`);
    jobs = result.jobs;
    jobsPagination = result.pagination;
    const active = result.activeCount;
    $('#job-count').textContent = active; $('#job-count').hidden = !active;
    if (currentView === 'jobs') renderJobs();
    if (currentView === 'workspace') renderWorkspace(currentWorkspace);
  } catch {}
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action], [data-workspace], [data-view]'); if (!target) return;
  const action = target.dataset.action;
  try {
    if (target.dataset.view === 'workspaces') return renderWorkspaces();
    if (target.dataset.view === 'jobs') return openJobs(1);
    if (target.dataset.view === 'observability') return renderObservability();
    if (target.dataset.view === 'mcp-users') return renderMcpUsers();
    if (target.dataset.view === 'knowledge-sync') return renderKnowledgeSync();
    if (target.dataset.workspace) return renderWorkspace(target.dataset.workspace);
    if (action === 'jobs-page') return openJobs(Number(target.dataset.page));
    if (action === 'new-workspace') return newWorkspaceModal();
    if (action === 'configure-knowledge-sync') return knowledgeSyncModal(target.dataset.kb);
    if (action === 'configure-drive-picker') return drivePickerModal();
    if (action === 'save-drive-picker') {
      target.disabled = true;
      await api('/api/knowledge-sync/picker-config', { method:'PUT', body:JSON.stringify({ clientId:$('#drive-picker-client-id').value, apiKey:$('#drive-picker-api-key').value }) });
      closeModal(); toast('Picker do Google Drive ativado no Open WebUI.'); return renderKnowledgeSync();
    }
    if (action === 'remove-drive-picker') {
      if (!confirm('Desativar o Picker do Google Drive no Open WebUI e remover o Client ID e a API Key salvos?')) return;
      await api('/api/knowledge-sync/picker-config', { method:'DELETE' });
      toast('Picker do Google Drive desativado.'); return renderKnowledgeSync();
    }
    if (action === 'configure-drive-credentials') return driveCredentialsModal();
    if (action === 'save-drive-credentials') {
      target.disabled = true;
      const credentials = JSON.parse($('#drive-credentials-json').value);
      await api('/api/knowledge-sync/credentials', { method:'PUT', body:JSON.stringify({ credentials }) });
      closeModal(); toast('Service Account salva no servidor.'); return renderKnowledgeSync();
    }
    if (action === 'test-drive-credentials') {
      await api('/api/knowledge-sync/credentials/test', { method:'POST', body:'{}' });
      toast('Conexão com o Google Drive validada.'); return;
    }
    if (action === 'copy-drive-email') {
      await copyText(target.dataset.email);
      toast('E-mail da Service Account copiado.'); return;
    }
    if (action === 'remove-drive-credentials') {
      if (!confirm('Remover a Service Account? Os vínculos existentes serão pausados e os arquivos já enviados permanecerão nas bases.')) return;
      await api('/api/knowledge-sync/credentials', { method:'DELETE' });
      toast('Service Account removida e vínculos pausados.'); return renderKnowledgeSync();
    }
    if (action === 'add-drive-folder-id') {
      const id = $('#drive-folder-id').value.trim();
      if (!id) throw new Error('Informe o folder ID.');
      selectedDriveFolders.set(id, { id, name:`Pasta ${id.slice(0, 8)}` });
      $('#drive-folder-id').value = '';
      updateDriveFolderSelection();
      toast('Folder ID adicionado; o acesso será validado ao salvar.');
      return;
    }
    if (action === 'save-knowledge-sync') {
      target.disabled = true;
      const cron = ['minute', 'hour', 'day', 'month', 'weekday'].map(field => $(`#knowledge-sync-cron-${field}`).value.trim()).join(' ');
      await api(`/api/knowledge-sync/targets/${target.dataset.kb}`, { method:'PUT', body:JSON.stringify({ knowledgeBaseName:target.dataset.name, folders:[...selectedDriveFolders.values()], cron, timezone:$('#knowledge-sync-timezone').value, enabled:$('#knowledge-sync-enabled').checked }) });
      closeModal(); toast('Vínculo salvo. A sincronização seguirá o cron configurado.'); return renderKnowledgeSync();
    }
    if (action === 'run-knowledge-sync') {
      await api(`/api/knowledge-sync/targets/${target.dataset.kb}/run`, { method:'POST' });
      toast('Sincronização iniciada.'); return renderKnowledgeSync();
    }
    if (action === 'toggle-knowledge-sync') {
      const current = knowledgeSyncTargets.find(item => item.knowledgeBaseId === target.dataset.kb);
      if (!current) throw new Error('Vínculo não encontrado.');
      await api(`/api/knowledge-sync/targets/${target.dataset.kb}`, { method:'PUT', body:JSON.stringify({ knowledgeBaseName:current.knowledgeBaseName, folders:current.folders, cron:current.cron, timezone:current.timezone, enabled:!current.enabled }) });
      toast(current.enabled ? 'Sincronização pausada.' : 'Sincronização ativada.'); return renderKnowledgeSync();
    }
    if (action === 'knowledge-sync-history') return knowledgeSyncHistoryModal(target.dataset.kb);
    if (action === 'knowledge-sync-files') return knowledgeSyncFilesModal(target.dataset.kb);
    if (action === 'reprocess-knowledge-file') {
      target.disabled = true;
      await api(`/api/knowledge-sync/targets/${encodeURIComponent(target.dataset.kb)}/files/${encodeURIComponent(target.dataset.sourceKey)}/reprocess`, { method:'POST' });
      closeModal(); toast('Reprocessamento adicionado à fila.'); return renderKnowledgeSync();
    }
    if (action === 'delete-knowledge-sync') {
      if (!confirm(`Desvincular ${target.dataset.name}? Os arquivos enviados pelo worker serão removidos da base, mas permanecerão no Google Drive.`)) return;
      await api(`/api/knowledge-sync/targets/${target.dataset.kb}?deleteFiles=true`, { method:'DELETE' });
      toast('Pastas desvinculadas da Knowledge Base.'); return renderKnowledgeSync();
    }
    if (action === 'edit-schedule') {
      const { workspace } = await api(`/api/workspaces/${currentWorkspace}`);
      return editScheduleModal(workspace.updateSchedule);
    }
    if (action === 'save-schedule') {
      target.disabled = true;
      const cron = ['#schedule-minute','#schedule-hour','#schedule-day','#schedule-month','#schedule-weekday'].map(selector => $(selector).value.trim()).join(' ');
      await api(`/api/workspaces/${currentWorkspace}/schedule`, { method:'PUT', body:JSON.stringify({ cron, timezone:$('#schedule-timezone').value, enabled:$('#schedule-enabled').checked }) });
      closeModal(); toast('Rotina atualizada.'); return renderWorkspace(currentWorkspace);
    }
    if (action === 'toggle-schedule') {
      const { workspace } = await api(`/api/workspaces/${currentWorkspace}`);
      await api(`/api/workspaces/${currentWorkspace}/schedule`, { method:'PUT', body:JSON.stringify({ cron:workspace.updateSchedule.cron, timezone:workspace.updateSchedule.timezone, enabled:target.dataset.enabled !== 'true' }) });
      toast(target.dataset.enabled === 'true' ? 'Rotina desativada.' : 'Rotina ativada.'); return renderWorkspace(currentWorkspace);
    }
    if (action === 'run-workspace-sync') {
      await api(`/api/workspaces/${currentWorkspace}/schedule/run`, { method:'POST' });
      toast('Sincronização do workspace adicionada à fila global.'); return refreshJobs();
    }
    if (action === 'index-workspace') {
      if (!confirm('Indexar todos os repositórios deste workspace?')) return;
      await api(`/api/workspaces/${currentWorkspace}/index`, { method:'POST' });
      toast('Indexação completa adicionada à fila.');
      return refreshJobs();
    }
    if (action === 'new-mcp-user') return newMcpUserModal();
    if (action === 'edit-mcp-access') {
      const user = currentMcpUsers.find(item => item.id === target.dataset.user);
      if (!user) throw new Error('Usuário MCP não encontrado. Atualize a página.');
      return editMcpAccessModal(user);
    }
    if (action === 'save-mcp-user') {
      target.disabled = true;
      const result = await api('/api/mcp-users', { method:'POST', body:JSON.stringify({ name:$('#mcp-user-name').value, identity:$('#mcp-user-identity').value, description:$('#mcp-user-description').value, repositoryIds:[...selectedMcpRepositories] }) });
      closeModal(); await renderMcpUsers(); mcpTokenModal(result.user.name, result.token); return;
    }
    if (action === 'save-mcp-access') {
      target.disabled = true;
      await api(`/api/mcp-users/${target.dataset.user}/repositories`, { method:'PUT', body:JSON.stringify({ repositoryIds:[...selectedMcpRepositories] }) });
      closeModal(); toast('Acessos atualizados.'); return renderMcpUsers();
    }
    if (action === 'copy-mcp-token') {
      const token = $('#generated-mcp-token')?.textContent?.trim() || '';
      const mode = await copyText(token);
      if (mode === 'manual') return toast('Use Ctrl+C ou Cmd+C para copiar o token selecionado.');
      target.textContent = 'Copiado ✓';
      setTimeout(() => { if (target.isConnected) target.textContent = 'Copiar token'; }, 1800);
      return toast('Token copiado.');
    }
    if (action === 'reveal-system-token') {
      const result = await api('/api/mcp-system-token/reveal', { method:'POST' }); mcpTokenModal(result.name, result.token); return;
    }
    if (action === 'rotate-system-token') {
      if (!confirm('Gerar um novo token técnico? Testes ou Playgrounds que estejam usando o token atual deixarão de funcionar imediatamente.')) return;
      const result = await api('/api/mcp-system-token/rotate', { method:'POST' }); mcpTokenModal(result.name, result.token); return;
    }
    if (action === 'reveal-workspace-token') {
      const result = await api(`/api/workspaces/${currentWorkspace}/mcp-token/reveal`, { method:'POST' });
      mcpTokenModal(result.name, result.token, true); return;
    }
    if (action === 'rotate-workspace-token') {
      if (!confirm('Gerar um novo token para este workspace? O token atual deixará de funcionar imediatamente.')) return;
      const result = await api(`/api/workspaces/${currentWorkspace}/mcp-token/rotate`, { method:'POST' });
      await renderWorkspace(currentWorkspace); mcpTokenModal(result.workspace.name, result.token, true); return;
    }
    if (action === 'revoke-workspace-token') {
      if (!confirm('Revogar o token MCP deste workspace?')) return;
      await api(`/api/workspaces/${currentWorkspace}/mcp-token/revoke`, { method:'POST' });
      toast('Token do workspace revogado.'); return renderWorkspace(currentWorkspace);
    }
    if (action === 'reactivate-workspace-token') {
      const result = await api(`/api/workspaces/${currentWorkspace}/mcp-token/reactivate`, { method:'POST' });
      await renderWorkspace(currentWorkspace); mcpTokenModal(result.workspace.name, result.token, true); return;
    }
    if (action === 'rotate-mcp-token') {
      if (!confirm(`Gerar um novo token para ${target.dataset.name}? O token atual deixará de funcionar imediatamente.`)) return;
      const result = await api(`/api/mcp-users/${target.dataset.user}/rotate`, { method:'POST' });
      await renderMcpUsers(); mcpTokenModal(result.user.name, result.token); return;
    }
    if (action === 'revoke-mcp-token') {
      if (!confirm(`Revogar o acesso de ${target.dataset.name}? O token atual deixará de funcionar imediatamente.`)) return;
      await api(`/api/mcp-users/${target.dataset.user}/revoke`, { method:'POST' }); toast('Token revogado.'); return renderMcpUsers();
    }
    if (action === 'reactivate-mcp-user') {
      if (!confirm(`Reativar ${target.dataset.name} e gerar um novo token?`)) return;
      const result = await api(`/api/mcp-users/${target.dataset.user}/reactivate`, { method:'POST' });
      await renderMcpUsers(); mcpTokenModal(result.user.name, result.token); return;
    }
    if (action === 'delete-mcp-user') {
      if (!confirm(`Excluir ${target.dataset.name}? Qualquer token ativo será revogado e o cadastro será removido.`)) return;
      await api(`/api/mcp-users/${target.dataset.user}`, { method:'DELETE' }); toast('Usuário MCP excluído.'); return renderMcpUsers();
    }
    if (action === 'logout') {
      await api('/api/auth/logout', { method:'POST', body:'{}' });
      location.assign('/login');
      return;
    }
    if (action === 'back') return renderWorkspaces();
    if (action === 'connect-github') return connectGithubModal();
    if (action === 'disconnect-github') { await api('/api/github/connection', { method:'DELETE' }); await renderGithub(); return toast('GitHub desconectado.'); }
    if (action === 'save-github') { target.disabled = true; await api('/api/github/connection', { method:'POST', body:JSON.stringify({ token:$('#github-token').value }) }); closeModal(); await renderGithub(); return toast('GitHub conectado.'); }
    if (action === 'save-workspace') { target.disabled = true; const result = await api('/api/workspaces', { method:'POST', body:JSON.stringify({ name:$('#workspace-name').value, description:$('#workspace-description').value }) }); closeModal(); await renderWorkspaces(); mcpTokenModal(result.workspace.name, result.token, true); return; }
    if (action === 'add-repositories') return repositoryPicker();
    if (action === 'clone-selected') { const selected = [...selectedRepositories]; if (!selected.length) throw new Error('Selecione pelo menos um repositório.'); target.disabled = true; await api(`/api/workspaces/${currentWorkspace}/repositories`, { method:'POST', body:JSON.stringify({ repositories:selected }) }); selectedRepositories.clear(); closeModal(); toast('Clonagem iniciada.'); await refreshJobs(); return renderWorkspace(currentWorkspace); }
    if (action === 'sync' || action === 'index') { await api(`/api/workspaces/${currentWorkspace}/repositories/${target.dataset.repo}/${action}`, { method:'POST' }); toast(action === 'sync' ? 'Sincronização iniciada.' : 'Indexação iniciada.'); return refreshJobs(); }
    if (action === 'delete-repo') { if (!confirm(`Excluir ${target.dataset.name}? O clone local será removido.`)) return; await api(`/api/workspaces/${currentWorkspace}/repositories/${target.dataset.repo}`, { method:'DELETE' }); toast('Repositório removido.'); return renderWorkspace(currentWorkspace); }
    if (action === 'delete-workspace') { if (!confirm('Excluir este workspace vazio?')) return; await api(`/api/workspaces/${currentWorkspace}`, { method:'DELETE' }); toast('Workspace removido.'); return renderWorkspaces(); }
  } catch (error) { target.disabled = false; toast(error.message, 'error'); }
});

const session = await api('/api/auth/session');
$('#admin-identity').textContent = session.user.username;
publicConfig = await api('/api/config');
grafanaDashboardUrl = `${publicConfig.grafanaUrl}/d/codebase-memory-operation/codebase-memory-operacao?orgId=1`;
await Promise.all([renderGithub(), renderWorkspaces(), refreshJobs()]);
setInterval(refreshJobs, 3000);
setInterval(() => refreshKnowledgeSyncRows().catch(() => {}), 5000);
