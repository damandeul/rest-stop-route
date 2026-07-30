const app = document.querySelector('#app');
const live = document.querySelector('#live');
const OFFICIAL_SOURCE_URL = 'https://www.safetydata.go.kr/disaster-data/view?dataSn=1338';

const state = {
  center: null,
  centerLabel: '',
  radiusKm: 2,
  aircon: 'all',
  view: 'search',
  searchResults: [],
  shelters: [],
  loading: false,
  message: '',
};

function announce(message) {
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = message; });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function header(backLabel = '') {
  return `<header class="app-header">
    ${backLabel ? `<button class="back" type="button" id="back-button">← ${backLabel}</button>` : ''}
    <span class="brand"><span class="brand-line" aria-hidden="true"></span>쉬어갈지도</span>
  </header>`;
}

function renderSearch() {
  app.innerHTML = `${header()}
    <section aria-labelledby="page-title">
      <h1 id="page-title">가까운 무더위쉼터를 찾아봐요</h1>
      <p class="lede">현재 위치나 직접 선택한 기준 장소 주변의 공식 등록 쉼터를 거리순으로 확인해요.</p>
      <div class="notice card">
        <strong>폭염 이동 주의</strong>
        <p>등록 정보만으로 당일 개방, 좌석, 냉방기 작동을 알 수 없어요. 이용 전 공식 원문이나 현장 안내를 다시 확인하세요.</p>
      </div>
    </section>

    <section class="section" aria-labelledby="location-title">
      <h2 id="location-title">어디 주변을 찾아볼까요?</h2>
      <div class="location-choice">
        <div>
          <strong>지금 있는 곳에서 찾기</strong>
          <p>버튼을 누를 때만 위치 권한을 요청해요.</p>
        </div>
        <button id="use-current-location" class="location-button" type="button">현재 위치로 찾기</button>
      </div>
      <div class="choice-divider"><span>또는 직접 입력</span></div>
      <div class="field">
        <label for="place-query">주소나 쉼터명으로 기준 장소 찾기</label>
        <input id="place-query" type="search" autocomplete="off" enterkeyhint="search" placeholder="예: 종로구, 주민센터, 도로명주소" aria-describedby="search-help">
        <p id="search-help" class="search-note">공식 쉼터의 이름·주소에서 검색하며, 결과 한 곳을 기준 위치로 사용해요.</p>
        <div id="place-results" class="results" role="listbox" aria-label="기준 장소 검색 결과"></div>
        <p id="selected-place" class="selected-place" aria-live="polite"></p>
      </div>
    </section>

    <fieldset class="section">
      <legend>얼마나 넓게 찾아볼까요?</legend>
      <p class="help">직선거리 기준이며 실제 보행거리와 다를 수 있어요.</p>
      <div class="segment">
        ${[1, 2, 5, 10].map((radius) => `<label><input type="radio" name="radius" value="${radius}" ${radius === state.radiusKm ? 'checked' : ''}><span>${radius}km</span></label>`).join('')}
      </div>
    </fieldset>

    <fieldset class="section">
      <legend>냉방기 수량 자료</legend>
      <p class="help">수량이 있어도 현재 작동 중이라는 뜻은 아니에요.</p>
      <div class="chips">
        <label><input type="radio" name="aircon" value="all" ${state.aircon === 'all' ? 'checked' : ''}><span>전체 보기</span></label>
        <label><input type="radio" name="aircon" value="true" ${state.aircon === 'true' ? 'checked' : ''}><span>1대 이상만</span></label>
      </div>
    </fieldset>

    <p class="privacy"><span aria-hidden="true">▣</span><span>위치는 검색에만 사용하고 앱에서 저장하지 않아요.</span></p>
    <button id="find-shelters" class="primary" type="button" disabled>주변 쉼터 보기</button>

    <section class="data-summary section" aria-label="데이터 출처">
      <strong>행정안전부 공식자료 60,672건</strong>
      <p>재난안전데이터공유플랫폼 · 이용허락범위 제한 없음</p>
    </section>
  `;
  bindSearchEvents();
}

let searchTimer = null;
let searchController = null;
let composing = false;
let locationRequestId = 0;
let nearbyController = null;
let nearbyRequestId = 0;

function resetLocationButton() {
  const button = document.querySelector('#use-current-location');
  if (!button) return;
  button.disabled = false;
  button.removeAttribute('aria-busy');
  button.textContent = '현재 위치로 찾기';
}

function cancelLocationRequest() {
  locationRequestId += 1;
  resetLocationButton();
}

