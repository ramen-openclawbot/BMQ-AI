import { useState, useEffect } from "react";
import { format } from "date-fns";
import { vi } from "date-fns/locale";
import { Loader2, Plus, Trash2, Package, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
  usePurchaseOrder,
  usePurchaseOrderItems,
  useUpdatePurchaseOrder,
} from "@/hooks/usePurchaseOrders";
import { useSuppliers } from "@/hooks/useSuppliers";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface EditPurchaseOrderDialogProps {
  orderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

interface ItemRow {
  id?: string;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
  notes?: string;
}

export function EditPurchaseOrderDialog({
  orderId,
  open,
  onOpenChange,
  onSuccess,
}: EditPurchaseOrderDialogProps) {
  const queryClient = useQueryClient();
  
  const { data: order, isLoading: orderLoading } = usePurchaseOrder(orderId);
  const { data: items, isLoading: itemsLoading } = usePurchaseOrderItems(orderId);
  const { data: suppliers } = useSuppliers();
  const updatePO = useUpdatePurchaseOrder();
  
  // Form state
  const [supplierId, setSupplierId] = useState<string>("");
  const [orderDate, setOrderDate] = useState<string>("");
  const [expectedDate, setExpectedDate] = useState<string>("");
  const [vatAmount, setVatAmount] = useState<number>(0);
  const [notes, setNotes] = useState<string>("");
  const [itemRows, setItemRows] = useState<ItemRow[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load data when dialog opens
  useEffect(() => {
    if (open && order && items) {
      setSupplierId(order.supplier_id || "");
      setOrderDate(order.order_date || "");
      setExpectedDate(order.expected_date || "");
      setVatAmount(order.vat_amount || 0);
      setNotes(order.notes || "");
      setItemRows(
        items.map((item) => ({
          id: item.id,
          product_name: item.product_name,
          quantity: Number(item.quantity) || 0,
          unit: item.unit || "kg",
          unit_price: Number(item.unit_price) || 0,
          line_total: Number(item.line_total) || 0,
          notes: item.notes || "",
        }))
      );
    }
  }, [open, order, items]);

  const isLoading = orderLoading || itemsLoading;

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  // Calculate totals
  const subtotal = itemRows.reduce((sum, item) => sum + item.line_total, 0);
  const total = subtotal + vatAmount;

  // Update item row
  const updateItemRow = (index: number, field: keyof ItemRow, value: any) => {
    setItemRows((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      
      // Recalculate line_total if quantity or unit_price changed
      if (field === "quantity" || field === "unit_price") {
        updated[index].line_total = 
          (updated[index].quantity || 0) * (updated[index].unit_price || 0);
      }
      
      return updated;
    });
  };

  // Add new item row
  const addItemRow = () => {
    setItemRows((prev) => [
      ...prev,
      {
        product_name: "",
        quantity: 1,
        unit: "kg",
        unit_price: 0,
        line_total: 0,
      },
    ]);
  };

  // Remove item row
  const removeItemRow = (index: number) => {
    setItemRows((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    if (itemRows.length === 0) {
      toast.error("Vui lòng thêm ít nhất 1 sản phẩm");
      return;
    }

    if (itemRows.some((item) => !item.product_name.trim())) {
      toast.error("Vui lòng nhập tên cho tất cả sản phẩm");
      return;
    }

    setIsSubmitting(true);

    try {
      // 1. Update the PO main record
      await updatePO.mutateAsync({
        id: orderId,
        supplier_id: supplierId || null,
        order_date: orderDate,
        expected_date: expectedDate || null,
        vat_amount: vatAmount,
        total_amount: total,
        notes: notes || null,
      });

      // 2. Delete all existing items
      const { error: deleteError } = await supabase
        .from("purchase_order_items")
        .delete()
        .eq("purchase_order_id", orderId);

      if (deleteError) throw deleteError;

      // 3. Insert new items
      const itemsToInsert = itemRows.map((item) => ({
        purchase_order_id: orderId,
        product_name: item.product_name,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: item.unit_price,
        line_total: item.line_total,
        notes: item.notes || null,
      }));

      const { error: insertError } = await supabase
        .from("purchase_order_items")
        .insert(itemsToInsert);

      if (insertError) throw insertError;

      // 4. Invalidate queries to refresh data
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["purchase-order", orderId] });
      queryClient.invalidateQueries({ queryKey: ["purchase-order-items", orderId] });

      toast.success("Đã cập nhật đơn đặt hàng");
      onOpenChange(false);
      onSuccess?.();
    } catch (error: any) {
      console.error("Error updating PO:", error);
      toast.error("Lỗi khi cập nhật: " + error.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            Chỉnh sửa Đơn Đặt Hàng
          </DialogTitle>
          <DialogDescription>
            {order?.po_number} - Trạng thái: Nháp
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Basic Info */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="col-span-2">
                <Label>Nhà cung cấp</Label>
                <Select
                  value={supplierId || "_none"}
                  onValueChange={(v) => setSupplierId(v === "_none" ? "" : v)}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Chọn NCC..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">-- Chưa chọn --</SelectItem>
                    {suppliers?.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Ngày đặt</Label>
                <Input
                  type="date"
                  value={orderDate}
                  onChange={(e) => setOrderDate(e.target.value)}
                  className="mt-1"
                />
              </div>

              <div>
                <Label>Ngày giao dự kiến</Label>
                <Input
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>

            {/* Items Table */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <Label className="text-base font-medium">
                  Danh sách sản phẩm ({itemRows.length})
                </Label>
                <Button type="button" variant="outline" size="sm" onClick={addItemRow}>
                  <Plus className="h-4 w-4 mr-1" />
                  Thêm dòng
                </Button>
              </div>

              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[35%]">Sản phẩm</TableHead>
                      <TableHead className="w-[12%]">SL</TableHead>
                      <TableHead className="w-[10%]">ĐVT</TableHead>
                      <TableHead className="w-[18%]">Đơn giá</TableHead>
                      <TableHead className="w-[18%]">Thành tiền</TableHead>
                      <TableHead className="w-[7%]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {itemRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                          Chưa có sản phẩm. Nhấn "Thêm dòng" để bắt đầu.
                        </TableCell>
                      </TableRow>
                    ) : (
                      itemRows.map((item, index) => (
                        <TableRow key={index}>
                          <TableCell>
                            <Input
                              value={item.product_name}
                              onChange={(e) =>
                                updateItemRow(index, "product_name", e.target.value)
                              }
                              placeholder="Tên sản phẩm"
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min="0"
                              step="0.1"
                              value={item.quantity}
                              onChange={(e) =>
                                updateItemRow(index, "quantity", parseFloat(e.target.value) || 0)
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={item.unit}
                              onChange={(e) => updateItemRow(index, "unit", e.target.value)}
                              placeholder="kg"
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min="0"
                              value={item.unit_price}
                              onChange={(e) =>
                                updateItemRow(index, "unit_price", parseFloat(e.target.value) || 0)
                              }
                            />
                          </TableCell>
                          <TableCell className="font-medium text-right">
                            {formatCurrency(item.line_total)}
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeItemRow(index)}
                              className="h-8 w-8 text-destructive hover:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            {/* Totals */}
            <div className="flex justify-end border-t pt-4">
              <div className="space-y-2 text-right w-64">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tạm tính:</span>
                  <span className="font-medium">{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">VAT:</span>
                  <Input
                    type="number"
                    min="0"
                    value={vatAmount}
                    onChange={(e) => setVatAmount(parseFloat(e.target.value) || 0)}
                    className="w-32 text-right"
                  />
                </div>
                <div className="flex justify-between pt-2 border-t">
                  <span className="font-medium">Tổng cộng:</span>
                  <span className="text-xl font-bold">{formatCurrency(total)}</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <div>
              <Label>Ghi chú</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Ghi chú thêm..."
                rows={2}
                className="mt-1"
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Hủy
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || isLoading}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Đang lưu...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                Lưu thay đổi
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
