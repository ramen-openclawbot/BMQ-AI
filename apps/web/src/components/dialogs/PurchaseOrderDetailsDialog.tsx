import { useState, useEffect } from "react";
import { format } from "date-fns";
import { vi, enUS } from "date-fns/locale";
import {
  Loader2,
  Package,
  Send,
  CheckCircle,
  XCircle,
  FileText,
  Truck,
  CreditCard,
  Pencil,
  ArrowLeft,
  MoreVertical,
  Clock,
} from "lucide-react";
import { ImagePreviewDialog } from "./ImagePreviewDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  usePurchaseOrder,
  usePurchaseOrderItems,
  useSendPurchaseOrder,
  useMarkPOCompleted,
  useCancelPurchaseOrder,
  getPurchaseOrderImageUrl,
} from "@/hooks/usePurchaseOrders";
import { useGoodsReceipts } from "@/hooks/useGoodsReceipts";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";
import { CreatePaymentRequestFromPODialog } from "./CreatePaymentRequestFromPODialog";
import { EditPurchaseOrderDialog } from "./EditPurchaseOrderDialog";

interface PurchaseOrderDetailsDialogProps {
  orderId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PurchaseOrderDetailsDialog({
  orderId,
  open,
  onOpenChange,
}: PurchaseOrderDetailsDialogProps) {
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [showReceiveDialog, setShowReceiveDialog] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showCreatePaymentRequest, setShowCreatePaymentRequest] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [selectedGoodsReceiptId, setSelectedGoodsReceiptId] = useState<string>("");
  const [resolvedImageUrl, setResolvedImageUrl] = useState<string | null>(null);
  const [showImagePreview, setShowImagePreview] = useState(false);

  const { language } = useLanguage();
  const locale = language === "vi" ? vi : enUS;

  const { data: order, isLoading: orderLoading, isError: orderError, refetch: refetchOrder } = usePurchaseOrder(orderId);
  const { data: items, isLoading: itemsLoading, isError: itemsError, refetch: refetchItems } = usePurchaseOrderItems(orderId);
  const { data: goodsReceipts } = useGoodsReceipts();

  const sendPO = useSendPurchaseOrder();
  const markCompleted = useMarkPOCompleted();
  const cancelPO = useCancelPurchaseOrder();

  // Filter goods receipts that can be linked (same supplier, received status)
  const availableReceipts = goodsReceipts?.filter(
    (gr) =>
      gr.status === "received" &&
      (!gr.purchase_order_id || gr.purchase_order_id === orderId) &&
      gr.supplier_id === order?.supplier_id
  );

  // Resolve image URL when order changes (handles both legacy and new data)
  useEffect(() => {
    const resolveImage = async () => {
      if (order?.image_url) {
        const url = await getPurchaseOrderImageUrl(order.image_url);
        setResolvedImageUrl(url);
      } else {
        setResolvedImageUrl(null);
      }
    };
    resolveImage();
  }, [order?.image_url]);

  const isLoading = orderLoading || itemsLoading;
  const hasError = orderError || itemsError;

