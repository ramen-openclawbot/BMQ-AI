import { useState, useEffect } from "react";
import { Loader2, FileText, CreditCard, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { toast } from "sonner";
import {
  usePaymentRequest,
  usePaymentRequestItems,
  getPaymentRequestImageUrl,
} from "@/hooks/usePaymentRequests";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";

interface CreateInvoiceFromRequestDialogProps {
  requestId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvoiceCreated?: (invoiceId: string) => void;
}

export function CreateInvoiceFromRequestDialog({
  requestId,
  open,
  onOpenChange,
  onInvoiceCreated,
}: CreateInvoiceFromRequestDialogProps) {
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [vatAmount, setVatAmount] = useState(0);
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [paymentSlipFile, setPaymentSlipFile] = useState<File | null>(null);
  const [paymentSlipPreview, setPaymentSlipPreview] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { data: request, isLoading: requestLoading } = usePaymentRequest(requestId);
  const { data: items, isLoading: itemsLoading } = usePaymentRequestItems(requestId);

  // Get image URL if exists
  const { data: imageUrl } = useQuery({
    queryKey: ["payment-request-image", request?.image_url],
    queryFn: async () => {
      if (!request?.image_url) return null;
      return getPaymentRequestImageUrl(request.image_url);
    },
    enabled: !!request?.image_url,
  });

  // Force refetch items when dialog opens to avoid stale cache
  useEffect(() => {
    if (open && requestId) {
      queryClient.invalidateQueries({ queryKey: ["payment-request-items", requestId] });
    }
  }, [open, requestId, queryClient]);

  // Reset form when dialog opens.
  // Fallback: older requests may have vat_amount=0; infer VAT from total_amount - subtotal(items)
  useEffect(() => {
    if (!open || !request) return;

    setInvoiceNumber(`INV-${request.request_number}`);
    setInvoiceDate(format(new Date(), "yyyy-MM-dd"));
    setNotes(`Tạo từ đề nghị chi ${request.request_number}`);

    const requestVatRaw = Number((request as any).vat_amount ?? 0) || 0;
    const subtotalFromItems = (items || []).reduce(
      (sum, item) => sum + (Number(item.line_total) || (Number(item.quantity) || 0) * (Number(item.unit_price) || 0)),
      0,
    );
    const totalFromRequest = Number((request as any).total_amount ?? 0) || 0;
    const inferredVat = Math.max(0, totalFromRequest - subtotalFromItems);
    setVatAmount(requestVatRaw > 0 ? requestVatRaw : inferredVat);
  }, [open, request, items]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const subtotal = items?.reduce((sum, item) => sum + (item.line_total || 0), 0) || 0;
  const totalAmount = subtotal + vatAmount;

  const handleSubmit = async () => {
    if (!request || !items || items.length === 0) {
      toast.error("Không có sản phẩm để tạo hóa đơn");
      return;
    }

    setIsSubmitting(true);
    try {
      // Get auth token
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast.error("Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.");
        return;
      }

      // Upload payment slip if exists
      let uploadedPaymentSlipUrl: string | null = null;
      if (paymentSlipFile) {
        const fileExt = paymentSlipFile.name.split(".").pop();
        const fileName = `slip-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
        
        const { error: uploadError } = await supabase.storage
          .from("invoices")
          .upload(fileName, paymentSlipFile);

        if (uploadError) {
          throw new Error(`Không thể upload chứng từ: ${uploadError.message}`);
        }

        const { data: signedData } = await supabase.storage
          .from("invoices")
          .createSignedUrl(fileName, 60 * 60 * 24 * 365);
        
        uploadedPaymentSlipUrl = signedData?.signedUrl || null;
      }

      // Call edge function to create invoice + items atomically
      const result = await callEdgeFunction<{
        success: boolean;
        invoice_id: string;
        items_count: number;
      }>(
        "create-invoice-from-pr",
        {
          payment_request_id: request.id,
          invoice_number: invoiceNumber,
          invoice_date: invoiceDate,
          vat_amount: vatAmount,
          notes,
          payment_slip_url: uploadedPaymentSlipUrl,
        },
        session.access_token,
        30000 // 30 second timeout
      );

      if (result.error) {
        if (result.isSessionExpired) {
          toast.error("Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.");
        } else {
          toast.error(result.error);
        }
        return;
      }

      if (!result.data?.success) {
        toast.error("Không thể tạo hóa đơn. Vui lòng thử lại.");
        return;
      }

      console.log(`Invoice created: ${result.data.invoice_id} with ${result.data.items_count} items`);

      // Invalidate queries
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-request", request.id] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice", result.data.invoice_id] });
      queryClient.invalidateQueries({ queryKey: ["invoice_items", result.data.invoice_id] });

      if (onInvoiceCreated) {
        onInvoiceCreated(result.data.invoice_id);
      }
      
      toast.success(`Đã tạo hóa đơn với ${result.data.items_count} sản phẩm`);
      onOpenChange(false);
    } catch (error) {
      console.error("Error creating invoice:", error);
      const errorMessage = error instanceof Error ? error.message : "Lỗi không xác định";
      toast.error(`Không thể tạo hóa đơn: ${errorMessage}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isLoading = requestLoading || itemsLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Tạo hóa đơn
          </DialogTitle>
          <DialogDescription>
            Tạo hóa đơn từ đề nghị chi {request?.request_number}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Invoice Info */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Số hóa đơn</Label>
                <Input
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  placeholder="Nhập số hóa đơn"
                />
              </div>
              <div className="space-y-2">
                <Label>Ngày hóa đơn</Label>
                <Input
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Nhà cung cấp</Label>
                <Input
                  value={request?.suppliers?.name || "Không xác định"}
                  disabled
                  className="bg-muted"
                />
              </div>
              <div className="space-y-2">
                <Label>VAT</Label>
                <Input
                  type="number"
                  value={vatAmount}
                  onChange={(e) => setVatAmount(Number(e.target.value))}
                  placeholder="0"
                />
              </div>
            </div>

            {/* Items Table */}
            <div>
              <Label className="mb-2 block">Danh sách sản phẩm</Label>
              <div className="border rounded-lg">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã SP</TableHead>
                      <TableHead>Tên sản phẩm</TableHead>
                      <TableHead className="text-right">SL</TableHead>
                      <TableHead>ĐVT</TableHead>
                      <TableHead className="text-right">Đơn giá</TableHead>
                      <TableHead className="text-right">Thành tiền</TableHead>
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
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            {/* Totals */}
            <div className="flex justify-end">
              <div className="w-64 space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Tạm tính:</span>
                  <span>{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>VAT:</span>
                  <span>{formatCurrency(vatAmount)}</span>
                </div>
                <div className="flex justify-between font-bold border-t pt-2">
                  <span>Tổng cộng:</span>
                  <span>{formatCurrency(totalAmount)}</span>
                </div>
              </div>
            </div>

            {/* Payment Slip Upload */}
            <div className="border-2 border-dashed border-border rounded-lg p-4">
              <div className="flex flex-col items-center gap-3">
                <p className="text-sm font-medium flex items-center gap-1">
                  <CreditCard className="h-4 w-4" />
                  Ảnh UNC / Chứng từ TT (tùy chọn)
                </p>
                {paymentSlipPreview ? (
                  <div className="relative">
                    <img
                      src={paymentSlipPreview}
                      alt="Payment slip preview"
                      className="max-h-32 rounded-lg object-contain"
                    />
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      className="absolute -top-2 -right-2"
                      onClick={() => {
                        setPaymentSlipFile(null);
                        setPaymentSlipPreview(null);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <div className="text-center py-2">
                    <Upload className="mx-auto h-6 w-6 text-muted-foreground" />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Upload ảnh UNC để lưu trữ
                    </p>
                  </div>
                )}
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setPaymentSlipFile(file);
                      const previewUrl = URL.createObjectURL(file);
                      setPaymentSlipPreview(previewUrl);
                    }
                  }}
                  className="text-xs"
                />
              </div>
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label>Ghi chú</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Ghi chú thêm..."
                rows={2}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || isLoading || !items?.length}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Đang tạo...
              </>
            ) : (
              "Tạo hóa đơn"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
