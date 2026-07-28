#!/usr/bin/env python3
"""Build a compact SQLite/RTree search index from normalized shelter JSONL."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path

SOURCE_PROVIDER = "행정안전부"
SOURCE_URL = "https://www.safetydata.go.kr/disaster-data/view?dataSn=1338"
SCHEMA_VERSION = "2"
HARD_GATE_STATUSES = {
    "internal_route_candidate",
    "information_insufficient",
    "condition_false",
}


def load_hard_gates(path: Path) -> dict[str, tuple[str, str]]:
    gates: dict[str, tuple[str, str]] = {}
    with path.open(encoding="utf-8") as lines:
        for line_number, line in enumerate(lines, start=1):
            record = json.loads(line)
            original_id = str(record.get("original_id"))
            status = record.get("hard_gate_status")
            reasons = record.get("hard_gate_reasons")
            if not original_id or original_id == "None" or original_id in gates:
                raise ValueError(f"hard-gate line {line_number}: invalid or duplicate original_id")
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
                if aircon not in {"true", "false", "unknown"}:
                    raise ValueError(f"line {count}: invalid has_aircon={aircon!r}")
                lat, lon = record.get("lat"), record.get("lon")
                if not isinstance(lat, (int, float)) or not -90 <= lat <= 90:
                    raise ValueError(f"line {count}: invalid latitude")
                if not isinstance(lon, (int, float)) or not -180 <= lon <= 180:
                    raise ValueError(f"line {count}: invalid longitude")
                ingested_at = record.get("ingested_at") or ""
                latest_ingested_at = max(latest_ingested_at, ingested_at)
                original_id = str(record["original_id"])
                gate = gate_by_id.get(original_id)
                if gate is None:
                    raise ValueError(f"line {count}: hard-gate result missing for original_id={original_id}")
                matched_gate_ids.add(original_id)
                shelter_rows.append(
                    (
                        count,
                        record["place_id"],
                        original_id,
                        record["name"],
                        lat,
                        lon,
                        record.get("road_address") or "",
                        record.get("lot_address"),
                        aircon,
                        gate[0],
                        gate[1],
                        record.get("weekday_begin"),
                        record.get("weekday_end"),
                        record.get("weekend_begin"),
                        record.get("weekend_end"),
                        record.get("weekend_open"),
                        record.get("source_provider") or SOURCE_PROVIDER,
                        record.get("source_url") or SOURCE_URL,
                        record.get("record_updated_at") or "",
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
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )""",
        shelters,
    )
    connection.executemany("INSERT INTO shelter_geo VALUES (?, ?, ?, ?, ?)", geo)


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

    if not args.source.is_file():
        raise SystemExit(f"source JSONL not found: {args.source}")
    if not args.hard_gates.is_file():
        raise SystemExit(f"hard-gate JSONL not found: {args.hard_gates}")
    if not args.force and is_current(args.source, args.hard_gates, args.output):
        print(f"search index is current: {args.output}")
        return
    count = build_index(args.source, args.hard_gates, args.output)
    print(f"built {count:,} shelter records: {args.output}")


if __name__ == "__main__":
    main()
