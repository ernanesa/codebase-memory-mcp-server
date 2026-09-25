import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/router.js';
import { register } from '../src/routes/jobs.js';
import { JOB_HISTORY_RETENTION_DAYS } from '../src/job-history.js';

function createMockResponse() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(data) {
      this.body = data;
    }
  };
}

test('register registra rota GET /api/jobs no roteador', () => {
  const router = createRouter();
  const ctx = {
    jobs: [],
    retainRecentJobs: () => false,
    scheduleJobHistoryPersistence: () => {}
  };

  register(router, ctx);

  const match = router.match('GET', '/api/jobs');
  assert.ok(match, 'Rota GET /api/jobs deve ser encontrada');
  assert.equal(typeof match.handler, 'function');
});

test('handler de GET /api/jobs pagina dados, conta jobs ativos e inclui retentionDays', async () => {
  const router = createRouter();
  let persistenceScheduled = false;
  let retentionCalled = false;

  const sampleJobs = [
    { id: '1', status: 'queued' },
    { id: '2', status: 'running' },
    { id: '3', status: 'completed' },
    { id: '4', status: 'failed' },
    { id: '5', status: 'running' }
  ];

  const ctx = {
    jobs: sampleJobs,
    retainRecentJobs: () => {
      retentionCalled = true;
      return true;
    },
    scheduleJobHistoryPersistence: () => {
      persistenceScheduled = true;
    }
  };

  register(router, ctx);
  const match = router.match('GET', '/api/jobs');

  const res = createMockResponse();
  const url = new URL('http://localhost/api/jobs?page=1&pageSize=2');

  await match.handler({}, res, url, match.params);

  assert.equal(retentionCalled, true);
  assert.equal(persistenceScheduled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');

  const payload = JSON.parse(res.body);
  assert.equal(payload.activeCount, 3);
  assert.equal(payload.retentionDays, JOB_HISTORY_RETENTION_DAYS);
  assert.equal(payload.jobs.length, 2);
  assert.deepEqual(payload.jobs.map(j => j.id), ['1', '2']);
  assert.deepEqual(payload.pagination, {
    page: 1,
    pageSize: 2,
    total: 5,
    totalPages: 3
  });
});

test('handler de GET /api/jobs não agenda persistência se retainRecentJobs retornar falso', async () => {
  const router = createRouter();
  let persistenceScheduled = false;

  const ctx = {
    jobs: [{ id: '1', status: 'completed' }],
    retainRecentJobs: () => false,
    scheduleJobHistoryPersistence: () => {
      persistenceScheduled = true;
    }
  };

  register(router, ctx);
  const match = router.match('GET', '/api/jobs');

  const res = createMockResponse();
  const url = new URL('http://localhost/api/jobs');

  await match.handler({}, res, url, match.params);

  assert.equal(persistenceScheduled, false);
  assert.equal(res.statusCode, 200);

  const payload = JSON.parse(res.body);
  assert.equal(payload.activeCount, 0);
  assert.equal(payload.retentionDays, 7);
  assert.equal(payload.jobs.length, 1);
});
