import { useState, useMemo, type KeyboardEvent } from "react";
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

const normalizeSearchText = (value: string | null | undefined) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .trim();

export default function PurchaseOrders() {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [deleteOrderId, setDeleteOrderId] = useState<string | null>(null);

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
      .map((item) => item.product_name?.trim())
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

  const stats = useMemo(() => {
    if (!orders) return { total: 0, draft: 0, sent: 0, inTransit: 0, completed: 0, totalValue: 0 };
    return {
      total: orders.length,
      draft: orders.filter((o) => o.status === "draft").length,
      sent: orders.filter((o) => o.status === "sent").length,
      inTransit: orders.filter((o) => o.status === "in_transit").length,
      completed: orders.filter((o) => o.status === "completed").length,
      totalValue: orders.filter((o) => o.status !== "cancelled").reduce((sum, o) => sum + (o.total_amount || 0), 0),
    };
  }, [orders]);

  const filteredOrders = useMemo(() => {
    if (!orders) return [];
    return orders.filter((order) => {
      const normalizedSearch = normalizeSearchText(searchTerm);
      const productNames = (order.purchase_order_items || [])
        .map((item) => item.product_name || "")
        .join(" ");
      const searchableText = normalizeSearchText(`${order.po_number} ${order.suppliers?.name || ""} ${productNames}`);
      const matchesSearch = searchableText.includes(normalizedSearch);
      const matchesStatus = statusFilter === "all" || order.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [orders, searchTerm, statusFilter]);

  const actionOrders = useMemo(() => {
    return (orders || [])
      .filter((order) => order.status === "draft" || order.status === "sent" || order.status === "in_transit")
      .slice(0, 5);
  }, [orders]);

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
    <div className="bg-slate-50 dark:bg-slate-950 -m-4 space-y-4 p-4 text-slate-950 dark:text-slate-100 md:-m-6 md:p-6">
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900/80 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-100">
            <FileText className="h-6 w-6 text-amber-600" />
            {t.poPurchasing}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{isVi ? "Quản lý vận hành nhập hàng & công nợ nhà cung cấp" : "Manage supplier purchasing operations and payables"}</p>
        </div>
        <AddPurchaseOrderDialog />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Card className={`cursor-pointer border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/80 ${statusFilter === "all" ? "ring-2 ring-amber-500" : ""}`} onClick={() => setStatusFilter("all")}>
              <CardHeader className="px-3 py-2"><CardTitle className="text-xs font-medium text-slate-500 dark:text-slate-400">{isVi ? "Tổng đơn" : "Total orders"}</CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 pt-0"><p className="text-xl font-semibold text-slate-950 dark:text-slate-100">{stats.total}</p></CardContent>
            </Card>
            <Card className={`cursor-pointer border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/80 ${statusFilter === "draft" ? "ring-2 ring-amber-500" : ""}`} onClick={() => setStatusFilter("draft")}>
              <CardHeader className="px-3 py-2"><CardTitle className="text-xs font-medium text-slate-500 dark:text-slate-400">{isVi ? "Nháp" : "Draft"}</CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 pt-0"><p className="text-xl font-semibold text-slate-950 dark:text-slate-100">{stats.draft}</p></CardContent>
            </Card>
            <Card className={`cursor-pointer border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/80 ${statusFilter === "sent" ? "ring-2 ring-amber-500" : ""}`} onClick={() => setStatusFilter("sent")}>
              <CardHeader className="px-3 py-2"><CardTitle className="text-xs font-medium text-blue-600 dark:text-blue-300">{isVi ? "Đã gửi" : "Sent"}</CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 pt-0"><p className="text-xl font-semibold text-blue-600 dark:text-blue-300">{stats.sent}</p></CardContent>
            </Card>
            <Card className={`cursor-pointer border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/80 ${statusFilter === "in_transit" ? "ring-2 ring-amber-500" : ""}`} onClick={() => setStatusFilter("in_transit")}>
              <CardHeader className="px-3 py-2"><CardTitle className="text-xs font-medium text-amber-600 dark:text-amber-300">{isVi ? "Đang giao" : "In transit"}</CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 pt-0"><p className="text-xl font-semibold text-amber-600 dark:text-amber-300">{stats.inTransit}</p></CardContent>
            </Card>
            <Card className="border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/80">
              <CardHeader className="px-3 py-2"><CardTitle className="text-xs font-medium text-slate-500 dark:text-slate-400">{isVi ? "Tổng giá trị" : "Total value"}</CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 pt-0"><p className="truncate text-sm font-semibold text-slate-950 dark:text-slate-100">{formatCurrency(stats.totalValue)}</p></CardContent>
            </Card>
          </div>

          <Card className="border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/80">
            <CardContent className="flex flex-col gap-3 p-3 md:flex-row md:items-center">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  placeholder={isVi ? "Tìm theo số PO, nhà cung cấp, sản phẩm... hỗ trợ không dấu" : "Search PO, supplier, product... diacritics optional"}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="h-9 border-slate-200 bg-slate-50 pl-10 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
                <SelectTrigger className="h-9 w-full border-slate-200 bg-white text-sm dark:border-slate-700 dark:bg-slate-950 md:w-44"><SelectValue placeholder={isVi ? "Trạng thái" : "Status"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{isVi ? "Tất cả" : "All"}</SelectItem>
                  <SelectItem value="draft">{isVi ? "Nháp" : "Draft"}</SelectItem>
                  <SelectItem value="sent">{isVi ? "Đã gửi" : "Sent"}</SelectItem>
                  <SelectItem value="in_transit">{isVi ? "Đang vận chuyển" : "In transit"}</SelectItem>
                  <SelectItem value="completed">{isVi ? "Hoàn thành" : "Completed"}</SelectItem>
                  <SelectItem value="cancelled">{isVi ? "Đã hủy" : "Cancelled"}</SelectItem>
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/80">
            <CardContent className="p-0">
              {isLoading ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin" /></div>
              ) : error ? (
                <div className="py-12 text-center text-destructive">{isVi ? "Lỗi tải dữ liệu" : "Failed to load data"}</div>
              ) : filteredOrders.length === 0 ? (
                <div className="py-12 text-center text-slate-500 dark:text-slate-400"><Package className="mx-auto mb-4 h-12 w-12 opacity-50" /><p>{isVi ? "Chưa có đơn đặt hàng nào" : "No purchase orders yet"}</p></div>
              ) : (
                <Table>
                  <TableHeader className="bg-slate-100 dark:bg-slate-800">
                    <TableRow className="border-slate-200 dark:border-slate-700 hover:bg-transparent">
                      <TableHead className="h-9 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{isVi ? "Số PO" : "PO #"}</TableHead>
                      <TableHead className="h-9 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{isVi ? "Nhà cung cấp" : "Supplier"}</TableHead>
                      <TableHead className="h-9 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{isVi ? "Sản phẩm" : "Products"}</TableHead>
                      <TableHead className="h-9 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{isVi ? "Ngày đặt" : "Order date"}</TableHead>
                      <TableHead className="h-9 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{isVi ? "Ngày dự kiến" : "Expected"}</TableHead>
                      <TableHead className="h-9 text-right text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{isVi ? "Tổng tiền" : "Total"}</TableHead>
                      <TableHead className="h-9 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{isVi ? "Trạng thái" : "Status"}</TableHead>
                      <TableHead className="h-9 w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredOrders.map((order) => (
                      <TableRow
                        key={order.id}
                        role="button"
                        tabIndex={0}
                        className="h-[52px] cursor-pointer border-slate-200 text-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-slate-700 dark:hover:bg-slate-800/60"
                        onClick={() => setSelectedOrderId(order.id)}
                        onKeyDown={(event) => handleOrderRowKeyDown(event, order.id)}
                      >
                        <TableCell className="py-2 font-semibold text-slate-950 dark:text-slate-100">{order.po_number}</TableCell>
                        <TableCell className="max-w-[180px] py-2 text-slate-700 dark:text-slate-200">{order.suppliers?.name || (order.supplier_id ? supplierMap.get(order.supplier_id) : undefined) || (isVi ? "N/A" : "N/A")}</TableCell>
                        <TableCell className="max-w-[260px] truncate py-2 text-slate-500 dark:text-slate-400" title={getOrderProductNames(order)}>{getOrderProductNames(order)}</TableCell>
                        <TableCell className="whitespace-nowrap py-2 text-slate-600 dark:text-slate-300">{format(new Date(order.order_date), "dd/MM/yyyy", { locale })}</TableCell>
                        <TableCell className="whitespace-nowrap py-2 text-slate-600 dark:text-slate-300">{formatOptionalDate(order.expected_date)}</TableCell>
                        <TableCell className="whitespace-nowrap py-2 text-right font-semibold text-slate-950 dark:text-slate-100">{formatCurrency(order.total_amount || 0)}</TableCell>
                        <TableCell className="py-2">{getStatusBadge(order.status)}</TableCell>
                        <TableCell className="py-2">
                          <div className="flex items-center justify-end gap-1">
                            {order.status === "draft" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={isVi ? "Xóa PO" : "Delete PO"}
                                className="h-8 w-8 text-slate-500 hover:text-destructive dark:text-slate-400"
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
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/80">
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-sm font-semibold text-slate-950 dark:text-slate-100">{isVi ? "Cần xử lý" : "Needs action"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4 pt-0">
            <button
              type="button"
              className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${statusFilter === "draft" ? "border-amber-500 bg-amber-50 text-amber-800 dark:border-amber-500 dark:bg-amber-950/30 dark:text-amber-200" : "border-slate-200 bg-slate-50 text-slate-700 hover:border-amber-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"}`}
              onClick={() => setStatusFilter("draft")}
            >
              <div className="flex items-center justify-between"><span>{isVi ? "PO nháp" : "Draft POs"}</span><strong>{stats.draft}</strong></div>
            </button>
            <button
              type="button"
              className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${statusFilter === "in_transit" ? "border-amber-500 bg-amber-50 text-amber-800 dark:border-amber-500 dark:bg-amber-950/30 dark:text-amber-200" : "border-slate-200 bg-slate-50 text-slate-700 hover:border-amber-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"}`}
              onClick={() => setStatusFilter("in_transit")}
            >
              <div className="flex items-center justify-between"><span>{isVi ? "Đang vận chuyển" : "In transit"}</span><strong>{stats.inTransit}</strong></div>
            </button>
            <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
              {actionOrders.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">{isVi ? "Không có PO cần xử lý" : "No purchase orders need action"}</p>
              ) : (
                actionOrders.map((order) => (
                  <button
                    key={order.id}
                    type="button"
                    className="w-full rounded-md p-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
                    onClick={() => setSelectedOrderId(order.id)}
                  >
                    <div className="truncate text-sm font-semibold text-slate-950 dark:text-slate-100">{order.po_number}</div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">{order.suppliers?.name || getOrderProductNames(order)}</div>
                  </button>
                ))
              )}
            </div>
          </CardContent>
        </Card>
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
