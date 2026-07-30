import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { healthPayload, nearbyPayload, openShelterStore, searchPayload } from '../lib/shelter-store.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const indexPath = join(root, 'data', 'heat-shelters.sqlite');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const PUBLIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
]);
const store = openShelterStore(indexPath);

function jsonResponse(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleApi(request, url, response) {
  if (url.pathname === '/api/shelters') {
    if (request.method !== 'POST') {
      jsonResponse(response, 405, { error: 'method_not_allowed', message: 'POST 요청만 허용해요.' }, { Allow: 'POST' });
      return true;
    }
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch {
      jsonResponse(response, 400, { error: 'invalid_json', message: '요청 형식이 올바르지 않아요.' });
      return true;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      jsonResponse(response, 400, { error: 'invalid_json', message: '요청 형식이 올바르지 않아요.' });
      return true;
    }
    let result;
    if (payload.action === 'health') result = healthPayload(store);
    else if (payload.action === 'search') result = searchPayload(store, payload);
    else if (payload.action === 'nearby') result = nearbyPayload(store, payload);
    else result = { statusCode: 400, body: { error: 'invalid_action', message: '지원하지 않는 요청이에요.' } };
    jsonResponse(response, result.statusCode, result.body);
    return true;
  }
  if (url.pathname.startsWith('/api/')) {
    jsonResponse(response, 404, { error: 'not_found' });
    return true;
  }
  return false;
}

const server = http.createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url, 'http://127.0.0.1');
    decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }
  if (await handleApi(request, url, response)) return;

  const relative = PUBLIC_FILES.get(url.pathname);
  if (!relative) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  try {
    const data = await readFile(join(root, relative));
    response.writeHead(200, {
      'Content-Type': types[extname(relative)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(data);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(4173, '127.0.0.1', () => console.log('쉬어갈지도: http://127.0.0.1:4173'));
