#!/usr/bin/env python3
"""Regression checks for bank-slip payment allocation RPC.

The Drive import confirmation path calls record_payment_allocations(). PostgreSQL
has no built-in min(uuid), so the RPC must not aggregate supplier_id with min().
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"
DIALOG = ROOT / "src/components/payment-requests/DriveImportProgressDialog.tsx"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    migration = read(MIGRATIONS / "20260609023000_fix_record_payment_allocations_uuid_supplier.sql")
    dialog = read(DIALOG)

    assert_true("record_payment_allocations" in dialog, "bank slip confirmation must still call payment allocation RPC")
    assert_true("min(pr.supplier_id)" not in migration, "RPC fix must not use unsupported min(uuid)")
    assert_true("array_agg(distinct pr.supplier_id order by pr.supplier_id))[1]" in migration, "RPC fix must pick the single supplier without min(uuid)")
    assert_true("supplier_count = 1 then selected_supplier_id" in migration, "single-supplier payment should still stamp payments.supplier_id")

    print("PASS: Bank slip payment allocation RPC avoids unsupported min(uuid) supplier aggregation")


if __name__ == "__main__":
    main()
