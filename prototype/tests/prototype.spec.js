import { test, expect } from '@playwright/test';

test('잘못 인코딩된 URL은 서버를 종료하지 않고 400으로 거부한다', async ({ request }) => {
  const bad = await request.get('/%E0%A4%A');
  expect(bad.status()).toBe(400);
  const health = await request.post('/api/shelters', { data: { action: 'health' } });
  expect(health.status()).toBe(200);
});

test('정적 서버는 공개 UI 파일만 제공하고 소스·테스트·검색 인덱스는 노출하지 않는다', async ({ request }) => {
  expect((await request.get('/app.js')).status()).toBe(200);
  expect((await request.get('/styles.css')).status()).toBe(200);
  for (const path of ['/server.mjs', '/tests/production-ui.spec.js', '/data/heat-shelters.sqlite', '/../lib/shelter-store.mjs']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});

test('레거시 GET 주변 검색은 좌표를 URL에 남기지 못하도록 404로 막는다', async ({ request }) => {
  const response = await request.get('/api/shelters/nearby?lat=37.5663&lon=126.9779&radiusKm=2');
  expect(response.status()).toBe(404);
  expect(await response.text()).not.toContain('37.5663');
});

test('통합 API는 잘못된 검색·좌표·반경·필터를 400으로 거부한다', async ({ request }) => {
  const cases = [
    { action: 'search', query: '서', limit: 8 },
    { action: 'search', query: '서울', limit: 99 },
    { action: 'search', query: '서울', limit: true },
    { action: 'search', query: '서울', limit: '8' },
    { action: 'nearby', latitude: '', longitude: 127, radiusKm: 2 },
    { action: 'nearby', latitude: '37', longitude: 127, radiusKm: 2 },
    { action: 'nearby', latitude: null, longitude: 127, radiusKm: 2 },
    { action: 'nearby', latitude: false, longitude: 127, radiusKm: 2 },
    { action: 'nearby', latitude: [], longitude: 127, radiusKm: 2 },
    { action: 'nearby', latitude: 37, longitude: null, radiusKm: 2 },
    { action: 'nearby', latitude: 91, longitude: 127, radiusKm: 2 },
    { action: 'nearby', latitude: 37, longitude: 181, radiusKm: 2 },
    { action: 'nearby', latitude: 37, longitude: 127, radiusKm: 21 },
    { action: 'nearby', latitude: 37, longitude: 127, radiusKm: false },
    { action: 'nearby', latitude: 37, longitude: 127, radiusKm: '2' },
    { action: 'nearby', latitude: 37, longitude: 127, radiusKm: 2, limit: true },
    { action: 'nearby', latitude: 37, longitude: 127, radiusKm: 2, aircon: 'yes' },
  ];
  for (const data of cases) {
    const response = await request.post('/api/shelters', { data });
    expect(response.status(), JSON.stringify(data)).toBe(400);
  }
});

test('통합 API는 null·배열·문자열 JSON을 400으로 거부하고 계속 응답한다', async ({ request }) => {
  for (const data of ['null', '[]', '"text"']) {
    const response = await request.post('/api/shelters', {
      headers: { 'Content-Type': 'application/json' },
      data,
    });
    expect(response.status(), data).toBe(400);
  }
  const health = await request.post('/api/shelters', { data: { action: 'health' } });
  expect(health.status()).toBe(200);
});

test('한글 조합 중에는 검색 입력 DOM을 교체하지 않고 조합 완료 후 결과를 보여준다', async ({ page }) => {
  await page.goto('/');
  const input = page.getByLabel('주소나 쉼터명으로 기준 장소 찾기');
  const original = await input.elementHandle();
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.value = '휴서울';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '휴서울' }));
  });
  await page.waitForTimeout(350);
  expect(await input.evaluate((element, first) => element === first, original)).toBe(true);
  await expect(page.getByRole('option')).toHaveCount(0);
  await input.evaluate((element) => {
    element.value = '휴서울이동노동자북창쉼터';
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '휴서울이동노동자북창쉼터' }));
  });
  await expect(page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ })).toBeVisible();
  expect(await input.evaluate((element, first) => element === first, original)).toBe(true);
});

