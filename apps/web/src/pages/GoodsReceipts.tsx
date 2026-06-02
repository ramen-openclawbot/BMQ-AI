import { useState, useMemo } from "react";
import { format } from "date-fns";
import { vi, enUS } from "date-fns/locale";
import { Package, Eye, Trash2, CheckCircle, Clock, FileCheck, AlertCircle, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { useGoodsReceipts, useDeleteGoodsReceipt, useConfirmGoodsReceipt } from "@/hooks/useGoodsReceipts";
import { useLanguage } from "@/contexts/LanguageContext";
import { AddGoodsReceiptDialog } from "@/components/dialogs/AddGoodsReceiptDialog";
import { GoodsReceiptDetailsDialog } from "@/components/dialogs/GoodsReceiptDetailsDialog";

export default function GoodsReceipts() {
  const { language } = useLanguage();
  const locale = language === "vi" ? vi : enUS;
  const isVi = language === "vi";
  
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data: receipts = [], isLoading, error } = useGoodsReceipts();
  const deleteReceipt = useDeleteGoodsReceipt();
  const confirmReceipt = useConfirmGoodsReceipt();

  // Filter receipts
  const filteredReceipts = useMemo(() => {
    return receipts.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      return true;
    });
  }, [receipts, statusFilter]);

  // Stats
  const stats = useMemo(() => {
    return {
      total: receipts.length,
      draft: receipts.filter((r) => r.status === "draft").length,
      confirmed: receipts.filter((r) => r.status === "confirmed").length,
      received: receipts.filter((r) => r.status === "received").length,
    };
  }, [receipts]);

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
        return <Badge className="bg-green-500"><CheckCircle className="h-3 w-3 mr-1" />{isVi ? "Đã nhập kho" : "Received"}</Badge>;
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
    return isVi ? "Nhập kho + Tạo công nợ" : "Receive + Create payable";
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

  return (
    <div className="-m-4 min-h-screen bg-slate-50 p-4 text-slate-950 md:-m-6 md:p-6 dark:bg-[#1d1813] dark:text-[#f3ece4]">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between dark:border-[#443b30] dark:bg-[#241f18]/90">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-slate-950 dark:text-[#f3ece4]">
              <Package className="h-6 w-6 text-amber-600" />
              {isVi ? "Phiếu nhập kho" : "Goods Receipts"}
            </h1>
            <p className="text-sm text-slate-500 dark:text-[#a99b8c]">{isVi ? "Quản lý phiếu nhập kho nguyên vật liệu từ nhà cung cấp" : "Manage goods receipts from suppliers"}</p>
          </div>
          <AddGoodsReceiptDialog />
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card className={`cursor-pointer border-slate-200 bg-white transition-shadow hover:shadow-md dark:border-[#443b30] dark:bg-[#241f18]/90 ${statusFilter === "all" ? "ring-2 ring-amber-500" : ""}`} onClick={() => setStatusFilter("all")}>
            <CardHeader className="px-3 py-2">
              <CardDescription>{isVi ? "Tổng phiếu" : "Total receipts"}</CardDescription>
              <CardTitle className="text-2xl">{stats.total}</CardTitle>
            </CardHeader>
          </Card>
          <Card className={`cursor-pointer border-slate-200 bg-white transition-shadow hover:shadow-md dark:border-[#443b30] dark:bg-[#241f18]/90 ${statusFilter === "draft" ? "ring-2 ring-amber-500" : ""}`} onClick={() => setStatusFilter("draft")}>
            <CardHeader className="px-3 py-2">
              <CardDescription>Nháp</CardDescription>
              <CardTitle className="text-2xl">{stats.draft}</CardTitle>
            </CardHeader>
          </Card>
          <Card className={`cursor-pointer border-slate-200 bg-white transition-shadow hover:shadow-md dark:border-[#443b30] dark:bg-[#241f18]/90 ${statusFilter === "confirmed" ? "ring-2 ring-amber-500" : ""}`} onClick={() => setStatusFilter("confirmed")}>
            <CardHeader className="px-3 py-2">
              <CardDescription>{isVi ? "Đã xác nhận" : "Confirmed"}</CardDescription>
              <CardTitle className="text-2xl">{stats.confirmed}</CardTitle>
            </CardHeader>
          </Card>
          <Card className={`cursor-pointer border-slate-200 bg-white transition-shadow hover:shadow-md dark:border-[#443b30] dark:bg-[#241f18]/90 ${statusFilter === "received" ? "ring-2 ring-amber-500" : ""}`} onClick={() => setStatusFilter("received")}>
            <CardHeader className="px-3 py-2">
              <CardDescription>{isVi ? "Đã nhập kho" : "Received"}</CardDescription>
              <CardTitle className="text-2xl text-green-600">{stats.received}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        {/* Filters */}
        <Card className="border-slate-200 bg-white dark:border-[#443b30] dark:bg-[#241f18]/90">
          <CardContent className="p-3">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-9 w-full border-slate-200 bg-white text-sm sm:w-48 dark:border-[#443b30] dark:bg-[#1d1813]">
                <SelectValue placeholder={isVi ? "Trạng thái" : "Status"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{isVi ? "Tất cả" : "All"}</SelectItem>
                <SelectItem value="draft">{isVi ? "Nháp" : "Draft"}</SelectItem>
                <SelectItem value="confirmed">{isVi ? "Đã xác nhận" : "Confirmed"}</SelectItem>
                <SelectItem value="received">{isVi ? "Đã nhập kho" : "Received"}</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Table */}
        <Card className="overflow-hidden border-slate-200 bg-white dark:border-[#443b30] dark:bg-[#241f18]/90">
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
                    <div className="flex items-center justify-center gap-2 text-slate-500 dark:text-[#a99b8c]">
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
                  <TableCell colSpan={7} className="text-center py-8">
                    <Package className="h-12 w-12 mx-auto text-muted-foreground mb-2" />
                    <p className="text-muted-foreground">{isVi ? "Chưa có phiếu nhập kho nào" : "No goods receipts yet"}</p>
                  </TableCell>
                </TableRow>
              ) : (
                filteredReceipts.map((receipt) => (
                  <TableRow key={receipt.id}>
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
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleViewDetails(receipt.id)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>

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

      {/* Details Dialog */}
      <GoodsReceiptDetailsDialog
        receiptId={selectedReceiptId}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
      </div>
    </div>
  );
}
