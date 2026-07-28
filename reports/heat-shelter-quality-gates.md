# 무더위쉼터 데이터 하드게이트 감사

- 감사 대상: `/Users/damandeul/다만들/ai-company/public-app-ideas/rest-stop-route/data/raw/heat-shelters-full.json`
- 스냅샷 수집 시각(KST): 2026-07-27T15:44:12.898274+09:00
- 실제 레코드: **60,672건** (선언 건수 60,672건과 일치)
- 원본 SHA-256: `6bd73c00768852bee58432f7870111569f529c34caa2398a7daee4c5269eefb8`
- 검사 스크립트: `/Users/damandeul/다만들/ai-company/public-app-ideas/rest-stop-route/scripts/audit_heat_shelter_hard_gates.py`
- 레코드별 판정: `/Users/damandeul/다만들/ai-company/public-app-ideas/rest-stop-route/data/processed/heat-shelter-hard-gates.jsonl`
- 실행 방식: 저장된 스냅샷만 읽는 오프라인 검사. API 키 파일을 읽거나 네트워크를 호출하지 않음.

## 1. 판정 정의와 결론

`internal_route_candidate`는 내부에서 질의 시각별 운영 여부를 계산해 볼 수 있는 후보일 뿐이다. 원본 ID·공식 좌표·냉방 true, 완결된 운영시간, 검증된 접근조건이 모두 필요하다. 현재 원본에는 행별 접근조건 필드가 없어 모든 행을 긍정 후보에서 제외한다.

`information_insufficient`는 접근조건 미검증, 냉방 unknown, 운영시간 미완결/상충, 중복 검토 필요, 좌표·출처 추적·수정일 오류 중 하나 이상인 행이다. `condition_false`는 다른 정보 부족이 없고 냉방기 수량만 명시적으로 0인 경우를 구분하는 상태다. unknown을 false로 바꾸지 않았다.

| 판정 | 건수 | 비율 | 내부 사용 의미 |
|---|---:|---:|---|
| internal_route_candidate | 0 | 0.00% | 질의 시각 계산 전 내부 후보 |
| information_insufficient | 60,672 | 100.00% | 긍정 경로 연결 제외 |
| condition_false | 0 | 0.00% | 냉방 조건 연결 제외 |

**결정: 보류.** 전국 데이터 수집·좌표·출처 추적은 확인했지만, 즉시 출입 가능 여부를 판정할 행별 접근조건이 없다. 별도 접근조건 검수 전에는 모든 행을 `information_insufficient`로 두며, 자동 경로 연결과 외부 데이터 배포를 보류한다.

## 2. 독립 하드게이트 검증

### 원본 ID 및 이름+주소 중복

- 원본 ID 중복 추가행: **0건**
- 동일 이름+도로명주소 중복 추가행: **1건**
- 동일 이름+도로명주소 중복 영향 행: **2건** (판정 전 수동 검토 대상으로 모두 제외)

| 이름 | 도로명주소 | 행 수 |
|---|---|---:|
| 외덕여자경로당 | 전남광주통합특별시 무안군 망운면 외덕길 11-3  | 2 |

### 운영시간 형식·상충

시간 형식은 시작 `0000~2359`, 종료 `0000~2400`만 허용했다. 평일은 시작·종료 완결쌍이 필요하다. 주말/휴일은 개방 Y이면 완결쌍, N이면 시간 없음이어야 하며, 개방 값 미제공은 unknown으로 차단했다. 종료가 시작보다 이른 야간 운영은 야간개방 Y가 있을 때만 경고와 함께 허용했다.

| 시간쌍 상태 | 평일 | 주말/휴일 |
|---|---:|---:|
| complete | 10,613 | 37,320 |
| missing | 49,799 | 22,299 |
| incomplete | 0 | 17 |
| format_error | 0 | 0 |
| equal_ambiguous | 260 | 1,036 |

| 차단 사유 | 영향 행 |
|---|---:|
| `weekend_open_unknown` | 51,293 |
| `weekday_hours_missing` | 49,799 |
| `weekend_open_y_hours_missing` | 1,444 |
| `weekend_closed_but_hours_present` | 1,306 |
| `weekday_hours_equal_ambiguous` | 260 |
| `weekday_overnight_without_night_confirmation` | 65 |
| `weekend_open_y_hours_equal_ambiguous` | 16 |
| `weekend_overnight_without_night_confirmation` | 6 |

| 비차단 경고 | 영향 행 |
|---|---:|
| `weekday_overnight_supported_by_night_flag` | 21 |

### 냉방 3값

| 값 | 건수 | 비율 | 판정 |
|---|---:|---:|---|
| true | 57,385 | 94.58% | 접근조건 등 다른 게이트 검증 전 정보 부족 |
| false | 478 | 0.79% | 냉방 조건 불충족; 다른 정보도 부족하면 information_insufficient 우선 |
| unknown | 2,809 | 4.63% | information_insufficient |

냉방 false 478건 중 다른 게이트를 통과한 **0건**은 `condition_false`, 운영정보 등도 부족한 **478건**은 우선순위에 따라 `information_insufficient`로 분류했다.

### 수정일 분포

