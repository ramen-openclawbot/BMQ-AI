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
PAYMENT_REQUESTS_HOOK = ROOT / "src/hooks/usePaymentRequests.ts"
PAYMENT_REQUESTS_PAGE = ROOT / "src/pages/PaymentRequests.tsx"
PAYABLES_MANAGEMENT_PAGE = ROOT / "src/pages/PayablesManagement.tsx"
PURCHASE_ORDERS_PAGE = ROOT / "src/pages/PurchaseOrders.tsx"
PAYMENT_REQUEST_DETAILS = ROOT / "src/components/dialogs/PaymentRequestDetailsDialog.tsx"
SIDEBAR = ROOT / "src/components/layout/Sidebar.tsx"
APP_ROUTES = ROOT / "src/components/AppRoutes.tsx"
LANGUAGE_CONTEXT = ROOT / "src/contexts/LanguageContext.tsx"
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


def test_finalization_rpc_posts_inventory_and_generates_pending_payable_atomically():
    migrations = "\n".join(read(path) for path in sorted(MIGRATIONS.glob("*.sql")))
    edge = read(FINALIZE_RECEIPT_FUNCTION)

    assert "CREATE OR REPLACE FUNCTION public.finalize_goods_receipt" in migrations
    assert "LANGUAGE plpgsql" in migrations
    assert "SECURITY DEFINER" in migrations
    assert "FOR UPDATE" in migrations
    assert "actual_quantity" in migrations
    assert "v_actual_quantity > 0" in migrations
    assert "public.inventory_items" in migrations
    assert "public.inventory_batches" in migrations
    assert "public.payment_requests" in migrations
    assert "public.payment_request_items" in migrations
    assert "payable_status = 'generated'" in migrations
    assert "finalized_at = now()" in migrations
    assert "finalized_by = p_user_id" in migrations
    assert "RAISE EXCEPTION" in migrations
    assert "GRANT EXECUTE ON FUNCTION public.finalize_goods_receipt(uuid, uuid) TO authenticated" in migrations
    assert "GRANT EXECUTE ON FUNCTION public.finalize_goods_receipt(uuid, uuid) TO service_role" in migrations

    assert 'rpc("finalize_goods_receipt"' in edge
    assert "p_receipt_id" in edge
    assert "p_user_id" in edge
    assert "Failed to finalize goods receipt" in edge
    rpc_section = edge.split('rpc("finalize_goods_receipt"', 1)[1]
    assert ".from(\"inventory_items\")" not in rpc_section
    assert ".from(\"inventory_batches\")" not in rpc_section
    assert ".from(\"payment_requests\")" not in rpc_section
    assert ".from(\"payment_request_items\")" not in rpc_section


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


def test_finance_payables_ui_filters_and_labels_warehouse_generated_requests():
    hook = read(PAYMENT_REQUESTS_HOOK)
    page = read(PAYMENT_REQUESTS_PAGE)
    details = read(PAYMENT_REQUEST_DETAILS)

    assert "goods_receipts(id, receipt_number, receipt_date, payable_status)" in hook
    assert "purchase_orders(id, po_number, status)" in hook
    assert "fallbackSelect" in hook
    assert "Falling back without receipt/PO relations" in hook
    assert 'select(fallbackSelect)' in hook
    assert "goods_receipts?:" in hook
    assert "purchase_orders?:" in hook
    assert "creator_profile?:" in hook
    assert "attachCreatorProfiles" in hook
    assert '.from("profiles")' in hook
    assert '.select("user_id, full_name, email")' in hook
    assert '.in("user_id", creatorIds)' in hook

    assert 'sourceFilter' in page
    assert 'warehouse_receipt' in page
    assert 'Công nợ tạo từ nhập kho' in page
    assert 'request.goods_receipt_id' in page
    assert 'stats.warehouseGenerated' in page
    assert 'filteredRequests' in page

    table_section = page.split('<TableHeader className="bg-slate-50 dark:bg-slate-900/50">', 1)[1].split('</Table>', 1)[0]
    assert '{language === "vi" ? "Nguồn" : "Source"}' not in table_section
    assert 'renderSourceBadge(request)' not in table_section
    assert 'request.creator_profile' in page
    assert 'profile?.full_name?.trim()' in page

    assert 'Công nợ tạo từ nhập kho' in details
    assert 'Phiếu nhập kho' in details
    assert 'PO liên kết' in details
    assert 'request.goods_receipts?.receipt_number' in details
    assert 'request.purchase_orders?.po_number' in details


