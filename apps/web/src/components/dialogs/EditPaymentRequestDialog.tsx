import { useState, useEffect } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, CreditCard, Banknote, TrendingUp, TrendingDown, Package, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useSuppliers } from "@/hooks/useSuppliers";
import { useGoodsReceipts } from "@/hooks/useGoodsReceipts";
import { supabase } from "@/integrations/supabase/client";
import {
  usePaymentRequest,
  usePaymentRequestItems,
  useUpdatePaymentRequest,
} from "@/hooks/usePaymentRequests";
import {
  findSKUByCodeOrName,
  getLastPrice,
  checkInventory,
} from "@/hooks/useProductSKUs";
import { useQueryClient } from "@tanstack/react-query";
import { useLanguage } from "@/contexts/LanguageContext";

interface EditPaymentRequestDialogProps {
  requestId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ItemPriceInfo {
  lastPrice: number | null;
  priceChangePercent: number | null;
  inventoryExists: boolean;
  currentQuantity: number;
  inventoryItemId: string | null;
  skuCode: string | null;
}

const paymentRequestItemSchema = z.object({
  id: z.string().optional(),
  product_code: z.string().optional(),
  product_name: z.string().min(1, "Tên sản phẩm là bắt buộc"),
  quantity: z.coerce.number().min(0.01, "Số lượng phải lớn hơn 0"),
  unit: z.string().optional(),
  unit_price: z.coerce.number(), // Cho phép số âm để nhập khoản khấu trừ (VD: gas thừa)
});

const editPaymentRequestSchema = z.object({
  title: z.string().min(1, "Tiêu đề là bắt buộc"),
  description: z.string().optional(),
  supplier_id: z.string().optional(),
  goods_receipt_id: z.string().optional(),
  payment_type: z.enum(["old_order", "new_order"]).default("old_order"),
  payment_method: z.enum(["bank_transfer", "cash"]).default("bank_transfer"),
  vat_amount: z.coerce.number().min(0).default(0),
  notes: z.string().optional(),
  items: z.array(paymentRequestItemSchema).min(1, "Cần ít nhất một sản phẩm"),
});

type EditPaymentRequestFormData = z.infer<typeof editPaymentRequestSchema>;

export function EditPaymentRequestDialog({
  requestId,
  open,
  onOpenChange,
}: EditPaymentRequestDialogProps) {
  const [itemPriceInfos, setItemPriceInfos] = useState<Record<number, ItemPriceInfo>>({});
  const [isLoadingPrices, setIsLoadingPrices] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const { data: suppliers } = useSuppliers();
  const { data: goodsReceipts = [] } = useGoodsReceipts();
  const { data: request, isLoading: requestLoading } = usePaymentRequest(requestId);
  const { data: existingItems, isLoading: itemsLoading } = usePaymentRequestItems(requestId);
  
  // Filter goods receipts that are confirmed (received)
  const availableGoodsReceipts = goodsReceipts.filter(gr => gr.status === "received");
  const updateRequest = useUpdatePaymentRequest();

  const form = useForm<EditPaymentRequestFormData>({
    resolver: zodResolver(editPaymentRequestSchema),
    defaultValues: {
      title: "",
      description: "",
      supplier_id: "",
      goods_receipt_id: "",
      payment_type: "old_order",
      payment_method: "bank_transfer",
      vat_amount: 0,
      notes: "",
      items: [],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  // Populate form when data loads
  useEffect(() => {
    if (request && existingItems && open) {
      form.reset({
        title: request.title,
        description: request.description || "",
        supplier_id: request.supplier_id || "",
        goods_receipt_id: request.goods_receipt_id || "",
        payment_type: (request.payment_type as "old_order" | "new_order") || "old_order",
        payment_method: (request.payment_method as "bank_transfer" | "cash") || "bank_transfer",
        vat_amount: (request as any).vat_amount || 0,
        notes: request.notes || "",
        items: existingItems.map((item) => ({
          id: item.id,
          product_code: item.product_code || "",
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit || "kg",
          unit_price: item.unit_price,
        })),
      });
    }
  }, [request, existingItems, open, form]);

  const watchItems = form.watch("items");
  const watchVat = form.watch("vat_amount");
  const watchSupplierId = form.watch("supplier_id");

  // Auto-fill payment method when supplier changes (only for new supplier selections)
  const [lastSupplierId, setLastSupplierId] = useState<string | null>(null);
  useEffect(() => {
    // Only auto-fill if user manually changes supplier (not on initial load)
    if (watchSupplierId && watchSupplierId !== lastSupplierId && lastSupplierId !== null) {
      const selectedSupplier = suppliers?.find(s => s.id === watchSupplierId);
      if (selectedSupplier?.default_payment_method) {
        form.setValue("payment_method", selectedSupplier.default_payment_method);
      }
    }
    setLastSupplierId(watchSupplierId || null);
  }, [watchSupplierId, suppliers, form, lastSupplierId]);

  // Get selected supplier info for display
  const selectedSupplier = watchSupplierId ? suppliers?.find(s => s.id === watchSupplierId) : null;

  const subtotal = watchItems.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0),
    0
  );
  const total = subtotal + (watchVat || 0);

  // Fetch price info when items change
  useEffect(() => {
    let cancelled = false;

    const fetchPriceInfos = async () => {
      if (watchItems.length === 0) {
        setItemPriceInfos({});
        return;
      }

      setIsLoadingPrices(true);
      const newInfos: Record<number, ItemPriceInfo> = {};

      const promises = watchItems.map(async (item, i) => {
        if (!item.product_name && !item.product_code) return;

        try {
          const [priceInfo, inventoryInfo, skuInfo] = await Promise.all([
            getLastPrice(item.product_name),
            checkInventory(item.product_name),
            findSKUByCodeOrName(item.product_code, item.product_name),
          ]);

          let priceChangePercent: number | null = null;
          const referencePrice = skuInfo?.unit_price || priceInfo.lastPrice;
          if (referencePrice && item.unit_price > 0) {
            priceChangePercent = ((item.unit_price - referencePrice) / referencePrice) * 100;
          }

          newInfos[i] = {
            lastPrice: referencePrice,
            priceChangePercent,
            inventoryExists: inventoryInfo.exists,
            currentQuantity: inventoryInfo.currentQuantity,
            inventoryItemId: inventoryInfo.inventoryItemId,
            skuCode: skuInfo?.sku_code || null,
          };
        } catch (err) {
          console.warn(`Error fetching info for item ${i}:`, err);
          newInfos[i] = {
            lastPrice: null,
            priceChangePercent: null,
            inventoryExists: false,
            currentQuantity: 0,
            inventoryItemId: null,
            skuCode: null,
          };
        }
      });

      await Promise.all(promises);

      if (!cancelled) {
        setItemPriceInfos(newInfos);
        setIsLoadingPrices(false);
      }
    };

    const timeoutId = setTimeout(fetchPriceInfos, 800);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [watchItems]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const onSubmit = async (data: EditPaymentRequestFormData) => {
    if (!requestId) return;

    setIsSaving(true);
    try {
      // Update payment request with all fields
      await updateRequest.mutateAsync({
        id: requestId,
        title: data.title,
        description: data.description || null,
        supplier_id: data.supplier_id || null,
        goods_receipt_id: data.goods_receipt_id || null,
        payment_type: data.payment_type,
        payment_method: data.payment_method,
        vat_amount: data.vat_amount || 0,
        total_amount: total,
        notes: data.notes || null,
      });

      // Delete old items
      const { error: deleteError } = await supabase
        .from("payment_request_items")
        .delete()
        .eq("payment_request_id", requestId);

      if (deleteError) throw deleteError;

      // Insert new items
      for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i];
        const priceInfo = itemPriceInfos[i];

        const { error: insertError } = await supabase
          .from("payment_request_items")
          .insert({
            payment_request_id: requestId,
            product_code: item.product_code || null,
            product_name: item.product_name,
            quantity: item.quantity,
            unit: item.unit || "kg",
            unit_price: item.unit_price,
            line_total: item.quantity * item.unit_price,
            last_price: priceInfo?.lastPrice || null,
            price_change_percent: priceInfo?.priceChangePercent || null,
            inventory_item_id: priceInfo?.inventoryItemId || null,
          });

        if (insertError) throw insertError;
      }

      queryClient.invalidateQueries({ queryKey: ["payment-request-items", requestId] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      
      toast.success("Đã cập nhật đề nghị chi thành công");
      onOpenChange(false);
    } catch (error) {
      console.error("Error updating payment request:", error);
      const errorMessage = error instanceof Error ? error.message : "Lỗi không xác định";
      if (errorMessage.includes("row-level security") || errorMessage.includes("permission")) {
        toast.error("Bạn không có quyền cập nhật đề nghị chi");
      } else {
        toast.error("Không thể cập nhật đề nghị chi. Vui lòng thử lại.");
      }
    } finally {
      setIsSaving(false);
    }
  };

  const isLoading = requestLoading || itemsLoading;

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.edit} đề nghị duyệt chi</DialogTitle>
          <DialogDescription>
            Chỉnh sửa thông tin đề nghị duyệt chi
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              {/* Basic Info */}
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tiêu đề *</FormLabel>
                      <FormControl>
                        <Input placeholder="VD: Đề nghị chi mua NVL tháng 1" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="supplier_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Nhà cung cấp</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn nhà cung cấp" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {suppliers?.map((supplier) => (
                            <SelectItem key={supplier.id} value={supplier.id}>
                              {supplier.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Payment Type and Goods Receipt Link */}
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="payment_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Loại thanh toán *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn loại" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="old_order">
                            <span className="flex items-center gap-2">
                              📋 Thanh toán đơn cũ (công nợ)
                            </span>
                          </SelectItem>
                          <SelectItem value="new_order">
                            <span className="flex items-center gap-2">
                              🆕 Thanh toán đơn mới
                            </span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="goods_receipt_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Liên kết Phiếu Nhập Kho</FormLabel>
                      <Select 
                        onValueChange={(value) => field.onChange(value === "_none" ? "" : value)} 
                        value={field.value || "_none"}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn phiếu nhập kho (nếu có)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="_none">Không liên kết</SelectItem>
                          {availableGoodsReceipts.map((gr) => (
                            <SelectItem key={gr.id} value={gr.id}>
                              {gr.receipt_number} - {gr.suppliers?.name || "N/A"} ({gr.receipt_date})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Payment Method Selection */}
              <FormField
                control={form.control}
                name="payment_method"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phương thức thanh toán *</FormLabel>
                    <FormControl>
                      <RadioGroup
                        value={field.value}
                        onValueChange={field.onChange}
                        className="flex gap-4"
                      >
                        <div className="flex items-center space-x-2 p-3 border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors">
                          <RadioGroupItem value="bank_transfer" id="edit_payment_unc" />
                          <Label htmlFor="edit_payment_unc" className="flex items-center gap-2 cursor-pointer">
                            <CreditCard className="h-4 w-4 text-blue-500" />
                            UNC
                          </Label>
                        </div>
                        <div className="flex items-center space-x-2 p-3 border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors">
                          <RadioGroupItem value="cash" id="edit_payment_cash" />
                          <Label htmlFor="edit_payment_cash" className="flex items-center gap-2 cursor-pointer">
                            <Banknote className="h-4 w-4 text-orange-500" />
                            Tiền mặt
                          </Label>
                        </div>
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mô tả</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Mô tả chi tiết về đề nghị chi..." {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Items Table */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Danh sách sản phẩm</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      append({
                        product_code: "",
                        product_name: "",
                        quantity: 1,
                        unit: "kg",
                        unit_price: 0,
                      })
                    }
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Thêm sản phẩm
                  </Button>
                </div>

                {fields.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-24">Mã SP</TableHead>
                        <TableHead>Tên sản phẩm</TableHead>
                        <TableHead className="w-24">SL</TableHead>
                        <TableHead className="w-20">ĐVT</TableHead>
                        <TableHead className="w-32">Đơn giá</TableHead>
                        <TableHead className="w-32">Thành tiền</TableHead>
                        <TableHead className="w-36">Giá cũ / Tồn kho</TableHead>
                        <TableHead className="w-12"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fields.map((field, index) => {
                        const item = watchItems[index];
                        const lineTotal = (item?.quantity || 0) * (item?.unit_price || 0);
                        const priceInfo = itemPriceInfos[index];

                        return (
                          <TableRow key={field.id}>
                            <TableCell>
                              <Input
                                {...form.register(`items.${index}.product_code`)}
                                placeholder="Mã"
                                className="h-8"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                {...form.register(`items.${index}.product_name`)}
                                placeholder="Tên sản phẩm"
                                className="h-8"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                step="0.01"
                                {...form.register(`items.${index}.quantity`, {
                                  valueAsNumber: true,
                                })}
                                className="h-8"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                {...form.register(`items.${index}.unit`)}
                                placeholder="kg"
                                className="h-8"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                {...form.register(`items.${index}.unit_price`, {
                                  valueAsNumber: true,
                                })}
                                className="h-8"
                              />
                            </TableCell>
                            <TableCell className="font-medium">
                              {formatCurrency(lineTotal)}
                            </TableCell>
                            <TableCell>
                              {isLoadingPrices ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : priceInfo ? (
                                <div className="space-y-1">
                                  {priceInfo.lastPrice ? (
                                    <div className="flex items-center gap-1">
                                      <span className="text-xs text-muted-foreground">
                                        {formatCurrency(priceInfo.lastPrice)}
                                      </span>
                                      {priceInfo.priceChangePercent !== null && (
                                        <Badge
                                          variant={priceInfo.priceChangePercent > 0 ? "destructive" : "secondary"}
                                          className="text-xs px-1"
                                        >
                                          {priceInfo.priceChangePercent > 0 ? (
                                            <TrendingUp className="h-3 w-3 mr-0.5" />
                                          ) : (
                                            <TrendingDown className="h-3 w-3 mr-0.5" />
                                          )}
                                          {Math.abs(priceInfo.priceChangePercent).toFixed(1)}%
                                        </Badge>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">Chưa có giá cũ</span>
                                  )}
                                  <div className="flex items-center gap-1">
                                    {priceInfo.inventoryExists ? (
                                      <Badge variant="outline" className="text-xs px-1">
                                        <Package className="h-3 w-3 mr-0.5" />
                                        Tồn: {priceInfo.currentQuantity}
                                      </Badge>
                                    ) : (
                                      <Badge variant="secondary" className="text-xs px-1">
                                        <AlertTriangle className="h-3 w-3 mr-0.5" />
                                        Mới
                                      </Badge>
                                    )}
                                  </div>
                                </div>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => remove(index)}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
                {form.formState.errors.items?.message && (
                  <p className="text-sm text-destructive">{form.formState.errors.items.message}</p>
                )}
              </div>

              {/* Totals */}
              <div className="space-y-2 border-t pt-4">
                <div className="flex justify-between">
                  <span>Tạm tính:</span>
                  <span>{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>VAT:</span>
                  <FormField
                    control={form.control}
                    name="vat_amount"
                    render={({ field }) => (
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                        className="w-32 text-right"
                      />
                    )}
                  />
                </div>
                <div className="flex justify-between font-bold text-lg border-t pt-2">
                  <span>Tổng cộng:</span>
                  <span>{formatCurrency(total)}</span>
                </div>
              </div>

              {/* Notes */}
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ghi chú</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Ghi chú thêm..." {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Actions */}
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {t.cancel}
                </Button>
                <Button type="submit" disabled={isSaving}>
                  {isSaving ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Đang lưu...
                    </>
                  ) : (
                    t.save
                  )}
                </Button>
              </div>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
