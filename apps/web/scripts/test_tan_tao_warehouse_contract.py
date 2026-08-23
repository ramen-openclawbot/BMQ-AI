#!/usr/bin/env python3
"""Static contracts for the chat-first Kho Tân Tạo MVP."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260823090000_tan_tao_ai_warehouse.sql"
PAGE = ROOT / "src/pages/TanTaoWarehouse.tsx"
PARSER = ROOT / "src/lib/tan-tao-warehouse.ts"
ROUTES = ROOT / "src/components/AppRoutes.tsx"
SIDEBAR = ROOT / "src/components/layout/Sidebar.tsx"
LANGUAGE = ROOT / "src/contexts/LanguageContext.tsx"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def test_schema_is_location_scoped_append_only_and_bmq001_first() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "warehouse_tan_tao",
        "bmq-001",
        "create table if not exists public.tan_tao_warehouse_documents",
        "create table if not exists public.tan_tao_warehouse_movements",
        "create table if not exists public.tan_tao_warehouse_reservations",
        "quantity numeric not null",
        "idempotency_key text not null",
        "unique (idempotency_key)",
        "movement_type in ('opening', 'receipt', 'dispatch', 'adjustment')",
        "status in ('active', 'released', 'dispatched', 'cancelled')",
    ]:
        assert needle in sql, f"Missing warehouse ledger contract: {needle}"
    assert "update public.tan_tao_warehouse_movements" not in sql
    assert "delete from public.tan_tao_warehouse_movements" not in sql


def test_snapshot_separates_on_hand_reserved_atp_and_incoming() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "get_tan_tao_warehouse_snapshot",
        "on_hand_quantity",
        "reserved_quantity",
        "atp_quantity",
        "incoming_quantity",
        "on_hand_quantity - reserved_quantity",
    ]:
        assert needle in sql, f"Missing stock snapshot contract: {needle}"


def test_command_rpc_keeps_expected_and_actual_events_distinct() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "execute_tan_tao_warehouse_command",
        "p_command_type",
        "supplier_order",
        "receipt",
        "outbound_order",
        "dispatch",
        "stock_count",
        "physical_quantity := ordered_quantity + exchange_quantity + makeup_quantity",
        "pg_advisory_xact_lock",
    ]:
        assert needle in sql, f"Missing command transition contract: {needle}"
    assert "supplier_order" in sql and "movement_type, 'receipt'" not in sql
    for needle in [
        "v_remaining",
        "receipt_exceeds_remaining",
        "fully_received_supplier_order",
        "if p_quantity = v_remaining then",
        "set status='posted'",
    ]:
        assert needle in sql, f"Missing bounded receipt contract: {needle}"


def test_rpc_is_private_and_direct_writes_are_revoked() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "security definer",
        "set search_path = ''",
        "revoke all on table public.tan_tao_warehouse_documents from public, anon, authenticated",
        "revoke all on table public.tan_tao_warehouse_movements from public, anon, authenticated",
        "revoke all on table public.tan_tao_warehouse_reservations from public, anon, authenticated",
        "grant select on table public.tan_tao_warehouse_documents to authenticated",
        "grant execute on function public.execute_tan_tao_warehouse_command",
        "auth.role() = 'service_role'",
        "has_role((select auth.uid()), 'owner'::public.app_role)",
    ]:
        assert needle in sql, f"Missing ACL/RLS contract: {needle}"


def test_natural_sources_automatically_create_incoming_and_reservations() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "sync_tan_tao_dealer_order_reservation",
        "sync_tan_tao_sent_notification",
        "tan_tao_dealer_order_reservation_trigger",
        "tan_tao_sent_notification_trigger",
        "supplier-notification:",
        "dealer-order:",
        "kiosk-dispatch-notification:",
        "production_bread_order",
        "warehouse_kiosk_bread_dispatch",
        "source_snapshot #>> '{rounding,total_bmq,sent_quantity}'",
        "orderquantity",
        "shortagequantity",
        "returnsquantity",
        "wastequantity",
    ]:
        assert needle in sql, f"Missing natural-source automation contract: {needle}"
    assert "for each row execute function public.sync_tan_tao_dealer_order_reservation()" in sql
    assert "for each row execute function public.sync_tan_tao_sent_notification()" in sql
    assert "historical_backfill" not in sql


def test_chat_first_page_and_navigation_are_reviewable() -> None:
    page = read(PAGE)
    parser = read(PARSER)
    routes = read(ROUTES)
    sidebar = read(SIDEBAR)
    language = read(LANGUAGE)
    for needle in [
        "Kho Tân Tạo",
        "BMQ Agent",
        "Tồn vật lý",
        "Đã giữ cho đơn",
        "ATP khả dụng",
        "Hàng đang về",
        "execute_tan_tao_warehouse_command",
        "get_tan_tao_warehouse_snapshot",
        "Cần xử lý",
    ]:
        assert needle in page, f"Missing chat-first UI marker: {needle}"
    assert "parseTanTaoWarehouseCommand" in page
    assert "submissionLockRef" in page
    assert "if (snapshotQuery.isLoading || snapshotQuery.isError) return;" in page
    assert "p_idempotency_key: idempotencyKey" in page
    assert 'onClick={() => setComposer(example)}' in page, "Example chips must prefill only and never post live stock"
    assert "Không tải được sổ kho" in page
    assert 'snapshotQuery.isError ? "—"' in page, "API failure must not be rendered as zero stock"
    assert 'path="/warehouse/tan-tao"' in routes
    assert 'path: "/warehouse/tan-tao"' in sidebar
    assert "tanTaoWarehouse" in language
    assert "physicalQuantity" in parser


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
    print(f"tan tao warehouse contracts passed: {len(tests)}")
