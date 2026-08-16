#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260816224500_bootstrap_q7_legacy_order_materials.sql"


def sql() -> str:
    assert MIGRATION.exists(), f"missing migration: {MIGRATION}"
    return MIGRATION.read_text(encoding="utf-8").lower()


def test_legacy_order_sku_backfill_is_exact_and_unambiguous() -> None:
    text = sql()
    assert "update public.production_order_items" in text
    assert "sku_type = 'finished_good'" in text
    assert "lower(btrim(ps.product_name)) = lower(btrim(poi.product_name))" in text
    assert "lower(btrim(ps.unit)) = lower(btrim(poi.unit))" in text
    assert "having count(ps.id) = 1" in text
    assert "poi.sku_id is null" in text


def test_q7_material_identities_are_separate_and_one_to_one() -> None:
    text = sql()
    assert "q7_bootstrap_materials" in text
    assert "not exists" in text and "sku_cogs_version_formulations child" in text
    assert "'q7-' || upper(substr(md5(" in text
    assert "'q7-material:' ||" in text
    assert "kitchen_unit" in text
    assert "conversion_factor" in text
    assert "1::numeric" in text
    assert "approval_status" in text and "'approved'" in text
    assert "on conflict (canonical_material_id, source_unit) do nothing" in text


def test_bootstrap_is_scoped_and_never_posts_inventory() -> None:
    text = sql()
    assert "po.location_code = 'q7'" in text
    assert "po.status::text in ('planned', 'in_progress')" in text
    assert "production_material_issues" not in text
    assert "production_material_issue_items" not in text
    assert "kitchen_inventory_movements" not in text
    assert "q7_inventory_movements" not in text
    assert "delete from" not in text


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
