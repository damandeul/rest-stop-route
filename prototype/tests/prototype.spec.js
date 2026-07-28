import { test, expect } from '@playwright/test';

test('잘못 인코딩된 URL은 서버를 종료하지 않고 400으로 거부한다', async ({ request }) => {
  const malformed = await request.get('/%E0');
  expect(malformed.status()).toBe(400);
  const home = await request.get('/');
  expect(home.status()).toBe(200);
});

test('정적 서버는 공개 UI 파일만 제공하고 소스·테스트·검색 인덱스는 노출하지 않는다', async ({ request }) => {
  for (const path of ['/index.html', '/app.js', '/styles.css']) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
  for (const path of [
    '/server.mjs',
    '/package.json',
    '/tests/prototype.spec.js',
    '/data/heat-shelters.sqlite',
    '/%2e%2e/server.mjs',
  ]) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
  expect((await request.get('/api/health')).status()).toBe(200);
});

test('로컬 인덱스 상태는 전량 레코드 수와 데이터 출처를 공개한다', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    status: 'ready',
    recordCount: 60672,
    source: {
      provider: '행정안전부',
      url: 'https://www.safetydata.go.kr/disaster-data/view?dataSn=1338',
    },
  });
});

for (const sample of [
  { aircon: 'unknown', lat: 36.664703, lon: 127.499567, placeId: 'mois-heat-4311400298' },
  { aircon: 'true', lat: 35.255404, lon: 129.214979, placeId: 'mois-heat-2671000258' },
  { aircon: 'false', lat: 37.5227158, lon: 126.7999266, placeId: 'mois-heat-41191101' },
]) {
  test(`좌표 주변 검색은 냉방 ${sample.aircon} 3값을 구분한다`, async ({ request }) => {
    const response = await request.get(`/api/shelters/nearby?lat=${sample.lat}&lon=${sample.lon}&radiusKm=0.1&aircon=${sample.aircon}&limit=5`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.results.some((item) => item.place_id === sample.placeId)).toBe(true);
    expect(body.results.every((item) => item.has_aircon === sample.aircon)).toBe(true);
    expect(body.results[0].distance_m).toBeGreaterThanOrEqual(0);
  });
}

for (const sample of [
  { status: 'information_insufficient', reasons: ['access_restriction_unverified', 'aircon_false', 'weekday_hours_missing', 'weekend_open_unknown'], lat: 37.5227158, lon: 126.7999266, originalId: '41191101' },
  { status: 'information_insufficient', reasons: ['access_restriction_unverified'], lat: 37.3591, lon: 126.9338, originalId: '4141135' },
  { status: 'information_insufficient', reasons: ['access_restriction_unverified', 'aircon_false'], lat: 35.130154, lon: 127.91313, originalId: '4824560' },
]) {
  test(`API는 ${sample.originalId}의 하드게이트 ${sample.status} 상태와 사유를 보존한다`, async ({ request }) => {
    const response = await request.get(`/api/shelters/nearby?lat=${sample.lat}&lon=${sample.lon}&radiusKm=0.1&limit=50`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    const item = body.results.find((result) => result.original_id === sample.originalId);
    expect(item).toBeDefined();
    expect(item.hard_gate_status).toBe(sample.status);
    expect(item.hard_gate_reasons).toEqual(sample.reasons);
  });
}

test('접근조건 검증 전 긍정 내부 경로 후보 질의는 빈 목록을 반환한다', async ({ request }) => {
  const response = await request.get('/api/shelters/nearby?lat=37.3591&lon=126.9338&radiusKm=2&limit=50&candidateOnly=true');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.results).toEqual([]);
});

test('주변 검색은 추적정보와 운영시간 경고를 보존하고 원본 raw를 내보내지 않는다', async ({ request }) => {
  const response = await request.get('/api/shelters/nearby?lat=36.664703&lon=127.499567&radiusKm=0.1&aircon=unknown&limit=1');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.results).toHaveLength(1);
  expect(body.results[0]).toMatchObject({
    source_provider: '행정안전부',
    source_url: 'https://www.safetydata.go.kr/disaster-data/view?dataSn=1338',
    record_updated_at: expect.any(String),
    warning: expect.stringMatching(/운영|개방/),
  });
  expect(body.results[0]).not.toHaveProperty('raw');
  expect(body.warnings.join(' ')).toMatch(/당일 개방|작동을 보장하지 않/);
});

