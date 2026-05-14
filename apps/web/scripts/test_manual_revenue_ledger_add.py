#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
UI = ROOT / "src" / "pages" / "RevenueSourceDetail.tsx"


def latest_manual_revenue_migration() -> str:
    files = sorted(MIGRATIONS.glob("*_manual_revenue_ledger_line.sql"))
    assert files, "missing manual revenue ledger migration"
    return files[-1].read_text(encoding="utf-8")


def test_manual_revenue_rpc_is_audited_and_permissioned() -> None:
    sql = latest_manual_revenue_migration()
    required = [
        "create or replace function public.add_manual_revenue_ledger_line",
        "security definer",
        "public.has_module_permission(_actor_id, 'finance_revenue', 'edit')",
        "not public.has_role(_actor_id, 'staff')",
        "audit_note_required",
        "manual_entry_type",
        "missing_po_email",
        "staff_forgot_po_email",
        "source_type, period, checksum",
        "revenue_ledger_line_audit_logs",
        "add_manual",
        "revoke all on function public.add_manual_revenue_ledger_line(jsonb, text) from public",
        "revoke all on function public.add_manual_revenue_ledger_line(jsonb, text) from anon",
        "grant execute on function public.add_manual_revenue_ledger_line(jsonb, text) to authenticated",
    ]
    for needle in required:
        if needle == "not public.has_role(_actor_id, 'staff')":
            assert "public.has_role(_actor_id, 'staff')" not in sql, "staff role alone must not be enough for manual revenue RPC"
            continue
        assert needle in sql, f"missing SQL marker: {needle}"
    assert "extra_raw_payload" not in sql, "caller-supplied extra_raw_payload must not override audit metadata"


def test_manual_revenue_ui_has_required_staff_flow() -> None:
    text = UI.read_text(encoding="utf-8")
    required = [
        "add_manual_revenue_ledger_line",
        "+ Thêm dòng doanh thu",
        "Thiếu PO/email",
        "Thêm vào Doanh thu đã kiểm soát",
        "Bổ sung doanh thu thủ công từ vận hành",
        "evidence_note: autoNote",
        "duplicateWarnings",
        "MANUAL_REVENUE_CHANNELS",
        "manualChannelOptions",
        "fetchManualRevenueCustomers",
        "Chọn kênh",
        "Chọn khách hàng/đại lý",
        "Vui lòng chọn khách hàng/đại lý từ CRM",
        "manual_entry_type",
        "staff_forgot_po_email",
    ]
    for needle in required:
        assert needle in text, f"missing UI marker: {needle}"

    removed_visible_fields = [
        "Nguồn xác nhận / evidence",
        "Lý do / audit note",
        "Link ảnh/tài liệu nếu có",
        "Sau khi lưu: source_type = manual_entry",
        "Dòng này sẽ vào Doanh thu đã kiểm soát",
    ]
    for needle in removed_visible_fields:
        assert needle not in text, f"manual add UI should not show operational clutter: {needle}"


if __name__ == "__main__":
    test_manual_revenue_rpc_is_audited_and_permissioned()
    test_manual_revenue_ui_has_required_staff_flow()
    print("manual revenue ledger add checks passed")
