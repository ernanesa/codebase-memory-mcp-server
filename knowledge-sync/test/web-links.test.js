import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLinkDocument, extractTextContent, fetchWebLink, isPublicIpAddress, normalizeWebLink, validateWebLinkDestination, webLinkSourceKey } from '../src/web-links.js';

test('normaliza URLs e bloqueia protocolos, credenciais e endereços privados', async () => {
  assert.equal(normalizeWebLink(' https://example.com/docs#parte '), 'https://example.com/docs');
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://localhost/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://10.0.0.1/a']) {
    assert.throws(() => normalizeWebLink(url));
  }
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('192.168.1.1'), false);
  assert.equal(isPublicIpAddress('2001:4860:4860::8888'), true);
  assert.equal(isPublicIpAddress('fc00::1'), false);
  assert.equal(isPublicIpAddress('2002:0a00:0001::1'), false);
  assert.equal(webLinkSourceKey('https://example.com/docs#x'), webLinkSourceKey('https://example.com/docs'));
  await assert.rejects(validateWebLinkDestination('https://127.0.0.1/path'), /privadas|reservadas/);
  await assert.rejects(validateWebLinkDestination('https://internal.example/path', { lookup: async () => [{ address: '10.0.0.8', family: 4 }] }), /privada|reservada/);
  assert.equal(await validateWebLinkDestination('https://public.example/path', { lookup: async () => [{ address: '8.8.8.8', family: 4 }] }), 'https://public.example/path');
});

test('extrai HTML principal, formata JSON e rejeita binários ou conteúdo vazio', () => {
  const html = extractTextContent(Buffer.from('<html><head><title>API X</title><style>x</style></head><body><nav>menu</nav><main><h1>Rotas</h1><p>Use /v1.</p></main></body></html>'), 'text/html; charset=utf-8', 'https://example.com');
  assert.equal(html.title, 'API X');
  assert.match(html.text, /Rotas\nUse \/v1/);
  assert.doesNotMatch(html.text, /menu/);
  const json = extractTextContent(Buffer.from('{"openapi":"3.1.0"}'), 'application/json', 'https://example.com/openapi.json');
  assert.match(json.text, /\n  "openapi": "3\.1\.0"\n/);
  assert.throws(() => extractTextContent(Buffer.from([0, 1, 2]), 'application/pdf', 'https://example.com/a.pdf'), /não suportado/);
  assert.throws(() => extractTextContent(Buffer.from('  '), 'text/plain', 'https://example.com/empty'), /útil/);
});

test('monta documento com descrição indexável e checksum sensível ao contexto', () => {
  const fetched = { title: 'API X', text: 'GET /v1', mimeType: 'application/json' };
  const first = buildLinkDocument({ url: 'https://example.com/openapi.json', description: 'Ambiente Y' }, fetched);
  const second = buildLinkDocument({ url: 'https://example.com/openapi.json', description: 'Ambiente Z' }, fetched);
  assert.match(first.content.toString(), /Descrição: Ambiente Y/);
  assert.notEqual(first.checksum, second.checksum);
});

test('segue redirecionamento HTTPS, envia validadores e trata 304', async () => {
  const calls = [];
  const responses = [
    { status: 302, headers: { location: 'https://cdn.example.com/doc.json' }, body: Buffer.alloc(0) },
    { status: 200, headers: { 'content-type': 'application/json', etag: '"v2"' }, body: Buffer.from('{"ok":true}') }
  ];
  const fetched = await fetchWebLink('https://example.com/doc', {
    etag: '"v1"',
    transport: async (url, headers) => { calls.push({ url: url.toString(), headers: { ...headers } }); return responses.shift(); }
  });
  assert.equal(fetched.finalUrl, 'https://cdn.example.com/doc.json');
  assert.equal(fetched.etag, '"v2"');
  assert.equal(calls[0].headers['if-none-match'], '"v1"');
  assert.equal(calls.length, 2);
  const unchanged = await fetchWebLink('https://example.com/doc', {
    lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT',
    transport: async (_url, headers) => ({ status: 304, headers: { 'last-modified': headers['if-modified-since'] }, body: Buffer.alloc(0) })
  });
  assert.equal(unchanged.notModified, true);
  await assert.rejects(fetchWebLink('https://example.com/doc', {
    transport: async () => ({ status: 302, headers: { location: 'https://127.0.0.1/private' }, body: Buffer.alloc(0) })
  }), /privadas|reservadas/);
});
