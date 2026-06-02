import { useEffect, useState, useMemo, useCallback, type KeyboardEvent } from "react";
import { format } from "date-fns";
import { vi, enUS } from "date-fns/locale";
import {
  FileText,
  Search,
  Loader2,
  Trash2,
  Send,
  Package,
  Clock,
  CheckCircle,
  XCircle,
  Bell,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { AddPurchaseOrderDialog } from "@/components/dialogs/AddPurchaseOrderDialog";
import { PurchaseOrderDetailsDialog } from "@/components/dialogs/PurchaseOrderDetailsDialog";
import { usePurchaseOrders, useDeletePurchaseOrder, type PurchaseOrder } from "@/hooks/usePurchaseOrders";
import { useSuppliers } from "@/hooks/useSuppliers";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";

type StatusFilter = "all" | "draft" | "sent" | "in_transit" | "completed" | "cancelled";
type TimeFilterMode = "day" | "month" | "year";

const PAGE_SIZE = 20;

const getInitialPeriodValue = (mode: TimeFilterMode) => {
  const today = new Date();
  if (mode === "day") return format(today, "yyyy-MM-dd");
  if (mode === "year") return format(today, "yyyy");
  return format(today, "yyyy-MM");
};

const getPeriodRange = (mode: TimeFilterMode, value: string) => {
  const today = new Date();
  if (mode === "day") {
    const [year, month, day] = value.split("-").map(Number);
    const date = year && month && day ? new Date(year, month - 1, day) : today;
    return {
      start: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0),
      end: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999),
    };
  }

  if (mode === "year") {
    const year = Number(value) || today.getFullYear();
    return {
      start: new Date(year, 0, 1, 0, 0, 0, 0),
      end: new Date(year, 11, 31, 23, 59, 59, 999),
    };
  }

  const [year, month] = value.split("-").map(Number);
  const date = year && month ? new Date(year, month - 1, 1) : today;
  return {
    start: new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0),
    end: new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999),
  };
};

const formatCompactCurrency = (amount: number) => {
  if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} tỷ`;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} triệu`;
  return `${Math.round(amount).toLocaleString("vi-VN")} đ`;
};

const normalizeSearchText = (value: string | null | undefined) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .trim();

const normalizeSupplierKey = (value: string | null | undefined) =>
  normalizeSearchText(value).replace(/\s+/g, " ");

const capitalizeProductName = (value: string | null | undefined) => {
  const trimmedValue = String(value || "").trim();
  const [firstCharacter, ...remainingCharacters] = Array.from(trimmedValue);
  if (!firstCharacter) return "";
  return `${firstCharacter.toLocaleUpperCase("vi-VN")}${remainingCharacters.join("")}`;
};

