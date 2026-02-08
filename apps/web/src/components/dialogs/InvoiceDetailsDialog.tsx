import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useInvoice, useInvoiceItems } from "@/hooks/useInvoices";
import { format } from "date-fns";
import { FileText, CreditCard, ExternalLink } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ImagePreviewDialog } from "./ImagePreviewDialog";

// Helper to resolve storage path to signed URL
async function resolveStorageUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  // If already a full URL, return as-is
  if (path.startsWith("http")) return path;
  
  const { data } = await supabase.storage
    .from("invoices")
    .createSignedUrl(path, 3600);
  return data?.signedUrl || null;
}

interface InvoiceDetailsDialogProps {
  invoiceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InvoiceDetailsDialog({
  invoiceId,
  open,
  onOpenChange,
}: InvoiceDetailsDialogProps) {
  const [showInvoiceImagePreview, setShowInvoiceImagePreview] = useState(false);
  const [showPaymentSlipPreview, setShowPaymentSlipPreview] = useState(false);

  const { data: invoice, isLoading: invoiceLoading } = useInvoice(invoiceId);
  const { data: items, isLoading: itemsLoading } = useInvoiceItems(invoiceId);

  // Resolve signed URLs for images
  const { data: resolvedImageUrl } = useQuery({
    queryKey: ["invoice-image-url", invoice?.image_url],
    queryFn: () => resolveStorageUrl(invoice?.image_url || null),
    enabled: !!invoice?.image_url,
  });

  const { data: resolvedPaymentSlipUrl } = useQuery({
    queryKey: ["invoice-payment-slip-url", invoice?.payment_slip_url],
    queryFn: () => resolveStorageUrl(invoice?.payment_slip_url || null),
    enabled: !!invoice?.payment_slip_url,
  });

  const isLoading = invoiceLoading || itemsLoading;

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Chi tiết hóa đơn
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : invoice ? (
          <div className="space-y-6">
            {/* Header Info */}
            <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
              <div>
                <p className="text-sm text-muted-foreground">Số hóa đơn</p>
                <p className="font-semibold">{invoice.invoice_number}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Ngày</p>
                <p className="font-semibold">
                  {format(new Date(invoice.invoice_date), "dd/MM/yyyy")}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Nhà cung cấp</p>
                <p className="font-semibold">
                  {invoice.suppliers?.name || (
                    <span className="text-muted-foreground">Không xác định</span>
                  )}
                </p>
              </div>
              {invoice.payment_request_id && (
                <div>
                  <p className="text-sm text-muted-foreground">Từ đề nghị chi</p>
                  <Badge variant="outline" className="mt-1">
                    <ExternalLink className="h-3 w-3 mr-1" />
                    Liên kết PR
                  </Badge>
                </div>
              )}
            </div>

            {/* Items Table */}
            <div>
              <h3 className="font-semibold mb-2">Danh sách sản phẩm</h3>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">Mã SP</TableHead>
                      <TableHead>Tên sản phẩm</TableHead>
                      <TableHead className="text-right w-20">SL</TableHead>
                      <TableHead className="w-20">ĐVT</TableHead>
                      <TableHead className="text-right w-28">Đơn giá</TableHead>
                      <TableHead className="text-right w-32">Thành tiền</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items && items.length > 0 ? (
                      items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="text-muted-foreground">
                            {item.product_code || "-"}
                          </TableCell>
                          <TableCell className="font-medium">
                            {item.product_name}
                          </TableCell>
                          <TableCell className="text-right">
                            {item.quantity}
                          </TableCell>
                          <TableCell>{item.unit || "kg"}</TableCell>
                          <TableCell className="text-right">
                            {formatCurrency(item.unit_price)}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(item.line_total || item.quantity * item.unit_price)}
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-4 text-muted-foreground">
                          Không có sản phẩm
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            {/* Totals */}
            <div className="flex justify-end">
              <div className="w-64 space-y-2 p-4 bg-muted/50 rounded-lg">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tạm tính:</span>
                  <span>{formatCurrency(invoice.subtotal || 0)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">VAT:</span>
                  <span>{formatCurrency(invoice.vat_amount || 0)}</span>
                </div>
                <div className="flex justify-between font-semibold border-t pt-2">
                  <span>Tổng cộng:</span>
                  <span className="text-primary">
                    {formatCurrency(invoice.total_amount || 0)}
                  </span>
                </div>
              </div>
            </div>

            {/* Attachments */}
            {(resolvedImageUrl || resolvedPaymentSlipUrl) && (
              <div>
                <h3 className="font-semibold mb-2">Chứng từ đính kèm</h3>
                <div className="grid grid-cols-2 gap-4">
                  {resolvedImageUrl && (
                    <div className="border rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">Hóa đơn</span>
                      </div>
                      <img
                        src={resolvedImageUrl}
                        alt="Invoice"
                        className="w-full h-32 object-contain rounded cursor-pointer hover:opacity-90 transition-opacity bg-muted/30"
                        onClick={() => setShowInvoiceImagePreview(true)}
                      />
                    </div>
                  )}
                  {resolvedPaymentSlipUrl && (
                    <div className="border rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <CreditCard className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">UNC / Chứng từ TT</span>
                      </div>
                      <img
                        src={resolvedPaymentSlipUrl}
                        alt="Payment Slip"
                        className="w-full h-32 object-contain rounded cursor-pointer hover:opacity-90 transition-opacity bg-muted/30"
                        onClick={() => setShowPaymentSlipPreview(true)}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Notes */}
            {invoice.notes && (
              <div>
                <h3 className="font-semibold mb-2">Ghi chú</h3>
                <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">
                  {invoice.notes}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            Không tìm thấy hóa đơn
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Đóng
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Image Preview Dialogs */}
      <ImagePreviewDialog
        imageUrl={resolvedImageUrl || null}
        open={showInvoiceImagePreview}
        onOpenChange={setShowInvoiceImagePreview}
        title="Hóa đơn"
      />
      <ImagePreviewDialog
        imageUrl={resolvedPaymentSlipUrl || null}
        open={showPaymentSlipPreview}
        onOpenChange={setShowPaymentSlipPreview}
        title="UNC / Chứng từ thanh toán"
      />
    </Dialog>
  );
}
