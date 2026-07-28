# 쉬어갈지도 Phase 2 — 실데이터 연결 통합 판정

> **2026-07-28 보안 재검토로 판정 갱신:** 원본에 행별 접근조건이 없어 현재 60,672건 전부를 `information_insufficient`로 재분류했다. 전체 스냅샷·파생 JSONL·SQLite는 이용조건 확인 전 Git/Vercel 배포 대상에서 제외했다. 아래 본문은 2026-07-27 당시 로컬 통합 이력이며 현재 긍정 후보 수나 공개 배포 상태로 사용하지 않는다.

- 판정일: 2026-07-27 (KST)
- 판정 범위: 내부 로컬 프로토타입과 저장된 무더위쉼터 스냅샷
- 당시 판정: **수정 후 통과 — 내부 로컬 프로토타입 한정** (현재는 위 갱신 우선)
- 외부 공개·배포·유료 API·사용자 접촉: 실행하지 않음

## 1. 한 줄 결론

최초 검수에서 하드게이트 미연결과 필수 좌표 검증 결함을 발견해 수정했다. 독립 재검토에서 저장 스냅샷 감사, SQLite 강제 재빌드, API·UI·28개 회귀 테스트와 390px 시각 검수를 모두 통과했다. 따라서 **Phase 2 실데이터 검색 통합은 내부 로컬 프로토타입 범위에서 수정 후 통과**다. 실제 보행 경로·예상시간 계산, 당일 개방·냉방 작동 보장, 공개 배포는 여전히 통과 범위가 아니다.

## 2. 독립 재검증 결과

### 2.1 통과한 항목

직접 재실행한 결과:

```text
python public-app-ideas/rest-stop-route/scripts/audit_heat_shelter_hard_gates.py
→ ok=true
→ total=60,672
→ internal_route_candidate=5,382
→ information_insufficient=55,175
→ condition_false=115
→ aircon true/false/unknown=57,385/478/2,809
→ 원본 SHA-256=6bd73c00768852bee58432f7870111569f529c34caa2398a7daee4c5269eefb8
```

```text
cd public-app-ideas/rest-stop-route/prototype
npm test -- --reporter=line
→ 22 passed (5.3s)
```

```text
python3 -m py_compile scripts/build_search_index.py scripts/audit_heat_shelter_hard_gates.py
node --check prototype/server.mjs
node --check prototype/app.js
→ 모두 종료코드 0
```

SQLite 독립 검사:

```text
PRAGMA integrity_check=ok
shelters=60,672
shelter_geo=60,672
has_aircon false/true/unknown=478/57,385/2,809
```

확인된 장점:

- 60,672건과 냉방 `true/false/unknown` 원값이 인덱스에서 보존된다.
- 검색은 로컬 `127.0.0.1` 서버와 읽기 전용 SQLite에서만 동작한다.
- API는 반경·결과 수를 제한하고 원본 `raw` 객체를 노출하지 않는다.
- 화면은 실데이터를 예시 경로·보행시간 계산에 아직 사용하지 않는다고 명시한다.
- 당일 개방·좌석·냉방 작동을 보장하지 않는 경고와 출처·수정시각을 표시한다.
- Phase 1의 비로그인·비저장·안전 비보장·`정보 부족` 우선 원칙을 깨는 외부 실행은 확인되지 않았다.

### 2.2 통합 차단 결함 1 — 하드게이트 결과 미연결

현재 `prototype/data/heat-shelters.sqlite`의 `shelters` 테이블에는 `hard_gate_status`와 `hard_gate_reasons` 열이 없다. `scripts/build_search_index.py`는 정규화된 `heat-shelters.jsonl`만 읽고, 셈이 산출물 `heat-shelter-hard-gates.jsonl`의 판정을 결합하지 않는다.

그 결과 API의 `aircon=true`는 냉방기 수량이 1대 이상이라는 한 조건만 검사하며, 운영시간·주말 개방·중복 등 하드게이트에서 `information_insufficient`로 차단된 행도 그대로 반환한다.

서울도서관 좌표 주변 2km, 냉방 `true`, 상위 3건을 API와 같은 거리 규칙으로 재검산한 결과:

| 거리 | 시설 | 원본 ID | 하드게이트 판정 | 차단 사유 |
|---:|---|---|---|---|
| 415m | 휴서울이동노동자북창쉼터 | 1114000096 | information_insufficient | weekend_open_unknown |
| 536m | 휴서울이동노동자종각역쉼터 | 1100000011 | information_insufficient | weekend_open_unknown |
| 609m | 소공동주민센터 | 11140002 | information_insufficient | weekend_open_unknown |

