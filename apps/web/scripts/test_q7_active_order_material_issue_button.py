#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260816223500_backfill_q7_active_production_orders.sql"


def test_existing_q7_orders_receive_location_and_active_drafts_become_planned() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()
    assert "update public.production_orders" in sql
    assert "set location_code = 'q7'" in sql
    assert "where location_code is null" in sql
    assert "set status = 'planned'" in sql
    assert "status::text = 'draft'" in sql
    assert "planned_end_date" in sql and "planned_start_date" in sql
    assert "asia/ho_chi_minh" in sql


def test_backfill_is_scoped_and_does_not_touch_ledgers_or_delete_rows() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()
    assert "delete from" not in sql
    assert "truncate" not in sql
    assert "insert into" not in sql
    assert "kitchen_inventory_movements" not in sql
    assert "q7_inventory_movements" not in sql
    assert "production_material_issues" not in sql


if __name__ == "__main__":
    tests = [
        test_existing_q7_orders_receive_location_and_active_drafts_become_planned,
        test_backfill_is_scoped_and_does_not_touch_ledgers_or_delete_rows,
    ]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as exc:
            failed += 1
            print(f"FAIL {test.__name__}: {exc}")
    raise SystemExit(1 if failed else 0)
