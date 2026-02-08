import { useState, useEffect, useMemo } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Loader2, Upload, Scan, AlertCircle, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { useSuppliers } from "@/hooks/useSuppliers";
import { useCreateGoodsReceipt, useCreateGoodsReceiptItem, uploadGoodsReceiptImage } from "@/hooks/useGoodsReceipts";
import { useProductSKUs } from "@/hooks/useProductSKUs";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";

const itemSchema = z.object({
  product_name: z.string().min(1, "Tên sản phẩm là bắt buộc"),
  quantity: z.coerce.number().min(0.01, "Số lượng phải > 0"),
  unit: z.string().optional(),
  sku_id: z.string().optional(),
  sku_code: z.string().optional(),
  sku_status: z.enum(["found", "not_found", "new"]).optional(),
});

const formSchema = z.object({
  supplier_id: z.string().optional(),
  receipt_date: z.string(),
  notes: z.string().optional(),
  items: z.array(itemSchema).min(1, "Cần ít nhất 1 sản phẩm"),
});

type FormData = z.infer<typeof formSchema>;

interface ExtractedItem {
  product_code?: string;
  product_name: string;
  unit?: string;
  quantity: number;
}

export function AddGoodsReceiptDialog() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanCompleted, setScanCompleted] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [newSkuItems, setNewSkuItems] = useState<number[]>([]);

  const { data: suppliers } = useSuppliers();
  const { data: skus } = useProductSKUs();
  const createReceipt = useCreateGoodsReceipt();
  const createItem = useCreateGoodsReceiptItem();

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      supplier_id: "",
      receipt_date: new Date().toISOString().split("T")[0],
      notes: "",
      items: [{ product_name: "", quantity: 0, unit: "kg" }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  const watchedItems = form.watch("items");
  const totalQuantity = useMemo(() => {
    return watchedItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
  }, [watchedItems]);

  // Handle image upload
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  // Auto-scan when image is uploaded
  useEffect(() => {
    const autoScan = async () => {
      if (imageFile && !isScanning && !scanCompleted) {
        await handleScanDeliveryNote();
      }
    };
    autoScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageFile]);

  // Scan delivery note with AI
  const handleScanDeliveryNote = async () => {
    if (!imageFile) {
      toast.error("Vui lòng upload ảnh phiếu giao hàng trước");
      return;
    }

    // Check session before calling Edge function
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) {
      setScanError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
      toast.error("Phiên đăng nhập đã hết hạn");
      return;
    }

    setIsScanning(true);
    setScanError(null);
    try {
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(",")[1];
          resolve(base64);
        };
        reader.readAsDataURL(imageFile);
      });

      const imageBase64 = await base64Promise;

      // Use fetch() directly instead of supabase.functions.invoke() for better error handling
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const response = await fetch(`${supabaseUrl}/functions/v1/scan-invoice`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sessionData.session.access_token}`,
          "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ imageBase64, mimeType: imageFile.type }),
      });

      // Handle specific HTTP status codes
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
        
        if (response.status === 401) {
          setScanError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
          toast.error("Phiên đăng nhập đã hết hạn");
          return;
        }
        
        if (response.status === 403) {
          setScanError("Bạn không có quyền sử dụng tính năng quét");
          toast.error("Bạn không có quyền sử dụng tính năng quét");
          return;
        }
        
        if (response.status === 429) {
          setScanError("Hệ thống đang bận. Vui lòng thử lại sau ít phút.");
          toast.error("Quá nhiều yêu cầu, vui lòng thử lại sau");
          return;
        }

        throw new Error(errorData.error || `Lỗi server: ${response.status}`);
      }

      const data = await response.json();

      if (data.success && data.data) {
        const extractedItems: ExtractedItem[] = data.data.items || [];

        // Match items with existing SKUs
        const newSkuIndices: number[] = [];
        const matchedItems = await Promise.all(
          extractedItems.map(async (item, index) => {
            // Find SKU by product code or name
            const matchedSku = skus?.find(
              (sku) =>
                (item.product_code && sku.sku_code.toLowerCase().includes(item.product_code.toLowerCase())) ||
                sku.product_name.toLowerCase().includes(item.product_name.toLowerCase()) ||
                item.product_name.toLowerCase().includes(sku.product_name.toLowerCase())
            );

            if (matchedSku) {
              return {
                product_name: matchedSku.product_name,
                quantity: item.quantity,
                unit: item.unit || matchedSku.unit || "kg",
                sku_id: matchedSku.id,
                sku_code: matchedSku.sku_code,
                sku_status: "found" as const,
              };
            } else {
              newSkuIndices.push(index);
              return {
                product_name: item.product_name,
                quantity: item.quantity,
                unit: item.unit || "kg",
                sku_id: undefined,
                sku_code: undefined,
                sku_status: "not_found" as const,
              };
            }
          })
        );

        // Update form with matched items
        form.setValue("items", matchedItems);
        setNewSkuItems(newSkuIndices);

        // Try to match supplier
        if (data.data.supplier_name && suppliers) {
          const matchedSupplier = suppliers.find((s) =>
            s.name.toLowerCase().includes(data.data.supplier_name.toLowerCase())
          );
          if (matchedSupplier) {
            form.setValue("supplier_id", matchedSupplier.id);
          }
        }

        setScanCompleted(true);
        if (newSkuIndices.length > 0) {
          toast.warning(`Có ${newSkuIndices.length} sản phẩm mới chưa có SKU. Vui lòng tạo SKU hoặc kiểm tra lại.`);
        } else {
          toast.success("Đã trích xuất thông tin từ phiếu giao hàng");
        }
      }
    } catch (error) {
      console.error("Scan error:", error);
      const errorMsg = error instanceof Error ? error.message : "Lỗi không xác định";
      setScanError(errorMsg);
      toast.error("Không thể quét phiếu giao hàng. Vui lòng thử lại.");
    } finally {
      setIsScanning(false);
    }
  };

  // Submit form
  const onSubmit = async (data: FormData) => {
    // Check for items without SKU
    const itemsWithoutSku = data.items.filter((item) => !item.sku_id && item.sku_status !== "found");
    if (itemsWithoutSku.length > 0) {
      const confirmProceed = window.confirm(
        `Có ${itemsWithoutSku.length} sản phẩm chưa có SKU. Bạn có muốn tiếp tục? Các sản phẩm này sẽ được thêm vào kho với tên gốc.`
      );
      if (!confirmProceed) return;
    }

    try {
      let imageUrl: string | undefined;
      if (imageFile) {
        imageUrl = await uploadGoodsReceiptImage(imageFile);
      }

      // Create goods receipt
      const receipt = await createReceipt.mutateAsync({
        supplier_id: data.supplier_id || null,
        receipt_date: data.receipt_date,
        image_url: imageUrl || null,
        notes: data.notes || null,
        total_quantity: totalQuantity,
        status: "confirmed",
        created_by: user?.id || null,
      });

      // Create items
      for (const item of data.items) {
        await createItem.mutateAsync({
          goods_receipt_id: receipt.id,
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit || "kg",
          sku_id: item.sku_id || null,
        });
      }

      toast.success("Đã tạo phiếu nhập kho thành công");
      setOpen(false);
      form.reset();
      setImageFile(null);
      setImagePreview(null);
      setNewSkuItems([]);
    } catch (error) {
      console.error("Create error:", error);
      const errorMessage = error instanceof Error ? error.message : "Lỗi không xác định";
      if (errorMessage.includes("row-level security") || errorMessage.includes("permission")) {
        toast.error("Bạn không có quyền tạo phiếu nhập kho");
      } else {
        toast.error(`Không thể tạo phiếu nhập kho: ${errorMessage}`);
      }
    }
  };

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      form.reset();
      setImageFile(null);
      setImagePreview(null);
      setNewSkuItems([]);
      setScanCompleted(false);
      setScanError(null);
    }
  }, [open, form]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          Tạo Phiếu Nhập
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tạo Phiếu Nhập Kho</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Image Upload & Scan */}
            <div className="border-2 border-dashed border-muted rounded-lg p-4">
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <Label htmlFor="delivery-note-image" className="cursor-pointer">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Upload className="h-4 w-4" />
                      {imageFile ? imageFile.name : "Upload ảnh phiếu giao hàng"}
                    </div>
                  </Label>
                  <Input
                    id="delivery-note-image"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleImageUpload}
                  />
                </div>
                
                {/* Scanning status */}
                {isScanning && (
                  <Badge variant="secondary" className="flex items-center gap-2">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Đang quét...
                  </Badge>
                )}
                
                {scanCompleted && !isScanning && (
                  <Badge variant="secondary" className="flex items-center gap-1 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                    <CheckCircle className="h-3 w-3" />
                    Đã quét
                  </Badge>
                )}
                
                {/* Rescan button - only show after first scan or on error */}
                {(scanCompleted || scanError) && !isScanning && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleScanDeliveryNote}
                    disabled={!imageFile || isScanning}
                  >
                    <Scan className="h-4 w-4 mr-1" />
                    Quét lại
                  </Button>
                )}
              </div>
              
              {/* Scan error display */}
              {scanError && (
                <div className="mt-2 flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {scanError}
                </div>
              )}
              
              {imagePreview && (
                <div className="mt-3">
                  <img
                    src={imagePreview}
                    alt="Preview"
                    className="max-h-32 rounded border object-contain"
                  />
                </div>
              )}
            </div>

            {/* Supplier & Date */}
            <div className="grid grid-cols-2 gap-4">
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

              <FormField
                control={form.control}
                name="receipt_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày nhận hàng</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Items Table */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Danh sách sản phẩm</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    append({ product_name: "", quantity: 0, unit: "kg" })
                  }
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Thêm
                </Button>
              </div>

              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40%]">Sản phẩm</TableHead>
                      <TableHead className="w-[15%]">SKU</TableHead>
                      <TableHead className="w-[15%]">Số lượng</TableHead>
                      <TableHead className="w-[15%]">Đơn vị</TableHead>
                      <TableHead className="w-[15%]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((field, index) => {
                      const item = watchedItems[index];
                      const hasNoSku = newSkuItems.includes(index) || item?.sku_status === "not_found";

                      return (
                        <TableRow key={field.id}>
                          <TableCell>
                            <Input
                              {...form.register(`items.${index}.product_name`)}
                              placeholder="Tên sản phẩm"
                            />
                          </TableCell>
                          <TableCell>
                            {item?.sku_code ? (
                              <Badge variant="secondary" className="flex items-center gap-1">
                                <CheckCircle className="h-3 w-3 text-green-500" />
                                {item.sku_code}
                              </Badge>
                            ) : hasNoSku ? (
                              <Badge variant="destructive" className="flex items-center gap-1">
                                <AlertCircle className="h-3 w-3" />
                                Chưa có SKU
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground text-sm">-</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              step="0.01"
                              {...form.register(`items.${index}.quantity`)}
                              placeholder="0"
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              {...form.register(`items.${index}.unit`)}
                              placeholder="kg"
                            />
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => remove(index)}
                              disabled={fields.length === 1}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {newSkuItems.length > 0 && (
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-5 w-5 text-yellow-600 mt-0.5" />
                    <div className="text-sm">
                      <p className="font-medium text-yellow-800 dark:text-yellow-200">
                        Có {newSkuItems.length} sản phẩm chưa có SKU
                      </p>
                      <p className="text-yellow-700 dark:text-yellow-300">
                        Bạn có thể tiếp tục tạo phiếu nhập hoặc vào trang SKU để tạo mã SKU trước.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Summary */}
            <div className="bg-muted/50 rounded-lg p-4">
              <div className="flex justify-between items-center">
                <span className="font-medium">Tổng số lượng:</span>
                <span className="text-lg font-bold">{totalQuantity.toLocaleString("vi-VN")}</span>
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
                    <Textarea {...field} placeholder="Ghi chú thêm..." />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t.cancel}
              </Button>
              <Button
                type="submit"
                disabled={createReceipt.isPending || createItem.isPending}
              >
                {createReceipt.isPending || createItem.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Tạo Phiếu Nhập
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
