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
ADD_PURCHASE_ORDER_DIALOG = ROOT / "src/components/dialogs/AddPurchaseOrderDialog.tsx"
PAYMENT_REQUEST_DETAILS = ROOT / "src/components/dialogs/PaymentRequestDetailsDialog.tsx"
PURCHASE_ORDER_DETAILS = ROOT / "src/components/dialogs/PurchaseOrderDetailsDialog.tsx"
USER_MANAGEMENT_HOOK = ROOT / "src/hooks/useUserManagement.ts"
SIDEBAR = ROOT / "src/components/layout/Sidebar.tsx"
APP_ROUTES = ROOT / "src/components/AppRoutes.tsx"
GLOBAL_AGENT_CHAT_WIDGET = ROOT / "src/components/agent/GlobalAgentChatWidget.tsx"
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
    assert "Cannot create payable with zero amount" in migrations
    zero_amount_guard = migrations.split("Cannot create payable with zero amount", 1)[0]
    assert "v_total_amount := v_subtotal + v_vat_amount" in zero_amount_guard
    assert zero_amount_guard.rfind("IF v_total_amount <= 0 THEN") > zero_amount_guard.rfind("v_total_amount := v_subtotal + v_vat_amount")
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
    assert "attachSupplierNames" in hook
    assert '.from("suppliers")' in hook
    assert '.in("id", missingSupplierIds)' in hook
    assert "Falling back to base goods_receipt detail query" in hook
    assert "Falling back to base goods_receipt_items query" in hook
    assert "product_skus: null" in hook
    assert "purchase_order_items: null" in hook

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
    assert "data-bmq-goods-receipts-mobile-optimized" in page
    assert "data-bmq-goods-receipts-mobile-card-list" in page
    assert "data-bmq-goods-receipt-row-click-detail" in page
    assert "data-bmq-goods-receipts-pagination" in page
    assert "data-bmq-goods-receipts-per-page={RECEIPTS_PER_PAGE}" in page
    assert "data-bmq-goods-receipts-period-filters" in page
    assert "data-bmq-goods-receipts-default-week-filter" in page
    assert "data-bmq-goods-receipts-supplier-search" in page
    assert "data-bmq-goods-receipts-week-buckets" in page
    assert "data-bmq-goods-receipts-week-filter" in page
    assert "data-bmq-goods-receipts-month-filter" in page
    assert "data-bmq-goods-receipts-year-filter" in page
    assert "data-bmq-goods-receipts-month-select-stable" in page
    assert "data-bmq-goods-receipts-filtered-dashboard" in page
    assert "type TimeFilterMode = \"week\" | \"month\" | \"year\";" in page
    assert "const [timeFilterMode, setTimeFilterMode] = useState<TimeFilterMode>(\"week\");" in page
    assert "const [supplierSearchTerm, setSupplierSearchTerm] = useState(\"\");" in page
    assert "buildWeekBuckets" in page
    assert "label: `Tuần ${index + 1}" in page
    assert "1-7, 8-14, 15-21, 22-28, 29-hết tháng" in page
    assert "receiptMatchesPeriod" in page
    assert "periodAndSupplierFilteredReceipts" in page
    assert "total: periodAndSupplierFilteredReceipts.length" in page
    assert "periodAndSupplierFilteredReceipts.filter((r) => r.status === \"draft\").length" in page
    assert "normalizeSearchText(r.suppliers?.name || \"\")" in page
    assert "formatMonthLabel(month)" in page
    assert "type=\"month\"" not in page
    assert "const RECEIPTS_PER_PAGE = 20" in page
    assert "paginatedReceipts.map((receipt)" in page
    assert "filteredReceipts.slice(start, start + RECEIPTS_PER_PAGE)" in page
    assert "renderPaginationControls(\"mobile\")" in page
    assert "renderPaginationControls(\"desktop\")" in page
    assert "setCurrentPage(1)" in page
    assert "onClick={() => handleViewDetails(receipt.id)}" in page
    assert "useSidebar" not in page
    assert 'window.dispatchEvent(new Event("bmq:open-sidebar"))' in page
    assert "Chạm vào thẻ để xem chi tiết" in page
    assert "<Eye" not in page

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
    assert "data-bmq-goods-receipt-detail-light-mobile" in details
    assert "data-bmq-goods-receipt-detail-mobile-v2" in details
    assert "data-bmq-goods-receipt-detail-mobile-hero" in details
    assert "data-bmq-goods-receipt-detail-mobile-summary" in details
    assert "data-bmq-goods-receipt-detail-mobile-item-cards" in details
    assert "max-md:h-[96dvh]" in details
    assert "hidden overflow-x-auto rounded-xl border border-border md:block" in details
    assert "Dòng hàng" in details
    assert "Thực nhận" in details
    assert "formatSafeDate" in details
    assert "Không tải được chi tiết phiếu nhập" in details
    assert "Đang tải chi tiết phiếu nhập" in details
    assert "data-bmq-goods-receipt-delivery-note-required" in details
    assert "data-bmq-goods-receipt-ocr-assist" in details
    assert "data-bmq-goods-receipt-ocr-compare-po" in details
    assert "data-bmq-goods-receipt-ocr-prefill-actuals" in details
    assert "data-bmq-goods-receipt-variance-evidence-required" in details
    assert "Chụp/scan phiếu giao hàng" in details
    assert "OCR tự điền" in details
    assert "So với PO" in details
    assert "Nhân viên xác nhận cuối" in details
    assert "useDeliveryNoteOcr" in details
    assert "hasDeliveryNoteEvidence" in details


