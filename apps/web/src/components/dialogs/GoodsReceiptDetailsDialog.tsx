import { format } from "date-fns";
import { vi } from "date-fns/locale";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { CheckCircle, Clock, FileCheck, Package, ExternalLink, Loader2 } from "lucide-react";
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

  const handleConfirmReceipt = async () => {
    if (!receiptId) return;
    try {
      await confirmReceipt.mutateAsync(receiptId);
      toast.success("Đã nhập hàng vào kho thành công");
      onOpenChange(false);
    } catch (error) {
      toast.error("Không thể nhập hàng vào kho");
    }
  };

  const isLoading = receiptLoading || itemsLoading;

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
                      <TableHead className="text-right">Số lượng</TableHead>
                      <TableHead>Đơn vị</TableHead>
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
                          {item.quantity.toLocaleString("vi-VN")}
                        </TableCell>
                        <TableCell>{item.unit || "kg"}</TableCell>
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
              {receipt.status === "confirmed" && (
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
                    Xác nhận nhập kho
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
