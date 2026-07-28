const app = document.querySelector('#app');
const live = document.querySelector('#live');

const places = [
  { id: 'seoul-city', name: '서울시청', address: '서울특별시 중구 세종대로 110', region: '서울특별시 중구', lat: 37.5665, lon: 126.9780 },
  { id: 'seoul-library', name: '서울도서관', address: '서울특별시 중구 세종대로 110', region: '서울특별시 중구', lat: 37.5663, lon: 126.9779, scenario: 'CONNECTED' },
  { id: 'busan-station', name: '부산역', address: '부산광역시 동구 중앙대로 206', region: '부산광역시 동구', lat: 35.1151, lon: 129.0414, scenario: 'REST_GAP' },
  { id: 'jeju-city', name: '제주시청', address: '제주특별자치도 제주시 광양9길 10', region: '제주특별자치도 제주시', lat: 33.4996, lon: 126.5312, scenario: 'DATA_GAP' },
  { id: 'daejeon-city', name: '대전시청', address: '대전광역시 서구 둔산로 100', region: '대전광역시 서구', lat: 36.3504, lon: 127.3845, scenario: 'ROUTE_ERROR' },
  { id: 'gwangju-city', name: '광주시청', address: '광주광역시 서구 내방로 111', region: '광주광역시 서구', lat: 35.1601, lon: 126.8514, scenario: 'DATA_GAP' },
  { id: 'daegu-city', name: '대구시청 동인청사', address: '대구광역시 중구 공평로 88', region: '대구광역시 중구', lat: 35.8714, lon: 128.6014, scenario: 'DATA_GAP' }
];

const candidate = {
  name: '한빛 무더위쉼터',
  address: '서울특별시 중구 예시로 12 (예시 주소)',
  type: '무더위쉼터 · 공공시설',
  confirmed: ['냉방 실내', '화장실'],
  unknown: ['그늘', '벤치', '물'],
  confidence: '낮음',
  reason: '공식 출처와 갱신일은 있지만 운영시간이 제공되지 않았어요.',
  updated: '2026-07-20',
  source: '행정안전부 무더위쉼터 API',
  sourceUrl: 'https://www.data.go.kr/data/15013199/standard.do'
};

const state = {
  screen: 'input',
  start: null,
  destination: null,
  queries: { start: '', destination: '' },
  minutes: null,
  conditions: [],
  errors: {},
  lastResultScroll: 0,
  location: { status: 'idle', message: '' }
};
let locationRequestId = 0;
let pendingCompositionCommit = null;

function escapeHtml(value = '') {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function announce(message) { live.textContent = message; }
function header(backLabel, onBack) {
  return `<header class="app-header">${backLabel ? `<button class="back" data-action="${onBack}">← ${backLabel}</button>` : ''}<span class="brand">쉬어갈지도</span></header>`;
}
function safety() {
  return `<aside class="safety"><strong>폭염 이동 주의</strong><p>예상 보행시간과 휴식 후보 정보는 실제 날씨·경사·신호대기·운영 상황과 다를 수 있어요. 몸이 불편하면 이동을 멈추고 시원한 곳으로 이동하세요.</p></aside>`;
}
function emergency() {
  return `<aside class="emergency"><strong>응급 상황</strong><p>어지럼, 두통, 메스꺼움, 의식 저하 등 이상이 있으면 즉시 이동을 멈추고 주변에 도움을 요청하세요. 응급 상황에서는 119에 연락하세요.</p></aside>`;
}

function searchResults(kind) {
  const query = state.queries[kind].trim().toLowerCase();
  if (query.length < 2 || state[kind]) return '';
  const matches = places.filter((place) => `${place.name} ${place.address}`.toLowerCase().includes(query));
  return `<div class="results" aria-label="${kind === 'start' ? '출발지' : '목적지'} 검색 결과">
    ${matches.length ? matches.map((place) => `<button class="search-result" data-select-place="${kind}" data-place-id="${escapeHtml(place.id)}"><strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.address)} · ${escapeHtml(place.region)}</small></button>`).join('') : `<div class="card"><strong>장소를 찾지 못했어요.</strong><p class="search-note">도로명주소나 주변 시설명으로 다시 검색해 주세요.</p></div>`}
    <p class="search-note">장소를 찾았더라도 이 지역의 휴식 후보 자료는 부족할 수 있어요.</p>
  </div>`;
}

