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
    item_guard = submit.index("if (itemError)")
    enqueue = submit.index('from("dealer_order_notifications")')
    assert enqueue > item_guard, "notification must be queued only after item insert succeeds"
    assert "formatWarehouseOrderMessage" in submit
    assert 'channel: "zalo_gmf"' in submit
    assert 'group_name: "BMQ - Kho Tân Tạo"' in submit
    assert "unit_price_vnd" not in submit[enqueue:], "notification path must not include prices"
    assert 'functions.invoke("dealer-warehouse-notify"' not in submit, (
        "order submission must queue only; the Vietnam evening cron owns delivery"
    )


def test_worker_and_cron_enforce_vietnam_evening_schedule() -> None:
    worker = WORKER.read_text(encoding="utf-8")
    sql = SCHEDULE_MIGRATION.read_text(encoding="utf-8")
    assert 'isWarehouseNotificationWindow(new Date())' in worker
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
        '"📦 ĐƠN HÀNG MỚI TỪ DATHANG.BANHMIQUE.VN"',
        'Thời gian đặt: ${formatSubmittedAt(input.submittedAt)}',
        'return `${day}/${month}/${year} ${hour}:${minute}`;',
        'Ngày giao: ${formatDeliveryDate(input.requestedDeliveryDate, input.submittedAt)}',
        '➜ Kho cần giao: ${formatQuantity(line.physicalQuantity)} ${unit}',
        '"━━━━━━━━━━━━━━"',
        '"📊 TỔNG ĐƠN"',
        '• Đặt mới: ${formatQuantity(totals.ordered)} ${totalUnit}',
        '✅ TỔNG KHO CẦN GIAO: ${formatQuantity(totals.physical)} ${totalUnit}',
        '"Nguồn: dathang.banhmique.vn"',
    ]:
        assert needle in helper, f"missing approved message marker: {needle}"
    assert "submittedAt: order.submitted_at" in submit
    assert "defaultDeliveryDateTPlusOne" in submit
    assert "requested_delivery_date: requestedDeliveryDate" in submit


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