즉 현재 대표 화면에 가장 먼저 표시되는 3건 모두 하드게이트상 긍정 경로 연결 제외 대상이다. 화면이 이 장소들을 실제 경로 연결점으로 쓰지는 않으므로 즉시 안전 오안내라고 단정할 수는 없지만, **하드게이트를 유지한 통합**이라고 판정할 수 없다. `냉방 확인` 문구도 냉방 수량 필드만 확인했다는 뜻으로 범위를 더 분명히 해야 한다.

### 2.3 통합 차단 결함 2 — 필수 좌표 누락을 200으로 수용

문서상 `lat`, `lon`은 필수지만 `Number(searchParams.get(...))`에서 누락값 `null`과 빈 문자열이 `0`으로 변환된다. 직접 호출 결과:

```text
/api/shelters/nearby                    → HTTP 200, lat=0, lon=0
/api/shelters/nearby?lat=37             → HTTP 200, lat=37, lon=0
/api/shelters/nearby?lon=127            → HTTP 200, lat=0, lon=127
/api/shelters/nearby?lat=&lon=           → HTTP 200, lat=0, lon=0
/api/shelters/nearby?lat=37&lon=127      → HTTP 200
```

이는 API 계약과 입력 검증이 불일치한 결함이다. 현재 테스트는 범위 밖 좌표만 검사하고 필수값 누락·빈값은 검사하지 않는다.

## 3. 판정 근거

### 통과로 올리지 않은 이유

1. 하드게이트 감사의 핵심 결과는 60,672건 중 5,382건만 내부 경로 후보라는 것이다.
2. 현재 검색 계층은 그 판정을 저장하거나 반환하지 않아 55,175건의 `information_insufficient`를 구분할 수 없다.
3. Phase 1은 자료 부족과 실제 시설 부족을 구분하고, 불완전한 자료에서는 `정보 부족`을 우선하도록 고정했다.
4. 자동 테스트 22개는 모두 통과하지만, 하드게이트-검색 결합과 필수 좌표 누락이라는 통합 계약을 검증하지 않는다.

### 중단으로 내리지 않은 이유

- 로컬 인덱스 무결성, 공간 검색, 3값 보존, 출처 추적, 경고, 390px 흐름은 실제 재실행에서 동작했다.
- 결함은 핵심 데이터가 없는 문제가 아니라 하드게이트 산출물을 검색 계층에 결합하지 않은 문제다.
- 공개 배포나 실제 사용자 오안내가 발생하지 않았고, 수정 범위가 독립적이며 재검증 가능하다.

## 4. 수정 완료 조건

아래를 모두 만족하면 Phase 2 통합을 다시 판정한다.

1. 인덱스 빌드가 `heat-shelter-hard-gates.jsonl`을 원본 ID로 결합하고 `hard_gate_status`, `hard_gate_reasons`를 보존한다.
2. API가 각 결과의 하드게이트 상태를 반환한다.
3. 내부 경로 후보 질의는 `internal_route_candidate`만 긍정 후보로 사용한다. `information_insufficient`는 `정보 부족`, `condition_false`는 냉방 조건 불충족으로 분리한다.
4. 참고용 주변 시설 목록에 전체 데이터를 유지한다면 하드게이트 상태와 제한 이유를 화면에 표시하고, 긍정 연결 후보와 시각·문구상 분리한다.
5. `냉방 확인`은 `공식 자료상 냉방기 수량 확인`처럼 확인 범위를 제한하고 현재 작동·개방 의미가 아님을 같은 카드에서 알린다.
6. `lat`, `lon` 누락·빈값을 HTTP 400으로 거부한다.
7. 자동 테스트에 다음을 추가한다.
   - 하드게이트 3상태 각각의 API 보존
   - `information_insufficient`의 긍정 후보 제외와 `정보 부족` 우선
   - 서울 표본 상위 결과의 제한 상태 표시
   - `lat`, `lon` 누락·빈값 400
8. 수정 후 하드게이트 감사, SQLite 무결성, 전체 Playwright 테스트, Python/Node 문법 검사를 다시 모두 통과한다.

## 5. 허용 범위와 제외 범위

수정 전 허용:

- 개발자 로컬에서 인덱스 생성·검색 성능·UI 로딩·회귀 테스트 확인
- 실데이터를 **경로와 분리된 참고 목록**으로 보되, 하드게이트 미연결 사실을 알고 검수하는 내부 디버깅

수정 전 금지:

- 실데이터 시설을 실제 경로 연결점 또는 현재 이용 가능한 냉방쉼터로 판정
- `aircon=true`만으로 하드게이트 통과라고 해석
- 전국 운영·안전·완전 커버리지 보장
- 공개 배포, 외부 사용자 테스트, 외부 기관 접촉, 유료 API 사용

계속 제외:

