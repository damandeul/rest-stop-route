import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = dirname(fileURLToPath(import.meta.url));
const indexPath = join(root, 'data', 'heat-shelters.sqlite');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
const SOURCE_URL = 'https://www.safetydata.go.kr/disaster-data/view?dataSn=1338';
const AIRCON_VALUES = new Set(['true', 'false', 'unknown']);
const MAX_RADIUS_KM = 20;
const MAX_LIMIT = 50;
const PUBLIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
]);

let database = null;
let metadata = {};
if (existsSync(indexPath)) {
  database = new DatabaseSync(indexPath, { readOnly: true });
  metadata = Object.fromEntries(database.prepare('SELECT key, value FROM metadata').all().map(({ key, value }) => [key, value]));
}

function jsonResponse(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function validationError(searchParams) {
  const latValue = searchParams.get('lat');
  const lonValue = searchParams.get('lon');
  if (latValue === null || latValue.trim() === '') return 'lat은 필수입니다.';
  if (lonValue === null || lonValue.trim() === '') return 'lon은 필수입니다.';
  const lat = Number(latValue);
  const lon = Number(lonValue);
  const radiusKm = Number(searchParams.get('radiusKm') ?? '2');
  const limit = Number(searchParams.get('limit') ?? '10');
  const aircon = searchParams.get('aircon');
  const candidateOnly = searchParams.get('candidateOnly');
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return 'lat은 -90~90 사이 숫자여야 합니다.';
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return 'lon은 -180~180 사이 숫자여야 합니다.';
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > MAX_RADIUS_KM) return `radiusKm는 0보다 크고 ${MAX_RADIUS_KM} 이하여야 합니다.`;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return `limit은 1~${MAX_LIMIT} 사이 정수여야 합니다.`;
  if (aircon !== null && !AIRCON_VALUES.has(aircon)) return 'aircon은 true, false, unknown 중 하나여야 합니다.';
  if (candidateOnly !== null && candidateOnly !== 'true') return 'candidateOnly는 true만 허용합니다.';
  return null;
}

function toRadians(degrees) { return degrees * Math.PI / 180; }
function distanceMeters(lat1, lon1, lat2, lon2) {
  const earthRadiusM = 6371008.8;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(earthRadiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function formatHours(row) {
  const weekday = row.weekday_begin && row.weekday_end ? `${row.weekday_begin}~${row.weekday_end}` : null;
  const weekend = row.weekend_begin && row.weekend_end ? `${row.weekend_begin}~${row.weekend_end}` : null;
  return { weekday, weekend, weekend_open: row.weekend_open || null };
}

function recordWarning(row) {
  if (!row.weekday_begin || !row.weekday_end) return '평일 운영시간 정보가 없어 현재 운영·개방 여부를 확인해야 해요.';
  return '공개 운영시간은 당일 개방이나 냉방기 작동을 보장하지 않아요.';
}

function nearby(searchParams) {
  const lat = Number(searchParams.get('lat'));
  const lon = Number(searchParams.get('lon'));
  const radiusKm = Number(searchParams.get('radiusKm') ?? '2');
  const limit = Number(searchParams.get('limit') ?? '10');
  const aircon = searchParams.get('aircon');
  const candidateOnly = searchParams.get('candidateOnly') === 'true';
  const latDelta = radiusKm / 110.574;
  const lonDelta = radiusKm / (111.320 * Math.max(0.01, Math.cos(toRadians(lat))));
  const params = {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  };
  const airconClause = aircon === null ? '' : 'AND s.has_aircon = :aircon';
  const candidateClause = candidateOnly ? "AND s.hard_gate_status = 'internal_route_candidate'" : '';
  if (aircon !== null) params.aircon = aircon;
  const rows = database.prepare(`
    SELECT s.*
    FROM shelter_geo AS g
    JOIN shelters AS s ON s.id = g.id
    WHERE g.min_lat >= :minLat AND g.max_lat <= :maxLat
      AND g.min_lon >= :minLon AND g.max_lon <= :maxLon
      ${airconClause}
      ${candidateClause}
  `).all(params);
  const radiusM = radiusKm * 1000;
  const results = rows
    .map((row) => ({ ...row, distance_m: distanceMeters(lat, lon, row.lat, row.lon) }))
    .filter((row) => row.distance_m <= radiusM)
    .sort((a, b) => a.distance_m - b.distance_m || a.id - b.id)
    .slice(0, limit)
    .map((row) => ({
      place_id: row.place_id,
      original_id: row.original_id,
      name: row.name,
      lat: row.lat,
      lon: row.lon,
      distance_m: row.distance_m,
      road_address: row.road_address,
      lot_address: row.lot_address,
      has_aircon: row.has_aircon,
      hard_gate_status: row.hard_gate_status,
      hard_gate_reasons: JSON.parse(row.hard_gate_reasons),
      operating_hours: formatHours(row),
      source_provider: row.source_provider,
      source_url: row.source_url,
      record_updated_at: row.record_updated_at,
      ingested_at: row.ingested_at,
      warning: recordWarning(row),
    }));
  return {
    query: { lat, lon, radius_km: radiusKm, aircon: aircon ?? 'all', candidate_only: candidateOnly, limit },
    results,
    warnings: [
      '쉼터 존재는 당일 개방, 좌석, 냉방기 작동을 보장하지 않아요.',
      '운영시간과 수정시각을 확인하고 이용 전 공식 원문이나 현장 안내를 다시 확인하세요.',
    ],
  };
}

async function handleApi(url, res) {
  if (url.pathname === '/api/health') {
    if (!database) {
      jsonResponse(res, 503, { status: 'index_missing', message: 'npm run build:index를 먼저 실행하세요.' });
      return true;
    }
    jsonResponse(res, 200, {
      status: 'ready',
      recordCount: Number(metadata.record_count),
      ingestedAt: metadata.ingested_at,
      source: { provider: metadata.source_provider, url: metadata.source_url || SOURCE_URL },
    });
    return true;
  }
  if (url.pathname === '/api/shelters/nearby') {
    if (!database) {
      jsonResponse(res, 503, { error: 'search_index_missing', message: 'npm run build:index를 먼저 실행하세요.' });
      return true;
    }
    const error = validationError(url.searchParams);
    if (error) {
      jsonResponse(res, 400, { error: 'invalid_query', message: error });
      return true;
    }
    jsonResponse(res, 200, nearby(url.searchParams));
    return true;
  }
  if (url.pathname.startsWith('/api/')) {
    jsonResponse(res, 404, { error: 'not_found' });
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
    decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  if (await handleApi(url, res)) return;

  const relative = PUBLIC_FILES.get(url.pathname);
  if (!relative) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  try {
    const data = await readFile(join(root, relative));
    res.writeHead(200, {
      'Content-Type': types[extname(relative)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(4173, '127.0.0.1', () => console.log('쉬어갈지도 prototype: http://127.0.0.1:4173'));