export default function PurchaseOrders() {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [deleteOrderId, setDeleteOrderId] = useState<string | null>(null);
  const [timeFilterMode, setTimeFilterMode] = useState<TimeFilterMode>("month");
  const [selectedPeriodValue, setSelectedPeriodValue] = useState(() => getInitialPeriodValue("month"));
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);

  const { language, t } = useLanguage();
  const isVi = language === "vi";
  const locale = language === "vi" ? vi : enUS;
  
  const { data: orders, isLoading, error } = usePurchaseOrders();
  const { data: suppliers } = useSuppliers();
  const deletePO = useDeletePurchaseOrder();

  const supplierMap = useMemo(() => {
    return new Map((suppliers || []).map((s) => [s.id, s.name]));
  }, [suppliers]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const formatOptionalDate = (date: string | null | undefined) => {
    if (!date) return "—";
    const parsedDate = new Date(date);
    if (Number.isNaN(parsedDate.getTime())) return "—";
    return format(parsedDate, "dd/MM/yyyy", { locale });
  };

  const getStatusMeta = (status: string) => {
    switch (status) {
      case "draft":
        return { label: isVi ? "Chờ duyệt" : "Pending approval", accent: "#F59E0B", icon: Clock };
      case "sent":
        return { label: isVi ? "Đã duyệt" : "Approved", accent: "#0F766E", icon: Send };
      case "in_transit":
        return { label: isVi ? "Chờ nhận hàng" : "Awaiting receipt", accent: "#80d5cb", icon: Package };
      case "completed":
        return { label: isVi ? "Hoàn thành" : "Completed", accent: "#16A34A", icon: CheckCircle };
      case "cancelled":
        return { label: isVi ? "Đã hủy" : "Cancelled", accent: "#DC2626", icon: XCircle };
      default:
        return { label: status, accent: "#A99B8C", icon: FileText };
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" />{isVi ? "Nháp" : "Draft"}</Badge>;
      case "sent":
        return <Badge className="bg-blue-500 hover:bg-blue-600 gap-1"><Send className="h-3 w-3" />{isVi ? "Đã gửi" : "Sent"}</Badge>;
      case "in_transit":
        return <Badge className="bg-orange-500 hover:bg-orange-600 gap-1"><Package className="h-3 w-3" />{isVi ? "Đang vận chuyển" : "In transit"}</Badge>;
      case "completed":
        return <Badge className="bg-green-500 hover:bg-green-600 gap-1"><CheckCircle className="h-3 w-3" />{isVi ? "Hoàn thành" : "Completed"}</Badge>;
      case "cancelled":
        return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />{isVi ? "Đã hủy" : "Cancelled"}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getOrderProductNames = (order: PurchaseOrder) => {
    const names = (order.purchase_order_items || [])
      .map((item) => capitalizeProductName(item.product_name))
      .filter((name): name is string => Boolean(name));

    if (names.length === 0) return isVi ? "Chưa có sản phẩm" : "No products";

    const visibleNames = names.slice(0, 2).join(", ");
    const hiddenCount = names.length - 2;
    return hiddenCount > 0 ? `${visibleNames} +${hiddenCount}` : visibleNames;
  };

  const handleOrderRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, orderId: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedOrderId(orderId);
    }
  };

  const periodRange = useMemo(() => getPeriodRange(timeFilterMode, selectedPeriodValue), [timeFilterMode, selectedPeriodValue]);

  const periodLabel = useMemo(() => {
    if (timeFilterMode === "day") return format(periodRange.start, "dd/MM/yyyy", { locale });
    return `${format(periodRange.start, "dd/MM/yyyy", { locale })} - ${format(periodRange.end, "dd/MM/yyyy", { locale })}`;
  }, [locale, periodRange.end, periodRange.start, timeFilterMode]);

  const orderMatchesSelectedPeriod = useCallback((order: PurchaseOrder) => {
    if (!order.order_date) return false;
    const orderDate = new Date(order.order_date);
    if (Number.isNaN(orderDate.getTime())) return false;
    return orderDate >= periodRange.start && orderDate <= periodRange.end;
  }, [periodRange.end, periodRange.start]);

  const periodOrders = useMemo(() => {
    return (orders || []).filter((order) => orderMatchesSelectedPeriod(order));
  }, [orderMatchesSelectedPeriod, orders]);

  const stats = useMemo(() => {
    return {
      total: periodOrders.length,
      draft: periodOrders.filter((o) => o.status === "draft").length,
      sent: periodOrders.filter((o) => o.status === "sent").length,
      inTransit: periodOrders.filter((o) => o.status === "in_transit").length,
      completed: periodOrders.filter((o) => o.status === "completed").length,
      totalValue: periodOrders.filter((o) => o.status !== "cancelled").reduce((sum, o) => sum + (o.total_amount || 0), 0),
    };
  }, [periodOrders]);

  const supplierRanking = useMemo(() => {
    const ranking = new Map<string, { id: string; name: string; totalValue: number; poCount: number; ids: Set<string> }>();
    periodOrders
      .filter((order) => order.status !== "cancelled" && order.supplier_id)
      .forEach((order) => {
        const supplierId = order.supplier_id as string;
        const supplierName = order.suppliers?.name || supplierMap.get(supplierId) || (isVi ? "Không rõ NCC" : "Unknown supplier");
        const supplierKey = normalizeSupplierKey(supplierName);
        const current = ranking.get(supplierKey) || { id: supplierKey, name: supplierName, totalValue: 0, poCount: 0, ids: new Set<string>() };
        current.ids.add(supplierId);
        current.totalValue += order.total_amount || 0;
        current.poCount += 1;
        ranking.set(supplierKey, current);
      });
    return Array.from(ranking.values()).sort((a, b) => b.totalValue - a.totalValue);
  }, [isVi, periodOrders, supplierMap]);

  const selectedSupplierSummary = useMemo(() => {
    if (!selectedSupplierId) return null;
    return supplierRanking.find((supplier) => supplier.id === selectedSupplierId) || null;
  }, [selectedSupplierId, supplierRanking]);

  const selectedSupplierName = useMemo(() => {
    if (!selectedSupplierId) return "";
    return selectedSupplierSummary?.name || supplierMap.get(selectedSupplierId) || (isVi ? "Nhà cung cấp đã chọn" : "Selected supplier");
  }, [isVi, selectedSupplierId, selectedSupplierSummary?.name, supplierMap]);

  const filteredOrders = useMemo(() => {
    return periodOrders.filter((order) => {
      const normalizedSearch = normalizeSearchText(searchTerm);
      const productNames = (order.purchase_order_items || [])
        .map((item) => item.product_name || "")
        .join(" ");
      const searchableText = normalizeSearchText(`${order.po_number} ${order.suppliers?.name || ""} ${productNames}`);
      const matchesSearch = searchableText.includes(normalizedSearch);
      const matchesStatus = statusFilter === "all" || order.status === statusFilter;
      const matchesSupplier = !selectedSupplierId || (!!order.supplier_id && !!selectedSupplierSummary && selectedSupplierSummary.ids.has(order.supplier_id));
      return matchesSearch && matchesStatus && matchesSupplier;
    });
  }, [periodOrders, searchTerm, selectedSupplierId, selectedSupplierSummary, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / PAGE_SIZE));
  const currentPageSafe = Math.min(currentPage, totalPages);
  const pageStartIndex = (currentPageSafe - 1) * PAGE_SIZE;
  const paginatedOrders = filteredOrders.slice(pageStartIndex, pageStartIndex + PAGE_SIZE);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, selectedSupplierId, statusFilter, selectedPeriodValue, timeFilterMode]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const handleTimeFilterModeChange = (mode: TimeFilterMode) => {
    setTimeFilterMode(mode);
    setSelectedPeriodValue(getInitialPeriodValue(mode));
  };

  const handleDelete = async () => {
    if (!deleteOrderId) return;
    try {
      await deletePO.mutateAsync(deleteOrderId);
      toast.success(isVi ? "Đã xóa đơn đặt hàng" : "Purchase order deleted");
      setDeleteOrderId(null);
    } catch (error) {
      toast.error(isVi ? "Lỗi khi xóa đơn đặt hàng" : "Failed to delete purchase order");
    }
  };

  return (
    <div className="bg-slate-50 dark:bg-[#1d1813] -m-4 min-h-screen text-slate-950 dark:text-[#f3ece4] md:-m-6">
      <section className="min-h-screen bg-slate-50 pb-8 md:hidden" data-stitch-mobile-po-main>
        <header className="sticky top-0 z-40 flex items-center justify-between border-b border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
          <button type="button" aria-label="Menu" className="-ml-2 rounded-full p-2 text-amber-700 transition hover:bg-amber-50">
            <FileText className="h-5 w-5" />
          </button>
          <div className="text-center">
            <h1 className="text-xl font-bold text-slate-950">PO (Mua hàng)</h1>
            <p className="text-[10px] text-slate-500">Quản lý vận hành nhập hàng & công nợ NCC</p>
          </div>
          <button type="button" aria-label="Notifications" className="relative -mr-2 rounded-full p-2 text-amber-700 transition hover:bg-amber-50">
            <Bell className="h-5 w-5" />
            {stats.draft > 0 && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-red-500" />}
          </button>
        </header>

        <div className="sticky top-[57px] z-30 border-b border-slate-200 bg-white/95 px-4 pb-3 pt-4 backdrop-blur-sm">
          <div className="relative mb-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder={isVi ? "Tìm PO, nhà cung cấp, sản phẩm..." : "Search PO, supplier, product..."}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-11 rounded-xl border-slate-200 bg-slate-50 pl-10 text-sm placeholder:text-slate-400 focus:border-amber-500 focus:ring-amber-500"
            />

          </div>
          <p className="mb-3 px-1 text-right text-[10px] italic text-slate-400">Hỗ trợ tìm không dấu</p>
          <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {([
              ["all", isVi ? "Tất cả" : "All"],
              ["draft", isVi ? "Chờ duyệt" : "Pending"],
              ["sent", isVi ? "Đã duyệt" : "Approved"],
              ["in_transit", isVi ? "Chờ nhận hàng" : "Awaiting"],
              ["cancelled", isVi ? "Đã huỷ" : "Cancelled"],
            ] as Array<[StatusFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-medium transition ${statusFilter === value ? "bg-amber-600 text-white" : "border border-slate-200 bg-white text-slate-600"}`}
                onClick={() => setStatusFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-3 space-y-2 rounded-xl bg-slate-50 p-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-600">Kỳ xem</span>
              <span className="text-slate-500">{periodLabel}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex h-9 rounded-lg border border-slate-200 bg-white p-1">
                {([
                  ["day", isVi ? "Ngày" : "Day"],
                  ["month", isVi ? "Tháng" : "Month"],
                  ["year", isVi ? "Năm" : "Year"],
                ] as Array<[TimeFilterMode, string]>).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className={`rounded-md px-3 text-xs font-semibold transition ${timeFilterMode === mode ? "bg-amber-600 text-white shadow-sm" : "text-slate-500"}`}
                    onClick={() => handleTimeFilterModeChange(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Input
                type={timeFilterMode === "day" ? "date" : timeFilterMode === "month" ? "month" : "number"}
                min={timeFilterMode === "year" ? "2020" : undefined}
                max={timeFilterMode === "year" ? "2035" : undefined}
                value={selectedPeriodValue}
                onChange={(event) => setSelectedPeriodValue(event.target.value)}
                className="h-9 flex-1 border-slate-200 bg-white text-sm"
              />
            </div>
          </div>
        </div>

        <main className="px-4 py-4">
          <div className="mb-6 grid grid-cols-2 gap-3">
            {[
              { label: isVi ? "Chờ duyệt" : "Pending", value: stats.draft, icon: Clock, color: "#F59E0B", filter: "draft" as StatusFilter },
              { label: isVi ? "Tổng giá trị" : "Total value", value: formatCurrency(stats.totalValue), icon: FileText, color: "#334155", filter: "all" as StatusFilter },
              { label: isVi ? "Đã duyệt" : "Approved", value: stats.sent, icon: CheckCircle, color: "#0F766E", filter: "sent" as StatusFilter },
              { label: isVi ? "Cần nhận hàng" : "Need receipt", value: stats.inTransit, icon: Package, color: "#80d5cb", filter: "in_transit" as StatusFilter },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  type="button"
                  className={`flex h-[88px] flex-col justify-between rounded-xl border bg-white p-3 text-left shadow-sm transition ${statusFilter === item.filter ? "border-amber-500 ring-2 ring-amber-100" : "border-slate-200"}`}
                  onClick={() => setStatusFilter(item.filter)}
                >
                  <div className="flex items-start justify-between">
                    <span className="text-xs font-medium text-slate-500">{item.label}</span>
                    <Icon className="h-4 w-4" style={{ color: item.color }} />
                  </div>
                  <span className="truncate text-2xl font-bold text-slate-950">{item.value}</span>
                </button>
              );
            })}
          </div>

          <div className="mb-3 flex items-end justify-between">
            <h2 className="text-sm font-semibold text-slate-950">Danh sách PO</h2>
            <span className="flex items-center gap-1 text-xs font-medium text-amber-700"><SlidersHorizontal className="h-3.5 w-3.5" />Lọc thêm</span>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-amber-600" /></div>
          ) : error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 py-10 text-center text-sm text-red-700">{isVi ? "Lỗi tải dữ liệu PO" : "Failed to load data"}</div>
          ) : filteredOrders.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white py-12 text-center text-slate-500"><Package className="mx-auto mb-4 h-12 w-12 opacity-50" /><p>{isVi ? "Không có PO trong kỳ/bộ lọc này" : "No purchase orders in this period/filter"}</p></div>
          ) : (
            <div className="flex flex-col gap-3">
              {paginatedOrders.map((order) => {
                const meta = getStatusMeta(order.status);
                return (
                  <button
                    key={order.id}
                    type="button"
                    className={`relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm transition active:scale-[0.99] ${order.status === "cancelled" ? "opacity-70" : ""}`}
                    onClick={() => setSelectedOrderId(order.id)}
                    data-stitch-mobile-po-card
                  >
                    <span className="absolute bottom-0 left-0 top-0 w-1" style={{ backgroundColor: meta.accent }} />
                    <div className="pl-2">
                      <div className="mb-1.5 flex items-center justify-between gap-3">
                        <span className={`text-sm font-semibold ${order.status === "cancelled" ? "text-slate-400 line-through" : "text-slate-950"}`}>{order.po_number}</span>
                        <span className="rounded border px-2 py-0.5 text-[10px] font-medium" style={{ borderColor: `${meta.accent}33`, color: meta.accent, backgroundColor: `${meta.accent}1A` }}>{meta.label}</span>
                      </div>
                      <div className="mb-1 truncate text-xs font-medium text-slate-700">{order.suppliers?.name || (order.supplier_id ? supplierMap.get(order.supplier_id) : undefined) || "N/A"}</div>
                      <div className="mb-2 truncate text-[11px] text-slate-500">{getOrderProductNames(order)}</div>
                      <div className="flex items-end justify-between border-t border-slate-100 pt-2">
                        <span className="text-[10px] text-slate-500">{format(new Date(order.order_date), "dd/MM/yyyy", { locale })}</span>
                        <span className={`text-sm font-bold ${order.status === "cancelled" ? "text-slate-400 line-through" : "text-amber-700"}`}>{formatCurrency(order.total_amount || 0)}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {!isLoading && !error && filteredOrders.length > 0 && (
            <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 shadow-sm">
              <span>{pageStartIndex + 1}-{Math.min(pageStartIndex + paginatedOrders.length, filteredOrders.length)} / {filteredOrders.length}</span>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" className="h-8 border-slate-200 bg-white text-xs" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPageSafe <= 1}>{isVi ? "Trước" : "Prev"}</Button>
                <span>{currentPageSafe}/{totalPages}</span>
                <Button type="button" variant="outline" size="sm" className="h-8 border-slate-200 bg-white text-xs" onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} disabled={currentPageSafe >= totalPages}>{isVi ? "Sau" : "Next"}</Button>
              </div>
            </div>
          )}
        </main>

        <div className="fixed bottom-4 right-4 z-40">
          <AddPurchaseOrderDialog>
            <Button className="rounded-2xl bg-amber-600 px-4 py-6 text-sm font-semibold text-white shadow-lg hover:bg-amber-700">
              <Plus className="mr-2 h-4 w-4" />Tạo PO
            </Button>
          </AddPurchaseOrderDialog>
        </div>
      </section>

      <div className="hidden space-y-4 p-4 md:block md:p-6">
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-[#443b30] dark:bg-[#241f18]/90 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-slate-950 dark:text-[#f3ece4]">
            <FileText className="h-6 w-6 text-amber-600" />
            {t.poPurchasing}
          </h1>
          <p className="text-sm text-slate-500 dark:text-[#a99b8c]">{isVi ? "Quản lý vận hành nhập hàng & công nợ nhà cung cấp" : "Manage supplier purchasing operations and payables"}</p>
        </div>
        <AddPurchaseOrderDialog />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Card className={`cursor-pointer border-slate-200 bg-white dark:border-[#443b30] dark:bg-[#241f18]/90 ${statusFilter === "all" ? "ring-2 ring-amber-500" : ""}`} onClick={() => setStatusFilter("all")}>
              <CardHeader className="px-3 py-2"><CardTitle className="text-xs font-medium text-slate-500 dark:text-[#a99b8c]">{isVi ? "Tổng đơn" : "Total orders"}</CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 pt-0"><p className="text-xl font-semibold text-slate-950 dark:text-[#f3ece4]">{stats.total}</p></CardContent>
            </Card>
            <Card className={`cursor-pointer border-slate-200 bg-white dark:border-[#443b30] dark:bg-[#241f18]/90 ${statusFilter === "draft" ? "ring-2 ring-amber-500" : ""}`} onClick={() => setStatusFilter("draft")}>
              <CardHeader className="px-3 py-2"><CardTitle className="text-xs font-medium text-slate-500 dark:text-[#a99b8c]">{isVi ? "Nháp" : "Draft"}</CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 pt-0"><p className="text-xl font-semibold text-slate-950 dark:text-[#f3ece4]">{stats.draft}</p></CardContent>
            </Card>
            <Card className={`cursor-pointer border-slate-200 bg-white dark:border-[#443b30] dark:bg-[#241f18]/90 ${statusFilter === "sent" ? "ring-2 ring-amber-500" : ""}`} onClick={() => setStatusFilter("sent")}>
              <CardHeader className="px-3 py-2"><CardTitle className="text-xs font-medium text-blue-600 dark:text-[#f0ad4e]">{isVi ? "Đã gửi" : "Sent"}</CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 pt-0"><p className="text-xl font-semibold text-blue-600 dark:text-[#f0ad4e]">{stats.sent}</p></CardContent>
            </Card>
            <Card className={`cursor-pointer border-slate-200 bg-white dark:border-[#443b30] dark:bg-[#241f18]/90 ${statusFilter === "in_transit" ? "ring-2 ring-amber-500" : ""}`} onClick={() => setStatusFilter("in_transit")}>
              <CardHeader className="px-3 py-2"><CardTitle className="text-xs font-medium text-amber-600 dark:text-[#f0ad4e]">{isVi ? "Đang giao" : "In transit"}</CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 pt-0"><p className="text-xl font-semibold text-amber-600 dark:text-[#f0ad4e]">{stats.inTransit}</p></CardContent>
            </Card>
            <Card className="border-slate-200 bg-white dark:border-[#443b30] dark:bg-[#241f18]/90">
              <CardHeader className="px-3 py-2"><CardTitle className="text-xs font-medium text-slate-500 dark:text-[#a99b8c]">{isVi ? "Tổng giá trị" : "Total value"}</CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 pt-0"><p className="truncate text-sm font-semibold text-slate-950 dark:text-[#f3ece4]">{formatCurrency(stats.totalValue)}</p></CardContent>
            </Card>
          </div>

          <Card className="border-slate-200 bg-white dark:border-[#443b30] dark:bg-[#241f18]/90">
            <CardContent className="space-y-3 p-3">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    placeholder={isVi ? "Tìm theo số PO, nhà cung cấp, sản phẩm... hỗ trợ không dấu" : "Search PO, supplier, product... diacritics optional"}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="h-9 border-slate-200 bg-slate-50 pl-10 text-sm dark:border-[#443b30] dark:bg-[#1d1813] dark:text-[#f3ece4]"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="sr-only">Ngày / Tháng / Năm</span>
                  <div className="inline-flex h-9 rounded-lg border border-slate-200 bg-slate-50 p-1 dark:border-[#443b30] dark:bg-[#1d1813]">
                    {([
                      ["day", isVi ? "Ngày" : "Day"],
                      ["month", isVi ? "Tháng" : "Month"],
                      ["year", isVi ? "Năm" : "Year"],
                    ] as Array<[TimeFilterMode, string]>).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        className={`rounded-md px-3 text-xs font-semibold transition ${timeFilterMode === mode ? "bg-[#D97706] text-white shadow-sm" : "text-slate-500 hover:text-slate-900 dark:text-[#a99b8c] dark:hover:text-[#f3ece4]"}`}
                        onClick={() => handleTimeFilterModeChange(mode)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <Input
                    type={timeFilterMode === "day" ? "date" : timeFilterMode === "month" ? "month" : "number"}
                    min={timeFilterMode === "year" ? "2020" : undefined}
                    max={timeFilterMode === "year" ? "2035" : undefined}
                    value={selectedPeriodValue}
                    onChange={(event) => setSelectedPeriodValue(event.target.value)}
                    className="h-9 w-36 border-slate-200 bg-white text-sm dark:border-[#443b30] dark:bg-[#1d1813] dark:text-[#f3ece4]"
                  />
                  <span className="whitespace-nowrap rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600 dark:bg-[#1d1813] dark:text-[#d6c8b8]">{periodLabel}</span>
                </div>
                <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
                  <SelectTrigger className="h-9 w-full border-slate-200 bg-white text-sm dark:border-[#443b30] dark:bg-[#1d1813] md:w-44"><SelectValue placeholder={isVi ? "Trạng thái" : "Status"} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{isVi ? "Tất cả" : "All"}</SelectItem>
                    <SelectItem value="draft">{isVi ? "Nháp" : "Draft"}</SelectItem>
                    <SelectItem value="sent">{isVi ? "Đã gửi" : "Sent"}</SelectItem>
                    <SelectItem value="in_transit">{isVi ? "Đang vận chuyển" : "In transit"}</SelectItem>
                    <SelectItem value="completed">{isVi ? "Hoàn thành" : "Completed"}</SelectItem>
                    <SelectItem value="cancelled">{isVi ? "Đã hủy" : "Cancelled"}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {selectedSupplierId && (
                <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-[#3a2612]/80 dark:text-[#ffd08a] sm:flex-row sm:items-center sm:justify-between">
                  <span className="font-medium">Đang xem: {selectedSupplierName} · {selectedSupplierSummary?.poCount || 0} PO · {formatCurrency(selectedSupplierSummary?.totalValue || 0)}</span>
                  <Button type="button" variant="ghost" size="sm" className="h-8 justify-start text-amber-800 hover:bg-amber-100 dark:text-[#ffd08a] dark:hover:bg-[#4a321a]" onClick={() => setSelectedSupplierId(null)}>
                    Xóa lọc NCC
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-slate-200 bg-white dark:border-[#443b30] dark:bg-[#241f18]/90">
            <CardHeader className="border-b border-slate-200 px-4 py-3 dark:border-[#443b30]">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-base font-semibold text-slate-950 dark:text-[#f3ece4]">
                    {selectedSupplierId ? `PO của ${selectedSupplierName}` : isVi ? "Danh sách PO" : "Purchase order list"}
                  </CardTitle>
                  <p className="text-xs text-slate-500 dark:text-[#a99b8c]">{periodLabel} · {filteredOrders.length} PO</p>
                </div>
                {selectedSupplierId && (
                  <Button type="button" variant="outline" size="sm" className="h-8 border-slate-200 bg-white text-xs dark:border-[#443b30] dark:bg-[#1d1813]" onClick={() => setSelectedSupplierId(null)}>
                    Xóa lọc NCC
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin" /></div>
              ) : error ? (
                <div className="py-12 text-center text-destructive">{isVi ? "Lỗi tải dữ liệu" : "Failed to load data"}</div>
              ) : filteredOrders.length === 0 ? (
                <div className="py-12 text-center text-slate-500 dark:text-[#a99b8c]"><Package className="mx-auto mb-4 h-12 w-12 opacity-50" /><p>{isVi ? "Không có PO trong kỳ đã chọn" : "No purchase orders in the selected period"}</p></div>
              ) : (
                <Table>
                  <TableHeader className="bg-slate-100 dark:bg-[#2b241c]">
                    <TableRow className="border-slate-200 dark:border-[#443b30] hover:bg-transparent">
                      <TableHead className="h-9 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-[#a99b8c]">{isVi ? "Số PO" : "PO #"}</TableHead>
                      <TableHead className="h-9 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-[#a99b8c]">{isVi ? "Nhà cung cấp" : "Supplier"}</TableHead>
                      <TableHead className="h-9 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-[#a99b8c]">{isVi ? "Sản phẩm" : "Products"}</TableHead>
                      <TableHead className="h-9 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-[#a99b8c]">{isVi ? "Ngày đặt" : "Order date"}</TableHead>
                      <TableHead className="h-9 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-[#a99b8c]">{isVi ? "Ngày dự kiến" : "Expected"}</TableHead>
                      <TableHead className="h-9 text-right text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-[#a99b8c]">{isVi ? "Tổng tiền" : "Total"}</TableHead>
                      <TableHead className="h-9 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-[#a99b8c]">{isVi ? "Trạng thái" : "Status"}</TableHead>
                      <TableHead className="h-9 w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedOrders.map((order) => (
                      <TableRow
                        key={order.id}
                        role="button"
                        tabIndex={0}
                        className="h-[52px] cursor-pointer border-slate-200 text-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-[#443b30] dark:hover:bg-[#342b22]/70"
                        onClick={() => setSelectedOrderId(order.id)}
                        onKeyDown={(event) => handleOrderRowKeyDown(event, order.id)}
                      >
                        <TableCell className="py-2 font-semibold text-slate-950 dark:text-[#f3ece4]">{order.po_number}</TableCell>
                        <TableCell className="max-w-[180px] py-2 text-slate-700 dark:text-[#e8ded2]">{order.suppliers?.name || (order.supplier_id ? supplierMap.get(order.supplier_id) : undefined) || (isVi ? "N/A" : "N/A")}</TableCell>
                        <TableCell className="max-w-[260px] truncate py-2 text-slate-500 dark:text-[#a99b8c]" title={getOrderProductNames(order)}>{getOrderProductNames(order)}</TableCell>
                        <TableCell className="whitespace-nowrap py-2 text-slate-600 dark:text-[#d6c8b8]">{format(new Date(order.order_date), "dd/MM/yyyy", { locale })}</TableCell>
                        <TableCell className="whitespace-nowrap py-2 text-slate-600 dark:text-[#d6c8b8]">{formatOptionalDate(order.expected_date)}</TableCell>
                        <TableCell className="whitespace-nowrap py-2 text-right font-semibold text-slate-950 dark:text-[#f3ece4]">{formatCurrency(order.total_amount || 0)}</TableCell>
                        <TableCell className="py-2">{getStatusBadge(order.status)}</TableCell>
                        <TableCell className="py-2">
                          <div className="flex items-center justify-end gap-1">
                            {order.status === "draft" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={isVi ? "Xóa PO" : "Delete PO"}
                                className="h-8 w-8 text-slate-500 hover:text-destructive dark:text-[#a99b8c]"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setDeleteOrderId(order.id);
                                }}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {!isLoading && !error && filteredOrders.length > 0 && (
                <div className="flex flex-col gap-2 border-t border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-[#443b30] dark:bg-[#241f18] dark:text-[#a99b8c] sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    {isVi ? "Hiển thị" : "Showing"} {pageStartIndex + 1}-{Math.min(pageStartIndex + paginatedOrders.length, filteredOrders.length)} / {filteredOrders.length} · {PAGE_SIZE} {isVi ? "dòng/trang" : "rows/page"}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="outline" size="sm" className="h-8 border-slate-200 bg-white text-xs dark:border-[#443b30] dark:bg-[#1d1813]" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPageSafe <= 1}>
                      {isVi ? "Trang trước" : "Previous"}
                    </Button>
                    <span className="min-w-[88px] text-center font-medium text-slate-600 dark:text-[#d6c8b8]">
                      {isVi ? "Trang" : "Page"} {currentPageSafe} / {totalPages}
                    </span>
                    <Button type="button" variant="outline" size="sm" className="h-8 border-slate-200 bg-white text-xs dark:border-[#443b30] dark:bg-[#1d1813]" onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} disabled={currentPageSafe >= totalPages}>
                      {isVi ? "Trang sau" : "Next"}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit border-slate-200 bg-white dark:border-[#443b30] dark:bg-[#241f18]/90" data-stitch-desktop-supplier-ranking>
          <CardHeader className="space-y-3 px-4 py-3">
            <div>
              <CardTitle className="text-sm font-semibold text-slate-950 dark:text-[#f3ece4]">Xếp hạng NCC theo giá trị PO</CardTitle>
              <p className="mt-1 text-xs text-slate-500 dark:text-[#a99b8c]">{periodLabel}</p>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4 pt-0">
            {selectedSupplierId && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-[#3a2612]/80">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-[#ffd08a]">Đang xem:</p>
                <p className="mt-1 text-sm font-semibold text-slate-950 dark:text-[#f3ece4]">{selectedSupplierName}</p>
                <p className="mt-1 text-xs text-slate-600 dark:text-[#d6c8b8]">{selectedSupplierSummary?.poCount || 0} PO · {formatCurrency(selectedSupplierSummary?.totalValue || 0)}</p>
                <Button type="button" variant="ghost" size="sm" className="mt-2 h-8 px-0 text-xs text-amber-800 hover:bg-transparent hover:text-amber-900 dark:text-[#ffd08a]" onClick={() => setSelectedSupplierId(null)}>
                  Xóa lọc NCC
                </Button>
              </div>
            )}

            {supplierRanking.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500 dark:border-[#443b30] dark:text-[#a99b8c]">Không có PO trong kỳ đã chọn</div>
            ) : (
              <div className="space-y-2">
                {supplierRanking.slice(0, 8).map((supplier, index) => {
                  const share = stats.totalValue > 0 ? Math.round((supplier.totalValue / stats.totalValue) * 100) : 0;
                  const isSelected = supplier.id === selectedSupplierId;
                  return (
                    <button
                      key={supplier.id}
                      type="button"
                      className={`w-full rounded-xl border p-3 text-left transition ${isSelected ? "border-[#D97706] bg-amber-50 shadow-sm dark:border-[#D97706] dark:bg-[#3a2612]/80" : "border-slate-200 bg-slate-50 hover:border-amber-300 hover:bg-white dark:border-[#443b30] dark:bg-[#1d1813] dark:hover:bg-[#342b22]/70"}`}
                      onClick={() => setSelectedSupplierId(isSelected ? null : supplier.id)}
                    >
                      <div className="flex items-start gap-2">
                        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${isSelected ? "bg-[#D97706] text-white" : "bg-white text-slate-600 dark:bg-[#2b241c] dark:text-[#d6c8b8]"}`}>{index + 1}</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-slate-950 dark:text-[#f3ece4]">{supplier.name}</div>
                          <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-[#a99b8c]">
                            <span>{supplier.poCount} PO</span>
                            <span className="font-semibold text-slate-700 dark:text-[#e8ded2]">{formatCompactCurrency(supplier.totalValue)}</span>
                          </div>
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-[#443b30]">
                            <div className="h-full rounded-full bg-[#D97706]" style={{ width: `${Math.min(100, share)}%` }} />
                          </div>
                          <div className="mt-1 text-right text-[11px] font-medium text-slate-500 dark:text-[#a99b8c]">{share}% tỷ trọng</div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      </div>

      <PurchaseOrderDetailsDialog orderId={selectedOrderId} open={!!selectedOrderId} onOpenChange={(open) => !open && setSelectedOrderId(null)} />

      <AlertDialog open={!!deleteOrderId} onOpenChange={() => setDeleteOrderId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isVi ? "Xác nhận xóa" : "Confirm deletion"}</AlertDialogTitle>
            <AlertDialogDescription>{isVi ? "Bạn có chắc muốn xóa đơn đặt hàng này?" : "Are you sure you want to delete this purchase order?"}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isVi ? "Hủy" : "Cancel"}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deletePO.isPending} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deletePO.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}{isVi ? "Xóa" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