function placeField(kind, label) {
  const selected = state[kind];
  return `<div class="field">
    <label for="${kind}">${label}</label>
    <input id="${kind}" type="search" data-search="${kind}" value="${escapeHtml(state.queries[kind])}" placeholder="도로명주소나 시설명 검색" autocomplete="off" aria-describedby="${kind}-selected ${kind}-error">
    <div id="${kind}-selected" class="selected-place">${selected ? `선택: ${escapeHtml(selected.address)}` : ''}</div>
    ${state.errors[kind] ? `<div id="${kind}-error" class="error">${state.errors[kind]}</div>` : ''}
    ${kind === 'start' ? `<button type="button" class="location-button" data-action="use-location" ${state.location.status === 'loading' ? 'disabled' : ''}>${state.location.status === 'loading' ? '현재 위치 확인 중…' : '현재 위치 사용'}</button>
      <p class="search-note">위치 권한을 허용하면 현재 위치를 출발지로 선택해요. 좌표는 브라우저 메모리에만 유지되고 저장하지 않아요.</p>
      ${state.location.message ? `<div class="error" role="alert">${state.location.message}</div>` : ''}` : ''}
    ${searchResults(kind)}
  </div>`;
}

function renderInput() {
  state.screen = 'input';
  app.innerHTML = `${header()}
    <h1>걷기 전에,<br>쉴 후보를 이어봐요</h1>
    <p class="lede">내가 고른 보행시간 안에 다음 휴식 후보가 이어지는지 확인해요.</p>
    <aside class="card notice"><strong>☀ 주의</strong><p>폭염에는 외출을 미루거나 대중교통을 먼저 고려하세요. 쉬어갈지도는 이동 안전을 보장하지 않아요.</p></aside>
    ${Object.keys(state.errors).length ? '<div class="error-summary" role="alert" tabindex="-1">입력하지 않은 항목이 있어요.</div>' : ''}
    <section class="section stack" aria-labelledby="route-title">
      <h2 id="route-title">어디에서 어디까지 갈까요?</h2>
      <p class="search-note"><strong>전국 검색 데모</strong> · 서울·부산·대전·대구·광주·제주 예시 장소를 검색할 수 있어요.</p>
      ${placeField('start', '출발지')}
      <button class="swap" data-action="swap" ${state.start?.id === 'current-location' ? 'disabled aria-describedby="current-location-swap-note"' : ''}>↕ 출발·도착 바꾸기</button>
      ${state.start?.id === 'current-location' ? '<p id="current-location-swap-note" class="search-note swap-note">현재 위치는 출발지로만 사용할 수 있어 출발·도착을 바꿀 수 없어요.</p>' : ''}
      ${placeField('destination', '목적지')}
    </section>
    <fieldset class="section">
      <legend>한 번에 최대 몇 분까지 걸을까요?</legend>
      <p class="help">진단명이나 건강정보는 묻지 않아요. 쉬기 전까지 걷고 싶은 시간을 골라 주세요.</p>
      <div class="segment">${[3,5,10].map((m) => `<label><input type="radio" name="minutes" value="${m}" ${state.minutes === m ? 'checked' : ''}><span>${state.minutes === m ? '✓ ' : ''}${m}분</span></label>`).join('')}</div>
      ${state.errors.minutes ? `<div class="error">${state.errors.minutes}</div>` : ''}
    </fieldset>
    <fieldset class="section">
      <legend>어떤 휴식이 필요할까요?</legend><p class="help">여러 개 고를 수 있어요.</p>
      <div class="chips">${['그늘','벤치','냉방 실내','물','화장실'].map((c) => `<label><input type="checkbox" name="conditions" value="${c}" ${state.conditions.includes(c) ? 'checked' : ''}><span>${state.conditions.includes(c) ? '✓ ' : ''}${c}</span></label>`).join('')}</div>
    </fieldset>
    <p class="privacy"><span aria-hidden="true">▣</span><span>검색한 장소와 선택 조건은 사용자 이력으로 저장하지 않아요. 새로고침하면 초기화돼요.</span></p>
    <button class="primary" data-action="submit">휴식 후보 이어보기</button>`;
  bindCommon();
  document.querySelectorAll('[data-search]').forEach((input) => {
    const updateSearch = (target) => {
      const kind = target.dataset.search;
      state.queries[kind] = target.value;
      state[kind] = null;
      if (kind === 'start') {
        locationRequestId += 1;
        state.location = { status: 'idle', message: '' };
      }
      delete state.errors[kind];
      renderInput();
      const next = document.querySelector(`[data-search="${kind}"]`);
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    };
    input.addEventListener('compositionstart', () => { input.dataset.composing = 'true'; });
    input.addEventListener('compositionend', (event) => {
      delete input.dataset.composing;
      pendingCompositionCommit = { kind: event.target.dataset.search, value: event.target.value };
      updateSearch(event.target);
    });
    input.addEventListener('input', (event) => {
      if (!event.target.isConnected || event.isComposing || event.target.dataset.composing === 'true') return;
      if (pendingCompositionCommit) {
        const isDuplicateCommit = pendingCompositionCommit.kind === event.target.dataset.search
          && pendingCompositionCommit.value === event.target.value;
        pendingCompositionCommit = null;
        if (isDuplicateCommit) return;
      }
      updateSearch(event.target);
    });
  });
  document.querySelectorAll('input[name="minutes"]').forEach((input) => input.addEventListener('change', () => { state.minutes = Number(input.value); delete state.errors.minutes; renderInput(); }));
  document.querySelectorAll('input[name="conditions"]').forEach((input) => input.addEventListener('change', () => {
    state.conditions = input.checked ? [...state.conditions, input.value] : state.conditions.filter((c) => c !== input.value);
    renderInput();
  }));
  document.querySelectorAll('[data-select-place]').forEach((button) => button.addEventListener('click', () => {
    const kind = button.dataset.selectPlace;
    if (kind === 'start') cancelLocationRequest();
    state[kind] = places.find((place) => place.id === button.dataset.placeId);
    state.queries[kind] = state[kind].name;
    delete state.errors[kind];
    renderInput();
    announce(`${kind === 'start' ? '출발지' : '목적지'}로 ${state[kind].name} 선택됨`);
  }));
}

