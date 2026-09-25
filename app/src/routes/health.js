import { json, textResponse } from '../http.js';
import { metricsText, log as structuredLog } from '../observability.js';

/**
 * Executa uma requisição de health check para uma URL com timeout de 3 segundos.
 * @param {string} name
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<{ name: string, ok: boolean, status?: number, error?: string, durationMs: number }>}
 */
async function probe(name, url, options = {}) {
  const started = performance.now();
  try {
    const result = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(3_000) });
    return {
      name,
      ok: result.status < 500,
      status: result.status,
      durationMs: Math.round(performance.now() - started)
    };
  } catch (error) {
    return {
      name,
      ok: false,
      error: error.message,
      durationMs: Math.round(performance.now() - started)
    };
  }
}

/**
 * Verifica a saúde das dependências do sistema (AgentGateway e opcionalmente Knowledge-Sync).
 * @param {object} ctx
 * @returns {Promise<{ status: 'ready'|'not_ready', checks: Array<{ name: string, ok: boolean, status?: number, error?: string, durationMs: number }> }>}
 */
async function dependencyHealth(ctx) {
  const { AGENTGATEWAY_ADMIN_URL, KNOWLEDGE_SYNC_ENABLED, KNOWLEDGE_SYNC_URL } = ctx.config;
  const checks = await Promise.all([
    probe('agentgateway', `${AGENTGATEWAY_ADMIN_URL}/`),
    ...(KNOWLEDGE_SYNC_ENABLED ? [probe('knowledge-sync', `${KNOWLEDGE_SYNC_URL}/health/ready`)] : [])
  ]);
  return { status: checks.every(check => check.ok) ? 'ready' : 'not_ready', checks };
}

/**
 * Registra as rotas de health check, métricas e configuração.
 * @param {{ add: (method: string, path: string, handler: Function) => void }} router
 * @param {object} ctx
 */
export function register(router, ctx) {
  if (!router || typeof router.add !== 'function') {
    throw new TypeError('Roteador inválido fornecido para registro de rotas.');
  }
  if (!ctx || !ctx.config) {
    throw new TypeError('Contexto com configuração é obrigatório.');
  }

  const handleHealth = async (request, response, url, params) => {
    return json(response, 200, { status: 'ok' });
  };

  const handleHealthReady = async (request, response, url, params) => {
    const health = await dependencyHealth(ctx);
    return json(response, health.status === 'ready' ? 200 : 503, health);
  };

  const handleMetrics = async (request, response, url, params) => {
    let combined = metricsText();
    if (ctx.config.KNOWLEDGE_SYNC_ENABLED) {
      try {
        const worker = await fetch(`${ctx.config.KNOWLEDGE_SYNC_URL}/metrics`, {
          signal: AbortSignal.timeout(3_000)
        });
        if (worker.ok) {
          combined += await worker.text();
        }
      } catch (error) {
        structuredLog('warn', 'worker_metrics_unavailable', { error: error.message });
      }
    }
    return textResponse(response, 200, combined, 'text/plain; version=0.0.4; charset=utf-8');
  };

  const handleConfig = async (request, response, url, params) => {
    return json(response, 200, {
      uiPort: ctx.config.UI_PORT,
      knowledgeSyncEnabled: ctx.config.KNOWLEDGE_SYNC_ENABLED,
      grafanaUrl: ctx.config.GRAFANA_PUBLIC_URL,
      mcpUrl: ctx.config.MCP_PUBLIC_URL
    });
  };

  router.add('GET', '/api/health', handleHealth);
  router.add('GET', '/api/health/live', handleHealth);
  router.add('GET', '/api/health/ready', handleHealthReady);
  router.add('GET', '/api/health/detail', handleHealthReady);
  router.add('GET', '/api/metrics', handleMetrics);
  router.add('GET', '/api/config', handleConfig);
}