def test_payables_management_is_accessible_from_cost_sidebar_with_filtered_route():
    sidebar = read(SIDEBAR)
    routes = read(APP_ROUTES)
    language = read(LANGUAGE_CONTEXT)
    page = read(PAYMENT_REQUESTS_PAGE)
    payables_page = read(PAYABLES_MANAGEMENT_PAGE)

    cost_section = sidebar.split('labelKey: "financeCostManagement"', 1)[1].split('labelKey: "financeRevenueManagement"', 1)[0]
    assert 'labelKey: "financePayablesManagement"' in cost_section
    assert 'path: "/finance-control/payables"' in cost_section
    assert 'moduleKey: "payment_requests"' in cost_section
    assert 'import PayablesManagement from "@/pages/PayablesManagement";' in routes
    assert '<Route path="/finance-control/payables" element={<ModuleRoute moduleKey="payment_requests"><PayablesManagement /></ModuleRoute>}' in routes
    assert '<PaymentRequests defaultSourceFilter="warehouse_receipt"' not in routes
    assert 'financePayablesManagement: string;' in language
    assert 'financePayablesManagement: "Supplier Payables"' in language
    assert 'financePayablesManagement: "Quản lý công nợ phải trả"' in language

    assert 'type PaymentRequestsProps' in page
    assert 'Quản lý công nợ phải trả' in payables_page
    assert 'Công nợ từ phiếu nhập kho' in payables_page
    assert 'useState<SourceFilter>("all")' in payables_page
    assert 'type="date"' not in payables_page
    assert 'dateFrom' not in payables_page
    assert 'dateTo' not in payables_page
    assert 'Ngày tạo' not in payables_page
    assert 'paymentRequest.goods_receipts?.receipt_number' in payables_page
    assert 'paymentRequest.purchase_orders?.po_number' in payables_page
    assert 'getRemainingPaymentAmount(paymentRequest)' in payables_page
    assert 'PaymentRequestDetailsDialog' in payables_page
    assert 'Không có công nợ phải trả' in payables_page
    assert 'type PaymentRequestsProps = {' in page
    assert 'defaultSourceFilter?: "all" | "warehouse_receipt" | "manual";' in page
    assert 'useState<string>(defaultSourceFilter)' in page


def test_purchase_orders_list_row_opens_details_and_shows_product_names_without_eye_icon():
    hook = read(PO_HOOK)
    page = read(PURCHASE_ORDERS_PAGE)

    assert "purchase_order_items(id, product_name)" in hook
    assert "purchase_order_items?: Array<Pick<Tables<\"purchase_order_items\">, \"id\" | \"product_name\">> | null;" in hook

    assert "  Eye," not in page
    assert "<Eye" not in page
    assert "{isVi ? \"Sản phẩm\" : \"Products\"}" in page
    assert "getOrderProductNames" in page
    assert "order.purchase_order_items" in page
    assert "onClick={() => setSelectedOrderId(order.id)}" in page
    assert "cursor-pointer" in page
    assert "onKeyDown={(event) => handleOrderRowKeyDown(event, order.id)}" in page
    assert "event.stopPropagation()" in page
    assert "aria-label={isVi ? \"Xóa PO\" : \"Delete PO\"}" in page


if __name__ == "__main__":
    test_payables_receiving_helpers_are_present_and_use_actual_quantity()
    test_migration_adds_receipt_variance_and_payable_state_without_breaking_existing_columns()
    test_generated_types_include_receipt_variance_fields_for_frontend_safety()
    test_purchase_order_send_ensures_single_pending_receipt_queue()
    test_warehouse_scan_matches_pending_po_receipt_queue_before_legacy_payment_requests()
    test_warehouse_ui_exposes_po_receipt_match_metadata()
    test_finalization_rpc_posts_inventory_and_generates_pending_payable_atomically()
    test_goods_receipt_confirm_uses_finalization_edge_function_not_client_side_inventory_mutations()
    test_goods_receipts_ui_shows_payable_audit_state_and_blocks_duplicate_finalization()
    test_finance_payables_ui_filters_and_labels_warehouse_generated_requests()
    test_payables_management_is_accessible_from_cost_sidebar_with_filtered_route()
    test_purchase_orders_list_row_opens_details_and_shows_product_names_without_eye_icon()
    print("ok - 12 tests passed")
