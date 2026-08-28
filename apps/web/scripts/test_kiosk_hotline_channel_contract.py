#!/usr/bin/env python3
"""Contract checks for the kiosk Hotline revenue channel."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORTAL = ROOT / "src/pages/KioskReportPortal.tsx"
MANAGEMENT = ROOT / "src/pages/PointRevenueManagement.tsx"
LEDGER = ROOT / "supabase/functions/revenue-monthly-parse-preview/kiosk-point-revenue.ts"
MIGRATION = ROOT / "supabase/migrations/20260828100000_kiosk_report_hotline_revenue_channel.sql"


def read(path: Path) -> str:
    assert path.exists(), f"missing {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def test_hotline_channel_is_global_and_idempotently_seeded() -> None:
    sql = read(MIGRATION).lower()
    for token in (
        "insert into public.kiosk_report_channels",
        "'hotline'",
        "'hotline'",
        "display_order",
        "active",
        "on conflict (code) do update",
        "excluded.channel_name",
        "excluded.display_order",
        "excluded.active",
    ):
        assert token in sql, f"migration missing Hotline channel contract: {token}"
    assert "location_id" not in sql, "Hotline must be available at every real point, not pinned to one location"


def test_report_portal_records_actual_hotline_fulfilment_at_the_reporting_point() -> None:
    portal = read(PORTAL)
    for token in (
        '{ code: "hotline", channel_name: "Hotline" }',
        'const hotlineChannel = row.channel_code === "hotline";',
        'label={hotlineChannel ? "Thực thu" : "Thành tiền"}',
        'placeholder="Mã đơn / lý do giảm giá"',
        'updateChannelRow(row.channel_code, "notes", event.target.value)',
        'Hotline: nhập số bánh điểm này thực xuất và số tiền thực thu sau giảm giá.',
        'if (code === "hotline")',
        '<Phone className="h-5 w-5"',
    ):
        assert token in portal, f"portal missing Hotline behavior: {token}"


def test_management_and_ledger_preserve_actual_received_amount() -> None:
    management = read(MANAGEMENT)
    ledger = read(LEDGER)
    assert 'const isHotline = channel.channel_code.trim().toLowerCase() === "hotline";' in management
    assert "Thực thu sau giảm giá; ghi mã đơn và lý do giảm ở Ghi chú" in management
    for token in (
        '"hotline"',
        'KIOSK_HOTLINE_REVENUE_RULE',
        'channelCode === "hotline"',
        'numericAmountVnd(channelRow.amount_vnd)',
        'actual_received_after_discount',
    ):
        assert token in ledger, f"ledger missing Hotline actual-revenue contract: {token}"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