test('주변 검색은 필수 좌표 누락·빈값을 400으로 거부한다', async ({ request }) => {
  for (const query of [
    '',
    'lat=37',
    'lon=127',
    'lat=&lon=',
    'lat=37&lon=',
    'lat=&lon=127',
  ]) {
    const response = await request.get(`/api/shelters/nearby?${query}`);
    expect(response.status(), query || '(no query)').toBe(400);
  }
});

test('주변 검색은 잘못된 좌표·반경·냉방 필터를 400으로 거부한다', async ({ request }) => {
  for (const query of [
    'lat=91&lon=127&radiusKm=1',
    'lat=37&lon=181&radiusKm=1',
    'lat=37&lon=127&radiusKm=0',
    'lat=37&lon=127&radiusKm=1&aircon=yes',
    'lat=37&lon=127&radiusKm=1&candidateOnly=false',
  ]) {
    const response = await request.get(`/api/shelters/nearby?${query}`);
    expect(response.status(), query).toBe(400);
  }
});

async function choosePlace(page, field, query, resultName) {
  await page.getByLabel(field).fill(query);
  await page.getByRole('button', { name: new RegExp(resultName) }).click();
}

async function plan(page, { destination = '서울도서관', minutes = '5분', conditions = ['냉방 실내', '화장실'] } = {}) {
  await choosePlace(page, '출발지', '서울', '서울시청');
  await choosePlace(page, '목적지', destination.slice(0, 2), destination);
  await page.getByRole('radio', { name: minutes }).click();
  for (const condition of conditions) await page.getByRole('checkbox', { name: condition }).click();
  await page.getByRole('button', { name: '휴식 후보 이어보기' }).click();
}

test('필수값 오류를 보여주고 첫 입력에 초점을 둔다', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '휴식 후보 이어보기' }).click();
  await expect(page.getByRole('alert')).toContainText('입력하지 않은 항목');
  await expect(page.getByText('출발지를 선택해 주세요.')).toBeVisible();
  await expect(page.getByLabel('출발지')).toBeFocused();
});

test('한글 조합 중에는 검색 입력 DOM을 교체하지 않고 조합 완료 후 결과를 보여준다', async ({ page }) => {
  await page.goto('/');
  const input = page.getByLabel('출발지');
  const original = await input.elementHandle();
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    element.value = '서';
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: '서',
      inputType: 'insertCompositionText',
      isComposing: true,
    }));
  });
  expect(await original.evaluate((element) => element.isConnected)).toBe(true);
  await input.evaluate((element) => {
    element.value = '서울';
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '서울' }));
  });
  const committed = await page.getByRole('searchbox', { name: '출발지' }).elementHandle();
  await original.evaluate((element) => {
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: '울',
      inputType: 'insertText',
      isComposing: false,
    }));
  });
  await committed.evaluate((element) => {
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: '울',
      inputType: 'insertText',
      isComposing: false,
    }));
  });
  expect(await committed.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.getByRole('searchbox', { name: '출발지' })).toHaveValue('서울');
  await expect(page.getByRole('searchbox', { name: '출발지' })).toBeFocused();
  expect(await page.getByRole('searchbox', { name: '출발지' }).evaluate((element) => element.selectionStart)).toBe(2);
  await expect(page.getByRole('button', { name: /서울시청/ })).toBeVisible();
});

test('모바일 사용자는 위치 권한으로 현재 위치를 출발지로 선택할 수 있다', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          success({ coords: { latitude: 37.5665, longitude: 126.978, accuracy: 18 } });
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '현재 위치 사용' }).click();
  await expect(page.getByLabel('출발지')).toHaveValue('현재 위치');
  await expect(page.getByText(/기기 위치정보로 선택됨/)).toBeVisible();
  await expect(page.getByText(/브라우저 메모리에만/)).toBeVisible();
  await expect(page.getByRole('button', { name: '출발·도착 바꾸기' })).toBeDisabled();
});

