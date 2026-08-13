import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

export const WEB_LINK_ROOT = 'Links (gerenciados)';
export const DEFAULT_LINK_TIMEOUT_MS = 30_000;
export const DEFAULT_LINK_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LINK_MAX_REDIRECTS = 5;
export const MAX_LINK_DESCRIPTION_LENGTH = 2_000;

function ipv4Parts(address) {
  if (net.isIP(address) !== 4) return null;
  return address.split('.').map(Number);
}

function ipv6Value(address) {
  if (net.isIP(address) !== 6) return null;
  let source = address.toLowerCase().split('%')[0];
  const mapped = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(source);
  if (mapped) {
    const octets = ipv4Parts(mapped[2]);
    source = `${mapped[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [leftSource, rightSource = ''] = source.split('::');
  const left = leftSource ? leftSource.split(':') : [];
  const right = rightSource ? rightSource.split(':') : [];
  const zeros = source.includes('::') ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array(zeros).fill('0'), ...right];
  if (parts.length !== 8) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(Number.parseInt(part || '0', 16)), 0n);
}

function inCidr(value, prefix, bits) {
  const shift = BigInt(128 - bits);
  return (value >> shift) === (prefix >> shift);
}

export function isPublicIpAddress(address) {
  const ipv4 = ipv4Parts(address);
  if (ipv4) {
    const [a, b] = ipv4;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && [18, 19].includes(b))
      || (a === 198 && b === 51 && ipv4[2] === 100)
      || (a === 203 && b === 0 && ipv4[2] === 113));
  }
  const ipv6 = ipv6Value(address);
  if (ipv6 === null) return false;
  const prefixes = [
    ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
    ['64:ff9b:1::', 48],
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
  ];
  if (prefixes.some(([prefix, bits]) => inCidr(ipv6, ipv6Value(prefix), bits))) return false;
  const mappedPrefix = ipv6Value('::ffff:0:0');
  if (inCidr(ipv6, mappedPrefix, 96)) {
    const value = Number(ipv6 & 0xffffffffn);
    return isPublicIpAddress(`${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`);
  }
  const sixToFourPrefix = ipv6Value('2002::');
  if (inCidr(ipv6, sixToFourPrefix, 16)) {
    const embedded = Number((ipv6 >> 80n) & 0xffffffffn);
    return isPublicIpAddress(`${embedded >>> 24}.${(embedded >>> 16) & 255}.${(embedded >>> 8) & 255}.${embedded & 255}`);
  }
  return true;
}

export function normalizeWebLink(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); }
  catch { throw new Error('Informe uma URL válida para o link.'); }
  if (parsed.protocol !== 'https:') throw new Error('Links devem usar HTTPS.');
  if (parsed.username || parsed.password) throw new Error('Links não podem conter credenciais na URL.');
  if (!parsed.hostname) throw new Error('O link deve possuir um hostname.');
  if (['localhost', 'localhost.localdomain'].includes(parsed.hostname.toLowerCase()) || parsed.hostname.toLowerCase().endsWith('.localhost')) {
    throw new Error('Links para endereços locais não são permitidos.');
  }
  const addressHost = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(addressHost) && !isPublicIpAddress(addressHost)) throw new Error('Links para redes privadas ou reservadas não são permitidos.');
  parsed.hash = '';
  return parsed.toString();
}

export function normalizeLinkInput(link) {
  const url = normalizeWebLink(link?.url);
  const description = String(link?.description || '').trim();
  if (description.length > MAX_LINK_DESCRIPTION_LENGTH) throw new Error(`A descrição do link deve ter no máximo ${MAX_LINK_DESCRIPTION_LENGTH} caracteres.`);
  return { url, description };
}

export function webLinkSourceKey(url) {
  return `link:${createHash('sha256').update(normalizeWebLink(url)).digest('hex')}`;
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10;
      const number = Number.parseInt(entity.slice(radix === 16 ? 2 : 1), radix);
      return Number.isFinite(number) ? String.fromCodePoint(number) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function cleanText(value) {
  return decodeEntities(value)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToText(html) {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const withoutNoise = html
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(withoutNoise)?.[2]
    || /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(withoutNoise)?.[1]
    || withoutNoise;
  const text = cleanText(main
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|header|footer|nav|aside|li|tr|h[1-6]|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
  return { title: cleanText(titleMatch?.[1] || ''), text };
}

function responseCharset(contentType) {
  return /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]?.toLowerCase() || 'utf-8';
}

export function extractTextContent(buffer, contentType, url) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  const textual = mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json')
    || ['application/xml', 'application/xhtml+xml'].includes(mime) || mime.endsWith('+xml');
  if (!textual) throw new Error(`Tipo de conteúdo não suportado para links: ${mime || 'desconhecido'}.`);
  let decoded;
  try { decoded = new TextDecoder(responseCharset(contentType), { fatal: true }).decode(buffer); }
  catch { throw new Error('O link não retornou conteúdo textual válido.'); }
  let title = '';
  let text = decoded;
  let preserveFormatting = false;
  if (mime === 'text/html' || mime === 'application/xhtml+xml') ({ title, text } = htmlToText(decoded));
  else if (mime === 'application/json' || mime.endsWith('+json')) {
    try { text = JSON.stringify(JSON.parse(decoded), null, 2); }
    catch { throw new Error('O link declarou JSON, mas retornou um documento inválido.'); }
    preserveFormatting = true;
  }
  text = preserveFormatting ? text.trim() : cleanText(text);
  if (!text) throw new Error('O link não retornou conteúdo textual útil.');
  const parsed = new URL(url);
  return { title: title || `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`, text, mimeType: mime };
}

function documentFilename(title, url) {
  const parsed = new URL(url);
  const base = String(title || parsed.pathname.split('/').filter(Boolean).at(-1) || parsed.hostname)
    .replace(/[\x00-\x1f/\\:?*<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'link';
  return base.toLowerCase().endsWith('.txt') ? base : `${base}.txt`;
}

export function buildLinkDocument(link, fetched) {
  const sections = [`Fonte: ${link.url}`, `Título: ${fetched.title}`];
  if (link.description) sections.push(`Descrição: ${link.description}`);
  sections.push('', 'Conteúdo:', fetched.text);
  const content = Buffer.from(`${sections.join('\n')}\n`);
  return {
    content,
    filename: documentFilename(fetched.title, link.url),
    originalName: fetched.title,
    checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`
  };
}

async function resolvePublicHost(hostname, lookup = dns.lookup) {
  const addressHost = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(addressHost)) return [{ address: addressHost, family: net.isIP(addressHost) }];
  let addresses;
  try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
  catch (error) { throw new Error(`Não foi possível resolver o host do link: ${error.message}`); }
  if (!addresses.length || addresses.some(item => !isPublicIpAddress(item.address))) {
    throw new Error('O host do link resolve para uma rede privada ou reservada.');
  }
  return addresses;
}

