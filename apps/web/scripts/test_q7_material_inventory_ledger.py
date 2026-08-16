#!/usr/bin/env python3
"""Task 7 replacement contracts for Q7-only material inventory ledger.

Strict TDD: this test is RED against the old Task7 kitchen-ledger posting block
and GREEN only after confirmation posts signed-slip actual quantities into a
separate negative-allowed Q7 ledger with structured actuals.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OLD_MIGRATION = ROOT / "apps/web/supabase/migrations/20260816181000_q7_signed_material_issue_workflow.sql"
NEW_MIGRATION = ROOT / "apps/web/supabase/migrations/20260816221000_q7_material_inventory_ledger.sql"

FORBIDDEN_SAFE_FIELDS = (
    "unit_cost",
    "amount",
    "total_amount",
    "material_code",
    "canonical_material_id",
    "q7_mapping_id",
    "source_ref_key",
    "signed_file_path",
    "signed_file_sha256",
    "pdf_path",
    "pdf_sha256",
    "source_hash",
    "bom",
    "sku_cogs",
    "code",
    "path",
    "hash",
)


def strip_comments(sql: str) -> str:
    sql = re.sub(r"--.*", "", sql)
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.S)
    return sql


def compact(sql: str) -> str:
    return re.sub(r"\s+", " ", strip_comments(sql).lower()).strip()


def read(path: Path) -> str:
    assert path.exists(), f"missing migration: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def old_sql() -> str:
    return compact(read(OLD_MIGRATION))


def new_sql() -> str:
    return compact(read(NEW_MIGRATION))


def function_sql(sql: str, name: str) -> str:
    match = re.search(
        rf"create or replace function public\.\s*{re.escape(name)}\(.*?\bend;\s*\$\$;",
        sql,
        flags=re.S,
    )
    assert match, f"function public.{name} must be defined"
    return match.group(0)


def table_sql(sql: str, name: str) -> str:
    match = re.search(
        rf"create table if not exists public\.{re.escape(name)} \((.*?)\);",
        sql,
        flags=re.S,
    )
    assert match, f"table public.{name} must be defined"
    return match.group(1)


def response_objects(fn: str) -> list[str]:
    return re.findall(r"return jsonb_build_object\((.*?)\);", fn, flags=re.S)


def assert_absent(haystack: str, snippets: tuple[str, ...]) -> None:
    for snippet in snippets:
        assert snippet not in haystack, f"forbidden SQL contract snippet present: {snippet}"


def assert_present(haystack: str, snippets: tuple[str, ...]) -> None:
    for snippet in snippets:
        assert snippet in haystack, f"missing SQL contract snippet: {snippet}"


def test_old_monolithic_migration_removes_shared_kitchen_task7_posting() -> None:
    sql = old_sql()
    assert_absent(sql, (
        "production_issue'",
        '"production_issue"',
        "kitchen_inventory_movements_production_issue_ref_id_uidx",
        "insert into kitchen_inventory_movements",
        "insert into public.kitchen_inventory_movements",
        "blocked_missing_stock_baseline",
        "blocked_insufficient_stock",
        "blocked_closed_stock_period",
        "confirm_q7_material_issue(",
    ))
    assert "create or replace function public.generate_q7_production_material_issue" in sql
    assert "create or replace function public.finalize_q7_material_issue_check" in sql


def test_q7_ledger_schema_is_append_only_costless_negative_allowed() -> None:
    sql = new_sql()
    movements = table_sql(sql, "q7_inventory_movements")
    openings = table_sql(sql, "q7_inventory_openings")
    audit = table_sql(sql, "q7_inventory_opening_audit_logs")

    assert_present(movements, (
        "kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id) on delete restrict",
        "movement_type text not null check (movement_type in ('receipt', 'production_usage', 'adjustment'))",
        "quantity numeric(15, 3) not null",
        "source text not null check (source in ('manual_receipt', 'signed_q7_issue', 'manual_adjustment'))",
        "source_issue_item_id uuid references public.production_material_issue_items(id) on delete restrict",
        "created_by uuid references auth.users(id) on delete set null",
    ))
    assert "q7_inventory_movements_quantity_check" in sql
    assert "movement_type in ('receipt', 'production_usage') and quantity > 0" in sql
    assert "movement_type = 'adjustment' and quantity <> 0" in sql
    assert "q7_inventory_movements_signed_issue_item_uidx" in sql
    assert "source = 'signed_q7_issue' and source_issue_item_id is not null" in sql

    for table in (movements, openings, audit):
        for forbidden in ("cost", "amount", "price", "material_code", "source_hash", "path", "sha256"):
            assert forbidden not in table, f"{forbidden} must not exist in Q7 inventory tables"

    assert "opening_qty numeric(15, 3)" in openings
    assert "opening_qty is null or" in openings
    assert "physical_count_qty numeric(15, 3)" in openings
    assert "unique (kitchen_inventory_item_id, effective_date)" in openings
    assert "old_opening jsonb" in audit and "new_opening jsonb not null" in audit
    assert "q7_prevent_inventory_movement_rewrite" in sql
    assert "q7_prevent_inventory_opening_audit_rewrite" in sql
    assert "before update or delete on public.q7_inventory_movements" in sql
    assert "before update or delete on public.q7_inventory_opening_audit_logs" in sql


def test_structured_actuals_and_service_role_finalize_contract() -> None:
    sql = new_sql()
    actuals = table_sql(sql, "production_material_issue_check_actuals")
    finalize = function_sql(sql, "finalize_q7_material_issue_check_with_actuals")

    assert_present(actuals, (
        "check_id uuid not null references public.production_material_issue_checks(id) on delete restrict",
        "issue_item_id uuid not null references public.production_material_issue_items(id) on delete restrict",
        "planned_qty numeric(15, 3) not null",
        "actual_qty numeric(15, 3) not null",
        "difference_qty numeric(15, 3) generated always as (actual_qty - planned_qty) stored",
        "evidence_kind text not null check (evidence_kind in ('printed_planned', 'handwritten_final'))",
        "confidence numeric(5, 4) not null",
        "unique (check_id, issue_item_id)",
    ))
    for forbidden in ("raw", "ocr", "provider", "cost", "amount", "path", "sha256"):
        assert forbidden not in actuals, f"actuals table exposes forbidden field {forbidden}"
    assert "q7_prevent_production_material_issue_check_actual_rewrite" in sql

    assert "coalesce(auth.role(), '') <> 'service_role'" in finalize
    assert "p_actual_rows jsonb" in finalize
    assert "p_outcome <> 'passed'" in finalize and "v_result := public.finalize_q7_material_issue_check(" in finalize
    assert "jsonb_array_length(coalesce(p_actual_rows, '[]'::jsonb)) <> 0" in finalize
    assert "invalid_actuals_payload" in finalize
    assert "v_issue_item_id_text !~*" in finalize and "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" in finalize
    assert "v_actual_qty_text !~" in finalize and "v_confidence_text !~" in finalize
    assert "jsonb_typeof(v_actual -> 'issue_item_id') <> 'string'" in finalize
    assert "jsonb_array_length(p_actual_rows) <> v_issue_item_count" in finalize
    assert "v_actual_seen ? v_issue_item_id_text" in finalize
    assert "v_actual_qty < 0" in finalize
    assert "v_actual_qty > v_actual_qty_cap" in finalize
    assert "(a.value ->> 'actual_qty')::numeric > v_actual_qty_cap" not in finalize
    assert "to_jsonb(o.*), o.* into old_opening, v_opening" not in sql
    assert "select to_jsonb(o), o into old_opening, v_opening" not in sql
    assert "select * into v_opening" in sql
    assert "old_opening := case when found then to_jsonb(v_opening) else null end" in sql
    assert "v_is_exact_retry boolean := false" in finalize
    assert "v_is_exact_retry := v_check.status = 'passed' and v_issue.status = 'ready_to_confirm'" in finalize
    assert "actuals_retry_mismatch" in finalize
    assert "v_result := public.finalize_q7_material_issue_check(" in finalize
    assert "return v_result || jsonb_build_object('actual_count', v_issue_item_count)" in finalize
    assert "v_actual ? 'planned_qty'" in finalize
    assert "v_planned_qty is not null and v_planned_qty is distinct from v_item.required_qty" in finalize
    assert "coalesce(v_planned_qty, v_item.required_qty)" in finalize
    assert "lower(btrim(v_actual ->> 'unit')) is distinct from lower(btrim(v_item.unit))" in finalize
    assert "insert into public.production_material_issue_check_actuals" in finalize
    assert "v_result := public.finalize_q7_material_issue_check(" in finalize
    assert "grant execute on function public.finalize_q7_material_issue_check_with_actuals(uuid, text, text, jsonb, jsonb, text, text, uuid) to service_role" in sql
    assert "grant select on public.production_material_issue_check_actuals to authenticated" in sql
    assert "grant insert" not in sql.split("production_material_issue_check_actuals", 1)[1].split("create or replace function", 1)[0]


def test_snapshot_receipt_opening_and_adjustment_rpcs_are_safe_and_q7_only() -> None:
    sql = new_sql()
    snapshot = function_sql(sql, "get_q7_inventory_snapshot")
    receipt = function_sql(sql, "record_q7_inventory_receipt")
    opening = function_sql(sql, "backfill_q7_inventory_opening")
    adjustment = function_sql(sql, "record_q7_inventory_adjustment")

    assert "v_actor_id uuid := auth.uid()" in snapshot
    assert "actor_required" in snapshot and "insufficient_privilege" in snapshot
    assert "q7_material_inventory_can_view(v_actor_id)" in snapshot
    assert "from public.q7_material_issue_material_mappings m" in snapshot
    assert "m.approval_status = 'approved'" in snapshot
    assert "join public.kitchen_inventory_items kii" in snapshot and "kii.active = true" in snapshot
    assert "distinct on (m.kitchen_inventory_item_id)" in snapshot
    assert "effective_date" in snapshot and "o.effective_date <= v_as_of_date" in snapshot
    assert "m.movement_date >= coalesce(o.effective_date, '0001-01-01'::date)" in snapshot
    assert "opening_qty" in snapshot and "coalesce(o.opening_qty, 0)" in snapshot
    assert "usage_qty" in snapshot and "movement_type = 'production_usage'" in snapshot
    assert "is_negative" in snapshot and "opening_audited" in snapshot
    for ret in response_objects(snapshot):
        for forbidden in FORBIDDEN_SAFE_FIELDS:
            assert f"'{forbidden}'" not in ret, f"snapshot response exposes {forbidden}"

    assert "public.q7_material_inventory_can_edit(v_actor_id)" in receipt
    assert "source_ref_key_invalid" in receipt and "length(btrim(p_source_ref_key)) > 120" in receipt
    assert "on conflict (source, source_ref_key) where source_ref_key is not null do nothing" in receipt
    assert "source_ref_conflict" in receipt
    assert "receipt_unchanged" in receipt and "v_existing" in receipt
    assert "movement_type, quantity, unit, source" in receipt
    assert "'receipt', p_quantity, v_item.unit, 'manual_receipt'" in receipt

    assert "public.q7_material_inventory_can_edit(v_actor_id)" in opening
    assert "p_opening_qty is not null and (p_opening_qty < 0" in opening
    assert "opening_unchanged" in opening
    assert "old_opening" in opening and "corrected" in opening
    assert "insert into public.q7_inventory_opening_audit_logs" in opening
    assert "on conflict (kitchen_inventory_item_id, effective_date) do update" in opening
    assert "kitchen_inventory_movements" not in opening

    assert "public.has_role(v_actor_id, 'owner')" in adjustment
    assert "public.has_module_permission(v_actor_id, 'accounting', 'edit')" in adjustment
    assert "public.has_module_permission(v_actor_id, 'q7_material_inventory', 'edit')" not in adjustment
    assert "source_ref_key_invalid" in adjustment and "length(btrim(p_source_ref_key)) > 120" in adjustment
    assert "source_ref_conflict" in adjustment and "adjustment_unchanged" in adjustment
    assert "p_quantity = 0" in adjustment
    assert "'adjustment', p_quantity, v_item.unit, 'manual_adjustment'" in adjustment


def test_confirm_posts_actual_quantities_to_q7_ledger_without_stock_blockers() -> None:
    sql = new_sql()
    fn = function_sql(sql, "confirm_q7_material_issue")

    assert "v_actor_id uuid := auth.uid()" in fn
    assert "security definer" in fn and "set search_path = public, pg_temp" in fn
    assert "public.q7_material_issue_can_edit(v_actor_id)" in fn
    assert "public.generate_q7_production_material_issue(v_issue.production_order_id, v_issue.issue_date)" in fn
    assert fn.index("select * into v_issue from public.production_material_issues where id = p_issue_id for update;", fn.index("v_generator_result :=")) < fn.index("if v_issue.status = 'posted' then")
    assert "ready_to_confirm_unchanged" in fn and "posted_unchanged" in fn
    assert "production_material_issue_check_actuals" in fn
    assert "left join public.production_material_issue_check_actuals a" in fn
    assert "a.actual_qty is not null" in fn
    assert "insert into public.q7_inventory_movements" in fn
    assert "'production_usage'" in fn
    assert "'signed_q7_issue'" in fn
    assert "i.actual_qty" in fn
    assert "where i.actual_qty > 0" in fn
    assert "on conflict (source, source_issue_item_id)" in fn
    assert "v_negative_count" in fn
    assert "get_q7_inventory_snapshot(v_issue.issue_date)" in fn
    assert "material_issue_confirmed_and_posted" in fn

    assert_absent(fn, (
        "insert into kitchen_inventory_movements",
        "insert into public.kitchen_inventory_movements",
        "kitchen_inventory_monthly_closings",
        "blocked_missing_stock_baseline",
        "blocked_insufficient_stock",
        "blocked_closed_stock_period",
        "available_qty < required_qty",
        "standard_unit_cost",
        "unit_cost",
        "amount",
    ))
    for ret in response_objects(fn):
        for forbidden in FORBIDDEN_SAFE_FIELDS:
            assert f"'{forbidden}'" not in ret and f'"{forbidden}"' not in ret, f"confirm response exposes {forbidden}"

    assert "revoke all on function public.confirm_q7_material_issue(uuid) from public" in sql
    assert "grant execute on function public.confirm_q7_material_issue(uuid) to authenticated, service_role" in sql
    assert "update public.kitchen_inventory_movements" not in sql
    assert "delete from public.kitchen_inventory_movements" not in sql
    assert "truncate public.kitchen_inventory_movements" not in sql


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
