#!/usr/bin/env python3
"""Task 8 static contracts for the Q7 canonical controller slice.

RED against Task7: manual Q7 receipt/opening/adjustment writes only required an active
kitchen item plus any approved mapping. GREEN when a new additive migration makes
canonical material linkage the server-side authority for picker/read and manual
receipt/opening writes.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "apps/web/supabase/migrations"
TASK8_MIGRATIONS = sorted(MIGRATIONS.glob("*_task8*q7*canonical*.sql"))
assert TASK8_MIGRATIONS, "missing new Task8 Q7 canonical controller migration"
TASK8_MIGRATION = TASK8_MIGRATIONS[-1]

PROTECTED_DML_TABLES = (
    "public.kitchen_inventory_movements",
    "kitchen_inventory_movements",
)
FORBIDDEN_Q7_PRICE_TOKENS = (
    "unit_cost",
    "standard_unit_cost",
    "amount",
    "price",
    "total_amount",
)


def strip_comments(sql: str) -> str:
    sql = re.sub(r"--.*", "", sql)
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.S)
    return sql


def compact(sql: str) -> str:
    return re.sub(r"\s+", " ", strip_comments(sql).lower()).strip()


def migration_sql() -> str:
    return compact(TASK8_MIGRATION.read_text(encoding="utf-8"))


def function_sql(sql: str, name: str) -> str:
    match = re.search(
        rf"create or replace function public\.\s*{re.escape(name)}\(.*?\bend;\s*\$\$;",
        sql,
        flags=re.S,
    )
    assert match, f"function public.{name} must be defined in Task8 migration"
    return match.group(0)


def returns_table_columns(fn: str) -> str:
    match = re.search(r"returns table \((.*?)\) language", fn, flags=re.S)
    assert match, "picker RPC must use an explicit returns table contract"
    return match.group(1)


def assert_no_protected_dml(sql: str) -> None:
    for table in PROTECTED_DML_TABLES:
        for verb in ("insert into", "update", "delete from", "truncate"):
            pattern = rf"\b{verb}\s+{re.escape(table)}\b"
            assert not re.search(pattern, sql), f"Task8 migration must not run {verb} {table}"


def test_task8_migration_is_additive_q7_only_and_has_no_shared_kitchen_ledger_dml() -> None:
    sql = migration_sql()
    assert_no_protected_dml(sql)
    assert "create or replace function public.resolve_q7_canonical_inventory_item" in sql
    assert "create or replace function public.get_q7_inventory_picker" in sql
    assert "create or replace function public.record_q7_inventory_receipt" in sql
    assert "create or replace function public.backfill_q7_inventory_opening" in sql
    assert "create or replace function public.record_q7_inventory_adjustment" in sql
    assert "alter table public.q7_inventory_movements add column if not exists q7_mapping_id" in sql
    assert "alter table public.q7_inventory_openings add column if not exists q7_mapping_id" in sql
    assert "alter table public.q7_inventory_opening_audit_logs add column if not exists q7_mapping_id" in sql
    assert "values ('kitchen_inventory', 'enforced')" in sql
    assert "on conflict (source_type) do update set mode = 'enforced'" in sql
    assert "update public.q7_inventory" not in sql
    assert "insert into public.q7_inventory" not in sql.split("create or replace function", 1)[0]


def test_shared_internal_resolver_fails_closed_on_active_linked_canonical_and_exact_approved_mapping() -> None:
    sql = migration_sql()
    resolver = function_sql(sql, "resolve_q7_canonical_inventory_item")
    receipt = function_sql(sql, "record_q7_inventory_receipt")
    opening = function_sql(sql, "backfill_q7_inventory_opening")
    adjustment = function_sql(sql, "record_q7_inventory_adjustment")

    assert "public.kitchen_inventory_items" in resolver
    assert "public.sku_cogs_materials" in resolver
    assert "public.q7_material_issue_material_mappings" in resolver
    assert "kii.canonical_material_id" in resolver
    assert "kii.material_resolution_status" in resolver
    assert "v_item.material_resolution_status is distinct from 'linked'" in resolver
    assert "scm.active = true" in resolver
    assert "m.approval_status = 'approved'" in resolver
    assert "m.canonical_material_id is not distinct from v_item.canonical_material_id" in resolver
    assert "m.kitchen_inventory_item_id is not distinct from v_item.id" in resolver
    assert "lower(btrim(m.kitchen_unit)) is not distinct from lower(btrim(v_item.unit))" in resolver
    assert "v_exact_mapping_count <> 1" in resolver
    assert "q7_canonical_link_required" in resolver
    assert "q7_mapping_required" in resolver
    assert "q7_mapping_identity_mismatch" in resolver

    assert "public.resolve_q7_canonical_inventory_item(p_kitchen_inventory_item_id, p_unit)" in receipt
    assert "public.resolve_q7_canonical_inventory_item(p_kitchen_inventory_item_id, p_unit)" in opening
    assert "public.resolve_q7_canonical_inventory_item(p_kitchen_inventory_item_id, p_unit)" in adjustment
    assert "select * into v_resolved" in receipt
    assert "select * into v_resolved" in opening
    assert "v_resolved.kitchen_inventory_item_id" in receipt
    assert "v_resolved.unit" in opening
    assert "v_resolved.q7_mapping_id" in adjustment


def test_canonical_picker_rpc_returns_approved_display_identity_without_price_fields() -> None:
    sql = migration_sql()
    picker = function_sql(sql, "get_q7_inventory_picker")
    columns = returns_table_columns(picker)

    for required in (
        "kitchen_inventory_item_id uuid",
        "q7_mapping_id uuid",
        "canonical_material_id uuid",
        "material_code text",
        "canonical_name text",
        "canonical_default_unit text",
        "location_unit text",
        "display_label text",
        "active boolean",
    ):
        assert required in columns, f"picker missing column: {required}"

    assert "public.q7_material_inventory_can_view(v_actor_id)" in picker
    assert "coalesce(auth.role(), '') <> 'service_role'" in picker
    assert "actor_required" in picker
    assert "insufficient_privilege" in picker
    assert "public.q7_material_issue_material_mappings m" in picker
    assert "public.kitchen_inventory_items kii" in picker
    assert "public.sku_cogs_materials scm" in picker
    assert "m.approval_status = 'approved'" in picker
    assert "kii.active = true" in picker
    assert "kii.material_resolution_status = 'linked'" in picker
    assert "scm.active = true" in picker
    assert "scm.material_code || ' · ' || scm.canonical_name || ' · ' || kii.unit" in picker
    assert "approved_mapping_count = 1" in picker, "indistinguishable duplicate approved mappings must be omitted fail-closed"
    for forbidden in FORBIDDEN_Q7_PRICE_TOKENS:
        assert forbidden not in columns
        assert forbidden not in picker, f"picker must not expose/use Q7 price token {forbidden}"


def test_manual_writes_snapshot_canonical_identity_but_preserve_q7_only_no_price_ledger() -> None:
    sql = migration_sql()
    receipt = function_sql(sql, "record_q7_inventory_receipt")
    opening = function_sql(sql, "backfill_q7_inventory_opening")
    adjustment = function_sql(sql, "record_q7_inventory_adjustment")

    for fn in (receipt, opening, adjustment):
        assert "v_actor_id uuid := auth.uid()" in fn
        assert "actor_required" in fn
        assert "q7_mapping_id" in fn
        assert "canonical_material_id" in fn
        for forbidden in FORBIDDEN_Q7_PRICE_TOKENS:
            assert forbidden not in fn, f"manual Q7 RPC must remain costless: {forbidden}"
        assert "public.kitchen_inventory_movements" not in fn

    assert "public.q7_material_inventory_can_edit(v_actor_id)" in receipt
    assert "public.q7_material_inventory_can_edit(v_actor_id)" in opening
    assert "public.has_role(v_actor_id, 'owner')" in adjustment
    assert "public.has_module_permission(v_actor_id, 'accounting', 'edit')" in adjustment

    assert "q7_mapping_id, canonical_material_id" in receipt
    assert "v_resolved.q7_mapping_id, v_resolved.canonical_material_id" in receipt
    assert "q7_mapping_id, canonical_material_id" in opening
    assert "v_resolved.q7_mapping_id, v_resolved.canonical_material_id" in opening
    assert "jsonb_build_object('q7_mapping_id', v_resolved.q7_mapping_id" in opening
    assert "q7_mapping_id, canonical_material_id" in adjustment
    assert "v_resolved.q7_mapping_id, v_resolved.canonical_material_id" in adjustment


def test_task8_exact_rpc_acls_are_fail_closed_and_no_service_role_actor_spoofing() -> None:
    sql = migration_sql()
    assert "revoke all on function public.resolve_q7_canonical_inventory_item(uuid, text) from public, anon, authenticated, service_role" in sql
    assert "revoke all on function public.get_q7_inventory_picker() from public" in sql
    assert "revoke execute on function public.get_q7_inventory_picker() from anon" in sql
    assert "grant execute on function public.get_q7_inventory_picker() to authenticated, service_role" in sql
    assert "revoke all on function public.record_q7_inventory_receipt(date, uuid, numeric, text, text, text) from public, anon, service_role" in sql
    assert "grant execute on function public.record_q7_inventory_receipt(date, uuid, numeric, text, text, text) to authenticated" in sql
    assert "revoke all on function public.backfill_q7_inventory_opening(date, uuid, numeric, text, numeric, date, text) from public, anon, service_role" in sql
    assert "grant execute on function public.backfill_q7_inventory_opening(date, uuid, numeric, text, numeric, date, text) to authenticated" in sql
    assert "revoke all on function public.record_q7_inventory_adjustment(date, uuid, numeric, text, text, text) from public, anon, service_role" in sql
    assert "grant execute on function public.record_q7_inventory_adjustment(date, uuid, numeric, text, text, text) to authenticated" in sql
    assert not re.search(r"grant execute on function public\.(?:record_q7_inventory_receipt|backfill_q7_inventory_opening|record_q7_inventory_adjustment)\([^;]+to[^;]*service_role", sql)

    for name in ("record_q7_inventory_receipt", "backfill_q7_inventory_opening", "record_q7_inventory_adjustment"):
        fn = function_sql(sql, name)
        assert "p_actor_id" not in fn, f"{name} must derive actor from auth.uid(), not caller-supplied spoofable actor"
        assert "if v_actor_id is null then raise exception 'actor_required'" in fn


if __name__ == "__main__":
    failures: list[str] = []
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as exc:  # noqa: BLE001
                failures.append(f"FAIL {name}: {exc}")
                print(failures[-1])
    if failures:
        raise SystemExit(1)