const statusContent = {
  CONNECTED: { icon: '✓', title: '조건에 맞는 후보가 이어짐', text: '선택한 조건에 맞는 휴식 후보가 이어져 있어요. 실제 운영 여부와 현장 상태는 출발 전에 다시 확인하세요.', cls: 'status-connected' },
  REST_GAP: { icon: '!', title: '휴식점 부족', text: '선택한 보행시간 안에 연결되는 휴식 후보를 찾지 못한 구간이 있어요.', cls: 'status-gap' },
  DATA_GAP: { icon: '?', title: '정보 부족', text: '이 지역은 공개자료가 부족해 휴식 후보가 없다고 판단할 수 없어요. 시설이 없다는 뜻은 아니에요.', cls: 'status-data' },
  ROUTE_ERROR: { icon: '!', title: '경로 계산 불가', text: '이 구간의 보행시간을 계산하지 못했어요. 거리나 시간을 임의로 추정하지 않았어요.', cls: 'status-error' }
};
function scenario() {
  const destinationScenario = state.destination?.scenario || 'CONNECTED';
  if (state.conditions.some((condition) => !candidate.confirmed.includes(condition))) return 'DATA_GAP';
  if (destinationScenario !== 'CONNECTED') return destinationScenario;
  return segmentTimes('CONNECTED').some((minutes) => minutes > state.minutes) ? 'REST_GAP' : 'CONNECTED';
}
function segmentTimes(type) {
  return type === 'REST_GAP'
    ? [Math.max(8, state.minutes + 5), 2]
    : [4, 5];
}
function resultTimeline(type) {
  if (type === 'DATA_GAP') return `<div class="segment-card"><h3>판단할 자료가 부족한 구간</h3><p>선택한 ‘${state.conditions.join(', ') || '조건 무관'}’ 공개자료의 범위와 갱신일을 확인하지 못했어요.</p></div>`;
  if (type === 'ROUTE_ERROR') return `<div class="segment-card"><h3>출발지 → 목적지</h3><p class="warning-inline">보행시간을 계산하지 못했어요.</p><p>직선거리 환산값이나 임의 시간은 표시하지 않아요.</p></div>`;
  const over = type === 'REST_GAP';
  const [first, second] = segmentTimes(type);
  return `<div class="segment-card ${over ? 'over' : ''}"><h3>구간 1 · ${state.start.name} → ${candidate.name}</h3><div class="duration">예상 ${first}분</div><p>${over ? `선택한 ${state.minutes}분 초과 · 약 ${first-state.minutes}분 길어요.` : `선택한 ${state.minutes}분 이내`}</p><small>지도 보행 경로 기준 예시 참고값이에요.</small></div>
    <article class="place-card"><span class="demo-badge">예시 데이터</span><h3>${candidate.name}</h3><p>${candidate.type}</p><div class="place-meta"><span><strong>확인됨</strong> · 냉방 실내, 화장실</span><span><strong>확인되지 않음</strong> · 그늘, 벤치, 물</span><span class="warning-inline">운영시간 정보 없음</span><span><strong>자료 신뢰 수준 ${candidate.confidence}</strong> · ${candidate.reason}</span><span>마지막 갱신일 ${candidate.updated}</span></div><button class="secondary" data-action="detail" aria-label="${candidate.name} 상세 보기">상세 보기</button></article>
    <div class="segment-card"><h3>구간 2 · ${candidate.name} → ${state.destination.name}</h3><div class="duration">예상 ${second}분</div><p>선택한 ${state.minutes}분 ${second > state.minutes ? '초과' : '이내'}</p></div>`;
}

