import { useEffect, useState, useMemo } from "react";
import { format } from "date-fns";
import { vi, enUS } from "date-fns/locale";
import { Package, Trash2, CheckCircle, Clock, FileCheck, AlertCircle, Link2, Loader2, Menu, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { useGoodsReceipts, useDeleteGoodsReceipt, useConfirmGoodsReceipt } from "@/hooks/useGoodsReceipts";
import { useLanguage } from "@/contexts/LanguageContext";
import { AddGoodsReceiptDialog } from "@/components/dialogs/AddGoodsReceiptDialog";
import { GoodsReceiptDetailsDialog } from "@/components/dialogs/GoodsReceiptDetailsDialog";

const RECEIPTS_PER_PAGE = 20;
type TimeFilterMode = "week" | "month" | "year";

const normalizeSearchText = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .trim();

const toMonthValue = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
const toYearValue = (date: Date) => String(date.getFullYear());

const formatMonthLabel = (monthValue: string) => {
  const [year, month] = monthValue.split("-");
  return `Tháng ${month}/${year}`;
};

const parseReceiptDate = (rawDate: string | null) => {
  if (!rawDate) return null;
  const date = new Date(rawDate);
  return Number.isNaN(date.getTime()) ? null : date;
};

const buildWeekBuckets = (monthValue: string) => {
  const [yearRaw, monthRaw] = monthValue.split("-");
  const year = Number(yearRaw);
  const monthIndex = Number(monthRaw) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) return [];

  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const monthLabel = String(monthIndex + 1).padStart(2, "0");
  return Array.from({ length: Math.ceil(lastDay / 7) }, (_, index) => {
    const startDay = index * 7 + 1;
    const endDay = Math.min(startDay + 6, lastDay);
    return {
      value: `${monthValue}-w${index + 1}`,
      label: `Tuần ${index + 1} (${startDay}-${endDay}/${monthLabel})`,
      startDay,
      endDay,
    };
  });
};

const getWeekBucketValue = (date: Date) => {
  const monthValue = toMonthValue(date);
  const weekIndex = Math.floor((date.getDate() - 1) / 7) + 1;
  return `${monthValue}-w${weekIndex}`;
};

const receiptMatchesPeriod = (rawDate: string | null, mode: TimeFilterMode, monthValue: string, yearValue: string, weekValue: string) => {
  const date = parseReceiptDate(rawDate);
  if (!date) return false;
  if (mode === "year") return String(date.getFullYear()) === yearValue;
  if (mode === "month") return toMonthValue(date) === monthValue;
  return getWeekBucketValue(date) === weekValue;
};