test('위치 확인 중 직접 선택하면 늦은 위치 응답이 선택을 덮어쓰지 않는다', async ({ page }) => {
  await page.addInitScript(() => {
    window.__geoSuccess = null;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition(success) { window.__geoSuccess = success; } },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '현재 위치로 찾기' }).click();
  const input = page.getByLabel('주소나 쉼터명으로 기준 장소 찾기');
  await input.fill('휴서울이동노동자북창쉼터');
  await page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ }).click();
  await page.evaluate(() => window.__geoSuccess({ coords: { latitude: 37.5, longitude: 127.0 } }));
  await expect(page.getByText(/선택한 기준 장소.*휴서울이동노동자북창쉼터/)).toBeVisible();
  await expect(page.getByText('현재 위치를 기준 장소로 선택했어요.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '현재 위치로 찾기' })).toBeEnabled();
});

test('위치 확인 중 직접 입력을 시작하면 늦은 위치 성공을 무시하고 직접 입력을 유지한다', async ({ page }) => {
  await page.addInitScript(() => {
    window.__geoSuccess = null;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition(success) { window.__geoSuccess = success; } },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '현재 위치로 찾기' }).click();
  const input = page.getByLabel('주소나 쉼터명으로 기준 장소 찾기');
  await input.fill('휴서울');
  await page.evaluate(() => window.__geoSuccess({ coords: { latitude: 37.5, longitude: 127.0 } }));
  await expect(input).toHaveValue('휴서울');
  await expect(page.getByText('현재 위치를 기준 장소로 선택했어요.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '현재 위치로 찾기' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '주변 쉼터 보기' })).toBeDisabled();
});

test('현재 위치 재요청은 기존 기준 장소와 주변 조회를 즉시 비활성화한다', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__locationSuccess = null;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          window.__locationSuccess = success;
        },
      },
    });
  });
  await page.goto('/');
  await page.getByLabel('주소나 쉼터명으로 기준 장소 찾기').fill('휴서울이동노동자북창쉼터');
  await page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ }).click();
  await expect(page.getByRole('button', { name: '주변 쉼터 보기' })).toBeEnabled();

  await page.getByRole('button', { name: '현재 위치로 찾기' }).click();
  await expect(page.getByRole('button', { name: '주변 쉼터 보기' })).toBeDisabled();
  await expect(page.locator('#selected-place')).not.toContainText('휴서울이동노동자북창쉼터');

  await page.evaluate(() => {
    window.__locationSuccess({ coords: { latitude: 37.51, longitude: 127.01 } });
  });
  await expect(page.locator('#selected-place')).toContainText('현재 위치를 기준 장소로 선택했어요.');
  expect(pageErrors).toEqual([]);
});

test('취소된 첫 위치 콜백은 진행 중인 두 번째 위치 버튼을 활성화하지 않는다', async ({ page }) => {
  await page.addInitScript(() => {
    window.__locationCallbacks = [];
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success, error) {
          window.__locationCallbacks.push({ success, error });
        },
      },
    });
  });
  await page.goto('/');
  const locationButton = page.getByRole('button', { name: '현재 위치로 찾기' });
  await locationButton.click();
  await page.getByLabel('주소나 쉼터명으로 기준 장소 찾기').fill('서울');
  await locationButton.click();
  await expect(page.getByRole('button', { name: '위치 확인 중…' })).toBeDisabled();

  await page.evaluate(() => {
    window.__locationCallbacks[0].success({ coords: { latitude: 37.5, longitude: 127 } });
  });
  await expect(page.getByRole('button', { name: '위치 확인 중…' })).toBeDisabled();

  await page.evaluate(() => {
    window.__locationCallbacks[1].success({ coords: { latitude: 37.51, longitude: 127.01 } });
  });
  await expect(page.getByRole('button', { name: '현재 위치로 찾기' })).toBeEnabled();
  await expect(page.locator('#selected-place')).toContainText('현재 위치를 기준 장소로 선택했어요.');
});

for (const errorCase of [
  { code: 2, expected: '현재 위치를 확인하지 못했어요.' },
  { code: 3, expected: '위치 확인 시간이 초과됐어요.' },
  { code: 99, expected: '현재 위치를 확인하지 못했어요.' },
]) {
  test(`위치 오류 코드 ${errorCase.code}은 직접 입력 대안을 유지한다`, async ({ page }) => {
    await page.addInitScript((code) => {
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: { getCurrentPosition(_success, failure) { failure({ code }); } },
      });
    }, errorCase.code);
    await page.goto('/');
    await page.getByRole('button', { name: '현재 위치로 찾기' }).click();
    await expect(page.locator('#selected-place')).toContainText(errorCase.expected);
    await expect(page.getByLabel('주소나 쉼터명으로 기준 장소 찾기')).toBeFocused();
  });
}