function airconLabel(value) {
  return value === 'true'
    ? '공식 자료상 냉방기 수량 확인'
    : value === 'false'
      ? '공식 자료상 냉방기 수량 0대'
      : '공식 자료상 냉방기 수량 미확인';
}

function airconEvidence(value) {
  return value === 'true'
    ? '공식 자료 수량 1대 이상'
    : value === 'false'
      ? '공식 자료 수량 0대'
      : '공식 자료 수량 정보 없음';
}

const hardGateLabels = {
  internal_route_candidate: '내부 경로 후보 · 당일 상태 확인 전',
  information_insufficient: '정보 부족 · 긍정 연결 제외',
  condition_false: '냉방 조건 불충족 · 긍정 연결 제외',
};

const hardGateReasonLabels = {
  aircon_unknown: '냉방기 수량 정보 없음',
  aircon_false: '냉방기 수량 0대',
  weekend_open_unknown: '주말·휴일 개방 여부 미확인',
  duplicate_original_id: '원본 ID 중복',
  duplicate_name_address_review: '동일 이름·주소 중복 검토 필요',
  coordinate_missing_or_invalid: '좌표 누락 또는 오류',
  source_trace_missing: '원본 추적정보 누락',
  record_updated_at_invalid: '수정일 정보 오류',
  record_updated_at_in_future: '수정일이 수집 시각보다 미래임',
  access_restriction_unverified: '즉시 출입 가능 여부 미검증',
};

function hardGateReasonLabel(reason) {
  if (hardGateReasonLabels[reason]) return hardGateReasonLabels[reason];
  if (reason.startsWith('weekday_hours_')) return '평일 운영시간 정보 미완결';
  if (reason.startsWith('weekend_open_y_hours_')) return '주말·휴일 운영시간 정보 미완결';
  if (reason === 'weekend_closed_but_hours_present') return '주말 휴무 표시와 운영시간 상충';
  if (reason.includes('overnight_without_night_confirmation')) return '야간 운영 확인 정보 부족';
  return `검토 필요: ${reason}`;
}

