import { format } from "date-fns";
import { vi } from "date-fns/locale";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { CheckCircle, Clock, FileCheck, Package, ExternalLink, Loader2, AlertCircle, Link2 } from "lucide-react";
import { useGoodsReceipt, useGoodsReceiptItems, useConfirmGoodsReceipt, getGoodsReceiptImageUrl } from "@/hooks/useGoodsReceipts";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useState } from "react";

interface GoodsReceiptDetailsDialogProps {
  receiptId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GoodsReceiptDetailsDialog({ receiptId, open, onOpenChange }: GoodsReceiptDetailsDialogProps) {
  const { data: receipt, isLoading: receiptLoading } = useGoodsReceipt(receiptId);
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
      toast.error("Không thể nhập hàng vào kho");
    }
  };

  const isLoading = receiptLoading || itemsLoading;
  const isFinalizedWithPayable = receipt?.payable_status === "generated";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Chi tiết Phiếu Nhập Kho
            </DialogTitle>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : receipt ? (
            <div className="space-y-6">
              {/* Receipt Info */}
              <div className="grid grid-cols-2 gap-4">
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
                    {format(new Date(receipt.receipt_date), "dd/MM/yyyy", { locale: vi })}
                  </p>
                </div>
              </div>

              {/* Payable audit */}
              <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
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
                      {receipt.finalized_at ? format(new Date(receipt.finalized_at), "dd/MM/yyyy HH:mm", { locale: vi }) : "-"}
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
                <h3 className="font-medium mb-3">Danh sách sản phẩm</h3>
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
                        <TableCell>{item.expiry_date ? format(new Date(item.expiry_date), "dd/MM/yyyy", { locale: vi }) : "-"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Summary */}
              <div className="bg-muted/50 rounded-lg p-4">
                <div className="flex justify-between items-center">
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
          ) : null}
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
