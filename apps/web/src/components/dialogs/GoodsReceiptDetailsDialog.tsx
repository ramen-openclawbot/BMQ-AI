import { format } from "date-fns";
import { vi } from "date-fns/locale";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { CheckCircle, Clock, FileCheck, Package, ExternalLink, Loader2, AlertCircle, Link2, XCircle } from "lucide-react";
import { useGoodsReceipt, useGoodsReceiptItems, useConfirmGoodsReceipt, getGoodsReceiptImageUrl } from "@/hooks/useGoodsReceipts";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useState } from "react";

interface GoodsReceiptDetailsDialogProps {
  receiptId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const formatSafeDate = (rawDate?: string | null, pattern = "dd/MM/yyyy") => {
  if (!rawDate) return "-";
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return "-";
  return format(date, pattern, { locale: vi });
};

export function GoodsReceiptDetailsDialog({ receiptId, open, onOpenChange }: GoodsReceiptDetailsDialogProps) {
  const { data: receipt, isLoading: receiptLoading, error: receiptError } = useGoodsReceipt(receiptId);
  const { data: items = [], isLoading: itemsLoading } = useGoodsReceiptItems(receiptId);
  const confirmReceipt = useConfirmGoodsReceipt();
  const [imageOpen, setImageOpen] = useState(false);

  const receiptImageUrl = receipt?.image_url;

  // Get image URL
  const { data: imageUrl } = useQuery({
    queryKey: ["goods-receipt-image", receiptImageUrl],
    queryFn: async () => {
      if (!receiptImageUrl) return null;
      return await getGoodsReceiptImageUrl(receiptImageUrl);
    },
    enabled: !!receiptImageUrl,
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />Nháp</Badge>;
      case "confirmed":
        return <Badge variant="default"><FileCheck className="h-3 w-3 mr-1" />Đã xác nhận</Badge>;
      case "received":
        return <Badge className="bg-green-500"><CheckCircle className="h-3 w-3 mr-1" />Đã nhập kho</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getPayableBadge = () => {
    if (receipt?.payable_status === "generated") {
      return <Badge className="bg-emerald-600"><CheckCircle className="h-3 w-3 mr-1" />Đã tạo công nợ</Badge>;
    }
    if (receipt?.payable_status === "pending") {
      return <Badge variant="default"><Clock className="h-3 w-3 mr-1" />Đang xử lý công nợ</Badge>;
    }
    return <Badge variant="outline"><AlertCircle className="h-3 w-3 mr-1" />Chưa tạo công nợ</Badge>;
  };

  const lineStatusLabel = (status?: string | null) => {
    if (status === "thieu") return "Thiếu";
    if (status === "du_thua") return "Dư";
    if (status === "du") return "Đủ";
    return "-";
  };

  const lineStatusBadge = (status?: string | null) => {
    if (status === "thieu") return <Badge variant="destructive">Thiếu</Badge>;
    if (status === "du_thua") return <Badge variant="secondary">Dư</Badge>;
    if (status === "du") return <Badge className="bg-green-500">Đủ</Badge>;
    return <Badge variant="outline">-</Badge>;
  };

  const handleConfirmReceipt = async () => {
    if (!receiptId) return;
    try {
      await confirmReceipt.mutateAsync(receiptId);
      toast.success("Đã nhập hàng vào kho và tạo công nợ chờ duyệt");
      onOpenChange(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Không thể nhập hàng vào kho";
      toast.error(message);
    }
  };

  const isLoading = receiptLoading || itemsLoading;
  const isFinalizedWithPayable = receipt?.payable_status === "generated";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[92vh] overflow-y-auto border-border bg-card p-0 sm:max-w-3xl" data-bmq-goods-receipt-detail-light-mobile>
          <DialogHeader className="border-b border-border bg-background/70 px-4 py-3 sm:px-6">
            <DialogTitle className="flex items-center gap-2 text-lg">
              <Package className="h-5 w-5 text-primary" />
              Chi tiết Phiếu Nhập Kho
            </DialogTitle>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              Đang tải chi tiết phiếu nhập...
            </div>
          ) : receiptError ? (
            <div className="m-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              <div className="mb-1 flex items-center gap-2 font-semibold"><XCircle className="h-4 w-4" />Không tải được chi tiết phiếu nhập</div>
              <p>Vui lòng thử lại hoặc tải lại trang. Danh sách vẫn có thể hiển thị nếu liên kết phụ bị lỗi.</p>
            </div>
          ) : receipt ? (
            <div className="space-y-5 p-4 sm:space-y-6 sm:p-6">
              {/* Receipt Info */}
              <div className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-background/70 p-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Mã phiếu</p>
                  <p className="font-mono font-medium">{receipt.receipt_number}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Trạng thái</p>
                  <div className="mt-1">{getStatusBadge(receipt.status)}</div>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Nhà cung cấp</p>
                  <p className="font-medium">{receipt.suppliers?.name || "-"}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Ngày nhận hàng</p>
                  <p className="font-medium">
                    {formatSafeDate(receipt.receipt_date)}
                  </p>
                </div>
              </div>

              {/* Payable audit */}
              <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Đối soát công nợ</p>
                    <p className="text-xs text-muted-foreground">Liên kết PO → phiếu nhập → công nợ phải trả</p>
                  </div>
                  {getPayableBadge()}
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                  <div>
                    <p className="text-muted-foreground">Mã PO</p>
                    <p className="font-mono font-medium">{receipt.purchase_orders?.po_number || "-"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Mã công nợ</p>
                    <p className="font-mono font-medium">{receipt.payment_requests?.request_number || "-"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Trạng thái duyệt</p>
                    <p className="font-medium">{receipt.payment_requests?.status || "-"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Ngày chốt</p>
                    <p className="font-medium">
                      {formatSafeDate(receipt.finalized_at, "dd/MM/yyyy HH:mm")}
                    </p>
                  </div>
                </div>
                {receipt.variance_summary && (
                  <p className="text-xs text-muted-foreground">
                    Tổng hợp lệch: {JSON.stringify(receipt.variance_summary)}
                  </p>
                )}
                {isFinalizedWithPayable && (
                  <p className="flex items-center gap-1 text-xs text-emerald-700">
                    <Link2 className="h-3 w-3" />
                    Không chốt lại phiếu đã tạo công nợ; mọi điều chỉnh tiếp theo phải đi qua quy trình audit/điều chỉnh.
                  </p>
                )}
              </div>

              {/* Image */}
              {imageUrl && (
                <div>
                  <p className="text-sm text-muted-foreground mb-2">Ảnh phiếu giao hàng</p>
                  <img
                    src={imageUrl}
                    alt="Phiếu giao hàng"
                    className="max-h-48 rounded-lg border cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => setImageOpen(true)}
                  />
                </div>
              )}

              <Separator />

              {/* Items */}
              <div>
                <h3 className="mb-3 font-medium">Danh sách sản phẩm</h3>
                <div className="overflow-x-auto rounded-xl border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Sản phẩm</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Đặt</TableHead>
                      <TableHead className="text-right">Thực nhận</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead>Đơn vị</TableHead>
                      <TableHead>HSD</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items?.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-medium">{item.product_name}</TableCell>
                        <TableCell>
                          {item.product_skus?.sku_code ? (
                            <Badge variant="secondary">{item.product_skus.sku_code}</Badge>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {(item.ordered_quantity ?? item.quantity).toLocaleString("vi-VN")}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {(item.actual_quantity ?? item.quantity).toLocaleString("vi-VN")}
                        </TableCell>
                        <TableCell title={lineStatusLabel(item.line_status)}>{lineStatusBadge(item.line_status)}</TableCell>
                        <TableCell>{item.unit || "kg"}</TableCell>
                        <TableCell>{formatSafeDate(item.expiry_date)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              </div>

              {/* Summary */}
              <div className="rounded-xl border border-border bg-muted/50 p-4">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Tổng số lượng:</span>
                  <span className="text-lg font-bold">
                    {receipt.total_quantity?.toLocaleString("vi-VN") || 0}
                  </span>
                </div>
              </div>

              {/* Notes */}
              {receipt.notes && (
                <div>
                  <p className="text-sm text-muted-foreground">Ghi chú</p>
                  <p className="mt-1">{receipt.notes}</p>
                </div>
              )}

              {/* Actions */}
              {receipt.status === "confirmed" && !isFinalizedWithPayable && (
                <div className="flex justify-end">
                  <Button
                    className="btn-gradient w-full sm:w-auto"
                    onClick={handleConfirmReceipt}
                    disabled={confirmReceipt.isPending}
                  >
                    {confirmReceipt.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <CheckCircle className="h-4 w-4 mr-2" />
                    )}
                    Xác nhận nhập kho + Tạo công nợ
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="m-4 rounded-xl border border-dashed border-border p-6 text-center text-muted-foreground">
              Chọn một phiếu nhập kho để xem chi tiết.
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Image Preview Dialog */}
      <Dialog open={imageOpen} onOpenChange={setImageOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Ảnh phiếu giao hàng</DialogTitle>
          </DialogHeader>
          {imageUrl && (
            <div className="flex flex-col items-center gap-4">
              <img
                src={imageUrl}
                alt="Phiếu giao hàng"
                className="max-h-[70vh] rounded-lg object-contain"
              />
              <Button variant="outline" asChild>
                <a href={imageUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Mở trong tab mới
                </a>
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
