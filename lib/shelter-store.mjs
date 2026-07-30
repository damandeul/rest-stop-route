import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

export const SOURCE_URL = 'https://www.safetydata.go.kr/disaster-data/view?dataSn=1338';
export const SOURCE_PROVIDER = '행정안전부';
export const SOURCE_LICENSE = '이용허락범위 제한 없음';

export function openShelterStore(indexPath) {
  const digestPath = `${indexPath}.sha256`;
  if (!existsSync(indexPath) || !existsSync(digestPath)) return { database: null, metadata: {} };
  let database = null;
  try {
    const expectedDigest = readFileSync(digestPath, 'ascii').trim();
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) return { database: null, metadata: {} };
    const actualDigest = createHash('sha256').update(readFileSync(indexPath)).digest('hex');
    if (actualDigest !== expectedDigest) return { database: null, metadata: {} };
    database = new Database(indexPath, { readonly: true, fileMustExist: true });
    const metadata = Object.fromEntries(
      database.prepare('SELECT key, value FROM metadata').all().map(({ key, value }) => [key, value]),
    );
    return { database, metadata };
  } catch {
    database?.close();
    return { database: null, metadata: {} };
  }
}

export function healthPayload(store) {
  if (!store.database) {
    return { statusCode: 503, body: { status: 'index_missing', message: '검색 데이터를 준비하지 못했어요.' } };
  }
  return {
    statusCode: 200,
    body: {
      status: 'ready',
      recordCount: Number(store.metadata.record_count),
      gateStatus: 'information_insufficient',
      ingestedAt: store.metadata.ingested_at,
      source: {
        provider: SOURCE_PROVIDER,
        url: SOURCE_URL,
        license: SOURCE_LICENSE,
      },
    },
  };
}

function escapedLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const earthRadiusM = 6371008.8;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(earthRadiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function operatingHours(row) {
  return {
    weekday: row.weekday_begin && row.weekday_end ? `${row.weekday_begin}~${row.weekday_end}` : null,
    weekend: row.weekend_begin && row.weekend_end ? `${row.weekend_begin}~${row.weekend_end}` : null,
    weekend_open: row.weekend_open || null,
  };
}

function operationWarning(row) {
  if (!row.weekday_begin || !row.weekday_end) {
    return '평일 운영시간 정보가 없어 현재 운영·개방 여부를 확인해야 해요.';
  }
  return '공개 운영시간은 당일 개방이나 냉방기 작동을 보장하지 않아요.';
}

function numberInput(value) {
  return typeof value === 'number' ? value : Number.NaN;
}

export function nearbyPayload(store, input = {}) {
  if (!store.database) {
    return { statusCode: 503, body: { error: 'index_missing', message: '검색 데이터를 준비하지 못했어요.' } };
  }
  const latitude = numberInput(input.latitude);
  const longitude = numberInput(input.longitude);
  const radiusKm = input.radiusKm === undefined ? 2 : numberInput(input.radiusKm);
  const limit = input.limit === undefined ? 10 : numberInput(input.limit);
  const aircon = input.aircon === undefined || input.aircon === 'all' ? null : input.aircon;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { statusCode: 400, body: { error: 'invalid_latitude', message: '위도를 확인해 주세요.' } };
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { statusCode: 400, body: { error: 'invalid_longitude', message: '경도를 확인해 주세요.' } };
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 20) {
    return { statusCode: 400, body: { error: 'invalid_radius', message: '검색 반경은 0보다 크고 20km 이하여야 해요.' } };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { statusCode: 400, body: { error: 'invalid_limit', message: '검색 결과 수는 1~50 사이여야 해요.' } };
  }
  if (aircon !== null && !['true', 'false', 'unknown'].includes(aircon)) {
    return { statusCode: 400, body: { error: 'invalid_aircon', message: '냉방 자료 조건을 확인해 주세요.' } };
  }

  const latDelta = radiusKm / 110.574;
  const lonDelta = radiusKm / (111.320 * Math.max(0.01, Math.cos(toRadians(latitude))));
  const params = {
    minLat: latitude - latDelta,
    maxLat: latitude + latDelta,
    minLon: longitude - lonDelta,
    maxLon: longitude + lonDelta,
  };
  const airconClause = aircon === null ? '' : 'AND s.has_aircon = :aircon';
  if (aircon !== null) params.aircon = aircon;
  const rows = store.database.prepare(`
    SELECT s.*
    FROM shelter_geo AS g
    JOIN shelters AS s ON s.id = g.id
    WHERE g.min_lat >= :minLat AND g.max_lat <= :maxLat
      AND g.min_lon >= :minLon AND g.max_lon <= :maxLon
      ${airconClause}
  `).all(params);
  const radiusM = radiusKm * 1000;
  const results = rows
    .map((row) => ({ ...row, distance_m: distanceMeters(latitude, longitude, row.lat, row.lon) }))
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
      aircon_count: row.aircon_count,
      has_fan: row.has_fan,
      fan_count: row.fan_count,
      capacity: row.capacity,
      hard_gate_status: row.hard_gate_status,
      hard_gate_reasons: JSON.parse(row.hard_gate_reasons),
      operating_hours: operatingHours(row),
      source_provider: SOURCE_PROVIDER,
      source_url: SOURCE_URL,
      record_updated_at: row.record_updated_at,
      ingested_at: row.ingested_at,
      warning: operationWarning(row),
    }));
  return {
    statusCode: 200,
    body: {
      results,
      radius_km: radiusKm,
      aircon: aircon ?? 'all',
      warnings: [
        '쉼터 존재는 당일 개방, 좌석, 냉방기 작동을 보장하지 않아요.',
        '운영시간과 수정시각을 확인하고 이용 전 공식 원문이나 현장 안내를 다시 확인하세요.',
      ],
      source: { provider: SOURCE_PROVIDER, url: SOURCE_URL, license: SOURCE_LICENSE },
    },
  };
}