function realShelterCard(item) {
  const hours = item.operating_hours.weekday ? `평일 ${item.operating_hours.weekday}` : '운영시간 정보 없음';
  const gateLabel = hardGateLabels[item.hard_gate_status] || '하드게이트 상태 미확인 · 긍정 연결 제외';
  const gateReasons = item.hard_gate_reasons.length
    ? item.hard_gate_reasons.map(hardGateReasonLabel).join(', ')
    : '차단 사유 없음';
  return `<article class="place-card real-place-card">
    <span class="real-badge">행정안전부 실데이터</span>
    <h3>${escapeHtml(item.name)}</h3>
    <p>${escapeHtml(item.road_address)} · 약 ${item.distance_m.toLocaleString('ko-KR')}m</p>
    <div class="place-meta">
      <span><strong>${escapeHtml(gateLabel)}</strong></span>
      <span>제한 사유 · ${escapeHtml(gateReasons)}</span>
      <span><strong>${airconLabel(item.has_aircon)}</strong> · ${airconEvidence(item.has_aircon)}</span>
      <span class="warning-inline">냉방기 수량 필드만 확인했으며 현재 작동·개방을 뜻하지 않아요.</span>
      <span>${escapeHtml(hours)}</span>
      <span>마지막 수정 ${escapeHtml(item.record_updated_at)}</span>
      <span>출처 ${escapeHtml(item.source_provider)} · 원본 ID ${escapeHtml(String(item.original_id))}</span>
      <span class="warning-inline">${escapeHtml(item.warning)}</span>
    </div>
  </article>`;
}

