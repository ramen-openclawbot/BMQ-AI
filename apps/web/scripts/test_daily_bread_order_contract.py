from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260811120000_daily_bread_order_zalo_tuyet_anh.sql"
VIETJET_FIX_MIGRATION = ROOT / "supabase/migrations/20260811123000_fix_vietjet_bread_quantity.sql"
VEHICLE_HISTORY_MIGRATION = ROOT / "supabase/migrations/20260811130000_daily_bread_vehicle_history.sql"
WORKER = ROOT / "supabase/functions/dealer-warehouse-notify/index.ts"
HELPER = ROOT / "supabase/functions/_shared/daily-bread-order.ts"
SUPPLIER_CREDIT_MIGRATION = ROOT / "supabase/migrations/20260824100000_bread_exchange_makeup_supplier_credit.sql"


def test_daily_bread_order_migration_contract():
    sql = MIGRATION.read_text(encoding="utf-8")
    required = [
        "production_bread_order",
        "source_snapshot",
        "upsert_daily_bread_order_notification",
        "get_latest_vietjet_bread_quantity",
        "jsonb_array_elements",
        "BMQ - HKD Tuyết Anh",
        "auth.role() is distinct from 'service_role'",
        "on conflict (digest_date, channel, notification_type)",
    ]
    for marker in required:
        assert marker in sql
    assert "grant execute on function public.upsert_daily_bread_order_notification" in sql
    assert "to service_role" in sql
    assert "to anon" not in sql.split("grant execute on function public.upsert_daily_bread_order_notification", 1)[1]


def test_vietjet_fix_uses_postgres_safe_numeric_regex():
    sql = VIETJET_FIX_MIGRATION.read_text(encoding="utf-8")
    assert "^[0-9]+([.][0-9]+)?$" in sql
    assert "\\\\d" not in sql
    assert "jsonb_typeof(inbox.production_items) = 'array'" in sql


def test_vehicle_history_is_per_location_service_only_and_unbounded_by_global_limit():
    sql = VEHICLE_HISTORY_MIGRATION.read_text(encoding="utf-8")
    required = [
        "get_daily_bread_vehicle_history",
        "partition by report.location_id",
        "report.report_rank <= 7",
        "inventory.product_code = 'banh_mi_que'",
        "auth.role() is distinct from 'service_role'",
        "to service_role",
    ]
    for marker in required:
        assert marker in sql

    source = WORKER.read_text(encoding="utf-8")
    assert '"get_daily_bread_vehicle_history"' in source
    assert '.limit(500)' not in source


def test_worker_routes_all_dealer_exchange_and_makeup_to_tuyet_anh():
    source = WORKER.read_text(encoding="utf-8")
    required = [
        'from "../_shared/daily-bread-order.ts"',
        "enqueueDailyBreadOrder",
        'Deno.env.get("ZALO_GMF_TUYET_ANH_GROUP_ID")',
        'job.group_name === "BMQ - HKD Tuyết Anh"',
        'supabase.rpc("upsert_daily_bread_order_notification"',
        'rule: "ceil-to-multiple-20-pate-batch-v1"',
        "batch_size: 20",
        "pate_boxes: roundedTotalBmq / 20",
        "raw_quantity: rawTotalBmq",
        "sent_quantity: roundedTotalBmq",
        "raw_quantity: vietjet.quantity",
        "sent_quantity: roundedVietjet",
        'extra_supplier_included: true',
        'extra_handling: "ordered_from_supplier_and_credited_to_bakery_payable"',
        "supplier_order_quantity: dealerOrderedQuantity + dealerExchangeQuantity + dealerMakeupQuantity",
        "supplier_credit_quantity: supplierCreditQuantity",
        "supplier_billable_quantity: supplierBillableQuantity",
        "physical_quantity: dealerOrderedQuantity + dealerExchangeQuantity + dealerMakeupQuantity",
        "vehicleExchangeQuantity",
        "vehicleMakeupQuantity",
        "vehicle_credit_quantity: vehicleExtraQuantity",
    ]
    for marker in required:
        assert marker in source
    assert "+ vehicleForecast.totalQuantity + vehicleExtraQuantity" in source


def test_tan_tao_supplier_document_preserves_physical_billable_and_credit_quantities():
    sql = SUPPLIER_CREDIT_MIGRATION.read_text(encoding="utf-8")
    required = [
        "supplier_billable_quantity",
        "supplier_credit_quantity",
        "supplier_exchange_quantity",
        "supplier_makeup_quantity",
        "ordered_from_supplier_and_credited_to_bakery_payable",
        "source_snapshot #>> '{supplier,billable_quantity}'",
        "source_snapshot #>> '{supplier,credit_quantity}'",
    ]
    for marker in required:
        assert marker in sql
    for correction_marker in [
        "create or replace function public.queue_late_kiosk_bread_order_corrections",
        "v_dealer_exchange",
        "v_dealer_makeup",
        "v_supplier_billable",
        "'Tổng BMQ giao: '",
        "'Khấu trừ công nợ lò: '",
        "'Lò tính tiền: '",
        "'ordered_from_supplier_and_credited_to_bakery_payable'",
    ]:
        assert correction_marker in sql
    assert " / 20) * 20" in sql
    assert "dùng tồn nội bộ" not in sql


def test_forecast_contract_is_explainable_and_has_no_sample_constants():
    source = HELPER.read_text(encoding="utf-8")
    assert "peak-7d-plus-10pct-minus-closing-smart-round20-lunar-off-v3" in source
    assert "PATE_BATCH_SIZE = 20" in source
    assert "round_up_to_prevent_peak_stockout" in source
    assert "round_down_existing_stock_buffer" in source
    assert "round_up_to_preserve_low_stock_safety" in source
    assert "lunar_day_30_monthly_off" in source
    assert 'new LunarDate(Number(year), Number(month), Number(day)).date' in source
    assert "1600" not in source
    assert "600" not in source
    assert "2300" not in source
