import { useState, useRef } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { format } from "date-fns";
import { CalendarIcon, Loader2, Plus, Trash2, Upload, Scan, ImageIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useSuppliers } from "@/hooks/useSuppliers";
import { useProductSKUs } from "@/hooks/useProductSKUs";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  generatePONumber,
  useCreatePurchaseOrder,
  useCreatePurchaseOrderItem,
} from "@/hooks/usePurchaseOrders";

import { callEdgeFunction } from "@/lib/fetch-with-timeout";

const poItemSchema = z.object({
  sku_id: z.string().optional(),
  product_name: z.string().min(1, "Tên sản phẩm là bắt buộc"),
  quantity: z.coerce.number().min(0.01, "Số lượng phải lớn hơn 0"),
  unit: z.string().optional(),
  unit_price: z.coerce.number().min(0, "Đơn giá phải >= 0"),
  notes: z.string().optional(),
});

const purchaseOrderSchema = z.object({
  supplier_id: z.string().min(1, "Vui lòng chọn nhà cung cấp"),
  order_date: z.date(),
  expected_date: z.date().optional(),
  vat_amount: z.coerce.number().min(0).optional(),
  notes: z.string().optional(),
  items: z.array(poItemSchema).min(1, "Cần ít nhất một sản phẩm"),
});

type PurchaseOrderFormData = z.infer<typeof purchaseOrderSchema>;

interface ScannedPOData {
  po_number?: string;
  order_date?: string;
  expected_date?: string;
  supplier_name?: string;
  vat_amount?: number;
  total_amount?: number;
  items: Array<{
    product_code?: string;
    product_name: string;
    unit?: string;
    quantity: number;
    unit_price?: number;
    line_total?: number;
    notes?: string;
  }>;
  notes?: string;
}

interface AddPurchaseOrderDialogProps {
  children?: React.ReactNode;
}

