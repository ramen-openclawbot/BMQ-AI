from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FLOW_LIB = ROOT / "src/lib/payables-receiving-flow.ts"
QUEUE_HOOK = ROOT / "src/hooks/usePurchaseReceiptQueue.ts"
PO_HOOK = ROOT / "src/hooks/usePurchaseOrders.ts"
WAREHOUSE_HOME = ROOT / "src/warehouse/pages/WarehouseHome.tsx"
SCAN_RESULT_EDITOR = ROOT / "src/warehouse/components/ScanResultEditor.tsx"
MATCH_DELIVERY_FUNCTION = ROOT / "supabase/functions/match-delivery-note/index.ts"
MIGRATIONS = ROOT / "supabase/migrations"
TYPES = ROOT / "src/integrations/supabase/types.ts"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path}"
    return path.read_text(encoding="utf-8")


def latest_receiving_migration() -> str:
    matches = sorted(MIGRATIONS.glob("*_payables_receiving_flow.sql"))
    assert matches, "Missing payables receiving flow migration"
    return read(matches[-1])


def test_payables_receiving_helpers_are_present_and_use_actual_quantity():
    lib = read(FLOW_LIB)
    assert 'export type ReceiptLineStatus = "du" | "thieu" | "du_thua"' in lib
    assert "export function classifyReceiptLine" in lib
    assert 'return "thieu"' in lib
    assert 'return "du_thua"' in lib
    assert 'return "du"' in lib
    assert "export function payableLineTotal" in lib
    assert "actualQty" in lib
    assert "unitPrice" in lib
    assert "Math.max(0, Number(actualQty" in lib
    assert "ordered" not in lib.split("export function payableLineTotal", 1)[1]


def test_migration_adds_receipt_variance_and_payable_state_without_breaking_existing_columns():
    migration = latest_receiving_migration()
    assert "ALTER TABLE public.goods_receipts" in migration
    assert "payable_status" in migration
    assert "finalized_at" in migration
    assert "finalized_by" in migration
    assert "variance_summary" in migration
    assert "ALTER TABLE public.goods_receipt_items" in migration
    assert "purchase_order_item_id" in migration
    assert "ordered_quantity" in migration
    assert "actual_quantity" in migration
    assert "unit_price" in migration
    assert "line_status" in migration
    assert "variance_reason" in migration
    assert "idx_goods_receipts_po_status" in migration
    assert "idx_goods_receipts_payable_status" in migration
    assert "uniq_goods_receipts_pending_purchase_order" in migration
    assert "CREATE OR REPLACE FUNCTION public.ensure_purchase_order_receipt_queue" in migration
    assert "FOR UPDATE" in migration
    assert "generate_receipt_number" in migration
    assert "purchase_order_items" in migration


def test_generated_types_include_receipt_variance_fields_for_frontend_safety():
    types = read(TYPES)
    goods_receipts = types.split("goods_receipts: {", 1)[1].split("inventory_batches:", 1)[0]
    assert "payable_status: string" in goods_receipts
    assert "finalized_at: string | null" in goods_receipts
    assert "finalized_by: string | null" in goods_receipts
    assert "variance_summary: Json" in goods_receipts
    receipt_items = types.split("goods_receipt_items: {", 1)[1].split("goods_receipts:", 1)[0]
    assert "purchase_order_item_id: string | null" in receipt_items
    assert "ordered_quantity: number | null" in receipt_items
    assert "actual_quantity: number | null" in receipt_items
    assert "unit_price: number | null" in receipt_items
    assert "line_status: string | null" in receipt_items
    assert "variance_reason: string | null" in receipt_items
    functions = types.split("Functions: {", 1)[1].split("Enums: {", 1)[0]
    assert "ensure_purchase_order_receipt_queue" in functions
    assert "p_purchase_order_id: string" in functions
    assert "Returns: string" in functions


def test_purchase_order_send_ensures_single_pending_receipt_queue():
    queue = read(QUEUE_HOOK)
    assert "export async function ensureReceiptForPurchaseOrder" in queue
    assert "ensure_purchase_order_receipt_queue" in queue
    assert "p_purchase_order_id" in queue

    po_hook = read(PO_HOOK)
    assert "ensureReceiptForPurchaseOrder" in po_hook
    send_section = po_hook.split("export function useSendPurchaseOrder", 1)[1].split("export function useReceivePurchaseOrder", 1)[0]
    assert "ensureReceiptForPurchaseOrder(id)" in send_section


def test_warehouse_scan_matches_pending_po_receipt_queue_before_legacy_payment_requests():
    edge = read(MATCH_DELIVERY_FUNCTION)
    assert "PendingReceiptCandidate" in edge
    assert "findBestPendingReceiptMatch" in edge
    assert ".from(\"goods_receipts\")" in edge
    assert "purchase_order_id" in edge
    assert ".in(\"status\", [\"draft\", \"confirmed\"])" in edge
    assert "goods_receipt_items" in edge
    assert "purchase_orders" in edge
    assert "payment_request_items" in edge
    assert edge.index("findBestPendingReceiptMatch") < edge.index("findBestPaymentRequestMatch")
    assert "goodsReceiptId" in edge
    assert "purchaseOrderId" in edge
    assert "poNumber" in edge
    assert "matchSource: \"purchase_order_receipt\"" in edge
    assert "matchSource: \"payment_request\"" in edge


def test_warehouse_ui_exposes_po_receipt_match_metadata():
    home = read(WAREHOUSE_HOME)
    editor = read(SCAN_RESULT_EDITOR)
    assert "goodsReceiptId" in home
    assert "purchaseOrderId" in home
    assert "poNumber" in home
    assert "matchSource" in home
    assert "goodsReceiptId: matchResult?.goodsReceiptId" in home
    assert "line_status" in home
    assert "ordered_quantity" in home
    assert "actual_quantity" in home
    assert "purchase_order_receipt" in editor
    assert "Đã tìm thấy phiếu chờ nhập kho" in editor
    assert "Đối chiếu PO" in editor
    assert "poNumber" in editor


if __name__ == "__main__":
    test_payables_receiving_helpers_are_present_and_use_actual_quantity()
    test_migration_adds_receipt_variance_and_payable_state_without_breaking_existing_columns()
    test_generated_types_include_receipt_variance_fields_for_frontend_safety()
    test_purchase_order_send_ensures_single_pending_receipt_queue()
    test_warehouse_scan_matches_pending_po_receipt_queue_before_legacy_payment_requests()
    test_warehouse_ui_exposes_po_receipt_match_metadata()
    print("ok - 6 tests passed")
