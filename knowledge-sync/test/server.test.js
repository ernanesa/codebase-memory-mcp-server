import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function freePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw lastError;
}

test('worker mantém arquivos de uma pasta dentro da Knowledge Base vinculada', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'knowledge-sync-worker-'));
  const apiToken = 'token-interno-de-teste';
  const uploads = [];
  const cleanups = [];
  let modifiedTime = '2026-01-01T00:00:00Z';
  let fileContent = 'primeira versão';
  let driveRevision = 0;
  let folderScans = 0;
  let uploadSequence = 0;
  let directorySequence = 0;
  let activeUploads = 0;
  let maxConcurrentUploads = 0;
  let pickerConfig = {
    'google_drive.enable': false,
    'google_drive.client_id': '',
    'google_drive.api_key': ''
  };

  const googleServer = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://google.test');
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && url.pathname === '/token') {
      response.end(JSON.stringify({ access_token: 'google-token', expires_in: 3600 }));
      return;
    }
    if (url.pathname === '/drive/v3/changes/startPageToken') {
      response.end(JSON.stringify({ startPageToken: String(driveRevision) }));
      return;
    }
    if (url.pathname === '/drive/v3/changes') {
      const changed = Number(url.searchParams.get('pageToken')) < driveRevision;
      response.end(JSON.stringify({
        changes: changed ? [{ fileId: 'file-A', file: { id: 'file-A', name: 'manual.txt', mimeType: 'text/plain', modifiedTime, size: String(fileContent.length), parents: ['folder-A'], trashed: false, webViewLink: 'https://drive.google.com/file/d/file-A/view' } }] : [],
        newStartPageToken: String(driveRevision)
      }));
      return;
    }
    if (url.pathname === '/drive/v3/files/folder-A' || url.pathname === '/drive/v3/files/folder-B') {
      const id = url.pathname.endsWith('folder-B') ? 'folder-B' : 'folder-A';
      response.end(JSON.stringify({ id, name: id === 'folder-B' ? 'Pasta B' : 'Pasta A', mimeType: 'application/vnd.google-apps.folder', parents: [], trashed: false }));
      return;
    }
    if (url.pathname === '/drive/v3/files/file-A' && url.searchParams.get('alt') === 'media') {
      response.setHeader('content-type', 'text/plain');
      response.end(fileContent);
      return;
    }
    if (url.pathname === '/drive/v3/files/file-A') {
      response.end(JSON.stringify({ id: 'file-A', name: 'manual.txt', mimeType: 'text/plain', modifiedTime, size: String(fileContent.length), parents: ['folder-A'], trashed: false, webViewLink: 'https://drive.google.com/file/d/file-A/view' }));
      return;
    }
    if (url.pathname === '/drive/v3/files/file-B' && url.searchParams.get('alt') === 'media') {
      response.setHeader('content-type', 'text/plain');
      response.end('arquivo da base B');
      return;
    }
    if (url.pathname === '/drive/v3/files') {
      const query = url.searchParams.get('q') || '';
      if (query.includes("'folder-A' in parents")) {
        folderScans += 1;
        response.end(JSON.stringify({ files: [{ id: 'file-A', name: 'manual.txt', mimeType: 'text/plain', modifiedTime, size: String(fileContent.length), parents: ['folder-A'], trashed: false, webViewLink: 'https://drive.google.com/file/d/file-A/view' }] }));
      } else if (query.includes("'folder-B' in parents")) {
        folderScans += 1;
        response.end(JSON.stringify({ files: [{ id: 'file-B', name: 'base-b.txt', mimeType: 'text/plain', modifiedTime: '2026-01-03T00:00:00Z', size: '17', parents: ['folder-B'], trashed: false, webViewLink: 'https://drive.google.com/file/d/file-B/view' }] }));
      } else {
        response.end(JSON.stringify({ files: [
          { id: 'folder-A', name: 'Pasta A', mimeType: 'application/vnd.google-apps.folder', parents: [], trashed: false },
          { id: 'folder-B', name: 'Pasta B', mimeType: 'application/vnd.google-apps.folder', parents: [], trashed: false }
        ] }));
      }
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  const googleUrl = await listen(googleServer);

  const openwebuiServer = createServer(async (request, response) => {
    let raw = Buffer.alloc(0);
    for await (const chunk of request) raw = Buffer.concat([raw, chunk]);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v1/auths/signin') {
      response.end(JSON.stringify({ token: 'openwebui-token' }));
      return;
    }
    if (request.url === '/api/v1/configs/import') {
      pickerConfig = { ...pickerConfig, ...JSON.parse(raw.toString('utf8')).config };
      response.end(JSON.stringify(pickerConfig));
      return;
    }
    if (request.url === '/api/config') {
      response.end(JSON.stringify({
        features: { enable_google_drive_integration: pickerConfig['google_drive.enable'] },
        google_drive: {
          client_id: pickerConfig['google_drive.client_id'],
          api_key: pickerConfig['google_drive.api_key']
        }
      }));
      return;
    }
    if (request.url === '/api/v1/knowledge/?page=1') {
      response.end(JSON.stringify({ items: [
        { id: 'kb-A', name: 'Base A', description: '', write_access: true },
        { id: 'kb-B', name: 'Base B', description: '', write_access: true }
      ], total: 2 }));
      return;
    }
    if (/^\/api\/v1\/knowledge\/kb-[AB]\/dirs\/create$/.test(request.url)) {
      directorySequence += 1;
      response.end(JSON.stringify({ id: `dir-${directorySequence}` }));
      return;
    }
    if (request.url === '/api/v1/files/') {
      activeUploads += 1;
      maxConcurrentUploads = Math.max(maxConcurrentUploads, activeUploads);
      await new Promise(resolve => setTimeout(resolve, 40));
      uploadSequence += 1;
      uploads.push(raw.toString('utf8'));
      activeUploads -= 1;
      response.end(JSON.stringify({ id: `uploaded-${uploadSequence}` }));
      return;
    }
    if (request.url === '/api/v1/knowledge/kb-A/sync/cleanup') {
      cleanups.push(JSON.parse(raw.toString('utf8')));
      response.end(JSON.stringify({ status: true }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: 'not found' }));
  });
  const openwebuiUrl = await listen(openwebuiServer);

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentialsFile = path.join(temporaryRoot, 'service-account.json');
  const tokenFile = path.join(temporaryRoot, 'api-token');
  const credentials = {
    type: 'service_account',
    client_email: 'sync@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: `${googleUrl}/token`
  };
  await writeFile(tokenFile, `${apiToken}\n`);

  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      SYNC_DATA_DIR: temporaryRoot,
      GOOGLE_APPLICATION_CREDENTIALS: credentialsFile,
      KNOWLEDGE_SYNC_TOKEN_FILE: tokenFile,
      GOOGLE_API_URL: googleUrl,
      OPENWEBUI_URL: openwebuiUrl,
      WEBUI_ADMIN_EMAIL: 'admin@example.com',
      WEBUI_ADMIN_PASSWORD: 'senha-secreta'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let childOutput = '';
  child.stdout.on('data', chunk => { childOutput += chunk; });
  child.stderr.on('data', chunk => { childOutput += chunk; });
  const workerUrl = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' };

  try {
    await waitFor(`${workerUrl}/health`);
    let response = await fetch(`${workerUrl}/api/picker-config`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        clientId: 'picker.apps.googleusercontent.com',
        apiKey: 'AIza12345678901234567890'
      })
    });
    assert.equal(response.status, 200, await response.text());
    let picker = await fetch(`${workerUrl}/api/picker-config`, { headers }).then(value => value.json());
    assert.deepEqual(picker, {
      enabled: true,
      configured: true,
      clientId: 'picker.apps.googleusercontent.com',
      apiKeyConfigured: true,
      apiKeySuffix: '7890'
    });
    assert.equal('apiKey' in picker, false);

    response = await fetch(`${workerUrl}/api/picker-config`, { method: 'DELETE', headers });
    assert.equal(response.status, 200);
    picker = await response.json();
    assert.equal(picker.enabled, false);

    let status = await fetch(`${workerUrl}/api/status`, { headers }).then(value => value.json());
    assert.equal(status.configured, false);

    await writeFile(credentialsFile, JSON.stringify(credentials));
    response = await fetch(`${workerUrl}/api/credentials/test`, { method: 'POST', headers });
    assert.equal(response.status, 200, await response.text());
    status = await fetch(`${workerUrl}/api/status`, { headers }).then(value => value.json());
    assert.equal(status.configured, true);
    assert.equal(status.serviceAccountEmail, credentials.client_email);

    response = await fetch(`${workerUrl}/api/targets/kb-A`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ knowledgeBaseName: 'Base A', folders: [{ id: 'folder-A', name: 'Pasta A' }], cron: '30 * * * *', timezone: 'America/Maceio' })
    });
    const configuredBody = await response.text();
    assert.equal(response.status, 200, configuredBody);
    const configured = JSON.parse(configuredBody);
    assert.equal(configured.target.cron, '30 * * * *');
    assert.equal(configured.target.timezone, 'America/Maceio');
    assert.equal(configured.target.scheduleDescription, 'A cada hora, no minuto 30');

    response = await fetch(`${workerUrl}/api/targets/kb-A/run`, { method: 'POST', headers });
    assert.equal(response.status, 202);
    await waitFor(`${workerUrl}/api/targets`, { headers }).then(async current => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const target = (await current.clone().json()).targets?.[0];
        if (target?.lastRunStatus === 'completed' && !target.running) return;
        await new Promise(resolve => setTimeout(resolve, 25));
        current = await fetch(`${workerUrl}/api/targets`, { headers });
      }
      throw new Error('Primeira sincronização não terminou.');
    });
    assert.equal(uploads.length, 1);
    assert.match(uploads[0], /"knowledge_id":"kb-A"/);
    assert.match(uploads[0], /manual\.txt/);
    assert.match(uploads[0], /"source":"google-drive"/);
    assert.match(uploads[0], /"source_url":"https:\/\/drive\.google\.com\/file\/d\/file-A\/view"/);
    assert.match(uploads[0], /"original_name":"manual\.txt"/);
    const managed = await fetch(`${workerUrl}/api/targets/kb-A/files`, { headers }).then(value => value.json());
    assert.equal(managed.files.length, 1);
    assert.equal(managed.files[0].status, 'indexed');
    assert.equal(managed.files[0].filename, 'manual.txt');

    response = await fetch(`${workerUrl}/api/targets/kb-A/files/${encodeURIComponent(managed.files[0].sourceKey)}/reprocess`, { method: 'POST', headers });
    assert.equal(response.status, 202, await response.text());
    for (let attempt = 0; attempt < 100 && uploads.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(uploads.length, 2);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await fetch(`${workerUrl}/api/targets`, { headers }).then(value => value.json());
      if (!current.targets[0]?.running) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    modifiedTime = '2026-01-02T00:00:00Z';
    fileContent = 'segunda versão';
    driveRevision += 1;
    response = await fetch(`${workerUrl}/api/targets/kb-A/run`, { method: 'POST', headers });
    assert.equal(response.status, 202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await fetch(`${workerUrl}/api/targets`, { headers }).then(value => value.json());
      if (current.targets[0]?.lastRunSummary?.modified === 1 && !current.targets[0].running) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(uploads.length, 3);
    assert.deepEqual(cleanups, [{ file_ids: ['uploaded-1'], dir_ids: [] }, { file_ids: ['uploaded-2'], dir_ids: [] }]);

    const scansBeforeFastPath = folderScans;
    const targetBeforeFastPath = await fetch(`${workerUrl}/api/targets`, { headers }).then(value => value.json());
    response = await fetch(`${workerUrl}/api/targets/kb-A/run`, { method: 'POST', headers });
    assert.equal(response.status, 202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await fetch(`${workerUrl}/api/targets`, { headers }).then(value => value.json());
      if (current.targets[0]?.lastRunAt !== targetBeforeFastPath.targets[0].lastRunAt && !current.targets[0].running) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(folderScans, scansBeforeFastPath, 'sem mudanças, a Changes API deve evitar nova varredura de pastas');
    assert.equal(uploads.length, 3);

    response = await fetch(`${workerUrl}/api/targets/kb-B`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ knowledgeBaseName: 'Base B', folders: [{ id: 'folder-B', name: 'Pasta B' }], cron: '30 * * * *', timezone: 'America/Maceio' })
    });
    assert.equal(response.status, 200, await response.text());
    modifiedTime = '2026-01-04T00:00:00Z';
    fileContent = 'terceira versão';
    driveRevision += 1;
    maxConcurrentUploads = 0;
    const [runA, runB] = await Promise.all([
      fetch(`${workerUrl}/api/targets/kb-A/run`, { method: 'POST', headers }),
      fetch(`${workerUrl}/api/targets/kb-B/run`, { method: 'POST', headers })
    ]);
    assert.equal(runA.status, 202);
    assert.equal(runB.status, 202);
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const current = await fetch(`${workerUrl}/api/targets`, { headers }).then(value => value.json());
      if (current.targets.length === 2 && current.targets.every(target => target.lastRunStatus === 'completed' && !target.running)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(uploads.length, 5);
    assert.equal(maxConcurrentUploads, 1, 'uploads de bases diferentes devem usar a fila sequencial');
  } catch (error) {
    error.message += `\nWorker output:\n${childOutput}`;
    throw error;
  } finally {
    child.kill('SIGTERM');
    await Promise.all([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => googleServer.close(resolve)),
      new Promise(resolve => openwebuiServer.close(resolve))
    ]);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
