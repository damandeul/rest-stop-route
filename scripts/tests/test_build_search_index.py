import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_search_index import (  # noqa: E402
    build_index,
    is_deployable_index,
    verify_index_digest,
    write_index_digest,
)


class BuildSearchIndexTest(unittest.TestCase):
    def test_preserves_official_cooling_and_capacity_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.jsonl'
            gates = root / 'gates.jsonl'
            output = root / 'index.sqlite'
            source.write_text(json.dumps({
                'place_id': 'mois-heat-1',
                'original_id': 1,
                'name': '공식쉼터',
                'lat': 37.5,
                'lon': 127.0,
                'road_address': '서울특별시 테스트로 1',
                'lot_address': '1-1',
                'has_aircon': 'true',
                'aircon_count': 3,
                'has_fan': 'false',
                'fan_count': 0,
                'capacity': 40,
                'record_updated_at': '2026-07-01 00:00:00',
                'ingested_at': '2026-07-02T00:00:00+00:00',
            }, ensure_ascii=False) + '\n', encoding='utf-8')
            gates.write_text(json.dumps({
                'original_id': '1',
                'hard_gate_status': 'information_insufficient',
                'hard_gate_reasons': ['access_info_unverified'],
            }, ensure_ascii=False) + '\n', encoding='utf-8')

            self.assertEqual(build_index(source, gates, output), 1)
            connection = sqlite3.connect(output)
            row = connection.execute(
                'SELECT aircon_count, has_fan, fan_count, capacity FROM shelters'
            ).fetchone()
            schema_version = connection.execute(
                "SELECT value FROM metadata WHERE key='schema_version'"
            ).fetchone()[0]
            connection.close()
            self.assertEqual(row, (3, 'false', 0, 40))
            self.assertEqual(schema_version, '3')
            self.assertFalse(is_deployable_index(output))
            self.assertTrue(is_deployable_index(output, expected_record_count=1))
            write_index_digest(output)
            self.assertTrue(verify_index_digest(output))

            connection = sqlite3.connect(output)
            connection.execute("UPDATE shelters SET source_url='javascript:alert(1)'")
            connection.commit()
            connection.close()
            self.assertFalse(is_deployable_index(output, expected_record_count=1))
            self.assertFalse(verify_index_digest(output))

            build_index(source, gates, output)
            connection = sqlite3.connect(output)
            connection.execute("UPDATE shelters SET hard_gate_reasons='not-json'")
            connection.commit()
            connection.close()
            self.assertFalse(is_deployable_index(output, expected_record_count=1))

            build_index(source, gates, output)
            connection = sqlite3.connect(output)
            connection.execute(
                'UPDATE shelter_geo SET min_lat=min_lat+10, max_lat=max_lat+10'
            )
            connection.commit()
            connection.close()
            self.assertFalse(is_deployable_index(output, expected_record_count=1))

            build_index(source, gates, output)
            connection = sqlite3.connect(output)
            connection.execute(
                'UPDATE shelter_geo SET min_lat=-90, max_lat=90, min_lon=-180, max_lon=180'
            )
            connection.commit()
            connection.close()
            self.assertFalse(is_deployable_index(output, expected_record_count=1))

            build_index(source, gates, output)
            connection = sqlite3.connect(output)
            geo_rows = connection.execute('SELECT * FROM shelter_geo').fetchall()
            connection.execute('DROP TABLE shelter_geo')
            connection.execute(
                'CREATE TABLE shelter_geo (id, min_lat, max_lat, min_lon, max_lon)'
            )
            connection.executemany('INSERT INTO shelter_geo VALUES (?, ?, ?, ?, ?)', geo_rows)
            connection.commit()
            connection.close()
            self.assertFalse(is_deployable_index(output, expected_record_count=1))

            build_index(source, gates, output)
            connection = sqlite3.connect(output)
            connection.execute("INSERT INTO metadata VALUES ('unexpected_key', 'unexpected_value')")
            connection.commit()
            connection.close()
            self.assertFalse(is_deployable_index(output, expected_record_count=1))

    def test_rejects_invalid_and_duplicate_original_ids(self):
        base_record = {
            'place_id': 'mois-heat-1', 'original_id': 'True', 'name': '공식쉼터',
            'lat': 37.5, 'lon': 127.0, 'road_address': '서울특별시 테스트로 1',
            'lot_address': None, 'has_aircon': 'true', 'aircon_count': 3,
            'has_fan': 'false', 'fan_count': 0, 'capacity': 40,
            'record_updated_at': '2026-07-01 00:00:00',
            'ingested_at': '2026-07-02T00:00:00+00:00',
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.jsonl'
            gates = root / 'gates.jsonl'
            output = root / 'index.sqlite'
            source.write_text(json.dumps(base_record, ensure_ascii=False) + '\n', encoding='utf-8')
            gates.write_text(json.dumps({
                'original_id': True,
                'hard_gate_status': 'information_insufficient',
                'hard_gate_reasons': ['access_info_unverified'],
            }, ensure_ascii=False) + '\n', encoding='utf-8')
            with self.assertRaises(ValueError):
                build_index(source, gates, output)

            first = dict(base_record, original_id=1)
            second = dict(base_record, place_id='mois-heat-2', original_id=1)
            source.write_text(
                json.dumps(first, ensure_ascii=False) + '\n'
                + json.dumps(second, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
            gates.write_text(json.dumps({
                'original_id': 1,
                'hard_gate_status': 'information_insufficient',
                'hard_gate_reasons': ['access_info_unverified'],
            }, ensure_ascii=False) + '\n', encoding='utf-8')
            with self.assertRaises(ValueError):
                build_index(source, gates, output)

    def test_rejects_loose_numeric_types_and_empty_timestamps(self):
        base_record = {
            'place_id': 'mois-heat-1',
            'original_id': 1,
            'name': '공식쉼터',
            'lat': 37.5,
            'lon': 127.0,
            'road_address': '서울특별시 테스트로 1',
            'lot_address': None,
            'has_aircon': 'true',
            'aircon_count': 3,
            'has_fan': 'false',
            'fan_count': 0,
            'capacity': 40,
            'record_updated_at': '2026-07-01 00:00:00',
            'ingested_at': '2026-07-02T00:00:00+00:00',
        }
        invalid_values = {
            'bool latitude': ('lat', True),
            'string aircon count': ('aircon_count', '3'),
            'empty record timestamp': ('record_updated_at', ''),
            'empty ingestion timestamp': ('ingested_at', ''),
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gates = root / 'gates.jsonl'
            gates.write_text(json.dumps({
                'original_id': '1',
                'hard_gate_status': 'information_insufficient',
                'hard_gate_reasons': ['access_info_unverified'],
            }, ensure_ascii=False) + '\n', encoding='utf-8')
            for label, (field, value) in invalid_values.items():
                with self.subTest(label=label):
                    source = root / f'{field}.jsonl'
                    output = root / f'{field}.sqlite'
                    record = dict(base_record)
                    record[field] = value
                    source.write_text(json.dumps(record, ensure_ascii=False) + '\n', encoding='utf-8')
                    with self.assertRaises(ValueError):
                        build_index(source, gates, output)


if __name__ == '__main__':
    unittest.main()
