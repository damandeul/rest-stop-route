# 쉬어갈지도 Phase 2 — 무더위쉼터 실데이터 로컬 검색 연결

> **현재 상태(2026-07-28):** 이 문서는 초기 로컬 통합 실행 기록이다. 후속 보안 재검토에서 행별 접근조건 미검증을 하드게이트로 추가해 60,672건 전부를 `information_insufficient`로 분류했다. 전체 데이터와 SQLite는 이용조건 검토 전 Git/Vercel에서 제외하며, 공개 Vercel 배포는 UI 파일 3개만 포함한다.

- 검증 시각: 2026-07-27 15:58 KST
- 범위: 내부 로컬 프로토타입
- 공개 배포·유료 API·외부 사용자 접촉: 실행하지 않음
- 입력: `PHASE_2_DATA_STATUS.md`, `DATA_TRUST_MODEL.md`, `data/processed/heat-shelters.jsonl`

## 1. 구현 결과

91,649,084바이트 JSONL 60,672건을 브라우저에 직접 싣지 않고 검색 필드만 담은 24,858,624바이트 SQLite 인덱스로 변환했다. 인덱스는 원본의 27.12% 크기다.

흐름:

```text
브라우저
  → GET /api/shelters/nearby (최대 50건, 반경 최대 20km)
  → 127.0.0.1 Node 서버
  → SQLite RTree 경계 상자 검색
  → Haversine 실제 반경 재판정·거리순 정렬
```

구현 파일:

- `scripts/build_search_index.py`: JSONL → SQLite/RTree 원자적 빌드, 소스 크기·mtime 기반 재빌드 생략
- `prototype/data/heat-shelters.sqlite`: 60,672건 읽기 전용 검색 인덱스
- `prototype/server.mjs`: 상태·좌표 주변 검색 API, 입력 검증, 제한 응답
- `prototype/app.js`: 목적지 좌표 주변 2km 공식 실데이터 최대 3건 표시
- `prototype/tests/prototype.spec.js`: 실데이터 API·UI 회귀 테스트 7개 추가
- `prototype/README.md`: 구조, 빌드·실행, API, 안전 경계, 한계 문서화

## 2. 데이터 보존 규칙

- 냉방은 문자열 `true / false / unknown` 3값을 그대로 보존한다.
- `unknown`을 `false`나 냉방 조건 충족으로 변환하지 않는다.
- 결과마다 `source_provider`, `source_url`, `original_id`, `record_updated_at`, `ingested_at`을 돌려준다.
- 평일·주말 운영시간은 서로 분리하며 결측을 가짜 시간으로 채우지 않는다.
- 운영시간이 없으면 `운영시간 정보가 없어 현재 운영·개방 여부를 확인`하라는 개별 경고를 표시한다.
- 모든 API 응답은 당일 개방·좌석·냉방기 작동을 보장하지 않는다는 공통 경고를 포함한다.
- 데이터의 `raw` 객체는 인덱스와 API 응답에 넣지 않았다.
- 실데이터 주변 검색은 아직 예시 경로의 연결점이나 보행시간 계산에 사용하지 않는다. 화면에서도 이 경계를 명시한다.

## 3. API

### 상태

`GET /api/health`

인덱스 준비 상태, 레코드 수, 수집시각, 공식 출처를 제공한다. 인덱스가 없으면 정적 프로토타입을 죽이지 않고 HTTP 503과 빌드 안내를 반환한다.

### 좌표 주변 검색

`GET /api/shelters/nearby?lat=37.5663&lon=126.9779&radiusKm=2&aircon=true&limit=10`

- 필수: `lat`, `lon`
- 선택: `radiusKm` 기본 2, 범위 `(0, 20]`
- 선택: `aircon=true|false|unknown`; 생략하면 전체
- 선택: `limit` 기본 10, 범위 1~50
- 잘못된 좌표·반경·필터·limit: HTTP 400
- API 미정의 경로: HTTP 404 JSON

## 4. 실제 검증 결과

### TDD RED

새 API 테스트 6개를 먼저 추가하고 실행했다. 구현 전 `/api/health`와 `/api/shelters/nearby`가 모두 HTTP 404여서 6개가 요구한 이유로 실패하는 것을 확인했다. UI 실데이터 테스트도 먼저 추가했고, 접근 가능한 `목적지 주변 무더위쉼터 실데이터` 영역이 없어 실패함을 확인했다.

### 전체 회귀·신규 테스트

명령:

```bash
cd public-app-ideas/rest-stop-route/prototype
npm test -- --reporter=line
```

실제 결과:

```text
Running 22 tests using 2 workers
22 passed (4.8s)
```

기존 15개 회귀 테스트와 신규 7개 실데이터 테스트가 모두 통과했다. 신규 검증은 다음을 포함한다.

1. 인덱스 상태의 60,672건·행정안전부 출처
2. 좌표 주변 검색
3. 냉방 `true`, `false`, `unknown` 각각의 실제 레코드
4. 거리순 결과와 반경 제한
5. 출처·수정시각·운영시간·경고 보존 및 `raw` 비노출
6. 잘못된 좌표·반경·냉방 필터의 HTTP 400
7. 브라우저 결과 화면의 공식 실데이터 로딩

### 인덱스 무결성

실제 SQLite 검사:

```text
PRAGMA integrity_check: ok
shelters: 60,672
shelter_geo RTree: 60,672
has_aircon false: 478
has_aircon true: 57,385
has_aircon unknown: 2,809
```

### 검색 응답 표본

서울도서관 좌표, 반경 2km, 냉방 true, limit 10:

```text
HTTP 200
응답 6,801바이트
실측 응답시간 0.009641초
결과 10건
첫 결과: 휴서울이동노동자북창쉼터, 415m
```

이 값은 로컬 단일 실행의 관찰값이며 성능 보장 수치가 아니다.

### 정적·보안 검사

- `python3 -m py_compile ../scripts/build_search_index.py`: 통과
- `node --check server.mjs`: 통과
- `node --check app.js`: 통과
- 프로토타입 내 `serviceKey`, `SERVICE_KEY`, `api key`, `authorization`, `bearer` 패턴: 0건
- 금지 문구 `안전한 경로`, `이동해도 됩니다`, `운영 중입니다`, `열사병을 예방`, `휴식점이 없습니다`: 0건
- 서버 바인딩: `127.0.0.1`만 사용
- API 응답: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`

## 5. 결정과 위험

- SQLite/RTree를 선택해 새 npm 런타임 의존성을 추가하지 않았다. Node.js 22의 `node:sqlite`는 Experimental API이므로 프로덕션 단계에서는 안정 API 또는 고정 드라이버 검토가 필요하다.
- 91MB 원본 대신 24MB대 인덱스를 서버에서만 열고 브라우저에는 제한된 JSON만 전송한다.
- 현 인덱스 최신성 판정은 로컬 JSONL의 크기와 mtime 기준이다. 운영 자동수집 단계에서는 원본 체크섬·수집 작업 ID까지 메타데이터에 연결해야 한다.
- 운영시간 결측이 많고 접근조건 필드가 없으므로 현재 운영 중이라는 표현과 실제 경로 연결을 금지했다.
- 공개 배포, 외부 API 재호출, 비용 지출, 외부 사용자 테스트는 하지 않았다.