export function searchPayload(store, input = {}) {
  if (!store.database) {
    return { statusCode: 503, body: { error: 'index_missing', message: '검색 데이터를 준비하지 못했어요.' } };
  }
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const limit = input.limit === undefined ? 8 : numberInput(input.limit);
  if (query.length < 2 || query.length > 80) {
    return { statusCode: 400, body: { error: 'invalid_query', message: '검색어는 2~80자로 입력해 주세요.' } };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    return { statusCode: 400, body: { error: 'invalid_limit', message: '검색 결과 수는 1~20 사이여야 해요.' } };
  }
  const escaped = escapedLike(query);
  const contains = `%${escaped}%`;
  const prefix = `${escaped}%`;
  const rows = store.database.prepare(`
    SELECT place_id, original_id, name, lat, lon, road_address, lot_address,
           has_aircon, aircon_count, has_fan, fan_count, capacity,
           hard_gate_status, hard_gate_reasons, record_updated_at,
           source_provider, source_url
    FROM shelters
    WHERE name LIKE :contains ESCAPE '\\'
       OR road_address LIKE :contains ESCAPE '\\'
       OR lot_address LIKE :contains ESCAPE '\\'
    ORDER BY CASE
      WHEN name LIKE :prefix ESCAPE '\\' THEN 0
      WHEN road_address LIKE :prefix ESCAPE '\\' THEN 1
      WHEN lot_address LIKE :prefix ESCAPE '\\' THEN 2
      ELSE 3
    END, name, original_id
    LIMIT :limit
  `).all({ contains, prefix, limit });
  return {
    statusCode: 200,
    body: {
      query,
      results: rows.map((row) => ({
        ...row,
        source_provider: SOURCE_PROVIDER,
        source_url: SOURCE_URL,
        hard_gate_reasons: JSON.parse(row.hard_gate_reasons),
      })),
    },
  };
}
