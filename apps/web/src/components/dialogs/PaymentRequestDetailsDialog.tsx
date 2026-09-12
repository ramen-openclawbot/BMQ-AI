import { paymentRequestDetails } from "@/i18n/paymentRequestDetails";
/* Hallmark · component: detail-dialog · genre: modern-minimal · tone: technical
 * structure: mobile information workbench · states: default · hover · focus · active · disabled · loading · error · success
 * pre-emit critique: P5 H5 E4 S5 R5 V4 · contrast: pass (40–41) · mobile: pass (34, 49, 50–57)
 */
import { useState } from "react";
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
} from "@/hooks/usePaymentRequests";
import { CreateInvoiceFromRequestDialog } from "./CreateInvoiceFromRequestDialog";
import { EditPaymentRequestDialog } from "./EditPaymentRequestDialog";
import { DriveImportProgressDialog } from "@/components/payment-requests/DriveImportProgressDialog";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useGoodsReceipt } from "@/hooks/useGoodsReceipts";
import { usePurchaseOrder } from "@/hooks/usePurchaseOrders";

interface PaymentRequestDetailsDialogProps {
  requestId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PaymentRequestDetailsDialog({
  requestId,
  open,
  onOpenChange,
}: PaymentRequestDetailsDialogProps) {
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
  
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t, language } = useLanguage();
  const copy = paymentRequestDetails[language];
  const queryClient = useQueryClient();
  const { data: request, isLoading: requestLoading } = usePaymentRequest(requestId);
  const { data: items, isLoading: itemsLoading } = usePaymentRequestItems(requestId);
  
  // Fetch linked goods receipt if exists
  const goodsReceiptId = request?.goods_receipt_id;
  const { data: linkedGoodsReceipt } = useGoodsReceipt(goodsReceiptId || null);
  
