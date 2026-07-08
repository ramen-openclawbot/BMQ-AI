import { format } from "date-fns";
import { vi } from "date-fns/locale";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { Camera, Sparkles, CheckCircle, Clock, FileCheck, Package, ExternalLink, Loader2, AlertCircle, Link2, XCircle, AlertTriangle } from "lucide-react";
import { useGoodsReceipt, useGoodsReceiptItems, useConfirmGoodsReceipt, useUpdateGoodsReceiptItems, useUpdateGoodsReceipt, getGoodsReceiptImageUrl, useDeliveryNoteOcr } from "@/hooks/useGoodsReceipts";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useState, useEffect } from "react";

interface GoodsReceiptDetailsDialogProps {
  receiptId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type LineEdit = { actual_quantity: string; variance_reason: string };

const formatSafeDate = (rawDate?: string | null, pattern = "dd/MM/yyyy") => {
  if (!rawDate) return "-";
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return "-";
  return format(date, pattern, { locale: vi });
};

function validateLine(draft: LineEdit | undefined, orderedQty: number): string | null {
  if (!draft) return "Chưa nhập số lượng";
  const n = parseFloat(draft.actual_quantity);
  if (isNaN(n) || n < 0) return "Số lượng không hợp lệ";
  if (n > orderedQty) return "Vượt quá số lượng đặt";
  if (n < orderedQty && !draft.variance_reason.trim()) return "Cần ghi lý do thiếu hàng";
  return null;
}

function getConfirmReceiptErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Không thể nhập hàng vào kho";
  if (message.includes("Cannot create payable with zero amount")) {
    return "Không thể tạo công nợ 0đ. Kiểm tra đơn giá trong PO hoặc đơn giá dòng phiếu nhập trước khi nhập kho.";
  }
  return message;
}

