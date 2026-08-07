#!/usr/bin/env python3
"""Static integration contract for dealer-order warehouse Zalo notifications."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"
SUBMIT = ROOT / "supabase/functions/dealer-order-submit/index.ts"
WORKER = ROOT / "supabase/functions/dealer-warehouse-notify/index.ts"
HELPER = ROOT / "supabase/functions/_shared/dealer-warehouse-notification.ts"
CONFIG = ROOT / "supabase/config.toml"
SCHEDULE_MIGRATION = ROOT / "supabase/migrations/20260803181500_dealer_warehouse_vietnam_evening_schedule.sql"
DAILY_DIGEST_MIGRATION = ROOT / "supabase/migrations/20260805170000_dealer_warehouse_daily_digest.sql"
POINT_DIGEST_PAUSE_MIGRATION = ROOT / "supabase/migrations/20260807005000_pause_warehouse_point_digest.sql"
DUPLICATE_GUARD_MIGRATION = ROOT / "supabase/migrations/20260806224000_dealer_duplicate_order_guard.sql"


def migration_text() -> str:
    matches = sorted(MIGRATIONS.glob("*_dealer_order_zalo_warehouse_notifications.sql"))
    assert len(matches) == 1, "expected one warehouse notification migration"
    return matches[0].read_text(encoding="utf-8")


def test_outbox_is_private_idempotent_and_retryable() -> None:
    sql = migration_text()
    for needle in [
        "create table if not exists public.dealer_order_notifications",
        "unique (order_id, channel)",
        "attempt_count integer not null default 0",
        "next_attempt_at timestamptz",
        "message_id text",
        "alter table public.dealer_order_notifications enable row level security",
        "revoke all on function public.claim_dealer_order_notifications(integer) from public",
        "revoke all on function public.claim_dealer_order_notifications(integer) from anon",
        "grant execute on function public.claim_dealer_order_notifications(integer) to service_role",
        "for update skip locked",
        "create table if not exists public.dealer_notification_worker_config",
        "worker_secret uuid not null default gen_random_uuid()",
        "zalo_access_token text",
        "zalo_refresh_token text",
        "zalo_access_token_expires_at timestamptz",
        "zalo_refresh_lock_id uuid",
        "zalo_refresh_locked_at timestamptz",
        "create or replace function public.claim_zalo_oauth_refresh_lock",
        "create or replace function public.release_zalo_oauth_refresh_lock",
        "alter table public.dealer_notification_worker_config enable row level security",
        "revoke all on table public.dealer_notification_worker_config from public, anon, authenticated",
        "revoke all on table public.dealer_order_notifications from public, anon, authenticated",
        "grant select, update on table public.dealer_notification_worker_config to service_role",
        "grant select, insert, update on table public.dealer_order_notifications to service_role",
        "cron.schedule(",
        "net.http_post(",
        "x-worker-secret",
        "*/2 * * * *",
    ]:
        assert needle in sql, f"missing outbox contract: {needle}"


def test_submit_queues_only_after_order_items_are_saved() -> None:
    submit = SUBMIT.read_text(encoding="utf-8")
    guard_sql = DUPLICATE_GUARD_MIGRATION.read_text(encoding="utf-8")
    item_insert = guard_sql.index("insert into public.dealer_order_items")
    enqueue = guard_sql.index("insert into public.dealer_order_notifications")
    assert enqueue > item_insert, "atomic RPC must save items before queueing notification"
    assert "submit_dealer_order_guarded" in submit
    assert "formatWarehouseOrderMessage" in submit
    assert "'zalo_gmf'" in guard_sql
    assert "'BMQ - Kho Tân Tạo'" in guard_sql
    assert "unit_price_vnd" not in guard_sql[enqueue:], "notification path must not include prices"
    assert 'functions.invoke("dealer-warehouse-notify"' not in submit, (
        "order submission must queue only; the Vietnam evening cron owns delivery"
    )


def test_worker_and_cron_enforce_vietnam_evening_schedule() -> None:
    worker = WORKER.read_text(encoding="utf-8")
    sql = SCHEDULE_MIGRATION.read_text(encoding="utf-8")
    assert "const now = new Date();" in worker
    assert "isWarehouseNotificationWindow(now)" in worker
    assert 'reason: "outside_vietnam_evening_window"' in worker
    assert "dealer-warehouse-notify-every-2-minutes" in sql
    assert "dealer-warehouse-notify-vn-20-22-30" in sql
    assert "dealer-warehouse-notify-vn-23-final" in sql
    assert "'0,30 13-15 * * *'" in sql
    assert "'0,30,59 16 * * *'" in sql
    assert "Asia/Ho_Chi_Minh" in sql


def test_warehouse_message_uses_approved_operations_layout() -> None:
    helper = HELPER.read_text(encoding="utf-8")
    submit = SUBMIT.read_text(encoding="utf-8")
    for needle in [
        "submittedAt: string",
        '"📦 ĐƠN BÁNH ĐẠI LÝ MỚI"',
        'Đơn vị đặt: ${input.customerName}',
        'return `${day}/${month}/${year} ${hour}:${minute}`;',
        'Ngày giao: ${formatDeliveryDate(input.requestedDeliveryDate, input.submittedAt)}',
        '→ GIAO ${formatQuantity(line.physicalQuantity)} ${unit}',
        '"📊 TỔNG KHO"',
        'Đặt mới: ${formatQuantity(totals.ordered)} ${totalUnit}',
        '✅ KHO CẦN GIAO: ${formatQuantity(totals.physical)} ${totalUnit.toUpperCase()}',
        '"Nguồn: dathang.banhmique.vn"',
    ]:
        assert needle in helper, f"missing approved message marker: {needle}"
    assert "submittedAt," in submit
    assert "p_submitted_at: submittedAt" in submit
    assert "defaultDeliveryDateTPlusOne" in submit
    assert "p_requested_delivery_date: requestedDeliveryDate" in submit


def test_daily_digest_is_idempotent_private_and_created_only_at_final_scan() -> None:
    helper = HELPER.read_text(encoding="utf-8")
    worker = WORKER.read_text(encoding="utf-8")
    sql = DAILY_DIGEST_MIGRATION.read_text(encoding="utf-8")
    for needle in [
        "formatWarehouseDealerDailyDigest",
        "formatWarehousePointDailyDigest",
        "TỔNG KẾT THEO ĐẠI LÝ — CUỐI NGÀY",
        "TỔNG KẾT THEO ĐIỂM BÁN — CUỐI NGÀY",
        "isWarehouseDailyDigestTime(now)",
        '"daily_dealer_digest"',
        '"daily_point_digest"',
        "upsert_dealer_warehouse_daily_digests",
    ]:
        assert needle in helper or needle in worker or needle in sql, f"missing two-digest runtime marker: {needle}"
    assert "Chú Đạm" not in helper
    assert "Chú Đạm" not in worker
    for needle in [
        "alter column order_id drop not null",
        "notification_type text not null default 'order'",
        "digest_date date",
        "dealer_order_notifications_daily_digest_unique_idx",
        "notification_type in ('daily_dealer_digest', 'daily_point_digest')",
        "on conflict (digest_date, channel, notification_type)",
        "n.status = 'processing'",
        "interval '15 minutes'",
        "for update skip locked",
        "revoke all on function public.upsert_dealer_warehouse_daily_digests(date, text, text) from public",
        "grant execute on function public.upsert_dealer_warehouse_daily_digests(date, text, text) to service_role",
    ]:
        assert needle in sql, f"missing daily digest database contract: {needle}"


def test_point_digest_is_paused_without_stopping_dealer_digest_or_kiosk_collection() -> None:
    sql = POINT_DIGEST_PAUSE_MIGRATION.read_text(encoding="utf-8")
    for needle in [
        "daily_point_digest_enabled boolean not null default false",
        "coalesce(daily_point_digest_enabled, false)",
        "'daily_dealer_digest'",
        "'daily_point_digest'",
        "where v_point_digest_enabled",
        "status = 'failed'",
        "paused_for_kiosk_inventory_learning",
        "status in ('pending', 'processing')",
        "grant execute on function public.upsert_dealer_warehouse_daily_digests(date, text, text) to service_role",
    ]:
        assert needle in sql, f"missing point-digest pause contract: {needle}"
    assert "delete from public.kiosk_daily_reports" not in sql.lower()
    assert "update public.kiosk_daily_reports" not in sql.lower()


def test_retry_worker_is_server_only_and_uses_claim_rpc() -> None:
    worker = WORKER.read_text(encoding="utf-8")
    helper = HELPER.read_text(encoding="utf-8")
    config = CONFIG.read_text(encoding="utf-8")
    assert helper.count("AbortSignal.timeout(20_000)") == 2
    assert "for (let attempt = 0; attempt < 3; attempt += 1)" in worker
    for needle in [
        'Deno.env.get("CRON_SECRET")',
        'req.headers.get("x-worker-secret")',
        'from("dealer_notification_worker_config")',
        "timingSafeEqual",
        'Deno.env.get("ZALO_OA_ACCESS_TOKEN")',
        'Deno.env.get("ZALO_OA_APP_ID")',
        'Deno.env.get("ZALO_OA_APP_SECRET")',
        'Deno.env.get("ZALO_OA_REFRESH_TOKEN")',
        "refreshZaloOaAccessToken",
        "claim_zalo_oauth_refresh_lock",
        "release_zalo_oauth_refresh_lock",
        "crypto.randomUUID()",
        'Deno.env.get("ZALO_GMF_WAREHOUSE_GROUP_ID")',
        'rpc("claim_dealer_order_notifications"',
        "sendZaloGmfText",
        'status: "sent"',
        'status: exhausted ? "failed" : "pending"',
    ]:
        assert needle in worker, f"missing retry worker contract: {needle}"
    assert "[functions.dealer-warehouse-notify]" in config
    assert "verify_jwt = false" in config.split("[functions.dealer-warehouse-notify]", 1)[1]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
