import { test, expect } from '@playwright/test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('런타임 저장소는 SQLite SHA-256이 일치하지 않으면 열지 않는다', async () => {
  const { openShelterStore } = await import('../../lib/shelter-store.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'rest-route-digest-'));
  const indexPath = join(directory, 'index.sqlite');
  try {
    copyFileSync(join(process.cwd(), 'data/heat-shelters.sqlite'), indexPath);
    writeFileSync(`${indexPath}.sha256`, `${'0'.repeat(64)}\n`, 'ascii');
    const store = openShelterStore(indexPath);
    expect(store.database).toBeNull();
    expect(store.metadata).toEqual({});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('프로덕션 통합 API는 공식 실데이터 상태를 POST로 반환한다', async ({ request }) => {
  const response = await request.post('/api/shelters', {
    data: { action: 'health' },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    status: 'ready',
    recordCount: 60672,
    gateStatus: 'information_insufficient',
    source: {
      provider: '행정안전부',
      url: 'https://www.safetydata.go.kr/disaster-data/view?dataSn=1338',
      license: '이용허락범위 제한 없음',
    },
  });
});

test('직접 입력 검색은 실제 쉼터명과 주소를 반환하고 원본 raw를 노출하지 않는다', async ({ request }) => {
  const response = await request.post('/api/shelters', {
    data: { action: 'search', query: '휴서울이동노동자북창쉼터', limit: 5 },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.results.length).toBeGreaterThan(0);
  expect(body.results[0]).toMatchObject({
    name: '휴서울이동노동자북창쉼터',
    hard_gate_status: 'information_insufficient',
    lat: expect.any(Number),
    lon: expect.any(Number),
  });
  expect(body.results[0].road_address || body.results[0].lot_address).toBeTruthy();
  expect(body.results[0]).not.toHaveProperty('raw');
  expect(body.results[0].source_provider).toBe('행정안전부');
  expect(body.results[0].source_url).toBe('https://www.safetydata.go.kr/disaster-data/view?dataSn=1338');
});

test('주변 조회는 사용자 좌표를 응답에 되돌려주지 않고 실제 쉼터만 거리순으로 반환한다', async ({ request }) => {
  const response = await request.post('/api/shelters', {
    data: {
      action: 'nearby',
      latitude: 37.5663,
      longitude: 126.9779,
      radiusKm: 2,
      aircon: 'true',
      limit: 3,
    },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.results).toHaveLength(3);
  expect(body).not.toHaveProperty('latitude');
  expect(body).not.toHaveProperty('longitude');
  expect(body).not.toHaveProperty('query');
  expect(body.results.every((item) => item.hard_gate_status === 'information_insufficient')).toBe(true);
  expect(body.results.every((item) => Number.isInteger(item.aircon_count) && item.aircon_count > 0)).toBe(true);
  expect(body.results.every((item) => Number.isInteger(item.distance_m) && item.distance_m >= 0)).toBe(true);
  expect(body.results.map((item) => item.distance_m)).toEqual(
    [...body.results.map((item) => item.distance_m)].sort((a, b) => a - b),
  );
  expect(body.results[0]).not.toHaveProperty('raw');
  expect(body.results.every((item) => item.source_url === 'https://www.safetydata.go.kr/disaster-data/view?dataSn=1338')).toBe(true);
  expect(body.warnings.join(' ')).toContain('당일 개방');
});

test('Vercel 서버리스 함수도 같은 공식 데이터 계약을 사용한다', async () => {
  const { default: handler } = await import('../../api/shelters.mjs');
  const request = { method: 'POST', body: { action: 'health' } };
  const response = {
    statusCode: 0,
    headers: {},
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
  await handler(request, response);
  expect(response.statusCode).toBe(200);
  expect(response.payload).toMatchObject({ status: 'ready', recordCount: 60672 });
  expect(response.headers['Cache-Control']).toBe('no-store');
});