export function GoodsReceiptDetailsDialog({ receiptId, open, onOpenChange }: GoodsReceiptDetailsDialogProps) {
  const { data: receipt, isLoading: receiptLoading, error: receiptError } = useGoodsReceipt(receiptId);
  const { data: items = [], isLoading: itemsLoading } = useGoodsReceiptItems(receiptId);
  const confirmReceipt = useConfirmGoodsReceipt();
  const updateItems = useUpdateGoodsReceiptItems();
  const updateReceipt = useUpdateGoodsReceipt();
  const ocrDelivery = useDeliveryNoteOcr();
  const [imageOpen, setImageOpen] = useState(false);
  const [editDraft, setEditDraft] = useState<Record<string, LineEdit>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [deliveryNotePath, setDeliveryNotePath] = useState<string | null>(null);

  const receiptImageUrl = receipt?.image_url;

  const { data: imageUrl } = useQuery({
    queryKey: ["goods-receipt-image", receiptImageUrl],
    queryFn: async () => {
      if (!receiptImageUrl) return null;
      return await getGoodsReceiptImageUrl(receiptImageUrl);
    },
    enabled: !!receiptImageUrl,
  });

  // Reset draft and OCR state when switching to a different receipt
  useEffect(() => {
    setEditDraft({});
    setDeliveryNotePath(null);
    ocrDelivery.reset();
    // ocrDelivery.reset is stable (closes over useState setters only)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptId]);

  // Pre-populate draft from DB values once items load
  useEffect(() => {
    if (items.length === 0) return;
    setEditDraft(prev => {
      const next: Record<string, LineEdit> = {};
      for (const item of items) {
        next[item.id] = prev[item.id] ?? {
          actual_quantity: String(item.actual_quantity ?? item.ordered_quantity ?? item.quantity ?? ""),
          variance_reason: item.variance_reason ?? "",
        };
      }
      return next;
    });
  }, [items]);

  useEffect(() => {
    setDeliveryNotePath(receipt?.image_url ?? null);
  }, [receipt?.image_url]);

  useEffect(() => {
    if (!receiptId || !ocrDelivery.uploadedPath || ocrDelivery.uploadedPath === receipt?.image_url) return;
    setDeliveryNotePath(ocrDelivery.uploadedPath);
    updateReceipt.mutate({ id: receiptId, image_url: ocrDelivery.uploadedPath });
  }, [ocrDelivery.uploadedPath, receipt?.image_url, receiptId, updateReceipt]);

  const updateDraft = (id: string, field: keyof LineEdit, value: string) => {
    setEditDraft(prev => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }));
  };

  const handleDeliveryNoteSelect = async (file: File) => {
    if (!receiptId) return;
    const poLines = items.map(item => ({
      id: item.id,
      product_name: item.product_name,
      quantity: Number(item.ordered_quantity ?? item.quantity ?? 0),
    }));
    const uploadedPath = await ocrDelivery.process(file, receiptId, poLines);
    if (uploadedPath) {
      setDeliveryNotePath(uploadedPath);
      await updateReceipt.mutateAsync({ id: receiptId, image_url: uploadedPath });
    }
  };

  const handleOcrPrefill = () => {
    setEditDraft(prev => {
      const next = { ...prev };
      for (const suggestion of ocrDelivery.suggestions) {
        if (!next[suggestion.itemId]) continue;
        const item = items.find(i => i.id === suggestion.itemId);
        const orderedQty = Number(item?.ordered_quantity ?? item?.quantity ?? 0);
        next[suggestion.itemId] = {
          ...next[suggestion.itemId],
          actual_quantity: String(Math.min(suggestion.suggestedQuantity, orderedQty)),
        };
      }
      return next;
    });
    toast.success("Đã điền số lượng từ OCR — kiểm tra và xác nhận trước khi chốt.");
  };

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

  const isLoading = receiptLoading || itemsLoading;
  const isFinalizedWithPayable = receipt?.payable_status === "generated";
  const isReceiveMode = receipt?.status === "confirmed" && !isFinalizedWithPayable;
  const itemCount = items.length;
  const displayActualQuantity = (item: typeof items[number]) => Number(
    item.actual_quantity ?? item.ordered_quantity ?? item.quantity ?? 0
  );
  const actualTotal = items.reduce((sum, item) => sum + displayActualQuantity(item), 0);
  const varianceCount = items.filter((item) => item.line_status && item.line_status !== "du").length;
  const hasUnitPrices = items.some(item => item.unit_price != null || item.purchase_order_items?.unit_price != null);
  const hasShortageItems = isReceiveMode && items.some(item => {
    const draft = editDraft[item.id];
    if (!draft) return false;
    const qty = parseFloat(draft.actual_quantity);
    return !isNaN(qty) && qty < Number(item.ordered_quantity ?? item.quantity ?? 0);
  });
  const hasDeliveryNoteEvidence = Boolean(deliveryNotePath || receiptImageUrl);
  const hasRequiredReceiptEvidence = !isReceiveMode || hasDeliveryNoteEvidence;
  const hasRequiredVarianceEvidence = !hasShortageItems || hasDeliveryNoteEvidence;

  const canFinalize =
    isReceiveMode &&
    items.length > 0 &&
    hasRequiredReceiptEvidence &&
    hasRequiredVarianceEvidence &&
    items.every(item => {
      const orderedQty = Number(item.ordered_quantity ?? item.quantity ?? 0);
      return validateLine(editDraft[item.id], orderedQty) === null;
    });

  const handleConfirmReceipt = async () => {
    if (!receiptId || !isReceiveMode) return;

    if (!hasRequiredReceiptEvidence) {
      toast.error("Phiếu nhập kho PO phải đính kèm ảnh/chứng từ đã upload trước khi nhập kho.");
      return;
    }

    for (const item of items) {
      const orderedQty = Number(item.ordered_quantity ?? item.quantity ?? 0);
      const err = validateLine(editDraft[item.id], orderedQty);
      if (err) {
        toast.error(`${item.product_name}: ${err}`);
        return;
      }
    }

    const payload = items.map(item => {
      const draft = editDraft[item.id]!;
      const orderedQty = Number(item.ordered_quantity ?? item.quantity ?? 0);
      const actualQty = parseFloat(draft.actual_quantity);
      return {
        id: item.id,
        actual_quantity: actualQty,
        line_status: actualQty < orderedQty ? "thieu" : "du",
        variance_reason: draft.variance_reason.trim() || null,
      };
    });

    try {
      setIsSaving(true);
      await updateItems.mutateAsync({ receiptId, items: payload });
      await confirmReceipt.mutateAsync(receiptId);
      toast.success("Đã nhập hàng vào kho và tạo công nợ chờ duyệt");
      onOpenChange(false);
    } catch (error) {
      toast.error(getConfirmReceiptErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  const isSubmitting = isSaving || confirmReceipt.isPending || updateItems.isPending;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[92vh] w-[calc(100vw-1rem)] flex-col overflow-hidden border-border bg-card p-0 sm:max-w-3xl max-md:h-[96dvh] max-md:max-w-none max-md:rounded-2xl" data-bmq-goods-receipt-detail-light-mobile data-bmq-goods-receipt-detail-mobile-v2>
          <DialogHeader className="shrink-0 border-b border-border bg-background/95 px-4 py-3 shadow-sm backdrop-blur sm:px-6">
            <DialogTitle className="flex min-w-0 items-center gap-2 pr-8 text-base sm:text-lg">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Package className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate">Chi tiết phiếu nhập kho</span>
                {receipt?.receipt_number && (
                  <span className="block font-mono text-xs font-medium text-muted-foreground">{receipt.receipt_number}</span>
                )}
              </span>
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto overscroll-contain">
            {isLoading ? (
            <div className="flex min-h-64 items-center justify-center gap-2 px-4 py-10 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              Đang tải chi tiết phiếu nhập...
            </div>
          ) : receiptError ? (
            <div className="m-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              <div className="mb-1 flex items-center gap-2 font-semibold"><XCircle className="h-4 w-4" />Không tải được chi tiết phiếu nhập</div>
              <p>Vui lòng thử lại hoặc tải lại trang. Danh sách vẫn có thể hiển thị nếu liên kết phụ bị lỗi.</p>
            </div>
          ) : receipt ? (
            <div className="space-y-4 p-4 sm:space-y-6 sm:p-6">
              <div className="rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/10 via-background to-card p-4 shadow-sm" data-bmq-goods-receipt-detail-mobile-hero>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-primary">Phiếu nhập kho</p>
                    <p className="mt-1 truncate font-mono text-xl font-bold text-foreground">{receipt.receipt_number}</p>
                    <p className="mt-1 truncate text-sm font-medium text-muted-foreground">{receipt.suppliers?.name || "Chưa có NCC"}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {getStatusBadge(receipt.status)}
                    {getPayableBadge()}
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center" data-bmq-goods-receipt-detail-mobile-summary>
                  <div className="rounded-xl border border-border/70 bg-card/80 p-3">
                    <p className="text-[11px] text-muted-foreground">Dòng hàng</p>
                    <p className="text-lg font-bold text-foreground">{itemCount}</p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-card/80 p-3">
                    <p className="text-[11px] text-muted-foreground">Thực nhận</p>
                    <p className="text-lg font-bold text-foreground">{actualTotal.toLocaleString("vi-VN")}</p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-card/80 p-3">
                    <p className="text-[11px] text-muted-foreground">Lệch</p>
                    <p className={varianceCount > 0 ? "text-lg font-bold text-amber-700" : "text-lg font-bold text-emerald-700"}>{varianceCount}</p>
                  </div>
                </div>
              </div>

              {/* Receipt Info */}
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-background/70 p-4 sm:grid-cols-2">
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
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
              <div className="rounded-xl border border-border bg-background/70 p-4" data-bmq-goods-receipt-attached-evidence>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-foreground">Ảnh/chứng từ phiếu nhập kho</p>
                    <p className="text-xs text-muted-foreground">Staff mở lại để đối chiếu PO, giao nhận và công nợ bất cứ lúc nào.</p>
                  </div>
                  {hasDeliveryNoteEvidence ? (
                    <Badge className="bg-emerald-600">Đã đính kèm</Badge>
                  ) : (
                    <Badge variant="destructive">Bắt buộc</Badge>
                  )}
                </div>
                {imageUrl ? (
                  <img
                    src={imageUrl}
                    alt="Chứng từ phiếu nhập kho"
                    className="max-h-48 cursor-pointer rounded-lg border object-contain transition-opacity hover:opacity-80"
                    onClick={() => setImageOpen(true)}
                  />
                ) : (
                  <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-3 text-xs font-medium text-amber-800">
                    Phiếu nhập kho từ PO chưa có ảnh/chứng từ đính kèm. Tải/chụp phiếu giao hàng hoặc chứng từ PO trước khi nhập kho.
                  </div>
                )}
              </div>

              {isReceiveMode && (
                <div
                  className="space-y-3 rounded-2xl border border-primary/20 bg-primary/5 p-4"
                  data-bmq-goods-receipt-delivery-note-required
                  data-bmq-goods-receipt-ocr-assist
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="flex items-center gap-2 text-sm font-semibold text-primary">
                        <Camera className="h-4 w-4" />
                        Chụp/scan phiếu giao hàng bắt buộc
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Phiếu nhập kho PO luôn phải có ảnh/chứng từ đã upload để staff đối chiếu sau này. Nếu chứng từ NCC có lệch, dùng OCR rồi cập nhật số thực nhận trước khi chốt.
                      </p>
                    </div>
                    <label className="inline-flex cursor-pointer items-center justify-center rounded-md border border-primary/30 bg-background px-3 py-2 text-sm font-medium text-primary shadow-sm hover:bg-primary/10">
                      <Camera className="mr-2 h-4 w-4" />
                      Tải/chụp phiếu
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="sr-only"
                        onChange={async (event) => {
                          const file = event.target.files?.[0];
                          if (file) await handleDeliveryNoteSelect(file);
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                  </div>

                  <div className="grid gap-2 text-xs sm:grid-cols-3" data-bmq-goods-receipt-ocr-compare-po>
                    <div className="rounded-lg border border-border bg-card/80 p-2">
                      <p className="font-medium">1. OCR tự điền</p>
                      <p className="text-muted-foreground">Đọc số lượng từ phiếu giao hàng NCC.</p>
                    </div>
                    <div className="rounded-lg border border-border bg-card/80 p-2">
                      <p className="font-medium">2. So với PO</p>
                      <p className="text-muted-foreground">Tự flag đủ, thiếu, dư hoặc ngoài PO.</p>
                    </div>
                    <div className="rounded-lg border border-border bg-card/80 p-2">
                      <p className="font-medium">3. Nhân viên xác nhận cuối</p>
                      <p className="text-muted-foreground">Kho vẫn được sửa ngoại lệ trước khi chốt.</p>
                    </div>
                  </div>

                  {ocrDelivery.status !== "idle" && (
                    <div className="rounded-lg border border-border bg-background/80 p-3 text-sm">
                      <p className="flex items-center gap-2 font-medium">
                        {ocrDelivery.status === "uploading" || ocrDelivery.status === "ocr" ? (
                          <Loader2 className="h-4 w-4 animate-spin text-primary" />
                        ) : ocrDelivery.status === "done" ? (
                          <Sparkles className="h-4 w-4 text-primary" />
                        ) : (
                          <AlertTriangle className="h-4 w-4 text-amber-600" />
                        )}
                        {ocrDelivery.status === "uploading" && "Đang tải chứng từ..."}
                        {ocrDelivery.status === "ocr" && "Đang OCR phiếu giao hàng..."}
                        {ocrDelivery.status === "done" && `OCR tìm thấy ${ocrDelivery.suggestions.length} dòng khớp PO`}
                        {ocrDelivery.status === "error" && "OCR chưa đọc được, nhân viên nhập/sửa thủ công"}
                      </p>
                      {ocrDelivery.ocrError && <p className="mt-1 text-xs text-muted-foreground">{ocrDelivery.ocrError}</p>}
                      {ocrDelivery.suggestions.length > 0 && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="mt-3"
                          onClick={handleOcrPrefill}
                          data-bmq-goods-receipt-ocr-prefill-actuals
                        >
                          <Sparkles className="mr-2 h-4 w-4" />
                          Áp dụng OCR vào số thực nhận
                        </Button>
                      )}
                    </div>
                  )}

                  {!hasDeliveryNoteEvidence && (
                    <p className="flex items-center gap-1 text-xs font-medium text-amber-700" data-bmq-goods-receipt-evidence-required-always>
                      <AlertTriangle className="h-3 w-3" />
                      Bắt buộc đính kèm ảnh/chứng từ phiếu nhập trước khi Nhập kho + Tạo công nợ.
                    </p>
                  )}
                  {hasShortageItems && (
                    <p className="flex items-center gap-1 text-xs font-medium text-amber-700" data-bmq-goods-receipt-variance-evidence-required>
                      <AlertTriangle className="h-3 w-3" />
                      Thiếu/lệch hàng cần lý do và ảnh chứng từ để kế toán đối soát.
                    </p>
                  )}
                </div>
              )}

              <Separator />

              {/* Items */}
              <div>
                <h3 className="mb-3 font-medium">Danh sách sản phẩm</h3>

                {/* Receiving workflow banner */}
                {isReceiveMode && (
                  <div
                    className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm"
                    data-bmq-goods-receipt-receive-editor
                  >
                    <p className="font-semibold text-primary">Kế toán kho xác nhận thực nhận</p>
                    <p className="mt-1 text-muted-foreground">
                      Phiếu nhập đã nhận đủ thông tin từ PO và phải giữ ảnh/chứng từ đính kèm để đối chiếu. Mặc định số thực nhận bằng số đặt;
                      chỉ sửa hoặc OCR khi phiếu giao hàng có chênh lệch, rồi nhấn{" "}
                      <strong>Nhập kho + Tạo công nợ</strong>.
                    </p>
                    <p
                      className="mt-1.5 flex items-center gap-1 text-xs font-medium text-primary"
                      data-bmq-goods-receipt-actual-payable-only
                    >
                      <CheckCircle className="h-3 w-3" />
                      Công nợ theo thực nhận — thiếu hàng chỉ tính giá trị đã nhận.
                    </p>
                  </div>
                )}

                {/* Mobile cards */}
                <div className="space-y-3 md:hidden" data-bmq-goods-receipt-detail-mobile-item-cards>
                  {items?.map((item) => {
                    const draft = editDraft[item.id];
                    const orderedQty = Number(item.ordered_quantity ?? item.quantity ?? 0);
                    const draftActual = draft ? parseFloat(draft.actual_quantity) : NaN;
                    const isShort = !isNaN(draftActual) && draftActual < orderedQty;
                    const draftStatus = !isNaN(draftActual)
                      ? (draftActual < orderedQty ? "thieu" : "du")
                      : item.line_status;
                    const unitPrice = item.unit_price ?? item.purchase_order_items?.unit_price;
                    const estimatedAmount =
                      unitPrice != null && !isNaN(draftActual) ? draftActual * unitPrice : null;
                    const validationError = isReceiveMode ? validateLine(draft, orderedQty) : null;

                    return (
                      <div key={item.id} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="line-clamp-2 font-semibold text-foreground">{item.product_name}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              {item.product_skus?.sku_code ? <Badge variant="secondary">{item.product_skus.sku_code}</Badge> : null}
                              {lineStatusBadge(draftStatus)}
                              <span className="text-xs text-muted-foreground">{item.unit || "kg"}</span>
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-[11px] text-muted-foreground">Thực nhận</p>
                            {isReceiveMode ? (
                              <Input
                                type="number"
                                min={0}
                                max={orderedQty}
                                value={draft?.actual_quantity ?? ""}
                                onChange={e => updateDraft(item.id, "actual_quantity", e.target.value)}
                                className="mt-1 w-20 text-right font-mono"
                                data-bmq-goods-receipt-mobile-receive-editor
                              />
                            ) : (
                              <p className="font-mono text-lg font-bold text-primary">{(item.actual_quantity ?? item.quantity).toLocaleString("vi-VN")}</p>
                            )}
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
                          <div className="rounded-lg bg-muted/60 p-2">
                            <p className="text-[11px] text-muted-foreground">Đặt</p>
                            <p className="font-mono font-semibold">{orderedQty.toLocaleString("vi-VN")}</p>
                          </div>
                          <div className="rounded-lg bg-muted/60 p-2">
                            <p className="text-[11px] text-muted-foreground">HSD</p>
                            <p className="font-medium">{formatSafeDate(item.expiry_date)}</p>
                          </div>
                          <div className="rounded-lg bg-muted/60 p-2">
                            <p className="text-[11px] text-muted-foreground">Trạng thái</p>
                            <p className="font-medium">{lineStatusLabel(draftStatus)}</p>
                          </div>
                        </div>
                        {isReceiveMode && isShort && (
                          <div className="mt-2" data-bmq-goods-receipt-shortage-reason>
                            <Input
                              placeholder="Lý do thiếu hàng *"
                              value={draft?.variance_reason ?? ""}
                              onChange={e => updateDraft(item.id, "variance_reason", e.target.value)}
                              className="text-sm"
                            />
                          </div>
                        )}
                        {isReceiveMode && estimatedAmount != null && (
                          <p className="mt-2 text-right text-xs text-muted-foreground">
                            Thành tiền:{" "}
                            <span className="font-mono font-medium text-foreground">
                              {estimatedAmount.toLocaleString("vi-VN", { style: "currency", currency: "VND" })}
                            </span>
                          </p>
                        )}
                        {validationError && (
                          <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                            <AlertTriangle className="h-3 w-3" />{validationError}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Desktop table */}
                <div className="hidden overflow-x-auto rounded-xl border border-border md:block" data-bmq-goods-receipt-desktop-receive-editor>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Sản phẩm</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Đặt</TableHead>
                      <TableHead className="text-right">Thực nhận</TableHead>
                      {isReceiveMode && <TableHead>Lý do thiếu</TableHead>}
                      <TableHead>Trạng thái</TableHead>
                      <TableHead>Đơn vị</TableHead>
                      <TableHead>HSD</TableHead>
                      {hasUnitPrices && <TableHead className="text-right">Thành tiền</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items?.map((item) => {
                      const draft = editDraft[item.id];
                      const orderedQty = Number(item.ordered_quantity ?? item.quantity ?? 0);
                      const draftActual = draft ? parseFloat(draft.actual_quantity) : NaN;
                      const isShort = !isNaN(draftActual) && draftActual < orderedQty;
                      const draftStatus = !isNaN(draftActual)
                        ? (draftActual < orderedQty ? "thieu" : "du")
                        : item.line_status;
                      const unitPrice = item.unit_price ?? item.purchase_order_items?.unit_price;
                      const displayQty = isReceiveMode
                        ? (isNaN(draftActual) ? 0 : draftActual)
                        : Number(item.actual_quantity ?? item.quantity ?? 0);
                      const estimatedAmount = unitPrice != null ? displayQty * unitPrice : null;
                      const validationError = isReceiveMode ? validateLine(draft, orderedQty) : null;

                      return (
                        <TableRow key={item.id}>
                          <TableCell className="font-medium">
                            {item.product_name}
                            {validationError && (
                              <p className="mt-0.5 flex items-center gap-1 text-xs text-destructive">
                                <AlertTriangle className="h-3 w-3" />{validationError}
                              </p>
                            )}
                          </TableCell>
                          <TableCell>
                            {item.product_skus?.sku_code ? (
                              <Badge variant="secondary">{item.product_skus.sku_code}</Badge>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {orderedQty.toLocaleString("vi-VN")}
                          </TableCell>
                          <TableCell className="text-right">
                            {isReceiveMode ? (
                              <Input
                                type="number"
                                min={0}
                                max={orderedQty}
                                value={draft?.actual_quantity ?? ""}
                                onChange={e => updateDraft(item.id, "actual_quantity", e.target.value)}
                                className="w-24 text-right font-mono"
                              />
                            ) : (
                              <span className="font-mono">{(item.actual_quantity ?? item.quantity).toLocaleString("vi-VN")}</span>
                            )}
                          </TableCell>
                          {isReceiveMode && (
                            <TableCell>
                              {isShort && (
                                <Input
                                  placeholder="Lý do thiếu *"
                                  value={draft?.variance_reason ?? ""}
                                  onChange={e => updateDraft(item.id, "variance_reason", e.target.value)}
                                  className="min-w-[140px] text-sm"
                                  data-bmq-goods-receipt-shortage-reason
                                />
                              )}
                            </TableCell>
                          )}
                          <TableCell title={lineStatusLabel(draftStatus)}>{lineStatusBadge(draftStatus)}</TableCell>
                          <TableCell>{item.unit || "kg"}</TableCell>
                          <TableCell>{formatSafeDate(item.expiry_date)}</TableCell>
                          {hasUnitPrices && (
                            <TableCell className="text-right font-mono text-sm">
                              {estimatedAmount != null
                                ? estimatedAmount.toLocaleString("vi-VN", { style: "currency", currency: "VND" })
                                : "-"}
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
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
                <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3 sm:flex sm:items-center sm:justify-between sm:gap-3">
                  {!hasRequiredReceiptEvidence && (
                    <p className="mb-2 text-xs font-medium text-amber-700 sm:mb-0">PO nhập hàng bắt buộc có ảnh/chứng từ đã upload trên phiếu nhập kho trước khi nhập kho.</p>
                  )}
                  {hasRequiredReceiptEvidence && !hasRequiredVarianceEvidence && (
                    <p className="mb-2 text-xs font-medium text-amber-700 sm:mb-0">Có chênh lệch/thiếu hàng: cần chụp/scan phiếu giao hàng trước khi nhập kho.</p>
                  )}
                  <Button
                    className="btn-gradient w-full sm:w-auto"
                    onClick={handleConfirmReceipt}
                    disabled={isSubmitting || !canFinalize}
                  >
                    {isSubmitting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <CheckCircle className="h-4 w-4 mr-2" />
                    )}
                    Nhập kho + Tạo công nợ
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="m-4 rounded-xl border border-dashed border-border p-6 text-center text-muted-foreground">
              Chọn một phiếu nhập kho để xem chi tiết.
            </div>
          )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Image Preview Dialog */}
      <Dialog open={imageOpen} onOpenChange={setImageOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Ảnh/chứng từ phiếu nhập kho</DialogTitle>
          </DialogHeader>
          {imageUrl && (
            <div className="flex flex-col items-center gap-4">
              <img
                src={imageUrl}
                alt="Chứng từ phiếu nhập kho"
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
