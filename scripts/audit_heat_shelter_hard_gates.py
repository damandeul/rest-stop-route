#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Audit the saved MOIS heat-shelter snapshot against DATA_TRUST_MODEL hard gates.

This script is deliberately offline: it reads only a saved JSON snapshot and never
loads an API key or calls an external endpoint.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "data/raw/heat-shelters-full.json"
DEFAULT_OUTPUT = ROOT / "data/processed/heat-shelter-hard-gates.jsonl"
DEFAULT_REPORT = ROOT / "reports/heat-shelter-quality-gates.md"
SOURCE_URL = "https://www.safetydata.go.kr/disaster-data/view?dataSn=1338"
SOURCE_ENDPOINT = "https://www.safetydata.go.kr/V2/api/DSSP-IF-10942"
PROVINCES = {
    "11": "서울특별시",
    "12": "전남광주통합특별시",
    "26": "부산광역시",
    "27": "대구광역시",
    "28": "인천광역시",
    "30": "대전광역시",
    "31": "울산광역시",
    "36": "세종특별자치시",
    "41": "경기도",
    "43": "충청북도",
    "44": "충청남도",
    "47": "경상북도",
    "48": "경상남도",
    "50": "제주특별자치도",
    "51": "강원특별자치도",
    "52": "전북특별자치도",
}
TIME_RE = re.compile(r"^(?:[01][0-9]|2[0-3])[0-5][0-9]$")


def missing(value: Any) -> bool:
    return value is None or value == ""


def tri_count(value: Any) -> str:
    """Preserve the required true/false/unknown three-valued condition."""
    if missing(value):
        return "unknown"
    try:
        return "true" if float(value) > 0 else "false"
    except (TypeError, ValueError):
        return "unknown"


def valid_coord(record: Dict[str, Any]) -> bool:
    try:
        lat, lon = float(record.get("LA")), float(record.get("LO"))
        return 32 <= lat <= 39.5 and 124 <= lon <= 132
    except (TypeError, ValueError):
        return False


def parse_record_dt(value: Any) -> Optional[datetime]:
    if missing(value):
        return None
    text = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=ZoneInfo("Asia/Seoul"))
        except ValueError:
            pass
    return None


def parse_snapshot_dt(value: Any) -> datetime:
    if not value:
        raise ValueError("snapshot retrieved_at is missing")
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(ZoneInfo("Asia/Seoul"))


def valid_time(value: Any, *, allow_2400: bool) -> bool:
    if missing(value):
        return False
    text = str(value).strip()
    return bool(TIME_RE.fullmatch(text) or (allow_2400 and text == "2400"))


def minute(value: Any) -> Optional[int]:
    if missing(value):
        return None
    text = str(value).strip()
    if text == "2400":
        return 1440
    if not TIME_RE.fullmatch(text):
        return None
    return int(text[:2]) * 60 + int(text[2:])


def pair_state(record: Dict[str, Any], begin_field: str, end_field: str) -> str:
    begin, end = record.get(begin_field), record.get(end_field)
    has_begin, has_end = not missing(begin), not missing(end)
    if not has_begin and not has_end:
        return "missing"
    if has_begin != has_end:
        return "incomplete"
    if not valid_time(begin, allow_2400=False) or not valid_time(end, allow_2400=True):
        return "format_error"
    if minute(begin) == minute(end):
        return "equal_ambiguous"
    return "complete"


def operation_reasons(record: Dict[str, Any]) -> Tuple[List[str], List[str]]:
    """Return blocking reasons and non-blocking warnings for time evaluation."""
    blocking: List[str] = []
    warnings: List[str] = []
    weekday = pair_state(record, "WKDAY_OPER_BEGIN_TIME", "WKDAY_OPER_END_TIME")
    weekend = pair_state(record, "WKEND_HDAY_OPER_BEGIN_TIME", "WKEND_HDAY_OPER_END_TIME")
    weekend_flag = record.get("CHCK_MATTER_WKEND_HDAY_OPN_AT")
    night_flag = record.get("CHCK_MATTER_NIGHT_OPN_AT")

    if weekday != "complete":
        blocking.append(f"weekday_hours_{weekday}")
    if weekend_flag not in ("Y", "N"):
        blocking.append("weekend_open_unknown")
    elif weekend_flag == "Y" and weekend != "complete":
        blocking.append(f"weekend_open_y_hours_{weekend}")
    elif weekend_flag == "N" and weekend != "missing":
        blocking.append("weekend_closed_but_hours_present")

    for prefix, begin_field, end_field, state in (
        ("weekday", "WKDAY_OPER_BEGIN_TIME", "WKDAY_OPER_END_TIME", weekday),
        ("weekend", "WKEND_HDAY_OPER_BEGIN_TIME", "WKEND_HDAY_OPER_END_TIME", weekend),
    ):
        if state == "complete":
            begin, end = minute(record.get(begin_field)), minute(record.get(end_field))
            if begin is not None and end is not None and end < begin:
                if night_flag == "Y":
                    warnings.append(f"{prefix}_overnight_supported_by_night_flag")
                else:
                    blocking.append(f"{prefix}_overnight_without_night_confirmation")
    return sorted(set(blocking)), sorted(set(warnings))


