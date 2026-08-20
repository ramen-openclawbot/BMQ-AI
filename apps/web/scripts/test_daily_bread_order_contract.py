from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260811120000_daily_bread_order_zalo_tuyet_anh.sql"
VIETJET_FIX_MIGRATION = ROOT / "supabase/migrations/20260811123000_fix_vietjet_bread_quantity.sql"
VEHICLE_HISTORY_MIGRATION = ROOT / "supabase/migrations/20260811130000_daily_bread_vehicle_history.sql"
WORKER = ROOT / "supabase/functions/dealer-warehouse-notify/index.ts"
HELPER = ROOT / "supabase/functions/_shared/daily-bread-order.ts"


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


def test_worker_routes_only_named_supplier_jobs_to_tuyet_anh():
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
        'extra_supplier_included: false',
        'extra_handling: "warehouse_bread_stock_and_point_pate_stock"',
        "supplier_order_quantity: dealerOrderedQuantity",
        "physical_quantity: dealerOrderedQuantity + dealerExtraQuantity",
    ]
    for marker in required:
        assert marker in source
    assert "dealerOrderedQuantity + vehicleForecast.totalQuantity" in source
    assert "dealerOrderedQuantity + dealerExtraQuantity + vehicleForecast.totalQuantity" not in source


def test_forecast_contract_is_explainable_and_has_no_sample_constants():
    source = HELPER.read_text(encoding="utf-8")
    assert "peak-7d-plus-10pct-minus-closing-round10-lunar-off-v2" in source
    assert "lunar_day_30_monthly_off" in source
    assert 'new LunarDate(Number(year), Number(month), Number(day)).date' in source
    assert "1600" not in source
    assert "600" not in source
    assert "2300" not in source
