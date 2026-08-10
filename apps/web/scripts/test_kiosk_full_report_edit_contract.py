#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
PAGE = ROOT / "src" / "pages" / "PointRevenueManagement.tsx"


def read(path: Path) -> str:
    assert path.exists(), f"missing {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def main() -> None:
    migrations = sorted(MIGRATIONS.glob("*kiosk_full_report_authorized_edit*.sql"))
    assert len(migrations) == 4, "expected four parser-safe authorized full-report edit migrations"
    sql = "\n".join(read(path) for path in migrations).lower()

    for token in (
        "get_kiosk_point_report_detail",
        "save_kiosk_point_report_correction",
        "security definer",
        "set search_path = public",
        "has_module_permission(v_actor, 'finance_revenue', 'edit')",
        "for update",
        "jsonb_array_elements",
        "invalid_kiosk_report_inventory_rows",
        "invalid_kiosk_report_channel_rows",
        "khach_le",
        "12000",
        "opening_source_report_id",
        "opening_reconciliation_required",
        "kiosk_point_revenue_audit_logs",
        "'edit_report'",
        "set_config('app.kiosk_report_authorized_edit'",
        "revoke all",
        "grant execute",
    ):
        assert token in sql, f"migration missing full-edit contract: {token}"

    assert "insert into public.revenue_ledger_lines" not in sql
    assert "disable trigger" not in sql

    page = read(PAGE)
    for token in (
        'canEditModule("finance_revenue")',
        'get_kiosk_point_report_detail',
        'save_kiosk_point_report_correction',
        'data-testid="point-report-inventory-editor"',
        'data-testid="point-report-channel-editor"',
        'const inventoryNumberFormatter = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 })',
        'formatInventoryQuantity(row.closing_quantity)',
        'Lý do chỉnh sửa',
        'Sửa toàn bộ phiếu',
        'Khách lẻ tự tính 12.000đ × số lượng',
    ):
        assert token in page, f"page missing full-edit behavior: {token}"

    print("PASS kiosk full report authorized edit contract")


if __name__ == "__main__":
    main()