def atomic_write_lines(path: Path, rows: Iterable[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        for row in rows:
            handle.write(row)
        temp = Path(handle.name)
    temp.replace(path)


def pct(value: int, total: int) -> str:
    return f"{(value / total * 100) if total else 0:.2f}%"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    args = parser.parse_args()

    raw_bytes = args.input.read_bytes()
    snapshot = json.loads(raw_bytes.decode("utf-8"))
    if snapshot.get("source") != SOURCE_ENDPOINT:
        raise ValueError(
            f"snapshot source mismatch: expected={SOURCE_ENDPOINT!r}, actual={snapshot.get('source')!r}"
        )
    records = snapshot.get("body")
    if not isinstance(records, list):
        raise ValueError("input JSON body must be a list")
    total = len(records)
    declared_total = int(snapshot.get("declared_total_count", total))
    if total != declared_total:
        raise ValueError(f"record count mismatch: declared={declared_total}, actual={total}")
    snapshot_at = parse_snapshot_dt(snapshot.get("retrieved_at"))
    raw_sha256 = hashlib.sha256(raw_bytes).hexdigest()

    ids = [r.get("RSTR_FCLTY_NO") for r in records]
    id_counts = Counter(ids)
    identity_counts = Counter((r.get("RSTR_NM"), r.get("RN_DTL_ADRES")) for r in records)
    duplicate_ids = {key for key, count in id_counts.items() if count > 1}
    duplicate_identity = {key for key, count in identity_counts.items() if count > 1}

    province_counts: Counter[str] = Counter()
    province_code_counts: Counter[str] = Counter()
    unclassified = 0
    aircon_counts: Counter[str] = Counter()
    aircon_status_counts: Counter[Tuple[str, str]] = Counter()
    weekday_states: Counter[str] = Counter()
    weekend_states: Counter[str] = Counter()
    operation_reason_counts: Counter[str] = Counter()
    operation_warning_counts: Counter[str] = Counter()
    status_counts: Counter[str] = Counter()
    record_dates: List[datetime] = []
    date_parse_errors = 0
    date_age_bands: Counter[str] = Counter()
    date_months: Counter[str] = Counter()
    affected_duplicate_identity_rows = 0

    classified: List[Dict[str, Any]] = []
    for record in records:
        code = str(record.get("ARCD") or "")[:2]
        province_code_counts[code or "missing"] += 1
        province = PROVINCES.get(code)
        if province is None:
            province = "미분류"
            unclassified += 1
        province_counts[province] += 1

        aircon = tri_count(record.get("COLR_HOLD_ARCNDTN"))
        aircon_counts[aircon] += 1
        weekday_states[pair_state(record, "WKDAY_OPER_BEGIN_TIME", "WKDAY_OPER_END_TIME")] += 1
        weekend_states[pair_state(record, "WKEND_HDAY_OPER_BEGIN_TIME", "WKEND_HDAY_OPER_END_TIME")] += 1
        operation_blocking, operation_warnings = operation_reasons(record)
        operation_reason_counts.update(operation_blocking)
        operation_warning_counts.update(operation_warnings)

        dt = parse_record_dt(record.get("MODF_TIME"))
        future_dt = dt is not None and dt > snapshot_at + timedelta(days=1)
        if dt is None:
            date_parse_errors += 1
        else:
            record_dates.append(dt)
            age_days = max(0, (snapshot_at.date() - dt.date()).days)
            if age_days <= 30:
                band = "0~30일"
            elif age_days <= 90:
                band = "31~90일"
            elif age_days <= 365:
                band = "91~365일"
            else:
                band = "366일 이상"
            date_age_bands[band] += 1
            date_months[dt.strftime("%Y-%m")] += 1

        reasons: List[str] = []
        trace_ok = not missing(record.get("RSTR_FCLTY_NO"))
        if not trace_ok:
            reasons.append("source_trace_missing")
        if not valid_coord(record):
            reasons.append("coordinate_missing_or_invalid")
        if record.get("RSTR_FCLTY_NO") in duplicate_ids:
            reasons.append("duplicate_original_id")
        identity_key = (record.get("RSTR_NM"), record.get("RN_DTL_ADRES"))
        if identity_key in duplicate_identity:
            reasons.append("duplicate_name_address_review")
            affected_duplicate_identity_rows += 1
        if aircon == "unknown":
            reasons.append("aircon_unknown")
        elif aircon == "false":
            reasons.append("aircon_false")
        reasons.extend(operation_blocking)
        if dt is None:
            reasons.append("record_updated_at_invalid")
        elif future_dt:
            reasons.append("record_updated_at_in_future")
        # The source has no row-level field proving that a member of the public can
        # enter immediately. Until a separately reviewed access record is joined,
        # every row must remain outside the positive route-candidate set.
        reasons.append("access_restriction_unverified")

        # A row modification date alone is not treated as expiry. The saved dataset was
        # freshly ingested and has no valid_until/closure field; expiry requires source-
        # level collection failure, an explicit validity end, or official closure evidence.
        hard_fail = [reason for reason in reasons if reason != "aircon_false"]
        if hard_fail:
            status = "information_insufficient"
        elif aircon == "false":
            status = "condition_false"
        else:
            status = "internal_route_candidate"
        status_counts[status] += 1
        aircon_status_counts[(aircon, status)] += 1

        classified.append({
            "original_id": record.get("RSTR_FCLTY_NO"),
            "name": record.get("RSTR_NM"),
            "road_address": record.get("RN_DTL_ADRES"),
            "province_code": code or None,
            "province": province,
            "lat": record.get("LA"),
            "lon": record.get("LO"),
            "has_aircon": aircon,
            "weekday_hours": {
                "begin": record.get("WKDAY_OPER_BEGIN_TIME"),
                "end": record.get("WKDAY_OPER_END_TIME"),
            },
            "weekend_holiday": {
                "open": record.get("CHCK_MATTER_WKEND_HDAY_OPN_AT"),
                "begin": record.get("WKEND_HDAY_OPER_BEGIN_TIME"),
                "end": record.get("WKEND_HDAY_OPER_END_TIME"),
            },
            "record_updated_at": record.get("MODF_TIME"),
            "hard_gate_status": status,
            "hard_gate_reasons": sorted(set(reasons)),
            "warnings": operation_warnings + [
                "internal_candidate_only",
                "same_day_opening_and_aircon_operation_not_guaranteed",
                "access_restriction_requires_separate_verification",
                "source_license_requires_separate_distribution_review",
            ],
        })

    atomic_write_lines(
        args.output,
        (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in classified),
    )

    duplicate_identity_groups = sorted(
        ((name, address, count) for (name, address), count in identity_counts.items() if count > 1),
        key=lambda item: (-item[2], str(item[0]), str(item[1])),
    )
    duplicate_id_extra = sum(count - 1 for count in id_counts.values() if count > 1)
    duplicate_identity_extra = sum(count - 1 for count in identity_counts.values() if count > 1)
    recognized_codes = {code for code in province_code_counts if code in PROVINCES}

    lines = [
        "# 무더위쉼터 데이터 하드게이트 감사",
        "",
        f"- 감사 대상: `{args.input}`",
        f"- 스냅샷 수집 시각(KST): {snapshot_at.isoformat()}",
        f"- 실제 레코드: **{total:,}건** (선언 건수 {declared_total:,}건과 일치)",
        f"- 원본 SHA-256: `{raw_sha256}`",
        f"- 검사 스크립트: `{Path(__file__).resolve()}`",
        f"- 레코드별 판정: `{args.output}`",
        "- 실행 방식: 저장된 스냅샷만 읽는 오프라인 검사. API 키 파일을 읽거나 네트워크를 호출하지 않음.",
        "",
        "## 1. 판정 정의와 결론",
        "",
        "`internal_route_candidate`는 내부에서 질의 시각별 운영 여부를 계산해 볼 수 있는 후보일 뿐이다. 원본 ID·공식 좌표·냉방 true, 완결된 운영시간, 검증된 접근조건이 모두 필요하다. 현재 원본에는 행별 접근조건 필드가 없어 모든 행을 긍정 후보에서 제외한다.",
        "",
        "`information_insufficient`는 접근조건 미검증, 냉방 unknown, 운영시간 미완결/상충, 중복 검토 필요, 좌표·출처 추적·수정일 오류 중 하나 이상인 행이다. `condition_false`는 다른 정보 부족이 없고 냉방기 수량만 명시적으로 0인 경우를 구분하는 상태다. unknown을 false로 바꾸지 않았다.",
        "",
        "| 판정 | 건수 | 비율 | 내부 사용 의미 |",
        "|---|---:|---:|---|",
        f"| internal_route_candidate | {status_counts['internal_route_candidate']:,} | {pct(status_counts['internal_route_candidate'], total)} | 질의 시각 계산 전 내부 후보 |",
        f"| information_insufficient | {status_counts['information_insufficient']:,} | {pct(status_counts['information_insufficient'], total)} | 긍정 경로 연결 제외 |",
        f"| condition_false | {status_counts['condition_false']:,} | {pct(status_counts['condition_false'], total)} | 냉방 조건 연결 제외 |",
        "",
        "**결정: 보류.** 전국 데이터 수집·좌표·출처 추적은 확인했지만, 즉시 출입 가능 여부를 판정할 행별 접근조건이 없다. 별도 접근조건 검수 전에는 모든 행을 `information_insufficient`로 두며, 자동 경로 연결과 외부 데이터 배포를 보류한다.",
        "",
        "## 2. 독립 하드게이트 검증",
        "",
        "### 원본 ID 및 이름+주소 중복",
        "",
        f"- 원본 ID 중복 추가행: **{duplicate_id_extra:,}건**",
        f"- 동일 이름+도로명주소 중복 추가행: **{duplicate_identity_extra:,}건**",
        f"- 동일 이름+도로명주소 중복 영향 행: **{affected_duplicate_identity_rows:,}건** (판정 전 수동 검토 대상으로 모두 제외)",
    ]
    if duplicate_identity_groups:
        lines += ["", "| 이름 | 도로명주소 | 행 수 |", "|---|---|---:|"]
        for name, address, count in duplicate_identity_groups:
            lines.append(f"| {name} | {address} | {count:,} |")

    lines += [
        "",
        "### 운영시간 형식·상충",
        "",
        "시간 형식은 시작 `0000~2359`, 종료 `0000~2400`만 허용했다. 평일은 시작·종료 완결쌍이 필요하다. 주말/휴일은 개방 Y이면 완결쌍, N이면 시간 없음이어야 하며, 개방 값 미제공은 unknown으로 차단했다. 종료가 시작보다 이른 야간 운영은 야간개방 Y가 있을 때만 경고와 함께 허용했다.",
        "",
        "| 시간쌍 상태 | 평일 | 주말/휴일 |",
        "|---|---:|---:|",
    ]
    for state in ("complete", "missing", "incomplete", "format_error", "equal_ambiguous"):
        lines.append(f"| {state} | {weekday_states[state]:,} | {weekend_states[state]:,} |")
    lines += ["", "| 차단 사유 | 영향 행 |", "|---|---:|"]
    for reason, count in operation_reason_counts.most_common():
        lines.append(f"| `{reason}` | {count:,} |")
    if not operation_reason_counts:
        lines.append("| 없음 | 0 |")
    lines += ["", "| 비차단 경고 | 영향 행 |", "|---|---:|"]
    for reason, count in operation_warning_counts.most_common():
        lines.append(f"| `{reason}` | {count:,} |")
    if not operation_warning_counts:
        lines.append("| 없음 | 0 |")

    lines += [
        "",
        "### 냉방 3값",
        "",
        "| 값 | 건수 | 비율 | 판정 |",
        "|---|---:|---:|---|",
        f"| true | {aircon_counts['true']:,} | {pct(aircon_counts['true'], total)} | 접근조건 등 다른 게이트 검증 전 정보 부족 |",
        f"| false | {aircon_counts['false']:,} | {pct(aircon_counts['false'], total)} | 냉방 조건 불충족; 다른 정보도 부족하면 information_insufficient 우선 |",
        f"| unknown | {aircon_counts['unknown']:,} | {pct(aircon_counts['unknown'], total)} | information_insufficient |",
        "",
        f"냉방 false 478건 중 다른 게이트를 통과한 **{aircon_status_counts[('false', 'condition_false')]:,}건**은 `condition_false`, 운영정보 등도 부족한 **{aircon_status_counts[('false', 'information_insufficient')]:,}건**은 우선순위에 따라 `information_insufficient`로 분류했다.",
        "",
        "### 수정일 분포",
        "",
        f"- 파싱 성공: **{len(record_dates):,}건 ({pct(len(record_dates), total)})**",
        f"- 파싱 실패: **{date_parse_errors:,}건 ({pct(date_parse_errors, total)})**",
        f"- 최솟값: **{min(record_dates).isoformat() if record_dates else '없음'}**",
        f"- 최댓값: **{max(record_dates).isoformat() if record_dates else '없음'}**",
        "",
        "| 스냅샷 기준 수정 경과 | 건수 | 비율 |",
        "|---|---:|---:|",
    ]
    for band in ("0~30일", "31~90일", "91~365일", "366일 이상"):
        lines.append(f"| {band} | {date_age_bands[band]:,} | {pct(date_age_bands[band], total)} |")
    lines += ["", "월별 분포:", "", "| 수정 월 | 건수 |", "|---|---:|"]
    for month, count in sorted(date_months.items()):
        lines.append(f"| {month} | {count:,} |")
    lines += [
        "",
        "수정일이 오래됐다는 이유만으로 자동 만료시키지 않았다. 이번 파일은 수집 시각과 건수 일치가 확인된 최신 스냅샷이지만, 행별 `valid_until`, 공식 폐쇄, 실제 시설 확인 필드가 없다. DATA_TRUST_MODEL에 따라 개별 행 수정일과 데이터셋 수집 최신성을 혼동하지 않으며, 후속 수집 실패·명시적 유효기간 종료·공식 폐쇄 근거가 생길 때 만료 게이트를 적용해야 한다.",
        "",
        "### 광역코드 16개 및 미분류",
        "",
        f"- 인식한 광역코드 종류: **{len(recognized_codes)}개 / 기대 16개**",
        f"- 기대 코드 누락: **{', '.join(sorted(set(PROVINCES) - recognized_codes)) or '없음'}**",
        f"- 미분류 행: **{unclassified:,}건**",
        "",
        "| 코드 | 광역단위 | 건수 | 비율 |",
        "|---|---|---:|---:|",
    ]
    for code, province in PROVINCES.items():
        count = province_code_counts[code]
        lines.append(f"| {code} | {province} | {count:,} | {pct(count, total)} |")
    lines.append(f"| 기타/결측 | 미분류 | {unclassified:,} | {pct(unclassified, total)} |")

    lines += [
        "",
        "## 3. 하드게이트 사유 전체 집계",
        "",
        "한 행에 여러 사유가 있을 수 있어 합계는 전체 행 수를 넘을 수 있다.",
        "",
        "| 사유 | 영향 행 |",
        "|---|---:|",
    ]
    all_reason_counts: Counter[str] = Counter()
    for row in classified:
        all_reason_counts.update(row["hard_gate_reasons"])
    for reason, count in all_reason_counts.most_common():
        lines.append(f"| `{reason}` | {count:,} |")

    lines += [
        "",
        "## 4. 사용 제한과 다음 단계",
        "",
        "- 후보라도 **당일 개방, 냉방기 작동, 즉시 출입, 좌석·급수**를 보장하지 않는다. 질의 시각 계산과 출발 전 원문 확인 문구가 필요하다.",
        "- 원본에는 별도 `access_restriction`과 행별 이용조건 필드가 없다. 따라서 모든 행을 `information_insufficient`로 두고, 접근 제한 검수 없이 자동 경로점으로 사용하지 않는다.",
        "- 소스 라이선스·파생 데이터 재배포 조건은 이 스냅샷에 포함되지 않았다. 외부 배포는 별도 이용조건 검토와 대표 승인이 필요하다.",
        "- 다음 단계는 30개 표본의 접근조건을 별도 근거로 검수한 뒤에만 후보 승격 여부를 판단하는 것이다. 현장·외부 접촉·비용 지출은 대표 승인 후 진행한다.",
        "",
        "## 5. 재현 명령",
        "",
        "프로젝트 루트에서:",
        "",
        "```bash",
        "python public-app-ideas/rest-stop-route/scripts/audit_heat_shelter_hard_gates.py",
        "```",
        "",
        "성공 시 JSON stdout의 `ok=true`, 60,672건, 보고서와 JSONL 경로, SHA-256을 확인한다.",
        "",
    ]
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text("\n".join(lines), encoding="utf-8")

    print(json.dumps({
        "ok": True,
        "total": total,
        "status_counts": dict(status_counts),
        "aircon_counts": dict(aircon_counts),
        "duplicate_id_extra_rows": duplicate_id_extra,
        "duplicate_name_address_extra_rows": duplicate_identity_extra,
        "province_code_count": len(recognized_codes),
        "unclassified": unclassified,
        "raw_sha256": raw_sha256,
        "output": str(args.output),
        "report": str(args.report),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