export default function GoodsReceipts() {
  const { language } = useLanguage();
  const locale = language === "vi" ? vi : enUS;
  const isVi = language === "vi";
  
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [supplierSearchTerm, setSupplierSearchTerm] = useState("");
  const [timeFilterMode, setTimeFilterMode] = useState<TimeFilterMode>("week");
  const [selectedMonthValue, setSelectedMonthValue] = useState(() => toMonthValue(new Date()));
  const [selectedYearValue, setSelectedYearValue] = useState(() => toYearValue(new Date()));
  const [selectedWeekValue, setSelectedWeekValue] = useState(() => getWeekBucketValue(new Date()));

  const { data: receipts = [], isLoading, error } = useGoodsReceipts();
  const deleteReceipt = useDeleteGoodsReceipt();
  const confirmReceipt = useConfirmGoodsReceipt();

  const weekOptions = useMemo(() => buildWeekBuckets(selectedMonthValue), [selectedMonthValue]);

  const monthOptions = useMemo(() => {
    const values = new Set<string>([toMonthValue(new Date())]);
    receipts.forEach((receipt) => {
      const date = parseReceiptDate(receipt.receipt_date);
      if (date) values.add(toMonthValue(date));
    });
    return Array.from(values).sort((a, b) => b.localeCompare(a));
  }, [receipts]);

  const yearOptions = useMemo(() => {
    const values = new Set<string>([toYearValue(new Date())]);
    receipts.forEach((receipt) => {
      const date = parseReceiptDate(receipt.receipt_date);
      if (date) values.add(toYearValue(date));
    });
    return Array.from(values).sort((a, b) => b.localeCompare(a));
  }, [receipts]);

  const periodAndSupplierFilteredReceipts = useMemo(() => {
    const supplierNeedle = normalizeSearchText(supplierSearchTerm);
    return receipts.filter((r) => {
      if (!receiptMatchesPeriod(r.receipt_date, timeFilterMode, selectedMonthValue, selectedYearValue, selectedWeekValue)) return false;
      if (supplierNeedle) {
        const supplierName = normalizeSearchText(r.suppliers?.name || "");
        if (!supplierName.includes(supplierNeedle)) return false;
      }
      return true;
    });
  }, [receipts, selectedMonthValue, selectedWeekValue, selectedYearValue, supplierSearchTerm, timeFilterMode]);

  const includeSelectedReceiptInFilteredResults = useMemo(() => {
    if (!selectedReceiptId) return null;
    return receipts.find((receipt) => receipt.id === selectedReceiptId) || null;
  }, [receipts, selectedReceiptId]);

  const filteredReceipts = useMemo(() => {
    const rows = periodAndSupplierFilteredReceipts.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      return true;
    });

    if (
      includeSelectedReceiptInFilteredResults &&
      !rows.some((receipt) => receipt.id === includeSelectedReceiptInFilteredResults.id)
    ) {
      return [includeSelectedReceiptInFilteredResults, ...rows];
    }

    return rows;
  }, [includeSelectedReceiptInFilteredResults, periodAndSupplierFilteredReceipts, statusFilter]);

  useEffect(() => {
    if (weekOptions.length > 0 && !weekOptions.some((week) => week.value === selectedWeekValue)) {
      setSelectedWeekValue(weekOptions[0].value);
    }
  }, [selectedWeekValue, weekOptions]);

  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, supplierSearchTerm, selectedMonthValue, selectedWeekValue, selectedYearValue, timeFilterMode]);

  const totalPages = Math.max(1, Math.ceil(filteredReceipts.length / RECEIPTS_PER_PAGE));

  useEffect(() => {
    setCurrentPage((page) => Math.min(Math.max(page, 1), totalPages));
  }, [totalPages]);

  const paginatedReceipts = useMemo(() => {
    const start = (currentPage - 1) * RECEIPTS_PER_PAGE;
    return filteredReceipts.slice(start, start + RECEIPTS_PER_PAGE);
  }, [currentPage, filteredReceipts]);

  const paginationStart = filteredReceipts.length === 0 ? 0 : (currentPage - 1) * RECEIPTS_PER_PAGE + 1;
  const paginationEnd = Math.min(currentPage * RECEIPTS_PER_PAGE, filteredReceipts.length);

  const stats = useMemo(() => {
    return {
      total: periodAndSupplierFilteredReceipts.length,
      draft: periodAndSupplierFilteredReceipts.filter((r) => r.status === "draft").length,
      confirmed: periodAndSupplierFilteredReceipts.filter((r) => r.status === "confirmed").length,
      received: periodAndSupplierFilteredReceipts.filter((r) => r.status === "received").length,
    };
  }, [periodAndSupplierFilteredReceipts]);

  const formatReceiptDate = (rawDate: string | null) => {
    if (!rawDate) return "-";
    const d = new Date(rawDate);
    if (Number.isNaN(d.getTime())) return "-";
    return format(d, "dd/MM/yyyy", { locale });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />Nháp</Badge>;
      case "confirmed":
        return <Badge variant="default"><FileCheck className="h-3 w-3 mr-1" />{isVi ? "Đã xác nhận" : "Confirmed"}</Badge>;
      case "received":
        return <Badge className="bg-emerald-600"><CheckCircle className="h-3 w-3 mr-1" />{isVi ? "Đã nhập kho" : "Received"}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getPayableBadge = (receipt: (typeof receipts)[number]) => {
    if (receipt.payable_status === "generated") {
      return <Badge className="bg-emerald-600"><CheckCircle className="h-3 w-3 mr-1" />{isVi ? "Đã tạo công nợ" : "Payable created"}</Badge>;
    }
    if (receipt.payable_status === "pending") {
      return <Badge variant="default"><Clock className="h-3 w-3 mr-1" />{isVi ? "Đang xử lý công nợ" : "Payable pending"}</Badge>;
    }
    return <Badge variant="outline"><AlertCircle className="h-3 w-3 mr-1" />{isVi ? "Chưa tạo công nợ" : "No payable"}</Badge>;
  };

  const getReceiptActionLabel = (receipt: (typeof receipts)[number]) => {
    if (receipt.payable_status === "generated") return isVi ? "Đã tạo công nợ" : "Payable created";
    const paymentStatus = receipt.payment_requests?.payment_status;
    const requestStatus = receipt.payment_requests?.status;
    if (paymentStatus === "paid" || paymentStatus === "partial") {
      return isVi ? "Nhập kho + Đối soát thanh toán" : "Receive + Reconcile payment";
    }
    if (requestStatus === "approved" || requestStatus === "completed" || receipt.payment_requests?.request_number) {
      return isVi ? "Nhập kho + Đối soát công nợ" : "Receive + Reconcile payable";
    }
    return isVi ? "Nhập kho + Ghi nhận công nợ" : "Receive + Record payable";
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteReceipt.mutateAsync(deleteId);
      toast.success("Đã xóa phiếu nhập kho");
      setDeleteId(null);
    } catch (error) {
      toast.error("Không thể xóa phiếu nhập kho");
    }
  };

  const handleConfirmReceipt = async (id: string) => {
    try {
      await confirmReceipt.mutateAsync(id);
      const finalizedReceipt = receipts.find((receipt) => receipt.id === id);
      const finalizedDate = parseReceiptDate(finalizedReceipt?.receipt_date || null) || new Date();
      setSelectedReceiptId(id);
      setStatusFilter("received");
      setTimeFilterMode("month");
      setSelectedMonthValue(toMonthValue(finalizedDate));
      setSelectedYearValue(toYearValue(finalizedDate));
      toast.success("Đã nhập hàng vào kho thành công");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Không thể nhập hàng vào kho";
      toast.error(message);
    }
  };

  const handleViewDetails = (id: string) => {
    setSelectedReceiptId(id);
    setDetailsOpen(true);
  };

  const renderPaginationControls = (surface: "mobile" | "desktop") => {
    if (filteredReceipts.length <= RECEIPTS_PER_PAGE) return null;

    return (
      <div
        className={`flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 text-sm ${surface === "mobile" ? "md:hidden" : "hidden md:flex"}`}
        data-bmq-goods-receipts-pagination
        data-bmq-goods-receipts-per-page={RECEIPTS_PER_PAGE}
      >
        <div className="min-w-0 text-muted-foreground">
          <span className="font-medium text-foreground">{paginationStart}-{paginationEnd}</span> / {filteredReceipts.length} {isVi ? "phiếu" : "receipts"}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-3"
            onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
            disabled={currentPage === 1}
          >
            {isVi ? "Trước" : "Prev"}
          </Button>
          <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
            {isVi ? "Trang" : "Page"} {currentPage}/{totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-3"
            onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
            disabled={currentPage === totalPages}
          >
            {isVi ? "Sau" : "Next"}
          </Button>
        </div>
      </div>
    );
  };

  const statusCards = [
    { key: "all", label: isVi ? "Tổng phiếu" : "Total", value: stats.total, tone: "text-primary" },
    { key: "draft", label: "Nháp", value: stats.draft, tone: "text-muted-foreground" },
    { key: "confirmed", label: isVi ? "Đã xác nhận" : "Confirmed", value: stats.confirmed, tone: "text-primary" },
    { key: "received", label: isVi ? "Đã nhập" : "Received", value: stats.received, tone: "text-emerald-600" },
  ];

  return (
    <div className="-m-4 min-h-screen bg-background text-foreground md:-m-6" data-bmq-goods-receipts-mobile-optimized data-bmq-goods-receipts-finalized-visible-after-confirm>
      <div className="space-y-4 p-4 pb-8 md:p-6">
        <div className="rounded-2xl border border-border bg-card p-4 shadow-card">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2 md:hidden">
                <Button type="button" variant="ghost" size="icon" className="-ml-2 h-8 w-8" onClick={() => window.dispatchEvent(new Event("bmq:open-sidebar"))} aria-label="Mở menu">
                  <Menu className="h-5 w-5" />
                </Button>
                <span className="text-xs font-semibold uppercase tracking-wide text-primary">Kho hàng</span>
              </div>
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
                <Package className="h-6 w-6 text-primary" />
                {isVi ? "Phiếu nhập kho" : "Goods Receipts"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">{isVi ? "Quản lý nhập kho từ PO và tạo công nợ phải trả" : "Manage receipt from PO and payable creation"}</p>
            </div>
            <div className="shrink-0">
              <AddGoodsReceiptDialog />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-bmq-goods-receipts-filtered-dashboard>
          {statusCards.map((card) => (
            <Card
              key={card.key}
              className={`cursor-pointer border-border bg-card transition-shadow hover:shadow-card ${statusFilter === card.key ? "ring-2 ring-primary" : ""}`}
              onClick={() => setStatusFilter(card.key)}
            >
              <CardHeader className="px-3 py-2">
                <CardDescription>{card.label}</CardDescription>
                <CardTitle className={`text-2xl ${card.tone}`}>{card.value}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </div>

        <Card className="border-border bg-card" data-bmq-goods-receipts-period-filters data-bmq-goods-receipts-default-week-filter>
          <CardContent className="space-y-3 p-3">
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[1.25fr_0.7fr_0.9fr_0.8fr]">
              <div className="relative" data-bmq-goods-receipts-supplier-search>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={supplierSearchTerm}
                  onChange={(event) => setSupplierSearchTerm(event.target.value)}
                  className="h-9 border-border bg-background pl-9 text-sm"
                  placeholder={isVi ? "Tìm theo nhà cung cấp..." : "Search supplier..."}
                />
              </div>

              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9 w-full border-border bg-background text-sm">
                  <SelectValue placeholder={isVi ? "Trạng thái" : "Status"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{isVi ? "Tất cả" : "All"}</SelectItem>
                  <SelectItem value="draft">{isVi ? "Nháp" : "Draft"}</SelectItem>
                  <SelectItem value="confirmed">{isVi ? "Đã xác nhận" : "Confirmed"}</SelectItem>
                  <SelectItem value="received">{isVi ? "Đã nhập kho" : "Received"}</SelectItem>
                </SelectContent>
              </Select>

              <Select value={timeFilterMode} onValueChange={(value) => setTimeFilterMode(value as TimeFilterMode)}>
                <SelectTrigger className="h-9 w-full border-border bg-background text-sm" data-bmq-goods-receipts-time-mode>
                  <SelectValue placeholder={isVi ? "Kỳ lọc" : "Period"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="week">{isVi ? "Theo tuần" : "Week"}</SelectItem>
                  <SelectItem value="month">{isVi ? "Theo tháng" : "Month"}</SelectItem>
                  <SelectItem value="year">{isVi ? "Theo năm" : "Year"}</SelectItem>
                </SelectContent>
              </Select>

              {timeFilterMode === "year" ? (
                <Select value={selectedYearValue} onValueChange={setSelectedYearValue}>
                  <SelectTrigger className="h-9 min-w-0 w-full border-border bg-background text-sm" data-bmq-goods-receipts-year-filter>
                    <SelectValue placeholder={isVi ? "Chọn năm" : "Select year"} />
                  </SelectTrigger>
                  <SelectContent>
                    {yearOptions.map((year) => (
                      <SelectItem key={year} value={year}>{year}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Select value={selectedMonthValue} onValueChange={setSelectedMonthValue}>
                  <SelectTrigger className="h-9 min-w-0 w-full border-border bg-background text-sm" data-bmq-goods-receipts-month-filter data-bmq-goods-receipts-month-select-stable>
                    <SelectValue placeholder={isVi ? "Chọn tháng" : "Select month"} />
                  </SelectTrigger>
                  <SelectContent>
                    {monthOptions.map((month) => (
                      <SelectItem key={month} value={month}>{formatMonthLabel(month)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {timeFilterMode === "week" && (
              <div className="flex flex-col gap-2 rounded-xl border border-primary/15 bg-primary/5 p-3 sm:flex-row sm:items-center sm:justify-between" data-bmq-goods-receipts-week-buckets>
                <div className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{isVi ? "Tuần mặc định" : "Default week"}</span>{" "}
                  {isVi ? "được chia theo ngày trong tháng: 1-7, 8-14, 15-21, 22-28, 29-hết tháng." : "is split by month days: 1-7, 8-14, 15-21, 22-28, 29-end."}
                </div>
                <Select value={selectedWeekValue} onValueChange={setSelectedWeekValue}>
                  <SelectTrigger className="h-9 w-full border-border bg-background text-sm sm:w-52" data-bmq-goods-receipts-week-filter>
                    <SelectValue placeholder={isVi ? "Chọn tuần" : "Select week"} />
                  </SelectTrigger>
                  <SelectContent>
                    {weekOptions.map((week) => (
                      <SelectItem key={week.value} value={week.value}>{week.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              {isVi ? "Đang hiển thị" : "Showing"} <span className="font-semibold text-foreground">{filteredReceipts.length}</span> / {receipts.length} {isVi ? "phiếu theo bộ lọc hiện tại" : "receipts for current filters"}
            </div>
          </CardContent>
        </Card>

        {renderPaginationControls("mobile")}

        <div className="space-y-3 md:hidden" data-bmq-goods-receipts-mobile-card-list>
          {isLoading ? (
            <Card className="border-border bg-card p-6 text-center text-muted-foreground">
              <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
              {isVi ? "Đang tải phiếu nhập kho..." : "Loading goods receipts..."}
            </Card>
          ) : error ? (
            <Card className="border-destructive/30 bg-card p-6 text-center text-destructive">
              {isVi ? "Lỗi tải dữ liệu phiếu nhập kho. Vui lòng thử lại." : "Failed to load goods receipts. Please try again."}
            </Card>
          ) : filteredReceipts.length === 0 ? (
            <Card className="border-dashed border-border bg-card p-6 text-center text-muted-foreground">
              <Package className="mx-auto mb-2 h-10 w-10 opacity-60" />
              {isVi ? "Chưa có phiếu nhập kho nào" : "No goods receipts yet"}
            </Card>
          ) : (
            paginatedReceipts.map((receipt) => (
              <Card
                key={receipt.id}
                role="button"
                tabIndex={0}
                data-bmq-goods-receipt-row-click-detail
                className="cursor-pointer border-border bg-card shadow-card transition active:scale-[0.99]"
                onClick={() => handleViewDetails(receipt.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleViewDetails(receipt.id);
                  }
                }}
              >
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-semibold text-primary">{receipt.receipt_number}</p>
                      <p className="mt-1 truncate text-sm font-medium text-foreground">{receipt.suppliers?.name || "Chưa có NCC"}</p>
                      <p className="text-xs text-muted-foreground">Chạm vào thẻ để xem chi tiết</p>
                    </div>
                    <div className="shrink-0">{getStatusBadge(receipt.status)}</div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-background/70 p-3 text-xs">
                    <div>
                      <p className="text-muted-foreground">Ngày nhận</p>
                      <p className="font-semibold">{formatReceiptDate(receipt.receipt_date)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Số lượng</p>
                      <p className="font-semibold">{receipt.total_quantity?.toLocaleString("vi-VN") || 0}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">PO</p>
                      <p className="truncate font-mono font-semibold">{receipt.purchase_orders?.po_number || "-"}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Công nợ</p>
                      <p className="truncate font-mono font-semibold">{receipt.payment_requests?.request_number || "-"}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {getPayableBadge(receipt)}
                    {receipt.status === "confirmed" && receipt.payable_status !== "generated" && (
                      <Button
                        type="button"
                        size="sm"
                        className="btn-gradient ml-auto h-8 text-xs"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleConfirmReceipt(receipt.id);
                        }}
                        disabled={confirmReceipt.isPending}
                      >
                        <CheckCircle className="mr-1 h-3.5 w-3.5" />
                        {getReceiptActionLabel(receipt)}
                      </Button>
                    )}
                    {receipt.status !== "received" && (
                      <AlertDialog open={deleteId === receipt.id} onOpenChange={(open) => !open && setDeleteId(null)}>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteId(receipt.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{isVi ? "Xóa phiếu nhập kho?" : "Delete goods receipt?"}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {isVi ? `Bạn có chắc chắn muốn xóa phiếu nhập kho ${receipt.receipt_number}? Hành động này không thể hoàn tác.` : `Are you sure you want to delete goods receipt ${receipt.receipt_number}? This action cannot be undone.`}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{isVi ? "Hủy" : "Cancel"}</AlertDialogCancel>
                            <AlertDialogAction onClick={handleDelete}>{isVi ? "Xóa" : "Delete"}</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {renderPaginationControls("mobile")}

        <Card className="hidden overflow-hidden border-border bg-card md:block">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{isVi ? "Mã phiếu" : "Receipt #"}</TableHead>
                    <TableHead>{isVi ? "Nhà cung cấp" : "Supplier"}</TableHead>
                    <TableHead>{isVi ? "Ngày nhận" : "Receipt date"}</TableHead>
                    <TableHead>{isVi ? "Số lượng" : "Quantity"}</TableHead>
                    <TableHead>{isVi ? "Trạng thái" : "Status"}</TableHead>
                    <TableHead>{isVi ? "PO / Công nợ" : "PO / Payable"}</TableHead>
                    <TableHead>{isVi ? "Thao tác" : "Actions"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center">
                        <div className="flex items-center justify-center gap-2 text-muted-foreground">
                          <Loader2 className="h-5 w-5 animate-spin" />
                          {isVi ? "Đang tải phiếu nhập kho..." : "Loading goods receipts..."}
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : error ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-destructive">
                        {isVi ? "Lỗi tải dữ liệu phiếu nhập kho. Vui lòng thử lại." : "Failed to load goods receipts. Please try again."}
                      </TableCell>
                    </TableRow>
                  ) : filteredReceipts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-8 text-center">
                        <Package className="mx-auto mb-2 h-12 w-12 text-muted-foreground" />
                        <p className="text-muted-foreground">{isVi ? "Chưa có phiếu nhập kho nào" : "No goods receipts yet"}</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    paginatedReceipts.map((receipt) => (
                      <TableRow
                        key={receipt.id}
                        role="button"
                        tabIndex={0}
                        data-bmq-goods-receipt-row-click-detail
                        className="cursor-pointer hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        onClick={() => handleViewDetails(receipt.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handleViewDetails(receipt.id);
                          }
                        }}
                      >
                        <TableCell className="font-mono font-medium">{receipt.receipt_number}</TableCell>
                        <TableCell>{receipt.suppliers?.name || "-"}</TableCell>
                        <TableCell>{formatReceiptDate(receipt.receipt_date)}</TableCell>
                        <TableCell>{receipt.total_quantity?.toLocaleString("vi-VN") || 0}</TableCell>
                        <TableCell>{getStatusBadge(receipt.status)}</TableCell>
                        <TableCell>
                          <div className="space-y-1 text-xs">
                            <div className="flex items-center gap-1 text-muted-foreground">
                              <Link2 className="h-3 w-3" />
                              <span>PO: {receipt.purchase_orders?.po_number || "-"}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              {getPayableBadge(receipt)}
                            </div>
                            {receipt.payment_requests?.request_number && (
                              <div className="font-mono text-muted-foreground">
                                {receipt.payment_requests.request_number}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
                            {receipt.status === "confirmed" && receipt.payable_status !== "generated" && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleConfirmReceipt(receipt.id)}
                                disabled={confirmReceipt.isPending}
                              >
                                <CheckCircle className="h-4 w-4 mr-1" />
                                {getReceiptActionLabel(receipt)}
                              </Button>
                            )}

                            {receipt.status !== "received" && (
                              <AlertDialog open={deleteId === receipt.id} onOpenChange={(open) => !open && setDeleteId(null)}>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setDeleteId(receipt.id)}
                                  >
                                    <Trash2 className="h-4 w-4 text-destructive" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>{isVi ? "Xóa phiếu nhập kho?" : "Delete goods receipt?"}</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {isVi ? `Bạn có chắc chắn muốn xóa phiếu nhập kho ${receipt.receipt_number}? Hành động này không thể hoàn tác.` : `Are you sure you want to delete goods receipt ${receipt.receipt_number}? This action cannot be undone.`}
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>{isVi ? "Hủy" : "Cancel"}</AlertDialogCancel>
                                    <AlertDialogAction onClick={handleDelete}>{isVi ? "Xóa" : "Delete"}</AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {renderPaginationControls("desktop")}

        <GoodsReceiptDetailsDialog
          receiptId={selectedReceiptId}
          open={detailsOpen}
          onOpenChange={(open) => {
            setDetailsOpen(open);
            if (!open) setSelectedReceiptId(null);
          }}
        />
      </div>
    </div>
  );
}
