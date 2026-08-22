from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
WORKER = ROOT / "supabase" / "functions" / "dealer-warehouse-notify" / "index.ts"
HELPER = ROOT / "supabase" / "functions" / "_shared" / "daily-bread-order.ts"
HELPER_TEST = ROOT / "supabase" / "functions" / "_shared" / "daily-bread-order.test.ts"
POINT_REVENUE = ROOT / "src" / "pages" / "PointRevenueManagement.tsx"

NEW_MIGRATION = MIGRATIONS / "20260820090000_late_kiosk_bread_correction_queue.sql"

def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")

def assert_contains(source: str, needle: str, label: str) -> None:
    assert needle in source, f"missing {label}: {needle}"


def test_late_bread_correction_migration_contract() -> None:
    sql = read(NEW_MIGRATION).lower()
    required = [
        "production_bread_order_correction",
        "queue_late_kiosk_bread_order_corrections",
        "pending_kiosk_bread_recompute",
        "report_id",
        "report_updated_at",
        "original_supplier_notification_id",
        "original_warehouse_notification_id",
        "correction_audit_id",
        "idempotency_key",
        "auth.role() is distinct from 'service_role'",
        "full replacement",
        "banh_mi_que",
        "đl:",
        "xe:",
        "tổng bmq:",
        "viet jet:",
        "kho cần giao",
        "approved_by_owner",
        "pending_owner_review",
        "approve_late_kiosk_bread_order_corrections",
        "grant execute on function public.queue_late_kiosk_bread_order_corrections",
        "to service_role",
        "revoke all on function public.queue_late_kiosk_bread_order_corrections",
        "from public, anon, authenticated",
    ]
    for marker in required:
        assert_contains(sql, marker, marker)
    assert "Bùi Hữu Nghĩa" not in sql
    grant_lines = [line for line in sql.splitlines() if line.startswith("grant execute on function public.queue_late_kiosk_bread_order_corrections")]
    assert grant_lines == ["grant execute on function public.queue_late_kiosk_bread_order_corrections(uuid, uuid) to service_role;"]


def test_correction_rpc_derives_bread_sold_from_channels_and_requires_specific_reason() -> None:
    sql = read(NEW_MIGRATION).lower()
    save_section = sql.split("create or replace function public.save_kiosk_point_report_correction", 1)[1]
    assert "v_breadstick_sold" in save_section
    assert "from jsonb_array_elements(p_channel_rows)" in save_section
    assert "sum((input" in save_section and "->>'quantity')::numeric" in save_section
    assert "target.product_code = 'banh_mi_que' then v_breadstick_sold" in save_section
    assert "đã kiểm" in save_section
    assert "length(v_reason) < 10" in save_section
    assert "queue_late_kiosk_bread_order_corrections" in save_section


def test_future_automatic_snapshots_persist_report_identity_and_revision() -> None:
    worker = read(WORKER)
    for marker in [
        "reportId: row.report_id",
        "reportUpdatedAt: row.report_updated_at",
        "latestReportSource",
        "report_id,location_id,location_code,report_date,updated_at,sold_quantity,closing_quantity",
        "source_report: forecast.latestReportSource",
    ]:
        assert_contains(worker, marker, marker)


def test_correction_message_helpers_have_full_replacement_wording_contracts() -> None:
    helper = read(HELPER)
    helper_test = read(HELPER_TEST)
    for marker in [
        "buildDailyBreadOrderCorrectionMessage",
        "buildWarehouseKioskBreadDispatchCorrectionMessage",
        "THAY THẾ TOÀN BỘ",
        "Chênh lệch điểm bị sửa",
        "Tổng đúng sau chỉnh sửa",
    ]:
        assert_contains(helper, marker, marker)
    for marker in [
        "formats supplier correction as full replacement with corrected totals",
        "formats warehouse correction as full replacement with affected point adjustment",
    ]:
        assert_contains(helper_test, marker, marker)


def test_point_revenue_ui_keeps_bread_sold_readonly_derived_and_rejects_generic_reasons() -> None:
    source = read(POINT_REVENUE)
    for marker in [
        "const breadstickSoldQuantity = Object.values(quantities).reduce",
        "field.key === \"sold_quantity\" && row.product_code === \"banh_mi_que\"",
        "Bánh bán tự tính từ tổng các kênh",
        "isSpecificCorrectionReason",
        "Đã kiểm",
        "trimmed.length >= 10",
        "disabled={saving || !isSpecificCorrectionReason(reason)}",
    ]:
        assert_contains(source, marker, marker)


def test_no_production_send_or_sent_row_mutation_in_correction_queue() -> None:
    sql = read(NEW_MIGRATION).lower()
    queue_section = sql.split("create or replace function public.queue_late_kiosk_bread_order_corrections", 1)[1]
    queue_section = queue_section.split("create or replace function public.approve_late_kiosk_bread_order_corrections", 1)[0]
    assert "'pending_owner_review'" in queue_section
    assert "'pending', 0, 1" not in queue_section
    assert "set status = 'sent'" not in sql
    assert "set sent_at" not in sql
    assert "set message_id" not in sql
    assert not re.search(r"update\s+public\.dealer_order_notifications[\s\S]{0,300}notification_type\s*=\s*'production_bread_order_correction'", queue_section)


def test_queue_recomputes_peak_history_and_full_warehouse_totals() -> None:
    sql = read(NEW_MIGRATION).lower()
    queue_section = sql.split("create or replace function public.queue_late_kiosk_bread_order_corrections", 1)[1]
    queue_section = queue_section.split("create or replace function public.approve_late_kiosk_bread_order_corrections", 1)[0]
    for marker in [
        "report_rank <= 7",
        "max(sold_quantity)",
        "latest_closing_quantity",
        "corrected_locations",
        "corrected_supplier_locations",
        "recommendedquantity",
        "jsonb_array_elements",
        "total_makeup",
        "total_exchange",
        "total_physical",
        "physical_quantity",
    ]:
        assert_contains(queue_section, marker, marker)


def test_only_bread_impacting_edits_queue_recompute() -> None:
    sql = read(NEW_MIGRATION).lower()
    save_section = sql.split("create or replace function public.save_kiosk_point_report_correction", 1)[1]
    for marker in [
        "v_before_bread",
        "v_after_bread",
        "v_before_bread is distinct from v_after_bread",
        "jsonb_array_elements_text(v_cascade_ids)",
        "queue_late_kiosk_bread_order_corrections(v_cascade_report_id",
    ]:
        assert_contains(save_section, marker, marker)
