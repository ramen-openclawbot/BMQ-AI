#!/usr/bin/env python3
"""Static contracts for the Tân Tạo auto ledger migration.

These checks never connect to a database or Supabase. They guard that migration
20261101420000_tan_tao_auto_dispatch.sql:

  * adds the run/event audit tables with the required unique event key and ACLs;
  * exposes close_tan_tao_open_before and run_tan_tao_daily_ledger as
    SECURITY DEFINER functions gated to owner/service_role;
  * closes reservations/documents without writing a warehouse movement;
  * runs the daily path through the public execute_tan_tao_warehouse_command
    receipt/dispatch branches with the auto-receipt/auto-dispatch keys;
  * skips cancelled orders and business dates on/before the per-SKU cutover;
  * schedules the 15:00 UTC cron and exposes an owner-readable status RPC.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261101420000_tan_tao_auto_dispatch.sql"
SMOKE = ROOT / "scripts/smoke_tan_tao_auto_dispatch.sql"


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
        "create table if not exists public.tan_tao_auto_ledger_runs",
        "run_date date not null",
        "mode text not null",
        "mode in ('close_before_cutover', 'daily')",
        "dry_run boolean not null default false",
        "result jsonb not null",
        "create table if not exists public.tan_tao_auto_ledger_events",
        "run_id uuid not null references public.tan_tao_auto_ledger_runs(id)",
        "action text not null",
        "action in ('closed_reservation', 'closed_supplier_order', 'dispatched', 'received', 'skipped')",
        "quantity numeric",
        "business_date date",
        "reason text",
        "create unique index if not exists tan_tao_auto_ledger_events_unique_idx",
        "on public.tan_tao_auto_ledger_events(action, coalesce(reservation_id, document_id))",
    ]:
        assert needle in sql, f"Missing audit-table contract: {needle}"


def test_audit_tables_are_rls_readable_only_by_owner_or_viewers() -> None:
    sql = read(MIGRATION).lower()
    for table in ("tan_tao_auto_ledger_runs", "tan_tao_auto_ledger_events"):
        for needle in [
            f"alter table public.{table} enable row level security",
            f"revoke all on table public.{table} from public, anon, authenticated",
            f"grant select on table public.{table} to authenticated",
            f"grant all on table public.{table} to service_role",
            f"create policy {table}_select",
            "has_role((select auth.uid()), 'owner'::public.app_role)",
            "public.can_view_tan_tao_warehouse()",
        ]:
            assert needle in sql, f"Missing ACL/RLS contract for {table}: {needle}"


def test_documents_gain_non_posting_closed_status() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "alter table public.tan_tao_warehouse_documents",
        "drop constraint if exists tan_tao_warehouse_documents_status_check",
        "status in ('expected', 'reserved', 'posted', 'cancelled', 'closed')",
    ]:
        assert needle in sql, f"Missing closed-document status contract: {needle}"


def test_close_rpc_is_owner_gated_and_never_posts_stock() -> None:
    sql = read(MIGRATION)
    close = function_body(sql, "close_tan_tao_open_before", "revoke all on function public.close_tan_tao_open_before").lower()
    for needle in [
        "security definer",
        "set search_path = ''",
        "auth.uid()",
        "auth.role()",
        "'owner'::public.app_role",
        "raise exception 'insufficient_privilege'",
        "p_dry_run",
        "status = 'cancelled'",
        "released_at = now()",
        "status = 'closed'",
        "'closed_reservation'",
        "'closed_supplier_order'",
        "before_cutover",
        "on conflict (action, coalesce(reservation_id, document_id)) do nothing",
        "public.tan_tao_auto_ledger_business_date",
        "public.tan_tao_auto_ledger_cutover",
    ]:
        assert needle in close, f"Missing close-before contract: {needle}"
    for forbidden in [
        "insert into public.tan_tao_warehouse_movements",
        "update public.tan_tao_warehouse_movements",
        "delete from public.tan_tao_warehouse_movements",
        "execute_tan_tao_warehouse_command",
    ]:
        assert forbidden not in close, f"Close-before must never post stock: {forbidden}"


def test_daily_rpc_is_owner_gated_and_uses_public_command_paths() -> None:
    sql = read(MIGRATION)
    daily = function_body(sql, "run_tan_tao_daily_ledger", "revoke all on function public.run_tan_tao_daily_ledger").lower()
    for needle in [
        "security definer",
        "set search_path = ''",
        "'owner'::public.app_role",
        "raise exception 'insufficient_privilege'",
        "public.execute_tan_tao_warehouse_command(",
        "'receipt'",
        "'dispatch'",
        "'auto-receipt:' || v_supplier.document_id::text",
        "'auto-dispatch:' || v_reservation.reservation_id::text",
        "p_source_document_number",
        "v_supplier.document_number",
        "v_reservation.document_number",
        "insufficient_stock",
        "before_cutover",
        "already_received",
        "cancelled_order",
        "v_order_status = 'cancelled'",
        "v_notice_status = 'cancelled'",
        "on_hand_delta",
        "on conflict (action, coalesce(reservation_id, document_id)) do nothing",
    ]:
        assert needle in daily, f"Missing daily-ledger contract: {needle}"
    assert daily.index("'receipt'") < daily.index("'dispatch'"), (
        "daily run must receive expected supplier orders before dispatching"
    )


def test_daily_skips_before_cutover_without_posting() -> None:
    sql = read(MIGRATION).lower()
    assert "v_business_date <= v_cutover" in sql
    assert "v_reason := 'before_cutover'" in sql
    assert "public.tan_tao_auto_ledger_cutover(v_supplier.sku_id)" in sql
    assert "public.tan_tao_auto_ledger_cutover(v_reservation.sku_id)" in sql


def test_status_rpc_is_owner_or_viewer_readable() -> None:
    sql = read(MIGRATION).lower()
    status = function_body(sql, "get_tan_tao_auto_ledger_status", "revoke all on function public.get_tan_tao_auto_ledger_status")
    for needle in [
        "security definer",
        "set search_path = ''",
        "p_limit integer default 14",
        "public.has_role((select auth.uid()), 'owner'::public.app_role)",
        "public.can_view_tan_tao_warehouse()",
        "from public.tan_tao_auto_ledger_runs",
        "'totals', coalesce(recent.result -> 'items', '[]'::jsonb)",
    ]:
        assert needle in status.lower(), f"Missing status contract: {needle}"


def test_cron_job_name_and_schedule() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "tan-tao-daily-ledger",
        "'0 15 * * *'",
        "perform cron.unschedule(existing_job_id)",
        "perform cron.schedule(",
        "select public.run_tan_tao_daily_ledger();",
    ]:
        assert needle in sql, f"Missing cron contract: {needle}"


def test_grants_are_private_for_the_new_rpcs() -> None:
    sql = read(MIGRATION).lower()
    for signature in (
        "public.close_tan_tao_open_before(date, boolean)",
        "public.run_tan_tao_daily_ledger(date, boolean)",
        "public.get_tan_tao_auto_ledger_status(integer)",
    ):
        assert f"revoke all on function {signature} from public, anon, authenticated" in sql
        assert f"grant execute on function {signature} to authenticated, service_role" in sql


def test_rollback_smoke_covers_the_required_paths() -> None:
    smoke = read(SMOKE).lower()
    for needle in [
        "begin;",
        "rollback;",
        "request.jwt.claims",
        "close_tan_tao_open_before('2026-10-16', true)",
        "close_tan_tao_open_before('2026-10-16', false)",
        "run_tan_tao_daily_ledger('2026-10-18', false)",
        "run_tan_tao_daily_ledger('2026-10-18', false)",
        "'smoke_result pass'",
    ]:
        assert needle in smoke, f"Missing smoke contract: {needle}"
    assert "insert into public.tan_tao_warehouse_movements" not in smoke, (
        "smoke fixtures must never insert warehouse movements directly"
    )


def main() -> None:
    test_audit_tables_and_unique_event_key()
    test_audit_tables_are_rls_readable_only_by_owner_or_viewers()
    test_documents_gain_non_posting_closed_status()
    test_close_rpc_is_owner_gated_and_never_posts_stock()
    test_daily_rpc_is_owner_gated_and_uses_public_command_paths()
    test_daily_skips_before_cutover_without_posting()
    test_status_rpc_is_owner_or_viewer_readable()
    test_cron_job_name_and_schedule()
    test_grants_are_private_for_the_new_rpcs()
    test_rollback_smoke_covers_the_required_paths()
    print("TAN_TAO_AUTO_DISPATCH_CONTRACT PASS")


if __name__ == "__main__":
    main()
