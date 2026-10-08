import { useEffect, useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { vi, enUS } from "date-fns/locale";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
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
import { UncApprovalDialog, type UncApprovalRequest } from "@/components/payment-requests/UncApprovalDialog";
import { UrgentPayablesPanel } from "@/components/payment-requests/UrgentPayablesPanel";
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
import "@/styles/bmq-payables.css";

type CardFilterType = "pending" | "approved" | "rejected" | null;

// Owner 2026-10-08: dates follow the device timezone, so the day filter does too (it used
// Vietnam days while rows showed device days, and a row dated 07/10 sat under the 08/10 filter).
const getDeviceDateKey = (date: Date = new Date()) => format(date, "yyyy-MM-dd");
const getCurrentDeviceDayInputValue = () => getDeviceDateKey();

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
  const [showBulkPaidConfirm, setShowBulkPaidConfirm] = useState(false);
  // Demo 3 master–detail: on wide screens the detail opens as a pane beside the list.
  const [wideLayout, setWideLayout] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 1280px)").matches : false,
  );
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const sync = () => setWideLayout(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const detailAsPanel = wideLayout && !!selectedRequestId;
  const [showDriveInvoiceDialog, setShowDriveInvoiceDialog] = useState(false);
  const [pageSize, setPageSize] = useState("10");
  const [currentPage, setCurrentPage] = useState(1);
  const [dateFrom, setDateFrom] = useState(getCurrentDeviceDayInputValue);
  const [dateTo, setDateTo] = useState(getCurrentDeviceDayInputValue);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  
  const { canEditModule, isOwner } = useAuth();
  const [showUncDialog, setShowUncDialog] = useState(false);
  // Default view: unpaid requests (Trình chi gấp). "all" keeps the full list below.
  const [view, setView] = useState<"unpaid" | "all">("unpaid");
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
      const requestDate = getDeviceDateKey(new Date(request.created_at));
      if (dateFrom && requestDate < dateFrom) return false;
      if (dateTo && requestDate > dateTo) return false;
      return true;
    });
  }, [requests, dateFrom, dateTo]);

  const summaryFilteredRequests = useMemo(() => {
    const normalizedSearchTerm = normalizeSearch(searchTerm);

    return dateFilteredRequests.filter((r) => {
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

      return true;
    });
  }, [dateFilteredRequests, sourceFilter, searchTerm]);

  const stats = useMemo(() => {
    const source = summaryFilteredRequests;
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
  }, [summaryFilteredRequests]);

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

    if (request.requires_receipt === false) {
      return {
        label: language === "vi" ? "Không nhập kho" : "No goods receipt",
        className: "border-border bg-muted text-muted-foreground",
        icon: FileText,
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
    return summaryFilteredRequests.filter((r) => {
      // Dropdown filters
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      
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
  }, [summaryFilteredRequests, statusFilter, activeCardFilter]);

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

  // One UNC can pay several requests of one supplier: pending ones and approved ones still owing money (CEO only).
  const selectedUncRequests = useMemo<UncApprovalRequest[]>(() => {
    return Array.from(selectedIds)
      .flatMap((id) => {
        const request = requests?.find((r) => r.id === id);
        if (!request) return [];
        const owing = getRemainingPaymentAmount(request) > 0
          && (request.payment_status === "unpaid" || request.payment_status === "partial");
        if (!(request.status === "pending" || (request.status === "approved" && owing))) return [];
        return [{
          id: request.id,
          requestNumber: request.request_number,
          supplierName: request.suppliers?.name ?? null,
          supplierId: request.supplier_id ?? null,
          totalAmount: Number(request.total_amount || 0),
          allocatedAmount: getAllocatedAmount(request),
          status: request.status,
          paymentStatus: request.payment_status,
          createdBy: request.created_by ?? null,
          createdAt: request.created_at ?? "",
        }];
      })
      .sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
  }, [selectedIds, requests]);

  // Calculate selected approved requests with remaining amount for bulk mark paid
  const selectedApprovedUnpaidIds = useMemo(() => {
    return Array.from(selectedIds).filter(id => {
      const request = requests?.find(r => r.id === id);
      return !!request && request.status === "approved" && hasOutstandingPayment(request);
    });
  }, [selectedIds, requests]);

  const selectedApprovedUnpaidTotal = useMemo(
    () =>
      selectedApprovedUnpaidIds.reduce((sum, id) => {
        const request = requests?.find((r) => r.id === id);
        return sum + (request ? getRemainingPaymentAmount(request) : 0);
      }, 0),
    [selectedApprovedUnpaidIds, requests],
  );

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
      onSuccess: (result) => {
        setShowBulkApproveConfirm(false);
        // Partial failures stay selected and are reported; approved ones leave the selection.
        setSelectedIds(new Set(result.failed.map((failure) => failure.id)));
        if (result.failed.length > 0) {
          const reasons = Array.from(new Set(result.failed.map((failure) => failure.message))).slice(0, 3).join("; ");
          toast.error(
            language === "vi"
              ? `Đã duyệt ${result.approved}/${result.count} phiếu. ${result.failed.length} phiếu chưa duyệt được: ${reasons}`
              : `Approved ${result.approved}/${result.count}. ${result.failed.length} could not be approved: ${reasons}`,
          );
        }
      },
    });
  };

  const isVi = language === "vi";
  const toMillions = (amount: number) =>
    (amount / 1_000_000).toLocaleString(isVi ? "vi-VN" : "en-US", { maximumFractionDigits: 1 });
  const figure = (value: string) => (isLoading ? "…" : isError ? "—" : value);
  // Demo 3 order: the pending queue leads, then the other status buckets.
  const summaryCards = [statCards[2], statCards[1], statCards[3], statCards[0], statCards[4]];
  const summaryTone = ["is-pending", "is-approved", "is-rejected", "is-total", "is-warehouse"];
  const statusLabel = (status: string) =>
    status === "pending" ? t.pending : status === "approved" ? t.approved : status === "rejected" ? t.rejected : status;
  const toggleSelected = (requestId: string) => {
    const next = new Set(selectedIds);
    if (next.has(requestId)) next.delete(requestId);
    else next.add(requestId);
    setSelectedIds(next);
  };

  return (
    <div
      data-stitch-payment-requests-mobile="hallmark-workbench"
      data-bmq-payables-layout="demo3-v1"
      data-bmq-payment-detail-pane={detailAsPanel ? "open" : undefined}
      className={cn("d3-pa min-w-0 overflow-x-clip pb-8 lg:pb-20", detailAsPanel && "d3-pr-has-panel")}
    >
      <header className="d3-pa-head">
        <div className="min-w-0">
          <span className="d3-pa-tag">
            {isVi ? "Tài chính · đề nghị chi" : "Finance · payment requests"} · {mobileDateRangeLabel}
          </span>
          <h1>
            {t.paymentRequestsTitle}{" "}
            <b>
              {isLoading
                ? "…"
                : isError
                  ? isVi ? "chưa tải được" : "unavailable"
                  : `${stats.pending.count} ${isVi ? "phiếu chờ" : "pending"}`}
            </b>
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2 lg:hidden">
          <Button
            variant="outline"
            size="icon"
            className="d3-pa-icon"
            onClick={() => window.dispatchEvent(new Event("bmq:open-agent-chat"))}
            title={isVi ? "Mở trợ lý AI" : "Open AI assistant"}
          >
            <MessageCircle className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" className="d3-pa-icon" onClick={() => refetch()} title={isVi ? "Làm mới" : "Refresh"}>
            <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
          </Button>
        </div>
      </header>

      <div className="d3-pa-view" role="tablist" aria-label="Chế độ xem" data-bmq-pr-view={view}>
        <button type="button" role="tab" aria-selected={view === "unpaid"} className={cn(view === "unpaid" && "is-on")} onClick={() => setView("unpaid")} data-bmq-pr-view-unpaid>
          Chưa thanh toán
        </button>
        <button type="button" role="tab" aria-selected={view === "all"} className={cn(view === "all" && "is-on")} onClick={() => setView("all")} data-bmq-pr-view-all>
          Tất cả
        </button>
      </div>

      {view === "unpaid" ? (
        <UrgentPayablesPanel canSubmit={isOwner || canEditPaymentRequests} onOpenRequest={setSelectedRequestId} />
      ) : (
      <>
      <section className="d3-pa-sum" data-bmq-payables-summary="demo3">
        {summaryCards.map((card, index) => {
          const isActive = card.isActive ?? (card.key === null ? activeCardFilter === null && sourceFilter === "all" : activeCardFilter === card.key);
          return (
            <button
              key={card.label}
              type="button"
              aria-pressed={isActive}
              className={cn("d3-pa-sumc", summaryTone[index], index === 0 && "is-hero", isActive && "is-active")}
              style={{ ["--i" as string]: index }}
              onClick={() => {
                if (card.onClick) {
                  card.onClick();
                  return;
                }
                setActiveCardFilter(card.key === activeCardFilter ? null : card.key);
              }}
            >
              {index === 0 ? <span className="d3-pa-glow" aria-hidden="true" /> : null}
              <span className="d3-pa-lvl"><i aria-hidden="true" />{card.label}</span>
              <span className="d3-pa-big">
                {figure(toMillions(card.amount))}
                {!isLoading && !isError ? <small>{isVi ? "tr" : "M"}</small> : null}
              </span>
              <span className="d3-pa-sub">
                {isError
                  ? isVi ? "Chưa tải được" : "Unavailable"
                  : isLoading
                    ? "…"
                    : `${card.count} ${isVi ? "phiếu" : "requests"} · ${compactCurrency(card.amount)}`}
              </span>
            </button>
          );
        })}
      </section>

      <div className="d3-pa-tools hidden min-w-0 flex-col gap-3 lg:flex" data-bmq-payables-toolbar="v2">
        <div className="flex min-w-0 items-center gap-3" data-bmq-payables-search-row="v2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={isVi ? "Tìm theo mã phiếu, tên sản phẩm hoặc nhà cung cấp" : "Search by code, product, or supplier"}
              className="h-12 rounded-md border-slate-200 bg-white pl-12 text-sm shadow-none placeholder:text-slate-400 dark:border-slate-800 dark:bg-card"
            />
          </div>

          <AddPaymentRequestDialog
            trigger={
              <Button className="d3-pa-primary h-12 rounded-md px-6 text-sm font-medium shadow-sm">
                <Plus className="h-5 w-5" />
                {isVi ? "Tạo duyệt chi" : "Create request"}
              </Button>
            }
          />

          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card"
            onClick={() => setShowDriveInvoiceDialog(true)}
            title={isVi ? "Nhập từ Google Drive" : "Import from Google Drive"}
          >
            <Upload className="h-5 w-5" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card"
            onClick={() => refetch()}
            title={isVi ? "Làm mới" : "Refresh"}
          >
            <RefreshCw className={cn("h-5 w-5", isLoading && "animate-spin")} />
          </Button>
        </div>
        <div
          className="grid min-w-0 grid-cols-2 gap-3 xl:grid-cols-[minmax(330px,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]"
          data-bmq-payables-filter-row="v3"
        >
          <div
            data-bmq-payables-date-range="v3"
            className="col-span-2 flex h-12 min-w-0 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 shadow-none dark:border-slate-800 dark:bg-card dark:text-slate-100 xl:col-span-1"
          >
            <CalendarDays className="h-4 w-4 shrink-0 text-slate-500" />
            <span className="sr-only">{dateRangeLabel}</span>
            <Input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(event) => setDateFrom(event.target.value)}
              aria-label={isVi ? "Từ ngày" : "From date"}
              className="h-10 min-w-0 flex-1 basis-0 border-0 bg-transparent p-0 text-sm font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <span className="shrink-0 text-slate-400">-</span>
            <Input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(event) => setDateTo(event.target.value)}
              aria-label={isVi ? "Đến ngày" : "To date"}
              className="h-10 min-w-0 flex-1 basis-0 border-0 bg-transparent p-0 text-sm font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger
              aria-label={isVi ? "Trạng thái" : "Status"}
              className="h-12 w-full min-w-0 rounded-md border-slate-200 bg-white px-4 text-slate-800 shadow-none dark:border-slate-800 dark:bg-card dark:text-slate-100"
            >
              <SelectValue placeholder={t.status} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{isVi ? "Tất cả trạng thái" : "All statuses"}</SelectItem>
              <SelectItem value="pending">{t.pending}</SelectItem>
              <SelectItem value="approved">{t.approved}</SelectItem>
              <SelectItem value="rejected">{t.rejected}</SelectItem>
            </SelectContent>
          </Select>

          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger
              aria-label={isVi ? "Nguồn công nợ" : "Payable source"}
              className="h-12 w-full min-w-0 rounded-md border-slate-200 bg-white px-4 text-slate-800 shadow-none dark:border-slate-800 dark:bg-card dark:text-slate-100"
            >
              <SelectValue placeholder={isVi ? "Nguồn công nợ" : "Payable source"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{isVi ? "Tất cả nguồn" : "All sources"}</SelectItem>
              <SelectItem value="warehouse_receipt">{isVi ? "Công nợ tạo từ nhập kho" : "Generated from warehouse receipt"}</SelectItem>
              <SelectItem value="manual">{isVi ? "Tạo thủ công / nguồn khác" : "Manual / other source"}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div data-stitch-section="mobile-summary-filters" className="d3-pa-mfilters lg:hidden">
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={isVi ? "Tìm mã phiếu, NCC..." : "Search code, supplier..."}
            className="d3-pa-msearch pl-11"
          />
        </div>
        <div className="d3-pa-pills" role="group" aria-label={isVi ? "Trạng thái" : "Status"}>
          {[
            { value: "all", label: isVi ? "Tất cả" : "All" },
            { value: "pending", label: t.pending },
            { value: "approved", label: t.approved },
            { value: "rejected", label: t.rejected },
          ].map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={statusFilter === filter.value}
              onClick={() => setStatusFilter(filter.value)}
              className={cn(statusFilter === filter.value && "is-on")}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-expanded={mobileFiltersOpen}
          onClick={() => setMobileFiltersOpen((open) => !open)}
          className="d3-pa-mtoggle"
        >
          <span className="flex min-w-0 items-center gap-2">
            <CalendarDays className="h-4 w-4 shrink-0" />
            <span>{isVi ? "Bộ lọc ngày & nguồn" : "Date & source filters"}</span>
          </span>
          <span className="shrink-0 text-xs tabular-nums">{mobileDateRangeLabel}</span>
        </button>

        {mobileFiltersOpen ? (
          <div className="space-y-3">
            <div data-bmq-payment-requests-default-vn-day="true" className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="d3-pa-mdate">
                {isVi ? "Từ ngày" : "From"}
                <span>
                  {dateFrom ? format(new Date(`${dateFrom}T00:00:00`), "dd/MM/yyyy") : "--/--/----"}
                  <input
                    type="date"
                    lang={language}
                    value={dateFrom}
                    max={dateTo || undefined}
                    onChange={(event) => setDateFrom(event.target.value)}
                    aria-label={isVi ? "Từ ngày" : "From date"}
                  />
                </span>
              </label>
              <label className="d3-pa-mdate">
                {isVi ? "Đến ngày" : "To"}
                <span>
                  {dateTo ? format(new Date(`${dateTo}T00:00:00`), "dd/MM/yyyy") : "--/--/----"}
                  <input
                    type="date"
                    lang={language}
                    value={dateTo}
                    min={dateFrom || undefined}
                    onChange={(event) => setDateTo(event.target.value)}
                    aria-label={isVi ? "Đến ngày" : "To date"}
                  />
                </span>
              </label>
            </div>
            <button
              type="button"
              aria-pressed={sourceFilter === "warehouse_receipt"}
              onClick={() => setSourceFilter(sourceFilter === "warehouse_receipt" ? "all" : "warehouse_receipt")}
              className={cn("d3-pa-mtoggle", sourceFilter === "warehouse_receipt" && "is-on")}
            >
              <span>{isVi ? "Chỉ phiếu từ nhập kho" : "Warehouse receipts only"}</span>
              <PackageCheck className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        <div className="grid grid-cols-[minmax(0,1fr)_44px] gap-2">
          <AddPaymentRequestDialog trigger={<Button className="d3-pa-primary h-11 w-full whitespace-nowrap"><Plus className="mr-2 h-4 w-4" />{isVi ? "Tạo duyệt chi" : "Create request"}</Button>} />
          <Button variant="outline" size="icon" className="d3-pa-icon" onClick={() => setShowDriveInvoiceDialog(true)} title={isVi ? "Nhập từ Google Drive" : "Import from Google Drive"}><Upload className="h-4 w-4" /></Button>
        </div>
      </div>

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div data-stitch-section="mobile-selected-actions-inline" className="d3-pa-bulk">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              {t.selected}: <b>{selectedIds.size}</b>
            </span>
            <span>
              {t.total}: <b>{formatCurrency(
                Array.from(selectedIds).reduce((sum, id) => {
                  const request = requests?.find(r => r.id === id);
                  return sum + (request?.total_amount || 0);
                }, 0)
              )}</b>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isOwner && selectedUncRequests.length > 0 && (
              <Button onClick={() => setShowUncDialog(true)} className="gap-2" data-bmq-unc-bulk>
                <Wallet className="h-4 w-4" />
                {language === "vi" ? "Trả bằng UNC" : "Pay with UNC"} ({selectedUncRequests.length})
              </Button>
            )}
            {/* Quick Approve button - only show when pending requests are selected */}
            {selectedPendingIds.length > 0 && (
              <Button
                onClick={() => setShowBulkApproveConfirm(true)}
                disabled={bulkApprove.isPending}
                className="d3-pa-go gap-2"
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
                onClick={() => setShowBulkPaidConfirm(true)}
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
              aria-label={isVi ? "Bỏ chọn tất cả" : "Clear selection"}
              onClick={() => setSelectedIds(new Set())}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Requests: one compact list for every width (Demo 3 .apr rows) */}
      <section className="d3-pa-list" data-bmq-pr-list="demo3">
        <div className="d3-pa-list-h">
          <h2>{isVi ? "Đề nghị chi" : "Requests"}</h2>
          {!isLoading && !isError && selectableRequests.length > 0 ? (
            <label className="d3-pa-all">
              <Checkbox
                checked={selectableRequests.every(r => selectedIds.has(r.id))}
                onCheckedChange={(checked) => {
                  if (checked) {
                    setSelectedIds(new Set(selectableRequests.map(r => r.id)));
                  } else {
                    setSelectedIds(new Set());
                  }
                }}
              />
              {isVi ? `Chọn tất cả (${selectableRequests.length})` : `Select all (${selectableRequests.length})`}
            </label>
          ) : null}
        </div>

        {isLoading ? (
          <div className="d3-pa-rows">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-[132px] rounded-2xl" />
            ))}
          </div>
        ) : isError ? (
          <div className="d3-pa-state is-error">
            <p className="font-medium">{isVi ? "Không thể tải dữ liệu" : "Couldn't load data"}</p>
            <p className="break-words text-sm">{error instanceof Error ? error.message : "Unknown error"}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => refetch()}>{isVi ? "Thử lại" : "Retry"}</Button>
              <Button variant="outline" onClick={() => window.location.reload()}>{isVi ? "Tải lại trang" : "Reload Page"}</Button>
            </div>
          </div>
        ) : filteredRequests?.length === 0 ? (
          <div className="d3-pa-state">
            <FileText className="mx-auto mb-3 h-10 w-10" />
            <p>{t.noPaymentRequests}</p>
          </div>
        ) : (
          <>
            <div className="d3-pa-rows">
              {paginatedRequests.map((request, index) => {
                const cue = getAccountingCue(request);
                const CueIcon = cue.icon;
                const isSelectable = request.status === "pending" || (request.status === "approved" && hasOutstandingPayment(request));
                const isSelected = selectedIds.has(request.id);
                const isActiveRow = selectedRequestId === request.id;
                const productNames = getProductNames(request);
                const remainingAmount = getRemainingPaymentAmount(request);
                const allocatedAmount = getAllocatedAmount(request);
                const products = productNames.length
                  ? productNames.slice(0, 2).join(", ") + (productNames.length > 2 ? ` +${productNames.length - 2}` : "")
                  : request.title || (isVi ? "Đề nghị thanh toán" : "Payment request");

                return (
                  <article
                    key={request.id}
                    data-bmq-pr-row={request.status}
                    aria-current={isActiveRow ? "true" : undefined}
                    className={cn("d3-pa-row", `is-${request.status}`, isSelected && "is-selected", isActiveRow && "d3-pr-row-active")}
                    style={{ ["--i" as string]: Math.min(index, 8) }}
                  >
                    <div className="d3-pa-check">
                      {isSelectable ? (
                        <Checkbox
                          checked={isSelected}
                          aria-label={isSelected ? (isVi ? "Bỏ chọn phiếu" : "Unselect request") : (isVi ? "Chọn phiếu" : "Select request")}
                          onCheckedChange={() => toggleSelected(request.id)}
                        />
                      ) : null}
                    </div>
                    <button type="button" className="d3-pa-open" onClick={() => setSelectedRequestId(request.id)}>
                      <span className="d3-pa-who">
                        <b>{request.suppliers?.name || (isVi ? "Chưa có nhà cung cấp" : "No supplier")}</b>
                        <small>{getRequestCode(request)} · {products}</small>
                      </span>
                      <span className="d3-pa-amt">
                        {new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(request.total_amount || 0)}
                        <small>đ</small>
                      </span>
                      <span className="d3-pa-tags">
                        <span className={cn("d3-pa-due", `is-${request.status}`)}>{statusLabel(request.status)}</span>
                        <span className="d3-pa-cue"><CueIcon className="h-3.5 w-3.5" />{cue.label}</span>
                        <span className="d3-pa-meta">
                          {format(new Date(request.created_at), "dd/MM/yyyy", { locale: dateLocale })} · {getCreatorName(request)} · {getSourceLabel(request)}
                        </span>
                      </span>
                      {allocatedAmount > 0 ? (
                        <span className="d3-pa-paid">
                          {isVi ? "Đã TT" : "Paid"} {formatCurrency(allocatedAmount)}
                          {remainingAmount > 0 ? ` · ${isVi ? "Còn" : "Left"} ${formatCurrency(remainingAmount)}` : ""}
                        </span>
                      ) : null}
                    </button>
                    {(request.status === "pending" && canEditPaymentRequests) || canEditPaymentRequests ? (
                      <div className="d3-pa-acts">
                        {canEditPaymentRequests ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="d3-pa-del hidden lg:inline-flex"
                            disabled={deleteRequest.isPending}
                            onClick={() => setDeletingRequestId(request.id)}
                            title={isVi ? "Xoá duyệt chi" : "Delete payment request"}
                            aria-label={isVi ? "Xoá duyệt chi" : "Delete payment request"}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {request.status === "pending" && canEditPaymentRequests ? (
                          <Button
                            className="d3-pa-go"
                            disabled={bulkApprove.isPending}
                            onClick={() => openQuickApproveConfirm(request.id)}
                          >
                            <CheckCircle2 className="h-4 w-4" />
                            {isVi ? "Duyệt" : "Approve"} {toMillions(request.total_amount || 0)}{isVi ? "tr" : "M"}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>

            <div className="d3-pa-foot">
              <div>
                {vi
                  ? `Hiển thị ${firstResult} - ${lastResult} trong ${totalResults} kết quả`
                  : `Showing ${firstResult} - ${lastResult} of ${totalResults} results`}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="hidden sm:inline">{isVi ? "Số dòng mỗi trang" : "Rows per page"}</span>
                <Select value={pageSize} onValueChange={setPageSize}>
                  <SelectTrigger aria-label={isVi ? "Số dòng mỗi trang" : "Rows per page"} className="d3-pa-pagesize">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="20">20</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                  </SelectContent>
                </Select>
                <div className="d3-pa-pages">
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={isVi ? "Trang trước" : "Previous page"}
                    disabled={safeCurrentPage <= 1}
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  {Array.from({ length: Math.min(4, totalPages) }, (_, index) => index + 1).map((page) => (
                    <Button
                      key={page}
                      variant="outline"
                      className={cn(safeCurrentPage === page && "is-on")}
                      aria-current={safeCurrentPage === page ? "page" : undefined}
                      onClick={() => setCurrentPage(page)}
                    >
                      {page}
                    </Button>
                  ))}
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={isVi ? "Trang sau" : "Next page"}
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
      </section>
      </>
      )}

      <UncApprovalDialog
        open={showUncDialog}
        onOpenChange={setShowUncDialog}
        mode="approve"
        requests={selectedUncRequests}
        onDone={() => setSelectedIds(new Set())}
      />

      {/* Details Dialog */}
      <PaymentRequestDetailsDialog
        requestId={selectedRequestId}
        open={!!selectedRequestId}
        onOpenChange={(open) => !open && setSelectedRequestId(null)}
        presentation={wideLayout ? "panel" : "dialog"}
        onSelectRequest={setSelectedRequestId}
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

      {/* Bulk "Đã chi" confirmation: records real payments, so it is never one click. */}
      <AlertDialog open={showBulkPaidConfirm} onOpenChange={setShowBulkPaidConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{language === "vi" ? "Xác nhận đã chi" : "Confirm payment"}</AlertDialogTitle>
            <AlertDialogDescription>
              {language === "vi"
                ? `Ghi nhận đã thanh toán ${selectedApprovedUnpaidIds.length} phiếu, tổng số tiền còn lại ${formatCurrency(selectedApprovedUnpaidTotal)}. Thao tác này ghi thanh toán thật.`
                : `Record payment for ${selectedApprovedUnpaidIds.length} requests, outstanding total ${formatCurrency(selectedApprovedUnpaidTotal)}. This records real payments.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
            <AlertDialogAction
              data-bmq-confirm-bulk-paid
              disabled={bulkMarkPaid.isPending || selectedApprovedUnpaidIds.length === 0}
              onClick={() =>
                bulkMarkPaid.mutate(selectedApprovedUnpaidIds, {
                  onSuccess: () => {
                    setSelectedIds(new Set());
                    setShowBulkPaidConfirm(false);
                  },
                  onError: (error) => {
                    toast.error(
                      language === "vi"
                        ? `Chưa ghi được thanh toán: ${error instanceof Error ? error.message : String(error)}`
                        : `Payment was not recorded: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  },
                })
              }
            >
              {bulkMarkPaid.isPending ? (language === "vi" ? "Đang ghi…" : "Recording…") : t.markAsPaid}
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
