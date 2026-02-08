import { useEffect } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Loader2, Plus, Trash2, FileText, CreditCard, Banknote, Package, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useAuth } from "@/contexts/AuthContext";
import {
  useCreatePaymentRequest,
  useCreatePaymentRequestItem,
} from "@/hooks/usePaymentRequests";
import { toast } from "sonner";
import type { PurchaseOrder, PurchaseOrderItem } from "@/hooks/usePurchaseOrders";

interface CreatePaymentRequestFromPODialogProps {
  purchaseOrder: PurchaseOrder | null;
  items: PurchaseOrderItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const paymentRequestItemSchema = z.object({
  product_code: z.string().optional(),
  product_name: z.string().min(1, "Tên sản phẩm là bắt buộc"),
  quantity: z.coerce.number().min(0.01, "Số lượng phải lớn hơn 0"),
  unit: z.string().optional(),
  unit_price: z.coerce.number().min(0, "Đơn giá phải lớn hơn hoặc bằng 0"),
});

const paymentRequestSchema = z.object({
  title: z.string().min(1, "Tiêu đề là bắt buộc"),
  description: z.string().optional(),
  payment_type: z.enum(["old_order", "new_order"]).default("old_order"),
  payment_method: z.enum(["bank_transfer", "cash"]).default("bank_transfer"),
  vat_amount: z.coerce.number().min(0).default(0),
  notes: z.string().optional(),
  items: z.array(paymentRequestItemSchema).min(1, "Cần ít nhất một sản phẩm"),
});

type PaymentRequestFormData = z.infer<typeof paymentRequestSchema>;

export function CreatePaymentRequestFromPODialog({
  purchaseOrder,
  items: poItems,
  open,
  onOpenChange,
}: CreatePaymentRequestFromPODialogProps) {
  const { user } = useAuth();
  const createPaymentRequest = useCreatePaymentRequest();
  const createPaymentRequestItem = useCreatePaymentRequestItem();

  const form = useForm<PaymentRequestFormData>({
    resolver: zodResolver(paymentRequestSchema),
    defaultValues: {
      title: "",
      description: "",
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

  // Pre-fill form when dialog opens with PO data
  useEffect(() => {
    if (open && purchaseOrder && poItems.length > 0) {
      form.reset({
        title: `Đề nghị chi - ${purchaseOrder.po_number}`,
        description: `Thanh toán công nợ cũ cho đơn hàng ${purchaseOrder.po_number}`,
        payment_type: "old_order",
        payment_method: "bank_transfer",
        vat_amount: purchaseOrder.vat_amount || 0,
        notes: purchaseOrder.notes || "",
        items: poItems.map((item) => ({
          product_code: item.productSkus?.sku_code || "",
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit || "kg",
          unit_price: item.unit_price || 0,
        })),
      });
    }
  }, [open, purchaseOrder, poItems, form]);

  // Update description when payment type changes
  const watchPaymentType = form.watch("payment_type");
  useEffect(() => {
    if (purchaseOrder) {
      const desc = watchPaymentType === "old_order"
        ? `Thanh toán công nợ cũ cho đơn hàng ${purchaseOrder.po_number}`
        : `Thanh toán khi nhận hàng cho đơn hàng ${purchaseOrder.po_number}`;
      form.setValue("description", desc);
    }
  }, [watchPaymentType, purchaseOrder, form]);

  const watchItems = form.watch("items");
  const watchVat = form.watch("vat_amount");

  const subtotal = watchItems.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0),
    0
  );
  const total = subtotal + (watchVat || 0);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const onSubmit = async (data: PaymentRequestFormData) => {
    if (!purchaseOrder) return;

    try {
      const requestNumber = `PR-${Date.now().toString(36).toUpperCase()}`;

      // Create payment request with purchase_order_id
      const requestData = {
        request_number: requestNumber,
        title: data.title,
        description: data.description || null,
        supplier_id: purchaseOrder.supplier_id || null,
        purchase_order_id: purchaseOrder.id,
        payment_type: data.payment_type,
        payment_method: data.payment_method,
        vat_amount: data.vat_amount || 0,
        total_amount: total,
        notes: data.notes || null,
        created_by: user?.id || null,
      };
      const request = await createPaymentRequest.mutateAsync(requestData as any);

      // Create items
      for (const item of data.items) {
        await createPaymentRequestItem.mutateAsync({
          payment_request_id: request.id,
          product_code: item.product_code || null,
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit || "kg",
          unit_price: item.unit_price,
          line_total: item.quantity * item.unit_price,
        });
      }

      toast.success("Đã tạo đề nghị thanh toán từ PO");
      onOpenChange(false);
      form.reset();
    } catch (error) {
      console.error("Error creating payment request:", error);
      toast.error("Lỗi khi tạo đề nghị thanh toán");
    }
  };

  if (!purchaseOrder) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Tạo đề nghị thanh toán từ PO
          </DialogTitle>
          <DialogDescription>
            Tạo đề nghị chi từ đơn đặt hàng {purchaseOrder.po_number}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* PO Info Badge */}
            <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">
                Liên kết với: <strong>{purchaseOrder.po_number}</strong>
              </span>
              <Badge variant={watchPaymentType === "old_order" ? "secondary" : "default"}>
                {watchPaymentType === "old_order" ? "Công nợ cũ" : "Thanh toán khi nhận hàng"}
              </Badge>
              <span className="text-sm text-muted-foreground ml-auto">
                NCC: {purchaseOrder.suppliers?.name || "N/A"}
              </span>
            </div>

            {/* Payment Type Selection */}
            <FormField
              control={form.control}
              name="payment_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Loại thanh toán</FormLabel>
                  <FormControl>
                    <RadioGroup
                      onValueChange={field.onChange}
                      value={field.value}
                      className="flex gap-6"
                    >
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="old_order" id="pr_po_old_order" />
                        <label htmlFor="pr_po_old_order" className="flex items-center gap-1 cursor-pointer">
                          <Clock className="h-4 w-4" />
                          Công nợ cũ
                        </label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="new_order" id="pr_po_new_order" />
                        <label htmlFor="pr_po_new_order" className="flex items-center gap-1 cursor-pointer">
                          <Package className="h-4 w-4" />
                          Thanh toán khi nhận hàng
                        </label>
                      </div>
                    </RadioGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Basic Info */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tiêu đề *</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="payment_method"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Hình thức thanh toán</FormLabel>
                    <FormControl>
                      <RadioGroup
                        onValueChange={field.onChange}
                        value={field.value}
                        className="flex gap-4"
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="bank_transfer" id="pr_po_bank" />
                          <label htmlFor="pr_po_bank" className="flex items-center gap-1 cursor-pointer">
                            <CreditCard className="h-4 w-4" />
                            Chuyển khoản
                          </label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="cash" id="pr_po_cash" />
                          <label htmlFor="pr_po_cash" className="flex items-center gap-1 cursor-pointer">
                            <Banknote className="h-4 w-4" />
                            Tiền mặt
                          </label>
                        </div>
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mô tả</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Items Table */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <FormLabel>Danh sách sản phẩm *</FormLabel>
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
                  Thêm
                </Button>
              </div>

              {fields.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã SP</TableHead>
                      <TableHead>Tên sản phẩm *</TableHead>
                      <TableHead className="w-20">SL</TableHead>
                      <TableHead className="w-20">ĐVT</TableHead>
                      <TableHead className="w-28">Đơn giá</TableHead>
                      <TableHead className="w-28 text-right">Thành tiền</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((field, index) => {
                      const item = watchItems[index];
                      const lineTotal = (item?.quantity || 0) * (item?.unit_price || 0);
                      return (
                        <TableRow key={field.id}>
                          <TableCell>
                            <FormField
                              control={form.control}
                              name={`items.${index}.product_code`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <Input {...field} placeholder="SKU" className="h-8" />
                                  </FormControl>
                                </FormItem>
                              )}
                            />
                          </TableCell>
                          <TableCell>
                            <FormField
                              control={form.control}
                              name={`items.${index}.product_name`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <Input {...field} placeholder="Tên SP" className="h-8" />
                                  </FormControl>
                                </FormItem>
                              )}
                            />
                          </TableCell>
                          <TableCell>
                            <FormField
                              control={form.control}
                              name={`items.${index}.quantity`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <Input
                                      {...field}
                                      type="number"
                                      step="0.01"
                                      className="h-8"
                                    />
                                  </FormControl>
                                </FormItem>
                              )}
                            />
                          </TableCell>
                          <TableCell>
                            <FormField
                              control={form.control}
                              name={`items.${index}.unit`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <Input {...field} className="h-8" />
                                  </FormControl>
                                </FormItem>
                              )}
                            />
                          </TableCell>
                          <TableCell>
                            <FormField
                              control={form.control}
                              name={`items.${index}.unit_price`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <Input
                                      {...field}
                                      type="number"
                                      step="1"
                                      className="h-8"
                                    />
                                  </FormControl>
                                </FormItem>
                              )}
                            />
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(lineTotal)}
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
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
              ) : (
                <p className="text-muted-foreground text-center py-4">
                  Chưa có sản phẩm
                </p>
              )}
            </div>

            {/* VAT and Totals */}
            <div className="flex justify-between items-start border-t pt-4">
              <FormField
                control={form.control}
                name="vat_amount"
                render={({ field }) => (
                  <FormItem className="w-48">
                    <FormLabel>VAT (VNĐ)</FormLabel>
                    <FormControl>
                      <Input {...field} type="number" step="1" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="text-right space-y-1">
                <div>
                  <span className="text-muted-foreground mr-4">Tạm tính:</span>
                  <span className="font-medium">{formatCurrency(subtotal)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground mr-4">VAT:</span>
                  <span className="font-medium">{formatCurrency(watchVat || 0)}</span>
                </div>
                <div className="text-lg">
                  <span className="text-muted-foreground mr-4">Tổng cộng:</span>
                  <span className="font-bold">{formatCurrency(total)}</span>
                </div>
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
                    <Textarea {...field} rows={2} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Actions */}
            <div className="flex justify-end gap-3 border-t pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                disabled={createPaymentRequest.isPending}
              >
                {createPaymentRequest.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Đang tạo...
                  </>
                ) : (
                  "Tạo đề nghị thanh toán"
                )}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
