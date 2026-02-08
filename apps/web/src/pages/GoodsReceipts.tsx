import { useState, useMemo } from "react";
import { format } from "date-fns";
import { vi, enUS } from "date-fns/locale";
import { Package, Eye, Trash2, CheckCircle, Clock, FileCheck } from "lucide-react";
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
  
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data: receipts = [], isLoading } = useGoodsReceipts();
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

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />Nháp</Badge>;
      case "confirmed":
        return <Badge variant="default"><FileCheck className="h-3 w-3 mr-1" />Đã xác nhận</Badge>;
      case "received":
        return <Badge className="bg-green-500"><CheckCircle className="h-3 w-3 mr-1" />Đã nhập kho</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
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
      toast.error("Không thể nhập hàng vào kho");
    }
  };

  const handleViewDetails = (id: string) => {
    setSelectedReceiptId(id);
    setDetailsOpen(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">Phiếu Nhập Kho</h1>
          <p className="text-muted-foreground">Quản lý phiếu nhập kho từ nhà cung cấp</p>
        </div>
        <AddGoodsReceiptDialog />
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setStatusFilter("all")}>
          <CardHeader className="pb-2">
            <CardDescription>Tổng phiếu</CardDescription>
            <CardTitle className="text-2xl">{stats.total}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setStatusFilter("draft")}>
          <CardHeader className="pb-2">
            <CardDescription>Nháp</CardDescription>
            <CardTitle className="text-2xl">{stats.draft}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setStatusFilter("confirmed")}>
          <CardHeader className="pb-2">
            <CardDescription>Đã xác nhận</CardDescription>
            <CardTitle className="text-2xl">{stats.confirmed}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setStatusFilter("received")}>
          <CardHeader className="pb-2">
            <CardDescription>Đã nhập kho</CardDescription>
            <CardTitle className="text-2xl text-green-600">{stats.received}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Trạng thái" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tất cả</SelectItem>
            <SelectItem value="draft">Nháp</SelectItem>
            <SelectItem value="confirmed">Đã xác nhận</SelectItem>
            <SelectItem value="received">Đã nhập kho</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mã phiếu</TableHead>
                <TableHead>Nhà cung cấp</TableHead>
                <TableHead>Ngày nhận</TableHead>
                <TableHead>Số lượng</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8">
                    Đang tải...
                  </TableCell>
                </TableRow>
              ) : filteredReceipts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8">
                    <Package className="h-12 w-12 mx-auto text-muted-foreground mb-2" />
                    <p className="text-muted-foreground">Chưa có phiếu nhập kho nào</p>
                  </TableCell>
                </TableRow>
              ) : (
                filteredReceipts.map((receipt) => (
                  <TableRow key={receipt.id}>
                    <TableCell className="font-mono font-medium">{receipt.receipt_number}</TableCell>
                    <TableCell>{receipt.suppliers?.name || "-"}</TableCell>
                    <TableCell>
                      {format(new Date(receipt.receipt_date), "dd/MM/yyyy", { locale })}
                    </TableCell>
                    <TableCell>{receipt.total_quantity?.toLocaleString("vi-VN") || 0}</TableCell>
                    <TableCell>{getStatusBadge(receipt.status)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleViewDetails(receipt.id)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>

                        {receipt.status === "confirmed" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleConfirmReceipt(receipt.id)}
                            disabled={confirmReceipt.isPending}
                          >
                            <CheckCircle className="h-4 w-4 mr-1" />
                            Nhập kho
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
                                <AlertDialogTitle>Xóa phiếu nhập kho?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Bạn có chắc chắn muốn xóa phiếu nhập kho {receipt.receipt_number}? Hành động này không thể hoàn tác.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Hủy</AlertDialogCancel>
                                <AlertDialogAction onClick={handleDelete}>Xóa</AlertDialogAction>
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
        </CardContent>
      </Card>

      {/* Details Dialog */}
      <GoodsReceiptDetailsDialog
        receiptId={selectedReceiptId}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
    </div>
  );
}
