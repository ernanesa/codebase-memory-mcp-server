import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const publicTools = ['code_search_surgical', 'get_architecture', 'get_symbol_snippet',
  'index_status', 'inspect_symbol', 'list_projects', 'trace_symbol'];

for (const missing of [false, true]) {
  test(`installer ${missing ? 'rejects an incomplete' : 'accepts the paginated public'} MCP catalog`, async t => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'cbm-install-mcp-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const tokenFile = path.join(temporary, 'token');
    await writeFile(tokenFile, 'test-system-token');
    const calls = [];
    const tools = missing ? publicTools.filter(name => name !== 'trace_symbol') : publicTools;
    const server = createServer(async (req, res) => {
      if (!req.headers.authorization) {
        res.writeHead(401).end();
        return;
      }
      assert.equal(req.headers.authorization, 'Bearer test-system-token');
      assert.equal(req.headers.host, 'mcp.test');
      if (req.method === 'DELETE') {
        calls.push('DELETE');
        res.writeHead(202).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      calls.push(message.method);
      if (message.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      let result;
      if (message.method === 'initialize') {
        res.setHeader('mcp-session-id', 'test-session');
        result = { protocolVersion: '2025-03-26', capabilities: {} };
      } else {
        assert.equal(message.method, 'tools/list');
        assert.equal(req.headers['mcp-session-id'], 'test-session');
        result = message.params.cursor
          ? { tools: tools.slice(3).map(name => ({ name })) }
          : { tools: tools.slice(0, 3).map(name => ({ name })), nextCursor: 'page-2' };
      }
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const installer = await readFile(path.join(root, 'install.sh'), 'utf8');
    const validation = installer.slice(installer.indexOf('validate_agentgateway_command()'));
    const script = validation.match(/docker_compose exec -T admin node --input-type=module -e '([\s\S]*?)\n  ' \|\|/)[1]
      .replace('/data/app/secrets/mcp-system-token', tokenFile)
      .replace('http://proxy:8080/', `http://127.0.0.1:${server.address().port}/`);
    const execute = () => run(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.join(root, 'app'), env: { ...process.env, MCP_PUBLIC_HOST: 'mcp.test' }, timeout: 10000
    });
    if (missing) {
      await assert.rejects(execute(), error => {
        assert.match(error.stderr, /MCP_CATALOG_INCOMPATIBLE/);
        assert.match(error.stderr, /ferramentas ausentes: trace_symbol\./);
        assert.doesNotMatch(error.stderr, /Atualize o binário/);
        return true;
      });
    } else {
      await execute();
    }
    assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
  });
}