test('잘못된 위치 좌표는 기준 장소로 선택하지 않는다', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition(success) { success({ coords: { latitude: Number.NaN, longitude: 127 } }); } },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '현재 위치로 찾기' }).click();
  await expect(page.getByText(/현재 위치 값이 올바르지 않아요/)).toBeVisible();
  await expect(page.getByRole('button', { name: '주변 쉼터 보기' })).toBeDisabled();
});

test('주변 API 실패는 성공으로 보이지 않고 다시 찾기 흐름을 제공한다', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('주소나 쉼터명으로 기준 장소 찾기').fill('휴서울이동노동자북창쉼터');
  await page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ }).click();
  await page.route('**/api/shelters', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === 'nearby') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '잠시 후 다시 시도해 주세요.' }) });
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '주변 쉼터 보기' }).click();
  await expect(page.getByRole('alert')).toContainText('잠시 후 다시 시도해 주세요.');
  await expect(page.getByRole('button', { name: '← 다시 찾기' })).toBeVisible();
  await expect(page.getByText(/검색 결과 \d+곳/)).toHaveCount(0);
});

test('주변 조회 중 다시 찾기를 누르면 늦은 응답이 검색 화면을 덮어쓰지 않는다', async ({ page }) => {
  let releaseNearby;
  const pendingNearby = new Promise((resolve) => { releaseNearby = resolve; });
  await page.goto('/');
  await page.getByLabel('주소나 쉼터명으로 기준 장소 찾기').fill('휴서울이동노동자북창쉼터');
  await page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ }).click();
  await page.route('**/api/shelters', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action !== 'nearby') return route.continue();
    await pendingNearby;
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [] }) });
    } catch {}
  });
  await page.getByRole('button', { name: '주변 쉼터 보기' }).click();
  await expect(page.getByText('공식 쉼터를 찾고 있어요…')).toBeVisible();
  await page.getByRole('button', { name: '← 다시 찾기' }).click();
  releaseNearby();
  await page.waitForTimeout(100);
  await expect(page.getByRole('heading', { name: '가까운 무더위쉼터를 찾아봐요' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /주변 공식 쉼터/ })).toHaveCount(0);
});

test('다시 찾기 후에도 표시 필터와 다음 주변 요청 조건이 일치한다', async ({ page }) => {
  const nearbyPayloads = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/shelters') && request.method() === 'POST') {
      const payload = request.postDataJSON();
      if (payload.action === 'nearby') nearbyPayloads.push(payload);
    }
  });

  const selectReference = async () => {
    await page.getByLabel('주소나 쉼터명으로 기준 장소 찾기').fill('휴서울이동노동자북창쉼터');
    await page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ }).click();
  };

  await page.goto('/');
  await selectReference();
  await page.getByRole('radio', { name: '10km' }).check();
  await page.getByRole('radio', { name: '1대 이상만' }).check();
  await page.getByRole('button', { name: '주변 쉼터 보기' }).click();
  await expect(page.getByText(/검색 결과 \d+곳/)).toBeVisible();
  await page.getByRole('button', { name: '다시 찾기' }).click();

  await expect(page.getByRole('radio', { name: '10km' })).toBeChecked();
  await expect(page.getByRole('radio', { name: '1대 이상만' })).toBeChecked();
  await selectReference();
  await page.getByRole('button', { name: '주변 쉼터 보기' }).click();
  await expect.poll(() => nearbyPayloads.length).toBe(2);
  expect(nearbyPayloads[1].radiusKm).toBe(10);
  expect(nearbyPayloads[1].aircon).toBe('true');
});

test('390px 첫 화면과 결과 화면에 가로 DOM 오버플로가 없다', async ({ page }) => {
  const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.goto('/');
  expect(await overflow()).toBe(0);
  await page.getByLabel('주소나 쉼터명으로 기준 장소 찾기').fill('휴서울이동노동자북창쉼터');
  await page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ }).click();
  await page.getByRole('button', { name: '주변 쉼터 보기' }).click();
  await expect(page.locator('[data-shelter-id]').first()).toBeVisible();
  expect(await overflow()).toBe(0);
});