function cancelNearbyRequest() {
  nearbyRequestId += 1;
  nearbyController?.abort();
  nearbyController = null;
  state.loading = false;
}

async function postAction(payload, signal) {
  const response = await fetch('/api/shelters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || '데이터를 불러오지 못했어요.');
  return body;
}

function renderPlaceResults(results) {
  const container = document.querySelector('#place-results');
  if (!container) return;
  container.replaceChildren();
  for (const result of results) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result';
    button.setAttribute('role', 'option');
    const name = document.createElement('strong');
    name.textContent = result.name;
    const address = document.createElement('small');
    address.textContent = result.road_address || result.lot_address || '주소 자료 없음';
    button.append(name, address);
    button.addEventListener('click', () => selectCenter(result));
    container.append(button);
  }
  if (!results.length) {
    const empty = document.createElement('p');
    empty.className = 'search-note search-empty';
    empty.textContent = '일치하는 공식 쉼터를 찾지 못했어요. 다른 주소나 시설명을 입력해 보세요.';
    container.append(empty);
  }
}

function selectCenter(result) {
  cancelLocationRequest();
  state.center = { latitude: Number(result.lat), longitude: Number(result.lon) };
  state.centerLabel = result.name;
  const selected = document.querySelector('#selected-place');
  const input = document.querySelector('#place-query');
  const button = document.querySelector('#find-shelters');
  if (input) input.value = result.name;
  if (selected) selected.textContent = `선택한 기준 장소 · ${result.name} · ${result.road_address || result.lot_address || '주소 자료 없음'}`;
  if (button) button.disabled = false;
  renderPlaceResults([]);
  const results = document.querySelector('#place-results');
  if (results) results.replaceChildren();
  announce(`${result.name}을 기준 장소로 선택했어요.`);
}

function handleCurrentLocation() {
  const button = document.querySelector('#use-current-location');
  const selected = document.querySelector('#selected-place');
  const input = document.querySelector('#place-query');
  const findButton = document.querySelector('#find-shelters');
  const requestId = ++locationRequestId;
  state.center = null;
  state.centerLabel = '';
  if (findButton) findButton.disabled = true;
  if (selected) selected.textContent = '';
  const finish = () => {
    resetLocationButton();
  };
  const fail = (message) => {
    if (requestId !== locationRequestId) return;
    state.center = null;
    state.centerLabel = '';
    if (findButton) findButton.disabled = true;
    if (selected) selected.textContent = `${message} 주소나 쉼터명으로 계속 찾을 수 있어요.`;
    finish();
    input?.focus();
    announce(selected?.textContent || message);
  };
  if (!navigator.geolocation) {
    fail('이 브라우저에서는 현재 위치를 사용할 수 없어요.');
    return;
  }
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = '위치 확인 중…';
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      if (requestId !== locationRequestId) return;
      const latitude = Number(coords?.latitude);
      const longitude = Number(coords?.longitude);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        fail('현재 위치 값이 올바르지 않아요.');
        return;
      }
      state.center = { latitude, longitude };
      state.centerLabel = '현재 위치';
      if (selected) selected.textContent = '현재 위치를 기준 장소로 선택했어요.';
      if (findButton) findButton.disabled = false;
      finish();
      announce(selected?.textContent || '현재 위치를 기준 장소로 선택했어요.');
    },
    (error) => {
      const messages = {
        1: '위치 권한이 허용되지 않았어요.',
        2: '현재 위치를 확인하지 못했어요.',
        3: '위치 확인 시간이 초과됐어요.',
      };
      fail(messages[error?.code] || '현재 위치를 확인하지 못했어요.');
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
  );
}

function formatDistance(distanceM) {
  return distanceM < 1000 ? `약 ${distanceM}m` : `약 ${(distanceM / 1000).toFixed(1)}km`;
}

function formatHours(hours) {
  if (!hours?.weekday && !hours?.weekend) return '운영시간 자료 없음';
  const parts = [];
  if (hours.weekday) parts.push(`평일 ${hours.weekday}`);
  if (hours.weekend) parts.push(`주말·휴일 ${hours.weekend}`);
  return parts.join(' · ');
}

function quantity(value, unit) {
  return Number.isInteger(value) ? `${value.toLocaleString('ko-KR')}${unit}` : '자료 없음';
}

