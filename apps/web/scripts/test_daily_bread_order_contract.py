from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260811120000_daily_bread_order_zalo_tuyet_anh.sql"
VIETJET_FIX_MIGRATION = ROOT / "supabase/migrations/20260811123000_fix_vietjet_bread_quantity.sql"
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


def test_worker_routes_only_named_supplier_jobs_to_tuyet_anh():
    source = WORKER.read_text(encoding="utf-8")
    required = [
        'from "../_shared/daily-bread-order.ts"',
        "enqueueDailyBreadOrder",
        'Deno.env.get("ZALO_GMF_TUYET_ANH_GROUP_ID")',
        'job.group_name === "BMQ - HKD Tuyết Anh"',
        'supabase.rpc("upsert_daily_bread_order_notification"',
    ]
    for marker in required:
        assert marker in source


def test_forecast_contract_is_explainable_and_has_no_sample_constants():
    source = HELPER.read_text(encoding="utf-8")
    assert "peak-7d-plus-10pct-minus-closing-round10-v1" in source
    assert "1600" not in source
    assert "600" not in source
    assert "2300" not in source
