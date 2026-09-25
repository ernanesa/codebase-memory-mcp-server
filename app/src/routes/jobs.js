import { json } from '../http.js';
import { JOB_HISTORY_RETENTION_DAYS, paginateJobs } from '../job-history.js';

/**
 * Registra a rota de listagem de jobs no roteador.
 * @param {object} router
 * @param {object} ctx
 * @param {Array<object>} ctx.jobs
 * @param {() => boolean} ctx.retainRecentJobs
 * @param {() => void} ctx.scheduleJobHistoryPersistence
 */
export function register(router, ctx) {
  router.add('GET', '/api/jobs', async (request, response, url, params) => {
    if (ctx.retainRecentJobs()) {
      ctx.scheduleJobHistoryPersistence();
    }
    const page = url?.searchParams?.get('page');
    const pageSize = url?.searchParams?.get('pageSize');
    const result = paginateJobs(ctx.jobs, { page, pageSize });
    const activeCount = (ctx.jobs || []).filter(job => ['queued', 'running'].includes(job?.status)).length;

    return json(response, 200, {
      ...result,
      activeCount,
      retentionDays: JOB_HISTORY_RETENTION_DAYS
    });
  });
}
