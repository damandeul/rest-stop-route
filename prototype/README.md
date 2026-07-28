# 쉬어갈지도 클릭 프로토타입

외부 유료 API와 계정 없이 로컬에서 실행하는 390px 모바일 우선 클릭 프로토타입이다. 경로·보행시간과 기존 `한빛 무더위쉼터` 카드는 예시 데이터다. 결과 하단의 `목적지 주변 무더위쉼터 실데이터`는 행정안전부 정규화 스냅샷 60,672건을 로컬 SQLite/RTree로 검색한다. 어느 결과도 실제 운영·안전·당일 개방·냉방기 작동을 보장하지 않는다.

## 구현 범위

- 화면 1: 한글 IME를 보존하는 전국 장소 검색 데모, 모바일 현재 위치 출발지 선택, 출발지·목적지 교환, 3/5/10분, 그늘·벤치·냉방 실내·물·화장실 복수 선택, 유효성 오류
- 화면 2: 구간 카드, 미니맵과 동일 순서 목록, `조건에 맞는 후보가 이어짐`·`휴식점 부족`·`정보 부족`·`경로 계산 불가`, 자료 범위, 대안, 공유 미리보기
- 화면 3: 장소 유형·주소, 확인/미확인 조건, 운영정보 없음, 출처·갱신일·자료 신뢰 수준과 이유, 앞뒤 구간, 지도 전환 확인, 공유 미리보기
- 개인정보: 입력값과 현재 위치는 브라우저 메모리에만 있고 영구 저장·분석 이벤트가 없다. 현재 위치는 브라우저 권한 승인 후에만 읽으며 출발지 좌표를 서버에 보내지 않는다.
- 승인 경계: 실제 공유 링크, 외부 메시지 발송, 외부 지도/원문 자동 전환, 배포를 하지 않는다.
- 실데이터: 91MB 정규화 JSONL과 하드게이트 JSONL을 브라우저에 내려보내지 않고 30MB 읽기 전용 SQLite 공간 인덱스와 제한된 로컬 JSON API를 사용한다.

## 실데이터 검색 구조

`../scripts/build_search_index.py`가 로컬의 `../data/processed/heat-shelters.jsonl`과 `heat-shelter-hard-gates.jsonl`을 `original_id`로 전량 결합해 `data/heat-shelters.sqlite`를 원자적으로 생성한다. 전체 스냅샷·파생 JSONL·SQLite는 이용조건과 재배포 범위 확인 전 Git/Vercel에 포함하지 않는다. schema v2는 `hard_gate_status`와 JSON `hard_gate_reasons`를 보존하며 두 입력 중 누락·중복·미결합 ID가 있으면 빌드를 실패시킨다. RTree가 위·경도 경계 상자를 먼저 거르고 서버가 Haversine 거리로 반경을 다시 판정한다. 응답은 기본 10건, 최대 50건이고 반경은 최대 20km다. 원본의 `raw` 객체와 API 키는 인덱스·응답·로그에 포함하지 않는다.

```text
브라우저 → GET /api/shelters/nearby → Node 로컬 서버 → SQLite/RTree
                                                    ↑
정규화 JSONL + 하드게이트 JSONL → build_search_index.py → 30MB 검색 인덱스
```

API:

- `GET /api/health`: 인덱스 상태, 60,672건, 출처, 수집시각
- `GET /api/shelters/nearby?lat=37.5663&lon=126.9779&radiusKm=2&aircon=true&limit=10`
- `lat`, `lon`: 필수. 누락·빈값·범위 밖 값은 HTTP 400
- `aircon`: 생략 또는 `true` / `false` / `unknown`. `unknown`을 `false`로 합치지 않는다.
- `candidateOnly=true`: 긍정 내부 경로 후보 질의. `internal_route_candidate`만 반환하며 다른 값은 허용하지 않는다.
- 각 결과: 거리, 좌표, 주소, 냉방 3값, 하드게이트 상태·사유, 평일·주말 운영시간, 원본 ID, 출처 URL, 개별 수정시각, 운영 경고
- 잘못된 좌표·반경·필터·limit은 HTTP 400으로 거부한다.
- 일반 주변 검색은 세 하드게이트 상태를 모두 유지하는 참고 목록이다. UI에서 `information_insufficient`와 `condition_false`를 긍정 연결 후보와 분리한다.

## 전국 검색 데모 시나리오

| 목적지 예시 | 결과 상태 | 검증 목적 |
|---|---|---|
| 서울도서관 | 조건·시간에 따라 연결/부족/정보 부족 | 확인된 조건과 5·10분은 연결, 3분은 시간 초과, 미확인 조건은 정보 부족 |
| 부산역 | 휴식점 부족 | 한도 초과 구간·대안 |
| 제주시청 | 정보 부족 | 시설 부재와 자료 부족 구분 |
| 대전시청 | 경로 계산 불가 | 임의 시간 추정 금지 |
| 광주시청·대구시청 동인청사 | 정보 부족 | 비표본 지역 처리 |

검색어 2자 이상을 입력하면 장소명, 전체 주소, 행정구역이 함께 표시된다. 이것은 외부 API 없는 전국 검색 상호작용 데모이며 전국 주소 데이터베이스가 아니다.

## 실행

요구 환경: Node.js 22 이상, npm

```bash
cd public-app-ideas/rest-stop-route/prototype
npm install
npm run build:index
npm run serve
```

브라우저에서 `http://127.0.0.1:4173`을 연다.

## Vercel 배포