def test_finance_payables_ui_filters_and_labels_warehouse_generated_requests():
    hook = read(PAYMENT_REQUESTS_HOOK)
    page = read(PAYMENT_REQUESTS_PAGE)
    details = read(PAYMENT_REQUEST_DETAILS)

    assert "goods_receipts(id, receipt_number, receipt_date, payable_status)" in hook
    assert "purchase_orders(id, po_number, status)" in hook
    assert "invoices:invoices!payment_requests_invoice_id_fkey(id, invoice_number)" in hook
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


def test_invoice_accounting_links_po_receipt_context_without_enterprise_ledger_rewrite():
    migrations = "\n".join(read(path) for path in sorted(MIGRATIONS.glob("*.sql")))
    types = read(TYPES)
    invoice_hook = read(ROOT / "src/hooks/useInvoices.ts")
    add_invoice = read(ROOT / "src/components/dialogs/AddInvoiceDialog.tsx")
    create_from_pr_dialog = read(ROOT / "src/components/dialogs/CreateInvoiceFromRequestDialog.tsx")
    create_from_pr_function = read(ROOT / "supabase/functions/create-invoice-from-pr/index.ts")

    assert "ALTER TABLE public.invoices" in migrations
    assert "purchase_order_id uuid" in migrations
    assert "goods_receipt_id uuid" in migrations
    assert "invoices_purchase_order_id_fkey" in migrations
    assert "invoices_goods_receipt_id_fkey" in migrations
    assert "uniq_invoices_supplier_invoice_number" in migrations
    assert "idx_invoices_purchase_order_id" in migrations
    assert "idx_invoices_goods_receipt_id" in migrations

    invoice_types = types.split("invoices: {", 1)[1].split("order_items:", 1)[0]
    assert "purchase_order_id: string | null" in invoice_types
    assert "goods_receipt_id: string | null" in invoice_types
    assert "foreignKeyName: \"invoices_purchase_order_id_fkey\"" in invoice_types
    assert "foreignKeyName: \"invoices_goods_receipt_id_fkey\"" in invoice_types

    assert "purchase_order_id: string | null;" in invoice_hook
    assert "goods_receipt_id: string | null;" in invoice_hook
    assert "purchase_orders (id, po_number)" in invoice_hook
    assert "goods_receipts (id, receipt_number)" in invoice_hook

    assert "selectedRequest?.purchase_order_id || null" in add_invoice
    assert "selectedRequest?.goods_receipt_id || null" in add_invoice
    assert "paymentRequest.purchase_order_id" in create_from_pr_function
    assert "paymentRequest.goods_receipt_id" in create_from_pr_function
    assert "purchase_order_id: request.purchase_order_id || null" in create_from_pr_dialog
    assert "goods_receipt_id: request.goods_receipt_id || null" in create_from_pr_dialog
    assert "Tạo từ đề nghị chi" in create_from_pr_dialog