- 실제 보행 경로 연결과 예상시간 계산
- 당일 개방·좌석·냉방기 작동 보장
- 건강정보·정밀 위치 이력 저장
- 외부 링크 발급·공유 전송·지도 앱 실제 전환

## 6. 다음 담당자 입력

개발 담당에게 필요한 고정 입력:

- 결합 키: `original_id`
- 판정 우선순위: `information_insufficient` > `condition_false` > `internal_route_candidate`
- 긍정 경로 후보: `internal_route_candidate`만
- 현재 검증 건수: 후보 5,382 / 정보 부족 55,175 / 조건 불충족 115
- 재검토 산출물: 수정된 인덱스·API·UI·테스트 결과와 위 8개 완료 조건의 대응표

## 7. 최초 통합 결정 — 수정 전

**수정.** 최초 판정 당시에는 로컬 검색 기능 자체가 내부 참고·개발용으로 동작했지만, 하드게이트 결과가 검색 계층에 결합되기 전이라 Phase 2 실데이터 연결 통합을 승인하지 않았다. 기능을 폐기하지 않고 결합과 입력 검증을 수정한 뒤 독립 재검토하기로 했다.

## 8. 수정 구현 결과 — 독립 재검토 요청

- 구현일: 2026-07-27
- 상태: **수정 구현·자체검증 완료, 코드 리뷰 대기**
- 승인 경계: 로컬 파일·로컬 서버만 사용. 공개 배포, 유료 API, 외부 사용자 접촉 없음.

### 8.1 수정 완료 조건 대응표

| # | 수정 완료 조건 | 구현 근거 | 자체검증 |
|---:|---|---|---|
| 1 | 하드게이트 JSONL을 `original_id`로 결합하고 상태·사유 보존 | `scripts/build_search_index.py`가 두 JSONL의 ID를 전량 대조하고 SQLite schema v2의 `hard_gate_status`, `hard_gate_reasons`에 저장한다. 누락·중복·미결합 ID는 빌드를 실패시킨다. | 60,672건 전량, 상태 5,382/55,175/115, NULL 0, 사유 JSON 오류 0 |
| 2 | API가 상태·사유 반환 | `prototype/server.mjs`가 각 결과에 `hard_gate_status`, `hard_gate_reasons`를 반환한다. | 3상태 API 표본 테스트 통과 |
| 3 | 긍정 내부 경로 후보는 `internal_route_candidate`만 허용하고 정보 부족·조건 불충족 분리 | `candidateOnly=true` 질의는 SQL에서 `internal_route_candidate`만 허용한다. 전체 참고 질의는 세 상태를 그대로 반환한다. 냉방 false와 운영정보 부족이 함께 있는 표본은 `information_insufficient`로 보존한다. | 후보 전용 필터 및 정보 부족 우선 테스트 통과 |
| 4 | 전체 참고 목록의 제한 상태 표시와 냉방 확인 범위 제한 | 실데이터 섹션을 `참고 목록 · 경로 연결에 사용하지 않음`으로 고정하고 카드마다 상태·번역된 제한 사유를 표시한다. `냉방 확인`을 `공식 자료상 냉방기 수량 확인`으로 바꾸고 현재 작동·개방 의미가 아님을 같은 카드에 표시한다. | 서울도서관 상위 3건 UI 테스트 및 390px 시각 확인 통과 |
| 5 | `lat`/`lon` 누락·빈값 HTTP 400 | 원문 파라미터가 `null` 또는 공백인지 숫자 변환 전에 검사한다. | 무쿼리, 한쪽 누락, 양쪽 빈값, 한쪽 빈값 6표본 모두 400 |
| 6 | 요구 회귀 테스트 추가 | 하드게이트 3상태, 정보 부족 우선, 후보 전용 필터, 서울 제한 표시, 좌표 누락·빈값을 `prototype.spec.js`에 추가했다. | 전체 Playwright 28/28 통과 |
| 7 | 감사·Playwright·SQLite·문법 검사 재실행 | 아래 재현 출력과 동일하다. | 전부 종료코드 0 |
| 8 | 독립 재검토 가능한 완료 근거 | 이 대응표, 실제 명령 출력, 변경 파일과 제한 범위를 남겼다. | 코드 리뷰 전에는 Phase 2 판정을 임의로 `통과`로 변경하지 않음 |

### 8.2 실제 재검증 출력

```text
python3 public-app-ideas/rest-stop-route/scripts/audit_heat_shelter_hard_gates.py
→ ok=true, total=60,672
→ information_insufficient=55,175
→ internal_route_candidate=5,382
→ condition_false=115
→ aircon unknown/true/false=2,809/57,385/478
→ raw_sha256=6bd73c00768852bee58432f7870111569f529c34caa2398a7daee4c5269eefb8
```

