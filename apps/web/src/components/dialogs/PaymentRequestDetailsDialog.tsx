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
  
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const { data: request, isLoading: requestLoading } = usePaymentRequest(requestId);
  const { data: items, isLoading: itemsLoading } = usePaymentRequestItems(requestId);
  
  // Fetch linked goods receipt if exists
  const goodsReceiptId = (request as any)?.goods_receipt_id;
  const { data: linkedGoodsReceipt } = useGoodsReceipt(goodsReceiptId || null);
  
  // Fetch linked purchase order if exists
  const purchaseOrderId = (request as any)?.purchase_order_id;
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

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="secondary">Chờ duyệt</Badge>;
      case "approved":
        return <Badge className="bg-green-500">Đã duyệt</Badge>;
      case "rejected":
        return <Badge variant="destructive">Từ chối</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getDeliveryStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="outline">Chưa giao</Badge>;
      case "delivered":
        return <Badge className="bg-green-500">Đã giao</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getPaymentStatusBadge = (status: string) => {
    switch (status) {
      case "unpaid":
        return <Badge variant="destructive">Chưa thanh toán</Badge>;
      case "paid":
        return <Badge className="bg-green-500">Đã thanh toán</Badge>;
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
            Tiền mặt
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
    if (!request?.invoice_created) {
      setShowPaidWarningDialog(true);
    } else {
      handleMarkPaid();
    }
  };

  const handleMarkPaid = async () => {
    if (!requestId) return;
    await markPaid.mutateAsync(requestId);
    setShowPaidWarningDialog(false);
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
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Chi tiết đề nghị duyệt chi</DialogTitle>
            <DialogDescription>
              {request?.request_number} - {request?.title}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : request ? (
            <div className="space-y-6">
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
              <div className="flex flex-wrap gap-3">
                {getStatusBadge(request.status)}
                {getPaymentMethodBadge(request.payment_method)}
                {getDeliveryStatusBadge(request.delivery_status)}
                {getPaymentStatusBadge(request.payment_status)}
              </div>

              {/* Request Info */}
              <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
                <div>
                  <Label className="text-muted-foreground">Mã đề nghị</Label>
                  <p className="font-medium">{request.request_number}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Ngày tạo</Label>
                  <p className="font-medium">
                    {format(new Date(request.created_at), "dd/MM/yyyy HH:mm", { locale: vi })}
                  </p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Nhà cung cấp</Label>
                  <p className="font-medium">{request.suppliers?.name || "Không xác định"}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Tổng tiền</Label>
                  <div className="space-y-1">
                    {(request as any).vat_amount > 0 && (
                      <>
                        <p className="text-sm text-muted-foreground">
                          Tạm tính: {formatCurrency((request.total_amount || 0) - ((request as any).vat_amount || 0))}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          VAT: {formatCurrency((request as any).vat_amount || 0)}
                        </p>
                      </>
                    )}
                    <p className="font-medium text-lg">{formatCurrency(request.total_amount || 0)}</p>
                  </div>
                </div>
                {request.description && (
                  <div className="col-span-2">
                    <Label className="text-muted-foreground">Mô tả</Label>
                    <p>{request.description}</p>
                  </div>
                )}
                {request.rejection_reason && (
                  <div className="col-span-2">
                    <Label className="text-destructive">Lý do từ chối</Label>
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
                  <Label className="text-muted-foreground">Loại thanh toán</Label>
                  <div className="mt-1">
                    {(request as any).payment_type === "new_order" ? (
                      <Badge variant="default">🆕 Đơn mới</Badge>
                    ) : (
                      <Badge variant="secondary">📋 Đơn cũ (công nợ)</Badge>
                    )}
                  </div>
                </div>
                
                {/* Linked Goods Receipt */}
                {linkedGoodsReceipt && (
                  <div className="col-span-2">
                    <Label className="text-muted-foreground">Phiếu Nhập Kho liên kết</Label>
                    <div className="mt-1 p-2 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800">
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4 text-blue-600" />
                        <span className="font-medium text-blue-700 dark:text-blue-300">
                          {linkedGoodsReceipt.receipt_number}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          - {linkedGoodsReceipt.suppliers?.name || "N/A"}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          ({format(new Date(linkedGoodsReceipt.receipt_date), "dd/MM/yyyy", { locale: vi })})
                        </span>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Linked Purchase Order */}
                {linkedPurchaseOrder && (
                  <div className="col-span-2">
                    <Label className="text-muted-foreground">Đơn đặt hàng liên kết</Label>
                    <div className="mt-1 p-2 bg-purple-50 dark:bg-purple-900/20 rounded border border-purple-200 dark:border-purple-800">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-purple-600" />
                        <span className="font-medium text-purple-700 dark:text-purple-300">
                          {linkedPurchaseOrder.po_number}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          - {linkedPurchaseOrder.suppliers?.name || "N/A"}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          ({format(new Date(linkedPurchaseOrder.order_date), "dd/MM/yyyy", { locale: vi })})
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Invoice Image */}
              {imageUrl && (
                <div>
                  <Label className="text-muted-foreground">Hóa đơn đính kèm</Label>
                  <Button
                    variant="outline"
                    className="mt-2 gap-2"
                    onClick={() => setShowImageDialog(true)}
                  >
                    <Image className="h-4 w-4" />
                    Xem hóa đơn
                  </Button>
                </div>
              )}

              {/* Items Table */}
              <div>
                <Label className="text-muted-foreground mb-2 block">Danh sách sản phẩm</Label>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã SP</TableHead>
                      <TableHead>Tên sản phẩm</TableHead>
                      <TableHead className="text-right">SL</TableHead>
                      <TableHead>ĐVT</TableHead>
                      <TableHead className="text-right">Đơn giá</TableHead>
                      <TableHead className="text-right">Thành tiền</TableHead>
                      <TableHead>So sánh giá</TableHead>
                      <TableHead>Tồn kho</TableHead>
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
                            <span className="text-xs text-muted-foreground">Chưa có</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {item.inventory_items ? (
                            <Badge variant="outline" className="text-xs">
                              <Package className="h-3 w-3 mr-0.5" />
                              Tồn: {item.inventory_items.quantity}
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">
                              <AlertTriangle className="h-3 w-3 mr-0.5" />
                              Mới
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Notes */}
              {request.notes && (
                <div>
                  <Label className="text-muted-foreground">Ghi chú</Label>
                  <p className="mt-1 p-3 bg-muted/50 rounded">{request.notes}</p>
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-wrap gap-3 border-t pt-4">
                {/* Edit button for pending requests */}
                {request.status === "pending" && (
                  <Button
                    variant="outline"
                    onClick={() => setShowEditDialog(true)}
                    className="gap-2"
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
                      className="gap-2 bg-green-600 hover:bg-green-700"
                    >
                      {approveRequest.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      Duyệt
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => setShowRejectDialog(true)}
                      className="gap-2"
                    >
                      <X className="h-4 w-4" />
                      Từ chối
                    </Button>
                  </>
                )}

                {/* Mark as delivered (only for approved requests) */}
                {request.status === "approved" && request.delivery_status === "pending" && (
                  <Button
                    onClick={handleMarkDelivered}
                    disabled={markDelivered.isPending}
                    variant="outline"
                    className="gap-2"
                  >
                    {markDelivered.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Truck className="h-4 w-4" />
                    )}
                    Đánh dấu đã giao
                  </Button>
                )}

                {/* Create Invoice buttons (for approved requests without invoice) */}
                {request.status === "approved" && !request.invoice_created && (
                  <>
                    <Button 
                      variant="outline" 
                      onClick={() => setShowDriveImportDialog(true)}
                      className="gap-2"
                    >
                      <FolderSearch className="h-4 w-4" />
                      Tạo hoá đơn từ GG Drive
                    </Button>
                    <Button onClick={() => setShowCreateInvoiceDialog(true)}>
                      <Plus className="h-4 w-4 mr-2" />
                      Tạo hoá đơn thủ công
                    </Button>
                  </>
                )}

                {/* Mark as paid (only for approved requests) */}
                {request.status === "approved" && request.payment_status === "unpaid" && (
                  <Button
                    onClick={handleMarkPaidClick}
                    disabled={markPaid.isPending}
                    variant="outline"
                    className="gap-2"
                  >
                    {markPaid.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CreditCard className="h-4 w-4" />
                    )}
                    Đánh dấu đã thanh toán
                  </Button>
                )}

                {/* Change Payment Method (for approved requests) */}
                {request.status === "approved" && (
                  <Button
                    onClick={handleOpenChangePaymentMethod}
                    variant="outline"
                    className="gap-2"
                  >
                    {request.payment_method === "cash" ? (
                      <Banknote className="h-4 w-4" />
                    ) : (
                      <CreditCard className="h-4 w-4" />
                    )}
                    Đổi PTTT
                  </Button>
                )}

                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Đóng
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-center py-8 text-muted-foreground">Không tìm thấy đề nghị</p>
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

      {/* Warning: Mark as Paid without Invoice */}
      <AlertDialog open={showPaidWarningDialog} onOpenChange={setShowPaidWarningDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              {t.invoiceWarning}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t.invoiceWarningDesc}
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
              className="bg-destructive hover:bg-destructive/90"
            >
              {t.stillMarkPaid}
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
      />
    </>
  );
}