def test_invoices_page_matches_approved_stitch_dashboard_handoff():
    page = read(ROOT / "src/pages/Invoices.tsx")

    assert "data-stitch-invoice-dashboard" in page
    assert "bg-card" in page
    assert "border-border" in page
    assert "text-primary" in page
    assert "btn-gradient" in page
    assert "bg-slate-50/60" not in page
    assert "#D97706" not in page
    assert "#B45309" not in page
    assert "data-stitch-invoice-filters" in page
    assert "data-stitch-invoice-table" in page
    assert "data-stitch-invoice-insights" in page
    assert "Kế toán phải trả" in page
    assert "Theo dõi hóa đơn, công nợ và liên kết PO/phiếu nhập" in page
    assert "Tổng hóa đơn" in page
    assert "Chờ thanh toán" in page
    assert "Quá hạn" in page
    assert "Chưa liên kết chứng từ" in page
    assert "Tìm số hóa đơn, nhà cung cấp, PO..." in page
    assert "Từ phiếu nhập kho" in page
    assert "Từ PO" in page
    assert "OCR/scan" in page
    assert "Thủ công" in page
    assert "Số hóa đơn" in page
    assert "Nguồn/PO/PNK" in page
    assert "Trạng thái" in page
    assert page.index('isVi ? "Trạng thái"') < page.index('isVi ? "Nguồn/PO/PNK"')
    assert "Thao tác" not in page
    assert "Đã trả/Còn lại" in page
    assert "Top NCC theo công nợ" in page
    assert "Thiếu PO/PNK" in page
    assert "const PAGE_SIZE = 20;" in page
    assert "paginatedInvoices.map" in page
    assert "20} {isVi ? \"dòng/trang\"" in page or "PAGE_SIZE} {isVi ? \"dòng/trang\"" in page
    assert "getInvoiceSource" in page
    assert "getInvoiceStatus" in page
    assert "payment_slip_url" in page
    assert "purchase_orders?.po_number" in page
    assert "goods_receipts?.receipt_number" in page
    assert "setViewingInvoiceId(invoice.id)" in page
    assert "onEdit={(invoiceId)" in page
    assert "onDelete={(invoiceId)" in page
    assert "onKeyDown={(event) => handleRowKeyDown(event, invoice.id)}" in page


def test_light_theme_uses_stitch_mediterranean_glass_tokens():
    css = read(ROOT / "src/index.css")
    tailwind = read(ROOT.parent / "tailwind.config.ts")
    sidebar = read(SIDEBAR)
    header = read(ROOT / "src/components/layout/Header.tsx")

    assert "Manrope" in css
    assert "JetBrains Mono" in css
    assert "--background: 36 45% 97%;" in css
    assert "--primary: 202 40% 35%;" in css
    assert "--secondary: 43 57% 83%;" in css
    assert "--font-display: 'Manrope', sans-serif;" in css
    assert "backdrop-filter: blur(16px)" in css
    assert "display: ['Manrope', 'sans-serif']" in tailwind
    assert "monoData: ['JetBrains Mono', 'monospace']" in tailwind
    assert "bg-sidebar/70" in sidebar
    assert "backdrop-blur-xl" in sidebar
    assert "bg-card/70" in header
    assert "backdrop-blur-xl" in header


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
    assert 'Từ hóa đơn' in payables_page
    assert 'Từ PO' in payables_page
    assert 'OCR/scan' in payables_page
    assert 'Thủ công' in payables_page
    assert 'getPayableSource(paymentRequest)' in payables_page
    assert 'paymentRequest.invoice_id' in payables_page
    assert 'paymentRequest.invoices?.invoice_number || paymentRequest.invoice_id' in payables_page
    assert 'paymentRequest.purchase_order_id' in payables_page
    assert 'paymentRequest.image_url' in payables_page
    assert 'type SourceFilter = "warehouse_receipt" | "invoice" | "purchase_order" | "ocr_scan" | "manual" | "all";' in payables_page
    assert 'useState<SourceFilter>("all")' in payables_page
    assert 'type="date"' not in payables_page
    assert 'dateFrom' not in payables_page
    assert 'dateTo' not in payables_page
    assert 'Ngày tạo' not in payables_page
    assert 'paymentRequest.goods_receipts?.receipt_number' in payables_page
    assert 'paymentRequest.purchase_orders?.po_number' in payables_page
    assert 'getRemainingPaymentAmount(paymentRequest)' in payables_page
    assert 'const PAGE_SIZE = 20;' in payables_page
    assert 'const [currentPage, setCurrentPage] = useState(1);' in payables_page
    assert 'const paginatedPayables = filteredPayables.slice(pageStartIndex, pageStartIndex + PAGE_SIZE);' in payables_page
    assert 'paginatedPayables.map((paymentRequest) => {' in payables_page
    assert '20 dòng/trang' in payables_page
    assert 'Trang trước' in payables_page
    assert 'Trang sau' in payables_page
    assert 'setCurrentPage(1);' in payables_page
    assert 'PaymentRequestDetailsDialog' in payables_page
    assert 'Không có công nợ phải trả' in payables_page
    assert 'type PaymentRequestsProps = {' in page
    assert 'defaultSourceFilter?: "all" | "warehouse_receipt" | "manual";' in page
    assert 'useState<string>(defaultSourceFilter)' in page