function shelterCard(shelter) {
  const name = escapeHtml(shelter.name);
  const address = escapeHtml(shelter.road_address || shelter.lot_address || '주소 자료 없음');
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${shelter.lat},${shelter.lon}`)}`;
  return `<article class="real-place-card" data-shelter-id="${escapeHtml(shelter.original_id)}">
    <span class="real-badge">행정안전부 공식 등록</span>
    <h2>${name}</h2>
    <p>${address} · <strong>${escapeHtml(formatDistance(shelter.distance_m))}</strong></p>
    <p class="warning-inline">정보 부족 · 당일 운영 확인 필요</p>
    <dl class="definition shelter-facts">
      <dt>냉방기 수량</dt><dd>${escapeHtml(quantity(shelter.aircon_count, '대'))}</dd>
      <dt>선풍기 수량</dt><dd>${escapeHtml(quantity(shelter.fan_count, '대'))}</dd>
      <dt>이용가능인원</dt><dd>${escapeHtml(quantity(shelter.capacity, '명'))}</dd>
      <dt>공개 운영시간</dt><dd>${escapeHtml(formatHours(shelter.operating_hours))}</dd>
      <dt>자료 수정</dt><dd>${escapeHtml(shelter.record_updated_at || '자료 없음')}</dd>
    </dl>
    <p class="warning-copy">수량과 운영시간 자료는 현재 개방·작동·좌석을 보장하지 않아요.</p>
    <details>
      <summary>출처와 제한 사유 보기</summary>
      <p>출처: <a href="${OFFICIAL_SOURCE_URL}" target="_blank" rel="noopener noreferrer">행정안전부</a> · 원본 ID ${escapeHtml(shelter.original_id)}</p>
      <p>즉시 출입 가능 여부와 주말·휴일 개방 여부를 독립적으로 확인하지 못해 긍정 경로 후보에서는 제외했어요.</p>
    </details>
    <div class="shelter-actions">
      <a class="secondary button-link" href="${escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer">지도에서 위치 열기</a>
      <button class="text-button share-shelter" type="button" data-share-id="${escapeHtml(shelter.original_id)}">보호자에게 정보 공유</button>
      <p class="share-feedback" role="status"></p>
    </div>
  </article>`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.className = 'sr-only';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('복사하지 못했어요.');
}

function bindResultActions() {
  document.querySelectorAll('.share-shelter').forEach((button) => {
    button.addEventListener('click', async () => {
      const shelter = state.shelters.find((item) => String(item.original_id) === button.dataset.shareId);
      const feedback = button.parentElement.querySelector('.share-feedback');
      if (!shelter) return;
      const address = shelter.road_address || shelter.lot_address || '주소 자료 없음';
      const text = [
        shelter.name,
        address,
        `냉방기 수량: ${quantity(shelter.aircon_count, '대')}`,
        '정보 부족: 당일 개방·좌석·냉방기 작동은 이용 전 확인이 필요해요.',
        '출처: 행정안전부 재난안전데이터공유플랫폼',
      ].join('\n');
      try {
        if (navigator.share) {
          await navigator.share({ title: `쉬어갈지도 · ${shelter.name}`, text, url: window.location.origin });
          feedback.textContent = '공유 창을 열었어요.';
        } else {
          await copyText(`${text}\n${window.location.origin}`);
          feedback.textContent = '쉼터 정보를 복사했어요.';
        }
      } catch (error) {
        feedback.textContent = error.name === 'AbortError' ? '공유를 취소했어요.' : '공유하지 못했어요. 다시 시도해 주세요.';
      }
      announce(feedback.textContent);
    });
  });
}

