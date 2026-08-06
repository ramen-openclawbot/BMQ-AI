import { useEffect, useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { vi, enUS } from "date-fns/locale";
import {
  AlertTriangle,
  ArrowDown,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Eye,
  FileText,
  Loader2,
  MessageCircle,
  PackageCheck,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Wallet,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AddPaymentRequestDialog } from "@/components/dialogs/AddPaymentRequestDialog";
import { PaymentRequestDetailsDialog } from "@/components/dialogs/PaymentRequestDetailsDialog";
import { ExportApprovedPDF } from "@/components/payment-requests/ExportApprovedPDF";

import { DriveImportProgressDialog } from "@/components/payment-requests/DriveImportProgressDialog";
import {
  getAllocatedAmount,
  getRemainingPaymentAmount,
  hasOutstandingPayment,
  usePaymentRequests,
  useDeletePaymentRequest,
  useBulkMarkPaid,
  useBulkApprovePaymentRequest,
  type PaymentRequestWithSupplier,
} from "@/hooks/usePaymentRequests";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import { getVietnamDateKey } from "@/lib/vietnam-time";
import { toast } from "sonner";

type CardFilterType = "pending" | "approved" | "rejected" | null;

const getCurrentVietnamDayInputValue = () => getVietnamDateKey();

const normalizeSearch = (value: string | null | undefined) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .trim();

const getProductNames = (request: PaymentRequestWithSupplier) => {
  const uniqueNames = new Set<string>();

  request.payment_request_items?.forEach((item) => {
    const productName = item.product_name?.trim() || item.raw_product_name?.trim();
    if (productName) uniqueNames.add(productName);
  });

  return Array.from(uniqueNames);
};

const isWarehouseReceiptPayable = (request: PaymentRequestWithSupplier) => Boolean(request.goods_receipt_id);

type PaymentRequestsProps = {
  defaultSourceFilter?: "all" | "warehouse_receipt" | "manual";
};

const PaymentRequests = ({ defaultSourceFilter = "all" }: PaymentRequestsProps) => {
  const queryClient = useQueryClient();
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [deletingRequestId, setDeletingRequestId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>(defaultSourceFilter);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeCardFilter, setActiveCardFilter] = useState<CardFilterType>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkApproveConfirm, setShowBulkApproveConfirm] = useState(false);
  const [showDriveInvoiceDialog, setShowDriveInvoiceDialog] = useState(false);
  const [pageSize, setPageSize] = useState("10");
  const [currentPage, setCurrentPage] = useState(1);
  const [dateFrom, setDateFrom] = useState(getCurrentVietnamDayInputValue);
  const [dateTo, setDateTo] = useState(getCurrentVietnamDayInputValue);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  
  const { canEditModule } = useAuth();
  const { language, t } = useLanguage();
  const canEditPaymentRequests = canEditModule("payment_requests");

  const {
    data: requests,
    isLoading,
    isError,
    error,
    refetch,
  } = usePaymentRequests();
  const deleteRequest = useDeletePaymentRequest();
  const bulkMarkPaid = useBulkMarkPaid();
  const bulkApprove = useBulkApprovePaymentRequest();

  const dateLocale = language === "vi" ? vi : enUS;



  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      maximumFractionDigits: 0,
    }).format(amount) + " đ";
  };

  const compactCurrency = (amount: number) => formatCurrency(amount);

  const getRequestCode = (request: PaymentRequestWithSupplier) =>
    request.request_number || request.title || `DC-${request.id.slice(0, 8).toUpperCase()}`;

  const getCreatorName = (request: PaymentRequestWithSupplier) => {
    const profile = request.creator_profile;
    return profile?.full_name?.trim() || profile?.email?.trim() || (request.created_by ? `User ${request.created_by.slice(0, 8)}` : "-");
  };

  const dateRangeLabel = useMemo(() => {
    const fromLabel = dateFrom ? format(new Date(`${dateFrom}T00:00:00`), "dd/MM/yyyy") : "--/--/----";
    const toLabel = dateTo ? format(new Date(`${dateTo}T00:00:00`), "dd/MM/yyyy") : "--/--/----";
    return `${fromLabel} - ${toLabel}`;
  }, [dateFrom, dateTo]);

  const mobileDateRangeLabel = useMemo(() => {
    const fromLabel = dateFrom ? format(new Date(`${dateFrom}T00:00:00`), "dd/MM") : "--/--";
    const toLabel = dateTo ? format(new Date(`${dateTo}T00:00:00`), "dd/MM") : "--/--";
    return dateFrom === dateTo ? fromLabel : `${fromLabel}–${toLabel}`;
  }, [dateFrom, dateTo]);

  const dateFilteredRequests = useMemo(() => {
    return (requests || []).filter((request) => {
      const requestDate = getVietnamDateKey(new Date(request.created_at));
      if (dateFrom && requestDate < dateFrom) return false;
      if (dateTo && requestDate > dateTo) return false;
      return true;
    });
  }, [requests, dateFrom, dateTo]);

  const stats = useMemo(() => {
    const source = dateFilteredRequests;
    const totalAmount = source.reduce((sum, request) => sum + (Number(request.total_amount) || 0), 0);
    const approved = source.filter((request) => request.status === "approved");
    const pending = source.filter((request) => request.status === "pending");
    const rejected = source.filter((request) => request.status === "rejected");

    return {
      total: {
        amount: totalAmount,
        count: source.length,
      },
      approved: {
        amount: approved.reduce((sum, request) => sum + (Number(request.total_amount) || 0), 0),
        count: approved.length,
      },
      pending: {
        amount: pending.reduce((sum, request) => sum + (Number(request.total_amount) || 0), 0),
        count: pending.length,
      },
      rejected: {
        amount: rejected.reduce((sum, request) => sum + (Number(request.total_amount) || 0), 0),
        count: rejected.length,
      },
      warehouseGenerated: {
        amount: source
          .filter((request) => isWarehouseReceiptPayable(request))
          .reduce((sum, request) => sum + (Number(request.total_amount) || 0), 0),
        count: source.filter((request) => isWarehouseReceiptPayable(request)).length,
      },
    };
  }, [dateFilteredRequests]);

  const statCards = [
    {
      key: null,
      label: language === "vi" ? "Tổng đề nghị" : "Total requests",
      amount: stats.total.amount,
      count: stats.total.count,
      icon: FileText,
      tone: "blue",
    },
    {
      key: "approved" as const,
      label: language === "vi" ? "Đã duyệt" : "Approved",
      amount: stats.approved.amount,
      count: stats.approved.count,
      icon: CheckCircle2,
      tone: "green",
    },
    {
      key: "pending" as const,
      label: language === "vi" ? "Chờ duyệt" : "Pending",
      amount: stats.pending.amount,
      count: stats.pending.count,
      icon: Clock3,
      tone: "amber",
    },
    {
      key: "rejected" as const,
      label: language === "vi" ? "Từ chối" : "Rejected",
      amount: stats.rejected.amount,
      count: stats.rejected.count,
      icon: XCircle,
      tone: "red",
    },
    {
      key: null,
      label: language === "vi" ? "Công nợ tạo từ nhập kho" : "Warehouse-generated payables",
      amount: stats.warehouseGenerated.amount,
      count: stats.warehouseGenerated.count,
      icon: PackageCheck,
      tone: "blue",
      onClick: () => setSourceFilter(sourceFilter === "warehouse_receipt" ? "all" : "warehouse_receipt"),
      isActive: sourceFilter === "warehouse_receipt",
    },
  ];

  const getStatToneClass = (tone: string) => {
    switch (tone) {
      case "green":
        return "bg-muted text-foreground";
      case "amber":
        return "bg-muted text-muted-foreground";
      case "red":
        return "bg-destructive/10 text-destructive dark:bg-destructive/15";
      default:
        return "bg-primary/10 text-primary dark:bg-primary/15";
    }
  };

  const renderProductNames = (request: PaymentRequestWithSupplier) => {
    const productNames = getProductNames(request);

    if (productNames.length === 0) {
      return <span className="text-muted-foreground">-</span>;
    }

    const visibleNames = productNames.slice(0, 2);
    const remainingCount = productNames.length - visibleNames.length;

    return (
      <div className="flex max-w-[300px] flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleNames.map((name) => (
            <Badge key={name} variant="outline" className="max-w-[170px] justify-start truncate rounded px-2 py-0.5 text-xs font-normal text-foreground">
              <span className="truncate">{name}</span>
            </Badge>
          ))}
        </div>
        {remainingCount > 0 && (
          <span className="text-xs text-slate-600 dark:text-slate-400">+{remainingCount} sản phẩm khác</span>
        )}
      </div>
    );
  };

  const handleDelete = async () => {
    if (!deletingRequestId) return;
    if (!canEditPaymentRequests) {
      toast.error(language === "vi" ? "Anh không có quyền xoá duyệt chi" : "No permission to delete payment requests");
      return;
    }

    try {
      const result = await deleteRequest.mutateAsync(deletingRequestId);
      setDeletingRequestId(null);
      toast.success(
        result.unlinked_invoice_count > 0
          ? language === "vi"
            ? "Đã xoá duyệt chi và giữ lại hóa đơn đã tạo"
            : "Payment request deleted; linked invoice was kept"
          : language === "vi"
            ? "Đã xoá duyệt chi"
            : "Payment request deleted"
      );
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : String(deleteError || "");
      toast.error(language === "vi" ? "Không xoá được duyệt chi" : "Failed to delete payment request", {
        description: message || (language === "vi" ? "Vui lòng thử lại." : "Please try again."),
      });
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return (
          <Badge variant="secondary" className="gap-1 rounded-md px-2.5 py-1 text-xs font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
            {t.pending}
          </Badge>
        );
      case "approved":
        return (
          <Badge variant="outline" className="gap-1 rounded-md bg-card px-2.5 py-1 text-xs font-medium text-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            {t.approved}
          </Badge>
        );
      case "rejected":
        return (
          <Badge variant="outline" className="gap-1 rounded-md bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">
            <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
            {t.rejected}
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getSourceLabel = (request: PaymentRequestWithSupplier) => {
    if (request.goods_receipts?.receipt_number) return `PN ${request.goods_receipts.receipt_number}`;
    if (request.purchase_orders?.po_number) return `PO ${request.purchase_orders.po_number}`;
    if (isWarehouseReceiptPayable(request)) return language === "vi" ? "Từ phiếu nhập" : "Warehouse receipt";
    return language === "vi" ? "Tạo thủ công" : "Manual";
  };

  const getAccountingCue = (request: PaymentRequestWithSupplier) => {
    const remainingAmount = getRemainingPaymentAmount(request);

    if (request.status === "rejected") {
      return {
        label: language === "vi" ? "Đã từ chối" : "Rejected",
        className: "border-destructive/20 bg-destructive/10 text-destructive",
        icon: XCircle,
      };
    }

    if (request.purchase_orders?.po_number && !isWarehouseReceiptPayable(request)) {
      return {
        label: language === "vi" ? "Cần đối soát PO" : "Needs PO match",
        className: "border-warning/25 bg-warning/10 text-warning-foreground",
        icon: AlertTriangle,
      };
    }

    if (request.status === "approved" && remainingAmount > 0) {
      return {
        label: language === "vi" ? "Chờ thanh toán" : "Awaiting payment",
        className: "border-primary/20 bg-primary/10 text-primary",
        icon: Wallet,
      };
    }

    if (isWarehouseReceiptPayable(request)) {
      return {
        label: language === "vi" ? "Có phiếu nhập" : "Receipt linked",
        className: "border-success/25 bg-success/10 text-success",
        icon: PackageCheck,
      };
    }

    return {
      label: language === "vi" ? "Cần kiểm tra chứng từ" : "Check documents",
      className: "border-border bg-muted text-muted-foreground",
      icon: ReceiptText,
    };
  };

  const openQuickApproveConfirm = (requestId: string) => {
    setSelectedIds(new Set([requestId]));
    setShowBulkApproveConfirm(true);
  };

  // Filter requests based on dropdown and card filters
  const filteredRequests = useMemo(() => {
    const normalizedSearchTerm = normalizeSearch(searchTerm);

    return dateFilteredRequests.filter((r) => {
      // Dropdown filters
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (sourceFilter === "warehouse_receipt" && !isWarehouseReceiptPayable(r)) return false;
      if (sourceFilter === "manual" && isWarehouseReceiptPayable(r)) return false;

      if (normalizedSearchTerm) {
        const supplierName = normalizeSearch(r.suppliers?.name);
        const requestCode = normalizeSearch(getRequestCode(r));
        const productNames = normalizeSearch(getProductNames(r).join(" "));
        const receiptNumber = normalizeSearch(r.goods_receipts?.receipt_number);
        const poNumber = normalizeSearch(r.purchase_orders?.po_number);

        if (
          !supplierName.includes(normalizedSearchTerm) &&
          !productNames.includes(normalizedSearchTerm) &&
          !requestCode.includes(normalizedSearchTerm) &&
          !receiptNumber.includes(normalizedSearchTerm) &&
          !poNumber.includes(normalizedSearchTerm)
        ) {
          return false;
        }
      }
      
      // Card filter
      if (activeCardFilter) {
        switch (activeCardFilter) {
          case "pending":
            return r.status === "pending";
          case "approved":
            return r.status === "approved";
          case "rejected":
            return r.status === "rejected";
        }
      }
      
      return true;
    });
  }, [dateFilteredRequests, statusFilter, sourceFilter, searchTerm, activeCardFilter]);

  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, sourceFilter, searchTerm, activeCardFilter, pageSize, dateFrom, dateTo]);

  // Get selectable requests (pending OR approved with remaining amount)
  const selectableRequests = useMemo(() => {
    return filteredRequests?.filter(r => 
      r.status === "pending" || (r.status === "approved" && hasOutstandingPayment(r))
    ) || [];
  }, [filteredRequests]);

  // Calculate selected pending requests for bulk approve
  const selectedPendingIds = useMemo(() => {
    return Array.from(selectedIds).filter(id => {
      const request = requests?.find(r => r.id === id);
      return request?.status === "pending";
    });
  }, [selectedIds, requests]);

  const selectedPendingTotal = useMemo(() => {
    return selectedPendingIds.reduce((sum, id) => {
      const request = requests?.find(r => r.id === id);
      return sum + (request?.total_amount || 0);
    }, 0);
  }, [selectedPendingIds, requests]);

  // Calculate selected approved requests with remaining amount for bulk mark paid
  const selectedApprovedUnpaidIds = useMemo(() => {
    return Array.from(selectedIds).filter(id => {
      const request = requests?.find(r => r.id === id);
      return !!request && request.status === "approved" && hasOutstandingPayment(request);
    });
  }, [selectedIds, requests]);

  const totalResults = filteredRequests?.length || 0;
  const numericPageSize = Number(pageSize);
  const totalPages = Math.max(1, Math.ceil(totalResults / numericPageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const paginatedRequests = useMemo(() => {
    const start = (safeCurrentPage - 1) * numericPageSize;
    return filteredRequests?.slice(start, start + numericPageSize) || [];
  }, [filteredRequests, numericPageSize, safeCurrentPage]);

  const firstResult = totalResults === 0 ? 0 : (safeCurrentPage - 1) * numericPageSize + 1;
  const lastResult = Math.min(safeCurrentPage * numericPageSize, totalResults);

  const handleBulkApprove = () => {
    bulkApprove.mutate(selectedPendingIds, {
      onSuccess: () => {
        setSelectedIds(new Set());
        setShowBulkApproveConfirm(false);
      },
    });
  };

  return (
    /* Hallmark · genre: modern-minimal · tone: technical · anchor: BMQ blue · macrostructure: Workbench · mobile-first approval queue */
    /* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V5 */
    <div
      data-stitch-payment-requests-mobile="hallmark-workbench"
      className="min-w-0 space-y-4 overflow-x-clip bg-background pb-8 font-sans text-foreground lg:space-y-5 lg:pb-20"
    >
      <div className="lg:static">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="min-w-0 [overflow-wrap:anywhere] text-2xl font-semibold leading-tight tracking-tight text-foreground lg:text-[28px]">
              {t.paymentRequestsTitle}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground lg:hidden">
              {language === "vi" ? "Theo dõi và xử lý đề nghị chi" : "Review and process payment requests"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 lg:hidden">
            <Button
              variant="outline"
              size="icon"
              className="h-11 w-11 rounded-md border-border bg-card shadow-none"
              onClick={() => window.dispatchEvent(new Event("bmq:open-agent-chat"))}
              title={language === "vi" ? "Mở trợ lý AI" : "Open AI assistant"}
            >
              <MessageCircle className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-11 w-11 rounded-md border-border bg-card shadow-none"
              onClick={() => refetch()}
              title={language === "vi" ? "Làm mới" : "Refresh"}
            >
              <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4 lg:space-y-5">
        <div className="hidden flex-col gap-3 lg:flex xl:flex-row xl:items-center">
          <div className="flex min-h-12 items-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-800 shadow-none dark:border-slate-800 dark:bg-card dark:text-slate-100 xl:w-[340px]">
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <CalendarDays className="h-4 w-4 text-slate-500" />
              <span className="sr-only">{dateRangeLabel}</span>
              <Input
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(event) => setDateFrom(event.target.value)}
                aria-label={language === "vi" ? "Từ ngày" : "From date"}
                className="h-10 min-w-0 border-0 bg-transparent p-0 text-sm font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
              />
              <span className="text-slate-400">-</span>
              <Input
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(event) => setDateTo(event.target.value)}
                aria-label={language === "vi" ? "Đến ngày" : "To date"}
                className="h-10 min-w-0 border-0 bg-transparent p-0 text-sm font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
              />
            </span>
          </div>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-12 rounded-md border-slate-200 bg-white px-4 text-slate-800 shadow-none dark:border-slate-800 dark:bg-card dark:text-slate-100 xl:w-[260px]">
              <SelectValue placeholder={t.status} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{language === "vi" ? "Tất cả trạng thái" : "All statuses"}</SelectItem>
              <SelectItem value="pending">{t.pending}</SelectItem>
              <SelectItem value="approved">{t.approved}</SelectItem>
              <SelectItem value="rejected">{t.rejected}</SelectItem>
            </SelectContent>
          </Select>

          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="h-12 rounded-md border-slate-200 bg-white px-4 text-slate-800 shadow-none dark:border-slate-800 dark:bg-card dark:text-slate-100 xl:w-[280px]">
              <SelectValue placeholder={language === "vi" ? "Nguồn công nợ" : "Payable source"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{language === "vi" ? "Tất cả nguồn" : "All sources"}</SelectItem>
              <SelectItem value="warehouse_receipt">{language === "vi" ? "Công nợ tạo từ nhập kho" : "Generated from warehouse receipt"}</SelectItem>
              <SelectItem value="manual">{language === "vi" ? "Tạo thủ công / nguồn khác" : "Manual / other source"}</SelectItem>
            </SelectContent>
          </Select>

          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={language === "vi" ? "Tìm theo mã phiếu, tên sản phẩm hoặc nhà cung cấp" : "Search by code, product, or supplier"}
              className="h-12 rounded-md border-slate-200 bg-white pl-12 text-sm shadow-none placeholder:text-slate-400 dark:border-slate-800 dark:bg-card"
            />
          </div>

          <AddPaymentRequestDialog
            trigger={
              <Button className="h-12 rounded-md px-6 text-sm font-medium shadow-sm">
                <Plus className="h-5 w-5" />
                {language === "vi" ? "Tạo duyệt chi" : "Create request"}
              </Button>
            }
          />

          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card"
            onClick={() => setShowDriveInvoiceDialog(true)}
            title={language === "vi" ? "Nhập từ Google Drive" : "Import from Google Drive"}
          >
            <Upload className="h-5 w-5" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card"
            onClick={() => refetch()}
            title={language === "vi" ? "Làm mới" : "Refresh"}
          >
            <RefreshCw className={cn("h-5 w-5", isLoading && "animate-spin")} />
          </Button>
        </div>

        <div data-stitch-section="mobile-summary-filters" className="space-y-3 lg:hidden">
          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3 border-b border-border pb-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-muted-foreground">{language === "vi" ? "Đang chờ duyệt" : "Awaiting approval"}</p>
                <p className="mt-1 text-[28px] font-bold leading-none tabular-nums text-primary">{formatCurrency(stats.pending.amount)}</p>
              </div>
              <span className="shrink-0 rounded-md bg-primary/10 px-2.5 py-1 text-sm font-semibold tabular-nums text-primary">
                {stats.pending.count} {language === "vi" ? "phiếu" : "requests"}
              </span>
            </div>
            <dl className="grid min-w-0 grid-cols-2 gap-4 pt-4">
              <div className="min-w-0">
                <dt className="text-xs font-medium text-muted-foreground">{language === "vi" ? "Đã duyệt" : "Approved"}</dt>
                <dd className="mt-1 truncate text-sm font-semibold tabular-nums text-foreground">{formatCurrency(stats.approved.amount)}</dd>
                <dd className="mt-0.5 text-xs text-muted-foreground">{stats.approved.count} {language === "vi" ? "phiếu" : "requests"}</dd>
              </div>
              <div className="min-w-0 border-l border-border pl-4">
                <dt className="text-xs font-medium text-muted-foreground">{language === "vi" ? "Từ chối" : "Rejected"}</dt>
                <dd className="mt-1 truncate text-sm font-semibold tabular-nums text-destructive">{formatCurrency(stats.rejected.amount)}</dd>
                <dd className="mt-0.5 text-xs text-muted-foreground">{stats.rejected.count} {language === "vi" ? "phiếu" : "requests"}</dd>
              </div>
            </dl>
          </section>

          <section className="space-y-3 rounded-lg border border-border bg-card p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder={language === "vi" ? "Tìm mã phiếu, NCC..." : "Search code, supplier..."}
                className="h-11 rounded-md border-border bg-background pl-11 text-sm shadow-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: "all", label: language === "vi" ? "Tất cả" : "All" },
                { value: "pending", label: t.pending },
                { value: "approved", label: t.approved },
                { value: "rejected", label: t.rejected },
              ].map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => setStatusFilter(filter.value)}
                  className={cn(
                    "h-11 whitespace-nowrap rounded-md border px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    statusFilter === filter.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground"
                  )}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-expanded={mobileFiltersOpen}
              onClick={() => setMobileFiltersOpen((open) => !open)}
              className="flex h-11 w-full items-center justify-between gap-3 whitespace-nowrap rounded-md border border-border bg-background px-3 text-sm font-semibold text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <CalendarDays className="h-4 w-4 shrink-0" />
                <span>{language === "vi" ? "Bộ lọc ngày & nguồn" : "Date & source filters"}</span>
              </span>
              <span className="shrink-0 text-xs font-normal tabular-nums">{mobileDateRangeLabel}</span>
            </button>

            {mobileFiltersOpen ? (
              <div className="space-y-3 border-t border-border pt-3">
                <div data-bmq-payment-requests-default-vn-day="true" className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="min-w-0 space-y-1.5 text-xs font-medium text-muted-foreground">
                    {language === "vi" ? "Từ ngày" : "From"}
                    <span className="relative flex h-11 min-w-0 max-w-full items-center overflow-hidden rounded-md border border-border bg-background px-3 text-sm tabular-nums text-foreground focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                      {dateFrom ? format(new Date(`${dateFrom}T00:00:00`), "dd/MM/yyyy") : "--/--/----"}
                      <input
                        type="date"
                        lang={language}
                        value={dateFrom}
                        max={dateTo || undefined}
                        onChange={(event) => setDateFrom(event.target.value)}
                        aria-label={language === "vi" ? "Từ ngày" : "From date"}
                        className="absolute inset-0 h-full w-full min-w-0 max-w-full cursor-pointer opacity-0"
                      />
                    </span>
                  </label>
                  <label className="min-w-0 space-y-1.5 text-xs font-medium text-muted-foreground">
                    {language === "vi" ? "Đến ngày" : "To"}
                    <span className="relative flex h-11 min-w-0 max-w-full items-center overflow-hidden rounded-md border border-border bg-background px-3 text-sm tabular-nums text-foreground focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                      {dateTo ? format(new Date(`${dateTo}T00:00:00`), "dd/MM/yyyy") : "--/--/----"}
                      <input
                        type="date"
                        lang={language}
                        value={dateTo}
                        min={dateFrom || undefined}
                        onChange={(event) => setDateTo(event.target.value)}
                        aria-label={language === "vi" ? "Đến ngày" : "To date"}
                        className="absolute inset-0 h-full w-full min-w-0 max-w-full cursor-pointer opacity-0"
                      />
                    </span>
                  </label>
                </div>
                <button type="button" onClick={() => setSourceFilter(sourceFilter === "warehouse_receipt" ? "all" : "warehouse_receipt")} className={cn("flex h-11 w-full items-center justify-between whitespace-nowrap rounded-md border px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2", sourceFilter === "warehouse_receipt" ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground")}>
                  <span>{language === "vi" ? "Chỉ phiếu từ nhập kho" : "Warehouse receipts only"}</span>
                  <PackageCheck className="h-4 w-4" />
                </button>
              </div>
            ) : null}
          </section>
          <div className="grid grid-cols-[minmax(0,1fr)_44px] gap-2">
            <AddPaymentRequestDialog trigger={<Button className="h-11 w-full whitespace-nowrap rounded-md font-semibold shadow-none"><Plus className="mr-2 h-4 w-4" />{language === "vi" ? "Tạo duyệt chi" : "Create request"}</Button>} />
            <Button variant="outline" size="icon" className="h-11 w-11 rounded-md border-border bg-card shadow-none" onClick={() => setShowDriveInvoiceDialog(true)} title={language === "vi" ? "Nhập từ Google Drive" : "Import from Google Drive"}><Upload className="h-4 w-4" /></Button>
          </div>
        </div>

        <div className="hidden gap-5 md:grid-cols-2 lg:grid 2xl:grid-cols-4">
          {statCards.map((card) => {
            const Icon = card.icon;
            const isActive = card.isActive ?? (card.key === null ? activeCardFilter === null && sourceFilter === "all" : activeCardFilter === card.key);

            return (
              <Card
                key={card.label}
                className={cn(
                  "cursor-pointer rounded-md border-slate-200 bg-white shadow-none transition-colors hover:border-primary/40 dark:border-slate-800 dark:bg-card dark:hover:border-primary/40",
                  isActive && "border-primary/60 ring-1 ring-primary/15"
                )}
                onClick={() => {
                  if (card.onClick) {
                    card.onClick();
                    return;
                  }
                  setActiveCardFilter(card.key === activeCardFilter ? null : card.key);
                }}
              >
                <CardContent className="flex items-center gap-5 p-6">
                  <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-md", getStatToneClass(card.tone))}>
                    <Icon className="h-7 w-7" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{card.label}</div>
                    <div className="mt-1 text-xl font-semibold leading-tight text-slate-950 dark:text-slate-50">
                      {compactCurrency(card.amount)}
                    </div>
                    <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      {card.count} {language === "vi" ? "phiếu" : "requests"}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div data-stitch-section="mobile-selected-actions-inline" className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 lg:flex-row lg:items-center lg:justify-between lg:rounded-md lg:bg-muted/40 lg:p-4">
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-medium">
              {t.selected}: {selectedIds.size}
            </span>
            <span className="text-muted-foreground">|</span>
            <span className="font-medium">
              {t.total}: {formatCurrency(
                Array.from(selectedIds).reduce((sum, id) => {
                  const request = requests?.find(r => r.id === id);
                  return sum + (request?.total_amount || 0);
                }, 0)
              )}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Quick Approve button - only show when pending requests are selected */}
            {selectedPendingIds.length > 0 && (
              <Button 
                onClick={() => setShowBulkApproveConfirm(true)}
                disabled={bulkApprove.isPending}
                className="gap-2"
              >
                <CheckCircle2 className="h-4 w-4" />
                {t.quickApprove} ({selectedPendingIds.length})
              </Button>
            )}
            {/* Export PDF button - show when approved requests are selected */}
            {requests && (
              <ExportApprovedPDF 
                selectedIds={Array.from(selectedIds)} 
                requests={requests} 
              />
            )}
            {/* Mark as Paid button - only show when approved+unpaid requests are selected */}
            {selectedApprovedUnpaidIds.length > 0 && (
              <Button 
                onClick={() => {
                  bulkMarkPaid.mutate(selectedApprovedUnpaidIds);
                  setSelectedIds(new Set());
                }}
                disabled={bulkMarkPaid.isPending}
                className="gap-2"
              >
                <Wallet className="h-4 w-4" />
                {t.markAsPaid} ({selectedApprovedUnpaidIds.length})
              </Button>
            )}
            <Button 
              variant="ghost" 
              size="icon"
              onClick={() => setSelectedIds(new Set())}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Requests Mobile Cards */}
      <div data-stitch-section="mobile-approval-cards" className="space-y-3 lg:hidden">
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-56 rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          <Card className="rounded-lg border-destructive/20 bg-destructive/5 shadow-none">
            <CardContent className="space-y-3 p-4">
              <p className="font-semibold text-destructive">{language === "vi" ? "Không thể tải dữ liệu" : "Couldn't load data"}</p>
              <p className="break-words text-sm text-muted-foreground">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
              <Button variant="outline" className="h-11 w-full rounded-md" onClick={() => refetch()}>
                {language === "vi" ? "Thử lại" : "Retry"}
              </Button>
            </CardContent>
          </Card>
        ) : filteredRequests?.length === 0 ? (
          <Card className="rounded-lg border-border bg-card shadow-none">
            <CardContent className="p-8 text-center">
              <FileText className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t.noPaymentRequests}</p>
            </CardContent>
          </Card>
        ) : (
          <>
            {paginatedRequests.map((request) => {
            const cue = getAccountingCue(request);
            const CueIcon = cue.icon;
            const isSelectable = request.status === "pending" || (request.status === "approved" && hasOutstandingPayment(request));
            const isSelected = selectedIds.has(request.id);
            const productNames = getProductNames(request);
            const remainingAmount = getRemainingPaymentAmount(request);
            const allocatedAmount = getAllocatedAmount(request);

            return (
              <Card
                key={request.id}
                data-stitch-card="mobile-payment-request"
                className={cn(
                  "overflow-hidden rounded-lg border-border bg-card shadow-none transition-colors",
                  isSelected && "border-primary ring-1 ring-primary/20"
                )}
              >
                <CardContent className="space-y-4 p-4">
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate rounded-md bg-muted px-2 py-1 font-mono text-[11px] font-semibold text-foreground">{getRequestCode(request)}</span>
                      {getStatusBadge(request.status)}
                    </div>
                    {isSelectable ? (
                      <button type="button" aria-label={isSelected ? (language === "vi" ? "Bỏ chọn phiếu" : "Unselect request") : (language === "vi" ? "Chọn phiếu" : "Select request")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => { const next = new Set(selectedIds); if (next.has(request.id)) next.delete(request.id); else next.add(request.id); setSelectedIds(next); }}>
                        {isSelected ? <CheckCircle2 aria-hidden="true" className="h-5 w-5 text-primary" /> : <span aria-hidden="true" className="h-4 w-4 rounded border border-input bg-background" />}
                      </button>
                    ) : null}
                  </div>

                  <div className="min-w-0">
                    <button type="button" className="block min-h-11 w-full min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => setSelectedRequestId(request.id)}>
                      <span className="line-clamp-1 text-base font-semibold text-foreground">{request.suppliers?.name || (language === "vi" ? "Chưa có nhà cung cấp" : "No supplier")}</span>
                      <span className="mt-1 block line-clamp-1 text-sm text-muted-foreground">{request.title || productNames[0] || (language === "vi" ? "Đề nghị thanh toán" : "Payment request")}</span>
                    </button>
                    <p className="mt-3 text-2xl font-bold leading-none tabular-nums text-primary">{formatCurrency(request.total_amount || 0)}</p>
                    {remainingAmount > 0 && allocatedAmount > 0 ? <p className="mt-1 text-xs font-medium tabular-nums text-muted-foreground">{language === "vi" ? "Còn phải chi" : "Remaining"}: {formatCurrency(remainingAmount)}</p> : null}
                  </div>

                  <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 border-y border-border py-3 text-xs">
                    <dt className="text-muted-foreground">{language === "vi" ? "Ngày tạo" : "Created"}</dt><dd className="truncate text-right font-medium tabular-nums text-foreground">{format(new Date(request.created_at), "dd/MM/yyyy", { locale: dateLocale })}</dd>
                    <dt className="text-muted-foreground">{language === "vi" ? "Người tạo" : "Created by"}</dt><dd className="truncate text-right font-medium text-foreground">{getCreatorName(request)}</dd>
                    <dt className="text-muted-foreground">{language === "vi" ? "Nguồn" : "Source"}</dt><dd className="truncate text-right font-medium text-foreground">{getSourceLabel(request)}</dd>
                  </dl>

                  <div className={cn("flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold", cue.className)}>
                    <CueIcon className="h-4 w-4 shrink-0" /><span className="min-w-0 truncate">{cue.label}</span><span className="ml-auto shrink-0 font-normal text-muted-foreground">{request.image_url ? (language === "vi" ? "Có ảnh" : "Image") : (language === "vi" ? "Kiểm tra chứng từ" : "Check documents")}</span>
                  </div>

                  {productNames.length > 0 ? <div className="flex min-w-0 flex-wrap gap-1.5">
                    {productNames.slice(0, 2).map((name) => <Badge key={name} variant="outline" className="max-w-full truncate rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground">{name}</Badge>)}
                    {productNames.length > 2 ? <Badge variant="secondary" className="rounded-md px-2 py-1 text-[11px] font-medium">+{productNames.length - 2}</Badge> : null}
                  </div> : null}

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      className="h-11 whitespace-nowrap rounded-md border-border bg-card font-semibold shadow-none"
                      onClick={() => setSelectedRequestId(request.id)}
                    >
                      <Eye className="mr-2 h-4 w-4" />
                      {language === "vi" ? "Chi tiết" : "Details"}
                    </Button>
                    {request.status === "pending" && canEditPaymentRequests ? (
                      <Button
                        className="h-11 whitespace-nowrap rounded-md font-semibold shadow-none"
                        disabled={bulkApprove.isPending}
                        onClick={() => openQuickApproveConfirm(request.id)}
                      >
                        <CheckCircle2 className="mr-2 h-4 w-4" />
                        {language === "vi" ? "Duyệt" : "Approve"}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        className="h-11 whitespace-nowrap rounded-md border-border bg-card font-semibold shadow-none"
                        onClick={() => {
                          const next = new Set(selectedIds);
                          if (isSelectable) {
                            if (next.has(request.id)) next.delete(request.id);
                            else next.add(request.id);
                            setSelectedIds(next);
                          }
                        }}
                        disabled={!isSelectable}
                      >
                        {isSelected ? (language === "vi" ? "Bỏ chọn" : "Unselect") : (language === "vi" ? "Chọn" : "Select")}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}

            <div data-stitch-section="mobile-pagination" className="rounded-lg border border-border bg-card p-3">
              <div className="mb-3 flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-muted-foreground">
                  {language === "vi"
                    ? `${firstResult} - ${lastResult} / ${totalResults} phiếu`
                    : `${firstResult} - ${lastResult} / ${totalResults} requests`}
                </span>
                <span className="rounded-md bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">
                  {language === "vi" ? `Trang ${safeCurrentPage}/${totalPages}` : `Page ${safeCurrentPage}/${totalPages}`}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="h-11 whitespace-nowrap rounded-md border-border bg-background font-semibold shadow-none"
                  disabled={safeCurrentPage <= 1}
                  onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                >
                  <ChevronLeft className="mr-2 h-4 w-4" />
                  {language === "vi" ? "Trước" : "Previous"}
                </Button>
                <Button
                  variant="outline"
                  className="h-11 whitespace-nowrap rounded-md border-border bg-background font-semibold shadow-none"
                  disabled={safeCurrentPage >= totalPages}
                  onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                >
                  {language === "vi" ? "Tiếp" : "Next"}
                  <ChevronRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Requests Table */}
      <Card className="hidden overflow-hidden rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card lg:block">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-4">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="p-6 space-y-3">
              <p className="font-medium text-foreground">
                {language === "vi" ? "Không thể tải dữ liệu" : "Couldn't load data"}
              </p>
              <p className="text-sm text-muted-foreground break-words">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button variant="outline" onClick={() => refetch()}>
                  {language === "vi" ? "Thử lại" : "Retry"}
                </Button>
                <Button variant="outline" onClick={() => window.location.reload()}>
                  {language === "vi" ? "Tải lại trang" : "Reload Page"}
                </Button>
              </div>
            </div>
          ) : filteredRequests?.length === 0 ? (
            <div className="p-12 text-center">
              <FileText className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-muted-foreground">{t.noPaymentRequests}</p>
            </div>
          ) : (
            <>
            <Table>
              <TableHeader className="bg-slate-50 dark:bg-slate-900/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-12 px-4">
                    <Checkbox
                      checked={selectableRequests.length > 0 && selectableRequests.every(r => selectedIds.has(r.id))}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedIds(new Set(selectableRequests.map(r => r.id)));
                        } else {
                          setSelectedIds(new Set());
                        }
                      }}
                    />
                  </TableHead>
                  <TableHead className="min-w-[130px] text-slate-700 dark:text-slate-300">Mã phiếu</TableHead>
                  <TableHead className="min-w-[130px] text-slate-700 dark:text-slate-300">
                    <span className="inline-flex items-center gap-1">
                      Ngày <ArrowDown className="h-3.5 w-3.5" />
                    </span>
                  </TableHead>
                  <TableHead className="min-w-[220px] text-slate-700 dark:text-slate-300">{t.supplier}</TableHead>
                  <TableHead className="min-w-[300px] text-slate-700 dark:text-slate-300">
                    {language === "vi" ? "Tên sản phẩm duyệt chi" : "Payment request products"}
                  </TableHead>
                  <TableHead className="min-w-[150px] text-right text-slate-700 dark:text-slate-300">Số tiền</TableHead>
                  <TableHead className="min-w-[140px] text-center text-slate-700 dark:text-slate-300">{t.status}</TableHead>
                  <TableHead className="min-w-[160px] text-slate-700 dark:text-slate-300">Người tạo</TableHead>
                  <TableHead className="w-16 text-center text-slate-700 dark:text-slate-300">{t.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedRequests.map((request) => {
                  const allocatedAmount = getAllocatedAmount(request);
                  const remainingAmount = getRemainingPaymentAmount(request);
                  const isSelectable = request.status === "pending" || (request.status === "approved" && hasOutstandingPayment(request));
                  const isSelected = selectedIds.has(request.id);
                  
                  return (
                    <TableRow
                      key={request.id}
                      className={cn(
                        "h-[72px] cursor-pointer transition-colors hover:bg-muted/40",
                        isSelected && "bg-muted/60"
                      )}
                      tabIndex={0}
                      role="button"
                      onClick={() => setSelectedRequestId(request.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedRequestId(request.id);
                        }
                      }}
                    >
                      <TableCell
                        className="px-4"
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        {isSelectable ? (
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={(checked) => {
                              const newSet = new Set(selectedIds);
                              if (checked) {
                                newSet.add(request.id);
                              } else {
                                newSet.delete(request.id);
                              }
                              setSelectedIds(newSet);
                            }}
                          />
                        ) : (
                          <div className="w-4" />
                        )}
                      </TableCell>
                    <TableCell className="whitespace-nowrap font-medium text-slate-800 dark:text-slate-100">
                      {getRequestCode(request)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-slate-700 dark:text-slate-300">
                      {format(new Date(request.created_at), "dd/MM/yyyy", { locale: dateLocale })}
                    </TableCell>
                    <TableCell className="font-medium text-slate-800 dark:text-slate-100">{request.suppliers?.name || "-"}</TableCell>
                    <TableCell>{renderProductNames(request)}</TableCell>
                    <TableCell className="text-right font-semibold text-slate-900 dark:text-slate-50">
                      {formatCurrency(request.total_amount || 0)}
                      {allocatedAmount > 0 && (
                        <div className="text-xs font-normal text-muted-foreground">
                          {language === "vi" ? "Đã TT" : "Paid"} {formatCurrency(allocatedAmount)}
                          {remainingAmount > 0 ? ` · ${language === "vi" ? "Còn" : "Left"} ${formatCurrency(remainingAmount)}` : ""}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-center">{getStatusBadge(request.status)}</TableCell>
                    <TableCell className="whitespace-nowrap text-slate-700 dark:text-slate-300">{getCreatorName(request)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {canEditPaymentRequests && (
                          <Button
                            variant="outline"
                            size="icon"
                            className="group h-8 w-8 rounded-md border-destructive/25 bg-destructive/5 text-destructive shadow-none hover:border-destructive/45 hover:bg-destructive/10 hover:text-destructive dark:border-destructive/35 dark:bg-destructive/10 dark:text-destructive dark:hover:bg-destructive/20 dark:hover:text-destructive"
                            disabled={deleteRequest.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeletingRequestId(request.id);
                            }}
                            onKeyDown={(event) => event.stopPropagation()}
                            title={language === "vi" ? "Xoá duyệt chi" : "Delete payment request"}
                          >
                            <Trash2 className="h-4 w-4 transition-[stroke-width] group-hover:stroke-[2.75]" />
                          </Button>
                        )}
                      </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="flex flex-col gap-4 border-t border-slate-200 px-4 py-4 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-300 lg:flex-row lg:items-center lg:justify-between lg:pr-28 xl:pr-32">
              <div>
                {language === "vi"
                  ? `Hiển thị ${firstResult} - ${lastResult} trong ${totalResults} kết quả`
                  : `Showing ${firstResult} - ${lastResult} of ${totalResults} results`}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span>{language === "vi" ? "Số dòng mỗi trang" : "Rows per page"}</span>
                <Select value={pageSize} onValueChange={setPageSize}>
                  <SelectTrigger className="h-10 w-[104px] rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="20">20</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                  </SelectContent>
                </Select>
                <div className="ml-0 flex items-center gap-2 lg:ml-8">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card"
                    disabled={safeCurrentPage <= 1}
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  {Array.from({ length: Math.min(4, totalPages) }, (_, index) => index + 1).map((page) => (
                    <Button
                      key={page}
                      variant={safeCurrentPage === page ? "default" : "outline"}
                      className={cn(
                        "h-10 w-10 rounded-md p-0 shadow-none",
                        safeCurrentPage === page
                          ? ""
                          : "border-slate-200 bg-white dark:border-slate-800 dark:bg-card"
                      )}
                      onClick={() => setCurrentPage(page)}
                    >
                      {page}
                    </Button>
                  ))}
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card"
                    disabled={safeCurrentPage >= totalPages}
                    onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Details Dialog */}
      <PaymentRequestDetailsDialog
        requestId={selectedRequestId}
        open={!!selectedRequestId}
        onOpenChange={(open) => !open && setSelectedRequestId(null)}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deletingRequestId} onOpenChange={(open) => !open && setDeletingRequestId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{language === "vi" ? "Xác nhận xóa" : "Confirm Delete"}</AlertDialogTitle>
            <AlertDialogDescription>
              {language === "vi" 
                ? "Bạn có chắc chắn muốn xóa đề nghị duyệt chi này? Hành động này không thể hoàn tác."
                : "Are you sure you want to delete this payment request? This action cannot be undone."
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleteRequest.isPending} className="bg-destructive hover:bg-destructive/90">
              {deleteRequest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {deleteRequest.isPending ? (language === "vi" ? "Đang xoá..." : "Deleting...") : t.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Approve Confirmation Dialog */}
      <AlertDialog open={showBulkApproveConfirm} onOpenChange={setShowBulkApproveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.confirmBulkApprove}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.confirmBulkApproveDesc
                .replace("{count}", String(selectedPendingIds.length))
                .replace("{amount}", formatCurrency(selectedPendingTotal))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleBulkApprove}
              disabled={bulkApprove.isPending}
            >
              {bulkApprove.isPending ? t.approving : t.confirmApproveAction}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Drive Invoice Import Dialog */}
      <DriveImportProgressDialog
        open={showDriveInvoiceDialog}
        onClose={(success) => {
          setShowDriveInvoiceDialog(false);
          if (success) {
            // Invalidate all related queries to refresh UI immediately
            queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
            queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
            queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
            queryClient.invalidateQueries({ queryKey: ["invoices"] });
          }
        }}
        importType="bank_slip"
      />
    </div>
  );
};

export default PaymentRequests;