  // Fetch linked purchase order if exists
  const purchaseOrderId = request?.purchase_order_id;
  const { data: linkedPurchaseOrder } = usePurchaseOrder(purchaseOrderId || null);
  
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

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="secondary">{copy.pendingApproval}</Badge>;
      case "approved":
        return <Badge className="bg-green-500">{copy.approved}</Badge>;
      case "rejected":
        return <Badge variant="destructive">{copy.rejected}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getDeliveryStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="outline">{copy.notDelivered}</Badge>;
      case "delivered":
        return <Badge className="bg-green-500">{copy.delivered}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getPaymentStatusBadge = (status: string) => {
    switch (status) {
      case "unpaid":
        return <Badge variant="destructive">{copy.unpaid}</Badge>;
      case "partial":
        return <Badge className="bg-amber-500">{copy.partiallyPaid}</Badge>;
      case "paid":
        return <Badge className="bg-green-500">{copy.paid}</Badge>;
      case "overpaid":
        return <Badge className="bg-purple-500">{copy.overpaid}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getPaymentMethodBadge = (method: string | null) => {
    switch (method) {
      case "bank_transfer":
        return (
          <Badge variant="outline" className="gap-1">
            <CreditCard className="h-3 w-3" />
            UNC
          </Badge>
        );
      case "cash":
        return (
          <Badge variant="secondary" className="gap-1">
            <Banknote className="h-3 w-3" />

            {copy.cash}
          </Badge>
        );
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
    await rejectRequest.mutateAsync({ id: requestId, reason: rejectionReason });
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
      toast.error(copy.invalidPaymentAmount);
      return;
    }
    if (amount > remainingAmount) {
      toast.error(copy.paymentAmountExceedsTheRemainingBalance);
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
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="!inset-0 !left-0 !top-0 h-screen h-[100dvh] max-h-screen max-h-[100dvh] w-full max-w-none !translate-x-0 !translate-y-0 touch-pan-y gap-0 overflow-x-hidden overflow-y-auto overscroll-contain border-0 p-0 [-webkit-overflow-scrolling:touch] [&>button]:top-[max(1rem,env(safe-area-inset-top))] [&>button]:right-[max(1rem,env(safe-area-inset-right))] [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center sm:!left-1/2 sm:!top-1/2 sm:h-auto sm:max-h-[90dvh] sm:max-w-4xl sm:!-translate-x-1/2 sm:!-translate-y-1/2 sm:gap-4 sm:rounded-lg sm:border sm:p-6">
          <DialogHeader className="sticky top-0 z-20 border-b border-border bg-background pb-4 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(3.75rem,calc(2.75rem+env(safe-area-inset-right)))] pt-[max(1rem,env(safe-area-inset-top))] text-left sm:static sm:border-0 sm:p-0">
            <DialogTitle className="min-w-0 [overflow-wrap:anywhere] text-xl leading-tight">{copy.paymentRequestDetails}</DialogTitle>
            <DialogDescription className="break-words">
              {request?.request_number} - {request?.title}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : request ? (
            <div className="min-w-0 space-y-4 pb-4 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-4 sm:space-y-6 sm:p-0">
              {/* Warning for paid without invoice */}
              {request.payment_status === "paid" && !request.invoice_created && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    {t.invoiceWarningDesc}
                  </AlertDescription>
                </Alert>
              )}

              {/* Status Badges */}
              <div className="grid min-w-0 grid-cols-2 gap-2 [&>*]:min-w-0 [&>*]:justify-center [&>*]:truncate sm:flex sm:flex-wrap sm:[&>*]:w-auto">
                {getStatusBadge(request.status)}
                {getPaymentMethodBadge(request.payment_method)}
                {getDeliveryStatusBadge(request.delivery_status)}
                {getPaymentStatusBadge(request.payment_status)}
                {request.goods_receipt_id && (
                  <Badge className="col-span-2 gap-1 bg-emerald-600 sm:col-span-1">
                    <Package className="h-3 w-3" />

                    {copy.payableFromGoodsReceipt}
                  </Badge>
                )}
              </div>

              {request.goods_receipt_id && (
                <Alert className="min-w-0">
                  <Package className="h-4 w-4" />
                  <AlertDescription className="min-w-0">
                    <div className="space-y-1">
                      <p className="font-medium">{copy.payableFromGoodsReceipt}</p>
                      <p className="min-w-0 break-words text-sm text-muted-foreground">

                        {copy.goodsReceipt} <span className="break-all font-mono text-xs text-foreground">{request.goods_receipts?.receipt_number || request.goods_receipt_id}</span>
                      </p>
                      <p className="min-w-0 break-words text-sm text-muted-foreground">

                        {copy.linkedPO} <span className="break-all font-mono text-xs text-foreground">{request.purchase_orders?.po_number || request.purchase_order_id || "-"}</span>
                      </p>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              {/* Request Info */}
              <div className="grid min-w-0 grid-cols-1 gap-4 rounded-lg bg-muted/50 p-4 sm:grid-cols-2">
                <div className="min-w-0">
                  <Label className="text-muted-foreground">{copy.requestCode}</Label>
                  <p className="break-all font-mono text-sm font-medium">{request.request_number}</p>
                </div>
                <div className="min-w-0">
                  <Label className="text-muted-foreground">{copy.createdDate}</Label>
                  <p className="font-medium tabular-nums">
                    {format(new Date(request.created_at), "dd/MM/yyyy HH:mm", { locale: vi })}
                  </p>
                </div>
                <div className="min-w-0">
                  <Label className="text-muted-foreground">{copy.supplier}</Label>
                  <p className="break-words font-medium">{request.suppliers?.name || copy.unknown}</p>
                </div>
                <div className="min-w-0 border-t border-border pt-4 sm:border-0 sm:pt-0">
                  <Label className="text-muted-foreground">{copy.totalAmount}</Label>
                  <div className="space-y-1">
                    {request.vat_amount > 0 && (
                      <>
                        <p className="text-sm text-muted-foreground">

                          {copy.subtotal} {formatCurrency((request.total_amount || 0) - (request.vat_amount || 0))}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          VAT: {formatCurrency(request.vat_amount || 0)}
                        </p>
                      </>
                    )}
                    <p className="text-2xl font-bold tabular-nums text-primary">{formatCurrency(request.total_amount || 0)}</p>
                    {allocatedAmount > 0 && (
                      <>
                        <p className="text-sm text-muted-foreground">

                          {copy.paid2} {formatCurrency(allocatedAmount)}
                        </p>
                        <p className="text-sm text-muted-foreground">

                          {copy.remaining} {formatCurrency(remainingAmount)}
                        </p>
                      </>
                    )}
                  </div>
                </div>
                {request.description && (
                  <div className="min-w-0 sm:col-span-2">
                    <Label className="text-muted-foreground">{copy.description}</Label>
                    <p className="break-words">{request.description}</p>
                  </div>
                )}
                {request.rejection_reason && (
                  <div className="min-w-0 sm:col-span-2">
                    <Label className="text-destructive">{copy.rejectionReason}</Label>
                    <p className="text-destructive">{request.rejection_reason}</p>
                  </div>
                )}
                
                {/* Invoice Status */}
                <div>
                  <Label className="text-muted-foreground">{t.invoiceStatus}</Label>
                  <div className="mt-1">
                    {request.invoice_created ? (
                      <Badge className="bg-green-500 gap-1">
                        <Check className="h-3 w-3" />
                        {t.invoiceCreated}
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        {t.invoiceNotCreated}
                      </Badge>
                    )}
                  </div>
                </div>
                
                {/* Payment Type */}
                <div>
                  <Label className="text-muted-foreground">{copy.paymentType}</Label>
                  <div className="mt-1">
                    {request.payment_type === "new_order" ? (
                      <Badge variant="default">{copy.newOrder}</Badge>
                    ) : (
                      <Badge variant="secondary">{copy.existingOrderDebt}</Badge>
                    )}
                  </div>
                </div>
                
                {/* Linked Goods Receipt */}
                {linkedGoodsReceipt && (
                  <div className="min-w-0 sm:col-span-2">
                    <Label className="text-muted-foreground">{copy.linkedGoodsReceipt}</Label>
                    <div className="mt-1 rounded border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-900/20">
                      <div className="flex min-w-0 items-start gap-2">
                        <Package className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                        <div className="min-w-0">
                          <p className="break-all font-medium text-blue-700 dark:text-blue-300">{linkedGoodsReceipt.receipt_number}</p>
                          <p className="break-words text-sm text-muted-foreground">
                            {linkedGoodsReceipt.suppliers?.name || "N/A"} · {format(new Date(linkedGoodsReceipt.receipt_date), "dd/MM/yyyy", { locale: vi })}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Linked Purchase Order */}
                {linkedPurchaseOrder && (
                  <div className="min-w-0 sm:col-span-2">
                    <Label className="text-muted-foreground">{copy.linkedPurchaseOrder}</Label>
                    <div className="mt-1 rounded border border-purple-200 bg-purple-50 p-3 dark:border-purple-800 dark:bg-purple-900/20">
                      <div className="flex min-w-0 items-start gap-2">
                        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-purple-600" />
                        <div className="min-w-0">
                          <p className="break-all font-medium text-purple-700 dark:text-purple-300">{linkedPurchaseOrder.po_number}</p>
                          <p className="break-words text-sm text-muted-foreground">
                            {linkedPurchaseOrder.suppliers?.name || "N/A"} · {format(new Date(linkedPurchaseOrder.order_date), "dd/MM/yyyy", { locale: vi })}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Invoice Image */}
              {imageUrl && (
                <div className="min-w-0">
                  <Label className="text-muted-foreground">{copy.attachedInvoice}</Label>
                  <Button
                    variant="outline"
                    className="mt-2 min-h-11 w-full gap-2 whitespace-nowrap sm:min-h-10 sm:w-auto"
                    onClick={() => setShowImageDialog(true)}
                  >
                    <Image className="h-4 w-4" />

                    {copy.viewInvoice}
                  </Button>
                </div>
              )}

              {/* Items Table */}
              <div className="min-w-0">
                <Label className="text-muted-foreground mb-2 block">{copy.productList}</Label>
                <div className="space-y-3 lg:hidden">
                  {items?.map((item) => (
                    <article key={item.id} className="min-w-0 border-t border-border py-3 first:border-t-0 first:pt-0">
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        {item.product_code || copy.noCode}
                      </p>
                      <p className="mt-1 break-words font-semibold leading-snug">{item.product_name}</p>
                      <p className="mt-3 text-xl font-bold tabular-nums text-primary">
                        {formatCurrency(item.line_total || 0)}
                      </p>

                      <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 text-sm">
                        <dt className="text-muted-foreground">{copy.quantity}</dt>
                        <dd className="min-w-0 break-words text-right font-medium tabular-nums">
                          {item.quantity} {item.unit}
                        </dd>
                        <dt className="text-muted-foreground">{copy.unitPrice}</dt>
                        <dd className="min-w-0 break-words text-right font-medium tabular-nums">
                          {formatCurrency(item.unit_price)}
                        </dd>
                      </dl>

                      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
                        {item.last_price ? (
                          <>
                            <span className="text-xs tabular-nums text-muted-foreground">

                              {copy.latestPrice} {formatCurrency(item.last_price)}
                            </span>
                            {item.price_change_percent !== null && (
                              <Badge
                                variant={item.price_change_percent > 0 ? "destructive" : "default"}
                                className={cn(
                                  "gap-1 px-2 text-xs tabular-nums",
                                  item.price_change_percent <= 0 && "bg-green-500"
                                )}
                              >
                                {item.price_change_percent > 0 ? (
                                  <TrendingUp className="h-3 w-3" />
                                ) : (
                                  <TrendingDown className="h-3 w-3" />
                                )}
                                {Math.abs(item.price_change_percent).toFixed(1)}%
                              </Badge>
                            )}
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">{copy.noRecentPrice}</span>
                        )}

                        {item.inventory_items ? (
                          <Badge variant="outline" className="gap-1 text-xs tabular-nums">
                            <Package className="h-3 w-3" />

                            {copy.stock} {item.inventory_items.quantity}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1 text-xs">
                            <AlertTriangle className="h-3 w-3" />

                            {copy.newProduct}
                          </Badge>
                        )}
                      </div>
                    </article>
                  ))}
                </div>

                <div className="hidden min-w-0 lg:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{copy.productCode}</TableHead>
                        <TableHead>{copy.productName}</TableHead>
                        <TableHead className="text-right">{copy.qty}</TableHead>
                        <TableHead>{copy.unit}</TableHead>
                        <TableHead className="text-right">{copy.unitPrice}</TableHead>
                        <TableHead className="text-right">{copy.amount}</TableHead>
                        <TableHead>{copy.priceComparison}</TableHead>
                        <TableHead>{copy.stock2}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items?.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>{item.product_code || "-"}</TableCell>
                          <TableCell className="font-medium">{item.product_name}</TableCell>
                          <TableCell className="text-right">{item.quantity}</TableCell>
                          <TableCell>{item.unit}</TableCell>
                          <TableCell className="text-right">{formatCurrency(item.unit_price)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(item.line_total || 0)}</TableCell>
                          <TableCell>
                            {item.last_price ? (
                              <div className="flex items-center gap-1">
                                <span className="text-xs text-muted-foreground">
                                  {formatCurrency(item.last_price)}
                                </span>
                                {item.price_change_percent !== null && (
                                  <Badge
                                    variant={item.price_change_percent > 0 ? "destructive" : "default"}
                                    className={cn(
                                      "text-xs px-1",
                                      item.price_change_percent <= 0 && "bg-green-500"
                                    )}
                                  >
                                    {item.price_change_percent > 0 ? (
                                      <TrendingUp className="h-3 w-3 mr-0.5" />
                                    ) : (
                                      <TrendingDown className="h-3 w-3 mr-0.5" />
                                    )}
                                    {Math.abs(item.price_change_percent).toFixed(1)}%
                                  </Badge>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">{copy.none}</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {item.inventory_items ? (
                              <Badge variant="outline" className="text-xs">
                                <Package className="h-3 w-3 mr-0.5" />

                                {copy.stock} {item.inventory_items.quantity}
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-xs">
                                <AlertTriangle className="h-3 w-3 mr-0.5" />

                                {copy.new}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Notes */}
              {request.notes && (
                <div className="min-w-0">
                  <Label className="text-muted-foreground">{copy.notes}</Label>
                  <p className="mt-1 break-words rounded bg-muted/50 p-3">{request.notes}</p>
                </div>
              )}

              {/* Actions */}
              <div className="sticky bottom-0 z-20 -ml-[max(1rem,env(safe-area-inset-left))] -mr-[max(1rem,env(safe-area-inset-right))] grid grid-cols-2 gap-2 border-t border-border bg-background pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-4 [transform:translateZ(0)] [&>button]:min-h-11 sm:static sm:mx-0 sm:flex sm:flex-wrap sm:p-0 sm:pt-4 sm:[&>button]:min-h-10">
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
                      className="w-full gap-2 whitespace-nowrap bg-green-600 hover:bg-green-700 sm:w-auto"
                    >
                      {approveRequest.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}

                      {copy.approve}
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => setShowRejectDialog(true)}
                      className="w-full gap-2 whitespace-nowrap sm:w-auto"
                    >
                      <X className="h-4 w-4" />

                      {copy.reject}
                    </Button>
                  </>
                )}

                {/* Mark as delivered (only for approved requests) */}
                {request.status === "approved" && request.delivery_status === "pending" && (
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
                    <span className="sm:hidden">{copy.delivered}</span>
                    <span className="hidden sm:inline">{copy.markDelivered}</span>
                  </Button>
                )}

                {/* Create Invoice buttons (for approved requests without invoice) */}
                {request.status === "approved" && !request.invoice_created && (
                  <>
                    <Button 
                      variant="outline" 
                      onClick={() => setShowDriveImportDialog(true)}
                      className="w-full gap-2 whitespace-nowrap sm:w-auto"
                    >
                      <FolderSearch className="h-4 w-4" />
                      <span className="sm:hidden">{copy.createFromDrive}</span>
                      <span className="hidden sm:inline">{copy.createInvoiceFromGoogleDrive}</span>
                    </Button>
                    <Button className="w-full whitespace-nowrap sm:w-auto" onClick={() => setShowCreateInvoiceDialog(true)}>
                      <Plus className="h-4 w-4 mr-2" />
                      <span className="sm:hidden">{copy.createManually}</span>
                      <span className="hidden sm:inline">{copy.createInvoiceManually}</span>
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
                    <span className="sm:hidden">{copy.pay}</span>
                    <span className="hidden sm:inline">{copy.recordPayment}</span>
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

                    {copy.changeMethod}
                  </Button>
                )}

                <Button className="w-full whitespace-nowrap sm:w-auto" variant="outline" onClick={() => onOpenChange(false)}>

                  {copy.close}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-center py-8 text-muted-foreground">{copy.requestNotFound}</p>
          )}
        </DialogContent>
      </Dialog>

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
                    <p className="text-sm text-muted-foreground">{copy.bankTransfer}</p>
                  </div>
                </Label>
              </div>
              <div className="flex items-center space-x-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/50">
                <RadioGroupItem value="cash" id="cash" />
                <Label htmlFor="cash" className="flex items-center gap-2 cursor-pointer flex-1">
                  <Banknote className="h-5 w-5 text-orange-600" />
                  <div>
                    <p className="font-medium">{t.cash}</p>
                    <p className="text-sm text-muted-foreground">{copy.cashPayment}</p>
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
            <AlertDialogTitle>{copy.rejectPaymentRequest}</AlertDialogTitle>
            <AlertDialogDescription>

              {copy.enterAReasonForRejectingThisRequest}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Textarea
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder={copy.rejectionReason2}
              rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReject}
              disabled={!rejectionReason.trim() || rejectRequest.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {rejectRequest.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}

              {copy.reject}
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
              {!request?.invoice_created ? t.invoiceWarning : copy.recordPayment}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {!request?.invoice_created && <p>{t.invoiceWarningDesc}</p>}
                <div className="grid gap-2">
                  <Label htmlFor="payment-amount">{copy.paymentAmountThisTime}</Label>
                  <Input
                    id="payment-amount"
                    type="number"
                    min="0"
                    max={remainingAmount}
                    value={paymentAmount}
                    onChange={(event) => setPaymentAmount(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">

                    {copy.remaining} {formatCurrency(remainingAmount)}
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
              {markPaid.isPending ? copy.saving : t.stillMarkPaid}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Image Dialog */}
      <AlertDialog open={showImageDialog} onOpenChange={setShowImageDialog}>
        <AlertDialogContent className="max-w-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.attachedInvoice}</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="max-h-[70vh] overflow-auto">
            {imageUrl && <img src={imageUrl} alt={copy.invoiceAlt} className="w-full rounded" />}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.close}</AlertDialogCancel>
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
          toast.success(copy.invoiceCreatedSuccessfully, {
            description: copy.theInvoiceWasCreatedAndLinkedTo,
            action: {
              label: copy.viewInvoice,
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
            <AlertDialogTitle>{copy.changePaymentMethod}</AlertDialogTitle>
            <AlertDialogDescription>

              {copy.selectANewPaymentMethodForThis}
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
                    <p className="text-sm text-muted-foreground">{copy.bankTransfer}</p>
                  </div>
                </Label>
              </div>
              <div className="flex items-center space-x-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/50">
                <RadioGroupItem value="cash" id="change_cash" />
                <Label htmlFor="change_cash" className="flex items-center gap-2 cursor-pointer flex-1">
                  <Banknote className="h-5 w-5 text-orange-600" />
                  <div>
                    <p className="font-medium">{t.cash}</p>
                    <p className="text-sm text-muted-foreground">{copy.cashPayment}</p>
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

              {copy.saveChanges}
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
