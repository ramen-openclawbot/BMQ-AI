import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  ClipboardCheck,
  Plus,
  Camera,
  CheckCircle2,
  XCircle,
  Loader2,
  Image,
} from "lucide-react";
import { format } from "date-fns";

interface QAInspection {
  id: string;
  production_order_id: string;
  production_shift_id?: string;
  inspected_by: string;
  inspection_date: string;
  status: "pending" | "approved" | "rejected";
  notes?: string;
  rejection_reason?: string;
  product_photos?: string[];
  created_at: string;
  production_order?: {
    production_number: string;
  };
  production_shift?: {
    shift_name: string;
  };
}

interface QAInspectionItem {
  id: string;
  qa_inspection_id: string;
  product_name: string;
  unit: string;
  inspected_qty: number;
  approved_qty: number;
  rejected_qty: number;
}

interface ProductionOrder {
  id: string;
  production_number: string;
  status: string;
}

export default function QAInspection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filterStatus, setFilterStatus] = useState<"all" | "pending" | "approved" | "rejected">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedInspection, setSelectedInspection] = useState<QAInspection | null>(null);
  const [selectedItems, setSelectedItems] = useState<QAInspectionItem[]>([]);

  // Create form state
  const [createForm, setCreateForm] = useState({
    production_order_id: "",
    production_shift_id: "",
    inspected_by: "",
    notes: "",
    product_photos: [] as string[],
    items: [] as Array<{
      product_name: string;
      unit: string;
      inspected_qty: number;
      approved_qty: number;
      rejected_qty: number;
    }>,
  });

  // Detail form state
  const [detailForm, setDetailForm] = useState({
    rejection_reason: "",
  });

  // Fetch QA inspections
  const { data: inspections = [], isLoading: inspectionsLoading } = useQuery({
    queryKey: ["qa_inspections", filterStatus],
    queryFn: async () => {
      let query = (supabase as any)
        .from("qa_inspections")
        .select(
          `
          *,
          production_order:production_orders(production_number),
          production_shift:production_shifts(shift_name)
        `
        );

      if (filterStatus !== "all") {
        query = query.eq("status", filterStatus);
      }

      const { data, error } = await query.order("created_at", { ascending: false });

      if (error) throw error;
      return data || [];
    },
  });

  // Fetch production orders for create dialog
  const { data: productionOrders = [] } = useQuery({
    queryKey: ["production_orders_active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_orders")
        .select("*")
        .in("status", ["in_progress", "completed"])
        .order("production_number", { ascending: false });

      if (error) throw error;
      return data || [];
    },
  });

  // Fetch production shifts
  const { data: productionShifts = [] } = useQuery({
    queryKey: ["production_shifts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_shifts")
        .select("*")
        .order("shift_date", { ascending: false });

      if (error) throw error;
      return data || [];
    },
  });

  // Fetch QA inspection items
  const { data: inspectionItems = [] } = useQuery({
    queryKey: ["qa_inspection_items", selectedInspection?.id],
    queryFn: async () => {
      if (!selectedInspection?.id) return [];

      const { data, error } = await (supabase as any)
        .from("qa_inspection_items")
        .select("*")
        .eq("qa_inspection_id", selectedInspection.id);

      if (error) throw error;
      return data || [];
    },
    enabled: !!selectedInspection?.id,
  });

  // Stats
  const pendingCount = inspections.filter((i: QAInspection) => i.status === "pending").length;
  const approvedCount = inspections.filter((i: QAInspection) => i.status === "approved").length;
  const rejectedCount = inspections.filter((i: QAInspection) => i.status === "rejected").length;

  // Create QA inspection mutation
  const createMutation = useMutation({
    mutationFn: async (formData: typeof createForm) => {
      const { data: inspection, error: inspectionError } = await (supabase as any)
        .from("qa_inspections")
        .insert({
          production_order_id: formData.production_order_id,
          production_shift_id: formData.production_shift_id || null,
          inspected_by: formData.inspected_by,
          status: "pending",
          notes: formData.notes,
          product_photos: formData.product_photos,
          inspection_date: new Date().toISOString(),
        })
        .select()
        .single();

      if (inspectionError) throw inspectionError;

      // Insert items
      if (formData.items.length > 0) {
        const itemsToInsert = formData.items.map((item) => ({
          qa_inspection_id: inspection.id,
          product_name: item.product_name,
          unit: item.unit,
          inspected_qty: item.inspected_qty,
          approved_qty: item.approved_qty,
          rejected_qty: item.rejected_qty,
        }));

        const { error: itemsError } = await (supabase as any)
          .from("qa_inspection_items")
          .insert(itemsToInsert);

        if (itemsError) throw itemsError;
      }

      return inspection;
    },
    onSuccess: () => {
      toast({
        title: "Thành công",
        description: "Đã tạo phiếu QA",
      });
      queryClient.invalidateQueries({ queryKey: ["qa_inspections"] });
      setCreateOpen(false);
      setCreateForm({
        production_order_id: "",
        production_shift_id: "",
        inspected_by: "",
        notes: "",
        product_photos: [],
        items: [],
      });
    },
    onError: (error) => {
      toast({
        title: "Lỗi",
        description: "Không thể tạo phiếu QA",
        variant: "destructive",
      });
      console.error(error);
    },
  });

  // Approve QA inspection mutation
  const approveMutation = useMutation({
    mutationFn: async (inspection: QAInspection) => {
      // Get items to process
      const { data: items, error: itemsError } = await (supabase as any)
        .from("qa_inspection_items")
        .select("*")
        .eq("qa_inspection_id", inspection.id);

      if (itemsError) throw itemsError;

      // Update QA inspection status
      const { error: updateError } = await (supabase as any)
        .from("qa_inspections")
        .update({ status: "approved" })
        .eq("id", inspection.id);

      if (updateError) throw updateError;

      // Process each approved item
      for (const item of items) {
        if (item.approved_qty > 0) {
          // Find or create inventory item for finished good
          const { data: existingInventory } = await (supabase as any)
            .from("inventory_items")
            .select("*")
            .eq("product_name", item.product_name)
            .single();

          let inventoryItemId: string;

          if (existingInventory) {
            // Update existing inventory
            const { error: inventoryUpdateError } = await (supabase as any)
              .from("inventory_items")
              .update({
                quantity: existingInventory.quantity + item.approved_qty,
              })
              .eq("id", existingInventory.id);

            if (inventoryUpdateError) throw inventoryUpdateError;
            inventoryItemId = existingInventory.id;
          } else {
            // Create new inventory item
            const { data: newInventory, error: inventoryCreateError } = await (
              supabase as any
            )
              .from("inventory_items")
              .insert({
                product_name: item.product_name,
                unit: item.unit,
                quantity: item.approved_qty,
                warehouse_location: "Chưa xác định",
              })
              .select()
              .single();

            if (inventoryCreateError) throw inventoryCreateError;
            inventoryItemId = newInventory.id;
          }

          // Insert inventory movement for production output
          const { error: movementError } = await (supabase as any)
            .from("inventory_movements")
            .insert({
              inventory_item_id: inventoryItemId,
              movement_type: "production_output",
              quantity: item.approved_qty,
              reference_type: "qa_inspection",
              reference_id: inspection.id,
              movement_date: new Date().toISOString(),
              notes: `QA duyệt từ phiếu kiểm tra ${inspection.id}`,
            });

          if (movementError) throw movementError;
        }

        // TODO: Implement raw material consumption via BOM
        // Query sku_formulations for finished good to get ingredients
        // Calculate consumed quantity based on approved qty, dosage, and wastage
        // Deduct from inventory_items
        // Insert inventory_movements with movement_type='production_consume'
      }

      return inspection;
    },
    onSuccess: () => {
      toast({
        title: "Thành công",
        description: "Đã duyệt QA & nhập kho thành phẩm",
      });
      queryClient.invalidateQueries({ queryKey: ["qa_inspections"] });
      queryClient.invalidateQueries({ queryKey: ["inventory_items"] });
      setDetailOpen(false);
      setSelectedInspection(null);
    },
    onError: (error) => {
      toast({
        title: "Lỗi",
        description: "Không thể duyệt QA",
        variant: "destructive",
      });
      console.error(error);
    },
  });

  // Reject QA inspection mutation
  const rejectMutation = useMutation({
    mutationFn: async (inspection: QAInspection) => {
      const { error } = await (supabase as any)
        .from("qa_inspections")
        .update({
          status: "rejected",
          rejection_reason: detailForm.rejection_reason,
        })
        .eq("id", inspection.id);

      if (error) throw error;
      return inspection;
    },
    onSuccess: () => {
      toast({
        title: "Thành công",
        description: "Đã từ chối QA",
      });
      queryClient.invalidateQueries({ queryKey: ["qa_inspections"] });
      setDetailOpen(false);
      setSelectedInspection(null);
      setDetailForm({ rejection_reason: "" });
    },
    onError: (error) => {
      toast({
        title: "Lỗi",
        description: "Không thể từ chối QA",
        variant: "destructive",
      });
      console.error(error);
    },
  });

  const handleOpenDetail = async (inspection: QAInspection) => {
    setSelectedInspection(inspection);
    const { data: items } = await (supabase as any)
      .from("qa_inspection_items")
      .select("*")
      .eq("qa_inspection_id", inspection.id);
    setSelectedItems(items || []);
    setDetailOpen(true);
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case "pending":
        return "bg-amber-100 text-amber-800";
      case "approved":
        return "bg-green-100 text-green-800";
      case "rejected":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "pending":
        return "Chờ kiểm tra";
      case "approved":
        return "Đã duyệt";
      case "rejected":
        return "Từ chối";
      default:
        return status;
    }
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ClipboardCheck className="h-8 w-8 text-blue-600" />
          <h1 className="text-3xl font-bold">Kiểm Tra Chất Lượng</h1>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          Tạo phiếu QA
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-600">
              Chờ kiểm tra
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-amber-600">{pendingCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-600">
              Đã duyệt
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600">{approvedCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-600">
              Từ chối
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-red-600">{rejectedCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b">
        {[
          { value: "all", label: "Tất cả" },
          { value: "pending", label: "Chờ kiểm tra" },
          { value: "approved", label: "Đã duyệt" },
          { value: "rejected", label: "Từ chối" },
        ].map((tab) => (
          <button
            key={tab.value}
            onClick={() =>
              setFilterStatus(tab.value as "all" | "pending" | "approved" | "rejected")
            }
            className={`px-4 py-2 font-medium text-sm ${
              filterStatus === tab.value
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mã QA</TableHead>
              <TableHead>Lệnh SX</TableHead>
              <TableHead>Ca SX</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Người kiểm tra</TableHead>
              <TableHead>Ngày kiểm tra</TableHead>
              <TableHead>Ảnh</TableHead>
              <TableHead>Hành động</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {inspectionsLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                </TableCell>
              </TableRow>
            ) : inspections.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-gray-500">
                  Không có dữ liệu
                </TableCell>
              </TableRow>
            ) : (
              inspections.map((inspection: QAInspection) => (
                <TableRow key={inspection.id}>
                  <TableCell className="font-mono text-sm">
                    {inspection.id.slice(0, 8)}
                  </TableCell>
                  <TableCell>
                    {inspection.production_order?.production_number || "-"}
                  </TableCell>
                  <TableCell>
                    {inspection.production_shift?.shift_name || "-"}
                  </TableCell>
                  <TableCell>
                    <Badge className={getStatusBadgeColor(inspection.status)}>
                      {getStatusLabel(inspection.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>{inspection.inspected_by}</TableCell>
                  <TableCell>
                    {format(
                      new Date(inspection.inspection_date),
                      "dd/MM/yyyy HH:mm"
                    )}
                  </TableCell>
                  <TableCell>
                    {inspection.product_photos && inspection.product_photos.length > 0 ? (
                      <div className="flex gap-1">
                        {inspection.product_photos.slice(0, 2).map((photo, idx) => (
                          <Image
                            key={idx}
                            className="h-4 w-4 text-blue-600 cursor-pointer"
                          />
                        ))}
                        {inspection.product_photos.length > 2 && (
                          <span className="text-xs text-gray-500">
                            +{inspection.product_photos.length - 2}
                          </span>
                        )}
                      </div>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenDetail(inspection)}
                    >
                      Chi tiết
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Tạo phiếu QA</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Production Order Select */}
            <div>
              <label className="text-sm font-medium">Lệnh SX</label>
              <select
                className="w-full mt-2 px-3 py-2 border rounded-md"
                value={createForm.production_order_id}
                onChange={(e) =>
                  setCreateForm({
                    ...createForm,
                    production_order_id: e.target.value,
                  })
                }
              >
                <option value="">-- Chọn lệnh SX --</option>
                {productionOrders.map((order: ProductionOrder) => (
                  <option key={order.id} value={order.id}>
                    {order.production_number}
                  </option>
                ))}
              </select>
            </div>

            {/* Production Shift Select */}
            <div>
              <label className="text-sm font-medium">Ca SX (tùy chọn)</label>
              <select
                className="w-full mt-2 px-3 py-2 border rounded-md"
                value={createForm.production_shift_id}
                onChange={(e) =>
                  setCreateForm({
                    ...createForm,
                    production_shift_id: e.target.value,
                  })
                }
              >
                <option value="">-- Chọn ca SX --</option>
                {productionShifts.map((shift: any) => (
                  <option key={shift.id} value={shift.id}>
                    {shift.shift_name} ({format(new Date(shift.shift_date), "dd/MM/yyyy")})
                  </option>
                ))}
              </select>
            </div>

            {/* Inspected By */}
            <div>
              <label className="text-sm font-medium">Người kiểm tra</label>
              <Input
                className="mt-2"
                placeholder="Nhập tên người kiểm tra"
                value={createForm.inspected_by}
                onChange={(e) =>
                  setCreateForm({ ...createForm, inspected_by: e.target.value })
                }
              />
            </div>

            {/* Items Section */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-medium">Mục hàng kiểm tra</label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setCreateForm({
                      ...createForm,
                      items: [
                        ...createForm.items,
                        {
                          product_name: "",
                          unit: "",
                          inspected_qty: 0,
                          approved_qty: 0,
                          rejected_qty: 0,
                        },
                      ],
                    })
                  }
                >
                  <Plus className="h-4 w-4" />
                  Thêm mục
                </Button>
              </div>

              {createForm.items.map((item, idx) => (
                <div key={idx} className="space-y-2 p-3 border rounded-md mb-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder="Tên sản phẩm"
                      value={item.product_name}
                      onChange={(e) => {
                        const updated = [...createForm.items];
                        updated[idx].product_name = e.target.value;
                        setCreateForm({ ...createForm, items: updated });
                      }}
                    />
                    <Input
                      placeholder="Đơn vị"
                      value={item.unit}
                      onChange={(e) => {
                        const updated = [...createForm.items];
                        updated[idx].unit = e.target.value;
                        setCreateForm({ ...createForm, items: updated });
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-xs text-gray-600">Kiểm tra (cái)</label>
                      <Input
                        type="number"
                        value={item.inspected_qty}
                        onChange={(e) => {
                          const updated = [...createForm.items];
                          updated[idx].inspected_qty = parseInt(e.target.value) || 0;
                          setCreateForm({ ...createForm, items: updated });
                        }}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-600">Duyệt (cái)</label>
                      <Input
                        type="number"
                        value={item.approved_qty}
                        onChange={(e) => {
                          const updated = [...createForm.items];
                          updated[idx].approved_qty = parseInt(e.target.value) || 0;
                          setCreateForm({ ...createForm, items: updated });
                        }}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-600">Từ chối (cái)</label>
                      <Input
                        type="number"
                        value={item.rejected_qty}
                        onChange={(e) => {
                          const updated = [...createForm.items];
                          updated[idx].rejected_qty = parseInt(e.target.value) || 0;
                          setCreateForm({ ...createForm, items: updated });
                        }}
                      />
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600 w-full"
                    onClick={() => {
                      setCreateForm({
                        ...createForm,
                        items: createForm.items.filter((_, i) => i !== idx),
                      });
                    }}
                  >
                    Xóa
                  </Button>
                </div>
              ))}
            </div>

            {/* Photo URLs */}
            <div>
              <label className="text-sm font-medium">Ảnh kiểm tra (URL)</label>
              <div className="space-y-2 mt-2">
                {createForm.product_photos.map((photo, idx) => (
                  <div key={idx} className="flex gap-2">
                    <Input
                      value={photo}
                      onChange={(e) => {
                        const updated = [...createForm.product_photos];
                        updated[idx] = e.target.value;
                        setCreateForm({ ...createForm, product_photos: updated });
                      }}
                      placeholder="https://..."
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setCreateForm({
                          ...createForm,
                          product_photos: createForm.product_photos.filter(
                            (_, i) => i !== idx
                          ),
                        });
                      }}
                    >
                      Xóa
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setCreateForm({
                      ...createForm,
                      product_photos: [...createForm.product_photos, ""],
                    })
                  }
                  className="w-full"
                >
                  <Camera className="h-4 w-4 mr-2" />
                  Thêm ảnh
                </Button>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="text-sm font-medium">Ghi chú</label>
              <Textarea
                className="mt-2"
                placeholder="Nhập ghi chú kiểm tra"
                value={createForm.notes}
                onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })}
                rows={3}
              />
            </div>
          </div>

          <div className="flex gap-2 justify-end mt-6">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Hủy
            </Button>
            <Button
              onClick={() => createMutation.mutate(createForm)}
              disabled={createMutation.isPending || !createForm.production_order_id}
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Tạo phiếu
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Chi tiết phiếu QA</DialogTitle>
          </DialogHeader>

          {selectedInspection && (
            <div className="space-y-4">
              {/* Header Info */}
              <div className="grid grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">
                <div>
                  <p className="text-xs text-gray-600">Mã QA</p>
                  <p className="font-mono text-sm">
                    {selectedInspection.id.slice(0, 8)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">Lệnh SX</p>
                  <p className="text-sm">
                    {selectedInspection.production_order?.production_number || "-"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">Người kiểm tra</p>
                  <p className="text-sm">{selectedInspection.inspected_by}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">Ngày kiểm tra</p>
                  <p className="text-sm">
                    {format(
                      new Date(selectedInspection.inspection_date),
                      "dd/MM/yyyy HH:mm"
                    )}
                  </p>
                </div>
                <div className="col-span-2">
                  <p className="text-xs text-gray-600">Trạng thái</p>
                  <Badge className={getStatusBadgeColor(selectedInspection.status)}>
                    {getStatusLabel(selectedInspection.status)}
                  </Badge>
                </div>
              </div>

              {/* Items Table */}
              <div>
                <h3 className="text-sm font-medium mb-2">Các mục hàng</h3>
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Sản phẩm</TableHead>
                        <TableHead>Đơn vị</TableHead>
                        <TableHead>Kiểm tra</TableHead>
                        {selectedInspection.status === "pending" ? (
                          <>
                            <TableHead>Duyệt</TableHead>
                            <TableHead>Từ chối</TableHead>
                          </>
                        ) : (
                          <>
                            <TableHead>Duyệt</TableHead>
                            <TableHead>Từ chối</TableHead>
                          </>
                        )}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedItems.map((item: QAInspectionItem) => (
                        <TableRow key={item.id}>
                          <TableCell className="text-sm">{item.product_name}</TableCell>
                          <TableCell className="text-sm">{item.unit}</TableCell>
                          <TableCell className="text-sm">{item.inspected_qty}</TableCell>
                          <TableCell>
                            {selectedInspection.status === "pending" ? (
                              <Input
                                type="number"
                                value={item.approved_qty}
                                onChange={(e) => {
                                  const updated = selectedItems.map((i) =>
                                    i.id === item.id
                                      ? {
                                          ...i,
                                          approved_qty: parseInt(e.target.value) || 0,
                                        }
                                      : i
                                  );
                                  setSelectedItems(updated);
                                }}
                                className="w-20"
                              />
                            ) : (
                              <span className="text-sm">{item.approved_qty}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">{item.rejected_qty}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Notes */}
              {selectedInspection.notes && (
                <div>
                  <p className="text-sm font-medium mb-2">Ghi chú</p>
                  <p className="text-sm p-3 bg-gray-50 rounded">
                    {selectedInspection.notes}
                  </p>
                </div>
              )}

              {/* Rejection Reason */}
              {selectedInspection.status === "rejected" && selectedInspection.rejection_reason && (
                <div>
                  <p className="text-sm font-medium mb-2">Lý do từ chối</p>
                  <p className="text-sm p-3 bg-red-50 rounded text-red-800">
                    {selectedInspection.rejection_reason}
                  </p>
                </div>
              )}

              {/* Rejection Reason Input - pending only */}
              {selectedInspection.status === "pending" && (
                <div>
                  <label className="text-sm font-medium">Lý do từ chối (nếu cần)</label>
                  <Textarea
                    className="mt-2"
                    placeholder="Nhập lý do từ chối"
                    value={detailForm.rejection_reason}
                    onChange={(e) =>
                      setDetailForm({ rejection_reason: e.target.value })
                    }
                    rows={3}
                  />
                </div>
              )}

              {/* Action Buttons */}
              {selectedInspection.status === "pending" && (
                <div className="flex gap-2 justify-end mt-6">
                  <Button
                    variant="outline"
                    onClick={() => setDetailOpen(false)}
                  >
                    Hủy
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => rejectMutation.mutate(selectedInspection)}
                    disabled={
                      rejectMutation.isPending ||
                      !detailForm.rejection_reason.trim()
                    }
                  >
                    {rejectMutation.isPending && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    Từ chối
                  </Button>
                  <Button
                    onClick={() => {
                      const updatedInspection = {
                        ...selectedInspection,
                      };
                      approveMutation.mutate(updatedInspection);
                    }}
                    disabled={approveMutation.isPending}
                  >
                    {approveMutation.isPending && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Duyệt
                  </Button>
                </div>
              )}

              {selectedInspection.status !== "pending" && (
                <Button
                  variant="outline"
                  onClick={() => setDetailOpen(false)}
                  className="w-full"
                >
                  Đóng
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