function renderResults(status = 'ready') {
  const label = escapeHtml(state.centerLabel || '선택한 장소');
  const count = state.shelters.length;
  app.innerHTML = `${header('다시 찾기')}
    <section aria-labelledby="results-title">
      <h1 id="results-title">${label} 주변 공식 쉼터</h1>
      <p class="lede">직선거리 ${escapeHtml(state.radiusKm)}km 안의 행정안전부 등록 자료를 가까운 순서로 보여드려요.</p>
      <div class="notice card">
        <strong>모든 결과는 정보 부족 상태예요</strong>
        <p>공식 등록은 확인됐지만 당일 개방, 좌석, 냉방기 작동, 즉시 출입 가능 여부는 확인되지 않았어요.</p>
      </div>
    </section>
    ${status === 'loading' ? '<p class="loading-status" role="status">공식 쉼터를 찾고 있어요…</p>' : ''}
    ${status === 'error' ? `<div class="error-summary" role="alert">${escapeHtml(state.message)}</div>` : ''}
    ${status === 'ready' ? `<section class="section" aria-labelledby="list-title">
      <h2 id="list-title">검색 결과 ${count.toLocaleString('ko-KR')}곳</h2>
      ${count ? `<div id="real-shelters">${state.shelters.map(shelterCard).join('')}</div>` : `<div class="card empty-state"><h3>이 반경에서는 쉼터를 찾지 못했어요</h3><p>더 넓은 반경으로 다시 찾아보거나 다른 기준 장소를 선택해 보세요.</p></div>`}
    </section>` : ''}
    <section class="data-summary section" aria-label="데이터 출처">
      <strong>출처 · <a href="https://www.safetydata.go.kr/disaster-data/view?dataSn=1338" target="_blank" rel="noopener noreferrer">행정안전부</a></strong>
      <p>재난안전데이터공유플랫폼 · 이용허락범위 제한 없음 · 검색용 인덱스 60,672건</p>
    </section>
    <div class="safety"><strong>폭염 이동 주의</strong><p>몸이 불편하면 이동을 멈추고 시원한 곳으로 이동하세요. 어지럼, 두통, 메스꺼움, 의식 저하가 있으면 119에 연락하세요.</p></div>
  `;
  document.querySelector('#back-button').addEventListener('click', () => {
    cancelNearbyRequest();
    state.center = null;
    state.centerLabel = '';
    state.shelters = [];
    renderSearch();
    app.focus();
  });
  if (status === 'ready') bindResultActions();
}

async function loadNearby() {
  if (!state.center || state.loading) return;
  const requestId = ++nearbyRequestId;
  nearbyController = new AbortController();
  state.loading = true;
  state.view = 'results';
  renderResults('loading');
  try {
    const body = await postAction({
      action: 'nearby',
      latitude: state.center.latitude,
      longitude: state.center.longitude,
      radiusKm: state.radiusKm,
      aircon: state.aircon,
      limit: 20,
    }, nearbyController.signal);
    if (requestId !== nearbyRequestId) return;
    state.shelters = body.results;
    state.message = '';
    renderResults('ready');
    announce(`${body.results.length}곳의 공식 쉼터를 찾았어요.`);
  } catch (error) {
    if (requestId !== nearbyRequestId || error.name === 'AbortError') return;
    state.shelters = [];
    state.message = error.message;
    renderResults('error');
    announce(error.message);
  } finally {
    if (requestId === nearbyRequestId) {
      state.loading = false;
      nearbyController = null;
    }
  }
}

function scheduleSearch(value) {
  cancelLocationRequest();
  clearTimeout(searchTimer);
  if (searchController) searchController.abort();
  const query = value.trim();
  state.center = null;
  state.centerLabel = '';
  const selected = document.querySelector('#selected-place');
  const submit = document.querySelector('#find-shelters');
  if (selected) selected.textContent = '';
  if (submit) submit.disabled = true;
  if (query.length < 2) {
    renderPlaceResults([]);
    const results = document.querySelector('#place-results');
    if (results) results.replaceChildren();
    return;
  }
  searchTimer = setTimeout(async () => {
    searchController = new AbortController();
    try {
      const body = await postAction({ action: 'search', query, limit: 8 }, searchController.signal);
      if (document.querySelector('#place-query')?.value.trim() !== query) return;
      renderPlaceResults(body.results);
      announce(`${body.results.length}개의 기준 장소를 찾았어요.`);
    } catch (error) {
      if (error.name === 'AbortError') return;
      renderPlaceResults([]);
      announce(error.message);
    }
  }, 220);
}

function bindSearchEvents() {
  const input = document.querySelector('#place-query');
  document.querySelector('#use-current-location').addEventListener('click', handleCurrentLocation);
  input.addEventListener('compositionstart', () => {
    composing = true;
    cancelLocationRequest();
    state.center = null;
    state.centerLabel = '';
    document.querySelector('#selected-place').textContent = '';
    document.querySelector('#find-shelters').disabled = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    scheduleSearch(input.value);
  });
  input.addEventListener('input', () => {
    if (!composing) scheduleSearch(input.value);
  });
  document.querySelectorAll('input[name="radius"]').forEach((radio) => {
    radio.addEventListener('change', () => { state.radiusKm = Number(radio.value); });
  });
  document.querySelectorAll('input[name="aircon"]').forEach((radio) => {
    radio.addEventListener('change', () => { state.aircon = radio.value; });
  });
  document.querySelector('#find-shelters').addEventListener('click', loadNearby);
}

renderSearch();
