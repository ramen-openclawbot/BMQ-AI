import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Truck, Plus, PackageCheck, Loader2, MapPin } from "lucide-react";
import { format } from "date-fns";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type DispatchStatus = "pending" | "picked" | "dispatched" | "delivered";

interface DispatchItem {
  id: string;
  dispatch_id: string;
  product_name: string;
  quantity: number;
  unit: string;
}

interface Dispatch {
  id: string;
  dispatch_number: string;
  production_order_id: string;
  customer_id: string;
  status: DispatchStatus;
  dispatch_date: string;
  delivered_date: string | null;
  delivery_address: string;
  notes: string | null;
  created_at: string;
  production_order?: {
    production_number: string;
    customer_id: string;
  };
  customer?: {
    name: string;
  };
  items?: DispatchItem[];
}

interface ProductionOrder {
  id: string;
  production_number: string;
  customer_id: string;
  status: string;
  mini_crm_customers?: {
    name: string;
  };
}

const statusConfig: Record<DispatchStatus, { label: string; color: string }> = {
  pending: { label: "Chờ xuất kho", color: "bg-gray-500" },
  picked: { label: "Đang lấy hàng", color: "bg-blue-500" },
  dispatched: { label: "Đã xuất kho", color: "bg-amber-500" },
  delivered: { label: "Đã giao", color: "bg-green-500" },
};

