# 쉬어갈지도 — 가까운 무더위쉼터 찾기

행정안전부 공식 무더위쉼터 자료를 현재 위치 또는 직접 입력한 기준 장소 주변에서 거리순으로 찾는 모바일 우선 웹앱이다.

- 운영 URL: `https://rest-stop-route.vercel.app`
- 공식 검색 인덱스: 60,672건
- 출처: 행정안전부 재난안전데이터공유플랫폼
- 이용허락범위: 제한 없음
- 모든 결과 상태: `information_insufficient`

공식 등록 정보는 당일 개방, 좌석, 냉방기 작동, 즉시 출입 가능성이나 이동 안전을 보장하지 않는다. 앱은 이 제한을 결과마다 명시하며 임의 장소, 예시 경로, 가짜 보행시간을 표시하지 않는다.

## 사용자 흐름

1. 사용자가 `현재 위치로 찾기`를 누르거나 주소·쉼터명을 직접 입력한다.
2. 검색 반경 `1·2·5·10km`와 냉방기 수량 자료 조건을 고른다.
3. 공식 등록 쉼터를 직선거리순으로 확인한다.
4. 주소, 냉방기·선풍기 수량, 이용가능인원, 공개 운영시간, 자료 수정일, 원본 ID와 출처를 확인한다.
5. 공개 쉼터 좌표를 지도에서 열거나 쉼터 정보를 보호자에게 공유한다.

## 위치정보·개인정보 경계

- 페이지 로드 시 위치를 자동 요청하지 않는다.
- 사용자가 현재 위치 버튼을 누른 뒤에만 Geolocation 권한을 요청한다.
- 위치 권한 거부·시간 초과·오류 후에도 직접 입력을 유지한다.
- 지연된 위치 응답은 사용자의 직접 선택을 덮어쓰지 않는다.
- 사용자 좌표는 브라우저 메모리에만 두고 localStorage·sessionStorage·분석 도구에 저장하지 않는다.
- 주변 조회는 POST body로만 보내며 URL과 API 응답에는 사용자 좌표를 포함하지 않는다.
- 공유문에는 선택한 쉼터 정보, 자료 제한, 공식 출처와 앱 origin만 포함한다.

## 데이터와 검색 인덱스

`scripts/build_search_index.py`가 정규화 JSONL과 하드게이트 JSONL을 `original_id`로 결합해 읽기 전용 SQLite/RTree 검색 인덱스를 만든다.

검색 인덱스에는 다음만 들어간다.

- 실제 장소명·주소·좌표
- 냉방기·선풍기 수량
- 이용가능인원
- 평일·주말 공개 운영시간
- 원본 ID·자료 수정일·수집일
- 하드게이트 상태·사유
- 공식 출처

원본 `raw` 객체, API 키, 사용자 위치와 검색 기록은 포함하지 않는다. 정제된 `prototype/data/heat-shelters.sqlite`는 공식 자료의 이용허락범위가 제한 없음으로 확인됐고 Git 기반 Vercel 배포에서도 동일 검색 결과를 재현해야 하므로 추적한다. 원본·중간 JSONL은 Git과 배포물에서 제외한다.

## 통합 API

모든 공개 UI 요청은 하나의 POST endpoint를 사용한다.

```text
POST /api/shelters
```

### 상태

```json
{ "action": "health" }
```

### 직접 입력 검색

```json
{
  "action": "search",
  "query": "휴서울이동노동자북창쉼터",
  "limit": 8
}
```

### 주변 검색

```json
{
  "action": "nearby",
  "latitude": 37.5663,
  "longitude": 126.9779,
  "radiusKm": 2,
  "aircon": "all",
  "limit": 20
}
```

- 좌표 범위, 반경 `0~20km`, 결과 수, 검색어 길이와 필터를 검증한다.
- 숫자 필드의 빈 문자열·null·불리언·배열·범위 밖 값을 HTTP 400으로 거부한다.
- SQL은 매개변수 바인딩을 사용한다.
- 주변 결과는 Haversine 직선거리로 다시 판정하고 가까운 순서로 반환한다.
- API 응답은 사용자 입력 좌표와 원본 `raw`를 되돌려주지 않는다.

## 로컬 실행

요구 환경: Node.js `22.x`, Python 3.11+, npm

```bash
cd public-app-ideas/rest-stop-route
npm install
cd prototype
npm install
npm run build:index
npm run serve
```

브라우저에서 `http://127.0.0.1:4173`을 연다.

## 테스트

```bash
cd public-app-ideas/rest-stop-route/prototype
npm test
```

현재 검증 기준:

- Python 데이터·인덱스 테스트: `6/6`
- Playwright API·UI·보안 회귀: `31/31`
- 루트·프로토타입 npm audit: 취약점 `0`
- 디자인 QA: 일반 12화면 + 200% 확대 동등 조건 3화면, 총 15화면 통과
- Vercel 로컬 프로덕션 빌드 통과

회귀 범위:

- 공식 데이터 60,672건과 출처
- 실제 쉼터명·주소 검색
- 거리순 주변 검색과 정보 부족 상태
- 한국어 IME 조합 중 DOM·포커스 유지
- 현재 위치 성공·거부·시간 초과·오류·지연 응답
- API 실패 대체 화면
- 좌표·검색 입력 유형·범위 검증
- 사용자 좌표와 위치 파생 거리의 공유문 비노출
- 서버·테스트·SQLite·라이브러리 정적 다운로드 차단
- 390px 가로 오버플로와 44px 터치 영역
- 공유문과 지도 링크

## Vercel 배포

저장소 루트가 Vercel 프로젝트 루트다.

```bash
cd public-app-ideas/rest-stop-route
npx vercel build --prod
npx vercel deploy --prebuilt --prod
```

로컬 프로덕션 빌드에서 확인해야 할 항목:

- 정적 UI: `index.html`, `styles.css`, `app.js`
- 함수: `api/shelters`
- 검색 DB: `prototype/data/heat-shelters.sqlite`
- 검색 DB SHA-256: `prototype/data/heat-shelters.sqlite.sha256`
- `better-sqlite3` Linux 네이티브 바이너리
- Node.js `22.x`

Vercel build는 SQLite의 스키마·정확한 60,672건·RTree 좌표·hard-gate JSON·공식 출처와 커밋된 SHA-256 사이드카를 검증한다. 런타임도 DB 해시가 사이드카와 일치할 때만 인덱스를 연다.

운영 배포 후에는 루트 제목, health 60,672건, 실제 직접 검색, 주변 검색, API 입력 400, 서버·테스트·DB의 404를 다시 확인한다.

## 알려진 한계

- 거리는 도로 보행거리가 아니라 직선거리다.
- 실제 iOS·Android 기기 키보드·화면 회전은 헤드리스 Chromium 검증과 별도로 확인해야 한다.
- JavaScript 비활성 환경의 검색은 지원하지 않는다.
- 공식 자료의 운영시간과 설비 수량은 현재 현장 상태를 보장하지 않는다.
- 지도 링크를 누르면 Google Maps에 공개 쉼터 좌표가 전달된다.

## 주요 파일

```text
api/shelters.mjs
lib/shelter-store.mjs
prototype/
├── index.html
├── styles.css
├── app.js
├── server.mjs
├── data/heat-shelters.sqlite
├── scripts/design-qa.mjs
├── tests/
│   ├── production-api.spec.js
│   ├── production-ui.spec.js
│   ├── prototype.spec.js
│   └── screenshot.spec.js
└── artifacts/
    ├── 01-input-390.png
    ├── 02-result-390.png
    ├── 03-detail-390.png
    └── design-qa.json
```