def test_purchase_orders_list_row_opens_details_and_shows_product_names_without_eye_icon():
    hook = read(PO_HOOK)
    page = read(PURCHASE_ORDERS_PAGE)
    add_dialog = read(ADD_PURCHASE_ORDER_DIALOG)
    detail_dialog = read(PURCHASE_ORDER_DETAILS)
    sidebar = read(SIDEBAR)
    routes = read(APP_ROUTES)
    chat_widget = read(GLOBAL_AGENT_CHAT_WIDGET)
    user_management_hook = read(USER_MANAGEMENT_HOOK)

    assert "purchase_order_items(id, product_name)" in hook
    assert "purchase_order_items?: Array<Pick<Tables<\"purchase_order_items\">, \"id\" | \"product_name\">> | null;" in hook

    assert "  Eye," not in page
    assert "<Eye" not in page
    assert "const { language, t } = useLanguage();" in page
    assert "{t.poPurchasing}" in page
    assert "{isVi ? \"Đơn đặt hàng\" : \"Purchase Orders\"}" not in page
    assert "const normalizeSearchText" in page
    assert '.normalize("NFD")' in page
    assert '.replace(/[\\u0300-\\u036f]/g, "")' in page
    assert '.replace(/đ/g, "d")' in page
    assert 'const normalizedSearch = normalizeSearchText(searchTerm);' in page
    assert 'const searchableText = normalizeSearchText(`${order.po_number} ${order.suppliers?.name || ""} ${productNames}`);' in page
    assert "{isVi ? \"Sản phẩm\" : \"Products\"}" in page
    assert "getOrderProductNames" in page
    assert "const capitalizeProductName" in page
    assert 'firstCharacter.toLocaleUpperCase("vi-VN")' in page
    assert "capitalizeProductName(item.product_name)" in page
    assert "order.purchase_order_items" in page
    assert "onClick={() => setSelectedOrderId(order.id)}" in page
    assert "cursor-pointer" in page
    assert "onKeyDown={(event) => handleOrderRowKeyDown(event, order.id)}" in page
    assert "event.stopPropagation()" in page
    assert "aria-label={isVi ? \"Xóa PO\" : \"Delete PO\"}" in page
    assert "data-bmq-mobile-po-revenue-palette" in page
    mobile_section = page.split('data-bmq-mobile-po-revenue-palette', 1)[1].split('<div className="hidden space-y-4 p-4 md:block md:p-6">', 1)[0]
    assert "bg-background" in mobile_section
    assert "bg-card/95" in mobile_section
    assert "bg-primary text-primary-foreground" in mobile_section
    assert "btn-gradient rounded-2xl" in mobile_section
    assert "data-bmq-mobile-po-create-fab" in mobile_section
    assert "bg-amber-600" not in mobile_section
    assert "text-amber-700" not in mobile_section
    assert "bg-slate-50" not in mobile_section
    assert "dark:bg-[#1d1813]" not in mobile_section
    assert "fixed bottom-0" not in mobile_section
    assert "lg:grid-cols-[minmax(0,1fr)_260px]" in page
    assert "grid-cols-2 lg:grid-cols-5" in page
    assert "dark:bg-[#241f18]/90" in page
    assert "dark:border-[#443b30]" in page
    assert "dark:text-[#f3ece4]" in page
    assert "dark:text-[#a99b8c]" in page
    assert "dark:hover:bg-[#342b22]/70" in page
    assert "h-[52px]" in page
    assert "bg-slate-100 dark:bg-[#2b241c]" in page
    assert "{isVi ? \"Ngày dự kiến\" : \"Expected\"}" in page
    assert "formatOptionalDate(order.expected_date)" in page
    assert "formatOptionalDate(order.order_date)" in page
    assert 'format(new Date(order.order_date)' not in page
    assert "const PAGE_SIZE = 20;" in page
    assert "const [currentPage, setCurrentPage] = useState(1);" in page
    assert "const paginatedOrders = filteredOrders.slice(pageStartIndex, pageStartIndex + PAGE_SIZE);" in page
    assert "{paginatedOrders.map((order) => (" in page
    assert "dòng/trang" in page
    assert "Trang trước" in page
    assert "Trang sau" in page
    assert "setCurrentPage(1);" in page
    assert "type TimeFilterMode = \"day\" | \"month\" | \"year\";" in page
    assert "const [timeFilterMode, setTimeFilterMode] = useState<TimeFilterMode>(\"month\");" in page
    assert "const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);" in page
    assert "const periodOrders = useMemo" in page
    assert "const selectedSupplierSummary = useMemo" in page
    assert "const selectedSupplierName = useMemo" in page
    assert "const normalizeSupplierKey =" in page
    assert "const supplierKey = normalizeSupplierKey(supplierName);" in page
    assert "ids: new Set<string>" in page
    assert "selectedSupplierSummary?.poCount || 0" in page
    assert "selectedSupplierId ? `PO của ${selectedSupplierName}`" in page
    assert "orderMatchesSelectedPeriod(order)" in page
    assert "selectedSupplierSummary.ids.has(order.supplier_id)" in page
    assert "Xếp hạng NCC theo giá trị PO" in page
    assert "Đang xem:" in page
    assert "Xóa lọc NCC" in page
    assert "PO của" in page
    assert "Không có PO trong kỳ đã chọn" in page
    assert "Ngày / Tháng / Năm" in page
    assert page.count("Ngày / Tháng / Năm") == 1
    ranking_card = page[page.index("data-stitch-desktop-supplier-ranking"):]
    assert "handleTimeFilterModeChange(mode)" not in ranking_card
    assert "grid grid-cols-3" not in ranking_card
    assert "data-stitch-desktop-supplier-ranking" in page
    assert "data-stitch-mobile-po-main" in page
    assert "data-stitch-mobile-po-card" in page
    assert "Quản lý vận hành nhập hàng & công nợ NCC" in page
    assert "Hỗ trợ tìm không dấu" in page
    assert "Chờ nhận hàng" in page
    assert "fixed bottom-4 right-4 z-40" in page
    assert "data-bmq-mobile-po-create-fab" in page
    assert 'const isPurchaseOrdersMobileContext = location.pathname.startsWith("/purchase-orders");' in chat_widget
    assert "const shouldLiftMobileChatButton = isRevenueMobileContext || isSkuCostsMobileContext || isPurchaseOrdersMobileContext;" in chat_widget
    assert "shouldLiftMobileChatButton" in chat_widget
    assert "bottom-[calc(5rem+env(safe-area-inset-bottom))] right-3 h-11 w-11" in chat_widget
    assert "fixed bottom-0" not in mobile_section
    assert "Kho hàng" not in page and "Cá nhân" not in page
    assert "Kỳ xem" in page
    assert 'onClick={() => window.dispatchEvent(new Event("bmq:open-sidebar"))}' in page
    assert 'sticky top-0 z-20' in page
    assert 'sticky top-[57px] z-10' in page
    assert 'fixed bottom-4 right-4 z-40' in page
    assert 'fixed left-0 top-0 z-50' in sidebar
    assert 'fixed inset-0 z-40 bg-black/45' in sidebar
    assert '<Route path="/purchase-orders" element={<ModuleRoute moduleKey="purchase_orders"><PurchaseOrders /></ModuleRoute>}' in routes
    assert 'Trang này yêu cầu quyền xem module {moduleLabel}' in routes
    assert '{ key: "purchase_orders", labelEn: "PO (Purchasing)", labelVi: "PO (Mua hàng)" }' in user_management_hook
    assert "Tạo PO (Mua hàng)" in add_dialog
    assert "Tạo đơn đặt hàng</Button>" not in add_dialog
    assert "data-stitch-mobile-po-approve-detail" in detail_dialog
    assert "data-bmq-po-detail-light-theme" in detail_dialog
    assert "max-md:bg-slate-50" in detail_dialog
    assert "bg-gradient-to-b from-amber-50 via-white to-slate-50" in detail_dialog
    assert "max-md:bg-[#1d1813]" not in detail_dialog
    assert "bg-[#17130e]" not in detail_dialog
    assert "bg-[#241f18]" not in detail_dialog
    assert "border-[#443b30]" not in detail_dialog
    assert "text-[#f3ece4]" not in detail_dialog
    assert "fixed bottom-0" not in detail_dialog
    assert "const formatSafeDate" in detail_dialog
    assert "formatSafeDate(order.order_date)" in detail_dialog
    assert "formatSafeDate(order.expected_date, \"Chưa xác định\")" in detail_dialog
    assert "formatSafeDate(gr.receipt_date)" in detail_dialog
    assert 'format(new Date(order.order_date)' not in detail_dialog
    assert 'format(new Date(order.expected_date)' not in detail_dialog
    assert 'format(new Date(gr.receipt_date)' not in detail_dialog
    assert "Duyệt PO" in detail_dialog
    assert "Chi tiết sản phẩm" in detail_dialog
    assert "Checklist duyệt" in detail_dialog
    assert "Đã kiểm tra NCC" in detail_dialog
    assert "Từ chối" in detail_dialog
    assert "bg-[#D97706]" in detail_dialog


