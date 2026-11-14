from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "supabase/functions/dealer-warehouse-notify/index.ts"
VERCEL = ROOT / "vercel.json"
VIETJET_CRON = ROOT / "api/vietjet-order-parser-cron.js"


def test_worker_keeps_the_normal_evening_delivery_window():
    source = WORKER.read_text(encoding="utf-8")
    assert "if (!isWarehouseNotificationWindow(now))" in source
    assert "x-force-delivery" not in source


def test_vietjet_order_parser_has_a_separate_22_vietnam_cron():
    vercel = VERCEL.read_text(encoding="utf-8")
    cron = VIETJET_CRON.read_text(encoding="utf-8")
    assert '"/api/vietjet-order-parser-cron"' in vercel
    assert '"schedule": "0 15 * * *"' in vercel
    assert "revenue-monthly-parse-preview" not in cron
    assert "po-gmail-sync" in cron
    assert "from:(vietjetair.com)" in cron
    assert 'mode: "import"' in cron
    assert "VIETJET_ORDER_CRON_SECRET" in cron
    assert "REVENUE_CRON_SECRET" not in cron
    assert "PO_SYNC_CRON_SECRET" not in cron
    assert '"x-vietjet-order-secret": poSyncSecret' in cron


def test_missing_vietjet_mail_never_blocks_supplier_order_and_records_zero():
    # Owner decision 2026-11-14: no VietJet mail for the service date means quantity 0, not a blocked order.
    source = WORKER.read_text(encoding="utf-8")
    assert 'throw new Error("VietJet order parser is not ready for target service date")' not in source
    assert "vietjetRow?.inbox_id" in source
    assert "vietjetRow?.received_at" in source
    assert "const vietjetMissing" in source
    assert "quantity: vietjetMissing ? 0" in source
    assert "missing_for_service_date: vietjet.missing" in source
