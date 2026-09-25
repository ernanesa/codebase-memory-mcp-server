import { json, body } from '../http.js';

/**
 * Registra as rotas de sincronização com o Google Drive (knowledge-sync) no roteador.
 *
 * @param {object} router - Instância do roteador da aplicação.
 * @param {object} ctx - Contexto contendo métodos e integrações de sincronização.
 * @param {(pathname: string, options?: { method?: string, payload?: unknown }) => Promise<{ status: number, result: unknown }>} ctx.knowledgeSyncRequest
 * @param {(value: unknown) => object} ctx.validateGoogleServiceAccount
 * @param {(credentials: object) => Promise<void>} ctx.saveGoogleServiceAccount
 * @param {() => Promise<void>} ctx.removeGoogleServiceAccount
 */
export function register(router, ctx) {
  // 1. Obter status das credenciais do worker
  router.add('GET', '/api/knowledge-sync/credentials', async (request, response, url, params) => {
    const result = await ctx.knowledgeSyncRequest('/api/status');
    return json(response, result.status, result.result);
  });

  // 2. Validar e salvar credenciais do Google Service Account, retornando status atualizado
  router.add('PUT', '/api/knowledge-sync/credentials', async (request, response, url, params) => {
    const payload = await body(request);
    const credentials = ctx.validateGoogleServiceAccount(payload.credentials ?? payload);
    await ctx.saveGoogleServiceAccount(credentials);
    const result = await ctx.knowledgeSyncRequest('/api/status');
    return json(response, 200, result.result);
  });

  // 3. Notificar worker da remoção, excluir arquivo de credenciais e retornar status atualizado
  router.add('DELETE', '/api/knowledge-sync/credentials', async (request, response, url, params) => {
    await ctx.knowledgeSyncRequest('/api/targets/drive-credentials-removed', { method: 'POST', payload: {} });
    await ctx.removeGoogleServiceAccount();
    const status = await ctx.knowledgeSyncRequest('/api/status');
    return json(response, 200, status.result);
  });

  // 4. Proxy catch-all para requisições do knowledge-sync
  // IMPORTANTE: Deve ser registrado após as rotas de credenciais específicas para respeitar a precedência do roteador.
  router.prefix('*', '/api/knowledge-sync', async (request, response, url, params) => {
    const search = url?.search || '';
    const workerPath = `/api${url.pathname.slice('/api/knowledge-sync'.length)}${search}`;
    const method = request.method ? request.method.toUpperCase() : 'GET';
    const payload = ['POST', 'PUT', 'PATCH'].includes(method) ? await body(request) : undefined;
    const result = await ctx.knowledgeSyncRequest(workerPath, { method: request.method, payload });
    return json(response, result.status, result.result);
  });
}
