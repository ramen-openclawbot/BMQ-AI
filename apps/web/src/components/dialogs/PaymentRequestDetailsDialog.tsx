/* Hallmark · component: detail-dialog · genre: modern-minimal · tone: technical
 * structure: mobile information workbench · states: default · hover · focus · active · disabled · loading · error · success
 * pre-emit critique: P5 H5 E4 S5 R5 V4 · contrast: pass (40–41) · mobile: pass (34, 49, 50–57)
 */
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { vi } from "date-fns/locale";
import { toast } from "sonner";
import {
  Check,
  X,
  Loader2,
  TrendingUp,
  TrendingDown,
  Package,
  AlertTriangle,
  Truck,
  CreditCard,
  Image,
  FileText,
  Banknote,
  Pencil,
  Plus,
  FolderSearch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  usePaymentRequest,
  usePaymentRequestItems,
  useApprovePaymentRequest,
  useRejectPaymentRequest,
  useMarkDelivered,
  useMarkPaid,
  useUpdatePaymentRequest,
  getPaymentRequestImageUrl,
  getAllocatedAmount,
  getRemainingPaymentAmount,
  hasOutstandingPayment,
  useSetPaymentRequestRequiresReceipt,
  PaymentRequestReceiptError,
} from "@/hooks/usePaymentRequests";
import { isReceiptRequired } from "@/lib/payment-request-receipt";
import "@/styles/bmq-payment-detail.css";
import { CreateInvoiceFromRequestDialog } from "./CreateInvoiceFromRequestDialog";
import { EditPaymentRequestDialog } from "./EditPaymentRequestDialog";
import { DriveImportProgressDialog } from "@/components/payment-requests/DriveImportProgressDialog";
import { UncApprovalDialog } from "@/components/payment-requests/UncApprovalDialog";
import { PaymentUncEvidenceSection } from "@/components/payment-requests/PaymentUncEvidenceSection";
import { CashSettlementPanel } from "@/components/payment-requests/CashSettlementPanel";
import { PaymentRequestAttachmentsStrip } from "@/components/payment-requests/PaymentRequestAttachmentsStrip";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useGoodsReceipt } from "@/hooks/useGoodsReceipts";
import { usePurchaseOrder } from "@/hooks/usePurchaseOrders";
import { useFinanceReconciliationFlags } from "@/hooks/useFinanceReconciliationFlags";
import { financeReconciliationLabel, sortFlags } from "@/lib/finance-reconciliation-flags";
import "@/styles/bmq-urgent-payables.css";
import "@/styles/bmq-reconciliation.css";

interface PaymentRequestDetailsDialogProps {
  requestId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "panel": non-modal detail pane beside the list (wide desktop, Demo 3 master–detail). */
  presentation?: "dialog" | "panel";
  /** Open another request (used by the "UNC này còn trả cho" list). */
  onSelectRequest?: (requestId: string) => void;
}

// Server-authority reject RPC errors (stage 3B) shown in plain Vietnamese.
const rejectErrorMessage = (error: unknown) => {
  const raw = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message ?? "") : String(error ?? "");
  if (raw.includes("insufficient_privilege")) return "Anh/chị chưa có quyền từ chối phiếu chi.";
  if (raw.includes("invalid_status")) return "Phiếu không còn ở trạng thái chờ duyệt nên không từ chối được. Hãy tải lại danh sách.";
  if (raw.includes("has_payments")) return "Phiếu đã có thanh toán nên không từ chối được.";
  if (raw.includes("rejection_reason_required")) return "Lý do từ chối cần ít nhất 3 ký tự.";
  return raw ? `Không từ chối được phiếu: ${raw}` : "Không từ chối được phiếu.";
};

