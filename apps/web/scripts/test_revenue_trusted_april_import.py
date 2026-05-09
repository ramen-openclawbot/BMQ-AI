#!/usr/bin/env python3
"""Offline checks for trusted April revenue import tooling."""
from __future__ import annotations

import importlib.util
import sys
import tempfile
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/import_trusted_april_revenue.py"
CSV = Path("/tmp/bmq_trusted_april_2026/trusted_april_revenue_ledger_lines.csv")

spec = importlib.util.spec_from_file_location("import_trusted_april_revenue", SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def test_april_csv_validates_expected_accounting_totals() -> None:
    rows, checksum = module.read_rows(CSV)
    summary = module.validate_rows(
        rows,
        checksum,
        period="2026-04",
        expected_rows=1407,
        expected_gross=Decimal("936505570"),
        expected_checksum=module.EXPECTED_SHA256,
    )
    assert summary.rows == 1407
    assert summary.quantity == Decimal("99021.6")
    assert summary.gross == Decimal("936505570.0")
    assert summary.channel_totals["ĐẠI LÝ"] == Decimal("412510000.0")
    assert summary.channel_totals["BÁNH NGỌT"] == Decimal("229613570.0")
    assert summary.channel_totals["Retail Kiosk"] == Decimal("164274000.0")
    assert summary.channel_totals["B2B BMQ"] == Decimal("130108000.0")


def test_mapping_preserves_raw_trusted_source_but_uses_allowed_db_source_type() -> None:
    rows, _ = module.read_rows(CSV)
    mapped = module.map_ledger_line(rows[0], "00000000-0000-0000-0000-000000000000")
    assert mapped["source_type"] == "csv_audit"
    assert mapped["approval_status"] == "approved"
    assert mapped["audit_status"] == "tied"
    assert mapped["confidence_status"] == "trusted"
    assert mapped["raw_payload"]["original_source_type"] == "trusted_accounting_xlsx"
    assert mapped["raw_payload"]["trusted_accounting_source"] is True


def test_validation_rejects_checksum_mismatch() -> None:
    rows, checksum = module.read_rows(CSV)
    try:
        module.validate_rows(
            rows,
            checksum,
            period="2026-04",
            expected_rows=1407,
            expected_gross=Decimal("936505570"),
            expected_checksum="bad",
        )
    except ValueError as exc:
        assert "Checksum mismatch" in str(exc)
    else:
        raise AssertionError("checksum mismatch should fail")


def test_required_headers_are_enforced() -> None:
    with tempfile.TemporaryDirectory() as td:
        bad = Path(td) / "bad.csv"
        bad.write_text("period,gross_revenue\n2026-04,1\n", encoding="utf-8")
        try:
            module.read_rows(bad)
        except ValueError as exc:
            assert "missing required headers" in str(exc)
        else:
            raise AssertionError("missing headers should fail")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
