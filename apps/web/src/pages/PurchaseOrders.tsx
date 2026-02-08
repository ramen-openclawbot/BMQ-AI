import { useState, useMemo } from "react";
import { format } from "date-fns";
import { vi, enUS } from "date-fns/locale";
import {
  FileText,
  Search,
  Loader2,
  Eye,
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
import { usePurchaseOrders, useDeletePurchaseOrder } from "@/hooks/usePurchaseOrders";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";

type StatusFilter = "all" | "draft" | "sent" | "in_transit" | "completed" | "cancelled";

export default function PurchaseOrders() {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [deleteOrderId, setDeleteOrderId] = useState<string | null>(null);

  const { language } = useLanguage();
  const locale = language === "vi" ? vi : enUS;
  
  const { data: orders, isLoading, error } = usePurchaseOrders();
  const deletePO = useDeletePurchaseOrder();

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" />Nháp</Badge>;
      case "sent":
        return <Badge className="bg-blue-500 hover:bg-blue-600 gap-1"><Send className="h-3 w-3" />Đã gửi</Badge>;
      case "in_transit":
        return <Badge className="bg-orange-500 hover:bg-orange-600 gap-1"><Package className="h-3 w-3" />Đang vận chuyển</Badge>;
      case "completed":
        return <Badge className="bg-green-500 hover:bg-green-600 gap-1"><CheckCircle className="h-3 w-3" />Hoàn thành</Badge>;
      case "cancelled":
        return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />Đã hủy</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const stats = useMemo(() => {
    if (!orders) return { total: 0, draft: 0, sent: 0, completed: 0, totalValue: 0 };
    return {
      total: orders.length,
      draft: orders.filter((o) => o.status === "draft").length,
      sent: orders.filter((o) => o.status === "sent").length,
      completed: orders.filter((o) => o.status === "completed").length,
      totalValue: orders.filter((o) => o.status !== "cancelled").reduce((sum, o) => sum + (o.total_amount || 0), 0),
    };
  }, [orders]);

  const filteredOrders = useMemo(() => {
    if (!orders) return [];
    return orders.filter((order) => {
      const matchesSearch = order.po_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.suppliers?.name?.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === "all" || order.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [orders, searchTerm, statusFilter]);

  const handleDelete = async () => {
    if (!deleteOrderId) return;
    try {
      await deletePO.mutateAsync(deleteOrderId);
      toast.success("Đã xóa đơn đặt hàng");
      setDeleteOrderId(null);
    } catch (error) {
      toast.error("Lỗi khi xóa đơn đặt hàng");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <FileText className="h-8 w-8" />
            Đơn Đặt Hàng (Purchase Orders)
          </h1>
          <p className="text-muted-foreground">Quản lý đơn đặt hàng gửi cho nhà cung cấp</p>
        </div>
        <AddPurchaseOrderDialog />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className={`cursor-pointer ${statusFilter === "all" ? "ring-2 ring-primary" : ""}`} onClick={() => setStatusFilter("all")}>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Tổng đơn</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold">{stats.total}</p></CardContent>
        </Card>
        <Card className={`cursor-pointer ${statusFilter === "draft" ? "ring-2 ring-primary" : ""}`} onClick={() => setStatusFilter("draft")}>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Nháp</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold">{stats.draft}</p></CardContent>
        </Card>
        <Card className={`cursor-pointer ${statusFilter === "sent" ? "ring-2 ring-primary" : ""}`} onClick={() => setStatusFilter("sent")}>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-blue-600">Đã gửi</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-blue-600">{stats.sent}</p></CardContent>
        </Card>
        <Card className={`cursor-pointer ${statusFilter === "completed" ? "ring-2 ring-primary" : ""}`} onClick={() => setStatusFilter("completed")}>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-green-600">Hoàn thành</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-green-600">{stats.completed}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Tổng giá trị</CardTitle></CardHeader>
          <CardContent><p className="text-lg font-bold">{formatCurrency(stats.totalValue)}</p></CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Tìm theo số PO, nhà cung cấp..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10" />
        </div>
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Trạng thái" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tất cả</SelectItem>
            <SelectItem value="draft">Nháp</SelectItem>
            <SelectItem value="sent">Đã gửi</SelectItem>
            <SelectItem value="completed">Hoàn thành</SelectItem>
            <SelectItem value="cancelled">Đã hủy</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin" /></div>
          ) : error ? (
            <div className="text-center py-12 text-destructive">Lỗi tải dữ liệu</div>
          ) : filteredOrders.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><Package className="h-12 w-12 mx-auto mb-4 opacity-50" /><p>Chưa có đơn đặt hàng nào</p></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Số PO</TableHead>
                  <TableHead>Nhà cung cấp</TableHead>
                  <TableHead>Ngày đặt</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead className="text-right">Tổng tiền</TableHead>
                  <TableHead className="w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-medium">{order.po_number}</TableCell>
                    <TableCell>{order.suppliers?.name || "N/A"}</TableCell>
                    <TableCell>{format(new Date(order.order_date), "dd/MM/yyyy", { locale })}</TableCell>
                    <TableCell>{getStatusBadge(order.status)}</TableCell>
                    <TableCell className="text-right font-medium">{formatCurrency(order.total_amount || 0)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" onClick={() => setSelectedOrderId(order.id)}><Eye className="h-4 w-4" /></Button>
                        {order.status === "draft" && <Button variant="ghost" size="icon" onClick={() => setDeleteOrderId(order.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <PurchaseOrderDetailsDialog orderId={selectedOrderId} open={!!selectedOrderId} onOpenChange={(open) => !open && setSelectedOrderId(null)} />

      <AlertDialog open={!!deleteOrderId} onOpenChange={() => setDeleteOrderId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xóa</AlertDialogTitle>
            <AlertDialogDescription>Bạn có chắc muốn xóa đơn đặt hàng này?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deletePO.isPending} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deletePO.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