export async function validateWebLinkDestination(url, options = {}) {
  const normalized = new URL(normalizeWebLink(url));
  await resolvePublicHost(normalized.hostname, options.lookup || dns.lookup);
  return normalized.toString();
}

function requestOnce(url, headers, timeoutMs, maxBytes) {
  return new Promise(async (resolve, reject) => {
    let addresses;
    try { addresses = await resolvePublicHost(url.hostname); }
    catch (error) { reject(error); return; }
    const selected = addresses[0];
    const request = https.request(url, {
      method: 'GET',
      headers: { accept: 'text/html, application/json, application/xml, text/plain, text/markdown, */*;q=0.1', 'user-agent': 'Codebase-Memory-Knowledge-Sync/1.0', ...headers },
      lookup: (_hostname, lookupOptions, callback) => lookupOptions?.all
        ? callback(null, addresses)
        : callback(null, selected.address, selected.family)
    }, response => {
      const contentLength = Number(response.headers['content-length'] || 0);
      if (contentLength > maxBytes) {
        response.destroy();
        reject(new Error(`O conteúdo do link excede o limite de ${maxBytes} bytes.`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(new Error(`O conteúdo do link excede o limite de ${maxBytes} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`A coleta do link excedeu ${timeoutMs} ms.`)));
    request.on('error', reject);
    request.end();
  });
}

export async function fetchWebLink(configuredUrl, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_LINK_TIMEOUT_MS;
  const maxBytes = options.maxBytes || DEFAULT_LINK_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_LINK_MAX_REDIRECTS;
  const conditionalHeaders = {};
  if (options.etag) conditionalHeaders['if-none-match'] = options.etag;
  if (options.lastModified) conditionalHeaders['if-modified-since'] = options.lastModified;
  let current = new URL(normalizeWebLink(configuredUrl));
  const transport = options.transport || requestOnce;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await transport(current, conditionalHeaders, timeoutMs, maxBytes);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirect === maxRedirects) throw new Error(`O link excedeu o limite de ${maxRedirects} redirecionamentos.`);
      const location = response.headers.location;
      if (!location) throw new Error('O link retornou um redirecionamento sem destino.');
      current = new URL(normalizeWebLink(new URL(location, current).toString()));
      continue;
    }
    if (response.status === 304) return { notModified: true, finalUrl: current.toString(), etag: response.headers.etag || options.etag || null, lastModified: response.headers['last-modified'] || options.lastModified || null };
    if (response.status < 200 || response.status >= 300) throw new Error(`O link respondeu HTTP ${response.status}.`);
    const extracted = extractTextContent(response.body, response.headers['content-type'], current.toString());
    return {
      ...extracted,
      finalUrl: current.toString(),
      etag: response.headers.etag || null,
      lastModified: response.headers['last-modified'] || null,
      size: response.body.length
    };
  }
  throw new Error('Não foi possível coletar o link.');
}
