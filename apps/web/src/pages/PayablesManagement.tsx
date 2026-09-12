import { useMemo, useState } from "react";
import { format } from "date-fns";
import {
  CheckCircle2,
  Clock3,
  Eye,
  PackageCheck,
  RefreshCw,
  Search,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaymentRequestDetailsDialog } from "@/components/dialogs/PaymentRequestDetailsDialog";
import {
  getAllocatedAmount,
  getRemainingPaymentAmount,
  hasOutstandingPayment,
  useBulkMarkPaid,
  usePaymentRequests,
  type PaymentRequestWithSupplier,
} from "@/hooks/usePaymentRequests";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { payables } from "@/i18n/payables";
import { formatText } from "@/i18n/format";

type PayableStatusFilter = "all" | "unpaid" | "partial" | "paid" | "overpaid";
type ApprovalStatusFilter = "all" | "pending" | "approved" | "rejected";
type SourceFilter = "warehouse_receipt" | "invoice" | "purchase_order" | "ocr_scan" | "manual" | "all";

type PayableSource = Exclude<SourceFilter, "all">;

const PAGE_SIZE = 20;

const normalizeSearch = (value: string | null | undefined) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .trim();

const formatCurrency = (amount: number) =>
  `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(amount)} đ`;

const errorMessage = (error: unknown) =>
  error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : typeof error === "string" ? error : "";

const getRequestCode = (paymentRequest: PaymentRequestWithSupplier) =>
  paymentRequest.request_number || paymentRequest.title || `CN-${paymentRequest.id.slice(0, 8).toUpperCase()}`;

const isWarehouseReceiptPayable = (paymentRequest: PaymentRequestWithSupplier) =>
  Boolean(paymentRequest.goods_receipt_id);

const getPayableSource = (paymentRequest: PaymentRequestWithSupplier): PayableSource => {
  if (paymentRequest.goods_receipt_id) return "warehouse_receipt";
  if (paymentRequest.invoice_id) return "invoice";
  if (paymentRequest.purchase_order_id) return "purchase_order";
  if (paymentRequest.image_url) return "ocr_scan";
  return "manual";
};

const getPaymentStatusLabel = (copy: typeof payables.vi, paymentRequest: PaymentRequestWithSupplier) => {
  if (paymentRequest.payment_status === "paid") return copy.paid;
  if (paymentRequest.payment_status === "partial") return copy.partial;
  if (paymentRequest.payment_status === "overpaid") return copy.overpaid;
  return copy.unpaid;
};

const getApprovalStatusLabel = (copy: typeof payables.vi, status: PaymentRequestWithSupplier["status"]) => {
  if (status === "approved") return copy.approved;
  if (status === "rejected") return copy.rejected;
  return copy.pending;
};

const getPaymentMethodLabel = (copy: typeof payables.vi, paymentRequest: PaymentRequestWithSupplier) => {
  if (paymentRequest.payment_method === "bank_transfer") return "UNC";
  if (paymentRequest.payment_method === "cash") return copy.cash;
  return copy.notSelected;
};

const getProductNames = (paymentRequest: PaymentRequestWithSupplier) => {
  const uniqueNames = new Set<string>();
  paymentRequest.payment_request_items?.forEach((item) => {
    const productName = item.product_name?.trim() || item.raw_product_name?.trim();
    if (productName) uniqueNames.add(productName);
  });
  return Array.from(uniqueNames);
};