```text
cd public-app-ideas/rest-stop-route/prototype
npm test -- --reporter=line
→ build:index: built 60,672 shelter records
→ Running 28 tests using 2 workers
→ 28 passed (5.6s)
```

```text
SQLite 독립 검사
→ integrity_check=ok
→ shelters=60,672
→ shelter_geo=60,672
→ hard_gate_status={condition_false: 115, information_insufficient: 55,175, internal_route_candidate: 5,382}
→ missing_gate_fields=0
→ invalid_gate_json=0
→ schema_version=2
```

```text
python3 -m py_compile scripts/build_search_index.py scripts/audit_heat_shelter_hard_gates.py
node --check prototype/server.mjs
node --check prototype/app.js
→ 모두 종료코드 0
```

수동 브라우저 확인에서도 서울 표본 상위 3건 모두 `정보 부족 · 긍정 연결 제외`, `주말·휴일 개방 여부 미확인`, 냉방기 수량 확인 범위 문구가 카드 안에 표시됐다. 브라우저 콘솔 오류는 0건이었고 390px 화면에서 겹침·잘림·가로 오버플로를 확인하지 못했다.

### 8.3 변경 파일

- `scripts/build_search_index.py`
- `prototype/server.mjs`
- `prototype/app.js`
- `prototype/tests/prototype.spec.js`
- `prototype/README.md`
- `prototype/data/heat-shelters.sqlite`
- `PHASE_2_REPORT.md`

본 절 작성 당시에는 독립 리뷰 전이므로 판정을 **수정**으로 유지했다. 최종 재검토 결과는 아래 §9에 기록한다.

## 9. 만드리 독립 재검토 — 수정 후 통과

- 재검토일: 2026-07-27 (KST)
- 재검토 범위: 저장된 공식 스냅샷, 하드게이트 감사, SQLite/RTree 인덱스, 로컬 API, 390px 내부 프로토타입
- 판정: **수정 후 통과 — 내부 로컬 프로토타입 한정**
- 공개 배포·유료 API·외부 사용자 접촉: 실행하지 않음

### 9.1 독립 재현 방법

원본 작업폴더의 생성물을 그대로 신뢰하지 않고 `/tmp/rest-route-phase2-gate-review.*`의 깨끗한 구조에 코드·원본 스냅샷·정규화 JSONL을 복사했다. 그 환경에서 하드게이트 JSONL을 새로 생성하고 SQLite를 `--force`로 재빌드한 뒤 테스트를 실행했다.

### 9.2 독립 재검증 결과

```text
하드게이트 감사
→ ok=true, total=60,672
→ internal_route_candidate=5,382
→ information_insufficient=55,175
→ condition_false=115
→ raw_sha256=6bd73c00768852bee58432f7870111569f529c34caa2398a7daee4c5269eefb8
```

```text
SQLite 강제 재빌드·독립 검사
→ integrity_check=ok
→ shelters=60,672
→ shelter_geo=60,672
→ hard_gate_status=5,382 / 55,175 / 115
→ missing_gate_fields=0
→ invalid_gate_json=0
→ schema_version=2
```

```text
Playwright 28/28 PASS
Python/Node 문법 검사 통과
npm audit 취약점 0건
```

추가 확인:

- API가 하드게이트 세 상태와 사유를 보존한다.
- `candidateOnly=true`는 `internal_route_candidate`만 반환한다.
- `information_insufficient`와 `condition_false`는 긍정 연결 후보에서 제외된다.
- `lat`, `lon` 누락·빈값 6개 표본은 모두 HTTP 400으로 거부된다.
- 서울도서관 주변 상위 3건은 모두 `정보 부족 · 긍정 연결 제외`와 `주말·휴일 개방 여부 미확인`을 표시한다.
- 냉방 표시는 공식 자료의 냉방기 수량 필드 확인 범위로 한정하며 현재 작동·개방을 뜻하지 않는다고 같은 카드에서 안내한다.
- 390px 화면에서 겹침·잘림·가로 넘침이나 핵심 문구 누락을 확인하지 못했다.

### 9.3 최종 허용 범위

통과:

- 개발자 로컬에서 60,672건 공간 검색
- 하드게이트 상태·제한 사유를 보존한 참고 목록
- 5,382건 내부 후보의 별도 후보 전용 질의
- 내부 회귀 테스트와 다음 단계 개발의 기반

계속 제외:

- 실데이터 쉼터를 실제 보행 경로 연결점으로 사용하는 기능
- 실제 보행 경로와 예상시간 계산
- 당일 개방·좌석·냉방기 작동·현장 안전 보장
- 전국 완전 커버리지 표현
- 공개 배포·외부 사용자 테스트·외부 기관 접촉·유료 API 사용
