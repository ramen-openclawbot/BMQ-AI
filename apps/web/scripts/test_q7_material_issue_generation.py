#!/usr/bin/env python3
"""Task 3 contracts for per-order Q7 material issue generation.

These stdlib tests are RED before the Task 3 SQL exists and GREEN after the
migration defines the snapshot-only generator.  They intentionally assert SQL
contracts that protect production inventory history: Q7 generation may write the
issue header/items/events only after all blockers pass, but must never write the
kitchen inventory ledger or call the legacy posting RPC.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "apps/web/supabase/migrations/20260816181000_q7_signed_material_issue_workflow.sql"


def read_sql() -> str:
    return MIGRATION.read_text(encoding="utf-8")


def strip_comments(sql: str) -> str:
    return re.sub(r"--.*", "", sql)


def compact(sql: str) -> str:
    return re.sub(r"\s+", " ", strip_comments(sql).lower()).strip()


def function_sql(name: str) -> str:
    sql = compact(read_sql())
    match = re.search(
        rf"create or replace function public\.{re.escape(name)}\(.*?\bend;\s*\$\$;",
        sql,
        flags=re.S,
    )
    assert match, f"function public.{name} must be defined"
    return match.group(0)


def assert_contains_all(haystack: str, snippets: tuple[str, ...]) -> None:
    for snippet in snippets:
        assert snippet in haystack, f"missing SQL contract snippet: {snippet}"


def test_task3_adds_order_location_and_issue_item_audit_snapshot_columns() -> None:
    sql = compact(read_sql())

    assert_contains_all(
        sql,
        (
            "alter table public.production_orders add column if not exists location_code text",
            "production_orders_location_code_check",
            "check (location_code is null or location_code = 'q7')",
            "alter table public.production_material_issue_items add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict",
            "alter table public.production_material_issue_items add column if not exists q7_mapping_id uuid references public.q7_material_issue_material_mappings(id) on delete restrict",
            "alter table public.production_material_issue_items add column if not exists source_unit text",
            "alter table public.production_material_issue_items add column if not exists source_required_qty numeric",
            "alter table public.production_material_issue_items add column if not exists conversion_factor numeric(18, 8)",
            "production_material_issue_items_q7_source_qty_check",
            "production_material_issue_items_q7_conversion_check",
        ),
    )
    assert "update public.production_orders set location_code" not in sql


def test_generator_rpc_security_authorization_and_acl_contract() -> None:
    sql = compact(read_sql())
    fn = function_sql("generate_q7_production_material_issue")

    assert "returns jsonb" in fn
    assert "security definer" in fn
    assert "set search_path = public, pg_temp" in fn
    assert "coalesce(auth.role(), '') = 'service_role'" in fn
    assert "public.has_role(v_actor_id, 'owner')" in fn
    for module in ("production_q7", "warehouse", "kitchen_inventory", "q7_material_inventory"):
        assert f"public.has_module_permission(v_actor_id, '{module}', 'edit')" in fn

    assert "p_expected_issue_date date default null" in fn
    assert "blocked_issue_date_changed" in fn
    assert "p_expected_issue_date is not null" in fn
    assert "revoke all on function public.generate_q7_production_material_issue(uuid,date) from public" in sql
    assert "revoke execute on function public.generate_q7_production_material_issue(uuid,date) from anon" in sql
    assert "grant execute on function public.generate_q7_production_material_issue(uuid,date) to authenticated, service_role" in sql


def test_generator_fails_closed_for_non_q7_ineligible_or_completed_orders() -> None:
    fn = function_sql("generate_q7_production_material_issue")

    assert "where id = p_production_order_id for update" in fn
    assert "pg_advisory_xact_lock(hashtext('q7_production_material_issue'), hashtext(p_production_order_id::text))" in fn
    assert "blocked_non_q7_order" in fn
    assert "order_row.location_code is distinct from 'q7'" in fn
    assert "blocked_cancelled_order" in fn
    assert "order_row.status::text = 'cancelled'" in fn
    assert "blocked_ineligible_status" in fn
    assert "order_row.status::text not in ('planned', 'in_progress', 'completed')" in fn
    assert "'confirmed'" not in fn, "linked production_order_status enum has no confirmed value"
    assert "order_row.status::text = 'completed'" in fn
    assert "current_issue.status || '_unchanged'" in fn
    assert "blocked_completed_order" in fn


def test_generator_uses_persisted_sku_historical_cogs_leaf_logic_and_finite_checks() -> None:
    fn = function_sql("generate_q7_production_material_issue")

    assert "poi.sku_id" in fn
    assert "blocked_missing_finished_skus" in fn
    assert "coalesce(poi.sku_id" not in fn, "Task 3 must not fuzzy-match or infer missing SKU IDs"
    assert "public.kfm_daily_issue_normalize_text" not in fn
    assert "when poi.actual_qty > 0 then poi.actual_qty" in fn
    assert "when poi.planned_qty > 0 then poi.planned_qty" in fn
    assert "when poi.ordered_qty > 0 then poi.ordered_qty" in fn
    assert "from public.sku_cogs_versions v" in fn
    assert "v.effective_from <= v_issue_date" in fn
    assert "v.effective_to is null or v_issue_date <= v.effective_to" in fn
    assert "order by v.effective_from desc, v.version_no desc, v.id::text desc" in fn
    assert "sku_cogs_version_formulations child" in fn
    assert "position(f.ingredient_name || ' > ' in child.ingredient_name) = 1" in fn
    assert "selected_finished_output_qty" in fn
    for marker in ("'nan'", "'infinity'", "'-infinity'"):
        assert marker in fn
    assert "blocked_invalid_formulations" in fn
    assert "blocked_nonpositive_required_qty" in fn


def test_generator_requires_exactly_one_approved_q7_mapping_before_any_snapshot_write() -> None:
    fn = function_sql("generate_q7_production_material_issue")

    assert "mapping_candidates" in fn
    assert "q7_material_issue_material_mappings" in fn
    assert "approval_status = 'approved'" in fn
    assert "canonical_material_id" in fn
    assert "source_unit" in fn
    assert "mapping_count <> 1" in fn
    assert "blocked_missing_q7_mappings" in fn
    assert "blocked_duplicate_q7_mappings" in fn
    assert "blocked_invalid_q7_mappings" in fn
    assert "blocked_missing_kitchen_items" in fn
    assert "conversion_factor > 0" in fn
    assert "required_qty * conversion_factor" in fn
    blocker_pos = fn.index("if exists (select 1 from blockers")
    first_header_write = fn.index("insert into public.production_material_issues")
    first_item_write = fn.index("insert into public.production_material_issue_items")
    assert blocker_pos < first_header_write < first_item_write


def test_generator_tracks_current_issue_with_explicit_boolean_not_plpgsql_found() -> None:
    fn = function_sql("generate_q7_production_material_issue")

    current_select = "select * into current_issue from public.production_material_issues where production_order_id = p_production_order_id and status not in ('superseded', 'cancelled') for update;"
    assert current_select in fn
    assert "v_has_current_issue boolean := false" in fn
    assert f"{current_select} v_has_current_issue := found;" in fn
    assert "if found" not in fn[fn.index(current_select) + len(current_select):], "FOUND is overwritten by later SELECTs; use v_has_current_issue"
    assert "if v_has_current_issue and current_issue.status = 'posted'" in fn
    assert "if v_has_current_issue and current_issue.status in ('generated', 'pdf_ready', 'signed_uploaded', 'checking', 'ready_to_confirm', 'needs_review', 'posted')" in fn
    assert "if v_has_current_issue then update public.production_material_issues set status = 'superseded'" in fn


def test_completed_posted_issue_recomputes_source_hash_before_returning_unchanged() -> None:
    fn = function_sql("generate_q7_production_material_issue")

    completed_branch = "if order_row.status::text = 'completed' and not (v_has_current_issue and current_issue.status = 'posted') then"
    blocker_branch = "if order_row.status::text not in ('planned', 'in_progress', 'completed') then"
    completed_start = fn.index(completed_branch)
    completed_end = fn.index(blocker_branch)
    hash_pos = fn.index("select encode(extensions.digest")
    unchanged_pos = fn.index("'status', current_issue.status || '_unchanged'")
    changed_block_pos = fn.index("'status', 'blocked_posted_issue_changed'")
    first_header_write_pos = fn.index("insert into public.production_material_issues")
    supersede_pos = fn.index("update public.production_material_issues set status = 'superseded'")

    completed_sql = fn[completed_start:completed_end]
    assert "'status', 'posted_unchanged'" not in completed_sql, "completed posted issues must not return before recomputing source hash"
    assert "if order_row.status::text = 'completed' and not (v_has_current_issue and current_issue.status = 'posted') then" in fn
    assert hash_pos < unchanged_pos < changed_block_pos < supersede_pos < first_header_write_pos
    assert "'status', 'blocked_completed_order'" in completed_sql
    assert "if v_has_current_issue and current_issue.status = 'posted' then" in fn
    assert "blocked_posted_issue_changed" in fn


def test_generator_source_hash_idempotency_revisions_and_safe_response_contract() -> None:
    fn = function_sql("generate_q7_production_material_issue")

    hash_match = re.search(r"select encode\(extensions\.digest\(.*?\) stable_snapshot;", fn, flags=re.S)
    assert hash_match, "source hash must use schema-qualified extensions.digest"
    hash_sql = hash_match.group(0)
    assert "digest(string_agg(snapshot_key, '|' order by snapshot_key), 'sha256')" not in fn.replace("extensions.digest", "")
    assert "select 'o|' || order_row.id::text || '|' || order_row.production_number || '|' || v_issue_date::text as snapshot_key" in hash_sql
    assert "order_row.status::text" not in hash_sql, "order status must not affect material-relevant source hash/idempotency"
    assert "cr.unit_cost" not in hash_sql and "cr.amount" not in hash_sql, "master costs/amounts must not affect Q7 source hash/idempotency"
    assert "selected_version_id" in fn
    assert "q7_mapping_id" in fn
    assert "conversion_factor" in fn
    assert "same source hash on current q7 issue" not in fn  # comments are stripped; ensure behavior is real SQL
    assert "current_issue.source_hash = v_source_hash" in fn
    assert "current_issue.status in ('generated', 'pdf_ready', 'signed_uploaded', 'checking', 'ready_to_confirm', 'needs_review', 'posted')" in fn
    assert "blocked_posted_issue_changed" in fn
    assert "update public.production_material_issues set status = 'superseded'" in fn
    assert "v_next_revision := current_issue.revision + 1" in fn
    assert "where issue_number like 'pxk-nvl-q7-' || to_char(v_issue_date, 'yyyymmdd') || '-%'" in fn
    assert "'generated'" in fn
    assert "insert into public.production_material_issue_events" in fn
    assert "event_type" in fn
    assert "'superseded'" in fn
    assert "'generation_generated'" in fn
    assert "'issue_id', v_issue_id" in fn
    assert "'issue_number', v_issue_number" in fn
    assert "'revision', v_next_revision" in fn
    assert "'source_hash', v_source_hash" in fn
    assert "'item_count', (select count(*) from agg_items)" in fn
    assert "'blockers'" in fn
    for forbidden_response_field in ("'unit_cost'", "'amount'", "'total_amount'"):
        assert forbidden_response_field not in fn


def test_generator_has_no_inventory_ledger_dml_or_legacy_posting_call() -> None:
    fn = function_sql("generate_q7_production_material_issue")
    sql = compact(read_sql())

    forbidden = (
        "insert into public.kitchen_inventory_movements",
        "update public.kitchen_inventory_movements",
        "delete from public.kitchen_inventory_movements",
        "truncate public.kitchen_inventory_movements",
        "public.create_production_material_issue(",
    )
    for snippet in forbidden:
        assert snippet not in fn
    assert "kitchen_inventory_movements(" not in fn
    assert "insert into public.kitchen_inventory_movements" not in sql
    assert "update public.kitchen_inventory_movements" not in sql
    assert "delete from public.kitchen_inventory_movements" not in sql
    assert "truncate public.kitchen_inventory_movements" not in sql


def test_items_are_select_only_for_browser_roles_and_function_owned_writes_only() -> None:
    sql = compact(read_sql())

    assert "alter table public.production_material_issue_items enable row level security" in sql
    for old_policy in (
        "production_material_issue_items_edit",
        "p_production_material_issue_items_insert_access",
        "p_production_material_issue_items_update_access",
        "p_production_material_issue_items_delete_access",
    ):
        assert f"drop policy if exists \"{old_policy}\" on public.production_material_issue_items" in sql
    assert "create policy q7_production_material_issue_items_select" in sql
    assert "on public.production_material_issue_items for select to authenticated" in sql
    assert "revoke all on public.production_material_issue_items from public, anon, authenticated" in sql
    assert "grant select on public.production_material_issue_items to authenticated" in sql
    assert "grant insert on public.production_material_issue_items to authenticated" not in sql
    assert "grant update on public.production_material_issue_items to authenticated" not in sql
    assert "grant delete on public.production_material_issue_items to authenticated" not in sql


if __name__ == "__main__":
    tests = [name for name in globals() if name.startswith("test_")]
    failures: list[str] = []
    for name in tests:
        try:
            globals()[name]()
            print(f"PASS {name}")
        except Exception as exc:  # noqa: BLE001 - tiny stdlib runner
            failures.append(f"FAIL {name}: {exc}")
            print(failures[-1])
    if failures:
        raise SystemExit(1)