export function AddPurchaseOrderDialog({ children }: AddPurchaseOrderDialogProps) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scannedImage, setScannedImage] = useState<string | null>(null);
  const [scannedData, setScannedData] = useState<ScannedPOData | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { user } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const { data: suppliers } = useSuppliers();
  const { data: productSKUs } = useProductSKUs();
  const createPurchaseOrder = useCreatePurchaseOrder();
  const createPurchaseOrderItem = useCreatePurchaseOrderItem();

  const form = useForm<PurchaseOrderFormData>({
    resolver: zodResolver(purchaseOrderSchema),
    defaultValues: {
      supplier_id: "",
      order_date: new Date(),
      expected_date: undefined,
      vat_amount: 0,
      notes: "",
      items: [],
    },
  });

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "items",
  });

  const watchItems = form.watch("items");
  const watchSupplierId = form.watch("supplier_id");
  const watchVat = form.watch("vat_amount") || 0;

  // Filter SKUs by selected supplier
  const supplierSKUs = productSKUs?.filter(
    (sku) => !watchSupplierId || sku.supplier_id === watchSupplierId
  );

  const subtotal = watchItems.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0),
    0
  );
  const total = subtotal + watchVat;

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  // Auto-fill item details when SKU selected
  const handleSKUSelect = (index: number, skuId: string) => {
    const sku = productSKUs?.find((s) => s.id === skuId);
    if (sku) {
      form.setValue(`items.${index}.sku_id`, skuId);
      form.setValue(`items.${index}.product_name`, sku.product_name);
      form.setValue(`items.${index}.unit`, sku.unit || "kg");
      form.setValue(`items.${index}.unit_price`, sku.unit_price || 0);
    }
  };

  // Handle image upload and scan - using fetch with timeout instead of invoke
  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      toast.error("Vui lòng chọn file ảnh");
      return;
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File ảnh quá lớn (tối đa 10MB)");
      return;
    }

    console.log("[po-scan] start");
    setIsScanning(true);

    try {
      // Get fresh session token
      console.log("[po-scan] getting-token");
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      if (!token) {
        console.log("[po-scan] no-token");
        toast.error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
        setIsScanning(false);
        return;
      }

      console.log("[po-scan] got-token");

      // Convert to base64
      const reader = new FileReader();
      reader.onloadend = async () => {
        try {
          const base64 = (reader.result as string).split(",")[1];
          const dataUrl = reader.result as string;
          setScannedImage(dataUrl);

          console.log("[po-scan] fetch-start");
          // Call scan edge function using fetch with timeout (60s)
          const { data, error } = await callEdgeFunction<{ success: boolean; data: ScannedPOData; error?: string }>(
            "scan-purchase-order",
            { imageBase64: base64, mimeType: file.type },
            token,
            60000 // 60 second timeout
          );
          console.log("[po-scan] fetch-done", { hasData: !!data, error });

          if (error) {
            console.error("[po-scan] error:", error);
            toast.error("Lỗi khi scan ảnh: " + error);
            return;
          }

          if (data?.success && data?.data) {
            const scanned = data.data;
            setScannedData(scanned);

            // Try to match supplier by name
            if (scanned.supplier_name && suppliers) {
              const matchedSupplier = suppliers.find(
                (s) =>
                  s.name.toLowerCase().includes(scanned.supplier_name!.toLowerCase()) ||
                  scanned.supplier_name!.toLowerCase().includes(s.name.toLowerCase())
              );
              if (matchedSupplier) {
                form.setValue("supplier_id", matchedSupplier.id);
              }
            }

            // Set order date if available
            if (scanned.order_date) {
              try {
                form.setValue("order_date", new Date(scanned.order_date));
              } catch (e) {
                console.warn("Could not parse order date:", scanned.order_date);
              }
            }

            // Set expected date if available
            if (scanned.expected_date) {
              try {
                form.setValue("expected_date", new Date(scanned.expected_date));
              } catch (e) {
                console.warn("Could not parse expected date:", scanned.expected_date);
              }
            }

            // Set notes
            if (scanned.notes) {
              form.setValue("notes", scanned.notes);
            }

            // Set VAT amount if available
            if (scanned.vat_amount) {
              form.setValue("vat_amount", scanned.vat_amount);
            }

            // Fill in items
            if (scanned.items && scanned.items.length > 0) {
              const formItems = scanned.items.map((item) => ({
                sku_id: "",
                product_name: item.product_name || "",
                quantity: item.quantity || 1,
                unit: item.unit || "kg",
                unit_price: item.unit_price || 0,
                notes: item.notes || "",
              }));
              replace(formItems);
            }

            toast.success(`Đã scan được ${scanned.items?.length || 0} sản phẩm từ ảnh`);
          } else {
            toast.error((data as any)?.error || "Không thể trích xuất dữ liệu từ ảnh");
          }
        } catch (innerError) {
          console.error("[po-scan] inner-error:", innerError);
          toast.error("Lỗi khi xử lý ảnh");
        } finally {
          console.log("[po-scan] finally");
          setIsScanning(false);
        }
      };

      reader.onerror = () => {
        console.error("[po-scan] reader-error");
        toast.error("Lỗi khi đọc file ảnh");
        setIsScanning(false);
      };

      reader.readAsDataURL(file);
    } catch (error) {
      console.error("[po-scan] outer-error:", error);
      toast.error("Lỗi khi xử lý ảnh");
      setIsScanning(false);
    }
  };

  const handleRemoveImage = () => {
    setScannedImage(null);
    setScannedData(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const onSubmit = async (data: PurchaseOrderFormData) => {
    setIsSubmitting(true);
    try {
      const poNumber = await generatePONumber();

      // Upload image to storage if exists
      let imageUrl: string | null = null;
      if (scannedImage) {
        try {
          const base64Data = scannedImage.split(",")[1];
          const byteCharacters = atob(base64Data);
          const byteArray = new Uint8Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteArray[i] = byteCharacters.charCodeAt(i);
          }

          const fileName = `${poNumber}-${Date.now()}.jpg`;
          const { data: uploadData, error: uploadError } = await supabase.storage
            .from("purchase-orders")
            .upload(fileName, byteArray, {
              contentType: "image/jpeg",
              upsert: false,
            });

          if (!uploadError && uploadData) {
            // Save storage path instead of signed URL to avoid JWT expiration
            imageUrl = uploadData.path;
          } else if (uploadError) {
            console.warn("Image upload error:", uploadError);
          }
        } catch (uploadErr) {
          console.warn("Image upload failed:", uploadErr);
        }
      }

      const order = await createPurchaseOrder.mutateAsync({
        po_number: poNumber,
        supplier_id: data.supplier_id,
        order_date: format(data.order_date, "yyyy-MM-dd"),
        expected_date: data.expected_date ? format(data.expected_date, "yyyy-MM-dd") : null,
        total_amount: total,
        vat_amount: data.vat_amount || 0,
        notes: data.notes || null,
        image_url: imageUrl,
        created_by: user?.id || null,
        status: "draft",
      });

      // Create items
      for (const item of data.items) {
        await createPurchaseOrderItem.mutateAsync({
          purchase_order_id: order.id,
          sku_id: item.sku_id || null,
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit || "kg",
          unit_price: item.unit_price,
          line_total: item.quantity * item.unit_price,
          notes: item.notes || null,
        });
      }

      // Invalidate queries to refresh list immediately (like AddSupplierDialog)
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["draft-po-count"] });
      
      toast.success(`Đã tạo đơn đặt hàng ${poNumber}`);
      form.reset();
      setScannedImage(null);
      setScannedData(null);
      setOpen(false);
    } catch (error) {
      console.error("Error creating PO:", error);
      toast.error("Lỗi khi tạo đơn đặt hàng");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Reset state when dialog closes to prevent stale state on next open
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset scan-related state when closing
      setIsScanning(false);
      setScannedImage(null);
      setScannedData(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
    setOpen(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {children || <Button><Plus className="h-4 w-4 mr-2" />Tạo đơn đặt hàng</Button>}
      </DialogTrigger>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tạo Đơn Đặt Hàng Mới</DialogTitle>
          <DialogDescription>
            Tạo đơn đặt hàng (Purchase Order) gửi cho nhà cung cấp. Bạn có thể upload ảnh đơn hàng từ NCC để tự động điền thông tin.
          </DialogDescription>
        </DialogHeader>

        {/* Image Upload Section */}
        <div className="border-2 border-dashed rounded-lg p-4 mb-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            className="hidden"
            id="po-image-upload"
          />
          
          {!scannedImage ? (
            <div className="flex flex-col items-center justify-center py-6">
              <ImageIcon className="h-12 w-12 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground mb-3">
                Upload ảnh đơn đặt hàng từ nhà cung cấp để tự động điền thông tin
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={isScanning}
              >
                {isScanning ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Đang scan...
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4 mr-2" />
                    Chọn ảnh để scan
                  </>
                )}
              </Button>
            </div>
          ) : (
            <div className="flex gap-4">
              <div className="relative w-48 h-32 flex-shrink-0">
                <img
                  src={scannedImage}
                  alt="Scanned PO"
                  className="w-full h-full object-cover rounded-lg"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute -top-2 -right-2 h-6 w-6"
                  onClick={handleRemoveImage}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <div className="flex-1">
                {isScanning ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Đang phân tích ảnh...</span>
                  </div>
                ) : scannedData ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Scan className="h-4 w-4 text-green-500" />
                      <span className="text-sm font-medium text-green-600">Đã scan thành công</span>
                    </div>
                    {scannedData.supplier_name && (
                      <p className="text-sm">
                        <span className="text-muted-foreground">NCC:</span>{" "}
                        <Badge variant="outline">{scannedData.supplier_name}</Badge>
                      </p>
                    )}
                    {scannedData.po_number && (
                      <p className="text-sm">
                        <span className="text-muted-foreground">Số PO:</span> {scannedData.po_number}
                      </p>
                    )}
                    <p className="text-sm">
                      <span className="text-muted-foreground">Sản phẩm:</span>{" "}
                      <Badge>{scannedData.items?.length || 0} items</Badge>
                    </p>
                    {scannedData.total_amount && (
                      <p className="text-sm">
                        <span className="text-muted-foreground">Tổng:</span>{" "}
                        {formatCurrency(scannedData.total_amount)}
                      </p>
                    )}
                    {scannedData.vat_amount !== undefined && scannedData.vat_amount > 0 && (
                      <p className="text-sm">
                        <span className="text-muted-foreground">VAT:</span>{" "}
                        {formatCurrency(scannedData.vat_amount)}
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Supplier and Dates */}
            <div className="grid grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="supplier_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nhà cung cấp *</FormLabel>
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

              <FormField
                control={form.control}
                name="order_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày đặt hàng</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            className={cn(
                              "w-full pl-3 text-left font-normal",
                              !field.value && "text-muted-foreground"
                            )}
                          >
                            {field.value ? format(field.value, "dd/MM/yyyy") : "Chọn ngày"}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={field.value}
                          onSelect={field.onChange}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="expected_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày giao dự kiến</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            className={cn(
                              "w-full pl-3 text-left font-normal",
                              !field.value && "text-muted-foreground"
                            )}
                          >
                            {field.value ? format(field.value, "dd/MM/yyyy") : "Chọn ngày"}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={field.value}
                          onSelect={field.onChange}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

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
                      sku_id: "",
                      product_name: "",
                      quantity: 1,
                      unit: "kg",
                      unit_price: 0,
                      notes: "",
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
                      <TableHead className="w-48">Chọn SKU</TableHead>
                      <TableHead>Tên sản phẩm</TableHead>
                      <TableHead className="w-24">SL</TableHead>
                      <TableHead className="w-20">ĐVT</TableHead>
                      <TableHead className="w-32">Đơn giá</TableHead>
                      <TableHead className="w-32">Thành tiền</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((field, index) => {
                      const item = watchItems[index];
                      const lineTotal = (item?.quantity || 0) * (item?.unit_price || 0);

                      return (
                        <TableRow key={field.id}>
                          <TableCell>
                            <Select
                              value={item?.sku_id || "_none"}
                              onValueChange={(value) => {
                                if (value !== "_none") {
                                  handleSKUSelect(index, value);
                                }
                              }}
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue placeholder="Chọn SKU" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="_none">Nhập thủ công</SelectItem>
                                {supplierSKUs?.map((sku) => (
                                  <SelectItem key={sku.id} value={sku.id}>
                                    {sku.sku_code} - {sku.product_name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
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

            {/* VAT and Total */}
            <div className="flex justify-end border-t pt-4">
              <div className="space-y-2 text-right">
                <div>
                  <span className="text-muted-foreground mr-4">Tạm tính:</span>
                  <span className="font-medium">{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <span className="text-muted-foreground">VAT:</span>
                  <Input
                    type="number"
                    {...form.register("vat_amount", { valueAsNumber: true })}
                    className="w-32 h-8 text-right"
                    placeholder="0"
                  />
                  <span className="text-muted-foreground">đ</span>
                </div>
                <div>
                  <span className="text-muted-foreground mr-4">Tổng cộng:</span>
                  <span className="text-xl font-bold">{formatCurrency(total)}</span>
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
                    <Textarea placeholder="Ghi chú thêm..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t.cancel}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Đang tạo...
                  </>
                ) : (
                  "Tạo đơn đặt hàng"
                )}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
