#!/usr/bin/env python3
"""Static contract checks for the KFM trace report and food-cert reminders.

No database or Supabase connection is made.  These checks guard migration
20261102950000_kho_trace_report.sql: kitchen-item resolution, the single
shelf-life source, both trace RPCs, the reminder thresholds/dedupe and the
08:00 ICT pg_cron schedule.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102950000_kho_trace_report.sql"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def block_after(text: str, marker: str, terminator: str = "$$;") -> str:
    """Case-insensitive slice from marker to the next terminator."""
    lowered = text.lower()
    start = lowered.index(marker.lower())
    end = lowered.index(terminator.lower(), start)
    return text[start:end]


def body_after(text: str, marker: str) -> str:
    return block_after(text, marker, "$$;")


def main() -> None:
    assert_true(
        MIGRATION.name == "20261102950000_kho_trace_report.sql",
        "migration must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- A. receipt line -> live kitchen item ------------------------------
    helper = body_after(migration, "CREATE OR REPLACE FUNCTION public.kho_receipt_line_item(")
    helper_lower = helper.lower()
    assert_true("p_goods_receipt_item_id uuid" in helper_lower, "helper signature")
    assert_true("returns uuid" in helper_lower, "helper must return uuid")
    assert_true("stable" in helper_lower, "helper must be stable")
    assert_true("security definer" in helper_lower, "helper must be SECURITY DEFINER")
    assert_true("set search_path = public, pg_temp" in helper_lower, "helper search_path")

    q7_index = helper_lower.index("q7_inventory_movements")
    tan_tao_index = helper_lower.index("tan_tao_material_movements")
    alias_index = helper_lower.index("stock_material_aliases")
    assert_true(q7_index < tan_tao_index < alias_index, "ledger lookup must precede the alias fallback")
    assert_true("source = 'goods_receipt'" in helper_lower, "helper must read goods_receipt movements")
    assert_true("source_ref_key = 'gr-item:'" in helper_lower, "helper must use the gr-item source key")
    assert_true(
        "a.location = coalesce(nullif(btrim(gr.receiving_location), ''), 'tan_tao')" in helper_lower,
        "alias location must come from the receipt (default tan_tao)",
    )
    assert_true(
        "public.normalize_stock_item_name(" in helper_lower
        and "gri.raw_product_name" in helper_lower
        and "gri.product_name" in helper_lower,
        "alias lookup must normalize the raw/product name",
    )
    assert_true(
        "a.supplier_id is not distinct from gr.supplier_id" in helper_lower,
        "alias supplier must match the receipt supplier",
    )
    assert_true(
        "a.status is distinct from 'disabled'" in helper_lower,
        "disabled aliases must be skipped",
    )
    assert_true(
        "a.kitchen_inventory_item_id is not null" in helper_lower,
        "alias fallback only returns a kitchen item",
    )
    assert_true(
        "order by a.last_confirmed_at desc nulls last" in helper_lower
        and "a.updated_at desc" in helper_lower
        and "a.id desc" in helper_lower,
        "alias fallback must use the kho review ordering",
    )
    assert_true("merged_into_id" in helper_lower, "helper must follow merged_into_id")
    assert_true(
        "revoke all on function public.kho_receipt_line_item(uuid) from public, anon" in lower,
        "helper must be revoked from public/anon",
    )

    # --- A. fixed expiry overview ------------------------------------------
    overview = body_after(migration, "CREATE OR REPLACE FUNCTION public.kho_expiry_overview(")
    overview_lower = overview.lower()
    assert_true(
        "public.kho_receipt_line_item(b.goods_receipt_item_id)" in overview_lower,
        "overview item_id must use the receipt-line resolver",
    )
    assert_true(
        "b.inventory_item_id as item_id" not in overview_lower,
        "overview must not use the legacy inventory_item_id",
    )
    assert_true(
        "coalesce(kii.name, ps.product_name, b.batch_number)" in overview_lower,
        "overview name must prefer the kitchen item name",
    )
    for field in (
        "'batch_id'",
        "'item_id'",
        "'sku_id'",
        "'name'",
        "'kho'",
        "'receipt_number'",
        "'received_date'",
        "'quantity'",
        "'unit'",
        "'manufacture_date'",
        "'expiry_date'",
        "'days_left'",
        "'manufacturer_lot'",
        "'manufacturer_name'",
    ):
        assert_true(field in overview_lower, f"expiry overview missing {field}")
    assert_true(
        "public.q7_material_inventory_can_view(v_actor)" in overview_lower
        and "public.stock_count_can_view('tan_tao')" in overview_lower
        and "public.stock_count_can_view('q7')" in overview_lower
        and "public.kho_item_can_edit(v_actor)" in overview_lower,
        "overview must keep the kho_get_items gate",
    )
    assert_true(
        "revoke all on function public.kho_expiry_overview(integer) from public, anon" in lower
        and "grant execute on function public.kho_expiry_overview(integer) to authenticated, service_role"
        in lower,
        "overview grants must stay unchanged",
    )

    # --- B. one shelf-life source ------------------------------------------
    assert_true(
        "drop function if exists public.sku_set_shelf_life(uuid, integer, uuid)" in lower,
        "legacy sku_set_shelf_life must be dropped",
    )
    guard_index = lower.index("product_skus_shelf_life_days_not_empty")
    drop_index = lower.index("drop column if exists shelf_life_days")
    assert_true(guard_index < drop_index, "the non-null guard must run before the column drop")
    assert_true(
        "where ps.shelf_life_days is not null" in lower
        and "raise exception 'product_skus_shelf_life_days_not_empty'" in lower,
        "the column drop must raise when any row is non-null",
    )
    assert_true(
        "drop constraint if exists product_skus_shelf_life_days_check" in lower,
        "the legacy check constraint must be dropped",
    )
    assert_true("drop column if exists shelf_life_days" in lower, "legacy column must be dropped")

    # --- C. kho_trace_candidates -------------------------------------------
    candidates = body_after(migration, "CREATE OR REPLACE FUNCTION public.kho_trace_candidates(")
    candidates_lower = candidates.lower()
    assert_true("p_from date" in candidates_lower and "p_to date" in candidates_lower, "candidate signature")
    assert_true("returns jsonb" in candidates_lower, "candidates must return jsonb")
    assert_true("stable" in candidates_lower, "candidates must be stable")
    assert_true("security definer" in candidates_lower, "candidates must be SECURITY DEFINER")
    assert_true("set search_path = public, pg_temp" in candidates_lower, "candidates search_path")
    assert_true(
        "public.q7_material_inventory_can_view(v_actor)" in candidates_lower
        and "public.stock_count_can_view('tan_tao')" in candidates_lower
        and "public.stock_count_can_view('q7')" in candidates_lower
        and "public.kho_item_can_edit(v_actor)" in candidates_lower
        and "public.has_module_permission(v_actor, 'production', 'view')" in candidates_lower,
        "candidates must use the kho view gate or production view",
    )
    assert_true("auth.role(), '') <> 'service_role'" in candidates_lower, "service_role bypass")
    assert_true(
        "from public.production_order_items poi" in candidates_lower
        and "join public.production_orders po on po.id = poi.production_order_id" in candidates_lower,
        "candidates must join production order items to orders",
    )
    assert_true(
        "coalesce(po.planned_start_date, po.completed_at::date)" in candidates_lower,
        "candidate production date",
    )
    assert_true(
        "coalesce(nullif(poi.actual_qty, 0), poi.planned_qty, poi.ordered_qty)" in candidates_lower,
        "candidate quantity",
    )
    assert_true("po.location_code" in candidates_lower, "candidate location code")
    assert_true("production_material_issues" in candidates_lower, "candidate has_issue")
    assert_true("pmi.is_current is true" in candidates_lower, "candidate current issue flag")
    assert_true("pmi.superseded_by_issue_id is null" in candidates_lower, "candidate superseded fallback")
    assert_true("limit 200" in candidates_lower, "candidates are capped at 200")
    assert_true(
        "order by production_date desc nulls last" in candidates_lower,
        "candidates must be newest first",
    )
    for field in (
        "'production_order_item_id'",
        "'production_number'",
        "'production_date'",
        "'sku_id'",
        "'sku_code'",
        "'product_name'",
        "'qty'",
        "'unit'",
        "'location_code'",
        "'has_issue'",
    ):
        assert_true(field in candidates_lower, f"candidate missing {field}")
    assert_true(
        "revoke all on function public.kho_trace_candidates(date, date) from public, anon" in lower
        and "grant execute on function public.kho_trace_candidates(date, date) to authenticated, service_role"
        in lower,
        "candidate grants",
    )

    # --- C. kho_trace_report -----------------------------------------------
    report = body_after(migration, "CREATE OR REPLACE FUNCTION public.kho_trace_report(")
    report_lower = report.lower()
    assert_true("p_production_order_item_id uuid" in report_lower, "report signature")
    assert_true("returns jsonb" in report_lower, "report must return jsonb")
    assert_true("stable" in report_lower, "report must be stable")
    assert_true("security definer" in report_lower, "report must be SECURITY DEFINER")
    assert_true("set search_path = public, pg_temp" in report_lower, "report search_path")
    assert_true(
        "public.q7_material_inventory_can_view(v_actor)" in report_lower
        and "public.stock_count_can_view('tan_tao')" in report_lower
        and "public.stock_count_can_view('q7')" in report_lower
        and "public.kho_item_can_edit(v_actor)" in report_lower
        and "public.has_module_permission(v_actor, 'production', 'view')" in report_lower,
        "report must use the kho view gate or production view",
    )
    assert_true("auth.role(), '') <> 'service_role'" in report_lower, "report service_role bypass")
    assert_true(
        "public.product_label_specs" in report_lower and "pls.shelf_life_days" in report_lower,
        "report shelf life must come from product_label_specs",
    )
    assert_true("v_production_date + v_shelf_life" in report_lower, "expiry date must be NSX + shelf life")
    assert_true('"hsd"' in report_lower, "missing HSD must be reported")
    assert_true("production_material_issues pmi" in report_lower, "report current material issue")
    assert_true(
        "pmi.is_current is true or pmi.superseded_by_issue_id is null" in report_lower,
        "report current issue condition",
    )
    assert_true("production_material_issue_items pii" in report_lower, "report issue items")
    assert_true(
        "pii.finished_sku_id = v_item.sku_id" in report_lower,
        "report must match issue items by finished SKU",
    )
    assert_true(
        "pii.production_order_item_id = v_item.id" in report_lower,
        "report must fall back to production order item",
    )
    assert_true(
        "public.kho_receipt_line_item(gri.id) = v_item_id" in report_lower,
        "report lots must use the receipt-line resolver",
    )
    assert_true("gr.receipt_date <= v_issue_date" in report_lower, "lots must precede the issue date")
    assert_true(
        "gr.status in ('confirmed', 'received')" in report_lower,
        "lots must come from real non-cancelled receipts",
    )
    assert_true("inventory_batches b" in report_lower and "batch_number" in report_lower, "lot batch fallback")
    assert_true(
        "coalesce(gri.manufacturer_id, v_default_manufacturer)" in report_lower,
        "manufacturer falls back to the item default",
    )
    assert_true("food_safety_certificates" in report_lower, "report certificates")
    assert_true("c.archived_at is null" in report_lower, "archived certificates must be excluded")
    assert_true(
        "c.expires_on is null or c.expires_on >= v_production_date" in report_lower,
        "expired certificates must be excluded",
    )
    assert_true("'company_certificates'" in report_lower, "company certificates are top-level")
    assert_true(
        "running_qty - running.quantity < v_required" in report_lower,
        "lots stop once required quantity is covered",
    )
    assert_true("limit 3" in report_lower, "at most three lots per material")
    for field in (
        "'product_name'",
        "'sku_code'",
        "'production_number'",
        "'production_date'",
        "'qty'",
        "'unit'",
        "'shelf_life_days'",
        "'expiry_date'",
        "'materials'",
        "'section'",
        "'required_qty'",
        "'lots'",
        "'missing'",
        "'certificates'",
        "'company_certificates'",
        "'semi_finished'",
    ):
        assert_true(field in report_lower, f"report missing {field}")
    for field in ('"lot"', '"manufacturer"', '"nsx"', '"hsd"', '"receipt"'):
        assert_true(field in report_lower, f"material missing flag {field}")
    assert_true("jsonb_array_length(v_lots) = 0" in report_lower, "report handles an empty lot list")
    assert_true("'lô bánh ủ'" in report_lower, "semi-finished bánh ủ row")
    assert_true("'vỏ bánh'" in report_lower, "semi-finished vỏ bánh row")
    assert_true("' ủ'" in report_lower, "bánh ủ lot suffix")
    assert_true(
        "upper(split_part(v_sku_code, '-', 1))" in report_lower
        and "to_char(v_production_date, 'ddmmyyyy')" in report_lower,
        "semi-finished lot code format",
    )
    assert_true(
        "greatest(v_item.actual_qty - v_item.ordered_qty, 0)" in report_lower,
        "semi-finished remaining quantity",
    )
    assert_true(
        "revoke all on function public.kho_trace_report(uuid) from public, anon" in lower
        and "grant execute on function public.kho_trace_report(uuid) to authenticated, service_role"
        in lower,
        "report grants",
    )

    # --- D. event constraint + reminder function ---------------------------
    for event in (
        "'assigned'",
        "'submitted'",
        "'approved'",
        "'returned'",
        "'due_soon'",
        "'overdue'",
        "'food_cert_expiry'",
    ):
        assert_true(event in lower, f"event constraint missing {event}")
    assert_true(
        "drop constraint if exists mission_zalo_notifications_event_type_check" in lower
        and "add constraint mission_zalo_notifications_event_type_check" in lower,
        "the event-type constraint must be extended",
    )

    reminder = body_after(
        migration,
        "CREATE OR REPLACE FUNCTION public.enqueue_food_cert_expiry_reminders(",
    )
    reminder_lower = reminder.lower()
    assert_true(
        "p_today date default (now() at time zone 'asia/ho_chi_minh')::date" in reminder_lower,
        "reminder default day must be Asia/Ho_Chi_Minh",
    )
    assert_true("returns integer" in reminder_lower, "reminder must return integer")
    assert_true("security definer" in reminder_lower, "reminder must be SECURITY DEFINER")
    assert_true("set search_path = public, pg_temp" in reminder_lower, "reminder search_path")
    assert_true(
        "auth.role(), '') <> 'service_role'" in reminder_lower
        and "public.has_role(v_actor, 'owner')" in reminder_lower,
        "reminder must be service_role or owner only",
    )
    assert_true(
        "c.archived_at is null" in reminder_lower and "c.expires_on is not null" in reminder_lower,
        "reminders must skip archived / no-expiry certificates",
    )
    assert_true("c.expires_on - p_today" in reminder_lower, "reminder day diff")
    assert_true("v_days_left > 30 or v_days_left < -1" in reminder_lower, "threshold window")
    assert_true(
        "when v_days_left <= 0 then 0" in reminder_lower
        and "when v_days_left <= 7 then 7" in reminder_lower
        and "else 30" in reminder_lower,
        "reminder thresholds 30/7/0",
    )
    assert_true(
        "'food-cert:'" in reminder_lower
        and "v_cert.id::text" in reminder_lower
        and "v_threshold::text" in reminder_lower
        and "v_cert.expires_on::text" in reminder_lower,
        "reminder dedupe key format",
    )
    assert_true("'food_cert_expiry'" in reminder_lower, "reminder event type")
    assert_true("'pending'" in reminder_lower, "reminder status")
    assert_true("on conflict (dedupe_key) do nothing" in reminder_lower, "reminder dedupe")
    for piece in (
        "Giấy ATTP sắp hết hạn",
        "Giấy ATTP hết hạn hôm nay",
        "Giấy chứng nhận cơ sở đủ điều kiện ATTP",
        "Phiếu kiểm nghiệm (COA)",
        "Bản công bố sản phẩm",
        "Giấy tờ khác",
        "https://ai.banhmique.vn/warehouse/ho-so-attp",
    ):
        assert_true(piece.lower() in reminder_lower, f"reminder message missing {piece}")
    assert_true("left(v_body, 4000)" in reminder_lower, "reminder body must stay under 4000 chars")
    assert_true("mission_zalo_notifications" in reminder_lower, "reminder uses the mission outbox")
    assert_true(
        "revoke all on function public.enqueue_food_cert_expiry_reminders(date) from public, anon"
        in lower,
        "reminder must be revoked from public/anon",
    )

    # --- D. cron schedule ---------------------------------------------------
    assert_true("food-cert-expiry-reminders-daily" in lower, "cron job name")
    assert_true("'0 1 * * *'" in lower, "cron must run at 01:00 UTC (08:00 ICT)")
    assert_true("cron.unschedule" in lower, "existing job must be unscheduled first")
    assert_true("cron.schedule" in lower, "cron.schedule call is required")
    assert_true(
        "select public.enqueue_food_cert_expiry_reminders()" in lower,
        "cron must call the reminder function",
    )

    # --- no stock/ledger writes -------------------------------------------
    for ledger_write in (
        "insert into public.inventory_movements",
        "update public.inventory_movements",
        "insert into public.q7_inventory_movements",
        "update public.q7_inventory_movements",
        "insert into public.tan_tao_material_movements",
        "update public.tan_tao_material_movements",
        "insert into public.stock_ledger_entries",
        "update public.stock_ledger_entries",
    ):
        assert_true(ledger_write not in lower, f"migration must not write {ledger_write}")

    print("test_kho_trace_contract: OK")


if __name__ == "__main__":
    main()