const PayablesManagement = () => {
  const { language } = useLanguage();
  const copy = payables[language];
  const { canEditModule } = useAuth();
  const canEditPaymentRequests = canEditModule("payment_requests");
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<PayableStatusFilter>("all");
  const [approvalStatusFilter, setApprovalStatusFilter] = useState<ApprovalStatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [currentPage, setCurrentPage] = useState(1);

  const { data: paymentRequests, isLoading, isError, error, refetch } = usePaymentRequests();
  const bulkMarkPaid = useBulkMarkPaid();

  const filteredPayables = useMemo(() => {
    const normalizedSearchTerm = normalizeSearch(searchTerm);

    return (paymentRequests || []).filter((paymentRequest) => {
      if (sourceFilter !== "all" && getPayableSource(paymentRequest) !== sourceFilter) return false;
      if (paymentStatusFilter !== "all" && paymentRequest.payment_status !== paymentStatusFilter) return false;
      if (approvalStatusFilter !== "all" && paymentRequest.status !== approvalStatusFilter) return false;

      if (!normalizedSearchTerm) return true;

      const haystack = [
        paymentRequest.suppliers?.name,
        getRequestCode(paymentRequest),
        paymentRequest.title,
        paymentRequest.goods_receipts?.receipt_number,
        paymentRequest.purchase_orders?.po_number,
        getProductNames(paymentRequest).join(" "),
      ]
        .map(normalizeSearch)
        .join(" ");

      return haystack.includes(normalizedSearchTerm);
    });
  }, [paymentRequests, searchTerm, sourceFilter, paymentStatusFilter, approvalStatusFilter]);

  const stats = useMemo(() => {
    return filteredPayables.reduce(
      (summary, paymentRequest) => {
        const amount = Number(paymentRequest.total_amount) || 0;
        const remaining = getRemainingPaymentAmount(paymentRequest);
        summary.totalAmount += amount;
        summary.remainingAmount += remaining;
        summary.count += 1;
        if (paymentRequest.status === "pending") summary.pendingApproval += 1;
        if (paymentRequest.payment_status === "paid" || remaining <= 0) {
          summary.paidAmount += amount;
          summary.paidCount += 1;
        } else {
          summary.outstandingAmount += remaining;
          summary.outstandingCount += 1;
        }
        if (isWarehouseReceiptPayable(paymentRequest)) {
          summary.warehouseAmount += amount;
          summary.warehouseCount += 1;
        }
        return summary;
      },
      {
        count: 0,
        totalAmount: 0,
        remainingAmount: 0,
        outstandingAmount: 0,
        outstandingCount: 0,
        paidAmount: 0,
        paidCount: 0,
        pendingApproval: 0,
        warehouseAmount: 0,
        warehouseCount: 0,
      }
    );
  }, [filteredPayables]);

  const totalPages = Math.max(1, Math.ceil(filteredPayables.length / PAGE_SIZE));
  const currentPageSafe = Math.min(currentPage, totalPages);
  const pageStartIndex = (currentPageSafe - 1) * PAGE_SIZE;
  const paginatedPayables = filteredPayables.slice(pageStartIndex, pageStartIndex + PAGE_SIZE);
  const pageEndIndex = Math.min(pageStartIndex + paginatedPayables.length, filteredPayables.length);

  const handleSearchChange = (value: string) => {
    setSearchTerm(value);
    setCurrentPage(1);
  };

  const handlePaymentStatusFilterChange = (value: PayableStatusFilter) => {
    setPaymentStatusFilter(value);
    setCurrentPage(1);
  };

  const handleApprovalStatusFilterChange = (value: ApprovalStatusFilter) => {
    setApprovalStatusFilter(value);
    setCurrentPage(1);
  };

  const handleSourceFilterChange = (value: SourceFilter) => {
    setSourceFilter(value);
    setCurrentPage(1);
  };

  const statCards = [
    {
      label: copy.totalPayables,
      value: formatCurrency(stats.totalAmount),
      helper: formatText(copy.documents, { count: stats.count }),
      icon: Wallet,
      tone: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200",
    },
    {
      label: copy.outstanding,
      value: formatCurrency(stats.outstandingAmount),
      helper: formatText(copy.unsettledDocuments, { count: stats.outstandingCount }),
      icon: Clock3,
      tone: "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/20 dark:text-rose-200",
    },
    {
      label: copy.paid,
      value: formatCurrency(stats.paidAmount),
      helper: formatText(copy.documents, { count: stats.paidCount }),
      icon: CheckCircle2,
      tone: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-200",
    },
    {
      label: copy.warehousePayables,
      value: formatCurrency(stats.warehouseAmount),
      helper: formatText(copy.warehouseDocuments, { count: stats.warehouseCount }),
      icon: PackageCheck,
      tone: "border-slate-200 bg-white text-slate-800 dark:border-slate-800 dark:bg-card dark:text-slate-100",
    },
  ];

  const handleMarkPaid = async (paymentRequest: PaymentRequestWithSupplier) => {
    if (!canEditPaymentRequests) {
      toast.error(copy.noPermission);
      return;
    }

    if (!hasOutstandingPayment(paymentRequest)) {
      toast.info(copy.nothingToPay);
      return;
    }

    try {
      await bulkMarkPaid.mutateAsync([paymentRequest.id]);
      toast.success(copy.paymentRecorded);
    } catch (markPaidError) {
      const message = errorMessage(markPaidError);
      toast.error(copy.updateError, {
        description: message || copy.retry,
      });
    }
  };

  const renderSourceBadge = (paymentRequest: PaymentRequestWithSupplier) => {
    const source = getPayableSource(paymentRequest);

    if (source === "invoice") {
      return (
        <div className="space-y-1 text-xs">
          <Badge className="bg-blue-600 text-white">{copy.fromInvoice}</Badge>
          <div className="font-mono text-muted-foreground">
            {paymentRequest.invoices?.invoice_number || paymentRequest.invoice_id}
          </div>
          {paymentRequest.purchase_orders?.po_number && (
            <div className="font-mono text-muted-foreground">PO: {paymentRequest.purchase_orders.po_number}</div>
          )}
        </div>
      );
    }

    if (source === "purchase_order") {
      return (
        <div className="space-y-1 text-xs">
          <Badge className="bg-amber-600 text-white">{copy.fromPo}</Badge>
          <div className="font-mono text-muted-foreground">
            {paymentRequest.purchase_orders?.po_number || paymentRequest.purchase_order_id}
          </div>
        </div>
      );
    }

    if (source === "ocr_scan") {
      return <Badge className="bg-violet-600 text-white">{copy.ocr}</Badge>;
    }

    if (source === "manual") {
      return <Badge variant="outline">{copy.manual}</Badge>;
    }

    return (
      <div className="space-y-1 text-xs">
        <Badge className="bg-emerald-600 text-white">
          <PackageCheck className="mr-1 h-3 w-3" />
          {copy.fromReceipt}
        </Badge>
        <div className="font-mono text-muted-foreground">
          {paymentRequest.goods_receipts?.receipt_number || paymentRequest.goods_receipt_id}
        </div>
        {paymentRequest.purchase_orders?.po_number && (
          <div className="font-mono text-muted-foreground">PO: {paymentRequest.purchase_orders.po_number}</div>
        )}
      </div>
    );
  };

  const renderPaymentBadge = (paymentRequest: PaymentRequestWithSupplier) => {
    const remaining = getRemainingPaymentAmount(paymentRequest);
    if (paymentRequest.payment_status === "paid" || remaining <= 0) {
      return <Badge className="bg-emerald-600 text-white">{copy.paid}</Badge>;
    }
    if (paymentRequest.payment_status === "partial") {
      return <Badge className="bg-amber-500 text-white">{formatText(copy.remainingAmount, { amount: formatCurrency(remaining) })}</Badge>;
    }
    return <Badge variant="destructive">{copy.unpaid}</Badge>;
  };

  if (isError) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-5 text-sm text-destructive" data-staff-i18n="payables-v1">
        {formatText(copy.loadError, { message: errorMessage(error) || copy.unknownError })}
      </div>
    );
  }

  return (
    <div className="space-y-5 bg-slate-50/40 pb-28 dark:bg-background lg:pb-20" data-staff-i18n="payables-v1">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <h1 className="text-[28px] font-semibold leading-tight tracking-normal text-slate-950 dark:text-slate-50">
            {copy.title}
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {copy.description}
          </p>
        </div>
        <Button
          variant="outline"
          className="h-11 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card"
          onClick={() => refetch()}
        >
          <RefreshCw className={cn("mr-2 h-4 w-4", isLoading && "animate-spin")} />
          {copy.refresh}
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.label} className={cn("rounded-xl shadow-none", card.tone)}>
              <CardContent className="flex items-start gap-3 p-4">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-white/70 dark:bg-black/20">
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium uppercase tracking-wide opacity-75">{card.label}</p>
                  <p className="mt-2 truncate text-xl font-semibold tabular-nums" title={card.value}>{card.value}</p>
                  <p className="mt-1 text-xs opacity-75">{card.helper}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="rounded-xl border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card">
        <CardContent className="space-y-4 p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(250px,1fr)_180px_180px_220px]">
            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={searchTerm}
                onChange={(event) => handleSearchChange(event.target.value)}
                placeholder={copy.search}
                className="h-11 rounded-md border-slate-200 bg-white pl-10 text-sm shadow-none dark:border-slate-800 dark:bg-background"
              />
            </div>

            <Select value={paymentStatusFilter} onValueChange={(value) => handlePaymentStatusFilterChange(value as PayableStatusFilter)}>
              <SelectTrigger className="h-11 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-background">
                <SelectValue placeholder={copy.payment} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{copy.allPayments}</SelectItem>
                <SelectItem value="unpaid">{copy.unpaid}</SelectItem>
                <SelectItem value="partial">{copy.partial}</SelectItem>
                <SelectItem value="paid">{copy.paid}</SelectItem>
                <SelectItem value="overpaid">{copy.overpaid}</SelectItem>
              </SelectContent>
            </Select>

            <Select value={approvalStatusFilter} onValueChange={(value) => handleApprovalStatusFilterChange(value as ApprovalStatusFilter)}>
              <SelectTrigger className="h-11 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-background">
                <SelectValue placeholder={copy.approval} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{copy.allApprovals}</SelectItem>
                <SelectItem value="pending">{copy.pending}</SelectItem>
                <SelectItem value="approved">{copy.approved}</SelectItem>
                <SelectItem value="rejected">{copy.rejected}</SelectItem>
              </SelectContent>
            </Select>

            <Select value={sourceFilter} onValueChange={(value) => handleSourceFilterChange(value as SourceFilter)}>
              <SelectTrigger className="h-11 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-background">
                <SelectValue placeholder={copy.payableSource} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{copy.allSources}</SelectItem>
                <SelectItem value="warehouse_receipt">{copy.fromReceipt}</SelectItem>
                <SelectItem value="invoice">{copy.fromInvoice}</SelectItem>
                <SelectItem value="purchase_order">{copy.fromPo}</SelectItem>
                <SelectItem value="ocr_scan">{copy.ocr}</SelectItem>
                <SelectItem value="manual">{copy.manual}</SelectItem>
              </SelectContent>
            </Select>

          </div>
        </CardContent>
      </Card>

      <Card className="rounded-xl border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/80 dark:bg-slate-900/40">
                  <TableHead className="min-w-[180px]">{copy.code}</TableHead>
                  <TableHead className="min-w-[220px]">{copy.supplier}</TableHead>
                  <TableHead className="min-w-[210px]">{copy.source}</TableHead>
                  <TableHead className="min-w-[140px] text-right">{copy.totalDue}</TableHead>
                  <TableHead className="min-w-[140px] text-right">{copy.remaining}</TableHead>
                  <TableHead className="min-w-[150px]">{copy.status}</TableHead>
                  <TableHead className="min-w-[120px]">{copy.method}</TableHead>
                  <TableHead className="min-w-[160px] text-right">{copy.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, index) => (
                    <TableRow key={index}>
                      <TableCell colSpan={8}><Skeleton className="h-9 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : filteredPayables.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                      {copy.empty}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedPayables.map((paymentRequest) => {
                    const remainingAmount = getRemainingPaymentAmount(paymentRequest);
                    const allocatedAmount = getAllocatedAmount(paymentRequest);
                    const productNames = getProductNames(paymentRequest);

                    return (
                      <TableRow key={paymentRequest.id} className="align-top hover:bg-amber-50/50 dark:hover:bg-amber-950/10">
                        <TableCell>
                          <button
                            type="button"
                            onClick={() => setSelectedRequestId(paymentRequest.id)}
                            className="font-mono text-sm font-semibold text-primary underline-offset-4 hover:underline"
                          >
                            {getRequestCode(paymentRequest)}
                          </button>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {format(new Date(paymentRequest.created_at), "dd/MM/yyyy")}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-foreground">{paymentRequest.suppliers?.name || copy.noSupplier}</div>
                          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{paymentRequest.title}</div>
                          {productNames.length > 0 && (
                            <div className="mt-2 flex max-w-[260px] flex-wrap gap-1">
                              {productNames.slice(0, 2).map((productName) => (
                                <Badge key={productName} variant="outline" className="max-w-[170px] truncate text-xs font-normal">
                                  {productName}
                                </Badge>
                              ))}
                              {productNames.length > 2 && <Badge variant="outline" className="text-xs">+{productNames.length - 2}</Badge>}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>{renderSourceBadge(paymentRequest)}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {formatCurrency(Number(paymentRequest.total_amount) || 0)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <div className="font-semibold text-rose-600 dark:text-rose-300">{formatCurrency(remainingAmount)}</div>
                          {allocatedAmount > 0 && (
                            <div className="text-xs text-muted-foreground">{formatText(copy.allocated, { amount: formatCurrency(allocatedAmount) })}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1.5">
                            {renderPaymentBadge(paymentRequest)}
                            <Badge variant="outline" className="block w-fit text-xs">
                              {getApprovalStatusLabel(copy, paymentRequest.status)}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">{getPaymentMethodLabel(copy, paymentRequest)}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{getPaymentStatusLabel(copy, paymentRequest)}</div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => setSelectedRequestId(paymentRequest.id)}>
                              <Eye className="mr-1 h-4 w-4" />
                              {copy.details}
                            </Button>
                            {canEditPaymentRequests && hasOutstandingPayment(paymentRequest) && paymentRequest.status === "approved" && (
                              <Button size="sm" onClick={() => handleMarkPaid(paymentRequest)} disabled={bulkMarkPaid.isPending}>
                                {copy.markPaid}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
          {!isLoading && filteredPayables.length > 0 && (
            <div className="flex flex-col gap-3 border-t border-slate-200 px-4 py-3 text-sm text-muted-foreground dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between">
              <div>
                {formatText(copy.pageSummary, { start: pageStartIndex + 1, end: pageEndIndex, count: filteredPayables.length })}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  disabled={currentPageSafe <= 1}
                >
                  {copy.previous}
                </Button>
                <span className="min-w-[92px] text-center text-xs font-medium text-foreground">
                  {formatText(copy.page, { page: currentPageSafe, total: totalPages })}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                  disabled={currentPageSafe >= totalPages}
                >
                  {copy.next}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <PaymentRequestDetailsDialog
        requestId={selectedRequestId}
        open={!!selectedRequestId}
        onOpenChange={(open) => {
          if (!open) setSelectedRequestId(null);
        }}
      />
    </div>
  );
};

export default PayablesManagement;