test('위치 권한이 거부되어도 시설명 직접 입력을 계속 사용할 수 있다', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(_success, error) {
          error({ code: 1 });
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '현재 위치 사용' }).click();
  await expect(page.getByRole('alert')).toContainText('위치 권한이 거부됐어요');
  await expect(page.getByRole('searchbox', { name: '출발지' })).toBeEnabled();
  await page.getByRole('searchbox', { name: '출발지' }).fill('서울');
  await expect(page.getByRole('button', { name: /서울시청/ })).toBeVisible();
});

for (const errorCase of [
  { code: 2, expected: '현재 위치를 확인하지 못했어요' },
  { code: 3, expected: '현재 위치 확인 시간이 초과됐어요' },
  { code: 99, expected: '현재 위치를 사용할 수 없어요' },
]) {
  test(`위치 오류 코드 ${errorCase.code}은 직접 입력 대안을 안내한다`, async ({ page }) => {
    await page.addInitScript((code) => {
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: { getCurrentPosition(_success, error) { error({ code }); } },
      });
    }, errorCase.code);
    await page.goto('/');
    await page.getByRole('button', { name: '현재 위치 사용' }).click();
    await expect(page.getByRole('alert')).toContainText(errorCase.expected);
    await expect(page.getByRole('searchbox', { name: '출발지' })).toBeEnabled();
  });
}

test('위치정보 API 미지원 시 시설명 직접 입력을 안내한다', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '현재 위치 사용' }).click();
  await expect(page.getByRole('alert')).toContainText('이 브라우저에서는 현재 위치를 사용할 수 없어요');
});

test('잘못된 위치 좌표는 출발지로 선택하지 않는다', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          success({ coords: { latitude: Number.NaN, longitude: 126.978, accuracy: 18 } });
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '현재 위치 사용' }).click();
  await expect(page.getByRole('alert')).toContainText('현재 위치 좌표를 확인하지 못했어요');
  await expect(page.getByRole('searchbox', { name: '출발지' })).toHaveValue('');
});

test('위치 확인 중 시설을 직접 선택하면 늦게 도착한 위치 응답이 선택을 덮어쓰지 않는다', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          window.resolveCurrentLocation = () => success({
            coords: { latitude: 37.5665, longitude: 126.978, accuracy: 18 },
          });
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('searchbox', { name: '출발지' }).fill('서울');
  await page.getByRole('button', { name: '현재 위치 사용' }).click();
  await page.getByRole('button', { name: /서울시청/ }).click();
  await page.evaluate(() => window.resolveCurrentLocation());
  await expect(page.getByRole('searchbox', { name: '출발지' })).toHaveValue('서울시청');
  await expect(page.getByText(/선택: 서울특별시 중구 세종대로 110/)).toBeVisible();
});

test('결과 화면으로 이동한 뒤 늦은 위치 응답이 첫 화면으로 되돌리지 않는다', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          window.resolveCurrentLocation = () => success({
            coords: { latitude: 37.5665, longitude: 126.978, accuracy: 18 },
          });
        },
      },
    });
  });
  await page.goto('/');
  await choosePlace(page, '출발지', '서울', '서울시청');
  await choosePlace(page, '목적지', '제주', '제주시청');
  await page.getByLabel('5분').check();
  await page.getByLabel('그늘').check();
  await page.getByRole('button', { name: '현재 위치 사용' }).click();
  await page.getByRole('button', { name: '휴식 후보 이어보기' }).click();
  await expect(page.getByRole('button', { name: '조건 바꾸기' })).toBeVisible();
  await page.evaluate(() => window.resolveCurrentLocation());
  await expect(page.getByRole('button', { name: '조건 바꾸기' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '출발지' })).toHaveCount(0);
});

