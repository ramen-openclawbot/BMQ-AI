import { useMemo, useState } from "react";
import { format } from "date-fns";
import {
  CalendarDays,
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

type PayableStatusFilter = "all" | "unpaid" | "partial" | "paid" | "overpaid";
type ApprovalStatusFilter = "all" | "pending" | "approved" | "rejected";
type SourceFilter = "warehouse_receipt" | "all" | "manual";

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

const formatCurrency = (amount: number) =>
  `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(amount)} đ`;

const getRequestCode = (paymentRequest: PaymentRequestWithSupplier) =>
  paymentRequest.request_number || paymentRequest.title || `CN-${paymentRequest.id.slice(0, 8).toUpperCase()}`;

const isWarehouseReceiptPayable = (paymentRequest: PaymentRequestWithSupplier) =>
  Boolean(paymentRequest.goods_receipt_id);

const getPaymentStatusLabel = (paymentRequest: PaymentRequestWithSupplier) => {
  if (paymentRequest.payment_status === "paid") return "Đã thanh toán";
  if (paymentRequest.payment_status === "partial") return "Thanh toán một phần";
  if (paymentRequest.payment_status === "overpaid") return "Thanh toán dư";
  return "Chưa thanh toán";
};

const getApprovalStatusLabel = (status: PaymentRequestWithSupplier["status"]) => {
  if (status === "approved") return "Đã duyệt";
  if (status === "rejected") return "Từ chối";
  return "Chờ duyệt";
};

const getPaymentMethodLabel = (paymentRequest: PaymentRequestWithSupplier) => {
  if (paymentRequest.payment_method === "bank_transfer") return "UNC";
  if (paymentRequest.payment_method === "cash") return "Tiền mặt";
  return "Chưa chọn";
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
  const { canEditModule } = useAuth();
  const canEditPaymentRequests = canEditModule("payment_requests");
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<PayableStatusFilter>("all");
  const [approvalStatusFilter, setApprovalStatusFilter] = useState<ApprovalStatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("warehouse_receipt");
  const [dateFrom, setDateFrom] = useState(getMonthStartInputValue);
  const [dateTo, setDateTo] = useState(getMonthEndInputValue);

  const { data: paymentRequests, isLoading, isError, error, refetch } = usePaymentRequests();
  const bulkMarkPaid = useBulkMarkPaid();

  const filteredPayables = useMemo(() => {
    const normalizedSearchTerm = normalizeSearch(searchTerm);

    return (paymentRequests || []).filter((paymentRequest) => {
      const requestDate = format(new Date(paymentRequest.created_at), "yyyy-MM-dd");
      if (dateFrom && requestDate < dateFrom) return false;
      if (dateTo && requestDate > dateTo) return false;
      if (sourceFilter === "warehouse_receipt" && !isWarehouseReceiptPayable(paymentRequest)) return false;
      if (sourceFilter === "manual" && isWarehouseReceiptPayable(paymentRequest)) return false;
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
  }, [paymentRequests, searchTerm, dateFrom, dateTo, sourceFilter, paymentStatusFilter, approvalStatusFilter]);

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

  const statCards = [
    {
      label: "Tổng công nợ phải trả",
      value: formatCurrency(stats.totalAmount),
      helper: `${stats.count} phiếu`,
      icon: Wallet,
      tone: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200",
    },
    {
      label: "Còn phải thanh toán",
      value: formatCurrency(stats.outstandingAmount),
      helper: `${stats.outstandingCount} phiếu chưa tất toán`,
      icon: Clock3,
      tone: "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/20 dark:text-rose-200",
    },
    {
      label: "Đã thanh toán",
      value: formatCurrency(stats.paidAmount),
      helper: `${stats.paidCount} phiếu`,
      icon: CheckCircle2,
      tone: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-200",
    },
    {
      label: "Công nợ từ phiếu nhập kho",
      value: formatCurrency(stats.warehouseAmount),
      helper: `${stats.warehouseCount} phiếu có link nhập kho`,
      icon: PackageCheck,
      tone: "border-slate-200 bg-white text-slate-800 dark:border-slate-800 dark:bg-card dark:text-slate-100",
    },
  ];

  const handleMarkPaid = async (paymentRequest: PaymentRequestWithSupplier) => {
    if (!canEditPaymentRequests) {
      toast.error("Anh không có quyền cập nhật thanh toán công nợ phải trả");
      return;
    }

    if (!hasOutstandingPayment(paymentRequest)) {
      toast.info("Phiếu này không còn số tiền cần thanh toán");
      return;
    }

    try {
      await bulkMarkPaid.mutateAsync([paymentRequest.id]);
      toast.success("Đã ghi nhận thanh toán công nợ");
    } catch (markPaidError) {
      const message = markPaidError instanceof Error ? markPaidError.message : String(markPaidError || "");
      toast.error("Không cập nhật được công nợ", {
        description: message || "Vui lòng thử lại.",
      });
    }
  };

  const renderSourceBadge = (paymentRequest: PaymentRequestWithSupplier) => {
    if (!isWarehouseReceiptPayable(paymentRequest)) {
      return <Badge variant="outline">Nguồn khác</Badge>;
    }

    return (
      <div className="space-y-1 text-xs">
        <Badge className="bg-emerald-600 text-white">
          <PackageCheck className="mr-1 h-3 w-3" />
          Từ phiếu nhập kho
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
      return <Badge className="bg-emerald-600 text-white">Đã thanh toán</Badge>;
    }
    if (paymentRequest.payment_status === "partial") {
      return <Badge className="bg-amber-500 text-white">Còn {formatCurrency(remaining)}</Badge>;
    }
    return <Badge variant="destructive">Chưa thanh toán</Badge>;
  };

  if (isError) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-5 text-sm text-destructive">
        Không đọc được dữ liệu công nợ phải trả: {error instanceof Error ? error.message : "Lỗi không xác định"}
      </div>
    );
  }

  return (
    <div className="space-y-5 bg-slate-50/40 pb-28 dark:bg-background lg:pb-20">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <h1 className="text-[28px] font-semibold leading-tight tracking-normal text-slate-950 dark:text-slate-50">
            Quản lý công nợ phải trả
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Theo dõi công nợ nhà cung cấp phát sinh từ phiếu nhập kho, PO và các đề nghị chi liên quan. Trang này tách riêng khỏi Duyệt chi để kế toán xem số phải trả và trạng thái thanh toán nhanh hơn.
          </p>
        </div>
        <Button
          variant="outline"
          className="h-11 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card"
          onClick={() => refetch()}
        >
          <RefreshCw className={cn("mr-2 h-4 w-4", isLoading && "animate-spin")} />
          Làm mới
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
          <div className="grid gap-3 lg:grid-cols-[minmax(250px,1fr)_180px_180px_220px_140px]">
            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Tìm nhà cung cấp, mã công nợ, phiếu nhập kho, PO"
                className="h-11 rounded-md border-slate-200 bg-white pl-10 text-sm shadow-none dark:border-slate-800 dark:bg-background"
              />
            </div>

            <Select value={paymentStatusFilter} onValueChange={(value) => setPaymentStatusFilter(value as PayableStatusFilter)}>
              <SelectTrigger className="h-11 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-background">
                <SelectValue placeholder="Thanh toán" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả thanh toán</SelectItem>
                <SelectItem value="unpaid">Chưa thanh toán</SelectItem>
                <SelectItem value="partial">Thanh toán một phần</SelectItem>
                <SelectItem value="paid">Đã thanh toán</SelectItem>
                <SelectItem value="overpaid">Thanh toán dư</SelectItem>
              </SelectContent>
            </Select>

            <Select value={approvalStatusFilter} onValueChange={(value) => setApprovalStatusFilter(value as ApprovalStatusFilter)}>
              <SelectTrigger className="h-11 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-background">
                <SelectValue placeholder="Duyệt chi" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả duyệt chi</SelectItem>
                <SelectItem value="pending">Chờ duyệt</SelectItem>
                <SelectItem value="approved">Đã duyệt</SelectItem>
                <SelectItem value="rejected">Từ chối</SelectItem>
              </SelectContent>
            </Select>

            <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value as SourceFilter)}>
              <SelectTrigger className="h-11 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-background">
                <SelectValue placeholder="Nguồn công nợ" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="warehouse_receipt">Công nợ từ phiếu nhập kho</SelectItem>
                <SelectItem value="manual">Nguồn khác / thủ công</SelectItem>
                <SelectItem value="all">Tất cả nguồn</SelectItem>
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 dark:border-slate-800 dark:bg-background">
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Ngày tạo</span>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(event) => setDateFrom(event.target.value)}
              aria-label="Từ ngày"
              className="h-11 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-background"
            />
            <Input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(event) => setDateTo(event.target.value)}
              aria-label="Đến ngày"
              className="h-11 rounded-md border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-background"
            />
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-xl border-slate-200 bg-white shadow-none dark:border-slate-800 dark:bg-card">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/80 dark:bg-slate-900/40">
                  <TableHead className="min-w-[180px]">Mã công nợ</TableHead>
                  <TableHead className="min-w-[220px]">Nhà cung cấp</TableHead>
                  <TableHead className="min-w-[210px]">Nguồn</TableHead>
                  <TableHead className="min-w-[140px] text-right">Tổng phải trả</TableHead>
                  <TableHead className="min-w-[140px] text-right">Còn lại</TableHead>
                  <TableHead className="min-w-[150px]">Trạng thái</TableHead>
                  <TableHead className="min-w-[120px]">Phương thức</TableHead>
                  <TableHead className="min-w-[160px] text-right">Thao tác</TableHead>
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
                      Không có công nợ phải trả phù hợp bộ lọc hiện tại.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredPayables.map((paymentRequest) => {
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
                          <div className="font-medium text-foreground">{paymentRequest.suppliers?.name || "Chưa có nhà cung cấp"}</div>
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
                            <div className="text-xs text-muted-foreground">Đã trả {formatCurrency(allocatedAmount)}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1.5">
                            {renderPaymentBadge(paymentRequest)}
                            <Badge variant="outline" className="block w-fit text-xs">
                              {getApprovalStatusLabel(paymentRequest.status)}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">{getPaymentMethodLabel(paymentRequest)}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{getPaymentStatusLabel(paymentRequest)}</div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => setSelectedRequestId(paymentRequest.id)}>
                              <Eye className="mr-1 h-4 w-4" />
                              Chi tiết
                            </Button>
                            {canEditPaymentRequests && hasOutstandingPayment(paymentRequest) && paymentRequest.status === "approved" && (
                              <Button size="sm" onClick={() => handleMarkPaid(paymentRequest)} disabled={bulkMarkPaid.isPending}>
                                Đã trả
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
