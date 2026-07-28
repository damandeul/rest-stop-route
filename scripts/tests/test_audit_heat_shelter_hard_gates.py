import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "audit_heat_shelter_hard_gates.py"
SOURCE_ENDPOINT = "https://www.safetydata.go.kr/V2/api/DSSP-IF-10942"


def valid_record(*, modified_at="2026-07-27 10:00:00"):
    return {
        "RSTR_FCLTY_NO": "fixture-1",
        "RSTR_NM": "테스트 쉼터",
        "RN_DTL_ADRES": "서울특별시 테스트로 1",
        "ARCD": "11",
        "LA": 37.5,
        "LO": 127.0,
        "COLR_HOLD_ARCNDTN": 1,
        "WKDAY_OPER_BEGIN_TIME": "0900",
        "WKDAY_OPER_END_TIME": "1800",
        "CHCK_MATTER_WKEND_HDAY_OPN_AT": "N",
        "WKEND_HDAY_OPER_BEGIN_TIME": "",
        "WKEND_HDAY_OPER_END_TIME": "",
        "CHCK_MATTER_NIGHT_OPN_AT": "N",
        "MODF_TIME": modified_at,
    }


def run_audit(snapshot):
    temp = tempfile.TemporaryDirectory()
    root = Path(temp.name)
    input_path = root / "input.json"
    output_path = root / "output.jsonl"
    report_path = root / "report.md"
    input_path.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--report",
            str(report_path),
        ],
        text=True,
        capture_output=True,
    )
    return temp, completed, output_path, report_path


class AuditHardGateTests(unittest.TestCase):
    def snapshot(self, record, *, source=SOURCE_ENDPOINT):
        return {
            "source": source,
            "retrieved_at": "2026-07-27T06:44:12+00:00",
            "declared_total_count": 1,
            "body": [record],
        }

    def test_unverified_access_never_becomes_internal_route_candidate(self):
        temp, completed, output_path, _ = run_audit(self.snapshot(valid_record()))
        self.addCleanup(temp.cleanup)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        row = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(row["hard_gate_status"], "information_insufficient")
        self.assertIn("access_restriction_unverified", row["hard_gate_reasons"])

    def test_future_record_timestamp_is_blocked(self):
        temp, completed, output_path, _ = run_audit(
            self.snapshot(valid_record(modified_at="2099-01-01 00:00:00"))
        )
        self.addCleanup(temp.cleanup)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        row = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertIn("record_updated_at_in_future", row["hard_gate_reasons"])
        self.assertEqual(row["hard_gate_status"], "information_insufficient")

    def test_unexpected_snapshot_source_fails_without_outputs(self):
        temp, completed, output_path, report_path = run_audit(
            self.snapshot(valid_record(), source="https://example.invalid/untrusted")
        )
        self.addCleanup(temp.cleanup)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("snapshot source mismatch", completed.stderr)
        self.assertFalse(output_path.exists())
        self.assertFalse(report_path.exists())


if __name__ == "__main__":
    unittest.main()
