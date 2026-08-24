#!/usr/bin/env python3
"""Static contracts for the chat-first Kho Tân Tạo MVP."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260823090000_tan_tao_ai_warehouse.sql"
MULTI_ITEM_MIGRATION = ROOT / "supabase/migrations/20260824135513_tan_tao_multi_item_stock_count.sql"
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



def test_multi_item_migration_adds_exact_pate_skus_without_history_dml() -> None:
    sql = read(MULTI_ITEM_MIGRATION).lower()
    pate_bootstrap_sql = sql.split("create or replace function public.record_tan_tao_stock_count", 1)[0]
    for needle in [
        "pate-500g",
        "pate-200g",
        "pate 500g",
        "pate 200g",
        "insert into public.product_skus",
        "on conflict (sku_code) do nothing",
        "existing exact-code pate sku has unexpected semantics",
        "sku_type",
        "finished_good",
        "hide_from_dealer_portal",
        "tan_tao_warehouse_documents_sku_check",
        "tan_tao_warehouse_movements_sku_check",
        "tan_tao_warehouse_reservations_sku_check",
        "check (upper(sku_code_snapshot) in ('bmq-001','bmq-002','pate-500g','pate-200g'))",
        "không fuzzy map nhãn/tem pate",
    ]:
        assert needle in sql, f"Missing deterministic Pate SKU contract: {needle}"
    for forbidden in [
        "insert into public.tan_tao_warehouse_documents",
        "insert into public.tan_tao_warehouse_movements",
        "insert into public.tan_tao_warehouse_reservations",
        "update public.tan_tao_warehouse_documents",
        "update public.tan_tao_warehouse_movements",
        "update public.tan_tao_warehouse_reservations",
        "delete from public.tan_tao_warehouse_documents",
        "delete from public.tan_tao_warehouse_movements",
        "delete from public.tan_tao_warehouse_reservations",
        "truncate public.tan_tao_warehouse",
        "historical_backfill",
        "nhãn/tem pate'",
    ]:
        assert forbidden not in pate_bootstrap_sql, f"Pate bootstrap must not mutate warehouse history or fuzzy-map Pate: {forbidden}"


def test_multi_item_snapshot_uses_allowlisted_operational_name_and_unit_not_master_sku_identity() -> None:
    sql = read(MULTI_ITEM_MIGRATION).lower()
    for needle in [
        "with sku_order(sku_code, sort_order, operational_name, operational_unit) as",
        "('bmq-001', 1, 'bánh mì tươi', 'que')",
        "('bmq-002', 2, 'bánh mì đông lạnh', 'que')",
        "s.operational_name as product_name",
        "s.operational_unit as unit",
        "'product_name', item_row.product_name",
        "'unit', item_row.unit",
        "'sku_code', 'bmq-001'",
        "'unit', 'que'",
    ]:
        assert needle in sql, f"Snapshot must use approved operational name/unit from sku_order: {needle}"
    forbidden = [
        "coalesce(nullif(ps.product_name, ''), s.",
        "coalesce(nullif(ps.unit, ''), s.",
        "ps.product_name as product_name",
        "ps.unit as unit",
    ]
    for needle in forbidden:
        assert needle not in sql, f"Snapshot must not expose product_skus master identity for Tan Tao operational cards: {needle}"


def test_multi_item_recent_documents_preserve_supplier_quantity_fields_for_existing_ui() -> None:
    sql = read(MULTI_ITEM_MIGRATION).lower()
    recent_section = sql.split("select d.id, d.document_number", 1)[1].split("from public.tan_tao_warehouse_documents d", 1)[0]
    for needle in [
        "d.supplier_billable_quantity",
        "d.supplier_credit_quantity",
        "d.supplier_exchange_quantity",
        "d.supplier_makeup_quantity",
    ]:
        assert needle in recent_section, f"recent_documents must preserve existing released supplier quantity field: {needle}"


def test_multi_item_snapshot_returns_four_independent_items_and_bmq_compatibility() -> None:
    sql = (read(MIGRATION) + "\n" + read(MULTI_ITEM_MIGRATION)).lower()
    for needle in [
        "get_tan_tao_warehouse_snapshot()",
        "v_allowed_skus text[] := array['bmq-001','bmq-002','pate-500g','pate-200g']",
        "jsonb_agg(item_row",
        "'items'",
        "'can_manage', public.can_manage_tan_tao_warehouse()",
        "'sku_code', 'bmq-001'",
        "'sku_code', item_row.sku_code",
        "'unit', item_row.unit",
        "on_hand_quantity - reserved_quantity",
        "recent_documents",
        "left join public.product_skus ps on ps.sku_code = s.sku_code",
        "from public.tan_tao_warehouse_movements",
        "from public.tan_tao_warehouse_reservations",
        "from public.tan_tao_warehouse_documents",
    ]:
        assert needle in sql, f"Missing multi-item snapshot contract: {needle}"
    assert "upper(i.sku_code)='bmq-001'" in sql or "upper(i.sku_code) = 'bmq-001'" in sql
    assert "new.notification_type='production_bread_order'" in sql or "new.notification_type = 'production_bread_order'" in sql


def test_multi_item_stock_count_rpc_is_exact_allowlisted_and_serialized_per_sku() -> None:
    sql = read(MULTI_ITEM_MIGRATION).lower()
    for needle in [
        "record_tan_tao_stock_count",
        "p_sku_code text",
        "p_count numeric",
        "p_reason text",
        "p_idempotency_key text",
        "v_sku_code text := upper(btrim(p_sku_code))",
        "v_sku_code not in ('bmq-001','bmq-002','pate-500g','pate-200g')",
        "can_manage_tan_tao_warehouse()",
        "pg_advisory_xact_lock(hashtextextended('warehouse_tan_tao:' || v_sku_code",
        "lower(p_count::text) in ('nan','infinity','-infinity')",
        "idempotency_conflict",
        "v_existing.document_type is distinct from 'stock_count'",
        "v_existing.sku_code_snapshot is distinct from v_sku_code",
        "v_existing.physical_quantity is distinct from p_count",
        "v_existing.note is distinct from btrim(p_reason)",
        "return jsonb_build_object('status', 'existing'",
        "confirmed_physical_count",
        "system_quantity_before",
        "counted_quantity",
        "adjustment_quantity",
        "public.get_tan_tao_warehouse_snapshot()",
        "grant execute on function public.record_tan_tao_stock_count(text,numeric,text,text)",
        "revoke all on function public.record_tan_tao_stock_count(text,numeric,text,text) from public, anon",
    ]:
        assert needle in sql, f"Missing exact SKU stock-count RPC contract: {needle}"
    assert "select id into v_sku_id from public.product_skus where sku_code = v_sku_code" in sql


def test_multi_item_ui_renders_four_cards_and_physical_count_action() -> None:
    page = read(PAGE)
    for needle in [
        "items?: WarehouseItem[]",
        "can_manage?: boolean",
        "selectedStockCountSku",
        "physicalCountValue",
        "physicalCountReason",
        "stockCountSubmissionLockRef",
        "stockCountSubmissionLockRef.current = true",
        "stockCountSubmissionLockRef.current = false",
        "window.confirm",
        "const idempotencyKey = `stock-count:${selectedStockCountSku}:${crypto.randomUUID()}`",
        "canManageWarehouse",
        "snapshot?.can_manage === true",
        "if (!canManageWarehouse || snapshotQuery.isLoading || snapshotQuery.isError) return;",
        "{canManageWarehouse ? (",
        "Bạn chỉ có quyền xem Kho Tân Tạo",
        "record_tan_tao_stock_count",
        "skuCode: selectedStockCountSku",
        "count: Number(physicalCountValue)",
        "reason: physicalCountReason.trim()",
        "stock-count:",
        "BMQ-001",
        "BMQ-002",
        "PATE-500G",
        "PATE-200G",
        "Bánh mì tươi",
        "Bánh mì đông lạnh",
        "Pate 500g",
        "Pate 200g",
        "data-bmq-tan-tao-multi-item-card",
        "grid gap-3 md:grid-cols-2 xl:grid-cols-4",
        "htmlFor=\"tan-tao-stock-count-quantity\"",
        "id=\"tan-tao-stock-count-quantity\"",
        "htmlFor=\"tan-tao-stock-count-reason\"",
        "id=\"tan-tao-stock-count-reason\"",
        "Số lượng kiểm kê vật lý",
        "Nhập lý do/ghi chú kiểm kê",
        "Ghi nhận kiểm kê vật lý",
        "disabled={!canSubmitStockCount",
    ]:
        assert needle in page, f"Missing multi-item UI marker: {needle}"
    assert "Pate tổng" not in page
    assert "p_sku_id" not in page, "Browser must not submit arbitrary product IDs for stock count"
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
    assert "if (!canManageWarehouse || snapshotQuery.isLoading || snapshotQuery.isError) return;" in page
    assert "p_idempotency_key: idempotencyKey" in page
    assert 'onClick={() => setComposer(example)}' in page, "Example chips must prefill only and never post live stock"
    assert "Không tải được sổ kho" in page
    assert 'snapshotQuery.isError ? "—"' in page, "API failure must not be rendered as zero stock"
    assert 'path="/warehouse/tan-tao"' in routes
    assert 'path: "/warehouse/tan-tao"' in sidebar
    assert "tanTaoWarehouse" in language
    assert "physicalQuantity" in parser
    assert "Lò tính tiền" in page
    assert "Khấu trừ công nợ lò" in page


def test_chat_stock_count_is_blocked_from_legacy_command_rpc() -> None:
    page = read(PAGE)
    for needle in [
        'Exclude<TanTaoWarehouseCommand, { type: "stock_count" }>',
        "parsed.type === \"stock_count\"",
        "Chọn mặt hàng trong form Ghi nhận kiểm kê vật lý",
        "không ghi kiểm kê vật lý qua khung chat",
        "setComposer(\"\")",
        "return;",
    ]:
        assert needle in page, f"Chat stock-count bypass guard missing UI marker: {needle}"

    stock_count_guard = page.split('parsed.type === "stock_count"', 1)[1].split("submissionLockRef.current = true", 1)[0]
    assert "commandMutation.mutate" not in stock_count_guard, "Parsed stock_count chat must not call legacy command mutation"
    assert "submissionLockRef.current = true" not in stock_count_guard, "Parsed stock_count chat must return before legacy submission lock"
    assert "Kiểm kê thực tế còn 172 que" not in page, "Example chips must not advertise chat stock-count recording"
    assert "hoặc kiểm kê thực tế" not in page, "Unparsed-chat help must not claim chat can directly record stock counts"


def test_multi_item_ui_does_not_hardcode_one_time_physical_count_labels() -> None:
    page = read(PAGE)
    for forbidden in [
        "approvedCountText",
        "Mốc kiểm kê duyệt",
        "52 que",
        "194 que",
        "165 hộp = 82,5kg",
        "40 hộp = 8kg",
        "Tổng pate tham khảo: 90,5kg",
        "BMQ-001 · Bánh mì que Pate",
    ]:
        assert forbidden not in page, f"UI must not hard-code stale one-time Tan Tao physical count label: {forbidden}"
    for needle in [
        "weightKgPerUnit",
        "weightKgPerUnit: 0.5",
        "weightKgPerUnit: 0.2",
        "pateKgTotal",
        "item.on_hand_quantity * (approved?.weightKgPerUnit || 0)",
        "Kho Tân Tạo · Bánh mì tươi, bánh mì đông lạnh và Pate",
    ]:
        assert needle in page, f"UI must show dynamic current-balance Pate kg metadata, not static count labels: {needle}"


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
    print(f"tan tao warehouse contracts passed: {len(tests)}")
