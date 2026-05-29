import { useEffect, useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { vi, enUS } from "date-fns/locale";
import {
  ArrowDown,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  Loader2,
  PackageCheck,
  Plus,
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
import { toast } from "sonner";

type CardFilterType = "pending" | "approved" | "rejected" | null;

const getMonthStartInputValue = () => {
  const today = new Date();
  return format(new Date(today.getFullYear(), today.getMonth(), 1), "yyyy-MM-dd");
};

const getMonthEndInputValue = () => {
  const today = new Date();
  return format(new Date(today.getFullYear(), today.getMonth() + 1, 0), "yyyy-MM-dd");
};

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
  const [dateFrom, setDateFrom] = useState(getMonthStartInputValue);
  const [dateTo, setDateTo] = useState(getMonthEndInputValue);
  
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

  const getCreatorName = (request: PaymentRequestWithSupplier) =>
    request.created_by ? `User ${request.created_by.slice(0, 8)}` : "-";

  const dateRangeLabel = useMemo(() => {
    const fromLabel = dateFrom ? format(new Date(`${dateFrom}T00:00:00`), "dd/MM/yyyy") : "--/--/----";
    const toLabel = dateTo ? format(new Date(`${dateTo}T00:00:00`), "dd/MM/yyyy") : "--/--/----";
    return `${fromLabel} - ${toLabel}`;
  }, [dateFrom, dateTo]);

  const dateFilteredRequests = useMemo(() => {
    return (requests || []).filter((request) => {
      const requestDate = format(new Date(request.created_at), "yyyy-MM-dd");
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

  const renderSourceBadge = (request: PaymentRequestWithSupplier) => {
    if (!isWarehouseReceiptPayable(request)) {
      return <Badge variant="outline" className="text-xs">{language === "vi" ? "Nguồn khác" : "Other source"}</Badge>;
    }

    return (
      <div className="space-y-1 text-xs">
        <Badge className="bg-emerald-600 text-xs">
          <PackageCheck className="mr-1 h-3 w-3" />
          {language === "vi" ? "Từ phiếu nhập kho" : "From warehouse receipt"}
        </Badge>
        <div className="font-mono text-muted-foreground">
          {request.goods_receipts?.receipt_number || request.goods_receipt_id}
        </div>
        {request.purchase_orders?.po_number && (
          <div className="font-mono text-muted-foreground">PO: {request.purchase_orders.po_number}</div>
        )}
      </div>
    );
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
    <div className="space-y-5 bg-slate-50/40 pb-28 dark:bg-background lg:pb-20">
      <div className="space-y-5">
        <h1 className="text-[28px] font-semibold leading-tight tracking-normal text-slate-950 dark:text-slate-50">
          {t.paymentRequestsTitle}
        </h1>

        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
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

        <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-4">
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
        <div className="flex flex-col gap-3 rounded-md border bg-muted/40 p-4 lg:flex-row lg:items-center lg:justify-between">
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

      {/* Requests Table */}
      <Card className="overflow-hidden rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card">
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
                  <TableHead className="min-w-[190px] text-slate-700 dark:text-slate-300">{language === "vi" ? "Nguồn" : "Source"}</TableHead>
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
                    <TableCell>{renderSourceBadge(request)}</TableCell>
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
