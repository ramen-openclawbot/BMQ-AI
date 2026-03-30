import { useState, useMemo } from "react";
import { format, isToday } from "date-fns";
import { vi } from "date-fns/locale";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  Factory,
  Plus,
  Eye,
  Loader2,
  CalendarDays,
  Package,
  CheckCircle,
  Clock,
  AlertCircle,
  Zap,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ProductionItem {
  product_name: string;
  qty: number;
  unit: string;
  unit_price: number;
  line_total: number;
  date: string;
}

interface CustomerPoInbox {
  id: string;
  po_number: string;
  from_name: string;
  delivery_date: string;
  production_items: ProductionItem[];
  total_amount: number;
  match_status: string;
}

interface ProductionOrder {
  id: string;
  production_number: string;
  source_po_inbox_id: string;
  customer_id: string | null;
  customer_name?: string;
  po_number?: string;
  status: "draft" | "planned" | "in_progress" | "completed" | "cancelled";
  planned_start_date: string | null;
  planned_end_date: string | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
  items_count?: number;
}

interface ProductionOrderItem {
  id: string;
  production_order_id: string;
  product_name: string;
  planned_qty: number;
  completed_qty: number;
  unit: string;
  unit_price: number;
  line_total: number;
  line_complete: boolean;
  delivery_date: string;
  notes: string | null;
  created_at: string;
}

interface CreateProductionOrderInput {
  po_id: string;
  po_number: string;
  from_name: string;
  items: Array<{
    product_name: string;
    original_qty: number;
    planned_qty: number;
    unit: string;
    unit_price: number;
    line_total: number;
    date: string;
  }>;
  planned_start_date: string;
  planned_end_date: string;
  notes: string;
}