export default function WarehouseDispatch() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<DispatchStatus | "all">("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [selectedDispatch, setSelectedDispatch] = useState<Dispatch | null>(null);

  // Form state for create dialog
  const [formData, setFormData] = useState({
    production_order_id: "",
    dispatch_date: format(new Date(), "yyyy-MM-dd"),
    delivery_address: "",
    notes: "",
    items: [] as Array<{ id: string; product_name: string; quantity: number; unit: string }>,
  });

  // Fetch dispatches
  const { data: dispatches = [], isLoading: dispatchesLoading } = useQuery({
    queryKey: ["warehouse_dispatches"],
    queryFn: async () => {
      const query = (supabase as any)
        .from("warehouse_dispatches")
        .select(
          `
          id,
          dispatch_number,
          production_order_id,
          customer_id,
          status,
          dispatch_date,
          delivered_date,
          delivery_address,
          notes,
          created_at,
          production_orders (
            production_number
          ),
          mini_crm_customers (
            name
          )
        `,
        )
        .order("created_at", { ascending: false });

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  });

  // Fetch production orders for create dialog
  const { data: productionOrders = [] } = useQuery({
    queryKey: ["production_orders_for_dispatch"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("production_orders")
        .select("id, production_number, customer_id, status, mini_crm_customers (name)")
        .in("status", ["completed", "qa_approved"])
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data || [];
    },
  });

  // Fetch dispatch items
  const { data: dispatchItems = [] } = useQuery({
    queryKey: ["warehouse_dispatch_items"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("warehouse_dispatch_items")
        .select("*");

      if (error) throw error;
      return data || [];
    },
  });

  // Fetch production order items for selected order
  const { data: productionOrderItems = [] } = useQuery({
    queryKey: ["production_order_items", formData.production_order_id],
    queryFn: async () => {
      if (!formData.production_order_id) return [];

      const { data, error } = await (supabase as any)
        .from("production_order_items")
        .select("id, product_name, actual_qty, unit")
        .eq("production_order_id", formData.production_order_id)
        .gt("actual_qty", 0);

      if (error) throw error;
      return data || [];
    },
    enabled: !!formData.production_order_id,
  });

  // Create dispatch mutation
  const createDispatchMutation = useMutation({
    mutationFn: async () => {
      // Generate dispatch number: XK-YYYYMMDD-NNN
      const now = new Date();
      const dateStr = format(now, "yyyyMMdd");
      const countResponse = await (supabase as any)
        .from("warehouse_dispatches")
        .select("id")
        .ilike("dispatch_number", `XK-${dateStr}-%`);

      const count = (countResponse.data || []).length;
      const sequence = String(count + 1).padStart(3, "0");
      const dispatch_number = `XK-${dateStr}-${sequence}`;

      // Create dispatch
      const { data: dispatchData, error: dispatchError } = await (supabase as any)
        .from("warehouse_dispatches")
        .insert({
          dispatch_number,
          production_order_id: formData.production_order_id,
          customer_id: productionOrders.find((o) => o.id === formData.production_order_id)?.customer_id,
          status: "pending",
          dispatch_date: formData.dispatch_date,
          delivery_address: formData.delivery_address,
          notes: formData.notes,
        })
        .select()
        .single();

      if (dispatchError) throw dispatchError;

      // Create dispatch items
      const itemsToInsert = formData.items.map((item) => ({
        dispatch_id: dispatchData.id,
        product_name: item.product_name,
        quantity: item.quantity,
        unit: item.unit,
      }));

      if (itemsToInsert.length > 0) {
        const { error: itemsError } = await (supabase as any)
          .from("warehouse_dispatch_items")
          .insert(itemsToInsert);

        if (itemsError) throw itemsError;
      }

      return dispatchData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["warehouse_dispatches"] });
      queryClient.invalidateQueries({ queryKey: ["warehouse_dispatch_items"] });
      toast({
        title: "Thành công",
        description: "Phiếu xuất kho được tạo thành công",
      });
      setCreateDialogOpen(false);
      resetForm();
    },
    onError: (error) => {
      toast({
        title: "Lỗi",
        description: "Không thể tạo phiếu xuất kho",
        variant: "destructive",
      });
      console.error(error);
    },
  });

  // Update dispatch status mutation
  const updateStatusMutation = useMutation({
    mutationFn: async ({ dispatchId, newStatus }: { dispatchId: string; newStatus: DispatchStatus }) => {
      const updateData: any = { status: newStatus };

      // If transitioning to dispatched, deduct from inventory
      if (newStatus === "dispatched" && selectedDispatch) {
        const dispatch = dispatches.find((d) => d.id === dispatchId);
        if (dispatch) {
          const items = dispatchItems.filter((item) => item.dispatch_id === dispatchId);

          for (const item of items) {
            // Deduct from inventory
            const { data: inventoryItem, error: findError } = await (supabase as any)
              .from("inventory_items")
              .select("id, quantity")
              .eq("product_name", item.product_name)
              .single();

            if (!findError && inventoryItem) {
              const newQuantity = inventoryItem.quantity - item.quantity;

              await (supabase as any)
                .from("inventory_items")
                .update({ quantity: newQuantity })
                .eq("id", inventoryItem.id);

              // Create inventory movement record
              await (supabase as any)
                .from("inventory_movements")
                .insert({
                  inventory_item_id: inventoryItem.id,
                  movement_type: "dispatch_out",
                  quantity: -item.quantity,
                  reference_type: "dispatch",
                  reference_id: dispatchId,
                });
            }
          }
        }
      }

      // If transitioning to delivered, set delivered_date
      if (newStatus === "delivered") {
        updateData.delivered_date = format(new Date(), "yyyy-MM-dd");
      }

      const { data, error } = await (supabase as any)
        .from("warehouse_dispatches")
        .update(updateData)
        .eq("id", dispatchId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["warehouse_dispatches"] });
      toast({
        title: "Thành công",
        description: "Cập nhật trạng thái thành công",
      });
      setDetailDialogOpen(false);
      setSelectedDispatch(null);
    },
    onError: (error) => {
      toast({
        title: "Lỗi",
        description: "Không thể cập nhật trạng thái",
        variant: "destructive",
      });
      console.error(error);
    },
  });

  const resetForm = () => {
    setFormData({
      production_order_id: "",
      dispatch_date: format(new Date(), "yyyy-MM-dd"),
      delivery_address: "",
      notes: "",
      items: [],
    });
  };

  const handleProductionOrderChange = (orderId: string) => {
    setFormData((prev) => ({
      ...prev,
      production_order_id: orderId,
      items: [],
    }));
  };

  const handleProductionOrderItemsSync = () => {
    const items = productionOrderItems.map((item) => ({
      id: item.id,
      product_name: item.product_name,
      quantity: item.actual_qty,
      unit: item.unit,
    }));
    setFormData((prev) => ({ ...prev, items }));
  };

  const handleItemQuantityChange = (index: number, quantity: number) => {
    setFormData((prev) => {
      const newItems = [...prev.items];
      newItems[index].quantity = Math.max(0, quantity);
      return { ...prev, items: newItems };
    });
  };

  const handleRemoveItem = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index),
    }));
  };

  const openDispatchDetail = async (dispatch: Dispatch) => {
    const items = dispatchItems.filter((item) => item.dispatch_id === dispatch.id);
    setSelectedDispatch({
      ...dispatch,
      items,
    });
    setDetailDialogOpen(true);
  };

  // Filter dispatches based on active tab
  const filteredDispatches = activeTab === "all" ? dispatches : dispatches.filter((d) => d.status === activeTab);

  // Calculate stats
  const stats = {
    pending: dispatches.filter((d) => d.status === "pending").length,
    picked: dispatches.filter((d) => d.status === "picked").length,
    dispatched: dispatches.filter((d) => d.status === "dispatched").length,
    delivered: dispatches.filter((d) => d.status === "delivered").length,
  };

  if (dispatchesLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Truck className="h-8 w-8 text-blue-600" />
          <h1 className="text-3xl font-bold">Xuất Kho</h1>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          Tạo phiếu xuất kho
        </Button>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-600">Chờ xuất kho</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats.pending}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-600">Đang lấy hàng</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats.picked}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-600">Đã xuất kho</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats.dispatched}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-600">Đã giao</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats.delivered}</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList>
          <TabsTrigger value="all">Tất cả</TabsTrigger>
          <TabsTrigger value="pending">Chờ xuất</TabsTrigger>
          <TabsTrigger value="picked">Đang lấy</TabsTrigger>
          <TabsTrigger value="dispatched">Đã xuất</TabsTrigger>
          <TabsTrigger value="delivered">Đã giao</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="space-y-4">
          {/* Dispatch List Table */}
          {filteredDispatches.length === 0 ? (
            <Card>
              <CardContent className="pt-8">
                <p className="text-center text-gray-500">Không có phiếu xuất kho</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã phiếu XK</TableHead>
                      <TableHead>Lệnh SX</TableHead>
                      <TableHead>Khách hàng</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead>Ngày xuất</TableHead>
                      <TableHead>Ghi chú</TableHead>
                      <TableHead className="w-32">Hành động</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDispatches.map((dispatch) => (
                      <TableRow key={dispatch.id} className="hover:bg-gray-50 cursor-pointer">
                        <TableCell className="font-medium">{dispatch.dispatch_number}</TableCell>
                        <TableCell>{dispatch.production_order?.production_number || "-"}</TableCell>
                        <TableCell>{dispatch.customer?.name || "-"}</TableCell>
                        <TableCell>
                          <Badge className={`${statusConfig[dispatch.status].color} text-white`}>
                            {statusConfig[dispatch.status].label}
                          </Badge>
                        </TableCell>
                        <TableCell>{format(new Date(dispatch.dispatch_date), "dd/MM/yyyy")}</TableCell>
                        <TableCell className="text-sm text-gray-600 max-w-xs truncate">{dispatch.notes || "-"}</TableCell>
                        <TableCell>
                          <Button variant="outline" size="sm" onClick={() => openDispatchDetail(dispatch)}>
                            <PackageCheck className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Create Dispatch Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Tạo phiếu xuất kho</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Production Order Selection */}
            <div>
              <label className="block text-sm font-medium mb-2">Lệnh SX</label>
              <Select value={formData.production_order_id} onValueChange={handleProductionOrderChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Chọn lệnh SX" />
                </SelectTrigger>
                <SelectContent>
                  {productionOrders.map((order) => (
                    <SelectItem key={order.id} value={order.id}>
                      {order.production_number} - {order.mini_crm_customers?.name || "N/A"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Customer Name (Read-only) */}
            {formData.production_order_id && (
              <div>
                <label className="block text-sm font-medium mb-2">Khách hàng</label>
                <Input
                  value={
                    productionOrders.find((o) => o.id === formData.production_order_id)?.mini_crm_customers?.name ||
                    "N/A"
                  }
                  disabled
                />
              </div>
            )}

            {/* Dispatch Date */}
            <div>
              <label className="block text-sm font-medium mb-2">Ngày xuất</label>
              <Input
                type="date"
                value={formData.dispatch_date}
                onChange={(e) => setFormData((prev) => ({ ...prev, dispatch_date: e.target.value }))}
              />
            </div>

            {/* Delivery Address */}
            <div>
              <label className="block text-sm font-medium mb-2 flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                Địa chỉ giao
              </label>
              <Textarea
                placeholder="Nhập địa chỉ giao hàng"
                value={formData.delivery_address}
                onChange={(e) => setFormData((prev) => ({ ...prev, delivery_address: e.target.value }))}
              />
            </div>

            {/* Items */}
            {formData.production_order_id && (
              <div>
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-sm font-medium">Sản phẩm</label>
                  <Button size="sm" variant="outline" onClick={handleProductionOrderItemsSync}>
                    Đồng bộ sản phẩm
                  </Button>
                </div>

                {formData.items.length === 0 ? (
                  <p className="text-sm text-gray-500">Chưa có sản phẩm</p>
                ) : (
                  <div className="space-y-2 border rounded p-3 bg-gray-50">
                    {formData.items.map((item, index) => (
                      <div key={index} className="flex gap-2 items-center">
                        <div className="flex-1">
                          <p className="text-sm font-medium">{item.product_name}</p>
                        </div>
                        <div className="w-24">
                          <Input
                            type="number"
                            min="0"
                            value={item.quantity}
                            onChange={(e) => handleItemQuantityChange(index, parseInt(e.target.value) || 0)}
                          />
                        </div>
                        <span className="text-sm w-12">{item.unit}</span>
                        <Button variant="ghost" size="sm" onClick={() => handleRemoveItem(index)}>
                          ✕
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium mb-2">Ghi chú</label>
              <Textarea
                placeholder="Nhập ghi chú"
                value={formData.notes}
                onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
              />
            </div>

            {/* Actions */}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                Hủy
              </Button>
              <Button
                onClick={() => createDispatchMutation.mutate()}
                disabled={!formData.production_order_id || formData.items.length === 0 || createDispatchMutation.isPending}
              >
                {createDispatchMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Tạo phiếu xuất kho
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dispatch Detail Dialog */}
      {selectedDispatch && (
        <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Chi tiết xuất kho - {selectedDispatch.dispatch_number}</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              {/* Basic Info */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Lệnh SX</p>
                  <p className="font-medium">{selectedDispatch.production_order?.production_number || "-"}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Khách hàng</p>
                  <p className="font-medium">{selectedDispatch.customer?.name || "-"}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Trạng thái</p>
                  <Badge className={`${statusConfig[selectedDispatch.status].color} text-white`}>
                    {statusConfig[selectedDispatch.status].label}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Ngày xuất</p>
                  <p className="font-medium">{format(new Date(selectedDispatch.dispatch_date), "dd/MM/yyyy")}</p>
                </div>
              </div>

              {/* Delivery Address */}
              <div>
                <p className="text-sm text-gray-600 mb-1">Địa chỉ giao</p>
                <p className="text-sm border rounded p-2 bg-gray-50">{selectedDispatch.delivery_address}</p>
              </div>

              {/* Items */}
              <div>
                <p className="text-sm font-medium mb-2">Sản phẩm</p>
                <div className="border rounded overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tên sản phẩm</TableHead>
                        <TableHead>Số lượng</TableHead>
                        <TableHead>Đơn vị</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedDispatch.items?.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="text-sm">{item.product_name}</TableCell>
                          <TableCell className="text-sm">{item.quantity}</TableCell>
                          <TableCell className="text-sm">{item.unit}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Notes */}
              {selectedDispatch.notes && (
                <div>
                  <p className="text-sm text-gray-600 mb-1">Ghi chú</p>
                  <p className="text-sm border rounded p-2 bg-gray-50">{selectedDispatch.notes}</p>
                </div>
              )}

              {/* Status Transition Buttons */}
              <div className="flex gap-2 justify-end">
                {selectedDispatch.status === "pending" && (
                  <Button
                    onClick={() => updateStatusMutation.mutate({ dispatchId: selectedDispatch.id, newStatus: "picked" })}
                    disabled={updateStatusMutation.isPending}
                  >
                    {updateStatusMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Bắt đầu lấy hàng
                  </Button>
                )}
                {selectedDispatch.status === "picked" && (
                  <Button
                    onClick={() =>
                      updateStatusMutation.mutate({ dispatchId: selectedDispatch.id, newStatus: "dispatched" })
                    }
                    disabled={updateStatusMutation.isPending}
                  >
                    {updateStatusMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Xuất kho
                  </Button>
                )}
                {selectedDispatch.status === "dispatched" && (
                  <Button
                    onClick={() =>
                      updateStatusMutation.mutate({ dispatchId: selectedDispatch.id, newStatus: "delivered" })
                    }
                    disabled={updateStatusMutation.isPending}
                  >
                    {updateStatusMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Xác nhận giao hàng
                  </Button>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