test('전국 장소 검색 데모는 주소와 행정구역을 함께 제공한다', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('목적지').fill('제주');
  const option = page.getByRole('button', { name: /제주시청/ });
  await expect(option).toContainText('제주특별자치도 제주시');
  await expect(page.getByText(/전국 검색 데모/)).toBeVisible();
});

test('3·5·10분 선택지를 제공하고 확인된 복수 조건으로 연결 결과를 본다', async ({ page }) => {
  await page.goto('/');
  for (const minutes of ['3분', '5분', '10분']) {
    await page.getByRole('radio', { name: minutes }).click();
    await expect(page.getByRole('radio', { name: minutes })).toBeChecked();
  }
  await plan(page);
  await expect(page.getByRole('heading', { name: '연결 결과' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /조건에 맞는 후보가 이어짐/ })).toBeVisible();
  await expect(page.getByText(/예상 4분/).first()).toBeVisible();
  await expect(page.getByText(/자료 신뢰 수준/).first()).toBeVisible();
  await expect(page.getByText(/예시 데이터/).first()).toBeVisible();
});

test('결과 화면은 목적지 좌표 주변 공식 쉼터 실데이터를 로컬 API에서 불러온다', async ({ page }) => {
  await page.goto('/');
  await plan(page, { conditions: ['냉방 실내'] });
  const section = page.getByRole('region', { name: '목적지 주변 무더위쉼터 실데이터' });
  await expect(section).toBeVisible();
  await expect(section.getByText(/행정안전부 실데이터/).first()).toBeVisible();
  await expect(section.getByText(/공식 자료상 냉방기 수량 확인/).first()).toBeVisible();
  await expect(section.getByText(/수량 필드만 확인했으며 현재 작동·개방을 뜻하지 않/).first()).toBeVisible();
  await expect(section.getByText(/공식 자료 수량 1대 이상/).first()).toBeVisible();
  await expect(section.getByText(/true\/false\/unknown 원값 보존/)).toHaveCount(0);
  await expect(section.getByText(/마지막 수정/).first()).toBeVisible();
  await expect(section.getByText(/당일 개방|운영시간/).first()).toBeVisible();
});

test('서울 표본 참고 목록은 정보 부족과 제한 사유를 카드마다 표시한다', async ({ page }) => {
  await page.goto('/');
  await plan(page, { conditions: ['냉방 실내'] });
  const section = page.getByRole('region', { name: '목적지 주변 무더위쉼터 실데이터' });
  await expect(section.getByText(/참고 목록 · 경로 연결에 사용하지 않음/)).toBeVisible();
  const cards = section.locator('.real-place-card');
  await expect(cards).toHaveCount(3);
  for (const card of await cards.all()) {
    await expect(card.getByText(/정보 부족 · 긍정 연결 제외/)).toBeVisible();
    await expect(card.getByText(/주말·휴일 개방 여부 미확인/)).toBeVisible();
  }
});

test('연결 표본도 선택 시간이 실제 구간보다 짧으면 휴식점 부족이다', async ({ page }) => {
  await page.goto('/');
  await plan(page, { minutes: '3분' });
  await expect(page.getByRole('heading', { name: /휴식점 부족/ })).toBeVisible();
  await expect(page.getByText(/선택한 3분 초과/).first()).toBeVisible();
});

test('선택 조건이 후보 자료에서 미확인이면 긍정 연결 대신 정보 부족이다', async ({ page }) => {
  await page.goto('/');
  await plan(page, { conditions: ['그늘'] });
  await expect(page.getByRole('heading', { name: /정보 부족/ })).toBeVisible();
});

test('미확인 조건은 목적지의 휴식점 부족 시나리오보다 정보 부족을 우선한다', async ({ page }) => {
  await page.goto('/');
  await plan(page, { destination: '부산역', conditions: ['그늘'] });
  await expect(page.getByRole('heading', { name: /정보 부족/ })).toBeVisible();
});