async function loadRealShelters() {
  const container = document.querySelector('#real-shelters');
  if (!container || !state.destination) return;
  const aircon = state.conditions.includes('냉방 실내') ? '&aircon=true' : '';
  try {
    const response = await fetch(`/api/shelters/nearby?lat=${state.destination.lat}&lon=${state.destination.lon}&radiusKm=2&limit=3${aircon}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (state.screen !== 'result' || !document.querySelector('#real-shelters')) return;
    container.innerHTML = payload.results.length
      ? `${payload.results.map(realShelterCard).join('')}<p class="help">${escapeHtml(payload.warnings.join(' '))}</p>`
      : '<div class="card"><strong>2km 안에서 조건에 맞는 공개자료를 찾지 못했어요.</strong><p>시설이 없다는 뜻은 아니에요.</p></div>';
  } catch {
    if (state.screen === 'result' && document.querySelector('#real-shelters')) {
      container.innerHTML = '<div class="card"><strong>실데이터를 불러오지 못했어요.</strong><p>공개 배포에는 재배포 검토 전 실데이터를 포함하지 않아요. 시설 유무를 판단할 수 없어요.</p></div>';
    }
  }
}

function miniMap(type) {
  return `<div class="mini-map" aria-label="경로 순서 미니맵"><div class="map-path"><span class="map-node">출</span><span class="map-node">${type === 'DATA_GAP' || type === 'ROUTE_ERROR' ? '?' : '1'}</span><span class="map-node">도</span></div><div class="map-labels"><span>출발</span><span>${type === 'DATA_GAP' ? '정보 부족' : type === 'ROUTE_ERROR' ? '계산 불가' : '휴식 후보'}</span><span>도착</span></div></div>`;
}
function renderResult() {
  state.screen = 'result';
  const type = scenario(); const status = statusContent[type];
  app.innerHTML = `${header('조건으로', 'input')}
    <h1>연결 결과</h1><span class="demo-badge">경로·시간 예시 데이터</span><p class="route-summary">${state.start.name} → ${state.destination.name}<br>최대 ${state.minutes}분 · ${state.conditions.join(', ') || '조건 무관'}</p>
    <button class="text-button" data-action="input">조건 바꾸기</button>
    <section class="card status-card ${status.cls}"><span class="status-badge">${status.icon} ${status.title}</span><h2>${status.icon} ${status.title}</h2><p>${status.text}</p></section>
    ${(type === 'REST_GAP' || type === 'DATA_GAP') ? '<aside class="card notice"><strong>무리해서 이동하지 마세요.</strong><p>이동을 미루거나 대중교통·택시·보호자 동행 같은 대안을 검토하세요.</p></aside>' : ''}
    <details class="card data-summary"><summary>자료 범위 보기</summary><p><strong>예시 데이터 · 출처 2곳 · 가장 오래된 갱신 2025.08</strong></p><ul><li>확인 범위: 선택 지역의 내부 시연용 표본</li><li>그늘·벤치·물 조건은 지역별 자료가 일부 또는 없음</li><li>실제 전국 완전 커버를 뜻하지 않음</li></ul></details>
    ${miniMap(type)}
    <section class="timeline" aria-label="구간과 휴식 후보 목록">${resultTimeline(type)}</section>
    <section class="section" role="region" aria-label="목적지 주변 무더위쉼터 실데이터"><h2>목적지 주변 무더위쉼터 실데이터</h2><p class="warning-inline"><strong>참고 목록 · 경로 연결에 사용하지 않음</strong></p><p class="help">91MB 원본 대신 로컬 SQLite 공간 인덱스에서 2km 이내 최대 3건만 불러와요. 각 카드의 하드게이트 상태와 제한 사유를 확인하세요.</p><div id="real-shelters" class="stack" aria-live="polite"><div class="card">공식 쉼터 자료를 찾는 중이에요.</div></div></section>
    ${safety()}
    <div class="actions">${(type === 'REST_GAP' || type === 'DATA_GAP') ? '<button class="primary" data-action="alternatives">다른 이동 방법 살펴보기</button>' : type === 'ROUTE_ERROR' ? '<button class="primary" data-action="input">출발·목적지 수정하기</button>' : '<button class="primary" data-action="detail">후보별 정보 확인하기</button>'}<button class="secondary" data-action="share">보호자에게 공유</button></div>
    ${emergency()}`;
  bindCommon();
  loadRealShelters();
  announce(`${status.title} 결과 화면`);
}

function renderDetail() {
  state.screen = 'detail';
  const [previousMinutes, nextMinutes] = segmentTimes(scenario());
  app.innerHTML = `${header('결과로', 'result')}
    <span class="demo-badge">예시 데이터</span><h1>${candidate.name}</h1><p class="lede">${candidate.address}<br>${candidate.type}</p>
    <section class="card"><span class="confidence">자료 신뢰 수준: ${candidate.confidence}</span><h2>왜 ${candidate.confidence}인가요?</h2><p>${candidate.reason}</p><p class="help">이 표시는 장소의 안전도나 현재 운영을 뜻하지 않아요.</p></section>
    <section class="section"><h2>휴식 조건</h2><div class="condition-columns"><div class="condition-box"><strong>자료에서 확인됨</strong><span>${candidate.confirmed.join(', ')}</span></div><div class="condition-box"><strong>확인되지 않음</strong><span>${candidate.unknown.join(', ')}</span></div></div><p class="help">확인되지 않음은 해당 조건이 없다는 뜻이 아니에요.</p></section>
    <section class="section"><h2>운영·이용 정보</h2><div class="card"><dl class="definition"><dt>운영시간</dt><dd><strong>정보 없음</strong></dd><dt>휴무·제한</dt><dd>정보 없음</dd></dl><p class="warning-inline">운영시간 정보가 없어요. 이용 가능 여부를 보장하지 않아요.</p></div></section>
    <section class="section"><h2>앞·뒤 구간</h2><div class="card"><p>이전 지점에서 예상 ${previousMinutes}분 · 선택한 ${state.minutes}분 ${previousMinutes > state.minutes ? '초과' : '이내'}</p><p>다음 지점까지 예상 ${nextMinutes}분 · 선택한 ${state.minutes}분 ${nextMinutes > state.minutes ? '초과' : '이내'}</p></div></section>
    <section class="section"><h2>출처와 갱신 정보</h2><div class="card"><dl class="definition"><dt>출처</dt><dd>${candidate.source}</dd><dt>마지막 갱신일</dt><dd>${candidate.updated}</dd><dt>자료 신뢰 이유</dt><dd>${candidate.reason}</dd></dl><button class="text-button" data-action="source">공식 원문 보기</button></div></section>
    <aside class="card notice"><strong>정정·현장 확인 안내</strong><p>첫 버전에서는 정정 제보를 받지 않아요. 이용 전 공식 원문이나 현장 안내를 다시 확인해 주세요.</p></aside>
    <div class="actions"><button class="primary" data-action="map">지도 앱에서 위치 열기</button><button class="secondary" data-action="share">보호자에게 공유</button><button class="text-button" data-action="result">결과로 돌아가기</button></div>
    ${safety()}${emergency()}`;
  bindCommon();
  announce(`${candidate.name} 상세 화면`);
}

function dialog(title, body, primaryLabel, primaryAction, secondaryLabel = '취소') {
  const el = document.createElement('dialog');
  el.setAttribute('aria-label', title);
  el.innerHTML = `<h2>${title}</h2>${body}<div class="dialog-actions"><button class="primary" data-dialog-action="${primaryAction}">${primaryLabel}</button><button class="secondary" data-dialog-close>${secondaryLabel}</button></div>`;
  document.body.appendChild(el);
  el.querySelector('[data-dialog-close]').addEventListener('click', () => el.close());
  el.addEventListener('close', () => el.remove());
  el.querySelector('[data-dialog-action]').addEventListener('click', () => handleDialogAction(primaryAction, el));
  el.showModal();
  el.querySelector('button').focus();
}
function handleDialogAction(action, el) {
  if (action === 'continue-no-condition') { el.close(); renderResult(); }
  if (action === 'share-preview') {
    el.close();
    el.remove();
    dialog('보호자 공유 미리보기', `<div class="share-preview"><strong>${state.start.name} → ${state.destination.name}</strong><p>최대 ${state.minutes}분 · ${state.conditions.join(', ') || '조건 무관'}</p><p>결과: ${statusContent[scenario()].title}</p><p>자료 기준일: 예시 데이터 ${candidate.updated}</p></div><p class="help">프로토타입에서는 실제 링크를 만들거나 전송하지 않아요.</p>`, '미리보기 닫기', 'close-preview', '결과 보기');
  }
  if (action === 'close-preview') el.close();
  if (action === 'close-alternatives') { announce('대안 검토 선택됨 — 외부 서비스는 열지 않았어요.'); el.close(); }
  if (action === 'open-map' || action === 'open-source') { announce('프로토타입이라 외부 페이지는 열지 않았어요.'); el.close(); }
}
function useCurrentLocation() {
  const requestId = ++locationRequestId;
  if (!navigator.geolocation) {
    state.location = { status: 'error', message: '이 브라우저에서는 현재 위치를 사용할 수 없어요. 시설명을 직접 입력해 주세요.' };
    renderInput();
    return;
  }
  state.location = { status: 'loading', message: '' };
  renderInput();
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      if (requestId !== locationRequestId || state.location.status !== 'loading') return;
      const { latitude, longitude, accuracy } = coords;
      if (![latitude, longitude].every(Number.isFinite)) {
        state.location = { status: 'error', message: '현재 위치 좌표를 확인하지 못했어요. 시설명을 직접 입력해 주세요.' };
        renderInput();
        return;
      }
      const accuracyText = Number.isFinite(accuracy) ? ` · 정확도 약 ${Math.round(accuracy)}m` : '';
      state.start = {
        id: 'current-location',
        name: '현재 위치',
        address: `기기 위치정보로 선택됨${accuracyText}`,
        region: '현재 위치',
        lat: latitude,
        lon: longitude,
      };
      state.queries.start = '현재 위치';
      state.location = { status: 'ready', message: '' };
      delete state.errors.start;
      renderInput();
      announce('현재 위치를 출발지로 선택했어요.');
    },
    (error) => {
      if (requestId !== locationRequestId || state.location.status !== 'loading') return;
      const messages = {
        1: '위치 권한이 거부됐어요. 브라우저 설정에서 허용하거나 시설명을 직접 입력해 주세요.',
        2: '현재 위치를 확인하지 못했어요. 잠시 후 다시 시도하거나 시설명을 직접 입력해 주세요.',
        3: '현재 위치 확인 시간이 초과됐어요. 다시 시도하거나 시설명을 직접 입력해 주세요.',
      };
      state.location = { status: 'error', message: messages[error.code] || '현재 위치를 사용할 수 없어요. 시설명을 직접 입력해 주세요.' };
      renderInput();
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
}
function cancelLocationRequest() {
  locationRequestId += 1;
  if (state.location.status === 'loading') state.location = { status: 'idle', message: '' };
}
function validateAndSubmit() {
  cancelLocationRequest();
  state.errors = {};
  if (!state.start) state.errors.start = '출발지를 선택해 주세요.';
  if (!state.destination) state.errors.destination = '목적지를 선택해 주세요.';
  if (!state.minutes) state.errors.minutes = '최대 연속 보행시간을 골라 주세요.';
  if (state.start && state.destination && state.start.id === state.destination.id) state.errors.destination = '출발지와 목적지가 같아요. 다른 장소를 선택해 주세요.';
  if (Object.keys(state.errors).length) {
    renderInput();
    requestAnimationFrame(() => { document.querySelector('.error-summary')?.focus(); document.querySelector(`#${Object.keys(state.errors)[0]}`)?.focus(); });
    return;
  }
  if (!state.conditions.length) dialog('휴식 조건 없이 볼까요?', '<p>조건을 고르지 않으면 그늘·벤치·냉방 실내·물·화장실 여부와 관계없이 후보를 보여드려요.</p>', '조건 무관으로 계속', 'continue-no-condition', '조건 고르기');
  else renderResult();
}
function bindCommon() {
  document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'submit') validateAndSubmit();
    if (action === 'use-location') useCurrentLocation();
    if (action === 'input') renderInput();
    if (action === 'result') renderResult();
    if (action === 'detail') { state.lastResultScroll = scrollY; renderDetail(); window.scrollTo(0,0); }
    if (action === 'swap') { cancelLocationRequest(); [state.start, state.destination] = [state.destination, state.start]; [state.queries.start, state.queries.destination] = [state.queries.destination, state.queries.start]; renderInput(); }
    if (action === 'share') dialog('공유할 내용을 확인해 주세요', '<p>출발지·목적지·선택 조건·예상 경로·자료 기준일이 포함돼요.</p><p class="help">프로토타입에서는 실제 링크를 만들거나 전송하지 않아요.</p>', '공유 미리보기', 'share-preview');
    if (action === 'alternatives') dialog('무리하지 않는 다른 방법을 먼저 살펴보세요', '<div class="stack"><label><input type="radio" name="alt"> 이동 미루기</label><label><input type="radio" name="alt"> 대중교통 확인</label><label><input type="radio" name="alt"> 택시 이용</label><label><input type="radio" name="alt"> 보호자와 동행 상의</label></div><p class="help">외부 예약·호출은 하지 않아요.</p>', '선택 완료', 'close-alternatives', '결과 다시 보기');
    if (action === 'map') dialog('지도 앱에서 위치를 열까요?', '<p>외부 지도는 위치 확인용이에요. 쉬어갈지도의 휴식 조건이나 구간 판단이 반영되지 않을 수 있어요.</p>', '위치 열기', 'open-map');
    if (action === 'source') dialog('공식 원문을 확인할까요?', `<p>${candidate.source}</p><p class="help">클릭 프로토타입에서는 외부 전환 없이 확인 단계만 시연해요.</p>`, '원문 위치 확인', 'open-source');
  }));
}

renderInput();