저장소 루트의 `vercel.json`이 공개 가능한 UI 파일 3개(`index.html`, `styles.css`, `app.js`)만 `dist/`로 복사한다. Vercel 프로젝트의 **Root Directory는 저장소 루트**로 두고 재배포한다. 루트 `index.html`이 없어서 발생하던 `404: NOT_FOUND`는 이 빌드 출력으로 해결한다.

현재 위치 기능은 HTTPS 또는 `localhost`에서만 동작한다. 페이지가 열릴 때 자동으로 위치를 읽지 않고, 사용자가 **현재 위치 사용**을 누른 뒤에만 브라우저 권한을 요청한다.

공개 배포에는 이용조건 검토 전 실데이터·SQLite와 로컬 Node 서버를 포함하지 않는다. 따라서 클릭 프로토타입은 열리지만 결과의 실데이터 영역은 “실데이터를 불러오지 못했어요”라는 제한 상태를 표시한다. 실제 API 배포는 데이터 재배포 조건과 서버리스 저장구조를 별도로 승인한 뒤 진행한다.

## 자동 테스트

```bash
cd public-app-ideas/rest-stop-route/prototype
npm test
```

`npm test`는 먼저 인덱스가 현재 JSONL과 같은 버전인지 확인하고 필요할 때만 다시 만든다.

2026-07-27 Phase 2 실제 실행 결과:

```text
Python hard-gate tests: 3 passed
Running 39 tests using 2 workers
39 passed
```

검증 항목:

1. 필수값 오류와 첫 오류 입력 초점
2. 한글 조합 입력 중 DOM 유지와 조합 완료 후 검색 결과 표시
3. 모바일 위치 권한으로 현재 위치를 출발지로 선택하고, 미지원·권한 거부·위치 오류·늦은 응답에도 시설명 직접 입력과 현재 화면을 유지
4. 전국 검색 데모의 주소·행정구역 표시
5. 3/5/10분 및 복수 휴식 조건, 시간 한도·조건 자료 하드 게이트
6. 휴식점 부족과 초과 구간·대안
7. 정보 부족과 시설 부재의 구분
8. 경로 계산 불가 시 임의 시간 미표시
9. 상세 출처·갱신일·신뢰 이유·운영정보 없음
10. 결과·상세 구간시간 일치와 대안 선택 44px 터치 영역
11. 실제 전송 없는 공유 미리보기
12. 입력·결과·상세 390px DOM 가로 오버플로 0
13. 390px 핵심 3화면 스크린샷 생성
14. 잘못 인코딩된 URL의 400 응답과 서버 생존
15. 인덱스 상태의 전량 60,672건·공식 출처
16. 좌표 주변 반경 검색과 냉방 `true/false/unknown` 3값 필터
17. 출처·원본 ID·수정시각·운영시간·경고 보존 및 `raw` 비노출
18. 잘못된 좌표·반경·필터 및 필수 좌표 누락·빈값의 HTTP 400
19. 목적지 주변 공식 실데이터의 브라우저 연결
20. API의 하드게이트 사유 보존과 `information_insufficient` 우선
21. 접근조건 검증 전 `candidateOnly=true` 빈 목록
22. 서울 표본 상위 3건의 정보 부족·제한 사유·냉방 수량 확인 범위 표시

브라우저 콘솔 검증: 메시지 0개, JavaScript 오류 0개.
금지 문구 정적 검사: `안전한 경로`, `이동해도 됩니다`, `운영 중입니다`, `열사병을 예방`, `휴식점이 없습니다` 0건.

## 390px 스크린샷

- `artifacts/01-input-390.png`
- `artifacts/02-result-390.png`
- `artifacts/03-detail-390.png`

세 파일 모두 Playwright의 390×844 뷰포트에서 `fullPage`로 생성했다. 시각 검수에서 텍스트 잘림·겹침·가로 넘침이 없고, 상태는 아이콘·배지명·설명문을 함께 사용함을 확인했다.

## 디자인·접근성 기록

- 주 표면: `Configure`; 보조 표면: `Explore / Inspect`
- 44px 이상 터치 영역, 본문 14–16px 이상, 실제 `<label>`, `<fieldset>`, `<dialog>`, 포커스 링 사용
- 상태 정보를 색상만으로 전달하지 않음
- `prefers-reduced-motion`을 존중하고 불필요한 애니메이션을 사용하지 않음
- 슬롭 자가진단: 0/10. 기술 그라데이션, 기본 인디고, 기능 타일 그리드, 강조 레일, 블러, 거대 통계, 아이콘 토퍼, 중앙 스택, 기본 Inter, 잘못된 표면 없음

## 파일 구조

```text
prototype/
├── index.html
├── styles.css
├── app.js
├── server.mjs
├── data/heat-shelters.sqlite
├── package.json
├── package-lock.json
├── playwright.config.js
├── tests/
│   ├── prototype.spec.js
│   └── screenshot.spec.js
└── artifacts/
    ├── 01-input-390.png
    ├── 02-result-390.png
    └── 03-detail-390.png
```

## 알려진 한계

- 실제 주소 검색·보행 경로·공공데이터 원격 API를 호출하지 않는다. 쉼터는 확보한 로컬 스냅샷만 검색한다.
- 지도는 공간 판단을 흉내 내는 순서 미니맵이며 실제 지리 좌표가 아니다.
- 실데이터 주변 검색 결과는 아직 경로 연결점이나 보행시간 계산에 사용하지 않는다.
- Node.js 22의 내장 `node:sqlite`는 현재 Experimental API라 실행 시 해당 경고만 숨기며, 프로덕션 전 안정 API나 고정된 SQLite 드라이버로 교체 검토가 필요하다.
- 실제 공유 링크·메시지를 생성하지 않는다.
- 외부 공개·배포·사용자 모집·유료 API 신청은 대표 승인 전 범위 밖이다.