  const handleRetry = () => {
    refetchOrder();
    refetchItems();
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const formatSafeDate = (date: string | null | undefined, fallback = "—") => {
    if (!date) return fallback;
    const parsedDate = new Date(date);
    if (Number.isNaN(parsedDate.getTime())) return fallback;
    return format(parsedDate, "dd/MM/yyyy", { locale });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return <Badge variant="secondary">Nháp</Badge>;
      case "sent":
        return <Badge className="bg-blue-500 hover:bg-blue-600">Đã gửi</Badge>;
      case "in_transit":
        return <Badge className="bg-orange-500 hover:bg-orange-600">Đang vận chuyển</Badge>;
      case "completed":
        return <Badge className="bg-green-500 hover:bg-green-600">Hoàn thành</Badge>;
      case "cancelled":
        return <Badge variant="destructive">Đã hủy</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const handleSend = async () => {
    if (!orderId) return;
    try {
      await sendPO.mutateAsync(orderId);
      toast.success("Đã gửi đơn đặt hàng cho nhà cung cấp");
      setShowSendConfirm(false);
    } catch (error) {
      toast.error("Lỗi khi gửi đơn đặt hàng");
    }
  };

  const handleReceive = async () => {
    if (!orderId) return;
    try {
      await markCompleted.mutateAsync({
        id: orderId,
        goodsReceiptId: selectedGoodsReceiptId || undefined,
      });
      toast.success("Đã đánh dấu đơn hàng hoàn thành");
      setShowReceiveDialog(false);
      setSelectedGoodsReceiptId("");
    } catch (error) {
      toast.error("Lỗi khi cập nhật trạng thái");
    }
  };

  const handleCancel = async () => {
    if (!orderId) return;
    try {
      await cancelPO.mutateAsync(orderId);
      toast.success("Đã hủy đơn đặt hàng và xóa đề nghị chi liên quan");
      setShowCancelConfirm(false);
    } catch (error) {
      toast.error("Lỗi khi hủy đơn đặt hàng");
    }
  };

  if (!open) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto p-0 md:p-6 data-[state=open]:md:rounded-lg max-md:h-[100dvh] max-md:max-h-[100dvh] max-md:w-screen max-md:max-w-none max-md:rounded-none max-md:border-0 max-md:bg-[#1d1813]">
          <DialogHeader className="px-4 pt-4 md:px-0 md:pt-0 max-md:hidden">
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Chi tiết Đơn Đặt Hàng
            </DialogTitle>
            <DialogDescription>
              {order?.po_number} - {order?.suppliers?.name || "N/A"}
            </DialogDescription>
          </DialogHeader>

          {hasError ? (
            <div className="flex flex-col items-center justify-center py-8 gap-4">
              <p className="text-destructive">Không thể tải dữ liệu. Vui lòng thử lại.</p>
              <Button onClick={handleRetry} variant="outline">
                Thử lại
              </Button>
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : order ? (
            <div className="space-y-6">
              <div className="space-y-4 pb-24 md:hidden" data-stitch-mobile-po-approve-detail>
                <header className="sticky top-0 z-40 -mx-0 flex h-14 items-center border-b border-[#443b30] bg-[#17130e] px-4">
                  <button type="button" className="-ml-2 rounded-full p-2 text-[#ffb77d]" onClick={() => onOpenChange(false)} aria-label="Quay lại">
                    <ArrowLeft className="h-5 w-5" />
                  </button>
                  <div className="ml-2 flex-1">
                    <div className="mb-0.5 text-xs text-[#a99b8c]">PO (Mua hàng)</div>
                    <h1 className="text-lg font-bold leading-none text-[#f3ece4]">Duyệt PO</h1>
                  </div>
                  <button type="button" className="-mr-2 rounded-full p-2 text-[#ffb77d]" aria-label="Thao tác khác">
                    <MoreVertical className="h-5 w-5" />
                  </button>
                </header>

                <main className="space-y-4 px-4">
                  <div className="flex justify-end">
                    <span className="rounded-full border border-[#d97706]/30 bg-[#d97706]/20 px-2.5 py-0.5 text-xs font-medium text-[#d97706]">
                      {order.status === "draft" ? "Chờ duyệt" : getStatusBadge(order.status)}
                    </span>
                  </div>

                  <section className="rounded-xl border border-[#443b30] bg-[#241f18] p-4 shadow-sm">
                    <div className="mb-4 flex items-start justify-between">
                      <div>
                        <h2 className="text-base font-semibold text-[#f3ece4]">{order.po_number}</h2>
                        <p className="mt-1 text-sm text-[#a99b8c]">{order.suppliers?.name || "N/A"}</p>
                      </div>
                    </div>
                    <div className="mb-4 grid grid-cols-2 gap-4">
                      <div>
                        <p className="mb-1 text-xs text-[#a99b8c]">Tổng tiền</p>
                        <p className="text-lg font-bold text-[#d97706]">{formatCurrency(order.total_amount || 0)}</p>
                      </div>
                      <div className="text-right">
                        <p className="mb-1 text-xs text-[#a99b8c]">Ngày đặt</p>
                        <p className="text-sm font-medium text-[#f3ece4]">{formatSafeDate(order.order_date)}</p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between border-t border-[#443b30] pt-3 text-sm">
                      <span className="text-[#a99b8c]">Người tạo</span>
                      <span className="flex items-center gap-2 font-medium text-[#f3ece4]"><FileText className="h-4 w-4" />BMQ-AI</span>
                    </div>
                  </section>

                  <section className="overflow-hidden rounded-xl border border-[#443b30] bg-[#241f18] shadow-sm">
                    <div className="border-b border-[#443b30] bg-[#2b241c] px-4 py-3">
                      <h3 className="text-sm font-semibold text-[#f3ece4]">Chi tiết sản phẩm ({items?.length || 0})</h3>
                    </div>
                    <div className="divide-y divide-[#443b30]">
                      {items && items.length > 0 ? items.map((item) => (
                        <div key={item.id} className="p-4 transition-colors hover:bg-[#342b22]">
                          <div className="mb-1 flex items-start justify-between gap-3">
                            <h4 className="font-medium text-[#f3ece4]">{item.product_name}</h4>
                            <span className="whitespace-nowrap font-medium text-[#f3ece4]">{formatCurrency(item.line_total || 0)}</span>
                          </div>
                          <p className="text-sm text-[#a99b8c]">{item.quantity} {item.unit} × {formatCurrency(item.unit_price || 0)}</p>
                        </div>
                      )) : (
                        <p className="py-4 text-center text-sm text-[#a99b8c]">Không có sản phẩm</p>
                      )}
                    </div>
                  </section>

                  <section className="space-y-4 rounded-xl border border-[#443b30] bg-[#241f18] p-4 shadow-sm">
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 text-[#a99b8c]"><Clock className="h-4 w-4" />Giao dự kiến</span>
                      <span className="font-medium text-[#f3ece4]">{formatSafeDate(order.expected_date, "Chưa xác định")}</span>
                    </div>
                    <div className="flex items-center justify-between border-t border-[#443b30] pt-4 text-sm">
                      <span className="flex items-center gap-2 text-[#a99b8c]"><Package className="h-4 w-4" />Trạng thái</span>
                      <span className="font-medium text-[#f3ece4]">{getStatusBadge(order.status)}</span>
                    </div>
                    {order.notes && (
                      <div className="border-t border-[#443b30] pt-4">
                        <span className="mb-2 block text-sm text-[#a99b8c]">Ghi chú PO</span>
                        <p className="rounded-lg border border-[#443b30] bg-[#1d1813] p-3 text-sm text-[#f3ece4]">{order.notes}</p>
                      </div>
                    )}
                  </section>

                  {order.status === "draft" && (
                    <section className="rounded-xl border border-[#443b30] bg-[#241f18] p-4 shadow-sm">
                      <h3 className="mb-4 text-sm font-semibold text-[#f3ece4]">Checklist duyệt</h3>
                      <div className="space-y-3">
                        {["Đã kiểm tra NCC", "Đã kiểm tra giá", "Đã kiểm tra số lượng"].map((label) => (
                          <label key={label} className="flex items-center gap-3 text-sm font-medium text-[#f3ece4]">
                            <input type="checkbox" className="h-5 w-5 rounded border-[#443b30] bg-[#1d1813] text-[#d97706] focus:ring-[#d97706]/50" />
                            {label}
                          </label>
                        ))}
                      </div>
                    </section>
                  )}
                </main>

                <nav className="fixed bottom-0 left-0 z-50 flex h-[72px] w-full gap-4 rounded-t-xl border-t border-[#443b30] bg-[#241f18] p-4 shadow-lg">
                  {order.status === "draft" ? (
                    <>
                      <Button type="button" variant="outline" className="h-full flex-1 border-[#DC2626] text-[#DC2626] hover:bg-[#DC2626]/10" onClick={() => setShowCancelConfirm(true)}>
                        <XCircle className="mr-2 h-4 w-4" />Từ chối
                      </Button>
                      <Button type="button" className="h-full flex-1 bg-[#D97706] font-semibold text-white hover:bg-[#b45309]" onClick={() => setShowSendConfirm(true)}>
                        <CheckCircle className="mr-2 h-4 w-4" />Duyệt PO
                      </Button>
                    </>
                  ) : order.status === "sent" ? (
                    <>
                      <Button type="button" variant="outline" className="h-full flex-1 border-[#DC2626] text-[#DC2626] hover:bg-[#DC2626]/10" onClick={() => setShowCancelConfirm(true)}>
                        <XCircle className="mr-2 h-4 w-4" />Hủy
                      </Button>
                      <Button type="button" className="h-full flex-1 bg-[#D97706] font-semibold text-white hover:bg-[#b45309]" onClick={() => setShowReceiveDialog(true)}>
                        <CheckCircle className="mr-2 h-4 w-4" />Đã nhận
                      </Button>
                    </>
                  ) : (
                    <Button type="button" className="h-full flex-1 bg-[#D97706] font-semibold text-white hover:bg-[#b45309]" onClick={() => setShowCreatePaymentRequest(true)}>
                      <CreditCard className="mr-2 h-4 w-4" />Tạo đề nghị thanh toán
                    </Button>
                  )}
                </nav>
              </div>

              <div className="hidden space-y-6 md:block">
              {/* Order Info */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 bg-muted/50 rounded-lg">
                <div>
                  <p className="text-sm text-muted-foreground">Số PO</p>
                  <p className="font-medium">{order.po_number}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Trạng thái</p>
                  <div className="mt-1">{getStatusBadge(order.status)}</div>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Ngày đặt</p>
                  <p className="font-medium">
                    {formatSafeDate(order.order_date)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Ngày giao dự kiến</p>
                  <p className="font-medium">
                    {formatSafeDate(order.expected_date, "Chưa xác định")}
                  </p>
                </div>
              </div>

              {/* Items */}
              <div>
                <h4 className="font-medium mb-3 flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  Danh sách sản phẩm ({items?.length || 0})
                </h4>
                {items && items.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Sản phẩm</TableHead>
                        <TableHead className="text-right">SL</TableHead>
                        <TableHead className="text-right">Đơn giá</TableHead>
                        <TableHead className="text-right">Thành tiền</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>
                            <div>
                              <p className="font-medium">{item.product_name}</p>
                              {item.productSkus?.sku_code && (
                                <p className="text-xs text-muted-foreground">
                                  SKU: {item.productSkus.sku_code}
                                </p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {item.quantity} {item.unit}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatCurrency(item.unit_price || 0)}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(item.line_total || 0)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-muted-foreground text-center py-4">
                    Không có sản phẩm
                  </p>
                )}
              </div>

              {/* Total with VAT breakdown - calculated from items */}
              {(() => {
                const subtotal = items?.reduce((sum, item) => sum + (item.line_total || 0), 0) || 0;
                const vatAmount = order.vat_amount || 0;
                const total = subtotal + vatAmount;
                return (
                  <div className="flex justify-end border-t pt-4">
                    <div className="space-y-1 text-right">
                      <div>
                        <span className="text-muted-foreground mr-4">Tạm tính:</span>
                        <span className="font-medium">
                          {formatCurrency(subtotal)}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground mr-4">VAT:</span>
                        <span className="font-medium">
                          {vatAmount > 0 
                            ? formatCurrency(vatAmount)
                            : "0 ₫ (chưa có)"}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground mr-4">Tổng cộng:</span>
                        <span className="text-xl font-bold">
                          {formatCurrency(total)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Original PO Image from Supplier */}
              {resolvedImageUrl && (
                <div className="border rounded-lg p-4 space-y-2">
                  <p className="text-sm font-medium flex items-center gap-2">
                    📷 Ảnh đơn hàng gốc từ NCC
                  </p>
                  <div className="border rounded-lg overflow-hidden">
                    <img 
                      src={resolvedImageUrl} 
                      alt="Đơn hàng gốc" 
                      className="w-full max-h-64 object-contain bg-muted cursor-pointer hover:opacity-90 transition-opacity"
                      onClick={() => setShowImagePreview(true)}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Nhấn vào ảnh để xem kích thước đầy đủ
                  </p>
                </div>
              )}

              {/* Notes */}
              {order.notes && (
                <div className="p-3 bg-muted/30 rounded-lg">
                  <p className="text-sm text-muted-foreground">Ghi chú:</p>
                  <p>{order.notes}</p>
                </div>
              )}

              <div className="flex justify-end gap-3 border-t pt-4">
                {order.status === "draft" && (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => setShowEditDialog(true)}
                    >
                      <Pencil className="h-4 w-4 mr-2" />
                      Chỉnh sửa
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setShowCancelConfirm(true)}
                    >
                      <XCircle className="h-4 w-4 mr-2" />
                      Hủy đơn
                    </Button>
                    <Button onClick={() => setShowSendConfirm(true)}>
                      <Send className="h-4 w-4 mr-2" />
                      Gửi đơn hàng
                    </Button>
                  </>
                )}
                {order.status === "sent" && (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => setShowCancelConfirm(true)}
                    >
                      <XCircle className="h-4 w-4 mr-2" />
                      Hủy đơn
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setShowCreatePaymentRequest(true)}
                    >
                      <CreditCard className="h-4 w-4 mr-2" />
                      Tạo đề nghị thanh toán
                    </Button>
                    <Button onClick={() => setShowReceiveDialog(true)}>
                      <Truck className="h-4 w-4 mr-2" />
                      Đánh dấu đã nhận
                    </Button>
                  </>
                )}
                {order.status === "completed" && (
                  <Button
                    variant="outline"
                    onClick={() => setShowCreatePaymentRequest(true)}
                  >
                    <CreditCard className="h-4 w-4 mr-2" />
                    Tạo đề nghị thanh toán
                  </Button>
                )}
              </div>
              </div>
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-8">
              Không tìm thấy đơn đặt hàng
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* Send Confirmation */}
      <AlertDialog open={showSendConfirm} onOpenChange={setShowSendConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận gửi đơn hàng</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc muốn gửi đơn đặt hàng {order?.po_number} cho nhà cung
              cấp {order?.suppliers?.name}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={handleSend} disabled={sendPO.isPending}>
              {sendPO.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              Gửi đơn
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Receive Dialog with Goods Receipt Link */}
      <AlertDialog open={showReceiveDialog} onOpenChange={setShowReceiveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Đánh dấu đã nhận hàng</AlertDialogTitle>
            <AlertDialogDescription>
              Xác nhận đã nhận hàng cho đơn {order?.po_number}. Bạn có thể liên
              kết với Phiếu Nhập Kho đã có.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="py-4">
            <label className="text-sm font-medium">
              Liên kết Phiếu Nhập Kho (tùy chọn)
            </label>
            <Select
              value={selectedGoodsReceiptId || "_none"}
              onValueChange={(value) =>
                setSelectedGoodsReceiptId(value === "_none" ? "" : value)
              }
            >
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="Chọn phiếu nhập kho" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">Không liên kết</SelectItem>
                {availableReceipts?.map((gr) => (
                  <SelectItem key={gr.id} value={gr.id}>
                    {gr.receipt_number} - {formatSafeDate(gr.receipt_date)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setSelectedGoodsReceiptId("")}>
              Hủy
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReceive}
              disabled={markCompleted.isPending}
            >
              {markCompleted.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <CheckCircle className="h-4 w-4 mr-2" />
              )}
              Xác nhận hoàn thành
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel Confirmation */}
      <AlertDialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận hủy đơn hàng</AlertDialogTitle>
            <AlertDialogDescription>
              Hành động này sẽ hủy đơn đặt hàng {order?.po_number} và xóa đề nghị chi liên quan (nếu có).
              Bạn không thể hoàn tác thao tác này.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Không</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancel}
              disabled={cancelPO.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelPO.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <XCircle className="h-4 w-4 mr-2" />
              )}
              Hủy đơn
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Payment Request from PO Dialog */}
      <CreatePaymentRequestFromPODialog
        purchaseOrder={order}
        items={items || []}
        open={showCreatePaymentRequest}
        onOpenChange={setShowCreatePaymentRequest}
      />

      {/* Edit Draft PO Dialog */}
      {orderId && (
        <EditPurchaseOrderDialog
          orderId={orderId}
          open={showEditDialog}
          onOpenChange={setShowEditDialog}
          onSuccess={() => {
            // Close edit dialog, the data will refresh automatically
          }}
        />
      )}

      {/* Image Preview Dialog */}
      <ImagePreviewDialog
        imageUrl={resolvedImageUrl}
        open={showImagePreview}
        onOpenChange={setShowImagePreview}
        title="Ảnh đơn hàng gốc từ NCC"
      />
    </>
  );
}
