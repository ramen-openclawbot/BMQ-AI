import { useMemo, useState, useEffect, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { addDays, differenceInCalendarDays, format, isThisMonth } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  CreditCard,
  FileText,
  Filter,
  Image,
  Link2,
  Pencil,
  ReceiptText,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  TrendingUp,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { useInvoices, useDeleteInvoice, type Invoice } from "@/hooks/useInvoices";
import { AddInvoiceDialog } from "@/components/dialogs/AddInvoiceDialog";
import { EditInvoiceDialog } from "@/components/dialogs/EditInvoiceDialog";
import { InvoiceDetailsDialog } from "@/components/dialogs/InvoiceDetailsDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { resolveImageUrl } from "@/lib/storage-url";
import { toast } from "sonner";

const PAGE_SIZE = 20;
const PAYMENT_TERM_DAYS = 15;

type InvoicePaymentStatus = "paid" | "waiting" | "overdue";
type InvoiceSource = "warehouse_receipt" | "purchase_order" | "ocr_scan" | "manual";
type StatusFilter = InvoicePaymentStatus | "all";
type SourceFilter = InvoiceSource | "all";
type MonthFilter = "this_month" | "all";

const normalizeSearchText = (value: string) =>
  value
    .toLocaleLowerCase("vi-VN")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");

const toNumber = (value: number | null | undefined) => Number(value || 0);

const formatCurrency = (amount: number) => {
  if (Math.abs(amount) >= 1_000_000_000) return `${(amount / 1_000_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} tỷ`;
  if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} triệu`;
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(amount);
};

const formatFullCurrency = (amount: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(amount);

const getInvoiceSource = (invoice: Invoice): InvoiceSource => {
  if (invoice.goods_receipt_id) return "warehouse_receipt";
  if (invoice.purchase_order_id) return "purchase_order";
  if (invoice.image_url) return "ocr_scan";
  return "manual";
};

const getSourceLabel = (source: InvoiceSource, isVi: boolean) => {
  const labels: Record<InvoiceSource, string> = {
    warehouse_receipt: isVi ? "Từ phiếu nhập kho" : "From receipt",
    purchase_order: isVi ? "Từ PO" : "From PO",
    ocr_scan: "OCR/scan",
    manual: isVi ? "Thủ công" : "Manual",
  };
  return labels[source];
};

const getSourceMeta = (invoice: Invoice) => {
  const source = getInvoiceSource(invoice);
  const reference =
    source === "warehouse_receipt"
      ? invoice.goods_receipts?.receipt_number || invoice.goods_receipt_id
      : source === "purchase_order"
        ? invoice.purchase_orders?.po_number || invoice.purchase_order_id
        : source === "ocr_scan"
          ? invoice.image_url
          : null;
  return { source, reference };
};

const getInvoiceDueDate = (invoice: Invoice) => addDays(new Date(invoice.invoice_date), PAYMENT_TERM_DAYS);

const getInvoiceStatus = (invoice: Invoice, today = new Date()): InvoicePaymentStatus => {
  if (invoice.payment_slip_url) return "paid";
  return differenceInCalendarDays(getInvoiceDueDate(invoice), today) < 0 ? "overdue" : "waiting";
};

const getStatusLabel = (status: InvoicePaymentStatus, isVi: boolean) => {
  const labels: Record<InvoicePaymentStatus, string> = {
    paid: isVi ? "Đã thanh toán" : "Paid",
    waiting: isVi ? "Chờ thanh toán" : "Pending",
    overdue: isVi ? "Quá hạn" : "Overdue",
  };
  return labels[status];
};

const getStatusClassName = (status: InvoicePaymentStatus) => {
  if (status === "paid") return "border-success/20 bg-success/10 text-success";
  if (status === "overdue") return "border-destructive/20 bg-destructive/10 text-destructive";
  return "border-warning/30 bg-warning/10 text-warning-foreground";
};

const Invoices = () => {
  const { user } = useAuth();
  const { language } = useLanguage();
  const isVi = language === "vi";

  const [searchParams, setSearchParams] = useSearchParams();
  const { data: invoices, isLoading, isError, error, refetch, isFetching } = useInvoices();
  const deleteInvoice = useDeleteInvoice();
  const [viewingInvoiceId, setViewingInvoiceId] = useState<string | null>(null);
  const [editingInvoiceId, setEditingInvoiceId] = useState<string | null>(null);
  const [deletingInvoiceId, setDeletingInvoiceId] = useState<string | null>(null);
  const [viewingImageUrl, setViewingImageUrl] = useState<string | null>(null);
  const [viewingImageTitle, setViewingImageTitle] = useState<string>(isVi ? "Ảnh hóa đơn" : "Invoice image");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [monthFilter, setMonthFilter] = useState<MonthFilter>("this_month");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [quickOverdueOnly, setQuickOverdueOnly] = useState(false);
  const [quickUnlinkedOnly, setQuickUnlinkedOnly] = useState(false);
  const [selectedSupplierName, setSelectedSupplierName] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    if (user && !isLoading && !invoices?.length && !isError) {
      refetch();
    }
  }, [user, isLoading, invoices, isError, refetch]);

  useEffect(() => {
    const viewInvoiceId = searchParams.get("view");
    if (viewInvoiceId && invoices?.some((inv) => inv.id === viewInvoiceId)) {
      setViewingInvoiceId(viewInvoiceId);
      searchParams.delete("view");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, invoices, setSearchParams]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, sourceFilter, monthFilter, supplierFilter, quickOverdueOnly, quickUnlinkedOnly, selectedSupplierName]);

  const invoiceRows = useMemo(() => invoices || [], [invoices]);

  const suppliers = useMemo(() => {
    const names = new Set<string>();
    invoiceRows.forEach((invoice) => {
      const name = invoice.suppliers?.name?.trim();
      if (name) names.add(name);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b, "vi"));
  }, [invoiceRows]);

  const enrichedInvoices = useMemo(() => {
    const today = new Date();
    return invoiceRows.map((invoice) => {
      const sourceMeta = getSourceMeta(invoice);
      const status = getInvoiceStatus(invoice, today);
      const total = toNumber(invoice.total_amount);
      const paidAmount = status === "paid" ? total : 0;
      const remainingAmount = Math.max(0, total - paidAmount);
      const dueDate = getInvoiceDueDate(invoice);
      return { invoice, sourceMeta, status, total, paidAmount, remainingAmount, dueDate };
    });
  }, [invoiceRows]);

  const stats = useMemo(() => {
    return enrichedInvoices.reduce(
      (acc, row) => {
        acc.totalAmount += row.total;
        if (row.status === "paid") acc.paidAmount += row.total;
        if (row.status !== "paid") acc.waitingAmount += row.remainingAmount;
        if (row.status === "overdue") acc.overdueAmount += row.remainingAmount;
        if (!row.invoice.purchase_order_id && !row.invoice.goods_receipt_id) acc.unlinkedCount += 1;
        return acc;
      },
      { totalAmount: 0, paidAmount: 0, waitingAmount: 0, overdueAmount: 0, unlinkedCount: 0 },
    );
  }, [enrichedInvoices]);

  const supplierDebtRanking = useMemo(() => {
    const map = new Map<string, { name: string; amount: number; count: number }>();
    enrichedInvoices.forEach((row) => {
      if (row.status === "paid") return;
      const name = row.invoice.suppliers?.name?.trim() || (isVi ? "Chưa có NCC" : "No supplier");
      const current = map.get(name) || { name, amount: 0, count: 0 };
      current.amount += row.remainingAmount;
      current.count += 1;
      map.set(name, current);
    });
    return Array.from(map.values()).sort((a, b) => b.amount - a.amount).slice(0, 5);
  }, [enrichedInvoices, isVi]);

  const filteredInvoices = useMemo(() => {
    const normalizedSearch = normalizeSearchText(searchTerm.trim());
    return enrichedInvoices.filter((row) => {
      const { invoice, sourceMeta, status } = row;
      const supplierName = invoice.suppliers?.name || "";
      const searchableText = normalizeSearchText([
        invoice.invoice_number,
        supplierName,
        invoice.purchase_orders?.po_number,
        invoice.goods_receipts?.receipt_number,
        invoice.notes || "",
      ].filter(Boolean).join(" "));

      if (normalizedSearch && !searchableText.includes(normalizedSearch)) return false;
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (sourceFilter !== "all" && sourceMeta.source !== sourceFilter) return false;
      if (monthFilter === "this_month" && !isThisMonth(new Date(invoice.invoice_date))) return false;
      if (supplierFilter !== "all" && supplierName !== supplierFilter) return false;
      if (selectedSupplierName && supplierName !== selectedSupplierName) return false;
      if (quickOverdueOnly && status !== "overdue") return false;
      if (quickUnlinkedOnly && (invoice.purchase_order_id || invoice.goods_receipt_id)) return false;
      return true;
    });
  }, [enrichedInvoices, monthFilter, quickOverdueOnly, quickUnlinkedOnly, searchTerm, selectedSupplierName, sourceFilter, statusFilter, supplierFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredInvoices.length / PAGE_SIZE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStartIndex = (safeCurrentPage - 1) * PAGE_SIZE;
  const paginatedInvoices = filteredInvoices.slice(pageStartIndex, pageStartIndex + PAGE_SIZE);

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const openAttachmentPreview = async (rawUrl: string | null | undefined, title: string, preferredBucket = "invoices") => {
    const resolved = await resolveImageUrl(rawUrl || null, { preferredBucket });

    if (!resolved) {
      toast.error(isVi ? "Không tìm thấy file đính kèm trong kho lưu trữ" : "Attachment file was not found in storage");
      setViewingImageUrl(null);
      return;
    }

    setViewingImageUrl(resolved);
    setViewingImageTitle(title);
  };

  const handleDelete = async () => {
    if (deletingInvoiceId) {
      await deleteInvoice.mutateAsync(deletingInvoiceId);
      setDeletingInvoiceId(null);
    }
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, invoiceId: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setViewingInvoiceId(invoiceId);
    }
  };

  const clearOperationalFilters = () => {
    setSearchTerm("");
    setStatusFilter("all");
    setSourceFilter("all");
    setMonthFilter("this_month");
    setSupplierFilter("all");
    setQuickOverdueOnly(false);
    setQuickUnlinkedOnly(false);
    setSelectedSupplierName(null);
  };

  return (
    <div className="space-y-5 p-0 text-foreground" data-stitch-invoice-dashboard>
      <div className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-card lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <ReceiptText className="h-4 w-4" />
            {isVi ? "Kế toán phải trả" : "Accounts payable"}
          </div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">{isVi ? "Hóa đơn" : "Invoices"}</h1>
          <p className="text-sm text-muted-foreground">
            {isVi ? "Theo dõi hóa đơn, công nợ và liên kết PO/phiếu nhập" : "Track invoices, payables, and PO/receipt links"}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            variant="outline"
            className="border-border bg-card text-foreground hover:bg-muted"
            onClick={() => toast.info(isVi ? "Chọn đề nghị chi/phiếu nhập trong luồng công nợ để tạo hóa đơn liên kết." : "Create linked invoices from payable/receipt workflows.")}
          >
            <UploadCloud className="mr-2 h-4 w-4" />
            {isVi ? "Nhập từ phiếu nhập" : "Import from receipt"}
          </Button>
          <div className="[&_button]:btn-gradient">
            <AddInvoiceDialog />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card className="border-border bg-card shadow-card">
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{isVi ? "Tổng hóa đơn" : "Total invoices"}</p>
              <p className="mt-1 text-2xl font-bold text-foreground">{formatCurrency(stats.totalAmount)}</p>
              <p className="text-xs text-muted-foreground">{invoiceRows.length} {isVi ? "hóa đơn" : "invoices"}</p>
            </div>
            <div className="rounded-xl bg-primary/10 p-3 text-primary"><CircleDollarSign className="h-5 w-5" /></div>
          </CardContent>
        </Card>
        <Card className="border-border bg-card shadow-card">
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{isVi ? "Chờ thanh toán" : "Pending payment"}</p>
              <p className="mt-1 text-2xl font-bold text-foreground">{formatCurrency(stats.waitingAmount)}</p>
              <p className="text-xs text-muted-foreground">{isVi ? "Còn lại phải trả" : "Remaining balance"}</p>
            </div>
            <div className="rounded-xl bg-primary/10 p-3 text-primary"><Clock3 className="h-5 w-5" /></div>
          </CardContent>
        </Card>
        <Card className="border-destructive/20 bg-card shadow-card">
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-destructive">{isVi ? "Quá hạn" : "Overdue"}</p>
              <p className="mt-1 text-2xl font-bold text-destructive">{formatCurrency(stats.overdueAmount)}</p>
              <p className="text-xs text-muted-foreground">{isVi ? "Cần xử lý trước" : "Needs attention"}</p>
            </div>
            <div className="rounded-xl bg-destructive/10 p-3 text-destructive"><AlertTriangle className="h-5 w-5" /></div>
          </CardContent>
        </Card>
        <Card className="border-warning/30 bg-card shadow-card">
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-primary">{isVi ? "Chưa liên kết chứng từ" : "Unlinked docs"}</p>
              <p className="mt-1 text-2xl font-bold text-primary">{stats.unlinkedCount}</p>
              <p className="text-xs text-muted-foreground">{isVi ? "hóa đơn cần gắn PO/PNK" : "need PO/receipt link"}</p>
            </div>
            <div className="rounded-xl bg-primary/10 p-3 text-primary"><Link2 className="h-5 w-5" /></div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border bg-card shadow-card" data-stitch-invoice-filters>
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="relative min-w-[260px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder={isVi ? "Tìm số hóa đơn, nhà cung cấp, PO..." : "Search invoice, supplier, PO..."}
                className="h-10 border-border bg-background pl-9"
              />
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:w-auto">
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
                <SelectTrigger className="h-10 border-border bg-card"><SelectValue placeholder={isVi ? "Trạng thái" : "Status"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{isVi ? "Tất cả trạng thái" : "All statuses"}</SelectItem>
                  <SelectItem value="waiting">{isVi ? "Chờ thanh toán" : "Pending"}</SelectItem>
                  <SelectItem value="paid">{isVi ? "Đã thanh toán" : "Paid"}</SelectItem>
                  <SelectItem value="overdue">{isVi ? "Quá hạn" : "Overdue"}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value as SourceFilter)}>
                <SelectTrigger className="h-10 border-border bg-card"><SelectValue placeholder={isVi ? "Nguồn" : "Source"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{isVi ? "Tất cả nguồn" : "All sources"}</SelectItem>
                  <SelectItem value="warehouse_receipt">{isVi ? "Từ phiếu nhập kho" : "From receipt"}</SelectItem>
                  <SelectItem value="purchase_order">{isVi ? "Từ PO" : "From PO"}</SelectItem>
                  <SelectItem value="ocr_scan">OCR/scan</SelectItem>
                  <SelectItem value="manual">{isVi ? "Thủ công" : "Manual"}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={monthFilter} onValueChange={(value) => setMonthFilter(value as MonthFilter)}>
                <SelectTrigger className="h-10 border-border bg-card"><SelectValue placeholder={isVi ? "Thời gian" : "Period"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="this_month">{isVi ? "Tháng này" : "This month"}</SelectItem>
                  <SelectItem value="all">{isVi ? "Tất cả thời gian" : "All time"}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={supplierFilter} onValueChange={setSupplierFilter}>
                <SelectTrigger className="h-10 border-border bg-card"><SelectValue placeholder={isVi ? "Nhà cung cấp" : "Supplier"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{isVi ? "Tất cả NCC" : "All suppliers"}</SelectItem>
                  {suppliers.map((supplier) => <SelectItem key={supplier} value={supplier}>{supplier}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant={quickOverdueOnly ? "default" : "outline"} className={quickOverdueOnly ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : "border-border"} onClick={() => setQuickOverdueOnly((value) => !value)}>
              <AlertTriangle className="mr-2 h-3.5 w-3.5" />{isVi ? "Quá hạn" : "Overdue"}
            </Button>
            <Button size="sm" variant={quickUnlinkedOnly ? "default" : "outline"} className={quickUnlinkedOnly ? "btn-gradient" : "border-border"} onClick={() => setQuickUnlinkedOnly((value) => !value)}>
              <Link2 className="mr-2 h-3.5 w-3.5" />{isVi ? "Chưa gắn PO/PNK" : "Missing PO/receipt"}
            </Button>
            {(searchTerm || statusFilter !== "all" || sourceFilter !== "all" || monthFilter !== "this_month" || supplierFilter !== "all" || selectedSupplierName || quickOverdueOnly || quickUnlinkedOnly) && (
              <Button size="sm" variant="ghost" onClick={clearOperationalFilters} className="text-muted-foreground">
                <Filter className="mr-2 h-3.5 w-3.5" />{isVi ? "Xóa lọc" : "Clear filters"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="overflow-hidden border-border bg-card shadow-card" data-stitch-invoice-table>
          <CardHeader className="border-b border-border bg-card px-4 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-2 text-base text-foreground">
                <FileText className="h-5 w-5 text-primary" />
                {selectedSupplierName ? `${isVi ? "Hóa đơn của" : "Invoices for"} ${selectedSupplierName}` : isVi ? "Danh sách hóa đơn" : "Invoice list"}
              </CardTitle>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{filteredInvoices.length} {isVi ? "kết quả" : "results"}</span>
                <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
                  <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="space-y-3 p-4">
                {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : isError ? (
              <div className="p-6 space-y-3">
                <p className="font-medium text-foreground">{isVi ? "Không thể tải hóa đơn" : "Couldn't load invoices"}</p>
                <p className="text-sm text-muted-foreground break-words">{error instanceof Error ? error.message : isVi ? "Lỗi không xác định" : "Unknown error"}</p>
                <Button variant="outline" onClick={() => refetch()}>{isVi ? "Thử lại" : "Retry"}</Button>
              </div>
            ) : filteredInvoices.length > 0 ? (
              <>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-muted/70">
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="min-w-[140px] text-xs font-bold uppercase tracking-wide text-muted-foreground">{isVi ? "Số hóa đơn" : "Invoice #"}</TableHead>
                        <TableHead className="min-w-[170px] text-xs font-bold uppercase tracking-wide text-muted-foreground">{isVi ? "Nhà cung cấp" : "Supplier"}</TableHead>
                        <TableHead className="min-w-[180px] text-xs font-bold uppercase tracking-wide text-muted-foreground">{isVi ? "Nguồn/PO/PNK" : "Source/PO/Receipt"}</TableHead>
                        <TableHead className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{isVi ? "Ngày HĐ" : "Date"}</TableHead>
                        <TableHead className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{isVi ? "Hạn TT" : "Due"}</TableHead>
                        <TableHead className="text-right text-xs font-bold uppercase tracking-wide text-muted-foreground">{isVi ? "Giá trị" : "Amount"}</TableHead>
                        <TableHead className="min-w-[150px] text-right text-xs font-bold uppercase tracking-wide text-muted-foreground">{isVi ? "Đã trả/Còn lại" : "Paid/Remaining"}</TableHead>
                        <TableHead className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{isVi ? "Trạng thái" : "Status"}</TableHead>
                        <TableHead className="text-right text-xs font-bold uppercase tracking-wide text-muted-foreground">{isVi ? "Thao tác" : "Actions"}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedInvoices.map(({ invoice, sourceMeta, status, total, paidAmount, remainingAmount, dueDate }) => (
                        <TableRow
                          key={invoice.id}
                          className="h-[52px] cursor-pointer border-border transition-colors hover:bg-muted/60"
                          tabIndex={0}
                          onClick={() => setViewingInvoiceId(invoice.id)}
                          onKeyDown={(event) => handleRowKeyDown(event, invoice.id)}
                        >
                          <TableCell>
                            <div className="font-semibold text-foreground">{invoice.invoice_number}</div>
                            {invoice.notes && <div className="max-w-[180px] truncate text-xs text-muted-foreground">{invoice.notes}</div>}
                          </TableCell>
                          <TableCell>
                            <div className="font-medium text-foreground">{invoice.suppliers?.name || <span className="text-muted-foreground">-</span>}</div>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              <Badge variant="outline" className="w-fit border-border bg-muted/70 text-foreground">
                                {getSourceLabel(sourceMeta.source, isVi)}
                              </Badge>
                              {sourceMeta.reference && <span className="max-w-[170px] truncate font-mono text-xs text-muted-foreground">{sourceMeta.reference}</span>}
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">{format(new Date(invoice.invoice_date), "dd/MM/yyyy")}</TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">{format(dueDate, "dd/MM/yyyy")}</TableCell>
                          <TableCell className="text-right font-semibold text-foreground">{formatFullCurrency(total)}</TableCell>
                          <TableCell className="text-right">
                            <div className="text-xs text-success">{formatFullCurrency(paidAmount)}</div>
                            <div className={remainingAmount > 0 ? "text-xs font-semibold text-primary" : "text-xs text-muted-foreground"}>{formatFullCurrency(remainingAmount)}</div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={getStatusClassName(status)}>{getStatusLabel(status, isVi)}</Badge>
                          </TableCell>
                          <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                            <div className="flex items-center justify-end gap-1">
                              {invoice.image_url && (
                                <Button variant="ghost" size="sm" onClick={() => openAttachmentPreview(invoice.image_url, isVi ? "Hóa đơn" : "Invoice", "invoices")} title={isVi ? "Xem hóa đơn" : "View invoice"}>
                                  <Image className="h-4 w-4" />
                                </Button>
                              )}
                              {invoice.payment_slip_url && (
                                <Button variant="ghost" size="sm" onClick={() => openAttachmentPreview(invoice.payment_slip_url, isVi ? "UNC / Chứng từ TT" : "UNC / Payment slip", "invoices")} title={isVi ? "Xem UNC" : "View UNC"} className="text-primary">
                                  <CreditCard className="h-4 w-4" />
                                </Button>
                              )}
                              <Button variant="ghost" size="sm" onClick={() => setEditingInvoiceId(invoice.id)} title={isVi ? "Chỉnh sửa" : "Edit"}><Pencil className="h-4 w-4" /></Button>
                              <Button variant="ghost" size="sm" onClick={() => setDeletingInvoiceId(invoice.id)} className="text-destructive hover:text-destructive" title={isVi ? "Xóa" : "Delete"}><Trash2 className="h-4 w-4" /></Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="flex flex-col gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <div>{PAGE_SIZE} {isVi ? "dòng/trang" : "rows/page"} · {isVi ? "Hiển thị" : "Showing"} {pageStartIndex + 1}-{Math.min(pageStartIndex + PAGE_SIZE, filteredInvoices.length)} / {filteredInvoices.length}</div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" disabled={safeCurrentPage <= 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}>
                      <ChevronLeft className="mr-1 h-4 w-4" />{isVi ? "Trang trước" : "Prev"}
                    </Button>
                    <span className="text-xs">{safeCurrentPage}/{totalPages}</span>
                    <Button variant="outline" size="sm" disabled={safeCurrentPage >= totalPages} onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}>
                      {isVi ? "Trang sau" : "Next"}<ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center py-12">
                <FileText className="mx-auto h-12 w-12 text-muted-foreground/50" />
                <h3 className="mt-4 text-lg font-semibold">{isVi ? "Không có hóa đơn phù hợp" : "No matching invoices"}</h3>
                <p className="text-muted-foreground">{isVi ? "Thử xóa bộ lọc hoặc thêm hóa đơn mới" : "Clear filters or add a new invoice"}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <aside className="space-y-4" data-stitch-invoice-insights>
          <Card className="border-border bg-card shadow-card">
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4 text-primary" />{isVi ? "Cần xử lý" : "Needs action"}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <button className="flex w-full items-center justify-between rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-left text-sm hover:bg-destructive/15" onClick={() => { setQuickOverdueOnly(true); setStatusFilter("all"); }}>
                <span className="flex items-center gap-2 text-destructive"><XCircle className="h-4 w-4" />{isVi ? "Hóa đơn quá hạn" : "Overdue invoices"}</span>
                <span className="font-bold text-destructive">{formatCurrency(stats.overdueAmount)}</span>
              </button>
              <button className="flex w-full items-center justify-between rounded-xl border border-primary/20 bg-primary/10 p-3 text-left text-sm hover:bg-primary/15" onClick={() => setQuickUnlinkedOnly(true)}>
                <span className="flex items-center gap-2 text-primary"><Link2 className="h-4 w-4" />{isVi ? "Thiếu PO/PNK" : "Missing PO/receipt"}</span>
                <span className="font-bold text-primary">{stats.unlinkedCount}</span>
              </button>
              <div className="flex items-center justify-between rounded-xl border border-success/20 bg-success/10 p-3 text-sm ">
                <span className="flex items-center gap-2 text-success"><CheckCircle2 className="h-4 w-4" />{isVi ? "Đã đối soát" : "Reconciled"}</span>
                <span className="font-bold text-success">{formatCurrency(stats.paidAmount)}</span>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-card shadow-card">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base"><TrendingUp className="h-4 w-4 text-primary" />{isVi ? "Top NCC theo công nợ" : "Top supplier debt"}</CardTitle>
                {selectedSupplierName && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setSelectedSupplierName(null)}>{isVi ? "Xóa lọc" : "Clear"}</Button>}
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {supplierDebtRanking.length > 0 ? supplierDebtRanking.map((supplier, index) => (
                <button
                  key={supplier.name}
                  className={`w-full rounded-xl border p-3 text-left transition-colors ${selectedSupplierName === supplier.name ? "border-primary/30 bg-primary/10" : "border-border bg-muted/50 hover:bg-muted"}`}
                  onClick={() => setSelectedSupplierName(supplier.name)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground">{index + 1}. {supplier.name}</div>
                      <div className="text-xs text-muted-foreground">{supplier.count} {isVi ? "hóa đơn còn nợ" : "open invoices"}</div>
                    </div>
                    <div className="whitespace-nowrap text-sm font-bold text-primary">{formatCurrency(supplier.amount)}</div>
                  </div>
                </button>
              )) : (
                <div className="rounded-xl border border-border bg-muted/50 p-4 text-sm text-muted-foreground">{isVi ? "Không còn công nợ mở" : "No open debt"}</div>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>

      <InvoiceDetailsDialog invoiceId={viewingInvoiceId} open={!!viewingInvoiceId} onOpenChange={(open) => !open && setViewingInvoiceId(null)} />
      <EditInvoiceDialog invoiceId={editingInvoiceId} open={!!editingInvoiceId} onOpenChange={(open) => !open && setEditingInvoiceId(null)} />

      <AlertDialog open={!!deletingInvoiceId} onOpenChange={(open) => !open && setDeletingInvoiceId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isVi ? "Xóa hóa đơn" : "Delete invoice"}</AlertDialogTitle>
            <AlertDialogDescription>{isVi ? "Bạn có chắc muốn xóa hóa đơn này? Hành động này không thể hoàn tác." : "Are you sure you want to delete this invoice? This action cannot be undone."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isVi ? "Hủy" : "Cancel"}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{isVi ? "Xóa" : "Delete"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!viewingImageUrl} onOpenChange={(open) => !open && setViewingImageUrl(null)}>
        <AlertDialogContent className="max-w-4xl">
          <AlertDialogHeader><AlertDialogTitle>{viewingImageTitle}</AlertDialogTitle></AlertDialogHeader>
          <div className="max-h-[70vh] overflow-auto">{viewingImageUrl && <img src={viewingImageUrl} alt={isVi ? "Hóa đơn" : "Invoice"} className="w-full h-auto rounded-lg" />}</div>
          <AlertDialogFooter><AlertDialogCancel>{isVi ? "Đóng" : "Close"}</AlertDialogCancel></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Invoices;
