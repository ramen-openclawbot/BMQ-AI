import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CalendarClock,
  Plus,
  Play,
  CheckCircle2,
  Loader2,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
} from "lucide-react";
import { format, addDays, startOfWeek, eachDayOfInterval, parseISO } from "date-fns";
import { vi } from "date-fns/locale";

interface ProductionOrder {
  id: string;
  production_number: string;
  status: string;
  due_date: string;
}

interface ProductionOrderItem {
  id: string;
  production_order_id: string;
  item_name: string;
  planned_qty: number;
  unit: string;
}

interface ProductionShiftItem {
  id: string;
  production_shift_id: string;
  production_order_item_id: string;
  planned_qty: number;
  actual_qty: number | null;
  item_name?: string;
  unit?: string;
}

interface ProductionShift {
  id: string;
  shift_code: string;
  shift_date: string;
  shift_type: "morning" | "afternoon" | "night";
  status: "scheduled" | "in_progress" | "completed" | "cancelled";
  assigned_to: string;
  started_at: string | null;
  completed_at: string | null;
  production_order_id: string;
  production_number?: string;
  items?: ProductionShiftItem[];
}

const shiftTypeLabels = {
  morning: "Sáng",
  afternoon: "Chiều",
  night: "Đêm",
};

const shiftTypeColors = {
  morning: "bg-blue-50 border-blue-200",
  afternoon: "bg-amber-50 border-amber-200",
  night: "bg-slate-100 border-slate-300",
};

const statusBadgeColors = {
  scheduled: "bg-blue-100 text-blue-800",
  in_progress: "bg-amber-100 text-amber-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
};

const statusLabels = {
  scheduled: "Dự kiến",
  in_progress: "Đang chạy",
  completed: "Hoàn thành",
  cancelled: "Hủy",
};

function CreateShiftDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedOrder, setSelectedOrder] = useState<string>("");
  const [shiftDate, setShiftDate] = useState<string>("");
  const [shiftType, setShiftType] = useState<"morning" | "afternoon" | "night">(
    "morning"
  );
  const [assignedTo, setAssignedTo] = useState<string>("");
  const [itemQtys, setItemQtys] = useState<Record<string, number>>({});

  // Fetch production orders
  const { data: orders = [] } = useQuery({
    queryKey: ["production-orders"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("production_orders")
        .select("id, production_number, status, due_date")
        .in("status", ["draft", "planned", "in_progress"]);

      if (error) throw error;
      return data as ProductionOrder[];
    },
  });

  // Fetch items for selected order
  const { data: orderItems = [] } = useQuery({
    queryKey: ["production-order-items", selectedOrder],
    queryFn: async () => {
      if (!selectedOrder) return [];
      const { data, error } = await (supabase as any)
        .from("production_order_items")
        .select("id, production_order_id, item_name, planned_qty, unit")
        .eq("production_order_id", selectedOrder);

      if (error) throw error;
      return data as ProductionOrderItem[];
    },
    enabled: !!selectedOrder,
  });

  // Initialize item quantities when order items load
  useState(() => {
    const newQtys: Record<string, number> = {};
    orderItems.forEach((item) => {
      newQtys[item.id] = item.planned_qty;
    });
    setItemQtys(newQtys);
  }, [orderItems.length]);

  // Create shift mutation
  const createShiftMutation = useMutation({
    mutationFn: async () => {
      if (!selectedOrder || !shiftDate || !assignedTo) {
        throw new Error("Vui lòng điền đầy đủ thông tin");
      }

      // Generate shift code: CA-YYYYMMDD-S/C/T
      const dateStr = shiftDate.replace(/-/g, "");
      const typeCode =
        shiftType === "morning" ? "S" : shiftType === "afternoon" ? "C" : "T";
      const shiftCode = `CA-${dateStr}-${typeCode}`;

      // Insert production shift
      const { data: shiftData, error: shiftError } = await (supabase as any)
        .from("production_shifts")
        .insert({
          shift_code: shiftCode,
          shift_date: shiftDate,
          shift_type: shiftType,
          status: "scheduled",
          assigned_to: assignedTo,
          production_order_id: selectedOrder,
        })
        .select()
        .single();

      if (shiftError) throw shiftError;

      // Insert production shift items
      const itemsToInsert = orderItems.map((item) => ({
        production_shift_id: shiftData.id,
        production_order_item_id: item.id,
        planned_qty: itemQtys[item.id] || item.planned_qty,
        actual_qty: null,
      }));

      if (itemsToInsert.length > 0) {
        const { error: itemsError } = await (supabase as any)
          .from("production_shift_items")
          .insert(itemsToInsert);

        if (itemsError) throw itemsError;
      }

      return shiftData;
    },
    onSuccess: () => {
      toast({
        title: "Thành công",
        description: "Ca sản xuất đã được tạo",
      });
      queryClient.invalidateQueries({ queryKey: ["production-shifts"] });
      onClose();
      setSelectedOrder("");
      setShiftDate("");
      setAssignedTo("");
      setItemQtys({});
    },
    onError: (error) => {
      toast({
        title: "Lỗi",
        description: error instanceof Error ? error.message : "Không thể tạo ca",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Tạo ca sản xuất</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Production Order Select */}
          <div>
            <label className="text-sm font-medium">Đơn hàng sản xuất</label>
            <Select value={selectedOrder} onValueChange={setSelectedOrder}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn đơn hàng" />
              </SelectTrigger>
              <SelectContent>
                {orders.map((order) => (
                  <SelectItem key={order.id} value={order.id}>
                    {order.production_number}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date Picker */}
          <div>
            <label className="text-sm font-medium">Ngày ca</label>
            <Input
              type="date"
              value={shiftDate}
              onChange={(e) => setShiftDate(e.target.value)}
            />
          </div>

          {/* Shift Type Select */}
          <div>
            <label className="text-sm font-medium">Loại ca</label>
            <Select
              value={shiftType}
              onValueChange={(value) =>
                setShiftType(value as "morning" | "afternoon" | "night")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="morning">Sáng</SelectItem>
                <SelectItem value="afternoon">Chiều</SelectItem>
                <SelectItem value="night">Đêm</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Assigned To */}
          <div>
            <label className="text-sm font-medium">Người phụ trách</label>
            <Input
              placeholder="Nhập tên người phụ trách"
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
            />
          </div>

          {/* Items */}
          {selectedOrder && orderItems.length > 0 && (
            <div>
              <label className="text-sm font-medium">Sản phẩm</label>
              <div className="space-y-2 max-h-48 overflow-y-auto border rounded p-2">
                {orderItems.map((item) => (
                  <div key={item.id} className="flex gap-2 items-center">
                    <div className="flex-1">
                      <span className="text-sm">{item.item_name}</span>
                    </div>
                    <Input
                      type="number"
                      className="w-20 h-8"
                      value={itemQtys[item.id] || item.planned_qty}
                      onChange={(e) =>
                        setItemQtys({
                          ...itemQtys,
                          [item.id]: parseInt(e.target.value) || 0,
                        })
                      }
                      min="0"
                    />
                    <span className="text-sm text-gray-500 w-12">
                      {item.unit}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Buttons */}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onClose}>
              Hủy
            </Button>
            <Button
              onClick={() => createShiftMutation.mutate()}
              disabled={
                !selectedOrder ||
                !shiftDate ||
                !assignedTo ||
                createShiftMutation.isPending
              }
            >
              {createShiftMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Tạo ca
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShiftDetailDialog({
  shift,
  isOpen,
  onClose,
}: {
  shift: ProductionShift | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [actualQtys, setActualQtys] = useState<Record<string, number>>({});

  // Fetch shift details on open
  const { data: fullShift } = useQuery({
    queryKey: ["production-shift", shift?.id],
    queryFn: async () => {
      if (!shift?.id) return null;

      const { data, error } = await (supabase as any)
        .from("production_shifts")
        .select(
          `
          *,
          production_orders (production_number),
          production_shift_items (
            id,
            planned_qty,
            actual_qty,
            production_order_items (item_name, unit)
          )
        `
        )
        .eq("id", shift.id)
        .single();

      if (error) throw error;

      // Flatten the items structure
      const items =
        data.production_shift_items?.map((item: any) => ({
          ...item,
          item_name: item.production_order_items?.item_name,
          unit: item.production_order_items?.unit,
        })) || [];

      return { ...data, items };
    },
    enabled: isOpen && !!shift?.id,
  });

  // Start shift mutation
  const startShiftMutation = useMutation({
    mutationFn: async () => {
      if (!shift?.id) throw new Error("No shift selected");

      const { error } = await (supabase as any)
        .from("production_shifts")
        .update({
          status: "in_progress",
          started_at: new Date().toISOString(),
        })
        .eq("id", shift.id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast({
        title: "Thành công",
        description: "Ca đã bắt đầu",
      });
      queryClient.invalidateQueries({ queryKey: ["production-shifts"] });
      queryClient.invalidateQueries({ queryKey: ["production-shift"] });
    },
    onError: (error) => {
      toast({
        title: "Lỗi",
        description: error instanceof Error ? error.message : "Không thể bắt đầu ca",
        variant: "destructive",
      });
    },
  });

  // Complete shift mutation
  const completeShiftMutation = useMutation({
    mutationFn: async () => {
      if (!shift?.id) throw new Error("No shift selected");

      // Update actual quantities
      const updates = fullShift?.items
        ?.filter((item: any) => actualQtys[item.id])
        .map((item: any) => ({
          id: item.id,
          actual_qty: actualQtys[item.id] || item.actual_qty || 0,
        }));

      if (updates && updates.length > 0) {
        for (const update of updates) {
          const { error } = await (supabase as any)
            .from("production_shift_items")
            .update({ actual_qty: update.actual_qty })
            .eq("id", update.id);

          if (error) throw error;
        }
      }

      // Update shift status
      const { error } = await (supabase as any)
        .from("production_shifts")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", shift.id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast({
        title: "Thành công",
        description: "Ca đã hoàn thành",
      });
      queryClient.invalidateQueries({ queryKey: ["production-shifts"] });
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Lỗi",
        description: error instanceof Error ? error.message : "Không thể hoàn thành ca",
        variant: "destructive",
      });
    },
  });

  if (!fullShift) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Chi tiết ca: {fullShift.shift_code}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Shift Info */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-600">Đơn hàng:</span>
              <p className="font-medium">{fullShift.production_orders?.production_number}</p>
            </div>
            <div>
              <span className="text-gray-600">Ngày ca:</span>
              <p className="font-medium">
                {format(parseISO(fullShift.shift_date), "dd/MM/yyyy")}
              </p>
            </div>
            <div>
              <span className="text-gray-600">Loại ca:</span>
              <p className="font-medium">
                {shiftTypeLabels[fullShift.shift_type as keyof typeof shiftTypeLabels]}
              </p>
            </div>
            <div>
              <span className="text-gray-600">Người phụ trách:</span>
              <p className="font-medium">{fullShift.assigned_to}</p>
            </div>
          </div>

          {/* Items Table */}
          <div>
            <label className="text-sm font-medium">Sản phẩm</label>
            <div className="border rounded overflow-hidden text-sm">
              <div className="bg-gray-100 grid grid-cols-4 gap-2 p-2 font-medium">
                <span>Sản phẩm</span>
                <span className="text-center">Đơn vị</span>
                <span className="text-center">Kế hoạch</span>
                <span className="text-center">Thực tế</span>
              </div>
              <div className="divide-y max-h-48 overflow-y-auto">
                {fullShift.items?.map((item: any) => (
                  <div key={item.id} className="grid grid-cols-4 gap-2 p-2 items-center">
                    <span>{item.item_name}</span>
                    <span className="text-center text-gray-600">{item.unit}</span>
                    <span className="text-center">{item.planned_qty}</span>
                    <Input
                      type="number"
                      className="h-8 text-center"
                      value={actualQtys[item.id] ?? item.actual_qty ?? ""}
                      onChange={(e) =>
                        setActualQtys({
                          ...actualQtys,
                          [item.id]: parseInt(e.target.value) || 0,
                        })
                      }
                      disabled={
                        fullShift.status === "completed" ||
                        fullShift.status === "cancelled"
                      }
                      min="0"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2 justify-end pt-4">
            <Button variant="outline" onClick={onClose}>
              Đóng
            </Button>
            {fullShift.status === "scheduled" && (
              <Button
                onClick={() => startShiftMutation.mutate()}
                disabled={startShiftMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {startShiftMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                <Play className="mr-2 h-4 w-4" />
                Bắt đầu ca
              </Button>
            )}
            {fullShift.status === "in_progress" && (
              <Button
                onClick={() => completeShiftMutation.mutate()}
                disabled={completeShiftMutation.isPending}
                className="bg-green-600 hover:bg-green-700"
              >
                {completeShiftMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Hoàn thành ca
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShiftCard({
  shift,
  onOpen,
}: {
  shift: ProductionShift;
  onOpen: (shift: ProductionShift) => void;
}) {
  return (
    <Card
      className={`border ${shiftTypeColors[shift.shift_type]} cursor-pointer hover:shadow-md transition-shadow`}
      onClick={() => onOpen(shift)}
    >
      <CardContent className="p-3">
        <div className="space-y-2">
          <div className="flex justify-between items-start gap-2">
            <div>
              <p className="font-semibold text-sm">{shift.shift_code}</p>
              <p className="text-xs text-gray-600">{shift.production_number}</p>
            </div>
            <Badge
              variant="secondary"
              className={statusBadgeColors[shift.status]}
            >
              {statusLabels[shift.status]}
            </Badge>
          </div>

          <div className="text-xs space-y-1">
            <p>
              <span className="font-medium">Loại:</span> {shiftTypeLabels[shift.shift_type]}
            </p>
            <p>
              <span className="font-medium">Người:</span> {shift.assigned_to}
            </p>
            {shift.items && shift.items.length > 0 && (
              <p>
                <span className="font-medium">Sản phẩm:</span> {shift.items.length} mục
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProductionShifts() {
  const { toast } = useToast();
  const [currentWeekStart, setCurrentWeekStart] = useState(
    startOfWeek(new Date(), { weekStartsOn: 1 })
  );
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedShift, setSelectedShift] = useState<ProductionShift | null>(
    null
  );
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);

  // Calculate week dates
  const weekDates = eachDayOfInterval({
    start: currentWeekStart,
    end: addDays(currentWeekStart, 6),
  });

  // Fetch shifts for the week
  const { data: shiftsData = [], isLoading, error } = useQuery({
    queryKey: ["production-shifts", currentWeekStart.toISOString()],
    queryFn: async () => {
      const startDate = format(currentWeekStart, "yyyy-MM-dd");
      const endDate = format(addDays(currentWeekStart, 6), "yyyy-MM-dd");

      const { data, error } = await (supabase as any)
        .from("production_shifts")
        .select(
          `
          *,
          production_orders (production_number),
          production_shift_items (
            id,
            production_order_item_id,
            planned_qty,
            actual_qty
          )
        `
        )
        .gte("shift_date", startDate)
        .lte("shift_date", endDate)
        .order("shift_date", { ascending: true })
        .order("shift_type", { ascending: true });

      if (error) throw error;

      return (data || []).map((shift: any) => ({
        ...shift,
        production_number: shift.production_orders?.production_number,
        items: shift.production_shift_items || [],
      }));
    },
  });

  // Group shifts by date
  const shiftsByDate = weekDates.reduce(
    (acc, date) => {
      const dateStr = format(date, "yyyy-MM-dd");
      acc[dateStr] = shiftsData.filter((shift) => shift.shift_date === dateStr);
      return acc;
    },
    {} as Record<string, ProductionShift[]>
  );

  const handleOpenDetail = (shift: ProductionShift) => {
    setSelectedShift(shift);
    setDetailDialogOpen(true);
  };

  const weekStartStr = format(currentWeekStart, "dd/MM");
  const weekEndStr = format(addDays(currentWeekStart, 6), "dd/MM");

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentWeekStart(addDays(currentWeekStart, -7))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <div className="text-lg font-semibold min-w-48 text-center">
            Tuần {weekStartStr} - {weekEndStr}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentWeekStart(addDays(currentWeekStart, 7))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <Button
          onClick={() => setCreateDialogOpen(true)}
          className="bg-blue-600 hover:bg-blue-700"
        >
          <Plus className="mr-2 h-4 w-4" />
          Tạo ca sản xuất
        </Button>
      </div>

      {/* Error State */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex gap-3">
          <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
          <div>
            <p className="font-medium text-red-900">Lỗi tải dữ liệu</p>
            <p className="text-sm text-red-700">
              {error instanceof Error ? error.message : "Không thể tải các ca sản xuất"}
            </p>
          </div>
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      )}

      {/* Board View */}
      {!isLoading && !error && (
        <div className="grid grid-cols-7 gap-4">
          {weekDates.map((date) => {
            const dateStr = format(date, "yyyy-MM-dd");
            const dayName = format(date, "EEEE", { locale: vi });
            const dayLabel = dayName.charAt(0).toUpperCase() + dayName.slice(1);
            const shifts = shiftsByDate[dateStr] || [];

            return (
              <div key={dateStr} className="flex flex-col">
                {/* Column Header */}
                <div className="bg-gray-50 border border-gray-200 rounded-t-lg p-3 mb-2">
                  <p className="font-semibold text-sm">{dayLabel}</p>
                  <p className="text-sm text-gray-600">
                    {format(date, "dd/MM", { locale: vi })}
                  </p>
                </div>

                {/* Shifts Column */}
                <div className="flex-1 space-y-2 min-h-96">
                  {shifts.length > 0 ? (
                    shifts.map((shift) => (
                      <ShiftCard
                        key={shift.id}
                        shift={shift}
                        onOpen={handleOpenDetail}
                      />
                    ))
                  ) : (
                    <div className="h-full flex items-center justify-center text-center p-2">
                      <p className="text-sm text-gray-400">Chưa có ca</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && shiftsData.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <CalendarClock className="h-12 w-12 text-gray-300 mb-4" />
          <p className="text-lg font-medium text-gray-600 mb-2">
            Chưa có ca sản xuất
          </p>
          <p className="text-sm text-gray-500 mb-6">
            Tạo ca sản xuất mới để bắt đầu quản lý sản xuất
          </p>
          <Button
            onClick={() => setCreateDialogOpen(true)}
            className="bg-blue-600 hover:bg-blue-700"
          >
            <Plus className="mr-2 h-4 w-4" />
            Tạo ca sản xuất
          </Button>
        </div>
      )}

      {/* Dialogs */}
      <CreateShiftDialog
        isOpen={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
      />

      <ShiftDetailDialog
        shift={selectedShift}
        isOpen={detailDialogOpen}
        onClose={() => {
          setDetailDialogOpen(false);
          setSelectedShift(null);
        }}
      />
    </div>
  );
}