def test_goods_receipt_receiving_edit_mode():
    hook = read(GOODS_RECEIPTS_HOOK)
    details = read(GOODS_RECEIPT_DETAILS)

    # Hook: mutation for bulk updating actual received quantities
    assert "export function useUpdateGoodsReceiptItems" in hook
    update_section = hook.split("export function useUpdateGoodsReceiptItems", 1)[1]
    assert "actual_quantity" in update_section
    assert "line_status" in update_section
    assert "variance_reason" in update_section
    assert "receiptId" in update_section
    assert "goods_receipt_items" in update_section

    # Dialog wires in the new mutation
    assert "useUpdateGoodsReceiptItems" in details

    # Stable regression markers
    assert "data-bmq-goods-receipt-receive-editor" in details
    assert "data-bmq-goods-receipt-mobile-receive-editor" in details
    assert "data-bmq-goods-receipt-desktop-receive-editor" in details
    assert "data-bmq-goods-receipt-shortage-reason" in details
    assert "data-bmq-goods-receipt-actual-payable-only" in details

    # Workflow Vietnamese copy
    assert "Kho nhập số lượng thực nhận" in details
    assert "Nhập kho + Tạo công nợ" in details
    assert "thực nhận" in details
    assert "Công nợ theo thực nhận" in details
    assert "Lý do thiếu" in details

    # Over-receipt blocked via validation message
    assert "Vượt quá" in details

    # Finalization gated on per-line validation
    assert "canFinalize" in details
    assert "disabled={" in details

    # Shortage requires reason before finalizing
    assert "variance_reason" in details


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
    test_invoice_accounting_links_po_receipt_context_without_enterprise_ledger_rewrite()
    test_invoices_page_matches_approved_stitch_dashboard_handoff()
    test_payables_management_is_accessible_from_cost_sidebar_with_filtered_route()
    test_purchase_orders_list_row_opens_details_and_shows_product_names_without_eye_icon()
    test_goods_receipt_receiving_edit_mode()
    print("ok - 15 tests passed")
