import { test, expect } from '@playwright/test';

test('공개 첫 화면은 현재 위치와 직접 입력으로 공식 쉼터를 찾게 한다', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('쉬어갈지도 — 가까운 무더위쉼터 찾기');
  await expect(page.getByRole('heading', { name: '가까운 무더위쉼터를 찾아봐요' })).toBeVisible();
  await expect(page.getByRole('button', { name: '현재 위치로 찾기' })).toBeVisible();
  await expect(page.getByLabel('주소나 쉼터명으로 기준 장소 찾기')).toBeVisible();
  await expect(page.getByText('위치는 검색에만 사용하고 앱에서 저장하지 않아요.')).toBeVisible();
  await expect(page.getByText('행정안전부 공식자료 60,672건')).toBeVisible();
  await expect(page.getByText(/내부 검토용/)).toHaveCount(0);
  await expect(page.getByText(/경로·보행시간은 예시/)).toHaveCount(0);
  await expect(page.getByText('목적지', { exact: true })).toHaveCount(0);
});

test('한국어 직접 입력으로 공식 쉼터를 기준 장소로 선택할 수 있다', async ({ page }) => {
  await page.goto('/');
  const input = page.getByLabel('주소나 쉼터명으로 기준 장소 찾기');
  await input.fill('휴서울이동노동자북창쉼터');
  const option = page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.getByText(/선택한 기준 장소.*휴서울이동노동자북창쉼터/)).toBeVisible();
  await expect(page.getByRole('button', { name: '주변 쉼터 보기' })).toBeEnabled();
});

test('현재 위치는 명시적 선택 후 기준 장소로만 사용하고 좌표를 화면에 노출하지 않는다', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          success({ coords: { latitude: 37.5663, longitude: 126.9779, accuracy: 20 } });
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '현재 위치로 찾기' }).click();
  await expect(page.getByText('현재 위치를 기준 장소로 선택했어요.')).toBeVisible();
  await expect(page.getByRole('button', { name: '주변 쉼터 보기' })).toBeEnabled();
  await expect(page.locator('body')).not.toContainText('37.5663');
  await expect(page.locator('body')).not.toContainText('126.9779');
});

test('위치 권한이 거부돼도 직접 입력 흐름과 포커스를 유지한다', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(_success, failure) { failure({ code: 1 }); },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '현재 위치로 찾기' }).click();
  await expect(page.getByText(/위치 권한이 허용되지 않았어요.*주소나 쉼터명으로 계속 찾을 수 있어요/)).toBeVisible();
  await expect(page.getByLabel('주소나 쉼터명으로 기준 장소 찾기')).toBeFocused();
  await expect(page.getByRole('button', { name: '현재 위치로 찾기' })).toBeEnabled();
});

test('선택한 장소 주변의 공식 쉼터를 POST로 조회해 거리순 실데이터를 표시한다', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('주소나 쉼터명으로 기준 장소 찾기').fill('휴서울이동노동자북창쉼터');
  await page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ }).click();
  const nearbyRequest = page.waitForRequest((request) => {
    if (!request.url().endsWith('/api/shelters') || request.method() !== 'POST') return false;
    return request.postDataJSON()?.action === 'nearby';
  });
  await page.getByRole('button', { name: '주변 쉼터 보기' }).click();
  const request = await nearbyRequest;
  expect(request.url()).not.toContain('latitude');
  expect(request.url()).not.toContain('longitude');
  await expect(page.getByRole('heading', { name: /휴서울이동노동자북창쉼터 주변 공식 쉼터/ })).toBeVisible();
  const cards = page.locator('[data-shelter-id]');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(0);
  await expect(cards.first()).toContainText('정보 부족');
  await expect(cards.first()).toContainText('냉방기 수량');
  await expect(cards.first().getByRole('link', { name: '지도에서 위치 열기' })).toBeVisible();
  await expect(page.getByRole('region', { name: '데이터 출처' }).getByRole('link', { name: '행정안전부' })).toBeVisible();
  await expect(page.getByText(/예상 \d+분/)).toHaveCount(0);
  await expect(page.getByText(/예시 데이터/)).toHaveCount(0);
});

test('오염된 출처 URL이 응답에 있어도 공식 HTTPS 출처만 링크한다', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('주소나 쉼터명으로 기준 장소 찾기').fill('휴서울이동노동자북창쉼터');
  await page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ }).click();
  await page.route('**/api/shelters', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action !== 'nearby') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [{
          original_id: 'safe-link-test', name: '출처 링크 검증 쉼터',
          road_address: '서울특별시 중구 세종대로 1', lat: 37.56, lon: 126.97,
          distance_m: 120, aircon_count: null, fan_count: null, capacity: null,
          operating_hours: {}, record_updated_at: null,
          source_provider: '오염된 출처', source_url: 'javascript:alert(document.domain)',
        }],
      }),
    });
  });
  await page.getByRole('button', { name: '주변 쉼터 보기' }).click();
  const card = page.locator('[data-shelter-id="safe-link-test"]');
  await card.getByText('출처와 제한 사유 보기').click();
  const source = card.getByRole('link', { name: '행정안전부' });
  await expect(source).toHaveAttribute('href', 'https://www.safetydata.go.kr/disaster-data/view?dataSn=1338');
  await expect(card.locator('a[href^="javascript:"]')).toHaveCount(0);
});

test('공유에는 사용자 위치 없이 선택한 쉼터 정보와 출처만 포함한다', async ({ page }) => {
  await page.addInitScript(() => {
    window.__sharedPayload = null;
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (payload) => { window.__sharedPayload = payload; },
    });
  });
  await page.goto('/');
  await page.getByLabel('주소나 쉼터명으로 기준 장소 찾기').fill('휴서울이동노동자북창쉼터');
  await page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ }).click();
  await page.getByRole('button', { name: '주변 쉼터 보기' }).click();
  const first = page.locator('[data-shelter-id]').first();
  await first.getByRole('button', { name: '보호자에게 정보 공유' }).click();
  const payload = await page.evaluate(() => window.__sharedPayload);
  expect(payload.title).toContain('쉬어갈지도');
  expect(payload.text).toContain('당일 개방');
  expect(payload.text).toContain('행정안전부');
  expect(payload.text).not.toContain('현재 위치');
  expect(payload.text).not.toMatch(/약 \d+(?:m|\.\d+km)/);
  expect(payload.text).not.toContain('37.');
  expect(payload.text).not.toContain('126.');
  await expect(first.getByRole('status')).toHaveText('공유 창을 열었어요.');
});
