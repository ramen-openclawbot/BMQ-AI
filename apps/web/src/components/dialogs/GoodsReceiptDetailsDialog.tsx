import { formatText } from "@/i18n/format";
import { goodsReceiptPurchasing } from "@/i18n/goodsReceiptPurchasing";
import { usePurchasingCopy, purchasingErrorMessage, renderPurchasingMessage } from "@/i18n/purchasingCopy";
import { format } from "date-fns";
import { vi } from "date-fns/locale";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { Camera, Sparkles, CheckCircle, Clock, FileCheck, Package, ExternalLink, Loader2, AlertCircle, Link2, XCircle, AlertTriangle, History } from "lucide-react";
import { useGoodsReceipt, useGoodsReceiptItems, useConfirmGoodsReceipt, useUpdateGoodsReceiptItems, useUpdateGoodsReceipt, getGoodsReceiptImageUrl, useDeliveryNoteOcr, usePaidPaymentRequestsForSupplier, useFinalizeHistoricalPaidGoodsReceipt } from "@/hooks/useGoodsReceipts";
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

export function GoodsReceiptDetailsDialog({ receiptId, open, onOpenChange }: GoodsReceiptDetailsDialogProps) {
  const pc = usePurchasingCopy(goodsReceiptPurchasing);
  const approvalLabels: Record<string, string> = { pending: pc.approvalPending, approved: pc.approvalApproved, rejected: pc.approvalRejected, completed: pc.approvalCompleted };
  const materialLabels: Record<string, string> = { pending: pc.materialPending, resolved_exact: pc.materialExact, needs_review: pc.materialReview, blocked: pc.materialBlocked };

function validateLine(draft: LineEdit | undefined, orderedQty: number): string | null {
  if (!draft) return pc.quantityMissing;
  const n = parseFloat(draft.actual_quantity);
  if (isNaN(n) || n < 0) return pc.quantityInvalid;
  if (n > orderedQty) return pc.quantityExceedsOrder;
  if (n < orderedQty && !draft.variance_reason.trim()) return pc.shortageReasonRequired;
  return null;
}

function getConfirmReceiptErrorMessage(error: unknown): string {
  return renderPurchasingMessage(pc, purchasingErrorMessage(error, "receiveError"));
}


  const { data: receipt, isLoading: receiptLoading, error: receiptError } = useGoodsReceipt(receiptId);
  const { data: items = [], isLoading: itemsLoading } = useGoodsReceiptItems(receiptId);
  const confirmReceipt = useConfirmGoodsReceipt();
  const finalizeHistoricalPaidReceipt = useFinalizeHistoricalPaidGoodsReceipt();
  const updateItems = useUpdateGoodsReceiptItems();
  const updateReceipt = useUpdateGoodsReceipt();
  const ocrDelivery = useDeliveryNoteOcr();
  const [imageOpen, setImageOpen] = useState(false);
  const [historicalDialogOpen, setHistoricalDialogOpen] = useState(false);
  const [selectedHistoricalPaymentRequestId, setSelectedHistoricalPaymentRequestId] = useState("");
  const [historicalStockConfirmed, setHistoricalStockConfirmed] = useState(false);
  const [historicalReconciliationReason, setHistoricalReconciliationReason] = useState("");
  const [editDraft, setEditDraft] = useState<Record<string, LineEdit>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [deliveryNotePath, setDeliveryNotePath] = useState<string | null>(null);
  const { data: paidHistoricalRequests = [], isLoading: paidHistoricalRequestsLoading } = usePaidPaymentRequestsForSupplier(
    receipt?.purchase_order_id ? null : receipt?.supplier_id || null,
    receiptId,
  );

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
    setHistoricalDialogOpen(false);
    setSelectedHistoricalPaymentRequestId("");
    setHistoricalStockConfirmed(false);
    setHistoricalReconciliationReason("");
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
    const safeItemIds = new Set(
      ocrDelivery.materialResolutions
        .filter((line) => line.resolved_exact === true || Boolean(line.material_resolution_request_id))
        .map((line) => line.matchedItemId)
        .filter(Boolean) as string[],
    );
    setEditDraft(prev => {
      const next = { ...prev };
      for (const suggestion of ocrDelivery.suggestions) {
        if (!next[suggestion.itemId]) continue;
        if (safeItemIds.size > 0 && !safeItemIds.has(suggestion.itemId)) continue;
        const item = items.find(i => i.id === suggestion.itemId);
        const orderedQty = Number(item?.ordered_quantity ?? item?.quantity ?? 0);
        next[suggestion.itemId] = {
          ...next[suggestion.itemId],
          actual_quantity: String(Math.min(suggestion.suggestedQuantity, orderedQty)),
        };
      }
      return next;
    });
    toast.success(pc.safeOCRQuantitiesAppliedFuzzyNamesWereNot);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />{pc.draft}</Badge>;
      case "confirmed":
        return <Badge variant="default"><FileCheck className="h-3 w-3 mr-1" />{pc.confirmed}</Badge>;
      case "received":
        return <Badge className="bg-green-500"><CheckCircle className="h-3 w-3 mr-1" />{pc.received}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getPayableBadge = () => {
    if (receipt?.payment_requests?.payment_status === "paid") {
      return <Badge className="bg-blue-600"><CheckCircle className="h-3 w-3 mr-1" />{pc.paidInAdvance}</Badge>;
    }
    if (receipt?.payable_status === "generated") {
      return <Badge className="bg-emerald-600"><CheckCircle className="h-3 w-3 mr-1" />{pc.payableCreated}</Badge>;
    }
    if (receipt?.payable_status === "pending") {
      return <Badge variant="default"><Clock className="h-3 w-3 mr-1" />{pc.processingPayable}</Badge>;
    }
    return <Badge variant="outline"><AlertCircle className="h-3 w-3 mr-1" />{pc.noPayableCreated}</Badge>;
  };

  const lineStatusLabel = (status?: string | null) => {
    if (status === "thieu") return pc.short;
    if (status === "du_thua") return pc.excess;
    if (status === "du") return pc.complete;
    return "-";
  };

  const lineStatusBadge = (status?: string | null) => {
    if (status === "thieu") return <Badge variant="destructive">{pc.short}</Badge>;
    if (status === "du_thua") return <Badge variant="secondary">{pc.excess}</Badge>;
    if (status === "du") return <Badge className="bg-green-500">{pc.complete}</Badge>;
    return <Badge variant="outline">-</Badge>;
  };

  const renderMaterialResolution = (item: typeof items[number]) => {
    const latest = getMaterialResolutionForItem(item);
    const status = getMaterialStatus(item);
    const canonicalName = latest?.canonical_material_name || item.canonical_materials?.canonical_name;
    const canonicalCode = latest?.canonical_material_code || item.canonical_materials?.material_code;
    const rawName = latest?.product_name || item.raw_product_name || item.product_name;
    const requestId = latest?.material_resolution_request_id || item.material_resolution_request_id;
    const blockers = latest?.blockers || [];
    const candidateNames = latest?.candidate_names || [];
    const exact = latest?.resolved_exact === true || Boolean(item.canonical_material_id);

    if (exact) {
      return (
        <div className="mt-1 space-y-1 text-xs" data-bmq-goods-receipt-material-resolution>
          <p className="text-muted-foreground">{pc.originalOCRName} <span className="font-medium text-foreground">{rawName}</span></p>
          <p className="text-emerald-700">{pc.canonicalMaterial} <span className="font-semibold">{canonicalCode ? `${canonicalCode} · ` : ""}{canonicalName || item.product_name}</span></p>
        </div>
      );
    }

    return (
      <div className="mt-1 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900" data-bmq-goods-receipt-material-resolution>
        <p className="font-semibold">{pc.materialReviewRequired}</p>
        <p>{pc.originalOCRName} <span className="font-medium">{rawName}</span></p>
        <p>{pc.status2} {materialLabels[status] || status}{requestId ? formatText(pc.message164, { v0: requestId.slice(0, 8) }) : ""}</p>
        {blockers.length > 0 && <p>{pc.blocker} {blockers.join(", ")}</p>}
        {candidateNames.length > 0 && <p>{pc.suggestions} {candidateNames.join("; ")}</p>}
        <a href="/material-master" className="mt-1 inline-flex items-center gap-1 font-medium text-primary hover:underline">
           {pc.openMaterialMasterQueue} <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    );
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
  const latestMaterialResolutionByItemId = new Map(
    ocrDelivery.materialResolutions
      .filter((line) => line.matchedItemId)
      .map((line) => [line.matchedItemId as string, line]),
  );
  const getMaterialResolutionForItem = (item: typeof items[number]) => latestMaterialResolutionByItemId.get(item.id);
  const getMaterialStatus = (item: typeof items[number]) => {
    const latest = getMaterialResolutionForItem(item);
    return latest?.material_resolution_status || item.material_resolution_status || (item.canonical_material_id ? "resolved_exact" : "pending");
  };
  const hasMaterialResolutionBlockers = isReceiveMode && items.some((item) => {
    const latest = getMaterialResolutionForItem(item);
    const exact = latest?.resolved_exact === true || Boolean(item.canonical_material_id);
    return !exact;
  });

  const canFinalize =
    isReceiveMode &&
    items.length > 0 &&
    hasRequiredReceiptEvidence &&
    hasRequiredVarianceEvidence &&
    !hasMaterialResolutionBlockers &&
    items.every(item => {
      const orderedQty = Number(item.ordered_quantity ?? item.quantity ?? 0);
      return validateLine(editDraft[item.id], orderedQty) === null;
    });
  const isHistoricalPaidEligible = isReceiveMode && !receipt?.purchase_order_id;
  const selectedHistoricalPaymentRequest = paidHistoricalRequests.find(
    request => request.id === selectedHistoricalPaymentRequestId,
  );

  const handleConfirmReceipt = async () => {
    if (!receiptId || !isReceiveMode) return;

    if (!hasRequiredReceiptEvidence) {
      toast.error(pc.aPOGoodsReceiptRequiresAnUploadedImage);
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
      toast.success(pc.goodsReceivedAndPayableCreatedForApproval);
      onOpenChange(false);
    } catch (error) {
      toast.error(getConfirmReceiptErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  const handleFinalizeHistoricalPaidReceipt = async () => {
    if (
      !receiptId ||
      !isHistoricalPaidEligible ||
      !selectedHistoricalPaymentRequestId ||
      !historicalStockConfirmed ||
      !historicalReconciliationReason.trim()
    ) return;
    if (!hasRequiredReceiptEvidence) {
      toast.error(pc.aPaidHistoricalOrderRequiresAnImageDocument);
      return;
    }

    const payload = [];
    for (const item of items) {
      const orderedQty = Number(item.ordered_quantity ?? item.quantity ?? 0);
      const err = validateLine(editDraft[item.id], orderedQty);
      if (err) {
        toast.error(`${item.product_name}: ${err}`);
        return;
      }
      const draft = editDraft[item.id]!;
      const actualQty = parseFloat(draft.actual_quantity);
      payload.push({
        id: item.id,
        actual_quantity: actualQty,
        line_status: actualQty < orderedQty ? "thieu" : "du",
        variance_reason: draft.variance_reason.trim() || null,
      });
    }

    try {
      setIsSaving(true);
      await updateItems.mutateAsync({ receiptId, items: payload });
      await finalizeHistoricalPaidReceipt.mutateAsync({
        receiptId,
        historicalPaymentRequestId: selectedHistoricalPaymentRequestId,
        historicalStockNotIncludedConfirmed: historicalStockConfirmed,
        historicalReconciliationReason: historicalReconciliationReason.trim(),
      });
      toast.success(pc.historicalOrderReceivedAndLinkedToTheExisting);
      setHistoricalDialogOpen(false);
      onOpenChange(false);
    } catch (error) {
      toast.error(getConfirmReceiptErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  const isSubmitting = isSaving || confirmReceipt.isPending || finalizeHistoricalPaidReceipt.isPending || updateItems.isPending;

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
                <span className="block truncate">{pc.goodsReceiptDetails}</span>
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
               {pc.loadingGoodsReceiptDetails} </div>
          ) : receiptError ? (
            <div className="m-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              <div className="mb-1 flex items-center gap-2 font-semibold"><XCircle className="h-4 w-4" />{pc.unableToLoadGoodsReceiptDetails}</div>
              <p>{pc.pleaseRetryOrReloadThePageTheList}</p>
            </div>
          ) : receipt ? (
            <div className="space-y-4 p-4 sm:space-y-6 sm:p-6">
              <div className="rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/10 via-background to-card p-4 shadow-sm" data-bmq-goods-receipt-detail-mobile-hero>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-primary">{pc.goodsReceipt}</p>
                    <p className="mt-1 truncate font-mono text-xl font-bold text-foreground">{receipt.receipt_number}</p>
                    <p className="mt-1 truncate text-sm font-medium text-muted-foreground">{receipt.suppliers?.name || pc.noSupplier}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {getStatusBadge(receipt.status)}
                    {getPayableBadge()}
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center" data-bmq-goods-receipt-detail-mobile-summary>
                  <div className="rounded-xl border border-border/70 bg-card/80 p-3">
                    <p className="text-[11px] text-muted-foreground">{pc.lineItems}</p>
                    <p className="text-lg font-bold text-foreground">{itemCount}</p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-card/80 p-3">
                    <p className="text-[11px] text-muted-foreground">{pc.actualReceived}</p>
                    <p className="text-lg font-bold text-foreground">{actualTotal.toLocaleString("vi-VN")}</p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-card/80 p-3">
                    <p className="text-[11px] text-muted-foreground">{pc.variance}</p>
                    <p className={varianceCount > 0 ? "text-lg font-bold text-amber-700" : "text-lg font-bold text-emerald-700"}>{varianceCount}</p>
                  </div>
                </div>
              </div>

              {/* Receipt Info */}
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-background/70 p-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">{pc.documentNumber}</p>
                  <p className="font-mono font-medium">{receipt.receipt_number}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{pc.status}</p>
                  <div className="mt-1">{getStatusBadge(receipt.status)}</div>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{pc.suppliers}</p>
                  <p className="font-medium">{receipt.suppliers?.name || "-"}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{pc.receiptDate2}</p>
                  <p className="font-medium">
                    {formatSafeDate(receipt.receipt_date)}
                  </p>
                </div>
              </div>

              {/* Payable audit */}
              <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">{pc.payableReconciliation}</p>
                    <p className="text-xs text-muted-foreground">{pc.linkPOGoodsReceiptAccountsPayable}</p>
                  </div>
                  {getPayableBadge()}
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                  <div>
                    <p className="text-muted-foreground">{pc.pONumber}</p>
                    <p className="font-mono font-medium">{receipt.purchase_orders?.po_number || "-"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">{pc.payableNumber}</p>
                    <p className="font-mono font-medium">{receipt.payment_requests?.request_number || "-"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">{pc.approvalStatus}</p>
                    <p className="font-medium">{approvalLabels[receipt.payment_requests?.status || ""] || receipt.payment_requests?.status || "-"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">{pc.finalizedOn}</p>
                    <p className="font-medium">
                      {formatSafeDate(receipt.finalized_at, "dd/MM/yyyy HH:mm")}
                    </p>
                  </div>
                </div>
                {receipt.variance_summary && (
                  <p className="text-xs text-muted-foreground">
                     {pc.varianceSummary} {JSON.stringify(receipt.variance_summary)}
                  </p>
                )}
                {isFinalizedWithPayable && (
                  <p className="flex items-center gap-1 text-xs text-emerald-700">
                    <Link2 className="h-3 w-3" />
                     {pc.doNotFinalizeAReceiptAgainAfterA} </p>
                )}
              </div>

              {/* Image */}
              <div className="rounded-xl border border-border bg-background/70 p-4" data-bmq-goods-receipt-attached-evidence>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{pc.goodsReceiptImageDocument}</p>
                    <p className="text-xs text-muted-foreground">{pc.staffCanReopenThisToReconcileThePO}</p>
                  </div>
                  {hasDeliveryNoteEvidence ? (
                    <Badge className="bg-emerald-600">{pc.attached}</Badge>
                  ) : (
                    <Badge variant="destructive">{pc.required}</Badge>
                  )}
                </div>
                {imageUrl ? (
                  <img
                    src={imageUrl}
                    alt={pc.goodsReceiptDocument}
                    className="max-h-48 cursor-pointer rounded-lg border object-contain transition-opacity hover:opacity-80"
                    onClick={() => setImageOpen(true)}
                  />
                ) : (
                  <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-3 text-xs font-medium text-amber-800">
                     {pc.thisPOGoodsReceiptHasNoAttachedImage} </div>
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
                         {pc.deliveryNoteCaptureScanRequired} </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                         {pc.pOGoodsReceiptsAlwaysRequireAnUploadedImage} </p>
                    </div>
                    <label className="inline-flex cursor-pointer items-center justify-center rounded-md border border-primary/30 bg-background px-3 py-2 text-sm font-medium text-primary shadow-sm hover:bg-primary/10">
                      <Camera className="mr-2 h-4 w-4" />
                       {pc.uploadCaptureDocument} <input
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
                      <p className="font-medium">{pc["1OCRAutofill"]}</p>
                      <p className="text-muted-foreground">{pc.readQuantitiesFromTheSupplierDeliveryNote}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-card/80 p-2">
                      <p className="font-medium">{pc["2CompareWithPO"]}</p>
                      <p className="text-muted-foreground">{pc.flagCompleteShortExcessOrNonPOItems}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-card/80 p-2">
                      <p className="font-medium">{pc["3StaffConfirmation"]}</p>
                      <p className="text-muted-foreground">{pc.warehouseStaffCanStillAdjustExceptionsBeforeFinalizing}</p>
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
                        {ocrDelivery.status === "uploading" && pc.uploadingDocument}
                        {ocrDelivery.status === "ocr" && pc.readingDeliveryNoteWithOCR}
                        {ocrDelivery.status === "done" && formatText(pc.message165, { v0: ocrDelivery.suggestions.length })}
                        {ocrDelivery.status === "error" && pc.oCRCouldNotReadTheDocumentStaffCan}
                      </p>
                      {ocrDelivery.ocrError && <p className="mt-1 text-xs text-muted-foreground">{renderPurchasingMessage(pc, ocrDelivery.ocrError)}</p>}
                      {ocrDelivery.suggestions.length > 0 && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="mt-3"
                          onClick={handleOcrPrefill}
                          data-bmq-goods-receipt-ocr-prefill-actuals
                          data-bmq-goods-receipt-ocr-safe-quantity-only
                        >
                          <Sparkles className="mr-2 h-4 w-4" />
                           {pc.applyOCRToActualQuantities} </Button>
                      )}
                    </div>
                  )}

                  {!hasDeliveryNoteEvidence && (
                    <p className="flex items-center gap-1 text-xs font-medium text-amber-700" data-bmq-goods-receipt-evidence-required-always>
                      <AlertTriangle className="h-3 w-3" />
                       {pc.attachAReceiptImageDocumentBeforeReceiveCreate} </p>
                  )}
                  {hasShortageItems && (
                    <p className="flex items-center gap-1 text-xs font-medium text-amber-700" data-bmq-goods-receipt-variance-evidence-required>
                      <AlertTriangle className="h-3 w-3" />
                       {pc.shortagesVariancesRequireAReasonAndDocumentImage} </p>
                  )}
                  {hasMaterialResolutionBlockers && (
                    <p className="flex items-center gap-1 text-xs font-medium text-amber-700">
                      <AlertTriangle className="h-3 w-3" />
                       {pc.resolveMaterialsInMaterialMasterBeforeReceiveCreate} </p>
                  )}
                </div>
              )}

              <Separator />

              {/* Items */}
              <div>
                <h3 className="mb-3 font-medium">{pc.productList}</h3>

                {/* Receiving workflow banner */}
                {isReceiveMode && (
                  <div
                    className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm"
                    data-bmq-goods-receipt-receive-editor
                  >
                    <p className="font-semibold text-primary">{pc.warehouseAccountingConfirmsActualReceipt}</p>
                    <p className="mt-1 text-muted-foreground">
                       {pc.theReceiptHasFullPODetailsAndMust}{" "}
                      <strong>{pc.receiveCreatePayable}</strong>.
                    </p>
                    <p
                      className="mt-1.5 flex items-center gap-1 text-xs font-medium text-primary"
                      data-bmq-goods-receipt-actual-payable-only
                    >
                      <CheckCircle className="h-3 w-3" />
                       {pc.payablesUseActualQuantitiesReceivedShortagesAreCharged} </p>
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
                            <p className="text-[11px] text-muted-foreground">{pc.actualReceived}</p>
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
                            <p className="text-[11px] text-muted-foreground">{pc.ordered}</p>
                            <p className="font-mono font-semibold">{orderedQty.toLocaleString("vi-VN")}</p>
                          </div>
                          <div className="rounded-lg bg-muted/60 p-2">
                            <p className="text-[11px] text-muted-foreground">{pc.expiry}</p>
                            <p className="font-medium">{formatSafeDate(item.expiry_date)}</p>
                          </div>
                          <div className="rounded-lg bg-muted/60 p-2">
                            <p className="text-[11px] text-muted-foreground">{pc.status}</p>
                            <p className="font-medium">{lineStatusLabel(draftStatus)}</p>
                          </div>
                        </div>
                        {renderMaterialResolution(item)}
                        {isReceiveMode && isShort && (
                          <div className="mt-2" data-bmq-goods-receipt-shortage-reason>
                            <Input
                              placeholder={pc.shortageReason}
                              value={draft?.variance_reason ?? ""}
                              onChange={e => updateDraft(item.id, "variance_reason", e.target.value)}
                              className="text-sm"
                            />
                          </div>
                        )}
                        {isReceiveMode && estimatedAmount != null && (
                          <p className="mt-2 text-right text-xs text-muted-foreground">
                             {pc.lineTotal}{" "}
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
                      <TableHead>{pc.product}</TableHead>
                      <TableHead>{pc.fieldSKU}</TableHead>
                      <TableHead className="text-right">{pc.ordered}</TableHead>
                      <TableHead className="text-right">{pc.actualReceived}</TableHead>
                      {isReceiveMode && <TableHead>{pc.shortageReason2}</TableHead>}
                      <TableHead>{pc.status}</TableHead>
                      <TableHead>{pc.unit}</TableHead>
                      <TableHead>{pc.expiry}</TableHead>
                      {hasUnitPrices && <TableHead className="text-right">{pc.lineTotal2}</TableHead>}
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
                            {renderMaterialResolution(item)}
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
                                  placeholder={pc.shortageReason3}
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
                  <span className="font-medium">{pc.totalQuantity}</span>
                  <span className="text-lg font-bold">
                    {receipt.total_quantity?.toLocaleString("vi-VN") || 0}
                  </span>
                </div>
              </div>

              {/* Notes */}
              {receipt.notes && (
                <div>
                  <p className="text-sm text-muted-foreground">{pc.notes}</p>
                  <p className="mt-1">{receipt.notes}</p>
                </div>
              )}

              {/* Actions */}
              {receipt.status === "confirmed" && !isFinalizedWithPayable && (
                <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3 sm:flex sm:items-center sm:justify-between sm:gap-3">
                  {!hasRequiredReceiptEvidence && (
                    <p className="mb-2 text-xs font-medium text-amber-700 sm:mb-0">{pc.pOReceiptsRequireAnUploadedImageDocumentBefore}</p>
                  )}
                  {hasRequiredReceiptEvidence && !hasRequiredVarianceEvidence && (
                    <p className="mb-2 text-xs font-medium text-amber-700 sm:mb-0">{pc.forVariancesShortagesCaptureOrScanTheDelivery}</p>
                  )}
                  <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                    {isHistoricalPaidEligible && (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full border-blue-300 text-blue-700 sm:w-auto"
                        onClick={() => setHistoricalDialogOpen(true)}
                        disabled={isSubmitting || !canFinalize}
                        data-bmq-historical-paid-receipt-flow
                      >
                        <History className="mr-2 h-4 w-4" />
                         {pc.receivePaidHistoricalOrder} </Button>
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
                       {pc.receiveCreatePayable} </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="m-4 rounded-xl border border-dashed border-border p-6 text-center text-muted-foreground">
               {pc.selectAGoodsReceiptToViewDetails} </div>
          )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={historicalDialogOpen} onOpenChange={setHistoricalDialogOpen}>
        <DialogContent className="max-w-lg" data-bmq-historical-paid-receipt-flow>
          <DialogHeader>
            <DialogTitle>{pc.receivePaidHistoricalOrder}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
              <p className="font-semibold">{pc.useOnlyWhenThePurchaseHasBeenFully}</p>
              <p className="mt-1 text-xs">{pc.theSystemLinksThePaidPaymentRequestUses} <strong>{pc.createsNoNewPayable}</strong>.</p>
            </div>

            <div>
              <label htmlFor="historical-payment-request" className="mb-1.5 block text-sm font-medium">{pc.existingPayment}</label>
              <select
                id="historical-payment-request"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={selectedHistoricalPaymentRequestId}
                onChange={event => setSelectedHistoricalPaymentRequestId(event.target.value)}
                disabled={paidHistoricalRequestsLoading || isSubmitting}
              >
                <option value="">{paidHistoricalRequestsLoading ? pc.loading : pc.selectPaidPaymentRequest}</option>
                {paidHistoricalRequests.map(request => (
                  <option key={request.id} value={request.id}>
                    {request.request_number} · {Number(request.total_amount || 0).toLocaleString("vi-VN")}đ · {formatSafeDate(request.paid_at)}
                  </option>
                ))}
              </select>
              {!paidHistoricalRequestsLoading && paidHistoricalRequests.length === 0 && (
                <p className="mt-1 text-xs text-amber-700">{pc.noUnlinkedPaymentsFoundForThisSupplier}</p>
              )}
            </div>

            {selectedHistoricalPaymentRequest && (
              <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
                <p className="font-mono font-semibold">{selectedHistoricalPaymentRequest.request_number}</p>
                <p className="mt-1 text-muted-foreground">{selectedHistoricalPaymentRequest.title || pc.supplierPayment}</p>
                <p className="mt-1 font-semibold">{Number(selectedHistoricalPaymentRequest.total_amount || 0).toLocaleString("vi-VN")}đ</p>
              </div>
            )}

            <div>
              <label htmlFor="historical-reconciliation-reason" className="mb-1.5 block text-sm font-medium">
                 {pc.reconciliationReason} </label>
              <textarea
                id="historical-reconciliation-reason"
                className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={historicalReconciliationReason}
                onChange={event => setHistoricalReconciliationReason(event.target.value)}
                placeholder={pc.eGJuneOrderWasPaidButNot}
                disabled={isSubmitting}
                maxLength={500}
              />
            </div>

            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-amber-400"
                checked={historicalStockConfirmed}
                onChange={event => setHistoricalStockConfirmed(event.target.checked)}
                disabled={isSubmitting}
              />
              <span>
                <strong>{pc.confirmThatCurrentInventoryDoesNotIncludeThis}</strong>
                <span className="mt-1 block text-xs">{pc.ifTheseGoodsAreAlreadyIncludedInOpening}</span>
              </span>
            </label>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={() => setHistoricalDialogOpen(false)} disabled={isSubmitting}>{pc.cancel}</Button>
              <Button
                type="button"
                className="bg-blue-600 text-white hover:bg-blue-700"
                onClick={handleFinalizeHistoricalPaidReceipt}
                disabled={
                  isSubmitting ||
                  !selectedHistoricalPaymentRequestId ||
                  !historicalStockConfirmed ||
                  !historicalReconciliationReason.trim() ||
                  !canFinalize
                }
              >
                {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <History className="mr-2 h-4 w-4" />}
                 {pc.receiveWithoutCreatingAPayable} </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Image Preview Dialog */}
      <Dialog open={imageOpen} onOpenChange={setImageOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{pc.goodsReceiptImageDocument}</DialogTitle>
          </DialogHeader>
          {imageUrl && (
            <div className="flex flex-col items-center gap-4">
              <img
                src={imageUrl}
                alt={pc.goodsReceiptDocument}
                className="max-h-[70vh] rounded-lg object-contain"
              />
              <Button variant="outline" asChild>
                <a href={imageUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" />
                   {pc.openInNewTab} </a>
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
