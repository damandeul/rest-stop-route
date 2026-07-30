#!/usr/bin/env python3
"""Build a compact SQLite/RTree search index from normalized shelter JSONL."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
from pathlib import Path

SOURCE_PROVIDER = "행정안전부"
SOURCE_URL = "https://www.safetydata.go.kr/disaster-data/view?dataSn=1338"
SCHEMA_VERSION = "3"
EXPECTED_RECORD_COUNT = 60_672
HARD_GATE_STATUSES = {
    "internal_route_candidate",
    "information_insufficient",
    "condition_false",
}
REQUIRED_SHELTER_COLUMNS = (
    "id", "place_id", "original_id", "name", "lat", "lon", "road_address", "lot_address",
    "has_aircon", "aircon_count", "has_fan", "fan_count", "capacity", "hard_gate_status",
    "hard_gate_reasons", "weekday_begin", "weekday_end", "weekend_begin", "weekend_end",
    "weekend_open", "source_provider", "source_url", "record_updated_at", "ingested_at",
)
EXPECTED_METADATA_KEYS = {
    "schema_version", "record_count", "source_provider", "source_url", "ingested_at",
    "source_size", "source_mtime_ns", "hard_gates_size", "hard_gates_mtime_ns",
}
EXPECTED_SHELTERS_SQL = (
    "createtableshelters(idintegerprimarykey,place_idtextnotnullunique,"
    "original_idtextnotnull,nametextnotnull,latrealnotnull,lonrealnotnull,"
    "road_addresstextnotnull,lot_addresstext,has_aircontextnotnullcheck("
    "has_airconin('true','false','unknown')),aircon_countintegercheck("
    "aircon_countisnulloraircon_count>=0),has_fantextnotnullcheck("
    "has_fanin('true','false','unknown')),fan_countintegercheck("
    "fan_countisnullorfan_count>=0),capacityintegercheck("
    "capacityisnullorcapacity>=0),hard_gate_statustextnotnullcheck("
    "hard_gate_statusin('internal_route_candidate','information_insufficient',"
    "'condition_false')),hard_gate_reasonstextnotnull,weekday_begintext,"
    "weekday_endtext,weekend_begintext,weekend_endtext,weekend_opentext,"
    "source_providertextnotnull,source_urltextnotnull,"
    "record_updated_attextnotnull,ingested_attextnotnull)"
)
EXPECTED_METADATA_SQL = "createtablemetadata(keytextprimarykey,valuetextnotnull)"
EXPECTED_INDEX_SQL = {
    "shelters_aircon": "createindexshelters_aircononshelters(has_aircon)",
    "shelters_hard_gate_status": (
        "createindexshelters_hard_gate_statusonshelters(hard_gate_status)"
    ),
}


def _finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _nonnegative_integer_or_none(value: object) -> bool:
    return value is None or (isinstance(value, int) and not isinstance(value, bool) and value >= 0)


def _nonempty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _normalized_original_id(value: object, context: str) -> str:
    if isinstance(value, bool) or not (
            isinstance(value, int) or _nonempty_string(value)):
        raise ValueError(f"{context}: invalid original_id")
    return str(value)


def _normalized_sql(value) -> str:
    return "" if value is None else "".join(value.lower().split())


def load_hard_gates(path: Path) -> dict[str, tuple[str, str]]:
    gates: dict[str, tuple[str, str]] = {}
    with path.open(encoding="utf-8") as lines:
        for line_number, line in enumerate(lines, start=1):
            record = json.loads(line)
            original_id = _normalized_original_id(
                record.get("original_id"), f"hard-gate line {line_number}"
            )
            status = record.get("hard_gate_status")
            reasons = record.get("hard_gate_reasons")
            if original_id in gates:
                raise ValueError(f"hard-gate line {line_number}: duplicate original_id")
            if status not in HARD_GATE_STATUSES:
                raise ValueError(f"hard-gate line {line_number}: invalid status={status!r}")
            if not isinstance(reasons, list) or not all(isinstance(reason, str) for reason in reasons):
                raise ValueError(f"hard-gate line {line_number}: reasons must be a string list")
            gates[original_id] = (status, json.dumps(reasons, ensure_ascii=False, separators=(",", ":")))
    return gates


def build_index(source: Path, hard_gates: Path, output: Path) -> int:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.unlink(missing_ok=True)

    gate_by_id = load_hard_gates(hard_gates)
    matched_gate_ids: set[str] = set()
    matched_place_ids: set[str] = set()
    connection = sqlite3.connect(temporary)
    try:
        connection.executescript(
            """
            PRAGMA journal_mode = OFF;
            PRAGMA synchronous = OFF;
            PRAGMA temp_store = MEMORY;
            CREATE TABLE shelters (
              id INTEGER PRIMARY KEY,
              place_id TEXT NOT NULL UNIQUE,
              original_id TEXT NOT NULL,
              name TEXT NOT NULL,
              lat REAL NOT NULL,
              lon REAL NOT NULL,
              road_address TEXT NOT NULL,
              lot_address TEXT,
              has_aircon TEXT NOT NULL CHECK (has_aircon IN ('true', 'false', 'unknown')),
              aircon_count INTEGER CHECK (aircon_count IS NULL OR aircon_count >= 0),
              has_fan TEXT NOT NULL CHECK (has_fan IN ('true', 'false', 'unknown')),
              fan_count INTEGER CHECK (fan_count IS NULL OR fan_count >= 0),
              capacity INTEGER CHECK (capacity IS NULL OR capacity >= 0),
              hard_gate_status TEXT NOT NULL CHECK (hard_gate_status IN ('internal_route_candidate', 'information_insufficient', 'condition_false')),
              hard_gate_reasons TEXT NOT NULL,
              weekday_begin TEXT,
              weekday_end TEXT,
              weekend_begin TEXT,
              weekend_end TEXT,
              weekend_open TEXT,
              source_provider TEXT NOT NULL,
              source_url TEXT NOT NULL,
              record_updated_at TEXT NOT NULL,
              ingested_at TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE shelter_geo USING rtree(
              id, min_lat, max_lat, min_lon, max_lon
            );
            CREATE INDEX shelters_aircon ON shelters(has_aircon);
            CREATE INDEX shelters_hard_gate_status ON shelters(hard_gate_status);
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """
        )
        shelter_rows = []
        geo_rows = []
        count = 0
        latest_ingested_at = ""
        with source.open(encoding="utf-8") as lines:
            for count, line in enumerate(lines, start=1):
                record = json.loads(line)
                aircon = record.get("has_aircon")
                fan = record.get("has_fan")
                if aircon not in {"true", "false", "unknown"}:
                    raise ValueError(f"line {count}: invalid has_aircon={aircon!r}")
                if fan not in {"true", "false", "unknown"}:
                    raise ValueError(f"line {count}: invalid has_fan={fan!r}")
                lat, lon = record.get("lat"), record.get("lon")
                if not _finite_number(lat) or not -90 <= lat <= 90:
                    raise ValueError(f"line {count}: invalid latitude")
                if not _finite_number(lon) or not -180 <= lon <= 180:
                    raise ValueError(f"line {count}: invalid longitude")
                for field in ("aircon_count", "fan_count", "capacity"):
                    if not _nonnegative_integer_or_none(record.get(field)):
                        raise ValueError(f"line {count}: invalid {field}")
                for field in ("place_id", "name", "road_address", "record_updated_at", "ingested_at"):
                    if not _nonempty_string(record.get(field)):
                        raise ValueError(f"line {count}: invalid {field}")
                original_id = _normalized_original_id(
                    record.get("original_id"), f"line {count}"
                )
                place_id = record["place_id"]
                if original_id in matched_gate_ids:
                    raise ValueError(f"line {count}: duplicate original_id={original_id}")
                if place_id in matched_place_ids:
                    raise ValueError(f"line {count}: duplicate place_id={place_id}")
                ingested_at = record["ingested_at"]
                latest_ingested_at = max(latest_ingested_at, ingested_at)
                gate = gate_by_id.get(original_id)
                if gate is None:
                    raise ValueError(f"line {count}: hard-gate result missing for original_id={original_id}")
                matched_gate_ids.add(original_id)
                matched_place_ids.add(place_id)
                shelter_rows.append(
                    (
                        count,
                        place_id,
                        original_id,
                        record["name"],
                        lat,
                        lon,
                        record.get("road_address") or "",
                        record.get("lot_address"),
                        aircon,
                        record.get("aircon_count"),
                        fan,
                        record.get("fan_count"),
                        record.get("capacity"),
                        gate[0],
                        gate[1],
                        record.get("weekday_begin"),
                        record.get("weekday_end"),
                        record.get("weekend_begin"),
                        record.get("weekend_end"),
                        record.get("weekend_open"),
                        SOURCE_PROVIDER,
                        SOURCE_URL,
                        record["record_updated_at"],
                        ingested_at,
                    )
                )
                geo_rows.append((count, lat, lat, lon, lon))
                if len(shelter_rows) >= 1000:
                    _insert_batch(connection, shelter_rows, geo_rows)
                    shelter_rows.clear()
                    geo_rows.clear()
        if shelter_rows:
            _insert_batch(connection, shelter_rows, geo_rows)

        unmatched_gate_ids = set(gate_by_id) - matched_gate_ids
        if unmatched_gate_ids:
            sample = sorted(unmatched_gate_ids)[:3]
            raise ValueError(f"hard-gate results without normalized rows: {sample!r}")

        connection.executemany(
            "INSERT INTO metadata(key, value) VALUES (?, ?)",
            [
                ("schema_version", SCHEMA_VERSION),
                ("record_count", str(count)),
                ("source_provider", SOURCE_PROVIDER),
                ("source_url", SOURCE_URL),
                ("ingested_at", latest_ingested_at),
                ("source_size", str(source.stat().st_size)),
                ("source_mtime_ns", str(source.stat().st_mtime_ns)),
                ("hard_gates_size", str(hard_gates.stat().st_size)),
                ("hard_gates_mtime_ns", str(hard_gates.stat().st_mtime_ns)),
            ],
        )
        connection.execute("ANALYZE")
        connection.commit()
    finally:
        connection.close()

    os.replace(temporary, output)
    return count


def _insert_batch(connection: sqlite3.Connection, shelters: list[tuple], geo: list[tuple]) -> None:
    connection.executemany(
        """INSERT INTO shelters VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )""",
        shelters,
    )
    connection.executemany("INSERT INTO shelter_geo VALUES (?, ?, ?, ?, ?)", geo)


def is_deployable_index(output: Path, expected_record_count: int = EXPECTED_RECORD_COUNT) -> bool:
    if not output.is_file():
        return False
    connection = None
    try:
        connection = sqlite3.connect(f"file:{output}?mode=ro", uri=True)
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            return False
        metadata = dict(connection.execute("SELECT key, value FROM metadata"))
        shelter_columns = tuple(row[1] for row in connection.execute("PRAGMA table_info(shelters)"))
        if shelter_columns != REQUIRED_SHELTER_COLUMNS:
            return False
        metadata_columns = tuple(row[1] for row in connection.execute("PRAGMA table_info(metadata)"))
        geo_columns = tuple(row[1] for row in connection.execute("PRAGMA table_info(shelter_geo)"))
        rtree_row = connection.execute(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name='shelter_geo'"
        ).fetchone()
        shelters_row = connection.execute(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name='shelters'"
        ).fetchone()
        metadata_row = connection.execute(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name='metadata'"
        ).fetchone()
        index_sql = dict(connection.execute(
            "SELECT name, sql FROM sqlite_schema WHERE type='index' AND name LIKE 'shelters_%'"
        ))
        normalized_rtree_sql = _normalized_sql(None if rtree_row is None else rtree_row[0])
        if metadata_columns != ("key", "value") or geo_columns != (
                "id", "min_lat", "max_lat", "min_lon", "max_lon"):
            return False
        if normalized_rtree_sql != (
                "createvirtualtableshelter_geousingrtree("
                "id,min_lat,max_lat,min_lon,max_lon)"):
            return False
        if _normalized_sql(None if shelters_row is None else shelters_row[0]) != EXPECTED_SHELTERS_SQL:
            return False
        if _normalized_sql(None if metadata_row is None else metadata_row[0]) != EXPECTED_METADATA_SQL:
            return False
        if {name: _normalized_sql(sql) for name, sql in index_sql.items()} != EXPECTED_INDEX_SQL:
            return False
        record_count = connection.execute("SELECT COUNT(*) FROM shelters").fetchone()[0]
        geo_count = connection.execute("SELECT COUNT(*) FROM shelter_geo").fetchone()[0]
        invalid_sources = connection.execute(
            "SELECT COUNT(*) FROM shelters WHERE source_provider != ? OR source_url != ?",
            (SOURCE_PROVIDER, SOURCE_URL),
        ).fetchone()[0]
        invalid_statuses = connection.execute(
            "SELECT COUNT(*) FROM shelters WHERE hard_gate_status != 'information_insufficient'"
        ).fetchone()[0]
        invalid_values = connection.execute(
            """SELECT COUNT(*) FROM shelters
            WHERE typeof(id) != 'integer'
               OR typeof(lat) NOT IN ('integer', 'real') OR lat < -90 OR lat > 90
               OR typeof(lon) NOT IN ('integer', 'real') OR lon < -180 OR lon > 180
               OR typeof(place_id) != 'text' OR trim(place_id) = ''
               OR typeof(original_id) != 'text' OR trim(original_id) = ''
               OR typeof(name) != 'text' OR trim(name) = ''
               OR typeof(road_address) != 'text' OR trim(road_address) = ''
               OR typeof(record_updated_at) != 'text' OR trim(record_updated_at) = ''
               OR typeof(ingested_at) != 'text' OR trim(ingested_at) = ''
               OR has_aircon NOT IN ('true', 'false', 'unknown')
               OR has_fan NOT IN ('true', 'false', 'unknown')
               OR (aircon_count IS NOT NULL AND (typeof(aircon_count) != 'integer' OR aircon_count < 0))
               OR (fan_count IS NOT NULL AND (typeof(fan_count) != 'integer' OR fan_count < 0))
               OR (capacity IS NOT NULL AND (typeof(capacity) != 'integer' OR capacity < 0))"""
        ).fetchone()[0]
        mismatched_geo = connection.execute(
            """SELECT COUNT(*) FROM shelters AS s
            LEFT JOIN shelter_geo AS g ON g.id = s.id
            WHERE g.id IS NULL
               OR ABS(g.min_lat - s.lat) > 0.00001
               OR ABS(g.max_lat - s.lat) > 0.00001
               OR ABS(g.min_lon - s.lon) > 0.00003
               OR ABS(g.max_lon - s.lon) > 0.00003"""
        ).fetchone()[0]
        orphaned_geo = connection.execute(
            """SELECT COUNT(*) FROM shelter_geo AS g
            LEFT JOIN shelters AS s ON s.id = g.id WHERE s.id IS NULL"""
        ).fetchone()[0]
        duplicate_ids = connection.execute(
            """SELECT
              (SELECT COUNT(*) - COUNT(DISTINCT place_id) FROM shelters)
              + (SELECT COUNT(*) - COUNT(DISTINCT original_id) FROM shelters)"""
        ).fetchone()[0]
        metadata_numbers_valid = all(
            isinstance(metadata.get(key), str) and metadata[key].isdigit()
            for key in ("source_size", "source_mtime_ns", "hard_gates_size", "hard_gates_mtime_ns")
        )
        for (encoded_reasons,) in connection.execute("SELECT hard_gate_reasons FROM shelters"):
            reasons = json.loads(encoded_reasons)
            if not isinstance(reasons, list) or not all(isinstance(reason, str) for reason in reasons):
                return False
        return (
            set(metadata) == EXPECTED_METADATA_KEYS
            and metadata.get("schema_version") == SCHEMA_VERSION
            and metadata.get("record_count") == str(record_count)
            and metadata.get("source_provider") == SOURCE_PROVIDER
            and metadata.get("source_url") == SOURCE_URL
            and _nonempty_string(metadata.get("ingested_at"))
            and metadata_numbers_valid
            and record_count == expected_record_count
            and geo_count == record_count
            and invalid_sources == 0
            and invalid_statuses == 0
            and invalid_values == 0
            and mismatched_geo == 0
            and orphaned_geo == 0
            and duplicate_ids == 0
        )
    except (json.JSONDecodeError, OSError, sqlite3.Error, TypeError, ValueError):
        return False
    finally:
        if connection is not None:
            connection.close()


def calculate_index_digest(output: Path) -> str:
    digest = hashlib.sha256()
    with output.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_index_digest(output: Path) -> bool:
    digest_path = output.with_suffix(output.suffix + ".sha256")
    try:
        expected = digest_path.read_text(encoding="ascii").strip()
        return len(expected) == 64 and all(character in "0123456789abcdef" for character in expected) \
            and calculate_index_digest(output) == expected
    except (OSError, UnicodeError):
        return False


def write_index_digest(output: Path) -> Path:
    digest_path = output.with_suffix(output.suffix + ".sha256")
    temporary = digest_path.with_suffix(digest_path.suffix + ".tmp")
    temporary.write_text(calculate_index_digest(output) + "\n", encoding="ascii")
    os.replace(temporary, digest_path)
    return digest_path


def is_current(source: Path, hard_gates: Path, output: Path) -> bool:
    if not output.exists():
        return False
    try:
        connection = sqlite3.connect(f"file:{output}?mode=ro", uri=True)
        metadata = dict(connection.execute("SELECT key, value FROM metadata"))
        connection.close()
        return (
            metadata.get("schema_version") == SCHEMA_VERSION
            and metadata.get("source_size") == str(source.stat().st_size)
            and metadata.get("source_mtime_ns") == str(source.stat().st_mtime_ns)
            and metadata.get("hard_gates_size") == str(hard_gates.stat().st_size)
            and metadata.get("hard_gates_mtime_ns") == str(hard_gates.stat().st_mtime_ns)
        )
    except sqlite3.Error:
        return False


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=project / "data/processed/heat-shelters.jsonl")
    parser.add_argument("--hard-gates", type=Path, default=project / "data/processed/heat-shelter-hard-gates.jsonl")
    parser.add_argument("--output", type=Path, default=project / "prototype/data/heat-shelters.sqlite")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    source_available = args.source.is_file()
    hard_gates_available = args.hard_gates.is_file()
    if not source_available or not hard_gates_available:
        if (not args.force
                and verify_index_digest(args.output)
                and is_deployable_index(args.output)
                and verify_index_digest(args.output)):
            print(f"verified tracked search index and committed digest: {args.output}")
            return
        missing = []
        if not source_available:
            missing.append(f"source JSONL not found: {args.source}")
        if not hard_gates_available:
            missing.append(f"hard-gate JSONL not found: {args.hard_gates}")
        raise SystemExit("\n".join(missing))
    if not args.force and is_current(args.source, args.hard_gates, args.output) and is_deployable_index(args.output):
        write_index_digest(args.output)
        print(f"search index is current: {args.output}")
        return
    count = build_index(args.source, args.hard_gates, args.output)
    if not is_deployable_index(args.output):
        raise SystemExit(f"built search index failed deployment validation: {args.output}")
    write_index_digest(args.output)
    print(f"built {count:,} shelter records: {args.output}")


if __name__ == "__main__":
    main()