test('휴식점 부족은 초과 구간과 대안을 보여준다', async ({ page }) => {
  await page.goto('/');
  await plan(page, { destination: '부산역', minutes: '3분', conditions: ['냉방 실내'] });
  await expect(page.getByRole('heading', { name: /휴식점 부족/ })).toBeVisible();
  await expect(page.getByText(/선택한 3분 초과/).first()).toBeVisible();
  await page.getByRole('button', { name: '다른 이동 방법 살펴보기' }).click();
  await expect(page.getByRole('dialog', { name: /무리하지 않는 다른 방법/ })).toBeVisible();
  const alternatives = page.getByRole('radio');
  await expect(alternatives).toHaveCount(4);
  for (const radio of await alternatives.all()) {
    const box = await radio.locator('xpath=..').boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

test('휴식점 부족 상세의 앞뒤 시간은 결과 카드와 일치한다', async ({ page }) => {
  await page.goto('/');
  await plan(page, { destination: '부산역', minutes: '3분', conditions: ['냉방 실내'] });
  await expect(page.getByText(/예상 8분/).first()).toBeVisible();
  await page.getByRole('button', { name: /한빛 무더위쉼터 상세 보기/ }).click();
  await expect(page.getByText(/이전 지점에서 예상 8분/)).toBeVisible();
  await expect(page.getByText(/다음 지점까지 예상 2분/)).toBeVisible();
});

test('자료 없는 지역은 휴식점 없음이 아닌 정보 부족을 표시한다', async ({ page }) => {
  await page.goto('/');
  await plan(page, { destination: '제주시청', conditions: ['물'] });
  await expect(page.getByRole('heading', { name: /정보 부족/ })).toBeVisible();
  await expect(page.getByText(/시설이 없다는 뜻은 아니/)).toBeVisible();
});

test('경로 계산 실패 시 시간을 추정하지 않는다', async ({ page }) => {
  await page.goto('/');
  await plan(page, { destination: '대전시청', minutes: '10분', conditions: ['화장실'] });
  await expect(page.getByRole('heading', { name: /경로 계산 불가/ })).toBeVisible();
  await expect(page.getByText(/임의로 추정하지 않았/)).toBeVisible();
});

test('상세에서 출처·갱신일·신뢰 이유와 정보 부족을 확인한다', async ({ page }) => {
  await page.goto('/');
  await plan(page);
  await page.getByRole('button', { name: /한빛 무더위쉼터 상세 보기/ }).click();
  await expect(page.getByRole('heading', { name: '한빛 무더위쉼터' })).toBeVisible();
  await expect(page.getByText('행정안전부 무더위쉼터 API')).toBeVisible();
  await expect(page.getByText(/마지막 갱신일/)).toBeVisible();
  await expect(page.getByText(/운영시간 정보가 없어요/)).toBeVisible();
  await expect(page.getByText(/안전도나 현재 운영/)).toBeVisible();
});

test('공유는 실제 전송 없이 포함 정보를 확인하는 미리보기다', async ({ page }) => {
  await page.goto('/');
  await plan(page);
  await page.getByRole('button', { name: '보호자에게 공유' }).click();
  await expect(page.getByRole('dialog', { name: '공유할 내용을 확인해 주세요' })).toBeVisible();
  await page.getByRole('button', { name: '공유 미리보기' }).click();
  await expect(page.getByRole('heading', { name: '보호자 공유 미리보기' })).toBeVisible();
  await expect(page.getByText(/실제 링크를 만들거나 전송하지 않아요/)).toBeVisible();
});

test('390px에서 주요 화면에 가로 DOM 오버플로가 없다', async ({ page }) => {
  await page.goto('/');
  const assertNoOverflow = async () => {
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .map((el) => el.tagName + '.' + el.className)
        .slice(0, 10),
    }));
    expect(overflow, JSON.stringify(overflow)).toEqual({ doc: 0, offenders: [] });
  };
  await assertNoOverflow();
  await plan(page);
  await assertNoOverflow();
  await page.getByRole('button', { name: /한빛 무더위쉼터 상세 보기/ }).click();
  await assertNoOverflow();
});