export default function ProductionPlanning() {
  const { language } = useLanguage();
  const isVi = language === "vi";
  const locale = isVi ? vi : undefined;
  const queryClient = useQueryClient();

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [expandedPoId, setExpandedPoId] = useState<string | null>(null);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [selectedPoForCreation, setSelectedPoForCreation] =
    useState<CustomerPoInbox | null>(null);

  // Form states for creation
  const [formData, setFormData] = useState<{
    items: Array<{ product_name: string; planned_qty: number; unit: string; unit_price: number; line_total: number; date: string }>;
    planned_start_date: string;
    planned_end_date: string;
    notes: string;
  }>({
    items: [],
    planned_start_date: "",
    planned_end_date: "",
    notes: "",
  });

  // Fetch unapproved POs (awaiting production)
  const { data: pendingPos = [], isLoading: loadingPos } = useQuery({
    queryKey: ["pending-pos"],
    queryFn: async () => {
      try {
        const { data: allPos, error: posError } = await (supabase as any)
          .from("customer_po_inbox")
          .select("*")
          .eq("match_status", "approved")
          .order("created_at", { ascending: false });

        if (posError) throw posError;

        // Get all POs already linked to production orders
        const { data: linkedPos, error: linkedError } = await (supabase as any)
          .from("production_orders")
          .select("source_po_inbox_id");

        if (linkedError) throw linkedError;

        const linkedPoIds = new Set(linkedPos.map((p: any) => p.source_po_inbox_id));

        // Filter out linked POs
        return (allPos || []).filter(
          (po: any) => !linkedPoIds.has(po.id)
        ) as CustomerPoInbox[];
      } catch (error) {
        console.error("Error fetching pending POs:", error);
        toast.error(isVi ? "Không thể tải danh sách PO" : "Failed to load POs");
        return [];
      }
    },
  });

  // Fetch production orders
  const { data: productionOrders = [], isLoading: loadingOrders } = useQuery({
    queryKey: ["production-orders"],
    queryFn: async () => {
      try {
        const { data: orders, error: ordersError } = await (supabase as any)
          .from("production_orders")
          .select("*")
          .order("created_at", { ascending: false });

        if (ordersError) throw ordersError;

        // Fetch items for each order
        const ordersWithItems = await Promise.all(
          (orders || []).map(async (order: any) => {
            const { data: items, error: itemsError } = await (supabase as any)
              .from("production_order_items")
              .select("*")
              .eq("production_order_id", order.id);

            if (itemsError) console.error("Error fetching order items:", itemsError);

            return {
              ...order,
              items_count: (items || []).length,
            };
          })
        );

        return ordersWithItems as ProductionOrder[];
      } catch (error) {
        console.error("Error fetching production orders:", error);
        toast.error(
          isVi ? "Không thể tải danh sách lệnh sản xuất" : "Failed to load production orders"
        );
        return [];
      }
    },
  });

  // Fetch production order items
  const { data: orderItems = {} } = useQuery({
    queryKey: ["production-order-items", expandedOrderId],
    queryFn: async () => {
      if (!expandedOrderId) return {};

      try {
        const { data: items, error } = await (supabase as any)
          .from("production_order_items")
          .select("*")
          .eq("production_order_id", expandedOrderId)
          .order("created_at");

        if (error) throw error;

        return { [expandedOrderId]: items || [] };
      } catch (error) {
        console.error("Error fetching order items:", error);
        return {};
      }
    },
    enabled: !!expandedOrderId,
  });

  // Create production order mutation
  const createProductionOrderMutation = useMutation({
    mutationFn: async (input: CreateProductionOrderInput) => {
      try {
        // Generate production number: SX-YYYYMMDD-NNN
        const now = new Date();
        const dateStr = format(now, "yyyyMMdd");

        // Get count of orders created today to generate sequence
        const { data: todayOrders, error: countError } = await (supabase as any)
          .from("production_orders")
          .select("id", { count: "exact", head: true })
          .gte("created_at", format(now, "yyyy-MM-dd'T'00:00:00"))
          .lte("created_at", format(now, "yyyy-MM-dd'T'23:59:59"));

        if (countError) throw countError;

        const sequence = ((todayOrders || []).length || 0) + 1;
        const sequenceStr = String(sequence).padStart(3, "0");
        const productionNumber = `SX-${dateStr}-${sequenceStr}`;

        // Insert production order
        const { data: newOrder, error: orderError } = await (supabase as any)
          .from("production_orders")
          .insert({
            production_number: productionNumber,
            source_po_inbox_id: input.po_id,
            status: "draft",
            planned_start_date: input.planned_start_date || null,
            planned_end_date: input.planned_end_date || null,
            notes: input.notes || null,
          })
          .select()
          .single();

        if (orderError) throw orderError;

        // Insert order items
        const itemsToInsert = input.items.map((item) => ({
          production_order_id: newOrder.id,
          product_name: item.product_name,
          planned_qty: item.planned_qty,
          completed_qty: 0,
          unit: item.unit,
          unit_price: item.unit_price,
          line_total: item.line_total,
          line_complete: false,
          delivery_date: item.date,
          notes: null,
        }));

        const { error: itemsError } = await (supabase as any)
          .from("production_order_items")
          .insert(itemsToInsert);

        if (itemsError) {
          // Rollback order if items failed
          await (supabase as any)
            .from("production_orders")
            .delete()
            .eq("id", newOrder.id);
          throw itemsError;
        }

        return newOrder;
      } catch (error: any) {
        console.error("Error creating production order:", error);
        throw error;
      }
    },
    onSuccess: (order) => {
      queryClient.invalidateQueries({ queryKey: ["pending-pos"] });
      queryClient.invalidateQueries({ queryKey: ["production-orders"] });
      toast.success(
        isVi
          ? `Tạo lệnh sản xuất ${order.production_number} thành công`
          : `Production order ${order.production_number} created successfully`
      );
      setCreateDialogOpen(false);
      setSelectedPoForCreation(null);
      setFormData({ items: [], planned_start_date: "", planned_end_date: "", notes: "" });
    },
    onError: (error: any) => {
      console.error("Mutation error:", error);
      toast.error(
        isVi
          ? "Không thể tạo lệnh sản xuất. Vui lòng thử lại."
          : "Failed to create production order. Please try again."
      );
    },
  });

  // Format date function
  const formatDate = (dateString: string | null) => {
    if (!dateString) return "-";
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return "-";
      return format(date, "dd/MM/yyyy", { locale });
    } catch {
      return "-";
    }
  };

  // Get status badge
  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return (
          <Badge variant="secondary">
            <Clock className="h-3 w-3 mr-1" />
            {isVi ? "Nháp" : "Draft"}
          </Badge>
        );
      case "planned":
        return (
          <Badge className="bg-blue-500">
            <CalendarDays className="h-3 w-3 mr-1" />
            {isVi ? "Đã lên kế hoạch" : "Planned"}
          </Badge>
        );
      case "in_progress":
        return (
          <Badge className="bg-amber-500">
            <Zap className="h-3 w-3 mr-1" />
            {isVi ? "Đang thực hiện" : "In Progress"}
          </Badge>
        );
      case "completed":
        return (
          <Badge className="bg-green-500">
            <CheckCircle className="h-3 w-3 mr-1" />
            {isVi ? "Hoàn thành" : "Completed"}
          </Badge>
        );
      case "cancelled":
        return (
          <Badge variant="destructive">
            <AlertCircle className="h-3 w-3 mr-1" />
            {isVi ? "Hủy" : "Cancelled"}
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  // Calculate stats
  const stats = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return {
      pendingPos: pendingPos.length,
      inProgressOrders: productionOrders.filter((o) => o.status === "in_progress").length,
      completedToday: productionOrders.filter((o) => {
        if (o.status !== "completed" || !o.completed_at) return false;
        const completedDate = new Date(o.completed_at);
        completedDate.setHours(0, 0, 0, 0);
        return completedDate.getTime() === today.getTime();
      }).length,
    };
  }, [pendingPos, productionOrders]);

  // Handle create production order click
  const handleCreateClick = (po: CustomerPoInbox) => {
    setSelectedPoForCreation(po);
    const items = (po.production_items || []).map((item) => ({
      product_name: item.product_name,
      planned_qty: item.qty,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: item.line_total,
      date: item.date,
    }));
    setFormData({
      items,
      planned_start_date: "",
      planned_end_date: "",
      notes: "",
    });
    setCreateDialogOpen(true);
  };

  // Handle form submission
  const handleSubmitCreate = async () => {
    if (!selectedPoForCreation) return;

    if (!formData.planned_start_date) {
      toast.error(isVi ? "Vui lòng chọn ngày bắt đầu" : "Please select start date");
      return;
    }

    if (!formData.planned_end_date) {
      toast.error(isVi ? "Vui lòng chọn ngày kết thúc" : "Please select end date");
      return;
    }

    await createProductionOrderMutation.mutateAsync({
      po_id: selectedPoForCreation.id,
      po_number: selectedPoForCreation.po_number,
      from_name: selectedPoForCreation.from_name,
      items: formData.items,
      planned_start_date: formData.planned_start_date,
      planned_end_date: formData.planned_end_date,
      notes: formData.notes,
    });
  };

  const pendingPosEmpty = !loadingPos && pendingPos.length === 0;
  const ordersEmpty = !loadingOrders && productionOrders.length === 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">
            {isVi ? "Lập kế hoạch sản xuất" : "Production Planning"}
          </h1>
          <p className="text-muted-foreground">
            {isVi
              ? "Quản lý đơn hàng khách và tạo lệnh sản xuất"
              : "Manage customer orders and create production orders"}
          </p>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{isVi ? "PO chờ sản xuất" : "POs Awaiting Production"}</CardDescription>
            <CardTitle className="text-2xl flex items-center gap-2">
              {loadingPos ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                stats.pendingPos
              )}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{isVi ? "Lệnh SX đang thực hiện" : "Orders In Progress"}</CardDescription>
            <CardTitle className="text-2xl text-amber-600">
              {stats.inProgressOrders}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{isVi ? "Hoàn thành hôm nay" : "Completed Today"}</CardDescription>
            <CardTitle className="text-2xl text-green-600">
              {stats.completedToday}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Section 1: Pending POs */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            {isVi ? "PO bán hàng chờ sản xuất" : "Sales POs Awaiting Production"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loadingPos ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : pendingPosEmpty ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Package className="h-12 w-12 text-muted-foreground mb-2" />
              <p className="text-muted-foreground">
                {isVi ? "Không có PO nào chờ sản xuất" : "No POs awaiting production"}
              </p>
            </div>
          ) : (
            <ScrollArea className="w-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{isVi ? "Mã PO" : "PO Number"}</TableHead>
                    <TableHead>{isVi ? "Khách hàng" : "Customer"}</TableHead>
                    <TableHead>{isVi ? "Ngày giao" : "Delivery Date"}</TableHead>
                    <TableHead>{isVi ? "Số lượng loại" : "Items"}</TableHead>
                    <TableHead>{isVi ? "Tổng tiền" : "Total Amount"}</TableHead>
                    <TableHead>{isVi ? "Thao tác" : "Actions"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingPos.map((po) => (
                    <TableRow key={po.id}>
                      <TableCell className="font-mono font-medium">{po.po_number}</TableCell>
                      <TableCell>{po.from_name}</TableCell>
                      <TableCell>{formatDate(po.delivery_date)}</TableCell>
                      <TableCell>
                        {(po.production_items || []).length}{" "}
                        {isVi ? "loại" : "items"}
                      </TableCell>
                      <TableCell className="font-medium">
                        {(po.total_amount || 0).toLocaleString("vi-VN", {
                          style: "currency",
                          currency: "VND",
                          minimumFractionDigits: 0,
                        })}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setExpandedPoId(expandedPoId === po.id ? null : po.id)
                            }
                          >
                            <Eye className="h-4 w-4 mr-1" />
                            {isVi ? "Xem" : "View"}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleCreateClick(po)}
                            disabled={createProductionOrderMutation.isPending}
                          >
                            <Plus className="h-4 w-4 mr-1" />
                            {isVi ? "Tạo SX" : "Create"}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}

          {/* Expanded PO Details */}
          {expandedPoId && (
            <div className="border-t p-4 bg-muted/50">
              <h4 className="font-semibold mb-3">
                {isVi ? "Chi tiết hàng hóa" : "Order Items"}
              </h4>
              <div className="space-y-2">
                {(
                  pendingPos.find((p) => p.id === expandedPoId)
                    ?.production_items || []
                ).map((item, idx) => (
                  <div
                    key={idx}
                    className="flex justify-between items-center text-sm p-2 bg-background rounded"
                  >
                    <div>
                      <p className="font-medium">{item.product_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {isVi ? "Giao dịch ngày" : "Delivery"}:{" "}
                        {formatDate(item.date)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium">
                        {item.qty} {item.unit}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(item.line_total || 0).toLocaleString("vi-VN", {
                          style: "currency",
                          currency: "VND",
                          minimumFractionDigits: 0,
                        })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2: Production Orders */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Factory className="h-5 w-5" />
            {isVi ? "Lệnh sản xuất" : "Production Orders"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loadingOrders ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : ordersEmpty ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Factory className="h-12 w-12 text-muted-foreground mb-2" />
              <p className="text-muted-foreground">
                {isVi ? "Chưa có lệnh sản xuất nào" : "No production orders yet"}
              </p>
            </div>
          ) : (
            <ScrollArea className="w-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{isVi ? "Mã LSX" : "Production #"}</TableHead>
                    <TableHead>{isVi ? "PO nguồn" : "Source PO"}</TableHead>
                    <TableHead>{isVi ? "Khách hàng" : "Customer"}</TableHead>
                    <TableHead>{isVi ? "Trạng thái" : "Status"}</TableHead>
                    <TableHead>{isVi ? "Ngày dự kiến" : "Planned Date"}</TableHead>
                    <TableHead>{isVi ? "Số mục" : "Items"}</TableHead>
                    <TableHead>{isVi ? "Thao tác" : "Actions"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {productionOrders.map((order) => (
                    <TableRow key={order.id}>
                      <TableCell className="font-mono font-medium">
                        {order.production_number}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {order.po_number || "-"}
                      </TableCell>
                      <TableCell>{order.customer_name || "-"}</TableCell>
                      <TableCell>{getStatusBadge(order.status)}</TableCell>
                      <TableCell>
                        {order.planned_start_date
                          ? `${formatDate(
                              order.planned_start_date
                            )} - ${formatDate(
                              order.planned_end_date
                            )}`
                          : "-"}
                      </TableCell>
                      <TableCell>{order.items_count || 0}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setExpandedOrderId(
                              expandedOrderId === order.id ? null : order.id
                            )
                          }
                        >
                          <ChevronDown
                            className="h-4 w-4"
                            style={{
                              transform:
                                expandedOrderId === order.id
                                  ? "rotate(180deg)"
                                  : "",
                              transition: "transform 0.2s",
                            }}
                          />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}

          {/* Expanded Order Items */}
          {expandedOrderId && (
            <div className="border-t p-4 bg-muted/50">
              <h4 className="font-semibold mb-3">
                {isVi ? "Chi tiết hàng sản xuất" : "Production Items"}
              </h4>
              <div className="space-y-3">
                {((orderItems[expandedOrderId] as ProductionOrderItem[]) || []).length >
                0 ? (
                  ((orderItems[expandedOrderId] as ProductionOrderItem[]) || []).map(
                    (item) => (
                      <div
                        key={item.id}
                        className="p-3 bg-background rounded border"
                      >
                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <p className="font-medium">{item.product_name}</p>
                            <p className="text-xs text-muted-foreground">
                              {isVi ? "Giao dịch ngày" : "Delivery"}:{" "}
                              {formatDate(item.delivery_date)}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="font-medium">
                              {item.planned_qty} {item.unit}
                            </p>
                            {item.completed_qty > 0 && (
                              <p className="text-xs text-green-600">
                                {isVi ? "Hoàn thành" : "Completed"}:{" "}
                                {item.completed_qty}
                              </p>
                            )}
                          </div>
                        </div>
                        {item.notes && (
                          <p className="text-xs text-muted-foreground italic">
                            {item.notes}
                          </p>
                        )}
                      </div>
                    )
                  )
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {isVi ? "Không có hàng nào" : "No items"}
                  </p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Production Order Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {isVi ? "Tạo lệnh sản xuất" : "Create Production Order"}
            </DialogTitle>
          </DialogHeader>

          {selectedPoForCreation && (
            <div className="space-y-4">
              {/* PO Info */}
              <div className="bg-muted p-3 rounded">
                <p className="text-sm font-semibold">
                  {isVi ? "PO:" : "PO:"} {selectedPoForCreation.po_number}
                </p>
                <p className="text-sm text-muted-foreground">
                  {selectedPoForCreation.from_name}
                </p>
              </div>

              {/* Items */}
              <div>
                <Label className="text-base font-semibold">
                  {isVi ? "Hàng hóa sản xuất" : "Production Items"}
                </Label>
                <div className="space-y-3 mt-2">
                  {formData.items.map((item, idx) => (
                    <div
                      key={idx}
                      className="border rounded p-3 space-y-2"
                    >
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div>
                          <p className="font-medium">{item.product_name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(item.date)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-muted-foreground text-xs">
                            {isVi ? "Giá" : "Price"}:{" "}
                            {(item.unit_price || 0).toLocaleString("vi-VN")}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Label className="text-xs">
                          {isVi ? "Số lượng dự kiến" : "Planned Qty"}
                        </Label>
                        <Input
                          type="number"
                          min="0"
                          value={item.planned_qty}
                          onChange={(e) => {
                            const newItems = [...formData.items];
                            newItems[idx].planned_qty = parseInt(e.target.value) || 0;
                            newItems[idx].line_total =
                              newItems[idx].planned_qty * item.unit_price;
                            setFormData({
                              ...formData,
                              items: newItems,
                            });
                          }}
                          className="w-24"
                        />
                        <span className="text-sm">{item.unit}</span>
                        <span className="text-sm font-medium ml-auto">
                          {(item.line_total || 0).toLocaleString("vi-VN", {
                            style: "currency",
                            currency: "VND",
                            minimumFractionDigits: 0,
                          })}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Dates */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="start-date">
                    {isVi ? "Ngày bắt đầu dự kiến" : "Planned Start Date"}
                  </Label>
                  <Input
                    id="start-date"
                    type="date"
                    value={formData.planned_start_date}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        planned_start_date: e.target.value,
                      })
                    }
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="end-date">
                    {isVi ? "Ngày kết thúc dự kiến" : "Planned End Date"}
                  </Label>
                  <Input
                    id="end-date"
                    type="date"
                    value={formData.planned_end_date}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        planned_end_date: e.target.value,
                      })
                    }
                    className="mt-1"
                  />
                </div>
              </div>

              {/* Notes */}
              <div>
                <Label htmlFor="notes">
                  {isVi ? "Ghi chú" : "Notes"}
                </Label>
                <Textarea
                  id="notes"
                  placeholder={isVi ? "Nhập ghi chú..." : "Enter notes..."}
                  value={formData.notes}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      notes: e.target.value,
                    })
                  }
                  className="mt-1"
                  rows={3}
                />
              </div>

              {/* Buttons */}
              <div className="flex gap-2 justify-end pt-4">
                <Button
                  variant="outline"
                  onClick={() => setCreateDialogOpen(false)}
                  disabled={createProductionOrderMutation.isPending}
                >
                  {isVi ? "Hủy" : "Cancel"}
                </Button>
                <Button
                  onClick={handleSubmitCreate}
                  disabled={createProductionOrderMutation.isPending}
                >
                  {createProductionOrderMutation.isPending && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  {isVi ? "Tạo lệnh SX" : "Create Order"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
