from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FLOW_LIB = ROOT / "src/lib/payables-receiving-flow.ts"
QUEUE_HOOK = ROOT / "src/hooks/usePurchaseReceiptQueue.ts"
PO_HOOK = ROOT / "src/hooks/usePurchaseOrders.ts"
WAREHOUSE_HOME = ROOT / "src/warehouse/pages/WarehouseHome.tsx"
SCAN_RESULT_EDITOR = ROOT / "src/warehouse/components/ScanResultEditor.tsx"
MATCH_DELIVERY_FUNCTION = ROOT / "supabase/functions/match-delivery-note/index.ts"
FINALIZE_RECEIPT_FUNCTION = ROOT / "supabase/functions/finalize-goods-receipt/index.ts"
GOODS_RECEIPTS_HOOK = ROOT / "src/hooks/useGoodsReceipts.ts"
GOODS_RECEIPTS_PAGE = ROOT / "src/pages/GoodsReceipts.tsx"
GOODS_RECEIPT_DETAILS = ROOT / "src/components/dialogs/GoodsReceiptDetailsDialog.tsx"
SUPABASE_CONFIG = ROOT / "supabase/config.toml"
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


def test_finalization_function_posts_inventory_and_generates_pending_payable_from_actual_quantities():
    edge = read(FINALIZE_RECEIPT_FUNCTION)
    assert "finalize-goods-receipt" in edge
    assert ".from(\"goods_receipts\")" in edge
    assert "payable_status" in edge
    assert "not_generated" in edge
    assert "already finalized" in edge or "already received" in edge
    assert "actual_quantity ?? item.quantity" in edge
    assert "actualQuantity > 0" in edge
    assert ".from(\"inventory_items\")" in edge
    assert ".from(\"inventory_batches\")" in edge
    assert "createPayableRequestNumber" in edge
    assert ".from(\"payment_requests\")" in edge
    assert "status: \"pending\"" in edge
    assert "delivery_status: \"delivered\"" in edge
    assert "payment_status: \"unpaid\"" in edge
    assert "purchase_order_id" in edge
    assert "goods_receipt_id" in edge
    assert ".from(\"payment_request_items\")" in edge
    assert "line_total: payableLineTotal" in edge
    assert "payable_status: \"generated\"" in edge
    assert "finalized_at" in edge
    assert "finalized_by" in edge


def test_goods_receipt_confirm_uses_finalization_edge_function_not_client_side_inventory_mutations():
    hook = read(GOODS_RECEIPTS_HOOK)
    confirm_section = hook.split("export function useConfirmGoodsReceipt", 1)[1]
    assert "callEdgeFunction" in hook
    assert "finalize-goods-receipt" in confirm_section
    assert "receiptId" in confirm_section
    assert ".from(\"inventory_items\")" not in confirm_section
    assert ".from(\"inventory_batches\")" not in confirm_section
    assert "payment_requests" not in confirm_section

    config = read(SUPABASE_CONFIG)
    assert "[functions.finalize-goods-receipt]" in config
    assert "verify_jwt = false" in config.split("[functions.finalize-goods-receipt]", 1)[1].split("[functions.", 1)[0]


def test_goods_receipts_ui_shows_payable_audit_state_and_blocks_duplicate_finalization():
    hook = read(GOODS_RECEIPTS_HOOK)
    page = read(GOODS_RECEIPTS_PAGE)
    details = read(GOODS_RECEIPT_DETAILS)

    assert "purchase_orders" in hook
    assert "payment_requests" in hook
    assert "payable_status" in hook

    assert "getPayableBadge" in page
    assert "payable_status" in page
    assert "Công nợ" in page
    assert "Chưa tạo công nợ" in page
    assert "Đã tạo công nợ" in page
    assert "Đang xử lý công nợ" in page
    assert "receipt.payable_status === \"generated\"" in page
    assert "receipt.payment_requests?.request_number" in page
    assert "receipt.purchase_orders?.po_number" in page
    assert "Tạo công nợ" in page

    assert "Đối soát công nợ" in details
    assert "Mã PO" in details
    assert "Mã công nợ" in details
    assert "payment_requests?.request_number" in details
    assert "purchase_orders?.po_number" in details
    assert "finalized_at" in details
    assert "variance_summary" in details
    assert "ordered_quantity" in details
    assert "actual_quantity" in details
    assert "line_status" in details
    assert "Không chốt lại phiếu đã tạo công nợ" in details


if __name__ == "__main__":
    test_payables_receiving_helpers_are_present_and_use_actual_quantity()
    test_migration_adds_receipt_variance_and_payable_state_without_breaking_existing_columns()
    test_generated_types_include_receipt_variance_fields_for_frontend_safety()
    test_purchase_order_send_ensures_single_pending_receipt_queue()
    test_warehouse_scan_matches_pending_po_receipt_queue_before_legacy_payment_requests()
    test_warehouse_ui_exposes_po_receipt_match_metadata()
    test_finalization_function_posts_inventory_and_generates_pending_payable_from_actual_quantities()
    test_goods_receipt_confirm_uses_finalization_edge_function_not_client_side_inventory_mutations()
    test_goods_receipts_ui_shows_payable_audit_state_and_blocks_duplicate_finalization()
    print("ok - 9 tests passed")