- 파싱 성공: **60,672건 (100.00%)**
- 파싱 실패: **0건 (0.00%)**
- 최솟값: **2022-05-23T11:15:04+09:00**
- 최댓값: **2026-07-26T16:16:04+09:00**

| 스냅샷 기준 수정 경과 | 건수 | 비율 |
|---|---:|---:|
| 0~30일 | 12,774 | 21.05% |
| 31~90일 | 29,695 | 48.94% |
| 91~365일 | 12,796 | 21.09% |
| 366일 이상 | 5,407 | 8.91% |

월별 분포:

| 수정 월 | 건수 |
|---|---:|
| 2022-05 | 1 |
| 2024-05 | 1 |
| 2025-04 | 496 |
| 2025-05 | 2,756 |
| 2025-06 | 319 |
| 2025-07 | 2,199 |
| 2025-08 | 158 |
| 2025-09 | 115 |
| 2025-11 | 1,793 |
| 2025-12 | 68 |
| 2026-01 | 3,304 |
| 2026-02 | 281 |
| 2026-03 | 817 |
| 2026-04 | 10,801 |
| 2026-05 | 10,367 |
| 2026-06 | 16,377 |
| 2026-07 | 10,819 |

수정일이 오래됐다는 이유만으로 자동 만료시키지 않았다. 이번 파일은 수집 시각과 건수 일치가 확인된 최신 스냅샷이지만, 행별 `valid_until`, 공식 폐쇄, 실제 시설 확인 필드가 없다. DATA_TRUST_MODEL에 따라 개별 행 수정일과 데이터셋 수집 최신성을 혼동하지 않으며, 후속 수집 실패·명시적 유효기간 종료·공식 폐쇄 근거가 생길 때 만료 게이트를 적용해야 한다.

### 광역코드 16개 및 미분류

- 인식한 광역코드 종류: **16개 / 기대 16개**
- 기대 코드 누락: **없음**
- 미분류 행: **0건**

| 코드 | 광역단위 | 건수 | 비율 |
|---|---|---:|---:|
| 11 | 서울특별시 | 3,976 | 6.55% |
| 12 | 전남광주통합특별시 | 9,689 | 15.97% |
| 26 | 부산광역시 | 1,678 | 2.77% |
| 27 | 대구광역시 | 1,283 | 2.11% |
| 28 | 인천광역시 | 1,105 | 1.82% |
| 30 | 대전광역시 | 1,022 | 1.68% |
| 31 | 울산광역시 | 1,199 | 1.98% |
| 36 | 세종특별자치시 | 512 | 0.84% |
| 41 | 경기도 | 8,953 | 14.76% |
| 43 | 충청북도 | 2,766 | 4.56% |
| 44 | 충청남도 | 6,086 | 10.03% |
| 47 | 경상북도 | 5,540 | 9.13% |
| 48 | 경상남도 | 7,766 | 12.80% |
| 50 | 제주특별자치도 | 620 | 1.02% |
| 51 | 강원특별자치도 | 2,034 | 3.35% |
| 52 | 전북특별자치도 | 6,443 | 10.62% |
| 기타/결측 | 미분류 | 0 | 0.00% |

## 3. 하드게이트 사유 전체 집계

한 행에 여러 사유가 있을 수 있어 합계는 전체 행 수를 넘을 수 있다.

| 사유 | 영향 행 |
|---|---:|
| `access_restriction_unverified` | 60,672 |
| `weekend_open_unknown` | 51,293 |
| `weekday_hours_missing` | 49,799 |
| `aircon_unknown` | 2,809 |
| `weekend_open_y_hours_missing` | 1,444 |
| `weekend_closed_but_hours_present` | 1,306 |
| `aircon_false` | 478 |
| `weekday_hours_equal_ambiguous` | 260 |
| `weekday_overnight_without_night_confirmation` | 65 |
| `weekend_open_y_hours_equal_ambiguous` | 16 |
| `weekend_overnight_without_night_confirmation` | 6 |
| `duplicate_name_address_review` | 2 |

## 4. 사용 제한과 다음 단계

- 후보라도 **당일 개방, 냉방기 작동, 즉시 출입, 좌석·급수**를 보장하지 않는다. 질의 시각 계산과 출발 전 원문 확인 문구가 필요하다.
- 원본에는 별도 `access_restriction`과 행별 이용조건 필드가 없다. 따라서 모든 행을 `information_insufficient`로 두고, 접근 제한 검수 없이 자동 경로점으로 사용하지 않는다.
- 소스 라이선스·파생 데이터 재배포 조건은 이 스냅샷에 포함되지 않았다. 외부 배포는 별도 이용조건 검토와 대표 승인이 필요하다.
- 다음 단계는 30개 표본의 접근조건을 별도 근거로 검수한 뒤에만 후보 승격 여부를 판단하는 것이다. 현장·외부 접촉·비용 지출은 대표 승인 후 진행한다.

## 5. 재현 명령

프로젝트 루트에서:

```bash
python public-app-ideas/rest-stop-route/scripts/audit_heat_shelter_hard_gates.py
```

성공 시 JSON stdout의 `ok=true`, 60,672건, 보고서와 JSONL 경로, SHA-256을 확인한다.
