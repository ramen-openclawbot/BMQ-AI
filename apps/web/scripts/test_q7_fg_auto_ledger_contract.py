#!/usr/bin/env python3
"""Static contract checks for the Q7 finished-goods auto ledger migration.

These checks never connect to a database or Supabase. They guard that migration
20261101430000_q7_fg_auto_ledger.sql:

  * creates the run/event audit tables with the required unique event key and
    owner / Q7-viewer read ACL;
  * exposes run_q7_fg_daily_ledger as a SECURITY DEFINER owner/service-only RPC
    that receives through create_q7_finished_goods_receipt and dispatches
    through create_q7_finished_goods_issue with request ids derived from the
    production-order item id;
  * skips before_cutover / no_sku / manual_receipt / manual_dispatch and logs
    insufficient_stock instead of failing the whole run;
  * schedules the 15:10 UTC cron and exposes get_q7_fg_auto_status;
  * never writes a revenue table.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261101430000_q7_fg_auto_ledger.sql"
SMOKE = ROOT / "scripts/smoke_q7_fg_auto_ledger.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def function_body(sql: str, name: str, next_marker: str) -> str:
    marker = f"create or replace function public.{name}("
    start = sql.index(marker)
    end = sql.index(next_marker, start)
    return sql[start:end]


def test_audit_tables_and_unique_event_key() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "create table if not exists public.q7_fg_auto_runs",
        "run_date date not null",
        "dry_run boolean not null default false",
        "result jsonb not null",
        "created_by uuid references auth.users(id) on delete set null",
        "created_at timestamptz not null default now()",
        "create table if not exists public.q7_fg_auto_events",
        "run_id uuid not null references public.q7_fg_auto_runs(id) on delete cascade",
        "production_order_item_id uuid not null references public.production_order_items(id)",
        "action text not null",
        "action in ('received', 'dispatched', 'skipped')",
        "quantity numeric",
        "business_date date",
        "reason text",
        "unique (action, production_order_item_id)",
    ]:
        assert needle in sql, f"Missing audit-table contract: {needle}"


def test_audit_tables_are_rls_readable_only_by_owner_or_q7_viewer() -> None:
    sql = read(MIGRATION).lower()
    for table in ("q7_fg_auto_runs", "q7_fg_auto_events"):
        for needle in [
            f"alter table public.{table} enable row level security",
            f"revoke all on table public.{table} from public, anon, authenticated",
            f"grant select on table public.{table} to authenticated",
            f"grant all on table public.{table} to service_role",
            f"create policy {table}_select",
            "has_role((select auth.uid()), 'owner'::public.app_role)",
            "public.q7_material_inventory_can_view((select auth.uid()))",
        ]:
            assert needle in sql, f"Missing ACL/RLS contract for {table}: {needle}"


def test_daily_rpc_is_owner_or_service_gated() -> None:
    sql = read(MIGRATION)
    daily = function_body(
        sql,
        "run_q7_fg_daily_ledger",
        "revoke all on function public.run_q7_fg_daily_ledger",
    ).lower()
    for needle in [
        "security definer",
        "set search_path = ''",
        "auth.uid()",
        "auth.role()",
        "set_config('request.jwt.claim.role', 'service_role', true)",
        "'owner'::public.app_role",
        "raise exception 'insufficient_privilege'",
        "pg_advisory_xact_lock",
        "p_as_of",
        "p_dry_run",
    ]:
        assert needle in daily, f"Missing daily-ledger gate contract: {needle}"


def test_daily_rpc_uses_the_public_receipt_and_issue_paths() -> None:
    sql = read(MIGRATION)
    daily = function_body(
        sql,
        "run_q7_fg_daily_ledger",
        "revoke all on function public.run_q7_fg_daily_ledger",
    ).lower()
    for needle in [
        "public.create_q7_finished_goods_receipt(",
        "public.create_q7_finished_goods_issue(",
        "'dispatch'",
        "'tự nhập theo ' || v_item.production_number",
        "'tự xuất giao po ' || v_item.po_number",
        "actual_qty",
        "planned_qty",
        "ordered_qty",
        "least(v_dispatch_qty, v_on_hand)",
        "public.q7_fg_auto_request_id('q7-fg-receipt:', v_item.item_id)",
        "public.q7_fg_auto_request_id('q7-fg-dispatch:', v_item.item_id)",
        "on conflict (action, production_order_item_id) do nothing",
    ]:
        assert needle in daily, f"Missing daily-ledger contract: {needle}"


def test_request_ids_are_md5_of_the_item_id() -> None:
    sql = read(MIGRATION)
    for needle in [
        "md5(p_kind || p_production_order_item_id::text)",
        "substr(h, 1, 8)",
    ]:
        assert needle in sql, f"Request ids must be a deterministic uuid from md5: {needle}"
    for prefix in ("'q7-fg-receipt:'", "'q7-fg-dispatch:'"):
        assert prefix in sql, f"Missing deterministic request prefix: {prefix}"


def test_skip_reasons_and_cutover_guard() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "v_item.planned_start_date <= v_cutover",
        "v_reason := 'before_cutover'",
        "v_reason := 'no_sku'",
        "v_receipt_reason := 'manual_receipt'",
        "v_dispatch_reason := 'manual_dispatch'",
        "v_dispatch_reason := 'insufficient_stock'",
        "v_receipt_reason := 'no_receipt_quantity'",
        "v_dispatch_reason := 'no_dispatch_quantity'",
        "public.stock_ledger_cutover_date('q7')",
        "po.status::text <> 'cancelled'",
        "po.location_code = 'q7'",
        "po.planned_start_date <= v_as_of",
        "order by po.planned_start_date, po.production_number, poi.id",
    ]:
        assert needle in sql, f"Missing skip/cutover contract: {needle}"


def test_dry_run_writes_nothing() -> None:
    sql = read(MIGRATION)
    daily = function_body(
        sql,
        "run_q7_fg_daily_ledger",
        "revoke all on function public.run_q7_fg_daily_ledger",
    ).lower()
    assert "dry runs write nothing" in daily
    assert "if not p_dry_run then" in daily
    # The run row and every event insert are behind `not p_dry_run`.
    assert daily.count("insert into public.q7_fg_auto_events") == 5
    assert "if not p_dry_run then" in daily


def test_revenue_tables_are_never_touched() -> None:
    migration = read(MIGRATION).lower()
    smoke = read(SMOKE).lower()
    for text, label in ((migration, "migration"), (smoke, "smoke")):
        for forbidden in (
            "po_dispatch_revenue",
            "insert into public.revenue",
            "update public.revenue",
            "delete from public.revenue",
        ):
            assert forbidden not in text, f"{label} must not touch revenue: {forbidden}"


def test_status_rpc_is_owner_or_q7_viewer_readable() -> None:
    sql = read(MIGRATION)
    status = function_body(
        sql,
        "get_q7_fg_auto_status",
        "revoke all on function public.get_q7_fg_auto_status",
    ).lower()
    for needle in [
        "security definer",
        "set search_path = ''",
        "p_limit integer default 14",
        "public.has_role((select auth.uid()), 'owner'::public.app_role)",
        "public.q7_material_inventory_can_view((select auth.uid()))",
        "from public.q7_fg_auto_runs",
        "'totals', coalesce(recent.result -> 'items', '[]'::jsonb)",
        "'orders', coalesce(recent.result -> 'orders', '[]'::jsonb)",
    ]:
        assert needle in status, f"Missing status contract: {needle}"


def test_cron_job_name_and_schedule() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "q7-fg-daily-ledger",
        "'10 15 * * *'",
        "perform cron.unschedule(existing_job_id)",
        "perform cron.schedule(",
        "select public.run_q7_fg_daily_ledger();",
    ]:
        assert needle in sql, f"Missing cron contract: {needle}"


def test_grants_are_private_for_the_new_rpcs() -> None:
    sql = read(MIGRATION).lower()
    for signature in (
        "public.run_q7_fg_daily_ledger(date, boolean)",
        "public.get_q7_fg_auto_status(integer)",
    ):
        assert f"revoke all on function {signature} from public, anon, authenticated" in sql
        assert f"grant execute on function {signature} to authenticated, service_role" in sql


def test_rollback_smoke_covers_the_required_paths() -> None:
    smoke = read(SMOKE).lower()
    for needle in [
        "begin;",
        "rollback;",
        "request.jwt.claims",
        "run_q7_fg_daily_ledger('2026-10-17', true)",
        "run_q7_fg_daily_ledger('2026-10-17', false)",
        # Synthetic stand-ins: the real SX-20261017-001 / SX-20261016-001 exist live
        # and production_number is unique.
        "stands in for sx-20261017-001",
        "stands in for sx-20261016-001",
        "'sx-smoke-'",
        "before_cutover",
        "manual_receipt",
        "create_q7_finished_goods_receipt(",
        "raise notice 'smoke_result pass'",
    ]:
        assert needle in smoke, f"Missing smoke contract: {needle}"


def main() -> None:
    test_audit_tables_and_unique_event_key()
    test_audit_tables_are_rls_readable_only_by_owner_or_q7_viewer()
    test_daily_rpc_is_owner_or_service_gated()
    test_daily_rpc_uses_the_public_receipt_and_issue_paths()
    test_request_ids_are_md5_of_the_item_id()
    test_skip_reasons_and_cutover_guard()
    test_dry_run_writes_nothing()
    test_revenue_tables_are_never_touched()
    test_status_rpc_is_owner_or_q7_viewer_readable()
    test_cron_job_name_and_schedule()
    test_grants_are_private_for_the_new_rpcs()
    test_rollback_smoke_covers_the_required_paths()
    print("Q7_FG_AUTO_LEDGER_CONTRACT PASS")


if __name__ == "__main__":
    main()