export function PaymentRequestDetailsDialog({
  requestId,
  open,
  onOpenChange,
  presentation = "dialog",
  onSelectRequest,
}: PaymentRequestDetailsDialogProps) {
  const asPanel = presentation === "panel";
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [showImageDialog, setShowImageDialog] = useState(false);
  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<"bank_transfer" | "cash">("bank_transfer");
  const [showCreateInvoiceDialog, setShowCreateInvoiceDialog] = useState(false);
  const [showPaidWarningDialog, setShowPaidWarningDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showChangePaymentMethodDialog, setShowChangePaymentMethodDialog] = useState(false);
  const [newPaymentMethod, setNewPaymentMethod] = useState<"bank_transfer" | "cash">("bank_transfer");
  const [showDriveImportDialog, setShowDriveImportDialog] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [showUncDialog, setShowUncDialog] = useState(false);
  const [showNoReceiptDialog, setShowNoReceiptDialog] = useState(false);
  const [noReceiptReason, setNoReceiptReason] = useState("");

  const navigate = useNavigate();
  const { user, isOwner, canEditModule } = useAuth();
  const setRequiresReceipt = useSetPaymentRequestRequiresReceipt();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const { data: request, isLoading: requestLoading } = usePaymentRequest(requestId);
  const { data: items, isLoading: itemsLoading } = usePaymentRequestItems(requestId);
  
  // Fetch linked goods receipt if exists
  const goodsReceiptId = request?.goods_receipt_id;
  const { data: linkedGoodsReceipt } = useGoodsReceipt(goodsReceiptId || null);
  
  // Fetch linked purchase order if exists
  const purchaseOrderId = request?.purchase_order_id;
  const { data: linkedPurchaseOrder } = usePurchaseOrder(purchaseOrderId || null);

  // Everything already paid against this PO, across every phiếu (Chặn chi vượt PO).
  const { data: poPaid } = useQuery({
    queryKey: ["purchase-order-paid", purchaseOrderId],
    enabled: !!purchaseOrderId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_requests")
        .select("id, request_number, status, payment_allocations(amount)")
        .eq("purchase_order_id", purchaseOrderId as string);
      if (error) throw error;
      const rows = (data ?? []) as Array<{ id: string; request_number: string; status: string; payment_allocations: Array<{ amount: number }> | null }>;
      const open = rows.filter((r) => r.status !== "rejected");
      const paid = rows.reduce((sum, r) => sum + (r.payment_allocations ?? []).reduce((s2, a) => s2 + Number(a.amount || 0), 0), 0);
      return { paid, openCount: open.length, others: open.filter((r) => r.id !== requestId).map((r) => r.request_number) };
    },
  });
  const { data: detailFlags } = useFinanceReconciliationFlags({
    entityIds: [requestId, purchaseOrderId].filter((v): v is string => !!v),
    enabled: !!requestId,
  });
  const openDetailFlags = sortFlags((detailFlags ?? []).filter((f) => !f.review_status || f.review_status === "needs_action"));
  
  const approveRequest = useApprovePaymentRequest();
  const rejectRequest = useRejectPaymentRequest();
  const markDelivered = useMarkDelivered();
  const markPaid = useMarkPaid();
  const updateRequest = useUpdatePaymentRequest();

  const { data: imageUrl } = useQuery({
    queryKey: ["payment-request-image", request?.image_url],
    queryFn: async () => {
      if (!request?.image_url) return null;
      return getPaymentRequestImageUrl(request.image_url);
    },
    enabled: !!request?.image_url,
  });

  const isLoading = requestLoading || itemsLoading;
  const allocatedAmount = request ? getAllocatedAmount(request) : 0;
  const remainingAmount = request ? getRemainingPaymentAmount(request) : 0;
  // VAT / thuế / dịch vụ: no delivery, no invoice; complete once paid.
  const needsReceipt = request ? isReceiptRequired(request) : true;
  const canEditRequests = isOwner || canEditModule("payment_requests");
  const cashSettlementStatus = (request as { cash_settlement_status?: string | null } | undefined)?.cash_settlement_status ?? null;
  const canMarkNoReceipt = !!request && needsReceipt && canEditRequests && request.status !== "rejected"
    && !request.goods_receipt_id && !request.purchase_order_id;

  const noReceiptError = (error: unknown) => {
    const code = error instanceof PaymentRequestReceiptError ? error.code : "unknown";
    if (code === "receipt_linked") return "Phiếu đã gắn PO hoặc phiếu nhập nên không đổi được.";
    if (code === "reason_required") return "Ghi lý do (ít nhất 3 ký tự).";
    if (code === "insufficient_privilege") return "Anh/chị chưa có quyền sửa phiếu chi.";
    if (code === "invalid_status") return "Phiếu đã bị từ chối.";
    return "Không đổi được loại phiếu. Thử lại.";
  };
  const saveRequiresReceipt = async (requiresReceipt: boolean) => {
    if (!requestId) return;
    try {
      await setRequiresReceipt.mutateAsync({ id: requestId, requiresReceipt, reason: requiresReceipt ? null : noReceiptReason.trim() });
      toast.success(requiresReceipt ? "Đã chuyển lại thành phiếu mua hàng" : "Đã đánh dấu chi không nhập kho");
      setShowNoReceiptDialog(false);
      setNoReceiptReason("");
    } catch (error) {
      toast.error(noReceiptError(error));
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  // Demo 3 chips: soft pill + coloured dot.
  const chip = (label: string, tone: "green" | "amber" | "red" | "blue" | "neutral" = "neutral", icon?: ReactNode) => (
    <span className={cn("d3-prd-chip", tone !== "neutral" && `is-${tone}`)}>
      {icon}
      {label}
    </span>
  );

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return chip("Chờ duyệt", "amber");
      case "approved":
        return chip("Đã duyệt", "green");
      case "rejected":
        return chip("Từ chối", "red");
      default:
        return chip(status);
    }
  };

  const getDeliveryStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return chip("Chưa giao", "neutral", <Truck className="h-3 w-3" />);
      case "delivered":
        return chip("Đã giao", "green", <Truck className="h-3 w-3" />);
      default:
        return chip(status);
    }
  };

  const getPaymentStatusBadge = (status: string) => {
    switch (status) {
      case "unpaid":
        return chip("Chưa thanh toán", "red");
      case "partial":
        return chip("Trả một phần", "amber");
      case "paid":
        return chip("Đã thanh toán", "green");
      case "overpaid":
        return chip("Thanh toán dư", "blue");
      default:
        return chip(status);
    }
  };

  const getPaymentMethodBadge = (method: string | null) => {
    switch (method) {
      case "bank_transfer":
        return chip("UNC", "neutral", <CreditCard className="h-3 w-3" />);
      case "cash":
        return chip("Tiền mặt", "neutral", <Banknote className="h-3 w-3" />);
      default:
        return null;
    }
  };

  const handleOpenApproveDialog = () => {
    // Pre-fill with the payment method chosen during creation
    setPaymentMethod((request?.payment_method as "bank_transfer" | "cash") || "bank_transfer");
    setShowApproveDialog(true);
  };

  const handleApprove = async () => {
    if (!requestId) return;
    await approveRequest.mutateAsync({ id: requestId, paymentMethod });
    setShowApproveDialog(false);
  };

  const handleReject = async () => {
    if (!requestId) return;
    try {
      await rejectRequest.mutateAsync({ id: requestId, reason: rejectionReason });
    } catch (error) {
      toast.error(rejectErrorMessage(error));
      return;
    }
    setShowRejectDialog(false);
    setRejectionReason("");
  };

  const handleMarkDelivered = async () => {
    if (!requestId) return;
    await markDelivered.mutateAsync(requestId);
  };

  const handleMarkPaidClick = () => {
    setPaymentAmount(String(remainingAmount || request?.total_amount || 0));
    setShowPaidWarningDialog(true);
  };

  const handleMarkPaid = async () => {
    if (!requestId) return;
    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Số tiền thanh toán không hợp lệ");
      return;
    }
    if (amount > remainingAmount) {
      toast.error("Số tiền thanh toán lớn hơn số còn lại");
      return;
    }
    await markPaid.mutateAsync({ id: requestId, amount });
    setShowPaidWarningDialog(false);
    setPaymentAmount("");
  };

  const handleOpenChangePaymentMethod = () => {
    setNewPaymentMethod((request?.payment_method as "bank_transfer" | "cash") || "bank_transfer");
    setShowChangePaymentMethodDialog(true);
  };

  const handleChangePaymentMethod = async () => {
    if (!requestId) return;
    await updateRequest.mutateAsync({ id: requestId, payment_method: newPaymentMethod });
    setShowChangePaymentMethodDialog(false);
  };

  if (!open) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange} modal={!asPanel}>
        <DialogContent
          data-bmq-payment-detail={asPanel ? "panel" : "dialog"}
          // The panel sits beside the list: clicking another row must switch, not close.
          onInteractOutside={asPanel ? (event) => event.preventDefault() : undefined}
          className={
            asPanel
              ? "d3-prd d3-pr-panel grid-cols-[minmax(0,1fr)] gap-0 overflow-x-hidden overflow-y-auto overscroll-contain p-0 sm:p-6 [&>button]:right-4 [&>button]:top-4 [&>button]:flex [&>button]:h-10 [&>button]:w-10 [&>button]:items-center [&>button]:justify-center"
              : "d3-prd grid-cols-[minmax(0,1fr)] !inset-0 !left-0 !top-0 h-screen h-[100dvh] max-h-screen max-h-[100dvh] w-full max-w-none !translate-x-0 !translate-y-0 touch-pan-y gap-0 overflow-x-hidden overflow-y-auto overscroll-contain border-0 p-0 [-webkit-overflow-scrolling:touch] [&>button]:top-[max(1rem,env(safe-area-inset-top))] [&>button]:right-[max(1rem,env(safe-area-inset-right))] [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center sm:!left-1/2 sm:!top-1/2 sm:h-auto sm:max-h-[90dvh] sm:max-w-4xl sm:!-translate-x-1/2 sm:!-translate-y-1/2 sm:gap-4 sm:rounded-lg sm:border sm:p-6"
          }
        >
          <DialogHeader className="d3-prd-head sticky top-0 z-20 pb-4 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(3.75rem,calc(2.75rem+env(safe-area-inset-right)))] pt-[max(1rem,env(safe-area-inset-top))] text-left sm:static sm:p-0 sm:pr-12">
            <span className="d3-prd-tag">Duyệt chi · {request?.request_number || "…"}</span>
            <DialogTitle className="d3-prd-title">{request?.suppliers?.name || "Chi tiết đề nghị duyệt chi"}</DialogTitle>
            <DialogDescription className="d3-prd-sub">{request?.title || ""}</DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : request ? (
            <div className="d3-prd-body min-w-0 pb-4 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-3 sm:p-0 sm:pt-4">
              {/* Paid but no goods-receipt invoice yet (goods requests only) */}
              {needsReceipt && request.payment_status === "paid" && !request.invoice_created && (
                <p className="d3-prd-note is-bad" role="alert" data-bmq-invoice-warning>
                  <AlertTriangle className="h-4 w-4" />
                  <span>{t.invoiceWarningDesc}</span>
                </p>
              )}

              {/* Amount + status */}
              <section className="d3-prd-hero">
                <div className="d3-prd-amt" data-bmq-prd-amount>
                  {new Intl.NumberFormat("vi-VN").format(Math.round(Number(request.total_amount || 0)))}
                  <small>đ</small>
                </div>
                {request.vat_amount > 0 && (
                  <p className="d3-prd-line">
                    Tạm tính {formatCurrency((request.total_amount || 0) - (request.vat_amount || 0))} · VAT {formatCurrency(request.vat_amount || 0)}
                  </p>
                )}
                {allocatedAmount > 0 && (
                  <p className="d3-prd-line">
                    Đã trả <b>{formatCurrency(allocatedAmount)}</b> · Còn lại <b>{formatCurrency(remainingAmount)}</b>
                  </p>
                )}
                <div className="d3-prd-chips" data-bmq-prd-chips>
                  {getStatusBadge(request.status)}
                  {getPaymentStatusBadge(request.payment_status)}
                  {getPaymentMethodBadge(request.payment_method)}
                  {needsReceipt ? getDeliveryStatusBadge(request.delivery_status) : (
                    <span className="d3-prd-chip" data-bmq-no-receipt-badge>
                      <FileText className="h-3 w-3" />
                      Không nhập kho
                    </span>
                  )}
                  {request.goods_receipt_id && (
                    <span className="d3-prd-chip is-green">
                      <Package className="h-3 w-3" />
                      Công nợ từ nhập kho
                    </span>
                  )}
                </div>
              </section>

              {!needsReceipt && (
                <p className="d3-prd-note" data-bmq-no-receipt-note>
                  <FileText className="h-4 w-4" />
                  <span>Chi không nhập kho{request.no_receipt_reason ? `: ${request.no_receipt_reason}` : ""}. Không cần giao hàng hay hóa đơn nhập kho.</span>
                </p>
              )}

              {request.rejection_reason && (
                <p className="d3-prd-note is-bad">
                  <X className="h-4 w-4" />
                  <span>Lý do từ chối: {request.rejection_reason}</span>
                </p>
              )}

              {/* Facts */}
              <section className="d3-prd-card">
                <dl className="d3-prd-facts">
                  <div>
                    <dt>Mã đề nghị</dt>
                    <dd className="is-mono">{request.request_number}</dd>
                  </div>
                  <div>
                    <dt>Ngày tạo</dt>
                    <dd>{format(new Date(request.created_at), "dd/MM/yyyy HH:mm", { locale: vi })}</dd>
                  </div>
                  <div>
                    <dt>Nhà cung cấp</dt>
                    <dd>{request.suppliers?.name || "Không xác định"}</dd>
                  </div>
                  <div>
                    <dt>Loại thanh toán</dt>
                    <dd>{request.payment_type === "new_order" ? "Đơn mới" : "Đơn cũ (công nợ)"}</dd>
                  </div>
                  <div>
                    <dt>{t.invoiceStatus}</dt>
                    <dd>
                      {request.invoice_created ? (
                        <span className="d3-prd-dot is-green">{t.invoiceCreated}</span>
                      ) : !needsReceipt ? (
                        <span className="d3-prd-dot" data-bmq-no-receipt-invoice>Không cần hóa đơn nhập kho</span>
                      ) : (
                        <span className="d3-prd-dot is-red">{t.invoiceNotCreated}</span>
                      )}
                    </dd>
                  </div>
                  {request.description && (
                    <div className="is-wide">
                      <dt>Mô tả</dt>
                      <dd>{request.description}</dd>
                    </div>
                  )}
                </dl>
              </section>

              {openDetailFlags.length > 0 && (
                <section className="d3-prd-card" data-bmq-pr-flags>
                  <h3>Cảnh báo đối soát</h3>
                  <div className="d3-rc-chips">
                    {openDetailFlags.map((f) => (
                      <span key={f.flag_key} className={cn("d3-up-chip", f.priority === "critical" ? "is-ink" : f.priority === "high" ? "is-red" : "is-amber")} data-bmq-pr-flag={f.label}>
                        {financeReconciliationLabel(f.label)}{f.entity_type === "purchase_order" ? ` · ${f.entity_ref}` : ""}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {/* Linked documents */}
              {(request.goods_receipt_id || linkedGoodsReceipt || linkedPurchaseOrder || imageUrl) && (
                <section className="d3-prd-card">
                  <h3>Chứng từ liên kết</h3>
                  <ul className="d3-prd-links">
                    {(linkedGoodsReceipt || request.goods_receipt_id) && (
                      <li>
                        <Package className="h-4 w-4" />
                        <span>
                          <b>Phiếu nhập {linkedGoodsReceipt?.receipt_number || request.goods_receipts?.receipt_number || request.goods_receipt_id}</b>
                          {linkedGoodsReceipt && (
                            <small>{linkedGoodsReceipt.suppliers?.name || "N/A"} · {format(new Date(linkedGoodsReceipt.receipt_date), "dd/MM/yyyy", { locale: vi })}</small>
                          )}
                        </span>
                      </li>
                    )}
                    {linkedPurchaseOrder && (
                      <li>
                        <FileText className="h-4 w-4" />
                        <span>
                          <b>PO {linkedPurchaseOrder.po_number}</b>
                          <small>{linkedPurchaseOrder.suppliers?.name || "N/A"} · {format(new Date(linkedPurchaseOrder.order_date), "dd/MM/yyyy", { locale: vi })}</small>
                          {(() => {
                            const poTotal = Number(linkedPurchaseOrder.total_amount ?? 0);
                            if (!poPaid) return null;
                            const left = poTotal - poPaid.paid;
                            return (
                              <span className="d3-prd-po" data-bmq-pr-po-value>
                                <span>Giá trị PO <b>{formatCurrency(poTotal)}</b> · đã chi cho PO <b className={cn(left < 0 && "is-red")}>{formatCurrency(poPaid.paid)}</b></span>
                                <span className={cn(left < 0 && "is-red")}>
                                  {left < 0 ? `Vượt PO ${formatCurrency(-left)}` : `Còn được chi ${formatCurrency(left)}`}
                                  {poPaid.others.length > 0 && ` · PO còn ${poPaid.others.length === 1 ? "phiếu" : `${poPaid.others.length} phiếu`} ${poPaid.others.join(", ")}`}
                                </span>
                              </span>
                            );
                          })()}
                        </span>
                      </li>
                    )}
                    {imageUrl && (
                      <li>
                        <Image className="h-4 w-4" />
                        <button type="button" className="d3-prd-linkbtn" onClick={() => setShowImageDialog(true)}>
                          Xem hóa đơn đính kèm
                        </button>
                      </li>
                    )}
                  </ul>
                </section>
              )}

              {/* Payment evidence (UNC / bank slip) right under the linked documents, so it is
                  visible without scrolling past the item list. */}
              <PaymentUncEvidenceSection
                requestId={requestId}
                enabled={allocatedAmount > 0}
                onSelectRequest={onSelectRequest}
                title={request.payment_method === "cash" ? "CEO chuyển tiền cho nhân viên" : undefined}
              />

              {/* Chi tiền mặt: receipts the staff member uploaded for each khoản. */}
              {request.payment_method === "cash" && cashSettlementStatus && (
                <section className="d3-prd-card" data-bmq-pr-cash-settle>
                  <CashSettlementPanel requestId={request.id} canEdit={false} />
                  {cashSettlementStatus === "awaiting_receipts" && (canEditRequests || request.created_by === user?.id) && (
                    <Button
                      variant="outline"
                      className="w-full sm:w-auto"
                      onClick={() => {
                        onOpenChange(false);
                        navigate(`/payment-requests/cash-settle/${request.id}`);
                      }}
                      data-bmq-pr-cash-settle-open
                    >
                      Nộp chứng từ chi lẻ
                    </Button>
                  )}
                </section>
              )}

              <PaymentRequestAttachmentsStrip requestId={request.id} />

              {/* Items */}
              <section className="d3-prd-card">
                <h3>Sản phẩm{items?.length ? ` · ${items.length}` : ""}</h3>
                {!items?.length ? (
                  <p className="d3-prd-empty">Phiếu chưa có dòng sản phẩm.</p>
                ) : (
                  <ul className="d3-prd-items">
                    {items.map((item) => (
                      <li key={item.id}>
                        <div className="d3-prd-item-main">
                          <b>{item.product_name}</b>
                          <small>
                            {item.product_code ? `${item.product_code} · ` : ""}
                            {item.quantity} {item.unit} × {formatCurrency(item.unit_price)}
                          </small>
                          <span className="d3-prd-item-tags">
                            {item.last_price ? (
                              <span className={cn("d3-prd-mini", item.price_change_percent !== null && item.price_change_percent > 0 && "is-red", item.price_change_percent !== null && item.price_change_percent <= 0 && "is-green")}>
                                {item.price_change_percent !== null ? (
                                  <>
                                    {item.price_change_percent > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                                    {Math.abs(item.price_change_percent).toFixed(1)}% · lần trước {formatCurrency(item.last_price)}
                                  </>
                                ) : (
                                  <>Lần trước {formatCurrency(item.last_price)}</>
                                )}
                              </span>
                            ) : (
                              <span className="d3-prd-mini">Chưa có giá lần trước</span>
                            )}
                            {item.inventory_items ? (
                              <span className="d3-prd-mini">Tồn {item.inventory_items.quantity}</span>
                            ) : (
                              <span className="d3-prd-mini is-amber">Sản phẩm mới</span>
                            )}
                          </span>
                        </div>
                        <span className="d3-prd-item-amt">{formatCurrency(item.line_total || 0)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {request.notes && (
                <section className="d3-prd-card">
                  <h3>Ghi chú</h3>
                  <p className="d3-prd-text">{request.notes}</p>
                </section>
              )}

              {/* Actions */}
              <div className="d3-prd-actions sticky bottom-0 z-20 -ml-[max(1rem,env(safe-area-inset-left))] -mr-[max(1rem,env(safe-area-inset-right))] grid grid-cols-2 gap-2 border-t border-border bg-background pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-4 [transform:translateZ(0)] [&>button]:min-h-11 sm:static sm:mx-0 sm:flex sm:flex-wrap sm:p-0 sm:pt-4 sm:[&>button]:min-h-10">
                {/* CEO: approve and record the payment in one step with the bank UNC. */}
                {request.status === "pending" && isOwner && request.payment_status === "unpaid" && (
                  <Button
                    onClick={() => setShowUncDialog(true)}
                    className="d3-prd-btn is-primary col-span-2 w-full gap-2 whitespace-nowrap sm:w-auto"
                    data-bmq-unc-open
                  >
                    <CreditCard className="h-4 w-4" />
                    Duyệt bằng UNC
                  </Button>
                )}

                {/* Edit button for pending requests */}
                {request.status === "pending" && (
                  <Button
                    variant="outline"
                    onClick={() => setShowEditDialog(true)}
                    className="w-full gap-2 whitespace-nowrap sm:w-auto"
                  >
                    <Pencil className="h-4 w-4" />
                    {t.edit}
                  </Button>
                )}

                {/* Any authenticated user can approve/reject pending requests */}
                {request.status === "pending" && (
                  <>
                    <Button
                      onClick={handleOpenApproveDialog}
                      disabled={approveRequest.isPending}
                      className="d3-prd-btn is-go w-full gap-2 whitespace-nowrap sm:w-auto"
                    >
                      {approveRequest.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      Duyệt
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setShowRejectDialog(true)}
                      className="d3-prd-btn is-danger w-full gap-2 whitespace-nowrap sm:w-auto"
                    >
                      <X className="h-4 w-4" />
                      Từ chối
                    </Button>
                  </>
                )}

                {/* Mark as delivered (only for approved requests) */}
                {needsReceipt && request.status === "approved" && request.delivery_status === "pending" && (
                  <Button
                    onClick={handleMarkDelivered}
                    disabled={markDelivered.isPending}
                    variant="outline"
                    className="w-full gap-2 whitespace-nowrap sm:w-auto"
                  >
                    {markDelivered.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Truck className="h-4 w-4" />
                    )}
                    <span className="sm:hidden">Đã giao</span>
                    <span className="hidden sm:inline">Đánh dấu đã giao</span>
                  </Button>
                )}

                {/* Create Invoice buttons (for approved requests without invoice) */}
                {needsReceipt && request.status === "approved" && !request.invoice_created && (
                  <>
                    <Button 
                      variant="outline" 
                      onClick={() => setShowDriveImportDialog(true)}
                      className="w-full gap-2 whitespace-nowrap sm:w-auto"
                    >
                      <FolderSearch className="h-4 w-4" />
                      <span className="sm:hidden">Tạo từ Drive</span>
                      <span className="hidden sm:inline">Tạo hoá đơn từ GG Drive</span>
                    </Button>
                    <Button variant="outline" className="w-full whitespace-nowrap sm:w-auto" onClick={() => setShowCreateInvoiceDialog(true)}>
                      <Plus className="h-4 w-4 mr-2" />
                      <span className="sm:hidden">Tạo thủ công</span>
                      <span className="hidden sm:inline">Tạo hoá đơn thủ công</span>
                    </Button>
                  </>
                )}

                {/* Mark as paid (only for approved requests) */}
                {request.status === "approved" && hasOutstandingPayment(request) && (
                  <Button
                    onClick={handleMarkPaidClick}
                    disabled={markPaid.isPending}
                    variant="outline"
                    className="w-full gap-2 whitespace-nowrap sm:w-auto"
                  >
                    {markPaid.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CreditCard className="h-4 w-4" />
                    )}
                    <span className="sm:hidden">Thanh toán</span>
                    <span className="hidden sm:inline">Ghi nhận thanh toán</span>
                  </Button>
                )}

                {/* Change Payment Method (for approved requests) */}
                {request.status === "approved" && (
                  <Button
                    onClick={handleOpenChangePaymentMethod}
                    variant="outline"
                    className="w-full gap-2 whitespace-nowrap sm:w-auto"
                  >
                    {request.payment_method === "cash" ? (
                      <Banknote className="h-4 w-4" />
                    ) : (
                      <CreditCard className="h-4 w-4" />
                    )}
                    Đổi PTTT
                  </Button>
                )}

                {canMarkNoReceipt && (
                  <Button
                    variant="outline"
                    onClick={() => setShowNoReceiptDialog(true)}
                    className="w-full gap-2 whitespace-nowrap sm:w-auto"
                    data-bmq-no-receipt-open
                  >
                    <FileText className="h-4 w-4" />
                    <span className="sm:hidden">Không nhập kho</span>
                    <span className="hidden sm:inline">Chi không nhập kho</span>
                  </Button>
                )}
                {!needsReceipt && canEditRequests && request.status !== "rejected" && (
                  <Button
                    variant="outline"
                    onClick={() => void saveRequiresReceipt(true)}
                    disabled={setRequiresReceipt.isPending}
                    className="w-full gap-2 whitespace-nowrap sm:w-auto"
                    data-bmq-no-receipt-undo
                  >
                    <Package className="h-4 w-4" />
                    <span className="sm:hidden">Có nhập kho</span>
                    <span className="hidden sm:inline">Chuyển lại phiếu mua hàng</span>
                  </Button>
                )}

                <Button className="w-full whitespace-nowrap sm:w-auto" variant="outline" onClick={() => onOpenChange(false)}>
                  Đóng
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-center py-8 text-muted-foreground">Không tìm thấy đề nghị</p>
          )}
        </DialogContent>
      </Dialog>

      {request && (
        <UncApprovalDialog
          open={showUncDialog}
          onOpenChange={setShowUncDialog}
          mode="approve"
          requests={[
            {
              id: request.id,
              requestNumber: request.request_number,
              supplierName: request.suppliers?.name ?? null,
              supplierId: request.supplier_id ?? null,
              totalAmount: Number(request.total_amount || 0),
              allocatedAmount: allocatedAmount,
              status: request.status,
              paymentStatus: request.payment_status,
              createdBy: request.created_by ?? null,
            },
          ]}
        />
      )}

      <AlertDialog open={showNoReceiptDialog} onOpenChange={(open) => { setShowNoReceiptDialog(open); if (!open) setNoReceiptReason(""); }}>
        <AlertDialogContent data-bmq-no-receipt-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle>Chi không nhập kho</AlertDialogTitle>
            <AlertDialogDescription>
              Dùng cho VAT, thuế, dịch vụ, phí. Phiếu sẽ không cần giao hàng hay hóa đơn nhập kho và hoàn tất khi đã trả.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={noReceiptReason}
            onChange={(e) => setNoReceiptReason(e.target.value)}
            placeholder="Lý do, ví dụ: Thuế VAT HĐ317"
            aria-label="Lý do chi không nhập kho"
            rows={2}
            maxLength={200}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
            <Button
              onClick={() => void saveRequiresReceipt(false)}
              disabled={noReceiptReason.trim().length < 3 || setRequiresReceipt.isPending}
              data-bmq-no-receipt-save
            >
              {setRequiresReceipt.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Xác nhận
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Approve Dialog with Payment Method Selection */}
      <AlertDialog open={showApproveDialog} onOpenChange={setShowApproveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.selectPaymentMethod}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.selectPaymentMethodDesc}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <RadioGroup value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as "bank_transfer" | "cash")}>
              <div className="flex items-center space-x-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/50">
                <RadioGroupItem value="bank_transfer" id="bank_transfer" />
                <Label htmlFor="bank_transfer" className="flex items-center gap-2 cursor-pointer flex-1">
                  <CreditCard className="h-5 w-5 text-blue-600" />
                  <div>
                    <p className="font-medium">{t.bankTransfer}</p>
                    <p className="text-sm text-muted-foreground">Chuyển khoản ngân hàng</p>
                  </div>
                </Label>
              </div>
              <div className="flex items-center space-x-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/50">
                <RadioGroupItem value="cash" id="cash" />
                <Label htmlFor="cash" className="flex items-center gap-2 cursor-pointer flex-1">
                  <Banknote className="h-5 w-5 text-orange-600" />
                  <div>
                    <p className="font-medium">{t.cash}</p>
                    <p className="text-sm text-muted-foreground">Thanh toán bằng tiền mặt</p>
                  </div>
                </Label>
              </div>
            </RadioGroup>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleApprove}
              disabled={approveRequest.isPending}
              className="bg-green-600 hover:bg-green-700"
            >
              {approveRequest.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Check className="h-4 w-4 mr-2" />
              )}
              {t.confirmApprove}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject Dialog */}
      <AlertDialog open={showRejectDialog} onOpenChange={setShowRejectDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Từ chối đề nghị chi</AlertDialogTitle>
            <AlertDialogDescription>
              Vui lòng nhập lý do từ chối đề nghị này.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Textarea
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Lý do từ chối..."
              rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReject}
              disabled={!rejectionReason.trim() || rejectRequest.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {rejectRequest.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Từ chối
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Record payment allocation */}
      <AlertDialog open={showPaidWarningDialog} onOpenChange={setShowPaidWarningDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className={cn("flex items-center gap-2", !request?.invoice_created && "text-destructive")}>
              {!request?.invoice_created ? <AlertTriangle className="h-5 w-5" /> : <CreditCard className="h-5 w-5" />}
              {!request?.invoice_created ? t.invoiceWarning : "Ghi nhận thanh toán"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {!request?.invoice_created && <p>{t.invoiceWarningDesc}</p>}
                <div className="grid gap-2">
                  <Label htmlFor="payment-amount">Số tiền thanh toán lần này</Label>
                  <Input
                    id="payment-amount"
                    type="number"
                    min="0"
                    max={remainingAmount}
                    value={paymentAmount}
                    onChange={(event) => setPaymentAmount(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Còn lại: {formatCurrency(remainingAmount)}
                  </p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowPaidWarningDialog(false)}>
              {t.cancel}
            </AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                setShowPaidWarningDialog(false);
                setShowCreateInvoiceDialog(true);
              }}
            >
              <FileText className="h-4 w-4 mr-2" />
              {t.createInvoiceFirst}
            </Button>
            <AlertDialogAction
              onClick={handleMarkPaid}
              disabled={markPaid.isPending}
              className={cn(!request?.invoice_created && "bg-destructive hover:bg-destructive/90")}
            >
              {markPaid.isPending ? "Đang lưu..." : t.stillMarkPaid}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Image Dialog */}
      <AlertDialog open={showImageDialog} onOpenChange={setShowImageDialog}>
        <AlertDialogContent className="max-w-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Hóa đơn đính kèm</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="max-h-[70vh] overflow-auto">
            {imageUrl && <img src={imageUrl} alt="Invoice" className="w-full rounded" />}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Invoice from Request Dialog */}
      <CreateInvoiceFromRequestDialog
        requestId={requestId}
        open={showCreateInvoiceDialog}
        onOpenChange={setShowCreateInvoiceDialog}
        onInvoiceCreated={(invoiceId) => {
          setShowCreateInvoiceDialog(false);
          onOpenChange(false); // Close all dialogs, return to list
          toast.success("Đã tạo hóa đơn thành công!", {
            description: "Hóa đơn đã được tạo và liên kết với đề nghị chi.",
            action: {
              label: "Xem hóa đơn",
              onClick: () => navigate(`/invoices?view=${invoiceId}`),
            },
          });
        }}
      />

      {/* Edit Payment Request Dialog */}
      <EditPaymentRequestDialog
        requestId={requestId}
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
      />

      {/* Change Payment Method Dialog */}
      <AlertDialog open={showChangePaymentMethodDialog} onOpenChange={setShowChangePaymentMethodDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Đổi phương thức thanh toán</AlertDialogTitle>
            <AlertDialogDescription>
              Chọn phương thức thanh toán mới cho đề nghị chi này.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <RadioGroup value={newPaymentMethod} onValueChange={(v) => setNewPaymentMethod(v as "bank_transfer" | "cash")}>
              <div className="flex items-center space-x-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/50">
                <RadioGroupItem value="bank_transfer" id="change_bank_transfer" />
                <Label htmlFor="change_bank_transfer" className="flex items-center gap-2 cursor-pointer flex-1">
                  <CreditCard className="h-5 w-5 text-blue-600" />
                  <div>
                    <p className="font-medium">{t.bankTransfer}</p>
                    <p className="text-sm text-muted-foreground">Chuyển khoản ngân hàng</p>
                  </div>
                </Label>
              </div>
              <div className="flex items-center space-x-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/50">
                <RadioGroupItem value="cash" id="change_cash" />
                <Label htmlFor="change_cash" className="flex items-center gap-2 cursor-pointer flex-1">
                  <Banknote className="h-5 w-5 text-orange-600" />
                  <div>
                    <p className="font-medium">{t.cash}</p>
                    <p className="text-sm text-muted-foreground">Thanh toán bằng tiền mặt</p>
                  </div>
                </Label>
              </div>
            </RadioGroup>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleChangePaymentMethod}
              disabled={updateRequest.isPending}
            >
              {updateRequest.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Check className="h-4 w-4 mr-2" />
              )}
              Lưu thay đổi
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Drive Import Dialog for bank slip scanning */}
      <DriveImportProgressDialog
        open={showDriveImportDialog}
        onClose={(success) => {
          setShowDriveImportDialog(false);
          if (success) {
            // Refresh payment request data
            queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
            queryClient.invalidateQueries({ queryKey: ["payment-request"] });
            queryClient.invalidateQueries({ queryKey: ["invoices"] });
            queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
          }
        }}
        importType="bank_slip"
        forceFolderPicker
      />
    </>
  );
}
